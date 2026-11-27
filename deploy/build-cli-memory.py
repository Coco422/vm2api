#!/usr/bin/env python3
"""Rebuild the pinned x86 CLI with the reviewed memory/lifecycle overlay on native Linux."""
import argparse
import importlib.util
import json
import platform
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('native_cli', Path(__file__).with_name('build-native-cli.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError('unsupported CLI patch location: ' + old[:100])
    return source.replace(old, new, 1)


def patch_source(source):
    projector = Path(__file__).with_name('cli-cch-bytes.mjs').read_text()
    projector = replace_once(projector, 'export function projectCchBytes(', 'function projectCchBytes(')
    source = replace_once(source, 'const digest = xxh64(material, CCH_SEED);',
                          'const digest = Bun.hash.xxHash64(material, CCH_SEED);')
    start = source.index('function stampCchBody(body, enabled = true) {')
    end = source.index('\nvar CCH_SEED', start)
    source = source[:start] + projector + '\n' + '''function stampCchBody(body, enabled = true, normalize = false) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    if (normalize) throw error;
    return body;
  }
  if (!setSystemCch(parsed, "00000"))
    return normalize ? JSON.stringify(parsed) : body;
  if (!enabled) return JSON.stringify(parsed);
  const material = projectCchBytes(JSON.stringify(parsed));
  const digest = Bun.hash.xxHash64(material, CCH_SEED);
  setSystemCch(parsed, (digest & 0xfffffn).toString(16).padStart(5, "0"));
  return JSON.stringify(parsed);
}
''' + source[end:]
    source = replace_once(source, 'wire = JSON.stringify(JSON.parse(text));', 'wire = text;')
    source = replace_once(source, 'stampCchBody(wire, readPanelCchEnabled())',
                          'stampCchBody(wire, readPanelCchEnabled(), !!headers.get("content-type")?.includes("application/json"))')
    source = replace_once(source, '''slot.task = withOutboundHeaders((headers) => writeStdout({
    type: "stream_event",
    job_id: jobId,
    slot_id: slot.id,
    event: { type: "kin_outbound_headers", headers }
  }), () => runJob(''',
                          'slot.task = withOutboundHeaders(makeJobOutboundReporter(jobId, slot.id), () => runJob(')
    needle = 'function startJob(slots, slotIdArg, jobId, request3, hostOptions, requestContext) {'
    source = replace_once(source, needle, '''function makeJobOutboundReporter(jobId, slotId) {
  return (headers) => writeStdout({
    type: "stream_event", job_id: jobId, slot_id: slotId,
    event: { type: "kin_outbound_headers", headers }
  });
}
''' + needle)
    source = replace_once(source, 'const abort3 = new AbortController;\n  slot.jobId = jobId;',
                          'const abort3 = new AbortController;\n  slot.phase = "running";\n  slot.jobId = jobId;')
    source = replace_once(source, '    await emitRateLimitHeaders();\n    const failure =',
                          '    await emitRateLimitHeaders();\n    if (abort3.signal.aborted)\n      return;\n    const failure =')
    source = replace_once(source, '  await emitRateLimitHeaders();\n  await writeStdout({\n    type: "job_done",',
                          '  await emitRateLimitHeaders();\n  if (abort3.signal.aborted)\n    return;\n  await writeStdout({\n    type: "job_done",')
    return source


def x64_elf(data):
    if data[:6] != b'\x7fELF\x02\x01' or int.from_bytes(data[18:20], 'little') != 62:
        raise ValueError('expected Linux x86_64 ELF')


def build(args):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('native Linux x86_64 required; emulation is not allowed')
    manifest = json.loads(args.manifest.read_text())
    native.checked(Path(__file__).with_name('cli-cch-bytes.mjs').read_bytes(),
                   manifest['projector_sha256'], 'CCH byte projection')
    packed = native.checked(args.payload.read_bytes(), manifest['cli_sha256'], 'input CLI')
    if args.output.exists() or args.output.with_suffix('.manifest.json').exists():
        raise ValueError('output already exists')
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cli-memory-', dir=args.output.parent) as temp:
        work = Path(temp)
        upx = work / 'upx'
        upx.write_bytes(native.archive_member(native.download(manifest['upx'], args.cache),
                                              manifest['upx']['member'], 'tar'))
        x64_elf(upx.read_bytes())
        upx.chmod(0o755)
        original = work / 'original'
        original.write_bytes(packed)
        unpacked = work / 'unpacked'
        subprocess.run([str(upx), '-d', '-o', str(unpacked), str(original)], check=True, timeout=120,
                       stdout=subprocess.DEVNULL)
        raw = native.extract_source(unpacked.read_bytes(), manifest['source_sha256']).decode('utf-8')
        patched = patch_source(raw)
        native.checked(patched.encode(), manifest['patched_source_sha256'], 'patched CLI source')
        source = work / 'cli-memory.mjs'
        source.write_text(patched)
        bun = work / 'bun'
        bun.write_bytes(native.archive_member(native.download(manifest['bun'], args.cache),
                                              manifest['bun']['member'], 'zip'))
        native.checked(bun.read_bytes(), manifest['bun']['binary_sha256'], 'Bun compiler')
        x64_elf(bun.read_bytes())
        bun.chmod(0o755)
        version = subprocess.check_output([str(bun), '--version'], text=True).strip()
        if version != manifest['bun_version']:
            raise ValueError('unexpected Bun compiler version')
        command = [str(bun), 'build', '--compile', '--target=bun-linux-x64-baseline',
                   '--compile-executable-path=' + str(bun), '--outfile=cli-node', './cli-memory.mjs']
        subprocess.run(command, cwd=work, check=True, timeout=180)
        output = (work / 'cli-node').read_bytes()
        x64_elf(output)
        # Recompile with identical input to detect unstable output before publishing it.
        subprocess.run(command, cwd=work, check=True, timeout=180)
        if (work / 'cli-node').read_bytes() != output:
            raise ValueError('repeated native builds differ')
        meta = {'schema': 1, 'native_arch': platform.machine(), 'bun_version': version,
                'input_sha256': manifest['cli_sha256'], 'source_sha256': manifest['source_sha256'],
                'patched_source_sha256': native.digest(patched.encode()),
                'builder_sha256': native.digest(Path(__file__).read_bytes()),
                'tool_manifest_sha256': native.digest(args.manifest.read_bytes()),
                'output_sha256': native.digest(output), 'output_size': len(output),
                'repeat_build_equal': True}
        args.output.write_bytes(output)
        args.output.chmod(0o755)
        args.output.with_suffix('.manifest.json').write_text(json.dumps(meta, indent=2) + '\n')
        # GNU diff handles this generated bundle without quadratic matching work.
        original_source = work / 'verified-cli.mjs'
        original_source.write_text(raw)
        with args.output.with_suffix('.patch').open('w') as patch:
            result = subprocess.run(['diff', '-u', '--label=verified-cli.mjs', '--label=memory-cli.mjs',
                                     str(original_source), str(source)], stdout=patch, timeout=30)
        if result.returncode != 1:
            raise ValueError('expected a nonempty reviewed source diff')
        return meta


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, default=Path(__file__).with_name('cli-memory.json'))
    print(json.dumps(build(parser.parse_args())))
