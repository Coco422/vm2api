#!/usr/bin/env python3
"""Forced-command backup source. Only inventory, snapshot and allowlisted images can leave this host."""
from pathlib import Path
import argparse, datetime, fcntl, hashlib, json, os, re, shutil, sqlite3, stat, subprocess, sys, tarfile, tempfile

TOOL = 'vm2api-dr-v1'
SKIP_DIRS = {'run', 'logs', 'backups', '.cache', '.npm', 'audit-maintenance', 'ops', '__pycache__'}

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        while chunk := stream.read(4 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True)

def image_projection(image):
    cfg = image['Config']
    return {'rootfs': image['RootFS']['Layers'], 'architecture': image['Architecture'], 'os': image['Os'], 'config': {key: cfg.get(key) or default for key, default in [('Env', []), ('Cmd', []), ('Entrypoint', []), ('WorkingDir', ''), ('User', ''), ('Labels', {}), ('Volumes', {}), ('ExposedPorts', {}), ('StopSignal', '')]}}

def inventory(config):
    containers = []
    for cid in docker('ps', '-aq').split():
        item = json.loads(docker('inspect', cid))[0]
        name = item['Name'].lstrip('/')
        if name.startswith('kin-') or name in config.get('extra_containers', []):
            containers.append(item)
    image_ids = {item['Image'] for item in containers}
    # Stopped slots have no container yet; retain the already prepared slot images too.
    for line in docker('image', 'ls', '--no-trunc', '--format', '{{json .}}').splitlines():
        row = json.loads(line)
        if row['Repository'].startswith('vm2api/kin-slot-'):
            image_ids.add(row['ID'])
    images = []
    for image_id in sorted(image_ids):
        item = json.loads(docker('image', 'inspect', image_id))[0]
        images.append({'id': item['Id'], 'tags': item.get('RepoTags') or [], 'alias': 'vm2api-dr:' + item['Id'].split(':')[1], 'bytes': item['Size'], 'projection': image_projection(item)})
    return {'tool': TOOL, 'role': config['role'], 'node_id': config.get('node_id'), 'root': config['root'], 'captured_at': now(), 'images': images, 'containers': containers, 'source_uid': os.getuid()}

def copy_path(source, staging, manifest, *, include_runtime=False):
    """Copy regular persisted data without following links, sockets or runtime caches."""
    source = Path(source)
    if not source.exists() or source.is_symlink():
        return
    parts = source.parts
    if not include_runtime and any(part in SKIP_DIRS for part in parts):
        return
    if source.is_dir():
        info = source.stat(); name = 'rootfs/' + str(source).lstrip('/')
        dest = staging / name; dest.mkdir(parents=True, exist_ok=True, mode=0o700)
        manifest[name] = {'type': 'directory', 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
        for child in sorted(source.iterdir()):
            copy_path(child, staging, manifest, include_runtime=include_runtime)
        return
    info = source.stat()
    if not stat.S_ISREG(info.st_mode) or source.name.endswith(('-wal', '-shm', '.lock')):
        return
    name = 'rootfs/' + str(source).lstrip('/')
    dest = staging / name
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copy2(source, dest)
    manifest[name] = {'sha256': sha256(dest), 'bytes': dest.stat().st_size, 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}

def snapshot(config, dest):
    inv = inventory(config)
    started = now()
    root = Path(config['root'])
    with tempfile.TemporaryDirectory(prefix='snapshot-', dir=config['work']) as tmp:
        stage = Path(tmp); files = {}
        if config['role'] == 'control':
            # VACUUM INTO reads a consistent WAL snapshot without stopping the gateway.
            target = stage / ('rootfs/' + str(root / 'data/kin.db').lstrip('/'))
            target.parent.mkdir(parents=True, mode=0o700)
            with sqlite3.connect('file:' + str(root / 'data/kin.db') + '?mode=ro', uri=True, timeout=30) as db:
                db.execute('VACUUM INTO ?', (str(target),))
            with sqlite3.connect('file:' + str(target) + '?mode=ro', uri=True) as db:
                assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
                inv['database'] = {'usage_rows': db.execute('SELECT COUNT(*) FROM usage_logs').fetchone()[0], 'vm_rows': db.execute('SELECT COUNT(*) FROM vms').fetchone()[0], 'user_rows': db.execute('SELECT COUNT(*) FROM users WHERE deleted_at IS NULL').fetchone()[0]}
            original = (root / 'data/kin.db').stat(); mode = stat.S_IMODE(original.st_mode)
            target.chmod(mode)
            files[str(target.relative_to(stage))] = {'sha256': sha256(target), 'bytes': target.stat().st_size, 'mode': mode, 'uid': original.st_uid, 'gid': original.st_gid}
            for name in ['.env', 'docker-compose.yml', 'src/config', 'vms', 'bin', 'share']:
                copy_path(root / name, stage, files)
            data = root / 'data'
            for child in sorted(data.iterdir()):
                if child.name not in {'kin.db', 'kin.db-wal', 'kin.db-shm', 'cluster', 'backups', 'run'}:
                    copy_path(child, stage, files)
            # `run` normally contains sockets; its shared binary directory is durable payload.
            payload = data / 'run/slot-guest-bin'
            copy_path(payload, stage, files, include_runtime=True)
        else:
            for name in ['vms', 'guest-bin', 'bin', 'share']:
                copy_path(root / name, stage, files)
        for authorized in (Path.home() / '.ssh').glob('authorized_keys*'):
            copy_path(authorized, stage, files)
        agent = Path(config['work']).parent
        for name in ['dr-export.py', 'dr_common.py', 'source.json']:
            copy_path(agent / name, stage, files)
        # Include vm2api-owned dependency configuration (e.g. the existing 188 Mihomo).
        # Docker sockets/devices/volumes are runtime dependencies, never copied as host data.
        for container in inv['containers']:
            for mount in container.get('Mounts', []):
                source = Path(mount['Source'])
                if mount['Type'] == 'bind' and str(source).startswith('/opt/') and not source.is_relative_to(root):
                    copy_path(source, stage, files)
                if container['Name'].lstrip('/') == 'vm2api-mihomo-188' and mount['Type'] == 'volume':
                    copy_path(source, stage, files)
        inv.update({'capture_started_at': started, 'capture_finished_at': now(), 'files': files, 'excluded': sorted(SKIP_DIRS), 'consistency': 'online consistent control SQLite; atomic persisted VM files; capture times recorded per node'})
        (stage / 'manifest.json').write_text(json.dumps(inv, indent=2) + '\n')
        def preserve(info):
            attrs = files.get(info.name.removeprefix('./'))
            if attrs:
                info.uid, info.gid, info.mode = attrs['uid'], attrs['gid'], attrs['mode']
            return info
        with tarfile.open(dest, 'w:gz', compresslevel=1) as archive:
            archive.add(stage, arcname='.', filter=preserve)
    return inv

def stream(path, metadata):
    header = {'tool': TOOL, 'bytes': path.stat().st_size, 'sha256': sha256(path), **metadata}
    sys.stdout.buffer.write((json.dumps(header) + '\n').encode()); sys.stdout.buffer.flush()
    with path.open('rb') as payload:
        shutil.copyfileobj(payload, sys.stdout.buffer, 4 * 1024 * 1024)
    sys.stdout.buffer.flush()

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); args = parser.parse_args()
    config = json.loads(Path(args.config).read_text()); work = Path(config['work']); work.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077); os.nice(10)
    original = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if original not in {'inventory', 'snapshot'} and not re.fullmatch(r'image sha256:[a-f0-9]{64}', original):
        raise SystemExit('Unsupported backup command')
    with (work / 'export.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        inv = inventory(config)
        if original == 'inventory':
            # Container environment is private; the inventory endpoint only returns image metadata.
            safe = {key: value for key, value in inv.items() if key != 'containers'}
            print(json.dumps(safe)); return
        with tempfile.TemporaryDirectory(prefix='export-', dir=work) as tmp:
            archive = Path(tmp) / 'payload.tar.gz'
            if original == 'snapshot':
                result = snapshot(config, archive); stream(archive, {'role': config['role'], 'captured_at': result['capture_finished_at']})
            else:
                image_id = original.split()[1]; item = next((i for i in inv['images'] if i['id'] == image_id), None)
                if not item: raise SystemExit('Image is not part of vm2api recovery inventory')
                alias = item['alias']; prior = subprocess.run(['docker', 'image', 'inspect', alias], capture_output=True, text=True)
                if prior.returncode == 0 and json.loads(prior.stdout)[0]['Id'] != image_id: raise SystemExit('Recovery alias collision')
                created = prior.returncode != 0
                try:
                    if created: subprocess.run(['docker', 'tag', image_id, alias], check=True, stdout=subprocess.DEVNULL)
                    with archive.open('wb') as output:
                        source = subprocess.Popen(['docker', 'image', 'save', alias], stdout=subprocess.PIPE)
                        compressor = subprocess.run(['gzip', '-1'], stdin=source.stdout, stdout=output); source.stdout.close()
                        assert source.wait() == 0 and compressor.returncode == 0
                    stream(archive, {'image_id': image_id, 'alias': alias})
                finally:
                    if created: subprocess.run(['docker', 'image', 'rm', '--no-prune', alias], check=True, stdout=subprocess.DEVNULL)

if __name__ == '__main__':
    main()
