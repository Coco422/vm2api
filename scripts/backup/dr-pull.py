#!/usr/bin/env python3
"""Run on 189: pull all nodes independently; publish only verified complete daily sets."""
from pathlib import Path
from zoneinfo import ZoneInfo
import argparse, datetime, fcntl, hashlib, json, os, shutil, subprocess, sys, uuid
from concurrent.futures import ThreadPoolExecutor
from dr_common import TOOL, sha256, verify_bundle, prune_daily

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()

def ssh_args(config, source, command):
    return ['ssh', '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + config['known_hosts'], '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-i', config['identity_file'], source['ssh'], command]

def receive_stream(config, source, command, target, log):
    partial = target.with_suffix(target.suffix + '.partial'); h = hashlib.sha256(); count = 0
    with log.open('ab') as errors, partial.open('wb') as output:
        child = subprocess.Popen(ssh_args(config, source, command), stdout=subprocess.PIPE, stderr=errors)
        try:
            header = child.stdout.readline(64 * 1024)
            meta = json.loads(header)
            if meta.get('tool') != TOOL: raise ValueError('Backup transport header mismatch')
            if not isinstance(meta.get('bytes'), int) or not 0 < meta['bytes'] < 32 * 1024**3: raise ValueError('Backup transport size rejected')
            if shutil.disk_usage(target.parent).free < meta['bytes'] + 512 * 1024**2: raise ValueError('Insufficient backup destination space')
            while chunk := child.stdout.read(4 * 1024 * 1024):
                output.write(chunk); h.update(chunk); count += len(chunk)
                if count > meta['bytes']: raise ValueError('Backup stream too large')
            if child.wait() != 0 or count != meta['bytes'] or h.hexdigest() != meta['sha256']:
                raise ValueError('Incomplete/corrupt backup transport')
            output.flush(); os.fsync(output.fileno())
        except BaseException:
            if child.poll() is None: child.terminate(); child.wait()
            raise
        finally: child.stdout.close()
    partial.replace(target); target.chmod(0o600)
    return meta

def artifact_info(config, source, command, log):
    with log.open('ab') as errors:
        child = subprocess.run(ssh_args(config, source, command), stdout=subprocess.PIPE, stderr=errors, timeout=600, check=True)
    if len(child.stdout) > 65536: raise ValueError('Artifact header too large')
    return validate_artifact_meta(json.loads(child.stdout))

def validate_artifact_meta(meta):
    if meta.get('tool') != TOOL or not isinstance(meta.get('bytes'), int) or not 0 < meta['bytes'] < 32 * 1024**3:
        raise ValueError('Artifact metadata rejected')
    digest = meta.get('sha256', '')
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest): raise ValueError('Artifact digest rejected')
    return meta

def receive_chunked(config, source, command, target, log):
    workers = source.get('chunk_workers', 1)
    if type(workers) is not int or not 1 <= workers <= 8: raise ValueError('Invalid chunk concurrency')
    receipt = target.with_suffix(target.suffix + '.transfer.json')
    if receipt.is_file():
        saved = json.loads(receipt.read_text())
        if saved.get('command') != command or saved.get('ssh') != source['ssh']: raise ValueError('Transfer receipt mismatch')
        meta = saved['meta']
    else:
        info_command = 'snapshot-info' if command == 'snapshot' else command.replace('image ', 'image-info ', 1)
        meta = artifact_info(config, source, info_command, log)
        receipt.write_text(json.dumps({'command': command, 'ssh': source['ssh'], 'meta': meta}) + '\n')
    meta = validate_artifact_meta(meta)
    digest = meta['sha256']; parts = target.parent / ('.chunks-' + digest); parts.mkdir(mode=0o700, exist_ok=True)
    if parts.is_symlink(): raise ValueError('Chunk destination link rejected')
    if shutil.disk_usage(target.parent).free < meta['bytes'] * 2 + 512 * 1024**2: raise ValueError('Insufficient chunk staging space')
    chunk_size = 2 * 1024**2
    def part(offset):
        size = min(chunk_size, meta['bytes'] - offset); dest = parts / str(offset); proof = parts / (str(offset) + '.json')
        if dest.is_file() and proof.is_file():
            check = json.loads(proof.read_text())
            if check.get('artifact') == digest and check.get('offset') == offset and check.get('bytes') == size and dest.stat().st_size == size and sha256(dest) == check.get('sha256'):
                return
        for attempt in range(3):
            try:
                check = receive_stream(config, source, f'chunk {digest} {offset} {size}', dest, log)
                if check.get('artifact') != digest or check.get('offset') != offset or check['bytes'] != size: raise ValueError('Chunk identity mismatch')
                proof.write_text(json.dumps(check) + '\n'); return
            except (OSError, ValueError, subprocess.SubprocessError):
                if attempt == 2: raise
    offsets = range(0, meta['bytes'], chunk_size)
    with ThreadPoolExecutor(max_workers=workers) as pool: list(pool.map(part, offsets))
    partial = target.with_suffix(target.suffix + '.partial')
    with partial.open('wb') as output:
        for offset in offsets:
            with (parts / str(offset)).open('rb') as stream: shutil.copyfileobj(stream, output, 4 * 1024**2)
        output.flush(); os.fsync(output.fileno())
    if partial.stat().st_size != meta['bytes'] or sha256(partial) != digest: raise ValueError('Assembled artifact checksum mismatch')
    partial.replace(target); target.chmod(0o600); shutil.rmtree(parts); receipt.unlink()
    return meta

def receive(config, source, command, target, log):
    return receive_chunked(config, source, command, target, log) if source.get('chunk_workers') else receive_stream(config, source, command, target, log)

def run(config, resume=None):
    root = Path(config['destination']); marker = root / '.vm2api-dr-owner.json'
    if json.loads(marker.read_text()).get('tool') != TOOL: raise ValueError('Destination owner marker mismatch')
    today = datetime.datetime.now(ZoneInfo('Asia/Shanghai')).date(); stamp = now(); runid = uuid.uuid4().hex[:12]
    if resume:
        stage = Path(resume)
        if stage.is_symlink() or stage.resolve().parent != (root / 'daily').resolve() or not stage.name.startswith('.partial-'):
            raise ValueError('Resume directory is outside owned staging area')
        owner = json.loads((stage / 'transfer-owner.json').read_text())
        if owner.get('tool') != TOOL or owner.get('date') != str(today): raise ValueError('Only resume today\'s owned transfer')
    else:
        stage = root / 'daily' / ('.partial-' + str(today) + '-' + runid); stage.mkdir(mode=0o700)
        (stage / 'transfer-owner.json').write_text(json.dumps({'tool': TOOL, 'date': str(today)}) + '\n')
    result = {'tool': TOOL, 'started_at': stamp, 'date': str(today), 'status': 'incomplete', 'nodes': {}, 'errors': {}}
    images = root / 'images'; images.mkdir(exist_ok=True, mode=0o700)
    for source in config['sources']:
        role = source['role']; log = root / 'logs' / (str(today) + '-' + role + '.log')
        try:
            dest = stage / (role + '.tar.gz'); receipt = stage / (role + '.verified.json')
            if dest.is_file() and receipt.is_file():
                meta = json.loads(receipt.read_text())
                if meta.get('tool') != TOOL or meta.get('role') != role or dest.stat().st_size != meta['bytes'] or sha256(dest) != meta['sha256']:
                    raise ValueError('Resumed node archive mismatch')
            else:
                meta = receive(config, source, 'snapshot', dest, log)
                if meta.get('role') != role: raise ValueError('Snapshot transport role mismatch')
                receipt.write_text(json.dumps(meta) + '\n')
            manifest = verify_bundle(dest, role); image_records = []
            for image in manifest['images']:
                key = image['id'].split(':')[1]
                if len(key) != 64 or any(c not in '0123456789abcdef' for c in key): raise ValueError('Invalid image identity')
                payload, metadata = images / (key + '.tar.gz'), images / (key + '.json')
                valid = False
                if payload.is_file() and metadata.is_file():
                    cached = json.loads(metadata.read_text()); valid = cached.get('tool') == TOOL and cached['sha256'] == sha256(payload)
                if not valid:
                    cached = receive(config, source, 'image ' + image['id'], payload, log)
                    if cached.get('image_id') != image['id']: raise ValueError('Image identity mismatch')
                    cached.update({'created_at': now(), 'projection': image['projection']}); metadata.write_text(json.dumps(cached, indent=2) + '\n'); metadata.chmod(0o600)
                image_records.append({'id': image['id'], 'file': payload.name, 'sha256': cached['sha256'], 'bytes': cached['bytes'], 'alias': image['alias'], 'tags': image['tags'], 'projection': image['projection']})
            result['nodes'][role] = {'file': dest.name, 'sha256': meta['sha256'], 'bytes': meta['bytes'], 'capture_started_at': manifest['capture_started_at'], 'capture_finished_at': manifest['capture_finished_at'], 'root': manifest['root'], 'node_id': manifest.get('node_id'), 'images': image_records, 'database': manifest.get('database'), 'persisted_files': sum(x.get('type') != 'directory' for x in manifest['files'].values())}
            print(json.dumps({'event': 'node_verified', 'role': role, 'images': len(image_records), 'bytes': meta['bytes']}), flush=True)
        except Exception as error:
            # Preserve other nodes even when a machine is down; do not rotate the last complete set.
            result['errors'][role] = type(error).__name__
        (stage / 'run.json').write_text(json.dumps(result, indent=2) + '\n')
    result['finished_at'] = now()
    (stage / 'run.json').write_text(json.dumps(result, indent=2) + '\n')
    if result['errors']:
        (root / 'last-failure.json').write_text(json.dumps(result, indent=2) + '\n'); raise RuntimeError('At least one node failed; previous complete backups retained')
    result['status'] = 'complete'
    tools = stage / 'tools'; tools.mkdir(mode=0o700)
    for script in Path(__file__).parent.glob('dr*.py'): shutil.copy2(script, tools / script.name)
    (stage / 'complete.json').write_text(json.dumps(result, indent=2) + '\n')
    final = root / 'daily' / str(today); retired = root / 'daily' / ('.retired-' + runid)
    if final.exists():
        if final.is_symlink() or json.loads((final / 'complete.json').read_text()).get('tool') != TOOL: raise ValueError('Existing daily directory is not owned')
        final.rename(retired)
    stage.rename(final)
    if retired.exists(): shutil.rmtree(retired)
    removed = prune_daily(root / 'daily', today, 7)
    # Image blobs stay while referenced by a retained complete restore set.
    referenced = set()
    for completed in (root / 'daily').glob('????-??-??/complete.json'):
        data = json.loads(completed.read_text())
        if data.get('tool') == TOOL:
            for node in data['nodes'].values(): referenced.update(image['id'].split(':')[1] for image in node['images'])
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)
    for metadata in images.glob('*.json'):
        data = json.loads(metadata.read_text())
        if metadata.stem not in referenced and data.get('tool') == TOOL and datetime.datetime.fromisoformat(data['created_at']) < cutoff:
            payload = metadata.with_suffix('.tar.gz')
            if payload.is_file() and not payload.is_symlink(): payload.unlink()
            metadata.unlink()
    status = {'tool': TOOL, 'last_success': result['finished_at'], 'date': str(today), 'nodes': list(result['nodes']), 'retained_days': 7, 'pruned': removed}
    (root / 'status.json').write_text(json.dumps(status, indent=2) + '\n'); print(json.dumps(status), flush=True)

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); parser.add_argument('--resume'); args = parser.parse_args()
    os.umask(0o077); config = json.loads(Path(args.config).read_text()); root = Path(config['destination'])
    with (root / 'pull.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(config, args.resume)

if __name__ == '__main__': main()
