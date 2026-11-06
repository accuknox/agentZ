#!/usr/bin/env python3
"""Exercise a running production gateway with a real, approved inference grant.

Use a disposable test client. The script reads an existing AgentZ OAuth token
file, discovers its approved model, and records statuses without credentials.
No OAuth, catalog, authorization, or inference server is mocked here.
"""
import argparse
import json
from pathlib import Path
import urllib.error
import urllib.request

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--origin', required=True)
p.add_argument('--token-file', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
token = json.loads(Path(a.token_file).read_text())['access_token']
origin = a.origin.rstrip('/')
results = []


def call(path, body=None, authorization=True):
    headers = {'Content-Type': 'application/json'}
    if authorization:
        headers['Authorization'] = 'Bearer '+token
    req = urllib.request.Request(origin+path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def check(name, path, body, expected, authorization=True):
    status, raw = call(path, body, authorization)
    passed = status in expected
    results.append({'name': name, 'status': status, 'expected': expected, 'passed': passed})
    print(('PASS ' if passed else 'FAIL ')+name+' HTTP '+str(status), flush=True)
    return raw

catalog_raw = check('approved-catalog', '/api/inference/v1/catalog', None, [200])
models = json.loads(catalog_raw).get('models', [])
if not models:
    raise SystemExit('Approve at least one native Responses model for this test client')
model = models[0]['id']
endpoint = '/api/inference/v1/responses'
valid = {'model': model, 'store': False, 'input': 'Reply with exactly agentz-contract-ok.', 'stream': True}
raw = check('live-stream', endpoint, valid, [200])
results[-1]['passed'] &= b'agentz-contract-ok' in raw
for name, change in [
    ('unknown-model', {'model': 'not-approved'}),
    ('stored-response', {'store': True}),
    ('background', {'background': True}),
    ('stored-conversation', {'conversation': 'conv-not-delegated'}),
    ('previous-response', {'previous_response_id': 'resp-not-delegated'}),
    ('provider-hosted-tool', {'tools': [{'type': 'file_search', 'vector_store_ids': ['vs-not-delegated']}]}),
    ('stored-file', {'input': [{'role': 'user', 'content': [{'type': 'input_file', 'file_id': 'file-not-delegated'}]}]}),
]:
    check(name, endpoint, {**valid, **change}, [404] if name == 'unknown-model' else [400])
check('missing-authorization', endpoint, valid, [401], False)
check('inference-token-cannot-use-mcp', '/api/mcp', {'jsonrpc':'2.0','id':1,'method':'tools/list'}, [401,403])
Path(a.output).write_text(json.dumps({'boundary': 'real AgentZ web/gateway, OAuth grant, Kubernetes data plane, live provider', 'results': results}, indent=2))
if not all(r['passed'] for r in results):
    raise SystemExit(1)
