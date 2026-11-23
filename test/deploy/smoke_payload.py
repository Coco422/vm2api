#!/usr/bin/env python3
"""Exercise pinned real payloads against loopback fixtures in a network-none container.

No live credentials or upstream model requests are required. The caller supplies
an owned work directory; all logs, synthetic credentials and results stay there.
"""
import argparse
import concurrent.futures
import ctypes
import ctypes.util
import hashlib
import http.client
import http.server
import json
import gzip
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import threading
import time


TOKEN = 'offline-payload-internal-token'


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decode_request(raw, encoding):
    if not encoding:
        return raw
    if encoding == 'gzip':
        return gzip.decompress(raw)
    require(encoding == 'zstd', 'unexpected request content encoding: ' + encoding)
    # Codex sends the official zstd request format. Use the system library so
    # this offline fixture needs no Python packages or network installation.
    library = ctypes.CDLL(ctypes.util.find_library('zstd') or 'libzstd.so.1')
    library.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
    library.ZSTD_decompress.restype = ctypes.c_size_t
    library.ZSTD_isError.argtypes = [ctypes.c_size_t]
    library.ZSTD_isError.restype = ctypes.c_uint
    output = ctypes.create_string_buffer(16 * 1024 * 1024)
    size = library.ZSTD_decompress(output, len(output), raw, len(raw))
    require(not library.ZSTD_isError(size), 'invalid zstd request or fixture limit exceeded')
    return output.raw[:size]


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=90)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(90)
        self.sock.connect(self.path)


def request(path, endpoint, body=None, token=TOKEN):
    connection = UnixConnection(path)
    try:
        connection.request('GET' if body is None else 'POST', endpoint,
                           body=None if body is None else json.dumps(body, separators=(',', ':')).encode(),
                           headers={'x-internal-token': token, 'content-type': 'application/json'})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


class Kernel:
    def __init__(self, argv, directory, env):
        self.argv, self.directory, self.env = argv, directory, env
        self.process = None
        self.log = (directory / 'kernel.log').open('a')

    def start(self):
        self.process = subprocess.Popen(self.argv, cwd=self.directory, env=self.env,
                                        stdout=self.log, stderr=self.log, start_new_session=True)

    def stop(self):
        if self.process is not None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=10)
            self.process = None

    def close(self):
        self.stop()
        self.log.close()


def wait_health(kernel, sock, predicate=lambda health: health.get('healthy') is not False, seconds=90):
    deadline = time.monotonic() + seconds
    last = {}
    while time.monotonic() < deadline:
        require(kernel.process.poll() is None, 'kernel exited before readiness')
        try:
            status, raw = request(sock, '/internal/health')
            last = json.loads(raw)
            if status == 200 and predicate(last):
                return last
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    raise AssertionError('health readiness timeout: ' + json.dumps(last))


class Fixture:
    def __init__(self):
        self.cancelled = threading.Event()
        self.requests = []
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get('content-length', '0')))
                encoding = self.headers.get('content-encoding')
                raw = decode_request(raw, encoding)
                body = json.loads(raw)
                fixture.requests.append({'path': self.path, 'bytes': len(raw),
                                         'content_encoding': encoding,
                                         'user_agent': self.headers.get('user-agent'),
                                         'model': body.get('model')})
                if self.path.startswith('/v1/messages'):
                    if b'cancel-test' in raw:
                        fixture.cancelled.set()
                        time.sleep(3)
                    message = {'id': 'msg_offline', 'type': 'message', 'role': 'assistant',
                               'model': body['model'], 'content': [], 'stop_reason': None,
                               'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}
                    events = [{'type': 'message_start', 'message': message},
                              {'type': 'content_block_start', 'index': 0,
                               'content_block': {'type': 'text', 'text': ''}},
                              {'type': 'content_block_delta', 'index': 0,
                               'delta': {'type': 'text_delta', 'text': 'offline-ok'}},
                              {'type': 'content_block_stop', 'index': 0},
                              {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
                               'usage': {'output_tokens': 1}}, {'type': 'message_stop'}]
                elif self.path.endswith('/responses'):
                    response = {'id': 'resp_offline', 'object': 'response', 'status': 'completed',
                                'model': body['model'], 'output': [{'id': 'msg_offline', 'type': 'message',
                                'role': 'assistant', 'status': 'completed', 'content': [
                                    {'type': 'output_text', 'text': 'offline-ok', 'annotations': []}]}],
                                'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
                    events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                              {'type': 'response.output_text.delta', 'item_id': 'msg_offline',
                               'output_index': 0, 'content_index': 0, 'delta': 'offline-ok'},
                              {'type': 'response.completed', 'response': response}]
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                data = ''.join('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n'
                               for event in events).encode()
                try:
                    self.send_response(200)
                    self.send_header('content-type', 'text/event-stream')
                    self.send_header('content-length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def clean_env(home, base):
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(('KIN_', 'VM2API_', 'ANTHROPIC_', 'OPENAI_', 'CLAUDE_'))
           and key.upper() not in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')}
    env.update({'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(home / '.claude'),
                'ANTHROPIC_API_KEY': 'offline-fixture-key', 'ANTHROPIC_BASE_URL': base,
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_TELEMETRY': '1',
                'DISABLE_ERROR_REPORTING': '1', 'NO_PROXY': '127.0.0.1,localhost'})
    return env


def claude(payload, template, work):
    work.mkdir()
    home = work / 'home'
    kin = home / '.kin'
    shutil.copytree(payload / 'share/wrap-cli', kin)
    shutil.copy2(template, kin / 'kin-kernel')
    (home / '.claude').mkdir()
    credential = home / '.claude/credentials.json'
    write_json(credential, {'anthropicApiKey': {'apiKey': 'offline-fixture-key'}})
    before = digest(credential)
    fixture = Fixture()
    sock = work / 'kernel.sock'
    cli = kin / 'cli-node'
    config = {'vm_id': 'offline-claude', 'socket_path': str(sock), 'credential_path': str(credential),
              'internal_token': TOKEN, 'provider': 'local_cli', 'dataplane': 'wrap',
              'claude_bin': str(cli), 'slots_per_worker': 20,
              'system_layout': 'zero', 'persona_preset': 'zero', 'cli_version': '2.1.303',
              'default_cache_ttl': '5m', 'cc_entrypoint': 'cli', 'test_endpoints': True,
              'anthropic_base_url': fixture.base, 'max_request_bytes': 134217728,
              'first_byte_timeout_seconds': 60, 'idle_timeout_seconds': 60}
    write_json(work / 'kernel.json', config)
    kernel = Kernel([str(kin / 'kin-kernel'), '--gateway-worker', '--config', str(work / 'kernel.json')],
                    work, clean_env(home, fixture.base))

    def ready(health):
        return health.get('healthy') and health.get('ready_slots') == 20

    def send(ident, size=1024, text=None):
        body = {'model': 'claude-sonnet-5-5', 'stream': True, 'max_tokens': 16,
                'messages': [{'role': 'user', 'content': text if text is not None else 'x' * size}]}
        started = time.monotonic()
        status, raw = request(sock, '/internal/v1/messages', {'request_id': ident, 'body': body,
                              'headers': {}, 'stream': True, 'delivery_mode': 'realtime'})
        result = {'id': ident, 'bytes': size, 'status': status,
                  'complete': b'event: message_stop' in raw and b'offline-ok' in raw,
                  'kernel_unavailable': b'kernel_unavailable' in raw,
                  'elapsed_seconds': round(time.monotonic() - started, 3)}
        if ident != 'cancel-probe':
            require(status == 200 and result['complete'] and not result['kernel_unavailable'],
                    str(result) + ': ' + raw[-1000:].decode(errors='replace'))
        return result

    try:
        version = subprocess.check_output([str(cli), '--version'],
                                          env=kernel.env, text=True, timeout=60).strip()
        kernel.start()
        initial = wait_health(kernel, sock, ready)
        status, _ = request(sock, '/internal/health', token='wrong-fixture-token')
        require(status in (401, 403), 'internal health accepts incorrect token')
        results = [send('single-' + str(size), size) for size in (1024, 15 * 1024 * 1024, 32 * 1024 * 1024)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results += list(pool.map(lambda i: send('parallel-' + str(i), 15 * 1024 * 1024), range(4)))
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(send, 'cancel-probe', 11, 'cancel-test')
            require(fixture.cancelled.wait(20), 'cancel did not reach fixture')
            status, raw = request(sock, '/internal/v1/cancel', {'request_id': 'cancel-probe'})
            require(status == 200 and json.loads(raw).get('cancelled'), 'cancel failed')
            pending.result(timeout=20)
        post_cancel = wait_health(kernel, sock, ready)
        require(post_cancel.get('cli_restarts') == initial.get('cli_restarts') == 0,
                'normal requests or cancellation restarted CLI')
        cli_pid = post_cancel.get('cli_pid')
        require(isinstance(cli_pid, int) and cli_pid > 1, 'missing owned CLI PID')
        os.kill(cli_pid, signal.SIGKILL)
        recovered = wait_health(kernel, sock, lambda h: ready(h) and h.get('cli_restarts', 0) >= 1)
        results.append(send('after-cli-recovery'))
        kernel.stop()
        kernel.start()
        restarted = wait_health(kernel, sock, ready)
        results.append(send('after-kernel-restart'))
        require(digest(credential) == before, 'credential modified during lifecycle tests')
        require(all(r['path'].startswith('/v1/messages') for r in fixture.requests), 'unexpected upstream path')
        return {'passed': True, 'cli_version': version, 'requests': results, 'cancelled': True,
                'initial_health': initial, 'recovered_health': recovered, 'restarted_health': restarted,
                'credentials_unchanged': True, 'upstream_requests': fixture.requests}
    finally:
        kernel.close()
        fixture.close()


def codex(payload, work):
    work.mkdir()
    fixture = Fixture()
    credential = work / 'credentials.json'
    write_json(credential, {'accounts': [{'id': 'offline-account', 'email': 'fixture@example.test',
               'access_token': 'offline-access-token', 'refresh_token': 'offline-refresh-token',
               'expires_at': int(time.time()) + 86400, 'chatgpt_account_id': 'offline-account',
               'rpm': 0, 'max_concurrency': 8}]})
    before = digest(credential)
    sock = work / 'kernel.sock'
    config = {'vm_id': 'offline-codex', 'device_id': '11111111-2222-4333-8444-555555555555',
              'socket_path': str(sock), 'credential_path': str(credential), 'internal_token': TOKEN,
              'chatgpt_base_url': fixture.base + '/backend-api/codex',
              'oauth_token_url': fixture.base + '/oauth/token', 'proxy_url': '', 'proxy_required': False,
              'test_endpoints': True, 'upstream_transport': 'http', 'client_features': False,
              'analytics': False, 'max_request_bytes': 134217728}
    write_json(work / 'kernel.json', config)
    lib = payload / 'share/wrap-cli/glibc239'
    kernel = Kernel([str(lib / 'ld-linux-x86-64.so.2'), '--library-path', str(lib),
                    str(payload / 'bin/kin-codex-kernel'), str(work / 'kernel.json')],
                    work, clean_env(work, fixture.base))

    def send(ident):
        status, raw = request(sock, '/internal/v1/codex/responses', {'request_id': ident,
            'body': {'model': 'gpt-5.4', 'input': [{'role': 'user', 'content': [{'type': 'input_text',
                     'text': 'offline payload test'}]}], 'stream': True, 'store': False},
            'headers': {}, 'stream': True, 'delivery_mode': 'realtime'})
        require(status == 200 and b'response.completed' in raw and b'offline-ok' in raw,
                'Codex response failed: ' + str(status) + ' ' + raw[-1000:].decode(errors='replace'))
        return {'id': ident, 'status': status, 'complete': True}

    try:
        kernel.start()
        health = wait_health(kernel, sock)
        status, _ = request(sock, '/internal/health', token='wrong-fixture-token')
        require(status in (401, 403), 'Codex internal health accepts incorrect token')
        results = [send('codex-first')]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results += list(pool.map(lambda i: send('codex-parallel-' + str(i)), range(4)))
        kernel.stop()
        kernel.start()
        restarted = wait_health(kernel, sock)
        results.append(send('codex-after-restart'))
        require(digest(credential) == before, 'Codex credential changed')
        require(len(fixture.requests) == len(results), 'Codex did not use the loopback upstream')
        return {'passed': True, 'requests': results, 'initial_health': health,
                'restarted_health': restarted, 'credentials_unchanged': True,
                'upstream_requests': fixture.requests}
    finally:
        kernel.close()
        fixture.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload-root', type=Path, required=True)
    parser.add_argument('--wrap-template', type=Path, required=True)
    parser.add_argument('--work-root', type=Path, required=True)
    parser.add_argument('--mode', choices=('both', 'claude', 'codex'), default='both')
    args = parser.parse_args()
    require(os.uname().sysname == 'Linux' and os.uname().machine in ('x86_64', 'amd64'),
            'This acceptance requires a native Linux x86-64 host')
    payload, work = args.payload_root.resolve(), args.work_root.resolve()
    require(not work.exists(), 'work directory already exists; choose a fresh owned directory')
    work.mkdir(parents=True, mode=0o700)
    manifest = json.loads((payload / 'manifest.json').read_text())
    for item in manifest['files']:
        file = payload / item['path']
        require(file.stat().st_size == item['size'] and digest(file) == item['sha256'],
                'payload manifest mismatch: ' + item['path'])
    result = {'release': manifest['release'], 'verified_payload_files': len(manifest['files']),
              'external_network': 'disabled by caller container', 'real_upstream_models': False,
              'execution': 'native-linux-x86_64'}
    try:
        if args.mode in ('both', 'claude'):
            result['claude'] = claude(payload, args.wrap_template.resolve(), work / 'claude')
            write_json(work / 'result.json', result)
        if args.mode in ('both', 'codex'):
            result['codex'] = codex(payload, work / 'codex')
        result['passed'] = True
    except Exception as error:
        result['passed'] = False
        result['error'] = str(error)
        raise
    finally:
        write_json(work / 'result.json', result)
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
