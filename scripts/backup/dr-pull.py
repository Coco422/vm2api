#!/usr/bin/env python3
"""Run on 189: pull all nodes independently; publish only verified complete daily sets."""
from pathlib import Path
from zoneinfo import ZoneInfo
import argparse, datetime, fcntl, hashlib, json, os, shutil, subprocess, sys, uuid
from dr_common import TOOL, sha256, verify_bundle, prune_daily

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()

def ssh_args(config, source, command):
    return ['ssh', '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + config['known_hosts'], '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-i', config['identity_file'], source['ssh'], command]

def receive(config, source, command, target, log):
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

def run(config):
    root = Path(config['destination']); marker = root / '.vm2api-dr-owner.json'
    if json.loads(marker.read_text()).get('tool') != TOOL: raise ValueError('Destination owner marker mismatch')
    today = datetime.datetime.now(ZoneInfo('Asia/Shanghai')).date(); stamp = now(); runid = uuid.uuid4().hex[:12]
    stage = root / 'daily' / ('.partial-' + str(today) + '-' + runid); stage.mkdir(mode=0o700)
    result = {'tool': TOOL, 'started_at': stamp, 'date': str(today), 'status': 'incomplete', 'nodes': {}, 'errors': {}}
    images = root / 'images'; images.mkdir(exist_ok=True, mode=0o700)
    for source in config['sources']:
        role = source['role']; log = root / 'logs' / (str(today) + '-' + role + '.log')
        try:
            dest = stage / (role + '.tar.gz'); meta = receive(config, source, 'snapshot', dest, log)
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
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); args = parser.parse_args()
    os.umask(0o077); config = json.loads(Path(args.config).read_text()); root = Path(config['destination'])
    with (root / 'pull.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(config)

if __name__ == '__main__': main()
