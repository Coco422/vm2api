"""Shared integrity, safe extraction and seven-calendar-day retention helpers."""
from pathlib import Path, PurePosixPath
import datetime, hashlib, json, os, shutil, tarfile

TOOL = 'vm2api-dr-v1'

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        while chunk := stream.read(4 * 1024 * 1024): h.update(chunk)
    return h.hexdigest()

def member_name(raw):
    path = PurePosixPath(raw)
    if path.is_absolute() or '..' in path.parts: raise ValueError('Unsafe archive path')
    name = str(path)
    if name not in {'.', 'manifest.json', 'rootfs'} and not name.startswith('rootfs/'):
        raise ValueError('Unexpected archive member')
    return name

def read_manifest(archive):
    with tarfile.open(archive, 'r:gz') as stream:
        item = next(x for x in stream if member_name(x.name) == 'manifest.json')
        if not item.isfile() or item.size > 16 * 1024 * 1024: raise ValueError('Invalid manifest')
        manifest = json.load(stream.extractfile(item))
    if manifest.get('tool') != TOOL: raise ValueError('Not a vm2api recovery archive')
    return manifest

def verify_bundle(archive, expected_role=None):
    manifest = read_manifest(archive)
    if expected_role and manifest['role'] != expected_role: raise ValueError('Source role mismatch')
    expected = {name: info for name, info in manifest['files'].items() if info.get('type') != 'directory'}
    seen = set()
    with tarfile.open(archive, 'r|gz') as stream:
        for item in stream:
            name = member_name(item.name)
            if item.isdir(): continue
            if not item.isfile(): raise ValueError('Links/devices are not restore payload')
            if name == 'manifest.json': continue
            if name not in expected or name in seen: raise ValueError('Unlisted/duplicate payload')
            h = hashlib.sha256(); size = 0
            source = stream.extractfile(item)
            while chunk := source.read(4 * 1024 * 1024): h.update(chunk); size += len(chunk)
            if h.hexdigest() != expected[name]['sha256'] or size != expected[name]['bytes']:
                raise ValueError('Payload checksum mismatch')
            seen.add(name)
    if seen != set(expected): raise ValueError('Missing recovery payload')
    return manifest

def extract_bundle(archive, destination, *, preserve_owner=False, overwrite=False, merge_authorized_keys=False):
    manifest = verify_bundle(archive)
    destination = Path(destination).resolve(); destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    directories = []
    with tarfile.open(archive, 'r|gz') as stream:
        for item in stream:
            name = member_name(item.name)
            if name in {'.', 'manifest.json', 'rootfs'}: continue
            relative = name.removeprefix('rootfs/'); target = destination / relative
            # Existing parent links must never redirect a restore outside its target.
            current = destination
            for part in PurePosixPath(relative).parts[:-1]:
                current /= part
                if current.is_symlink(): raise ValueError('Symlink in restore destination')
                current.mkdir(exist_ok=True, mode=0o700)
            if target.is_symlink(): raise ValueError('Symlink restore destination')
            if item.isdir():
                target.mkdir(exist_ok=True, mode=0o700); directories.append((target, item)); continue
            if not item.isfile(): raise ValueError('Unsupported member')
            if merge_authorized_keys and '/.ssh/' in relative and PurePosixPath(relative).name.startswith('authorized_keys') and target.exists():
                previous = target.read_bytes(); incoming = stream.extractfile(item).read().splitlines()
                additions = [line for line in incoming if line and line not in previous.splitlines()]
                if additions:
                    with target.open('ab') as output:
                        if previous and not previous.endswith(b'\n'): output.write(b'\n')
                        output.write(b'\n'.join(additions) + b'\n')
                target.chmod(0o600)
                continue
            with target.open('wb' if overwrite else 'xb') as output:
                shutil.copyfileobj(stream.extractfile(item), output, 4 * 1024 * 1024)
            target.chmod(item.mode & 0o777)
            if preserve_owner: os.chown(target, item.uid, item.gid)
    for target, item in reversed(directories):
        target.chmod(item.mode & 0o777)
        if preserve_owner: os.chown(target, item.uid, item.gid)
    return manifest

def prune_daily(root, today, days=7):
    """Only remove completed, owned dates after a new complete set has been published."""
    root = Path(root); cutoff = today - datetime.timedelta(days=days - 1); removed = []
    for child in root.iterdir():
        if child.is_symlink() or not child.is_dir(): continue
        try: date = datetime.date.fromisoformat(child.name)
        except ValueError: continue
        marker = child / 'complete.json'
        if date >= cutoff or not marker.is_file(): continue
        info = json.loads(marker.read_text())
        if info.get('tool') != TOOL or info.get('status') != 'complete': continue
        shutil.rmtree(child); removed.append(child.name)
    return removed

def image_projection(image):
    config = image['Config']
    fields = [('Env', []), ('Cmd', []), ('Entrypoint', []), ('WorkingDir', ''), ('User', ''), ('Labels', {}), ('Volumes', {}), ('ExposedPorts', {}), ('StopSignal', '')]
    return {'rootfs': image['RootFS']['Layers'], 'architecture': image['Architecture'], 'os': image['Os'], 'config': {key: config.get(key) or fallback for key, fallback in fields}}
