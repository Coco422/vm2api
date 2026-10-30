#!/usr/bin/env python3
"""Verify or stage a node restore; applying at / requires explicit confirmation and stopped services."""
from pathlib import Path
import argparse, datetime, http.client, json, os, socket, subprocess, time
from dr_common import TOOL, sha256, verify_bundle, extract_bundle, image_projection

def docker_inspect(name):
    result = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None

def load_images(record, images_dir, log):
    """Load only the private recovery alias; do not overwrite development/production tags."""
    loaded = []
    for image in record['images']:
        archive = images_dir / image['file']
        if sha256(archive) != image['sha256']: raise ValueError('Recovery image archive checksum mismatch')
        prior = docker_inspect(image['alias'])
        if prior and image_projection(prior) != image['projection']: raise ValueError('Recovery image alias collision')
        if not prior:
            with log.open('ab') as output:
                subprocess.run(['docker', 'load', '-i', str(archive)], stdout=output, stderr=output, check=True)
        actual = docker_inspect(image['alias'])
        if not actual or image_projection(actual) != image['projection']: raise ValueError('Restored image content differs')
        loaded.append({'source_id': image['id'], 'local_id': actual['Id'], 'alias': image['alias'], 'tags': image['tags']})
    return loaded

def application_plan(manifest, loaded):
    mapping = {item['source_id']: item['alias'] for item in loaded}
    return {'role': manifest['role'], 'root': manifest['root'], 'node_id': manifest.get('node_id'), 'containers': [{'name': item['Name'].lstrip('/'), 'image_alias': mapping.get(item['Image']), 'was_running': item['State']['Running'], 'original_user': item['Config'].get('User'), 'restart_policy': item['HostConfig'].get('RestartPolicy'), 'mounts': [{'source': mount['Source'], 'destination': mount['Destination'], 'type': mount['Type']} for mount in item.get('Mounts', [])]} for item in manifest['containers']]}

def start_dependencies(manifest, loaded):
    mapping = {item['source_id']: item['alias'] for item in loaded}; restored = []
    class DockerConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX); self.sock.connect('/var/run/docker.sock')
    def call(method, path, body=None):
        conn = DockerConnection('localhost'); data = json.dumps(body).encode() if body is not None else None
        conn.request(method, '/v1.43' + path, data, {'Content-Type': 'application/json'}); response = conn.getresponse(); payload = response.read(); status = response.status; conn.close()
        if status not in [200, 201, 204, 304]: raise RuntimeError('Dependency Docker operation failed: ' + str(status))
        return json.loads(payload) if payload else None
    for item in manifest['containers']:
        name = item['Name'].lstrip('/')
        if name != 'vm2api-mihomo-188': continue
        if docker_inspect(name): raise ValueError('Existing dependency container must be reviewed before recreation')
        config = {key: item['Config'][key] for key in ['Cmd', 'Entrypoint', 'Env', 'WorkingDir', 'User', 'Labels', 'ExposedPorts', 'Volumes', 'StopSignal'] if key in item['Config']}
        config['Image'] = mapping[item['Image']]
        config['HostConfig'] = {key: item['HostConfig'][key] for key in ['Binds', 'PortBindings', 'NetworkMode', 'RestartPolicy', 'Memory', 'MemorySwap', 'NanoCpus', 'CpuQuota', 'CpuPeriod', 'CapAdd', 'CapDrop', 'SecurityOpt', 'ReadonlyRootfs', 'Dns', 'DnsOptions', 'DnsSearch', 'ExtraHosts', 'Tmpfs', 'PidsLimit', 'ShmSize'] if key in item['HostConfig']}
        for mount in item.get('Mounts', []):
            if mount['Type'] == 'volume':
                call('POST', '/volumes/create', {'Name': mount['Name'], 'Driver': 'local'})
                config['HostConfig']['Binds'] = (config['HostConfig'].get('Binds') or []) + [mount['Name'] + ':' + mount['Destination']]
        created = call('POST', '/containers/create?name=' + name, config)
        call('POST', '/containers/' + created['Id'] + '/start'); restored.append(name)
    return restored

def prepare_live_root(root, *, overwrite=False):
    """Keep an old database and its WAL together; never mix them with a restored DB."""
    root = Path(root)
    if os.geteuid() != 0: raise PermissionError('Live restore must run as root to preserve VM ownership')
    if not root.is_absolute() or len(root.parts) < 3 or root.is_symlink(): raise ValueError('Unsafe application root')
    if not root.exists(): return None
    if not overwrite: raise FileExistsError('Destination application root exists; review it before --overwrite')
    suffix = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    previous = root.with_name(root.name + '.pre-recovery-' + suffix)
    root.rename(previous)
    return str(previous)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--daily', required=True, type=Path)
    parser.add_argument('--role', required=True, choices=['control', 'worker188', 'worker23'])
    parser.add_argument('--images', required=True, type=Path)
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm-live-target', action='store_true')
    parser.add_argument('--overwrite', action='store_true')
    parser.add_argument('--load-images', action='store_true')
    parser.add_argument('--start-control', action='store_true')
    parser.add_argument('--start-dependencies', action='store_true')
    args = parser.parse_args(); os.umask(0o077)
    complete = json.loads((args.daily / 'complete.json').read_text())
    if complete.get('tool') != TOOL or complete.get('status') != 'complete': raise ValueError('Daily set is not complete')
    record = complete['nodes'][args.role]; archive = args.daily / record['file']
    if sha256(archive) != record['sha256']: raise ValueError('Node archive checksum mismatch')
    manifest = verify_bundle(archive, args.role)
    destination = args.destination.resolve() if args.destination else None
    if args.apply and not destination: raise ValueError('--apply requires --destination')
    if (args.start_control or args.start_dependencies) and not (args.apply and destination == Path('/') and args.confirm_live_target and args.load_images):
        raise ValueError('Starting services requires an explicit live-target restore and loaded images')
    if args.start_control and args.role != 'control': raise ValueError('Control startup requires the control bundle')
    if args.apply and destination == Path('/'):
        if not args.confirm_live_target: raise ValueError('Refuse live restore without --confirm-live-target')
        for container in manifest['containers']:
            prior = docker_inspect(container['Name'])
            if prior and prior['State']['Running']: raise ValueError('Stop the destination vm2api services first')
    output_dir = (destination if destination and destination != Path('/') else args.daily) / 'restore-evidence'
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    loaded = load_images(record, args.images, output_dir / 'image-load.log') if args.load_images else []
    previous_root = None
    if args.apply and destination == Path('/'):
        root = Path(manifest['root'])
        if args.daily.resolve().is_relative_to(root): raise ValueError('Keep recovery bundles outside the application root')
        previous_root = prepare_live_root(root, overwrite=args.overwrite)
    if args.apply:
        extract_bundle(archive, destination, preserve_owner=os.getuid() == 0, overwrite=args.overwrite, merge_authorized_keys=destination == Path('/'))
    plan = application_plan(manifest, loaded)
    if args.apply and destination == Path('/'):
        # Original application tags are assigned only as an explicit live restore action.
        for image in loaded:
            for tag in image['tags']:
                previous = docker_inspect(tag)
                if previous and previous['Id'] != image['local_id'] and not args.overwrite: raise ValueError('Existing application tag differs')
                subprocess.run(['docker', 'tag', image['alias'], tag], check=True)
    dependencies = start_dependencies(manifest, loaded) if args.start_dependencies else []
    if args.start_control:
        root = Path(manifest['root'])
        subprocess.run(['docker', 'compose', '--env-file', str(root / '.env'), '-f', str(root / 'docker-compose.yml'), 'up', '-d', '--no-deps', 'vm2api'], cwd=root, check=True)
    (output_dir / (args.role + '-recovery-plan.json')).write_text(json.dumps(plan, indent=2) + '\n')
    result = {'tool': TOOL, 'role': args.role, 'all_file_hashes_verified': True, 'images_verified': len(loaded), 'files_staged': args.apply, 'destination': str(destination) if destination else None, 'previous_root': previous_root, 'control_started': args.start_control, 'dependencies_started': dependencies, 'VM_restart': 'use dr-resume.py through the native control API', 'plan': str(output_dir / (args.role + '-recovery-plan.json'))}
    print(json.dumps(result))

if __name__ == '__main__': main()
