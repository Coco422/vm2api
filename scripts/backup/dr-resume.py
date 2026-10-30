#!/usr/bin/env python3
"""Explicit operator step after files/images are restored: reconnect a node and recover its prior running slots."""
from pathlib import Path
import argparse, json, time, urllib.request, urllib.error, urllib.parse

def read_env(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line: continue
        key, value = line.split('=', 1); values[key.strip()] = value.strip().strip('"').strip("'")
    return values

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control-url', required=True)
    parser.add_argument('--control-env', required=True)
    parser.add_argument('--node-id', help='Omit for control-host local VMs')
    parser.add_argument('--confirm-resume', action='store_true')
    args = parser.parse_args(); url = urllib.parse.urlsplit(args.control_url)
    if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ['127.0.0.1', 'localhost']):
        raise ValueError('Remote control API must use HTTPS')
    env = read_env(args.control_env); key = env.get('VM2API_API_KEY') or env.get('KIN_API_KEY')
    if not key: raise ValueError('Control master key is missing from the restored environment')
    def call(route, body=None, method=None):
        req = urllib.request.Request(args.control_url.rstrip('/') + route, data=json.dumps(body).encode() if body is not None else None, headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=180) as result: data = json.load(result)
        except urllib.error.HTTPError as error: raise RuntimeError('Control operation failed: ' + str(error.code)) from None
        if not data.get('ok'): raise RuntimeError('Control operation was rejected')
        return data.get('data', data)
    items = call('/api/panel/vms')['items']
    selected = [v['id'] for v in items if v.get('node_id') == args.node_id and v.get('status') == 'running']
    if not args.confirm_resume:
        print(json.dumps({'dry_run': True, 'node_id': args.node_id, 'prior_running_vms_to_recover': selected, 'changes': False})); return
    if args.node_id:
        for _ in range(30):
            node = call('/api/panel/cluster/nodes/' + args.node_id)
            if node.get('link', {}).get('state') == 'ready': break
            time.sleep(2)
        else: raise RuntimeError('Worker SSH is not ready; prior control credentials/public keys must be restored')
    result = []
    for vm in selected:
        value = call('/api/panel/vms/' + vm + '/recover', {})
        diagnosis = call('/api/panel/vms/' + vm + '/diagnose')
        result.append({'vm_id': vm, 'diagnosis_ok': diagnosis.get('ok'), 'first_failure': diagnosis.get('first_failure')})
    print(json.dumps({'recovered': result, 'stopped_or_unconfigured_vms': 'not started'}))

if __name__ == '__main__': main()
