import datetime, importlib.util, io, json, os, sqlite3, sys, tarfile, tempfile, unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'scripts/backup'))
from dr_common import TOOL, extract_bundle, member_name, prune_daily, sha256, verify_bundle
spec = importlib.util.spec_from_file_location('exporter', ROOT / 'scripts/backup/dr-export.py')
exporter = importlib.util.module_from_spec(spec); spec.loader.exec_module(exporter)

def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / ('scripts/backup/' + name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

class Recovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def bundle(self, corrupt=False):
        stage = self.root / 'stage'; file = stage / 'rootfs/opt/vm2api/data/kin.db'; file.parent.mkdir(parents=True)
        db = sqlite3.connect(file); db.execute('CREATE TABLE bills (id TEXT, cost REAL)'); db.execute('INSERT INTO bills VALUES (?,?)', ('old-account', 42.5)); db.commit(); db.close()
        meta = {'tool': TOOL, 'role': 'control', 'root': '/opt/vm2api', 'files': {'rootfs/opt/vm2api/data/kin.db': {'sha256': sha256(file), 'bytes': file.stat().st_size}}}
        (stage / 'manifest.json').write_text(json.dumps(meta))
        if corrupt: file.write_bytes(b'corrupt')
        archive = self.root / 'bundle.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar: tar.add(stage, arcname='.')
        return archive
    def test_verified_restore_preserves_billing_and_does_not_overwrite(self):
        archive = self.bundle(); self.assertEqual(verify_bundle(archive)['role'], 'control')
        out = self.root / 'restore'; extract_bundle(archive, out)
        with sqlite3.connect(out / 'opt/vm2api/data/kin.db') as db: self.assertEqual(db.execute('SELECT * FROM bills').fetchone(), ('old-account', 42.5))
        with self.assertRaises(FileExistsError): extract_bundle(archive, out)
    def test_corruption_and_foreign_role_fail_closed(self):
        archive = self.bundle(True)
        with self.assertRaises(ValueError): verify_bundle(archive)
        with self.assertRaises(ValueError): verify_bundle(archive, 'worker188')
    def test_path_traversal_and_link_destination_are_refused(self):
        for path in ['/etc/passwd', '../../x', 'rootfs/../../x', 'unlisted']:
            with self.assertRaises(ValueError): member_name(path)
        archive = self.bundle(); out = self.root / 'restore'; out.mkdir(); (out / 'opt').symlink_to(self.root / 'foreign')
        with self.assertRaises(ValueError): extract_bundle(archive, out)
    def test_seven_days_preserves_incomplete_and_foreign_directories(self):
        daily = self.root / 'daily'; daily.mkdir(); today = datetime.date(2026, 10, 30)
        for days in range(10):
            path = daily / str(today - datetime.timedelta(days=days)); path.mkdir(); (path / 'complete.json').write_text(json.dumps({'tool': TOOL, 'status': 'complete'}))
        incomplete = daily / '2020-01-01'; incomplete.mkdir()
        foreign = daily / '2020-01-02'; foreign.mkdir(); (foreign / 'complete.json').write_text(json.dumps({'tool': 'foreign'}))
        self.assertEqual(len(prune_daily(daily, today)), 3)
        self.assertTrue(incomplete.exists() and foreign.exists())
        self.assertTrue((daily / '2026-10-24').exists())
    def test_export_excludes_runtime_and_links_but_preserves_private_state(self):
        source = self.root / 'source'; (source / 'run').mkdir(parents=True); (source / 'run/socket-data').write_text('temporary'); (source / 'identity').write_text('stable-machine-id'); (source / 'escape').symlink_to('/etc/passwd')
        stage = self.root / 'export'; stage.mkdir(); files = {}; exporter.copy_path(source, stage, files)
        restored = stage / ('rootfs/' + str(source).lstrip('/'))
        self.assertEqual((restored / 'identity').read_text(), 'stable-machine-id')
        self.assertFalse((restored / 'run').exists() or (restored / 'escape').exists())
        self.assertIn('uid', next(x for x in files.values() if x.get('type') == 'directory'))
    def test_image_cache_requires_matching_identity_size_and_checksum(self):
        cache = self.root / 'cache'; cache.mkdir(); image_id = 'sha256:' + 'a'*64; archive = cache / ('a'*64 + '.tar.gz'); archive.write_bytes(b'synthetic immutable image archive')
        marker = {'tool':TOOL, 'images':[{'id':image_id, 'bytes':archive.stat().st_size, 'sha256':sha256(archive)}]}; (cache / 'complete.json').write_text(json.dumps(marker))
        self.assertEqual(exporter.cached_image({'image_cache':str(cache)}, image_id), archive)
        self.assertIsNone(exporter.cached_image({'image_cache':str(cache)}, 'sha256:' + 'b'*64))
        archive.write_bytes(b'corrupt'); self.assertIsNone(exporter.cached_image({'image_cache':str(cache)}, image_id))
    def test_image_cleanup_keeps_only_tag_for_running_image_and_never_forces_removal(self):
        with patch.object(exporter.subprocess, 'run') as run:
            exporter.release_alias('vm2api-dr:fixture', created=True, original_tags=[])
            run.assert_not_called()
            exporter.release_alias('vm2api-dr:fixture', created=True, original_tags=['app:production'])
            self.assertNotIn('--force', run.call_args.args[0]); self.assertFalse(run.call_args.kwargs['check'])
    def test_guest_binary_directories_keep_executable_permissions_under_run(self):
        payload = self.root / 'run/slot-guest-bin'; payload.mkdir(parents=True); payload.chmod(0o755); (payload / 'worker').write_bytes(b'fake-binary'); (payload / 'worker').chmod(0o755)
        stage = self.root / 'export'; stage.mkdir(); files = {}; exporter.copy_path(payload, stage, files, include_runtime=True)
        key = 'rootfs/' + str(payload).lstrip('/')
        self.assertEqual(files[key]['type'], 'directory'); self.assertEqual(files[key]['mode'], 0o755); self.assertEqual(files[key + '/worker']['mode'], 0o755)
    def test_online_sqlite_snapshot_includes_committed_wal_without_stopping_writer(self):
        live = self.root / 'live.db'; writer = sqlite3.connect(live); writer.execute('PRAGMA journal_mode=WAL'); writer.execute('CREATE TABLE usage(id INTEGER, cost REAL)'); writer.execute('INSERT INTO usage VALUES(1,7)'); writer.commit()
        with sqlite3.connect('file:' + str(live) + '?mode=ro', uri=True) as db: db.execute('VACUUM INTO ?', (str(self.root / 'copy.db'),))
        writer.execute('INSERT INTO usage VALUES(2,11)'); writer.commit(); writer.close()
        with sqlite3.connect(self.root / 'copy.db') as db: self.assertEqual(db.execute('SELECT SUM(cost) FROM usage').fetchone()[0], 7)
    def test_authorized_keys_merge_keeps_replacement_operator_access(self):
        archive = self.bundle(); stage = self.root / 'auth'; file = stage / 'rootfs/root/.ssh/authorized_keys'; file.parent.mkdir(parents=True); file.write_text('ssh-ed25519 original\n')
        meta = {'tool': TOOL, 'role': 'control', 'files': {'rootfs/root/.ssh/authorized_keys': {'sha256': sha256(file), 'bytes': file.stat().st_size}}}
        (stage / 'manifest.json').write_text(json.dumps(meta)); archive = self.root / 'auth.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar: tar.add(stage, arcname='.')
        out = self.root / 'dest'; target = out / 'root/.ssh/authorized_keys'; target.parent.mkdir(parents=True); target.write_text('ssh-ed25519 replacement-operator\n')
        extract_bundle(archive, out, merge_authorized_keys=True)
        self.assertEqual(target.read_text(), 'ssh-ed25519 replacement-operator\nssh-ed25519 original\n')

    def test_worker_rebind_clears_only_ephemeral_runtime(self):
        module = load_script('dr-rebind-node')
        value = {'id':'vm-4', 'node_id':'node-458204a6', 'owner_id':'tenant', 'account':{'secret':'synthetic'}, 'proxy_id':'proxy-one', 'machine':{'id':'stable'}, 'runtime':{'type':'docker','container_id':'old','pid':72,'user':'10001:10001','container':'kin-4','remote_dir':'/root/.vm2api/vms/vm-4'}}
        result = module.clear_runtime(value)
        self.assertEqual(result['runtime'], {'type':'docker','user':'10001:10001','container':'kin-4','remote_dir':'/root/.vm2api/vms/vm-4'})
        self.assertEqual({k:v for k,v in result.items() if k != 'runtime'}, {k:v for k,v in value.items() if k != 'runtime'})
        self.assertEqual(value['runtime']['container_id'], 'old')
    def test_live_restore_keeps_old_database_wal_and_requires_root_and_overwrite(self):
        module = load_script('dr-restore'); root = self.root / 'app'; root.mkdir(); (root / 'kin.db').write_text('old-db'); (root / 'kin.db-wal').write_text('old-wal')
        with patch.object(module.os, 'geteuid', return_value=1000):
            with self.assertRaises(PermissionError): module.prepare_live_root(root, overwrite=True)
        with patch.object(module.os, 'geteuid', return_value=0):
            with self.assertRaises(FileExistsError): module.prepare_live_root(root)
            previous = Path(module.prepare_live_root(root, overwrite=True))
        self.assertFalse(root.exists()); self.assertEqual((previous / 'kin.db-wal').read_text(), 'old-wal'); self.assertEqual((previous / 'kin.db').read_text(), 'old-db')
    def test_latest_successful_node_is_recoverable_when_another_worker_failed(self):
        module = load_script('dr-restore'); daily = self.root / 'partial'; daily.mkdir()
        (daily / 'run.json').write_text(json.dumps({'tool':TOOL, 'status':'incomplete', 'nodes':{'control':{'file':'control.tar.gz'}}, 'errors':{'worker188':'ConnectionError'}}))
        with self.assertRaises(ValueError): module.restore_record(daily, 'control')
        self.assertEqual(module.restore_record(daily, 'control', allow_partial=True)['file'], 'control.tar.gz')
        with self.assertRaises(ValueError): module.restore_record(daily, 'worker188', allow_partial=True)
    def test_pull_is_direct_and_ignores_user_ssh_jump_configuration(self):
        module = load_script('dr-pull')
        args = module.ssh_args({'known_hosts':'/known', 'identity_file':'/key', 'ssh_config':'/unwanted-jump'}, {'ssh':'root@host'}, 'snapshot')
        self.assertEqual(args[1:3], ['-F','/dev/null']); self.assertNotIn('/unwanted-jump',args)

    def test_chunk_transfer_resumes_verified_parts_and_rejects_corrupt_cache(self):
        module = load_script('dr-pull'); blob = os.urandom(5 * 1024**2)
        import hashlib
        meta = {'tool':TOOL,'sha256':hashlib.sha256(blob).hexdigest(),'bytes':len(blob),'role':'worker188'}
        source = {'ssh':'root@direct-source','chunk_workers':1}; target = self.root/'worker188.tar.gz'; log = self.root/'log'; calls=[]
        def receive(config, source, command, dest, log):
            _,digest,offset,size=command.split();offset=int(offset);size=int(size);calls.append(offset)
            if offset >= 2*1024**2: raise OSError('fixture interrupted connection')
            data=blob[offset:offset+size];dest.write_bytes(data)
            return {'tool':TOOL,'artifact':digest,'offset':offset,'bytes':size,'sha256':hashlib.sha256(data).hexdigest()}
        with patch.object(module,'artifact_info',return_value=meta),patch.object(module,'receive_stream',side_effect=receive):
            with self.assertRaises(OSError): module.receive_chunked({},source,'snapshot',target,log)
        parts=self.root/('.chunks-'+meta['sha256']);self.assertTrue((parts/'0').exists())
        (parts/'0').write_bytes(b'corrupt cached part');calls.clear()
        def finish(config, source, command, dest, log):
            _,digest,offset,size=command.split();offset=int(offset);size=int(size);calls.append(offset);data=blob[offset:offset+size];dest.write_bytes(data)
            return {'tool':TOOL,'artifact':digest,'offset':offset,'bytes':size,'sha256':hashlib.sha256(data).hexdigest()}
        with patch.object(module,'artifact_info') as info,patch.object(module,'receive_stream',side_effect=finish):
            module.receive_chunked({},source,'snapshot',target,log);info.assert_not_called()
        self.assertIn(0,calls);self.assertEqual(target.read_bytes(),blob);self.assertFalse(parts.exists())

    def test_chunk_transfer_skips_valid_parts_and_refuses_bad_metadata(self):
        module=load_script('dr-pull');blob=b'fixture';import hashlib
        digest=hashlib.sha256(blob).hexdigest();meta={'tool':TOOL,'sha256':digest,'bytes':len(blob)}
        source={'ssh':'root@direct','chunk_workers':2};target=self.root/'image.tar.gz';parts=self.root/('.chunks-'+digest);parts.mkdir();(parts/'0').write_bytes(blob)
        (parts/'0.json').write_text(json.dumps({'artifact':digest,'offset':0,'bytes':len(blob),'sha256':digest}))
        with patch.object(module,'artifact_info',return_value=meta),patch.object(module,'receive_stream') as receive:
            module.receive_chunked({},source,'image sha256:'+digest,target,self.root/'log');receive.assert_not_called()
        with self.assertRaises(ValueError):module.validate_artifact_meta({'tool':TOOL,'sha256':'../../escape','bytes':10})
        with self.assertRaises(ValueError):module.validate_artifact_meta({'tool':TOOL,'sha256':digest,'bytes':-1})

    def test_export_chunk_only_reads_registered_blob_with_bounded_range(self):
        import hashlib
        work=self.root/'work';artifacts=work/'artifacts';artifacts.mkdir(parents=True);blob=b'private registered fixture';digest=hashlib.sha256(blob).hexdigest()
        (artifacts/(digest+'.tar.gz')).write_bytes(blob);(artifacts/(digest+'.json')).write_text(json.dumps({'tool':TOOL,'sha256':digest,'bytes':len(blob)}))
        output=type('BinaryOutput',(),{'buffer':io.BytesIO()})()
        with patch.object(exporter.sys,'stdout',output):exporter.artifact_chunk({'work':str(work)},digest,2,5)
        header,data=output.buffer.getvalue().split(b'\n',1);self.assertEqual(data,blob[2:7]);self.assertEqual(json.loads(header)['sha256'],hashlib.sha256(data).hexdigest())
        for offset,length in [(-1,1),(0,9*1024**2),(len(blob),1)]:
            with self.assertRaises(ValueError):exporter.artifact_chunk({'work':str(work)},digest,offset,length)
        with self.assertRaises(ValueError):exporter.artifact_chunk({'work':str(work)},'../../escape',0,1)
        (artifacts/(digest+'.tar.gz')).unlink();(artifacts/(digest+'.tar.gz')).symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):exporter.artifact_chunk({'work':str(work)},digest,0,1)

    def test_edge_links_are_recorded_and_only_explicit_targets_are_copied(self):
        app=self.root/'app';app.mkdir();work=self.root/'agent/tmp';work.mkdir(parents=True)
        cert=self.root/'archive/cert1.pem';cert.parent.mkdir();cert.write_bytes(b'synthetic certificate')
        link=self.root/'live/cert.pem';link.parent.mkdir();link.symlink_to('../archive/cert1.pem')
        extra=self.root/'nginx.conf';extra.write_text('synthetic service configuration')
        config={'role':'worker23','root':str(app),'work':str(work),'extra_paths':[str(extra)],'recovery_links':[str(link)]}
        archive=self.root/'edge.tar.gz'
        with patch.object(exporter,'inventory',return_value={'role':'worker23','containers':[]}),patch.object(exporter.Path,'home',return_value=self.root):
            result=exporter.snapshot(config,archive)
        self.assertEqual(result['recovery_links'],{str(link):'../archive/cert1.pem'})
        self.assertIn('rootfs/'+str(cert).lstrip('/'),result['files']);self.assertNotIn('rootfs/'+str(link).lstrip('/'),result['files'])
        with tarfile.open(archive) as tar:self.assertFalse(any(x.issym() for x in tar))

if __name__ == '__main__': unittest.main()
