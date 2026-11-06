#!/usr/bin/env python3
"""Installed-client E2E harness. OAuth/catalog/MCP are explicit fixtures.

Optional --live-credentials forwards inference to real OpenAI/Anthropic APIs.
It never loads provider keys into child environments or writes them to evidence.
This is not a replacement for a deployed AgentZ control-plane E2E test.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agentz', required=True)
    parser.add_argument('--copilot', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--live-credentials')
    parser.add_argument('--keep', action='store_true')
    parser.add_argument('--provider', default='github-copilot-cli')
    parser.add_argument('--serve-only', action='store_true')
    parser.add_argument('--resume-runtime', help='Reuse paths and origin from a previous serve-only runtime.json')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    secrets = {}
    if args.live_credentials:
        lines = Path(args.live_credentials).read_text().splitlines()
        for index, line in enumerate(lines[:-1]):
            if 'OpenAI API Key' in line:
                secrets['openai'] = lines[index+1].strip()
            if 'Anthropic API Key' in line:
                secrets['anthropic'] = lines[index+1].strip()
    events = []
    state = {'denied': False, 'refreshes': 0, 'calls': 0, 'tools': 0}
    results = []
    inference_model = 'claude-sonnet-4-6' if args.provider == 'claude-desktop' else 'gpt-5-mini'

    model_alias = 'e2e/'+inference_model

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass

        def send_json(self, body, status=200):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            self.path = urllib.parse.urlsplit(self.path).path
            if self.path == '/api/mcp':
                self.send_response(405)
                self.send_header('Allow', 'POST')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            if self.path == '/fixture/status':
                return self.send_json({'events': events, **state})
            if self.path == '/api/inference/v1/catalog':
                return self.send_json({'models': [{
                    'id': model_alias, 'model': inference_model,
                    'model_display_name': 'Approved E2E model', 'provider': 'e2e',
                    'provider_display_name': 'E2E provider', 'workspace_id': 'e2e',
                    'model_info': {'capabilities': {'tool_call': True}},
                    'api_compatibility': [
                        {'api': api, 'support': ('native' if api == ('Messages' if inference_model.startswith('claude-') else 'Responses') else 'unsupported'), 'warning': ''}
                        for api in ['ChatCompletions', 'Responses', 'Messages']
                    ],
                }], 'mcp': []})
            return self.send_json({'error': 'not_found'}, 404)

        def do_POST(self):
            self.path = urllib.parse.urlsplit(self.path).path
            size = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(size)
            if self.path == '/api/auth/device/code':
                form = urllib.parse.parse_qs(raw.decode())
                resource = form['resource'][0]
                kind = 'mcp' if resource.endswith('/api/mcp') else 'inference'
                events.append({'event': 'device_authorization', 'resource': kind})
                return self.send_json({'device_code': kind, 'user_code': 'E2E-CODE',
                    'verification_uri': origin+'/fixture-consent', 'expires_in': 600, 'interval': 1})
            if self.path == '/api/auth/oauth2/token':
                form = urllib.parse.parse_qs(raw.decode())
                resource = form['resource'][0]
                kind = 'mcp' if resource.endswith('/api/mcp') else 'inference'
                if state['denied']:
                    return self.send_json({'error': 'invalid_grant'}, 400)
                if form.get('grant_type', [''])[0] == 'refresh_token':
                    state['refreshes'] += 1
                return self.send_json({'access_token': kind+'-fixture-access',
                    'token_type': 'Bearer', 'refresh_token': kind+'-fixture-refresh', 'expires_in': 300})
            if self.path == '/api/mcp':
                if self.headers.get('Authorization') != 'Bearer mcp-fixture-access':
                    return self.send_json({'error': 'wrong_audience'}, 401)
                message = json.loads(raw)
                method = message.get('method')
                events.append({'event': 'mcp', 'method': method})
                if 'id' not in message:
                    self.send_response(202); self.send_header('Content-Length','0'); self.end_headers(); return
                if method == 'initialize':
                    result = {'protocolVersion': message['params']['protocolVersion'],
                        'capabilities': {'tools': {}}, 'serverInfo': {'name': 'AgentZ E2E fixture', 'version': '1'}}
                elif method == 'tools/list':
                    result = {'tools': [{'name': 'verify_agentz', 'description': 'Returns the AgentZ integration verification marker.',
                        'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}}]}
                elif method == 'tools/call':
                    state['tools'] += 1
                    result = {'content': [{'type':'text','text':'agentz-tool-ok'}]}
                elif method in ['resources/list','prompts/list']:
                    result = {method.split('/')[0]: []}
                else:
                    return self.send_json({'jsonrpc':'2.0','id':message['id'],'error':{'code':-32601,'message':'Method not found'}})
                return self.send_json({'jsonrpc':'2.0','id':message['id'],'result':result})
            if self.path in ['/api/inference/v1/chat/completions','/api/inference/v1/responses','/api/inference/v1/messages','/api/inference/v1/messages/count_tokens']:
                state['calls'] += 1
                if self.headers.get('Authorization') != 'Bearer inference-fixture-access':
                    return self.send_json({'error': 'wrong_audience'}, 401)
                body = json.loads(raw)
                if body.get('model') != model_alias:
                    return self.send_json({'error': {'message':'Model not approved','type':'permission_error'}},403)
                events.append({'event': 'inference', 'api': self.path.rsplit('/v1/',1)[-1], 'stream': body.get('stream'), 'tool_count':len(body.get('tools',[])), 'store':body.get('store'), 'has_previous_response':bool(body.get('previous_response_id')), 'has_conversation':bool(body.get('conversation'))})
                if secrets:
                    body['model'] = inference_model
                    anthropic = '/messages' in self.path
                    headers={'Content-Type':'application/json'}
                    if anthropic:
                        headers.update({'x-api-key':secrets['anthropic'],'anthropic-version':'2023-06-01'})
                        if self.headers.get('anthropic-beta'): headers['anthropic-beta']=self.headers['anthropic-beta']
                    else: headers['Authorization']='Bearer '+secrets['openai']
                    target=('https://api.anthropic.com/v1/' if anthropic else 'https://api.openai.com/v1/')+self.path.rsplit('/v1/',1)[-1]
                    request = urllib.request.Request(target,data=json.dumps(body).encode(),headers=headers)
                    try:
                        response = urllib.request.urlopen(request, timeout=120)
                    except urllib.error.HTTPError as error:
                        detail=json.loads(error.read()).get('error',{}).get('message','')
                        for value in secrets.values(): detail=detail.replace(value,'[REDACTED]')
                        events.append({'event':'provider_error','status':error.code,'message':detail[:500]})
                        return self.send_json({'error':{'message':'Live provider rejected request','type':'provider_error'}},error.code)
                    self.send_response(response.status)
                    self.send_header('Content-Type',response.headers.get('Content-Type','text/event-stream'))
                    self.send_header('Connection','close'); self.end_headers(); self.close_connection=True
                    try:
                        while chunk := response.read1(4096):
                            self.wfile.write(chunk); self.wfile.flush()
                    except (BrokenPipeError,ConnectionResetError):
                        pass
                    finally:
                        response.close()
                    return
                self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Connection','close'); self.end_headers(); self.close_connection=True
                if self.path.endswith('/responses'):
                    item={'type':'message','id':'msg_e2e','role':'assistant','status':'completed','content':[{'type':'output_text','text':'agentz-e2e-ok','annotations':[]}]}
                    response={'id':'resp_e2e','object':'response','created_at':int(time.time()),'status':'completed','model':inference_model,'output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
                    for event in [
                        {'type':'response.created','response':{**response,'status':'in_progress','output':[]}},
                        {'type':'response.output_item.added','output_index':0,'item':{**item,'status':'in_progress','content':[]}},
                        {'type':'response.content_part.added','item_id':'msg_e2e','output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}},
                        {'type':'response.output_text.delta','item_id':'msg_e2e','output_index':0,'content_index':0,'delta':'agentz-e2e-ok'},
                        {'type':'response.output_text.done','item_id':'msg_e2e','output_index':0,'content_index':0,'text':'agentz-e2e-ok'},
                        {'type':'response.output_item.done','output_index':0,'item':item},
                        {'type':'response.completed','response':response},
                    ]:
                        self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
                    return
                for data in [
                    {'id':'e2e','object':'chat.completion.chunk','created':int(time.time()),'model':inference_model,'choices':[{'index':0,'delta':{'role':'assistant','content':'agentz-e2e-ok'},'finish_reason':None}]},
                    {'id':'e2e','object':'chat.completion.chunk','created':int(time.time()),'model':inference_model,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]},
                ]:
                    self.wfile.write(('data: '+json.dumps(data)+'\n\n').encode()); self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n'); return
            return self.send_json({'error':'not_found'},404)

    resume = json.loads(Path(args.resume_runtime).read_text()) if args.resume_runtime else None
    port = urllib.parse.urlsplit(resume['origin']).port if resume else 0
    server = http.server.ThreadingHTTPServer(('127.0.0.1',port),Handler)
    origin = f'http://127.0.0.1:{server.server_port}'
    thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    root=Path(resume['root']) if resume else Path(tempfile.mkdtemp(prefix='agentz-client-e2e-'))
    env=os.environ.copy(); env['COPILOT_AUTO_UPDATE']='false'; env['XDG_CONFIG_HOME']=str(root/'config')
    env['PATH']=str(Path(args.copilot).absolute().parent)+os.pathsep+env['PATH']
    config=root/'config.yaml'
    config.write_text(f'serverURL: {origin}\nexternalAgents:\n  - e2e:\n      provider: {args.provider}\n      clientID: e2e-client\n')
    base=[str(Path(args.agentz).resolve()),'--config',str(config),'--profile','e2e']

    def run(name,command,marker=None,expected=0,timeout=180):
        started=time.monotonic()
        result=subprocess.run(command,env=env,capture_output=True,text=True,timeout=timeout)
        # Never capture child environment or request headers.
        text=result.stdout+result.stderr
        for value in secrets.values(): text=text.replace(value,'[REDACTED]')
        passed=(result.returncode==expected and (not marker or marker in text))
        results.append({'name':name,'passed':passed,'exit_code':result.returncode,'duration_seconds':round(time.monotonic()-started,2)})
        (output/(name+'.txt')).write_text(text)
        print(('PASS' if passed else 'FAIL')+' '+name,flush=True)
        if not passed: print(text[-1500:],flush=True)
        return result,text

    try:
        run('inference-login',base+['login',args.provider],'inference connected')
        run('mcp-login',base+['login',args.provider,'--','--mcp'],'mcp connected')
        if args.serve_only:
            run('desktop-export',base+['launch',args.provider],'Desktop connection saved')
            profile=next((root/'config'/'agentz'/'profiles').iterdir())
            (output/'runtime.json').write_text(json.dumps({'root':str(root),'config':str(config),'profile':str(profile),'origin':origin,'provider':args.provider}))
            print('Desktop fixture ready. Runtime paths: '+str(output/'runtime.json'),flush=True)
            import signal
            event=threading.Event()
            signal.signal(signal.SIGTERM,lambda *_:event.set())
            signal.signal(signal.SIGINT,lambda *_:event.set())
            event.wait()
            return
        run('installed-copilot-stream',base+['launch','github-copilot-cli','--','--trust-folder','--disable-client-telemetry','-p','Reply with exactly agentz-e2e-ok. Do not use tools.','-s'], 'agentz-e2e-ok')
        profile=next((root/'config'/'agentz'/'profiles').iterdir())
        token_path=profile/'inference-oauth.json'
        token=json.loads(token_path.read_text());token['expiry']='2020-01-01T00:00:00Z';token_path.write_text(json.dumps(token))
        run('refresh-and-relaunch',base+['launch','github-copilot-cli','--','--trust-folder','--disable-client-telemetry','-p','Reply with exactly agentz-e2e-ok. Do not use tools.','-s'],'agentz-e2e-ok')
        if secrets:
            run('live-mcp-tool-call',base+['launch','github-copilot-cli','--','--trust-folder','--disable-client-telemetry','--allow-tool','agentz','-p','Call the verify_agentz MCP tool and reply with its exact returned text.','-s'],'agentz-tool-ok')
        state['denied']=True
        token=json.loads(token_path.read_text());token['expiry']='2020-01-01T00:00:00Z';token_path.write_text(json.dumps(token))
        run('revoked-refresh-rejected',base+['launch','github-copilot-cli','--','-p','must not run'],'rejected token refresh',expected=1)
        run('relay-status',base+['relay','status'],'relay running')
    finally:
        subprocess.run(base+['relay','stop'],env=env,capture_output=True,timeout=10)
        server.shutdown(); server.server_close()
        report={'boundary':'installed AgentZ client and Copilot CLI; OAuth/catalog/MCP fixture; '+('live provider inference' if secrets else 'deterministic inference fixture'),
            'results':results,'events':events,'refreshes':state['refreshes'],'inference_calls':state['calls'],'tool_calls':state['tools']}
        (output/'results.json').write_text(json.dumps(report,indent=2))
        if not args.keep:
            import shutil
            shutil.rmtree(root)
    if not all(item['passed'] for item in results): raise SystemExit(1)

if __name__=='__main__': main()
