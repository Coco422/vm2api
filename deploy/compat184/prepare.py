#!/usr/bin/env python3
"""Materialize the pinned company184 rollback build context in a fresh directory."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def prepare(repo, output):
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    patch_bytes = ''.join(json.loads((ROOT / 'overlay.json').read_text())['patch_lines']).encode()
    if hashlib.sha256(patch_bytes).hexdigest() != manifest['patch_sha256']:
        raise ValueError('compat184 patch digest mismatch')
    if output.exists() or output.is_symlink():
        raise FileExistsError(output)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.prepare-') as work:
        patch = Path(work) / 'compat184.patch'
        patch.write_bytes(patch_bytes)
        stage = Path(work) / 'source'
        stage.mkdir()
        archive = Path(work) / 'base.tar'
        subprocess.run(['git', '-C', str(repo), 'archive', '--format=tar', '-o', str(archive), manifest['base_commit']], check=True)
        with tarfile.open(archive) as tar:
            tar.extractall(stage, filter='data')
        for file, hashes in manifest['files'].items():
            source = stage / file
            if hashes['base_sha256'] is None:
                if source.exists() or source.is_symlink():
                    raise ValueError(f'unexpected base file: {file}')
                continue
            if sha(source) != hashes['base_sha256']:
                raise ValueError(f'base digest mismatch: {file}')
        subprocess.run(['git', 'apply', '--check', str(patch)], cwd=stage, check=True)
        subprocess.run(['git', 'apply', str(patch)], cwd=stage, check=True)
        for file, hashes in manifest['files'].items():
            if sha(stage / file) != hashes['rollback_sha256']:
                raise ValueError(f'rollback digest mismatch: {file}')
        stage.rename(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    prepare(args.repo.resolve(), args.output.resolve())
