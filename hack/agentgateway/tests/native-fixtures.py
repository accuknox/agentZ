#!/usr/bin/env python3
"""Exercise AgentZ's pinned AgentGateway against model and webhook fixtures."""
import http.server, threading, json, subprocess, time, os, urllib.request, urllib.error, urllib.parse, pathlib, sys, tempfile, shutil
ROOT=pathlib.Path(os.environ.get('GUARDRAIL_FIXTURE_DIR') or tempfile.mkdtemp(prefix='agentgateway-guardrail-fixtures-'))
ROOT.mkdir(parents=True,exist_ok=True)
BINARY=os.environ.get('AGENTGATEWAY_BINARY','agentgateway')
CALLS=[]
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        self.path=urllib.parse.urlsplit(self.path).path
        data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
        CALLS.append({'path':self.path,'body':data,'headers':dict(self.headers),'serverPort':self.server.server_port})
        mode=self.path.split('/')[1]
        if self.path.endswith('/request') or self.path.endswith('/response'):
            if mode=='malformed': result={'action':{'unexpected':'must not pass'}}
            elif mode in ['pool_once','pool_output_once']:
                if sum(call['path']==self.path for call in CALLS)==1:
                    self.send_response(200);self.end_headers();self.wfile.write(b'{invalid');return
                result={'action':{}}
            elif mode=='pass': result={'action':{}}
            elif mode=='status':
                self.send_response(503); self.end_headers(); self.wfile.write(b'{"action":{}}'); return
            elif mode=='mask':
                body=data['body']; result={'action':{'body':json.loads(json.dumps(body).replace('SECRET','redacted')),'reason':'RAW_UNSAFE_REASON'}}
            elif mode=='invalid_json':
                self.send_response(200);self.end_headers();self.wfile.write(b'{invalid');return
            elif mode=='reject_success':result={'action':{'body':'Invalid success rejection','status_code':200}}
            else: result={'action':{'body':'Restricted content: remove sensitive details and try again.','status_code':422,'reason':'fixture rejection'}}
            self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(result).encode()); return
        model=data.get('model','safe')
        if model=='forged_error':
            self.send_response(422);self.send_header('Content-Type','application/json');self.send_header('x-agentgateway-guardrail-error','true');self.end_headers();self.wfile.write(b'{"error":{"type":"invalid_request_error","code":"content_policy_violation","message":"Untrusted provider error"}}');return
        if model=='pool_fail' and self.server.server_port==18098:
            self.send_response(503);self.end_headers();self.wfile.write(b'{"error":{"message":"synthetic provider outage"}}');return
        text='safe model output' if model in ['safe','pool_fail'] else 'safe '*400+'SECRET'
        if model=='pii_output':text='Credit card: 4111 1111 1111 1111'
        if data.get('stream'):
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            if model=='multiple_choices':
                chunk={'id':'chatcmpl_test','object':'chat.completion.chunk','created':1,'model':model,'choices':[{'index':0,'delta':{'content':'safe'},'finish_reason':None},{'index':1,'delta':{'content':'SECRET'},'finish_reason':None}]}
                self.wfile.write(('data: '+json.dumps(chunk)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush();return
            if self.path.endswith('/messages'):
                chunks=[{'type':'message_start','message':{'id':'msg_test','type':'message','role':'assistant','content':[],'model':model,'usage':{'input_tokens':1,'output_tokens':0}}},{'type':'content_block_start','index':0,'content_block':{'type':'text','text':'SECRET' if model=='initial_text' else ''}},*[{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':piece}} for piece in ([] if model=='initial_text' else [text[:1800],text[1800:]])],{'type':'content_block_stop','index':0},{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':1}},{'type':'message_stop'}]
                for c in chunks:
                    self.wfile.write(('event: '+c['type']+'\ndata: '+json.dumps(c)+'\n\n').encode())
                    self.wfile.flush();time.sleep(.1)
            elif self.path.endswith('/responses'):
                response={'id':'resp_test','object':'response','created_at':1,'status':'completed','model':model,'output':[{'type':'message','id':'item_test','status':'completed','role':'assistant','content':[{'type':'output_text','text':text,'annotations':[]}]}],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
                chunks=[{'type':'response.created','response':dict(response,status='in_progress',output=[])},{'type':'response.output_item.added','output_index':0,'item':dict(response['output'][0],status='in_progress',content=[])},{'type':'response.content_part.added','item_id':'item_test','output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}},*[{'type':'response.output_text.delta','item_id':'item_test','output_index':0,'content_index':0,'delta':piece} for piece in [text[:1800],text[1800:]]],{'type':'response.output_text.done','item_id':'item_test','output_index':0,'content_index':0,'text':text},{'type':'response.output_item.done','output_index':0,'item':response['output'][0]},{'type':'response.completed','response':response}]
                for sequence,c in enumerate(chunks):
                    c['sequence_number']=sequence
                    self.wfile.write(('event: '+c['type']+'\ndata: '+json.dumps(c)+'\n\n').encode())
                    self.wfile.flush();time.sleep(.1)
            else:
                for piece in [text[:1800],text[1800:]]:
                    self.wfile.write(('data: '+json.dumps({'id':'chatcmpl_test','object':'chat.completion.chunk','created':1,'model':model,'choices':[{'index':0,'delta':{'content':piece},'finish_reason':None}]})+'\n\n').encode())
                    self.wfile.flush();time.sleep(.1)
                self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush();return
        body={'id':'chatcmpl_test','object':'chat.completion','created':1,'model':model,'choices':[{'index':0,'message':{'role':'assistant','content':text},'finish_reason':'stop'}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}
        if self.path.endswith('/messages'):
            body={'id':'msg_test','type':'message','role':'assistant','content':[{'type':'text','text':text}],'model':model,'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':1}}
        if self.path.endswith('/responses'):
            body={'id':'resp_test','object':'response','created_at':1,'status':'completed','model':model,'output':[{'type':'message','id':'item_test','status':'completed','role':'assistant','content':[{'type':'output_text','text':text,'annotations':[]}]}],'error':None,'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(body).encode())

def regex(action='reject',pattern='SECRET',scope=None):
    v={'regex':{'action':action,'rules':[{'pattern':pattern}]},'rejection':{'status':422,'body':'Restricted content: remove sensitive details and try again.'}}
    if scope:v['scope']=scope
    return v
def webhook(mode='deny',failure='failClosed',action='reject'):
    return {'webhook':{'target':{'host':'127.0.0.1:18098'},'headers':{':path':json.dumps('/'+mode+'/request'),'authorization':json.dumps('Bearer guardrail-auth')},'failureMode':failure,'action':action}}
CASES=[]
def case(name,req=None,resp=None,pool=False):
    req=req or [];resp=resp or [];port=18180+len(CASES)
    guard={'streaming':'Enabled','request':req,'response':resp}
    route={'backends':[{'ai':{'name':'fixture','hostOverride':'127.0.0.1:18098','provider':{'custom':{'formats':[{'type':'completions'},{'type':'messages'},{'type':'responses'}]}}}}],'policies':{'ai':{'promptGuard':guard,'routes':{'/messages':'messages','/responses':'responses','/chat/completions':'completions'}}}}
    if pool:
        provider=route['backends'][0]['ai']
        route['backends'][0]['ai']={'groups':[{'providers':[dict(provider,name='primary',hostOverride='127.0.0.1:18098')]},{'providers':[dict(provider,name='alternate',hostOverride='127.0.0.1:18097')]}]}
        route['policies']['retry']={'attempts':2,'backoff':'50ms','codes':[],'condition':'response.code == 401 || response.code == 403 || response.code == 429 || response.code >= 500'}
    CASES.append({'name':name,'port':port,'bind':{'port':port,'listeners':[{'routes':[route]}]}})
    return port
PORTS={}
PORTS['deny']=case('deny',[regex()])
PORTS['mask']=case('mask',[regex('mask')])
PORTS['audit']=case('audit',[regex('audit')])
PORTS['webhook']=case('webhook',[webhook()])
PORTS['webhook_mask']=case('webhook_mask',[webhook('mask')])
PORTS['malformed']=case('malformed',[webhook('malformed')])
PORTS['invalid_json']=case('invalid_json',[webhook('invalid_json')])
PORTS['fail_open']=case('fail_open',[webhook('invalid_json','failOpen')])
PORTS['http_status']=case('http_status',[webhook('status')])
PORTS['reject_success']=case('reject_success',[webhook('reject_success')])
PORTS['output']=case('output',resp=[regex()])
PORTS['output_mask']=case('output_mask',resp=[regex('mask')])
PORTS['webhook_pass']=case('webhook_pass',[webhook('pass')])
PORTS['audit_invalid_closed']=case('audit_invalid_closed',[webhook('invalid_json',action='audit')])
PORTS['audit_invalid_open']=case('audit_invalid_open',[webhook('invalid_json','failOpen',action='audit')])
PORTS['audit_mask']=case('audit_mask',[webhook('mask',action='audit')])
PORTS['pool_input']=case('pool_input',[regex()],pool=True)
PORTS['pool_closed']=case('pool_closed',[webhook('pool_once')],pool=True)
PORTS['pool_output']=case('pool_output',resp=[regex()],pool=True)
PORTS['pool_output_closed']=case('pool_output_closed',resp=[webhook('pool_output_once')],pool=True)
PORTS['pool_failover']=case('pool_failover',[regex()],pool=True)
# AgentZ's configured JSON body is the same contract emitted by its compiler.
for phase in ['request','response']:
    check=regex()
    context={'phase':phase,'guard':'regex','policyId':'fixture-policy','policyName':'Sensitive data','checkId':'fixture-check','checkName':'Secret check','message':'Remove sensitive details and retry.','scopes':['conversation']}
    check['rejection']['body']=json.dumps({'error':{'type':'invalid_request_error','code':'content_policy_violation','message':'Configured rejection','guardrail':context}})
    PORTS['structured_'+phase]=case('structured_'+phase,req=[check] if phase=='request' else [],resp=[check] if phase=='response' else [])
for native_scope,scope in [('systemPrompt','instructions'),('messages','conversation'),('toolInput','toolArguments'),('toolOutput','toolResults')]:
    check=regex(scope=[native_scope])
    context={'phase':'request','guard':'regex','policyId':'fixture-policy','policyName':'Sensitive data','checkId':'scope-'+scope,'checkName':'Scope check','message':'Remove sensitive details and retry.','scopes':[scope]}
    check['rejection']['body']=json.dumps({'error':{'type':'invalid_request_error','code':'content_policy_violation','message':'Configured rejection','guardrail':context}})
    PORTS['scope_'+scope]=case('scope_'+scope,req=[check])
for phase in ['request','response']:
    check=webhook('invalid_json')
    context={'phase':phase,'guard':'webhook','policyId':'fixture-policy','policyName':'Sensitive data','checkId':'remote-check','checkName':'Remote check','message':'Remove sensitive details and retry.','scopes':['instructions','conversation'] if phase=='request' else ['conversation']}
    check['rejection']={'status':422,'body':json.dumps({'error':{'type':'invalid_request_error','code':'content_policy_violation','message':'Configured rejection','guardrail':context}})}
    PORTS['structured_failure_'+phase]=case('structured_failure_'+phase,req=[check] if phase=='request' else [],resp=[check] if phase=='response' else [])
if os.environ.get('MODEL_ARMOR_TEST_TEMPLATE'):
    _,project,_,location,_,template=os.environ['MODEL_ARMOR_TEST_TEMPLATE'].split('/')
    for phase in ['request','response']:
        context={'phase':phase,'guard':'googleModelArmor','policyId':'cloud-verification','policyName':'Cloud verification','checkId':'model-armor','checkName':'Personal data','message':'Remove sensitive personal data.','scopes':['instructions','conversation'] if phase=='request' else ['conversation']}
        guard={'googleModelArmor':{'projectId':project,'location':location,'templateId':template},'rejection':{'status':422,'body':json.dumps({'error':{'type':'invalid_request_error','code':'content_policy_violation','message':'Restricted personal data','guardrail':context}})}}
        PORTS['model_armor_'+phase]=case('model_armor_'+phase,req=[guard] if phase=='request' else [],resp=[guard] if phase=='response' else [])
if os.environ.get('BEDROCK_TEST_GUARDRAIL'):
    guard={'bedrockGuardrails':{'guardrailIdentifier':os.environ['BEDROCK_TEST_GUARDRAIL'],'guardrailVersion':os.environ.get('BEDROCK_TEST_VERSION','DRAFT'),'region':os.environ.get('AWS_REGION','us-east-1')},'rejection':{'status':422,'body':'Personal data is restricted.'}}
    PORTS['bedrock_request']=case('bedrock_request',req=[guard])
CONFIG={'config':{'adminAddr':'127.0.0.1:18290','readinessAddr':'127.0.0.1:18291','statsAddr':'127.0.0.1:18292'},'frontendPolicies':{'accessLog':{'add':{'test.guardrails':'guardrails'}}},'binds':[c['bind'] for c in CASES]}
(ROOT/'config.json').write_text(json.dumps(CONFIG,indent=2))
if '--prepare' in sys.argv:
    print(json.dumps(PORTS));sys.exit()
server=http.server.ThreadingHTTPServer(('127.0.0.1',18098),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
alternate_server=http.server.ThreadingHTTPServer(('127.0.0.1',18097),Handler);threading.Thread(target=alternate_server.serve_forever,daemon=True).start()
log=open(ROOT/'gateway.log','w')
env=dict(os.environ,LOG_FORMAT='json',RUST_LOG='info')
process=subprocess.Popen([BINARY,'-f',str(ROOT/'config.json')],stdout=log,stderr=subprocess.STDOUT,env=env)
RESULT=[]
try:
    for _ in range(100):
        if process.poll() is not None:raise RuntimeError('gateway exited '+str(process.returncode)+'; '+(ROOT/'gateway.log').read_text()[-6000:])
        try:urllib.request.urlopen('http://127.0.0.1:18291/healthz/ready',timeout=.2);break
        except Exception:time.sleep(.1)
    def request(name,body=None,path='/v1/chat/completions'):
        body=body or {'model':'safe','messages':[{'role':'user','content':'SECRET'}]}
        req=urllib.request.Request('http://127.0.0.1:'+str(PORTS[name])+path,json.dumps(body).encode(),{'Content-Type':'application/json','Authorization':'Bearer client-secret','Cookie':'session=client-cookie','x-api-key':'client-api-key'})
        try:
            with urllib.request.urlopen(req,timeout=20) as resp:return resp.status,dict(resp.headers),resp.read().decode()
        except urllib.error.HTTPError as e:return e.code,dict(e.headers),e.read().decode()
    for name,status in [('deny',422),('mask',200),('audit',200),('webhook',422),('webhook_mask',200),('malformed',200),('invalid_json',503),('fail_open',200),('http_status',200),('reject_success',200),('webhook_pass',200),('audit_invalid_closed',503),('audit_invalid_open',200),('audit_mask',200)]:
        start=len(CALLS)
        result=request(name)
        assert result[0]==status,(name,result)
        models=[call for call in CALLS[start:] if not call['path'].endswith('/request') and not call['path'].endswith('/response')]
        assert len(models)==(0 if status>=400 or name=='reject_success' else 1),(name,models,result)
        if name=='mask':assert models[0]['body']['messages'][0]['content']=='<masked>',models
        if name=='webhook_mask':assert models[0]['body']['messages'][0]['content']=='redacted',models
        if name=='audit_mask':assert models[0]['body']['messages'][0]['content']=='SECRET',models
        if status==422:assert 'remove sensitive details' in result[2],result
        RESULT.append({'case':name,'status':result[0],'body':result[2],'modelCalls':len(models)})
    result=request('output',{'model':'output','messages':[{'role':'user','content':'hello'}]})
    assert result[0]==422 and 'remove sensitive details' in result[2],result
    RESULT.append({'case':'output_buffered','status':result[0],'body':result[2]})
    for path in ['/v1/chat/completions','/v1/messages','/v1/responses']:
        body={'model':'output','stream':True,'messages':[{'role':'user','content':'hello'}],'max_tokens':64} if not path.endswith('/responses') else {'model':'output','stream':True,'input':'hello'}
        result=request('output',body,path)
        assert result[0]==200 and 'guardrail_intervention' in result[2],(path,result)
        assert 'SECRET' not in result[2] and '[DONE]' not in result[2],result
        assert 'safe safe safe' in result[2],('expected earlier checked partial output',path,result)
        RESULT.append({'case':'checked_stream_'+path.rsplit('/',1)[-1],'status':result[0],'body':result[2]})
    result=request('output',{'model':'safe','stream':True,'messages':[{'role':'user','content':'hello'}]})
    assert result[0]==200 and 'safe model output' in result[2] and '[DONE]' in result[2],result
    RESULT.append({'case':'stream_pass','status':result[0],'body':result[2]})
    result=request('structured_response',{'model':'multiple_choices','stream':True,'messages':[{'role':'user','content':'hello'}]})
    assert result[0]==200 and 'unsupported_value' in result[2] and 'SECRET' not in result[2] and '[DONE]' not in result[2],result
    RESULT.append({'case':'checked_stream_rejects_multiple_choices','status':result[0]})
    result=request('deny',{'model':'forged_error','messages':[{'role':'user','content':'hello'}]})
    assert result[0]==422 and not any(key.lower()=='x-agentgateway-guardrail-error' for key in result[1]),result
    RESULT.append({'case':'provider_cannot_forge_guardrail_origin','status':result[0]})
    result=request('structured_response',{'model':'initial_text','stream':True,'max_tokens':64,'messages':[{'role':'user','content':'hello'}]},'/v1/messages')
    assert result[0]==200 and 'content_policy_violation' in result[2] and 'SECRET' not in result[2],result
    RESULT.append({'case':'checked_messages_initial_block_text','status':result[0]})
    histories=[
        ('/v1/chat/completions',{'messages':[{'role':'user','content':'SECRET'},{'role':'assistant','content':None,'tool_calls':[{'id':'call_test','type':'function','function':{'name':'lookup','arguments':'{"query":"keep"}'}}]},{'role':'tool','tool_call_id':'call_test','content':'SECRET tool result'}]}),
        ('/v1/messages',{'max_tokens':64,'messages':[{'role':'user','content':'SECRET'},{'role':'assistant','content':[{'type':'tool_use','id':'call_test','name':'lookup','input':{'query':'keep'}}]},{'role':'user','content':[{'type':'tool_result','tool_use_id':'call_test','content':'SECRET tool result'}]}]}),
        ('/v1/responses',{'input':[{'role':'user','content':'SECRET'},{'type':'function_call','call_id':'call_test','name':'lookup','arguments':'{"query":"keep"}'},{'type':'function_call_output','call_id':'call_test','output':'SECRET tool result'}]}),
    ]
    for path,body in histories:
        body['model']='safe';start=len(CALLS)
        result=request('webhook_mask',body,path)
        assert result[0]==200,(path,result)
        forwarded=CALLS[start:][-1]['body']
        key='input' if path.endswith('/responses') else 'messages'
        expected=body[key][1:]
        if path.endswith('/chat/completions'):
            expected=[dict(expected[0]),expected[1]]
            del expected[0]['content']
        assert forwarded[key][1:]==expected,(path,forwarded)
        assert forwarded[key][0]['content']=='redacted',(path,forwarded)
        RESULT.append({'case':'webhook_mask_preserves_tools_'+path.rsplit('/',1)[-1],'status':result[0]})
    body={'model':'safe','messages':[{'role':'user','content':'hello'},{'role':'function','name':'lookup','content':'SECRET function result'}]}
    start=len(CALLS);result=request('webhook_pass',body)
    assert result[0]==200 and all(message['role']!='function' for message in CALLS[start]['body']['body']['messages']),(result,CALLS[start:])
    RESULT.append({'case':'webhook_excludes_legacy_function_results','status':result[0]})
    # Record an upstream limitation, not supported AgentZ behavior: native streamed Mask passes unmodified.
    result=request('output_mask',{'model':'output','stream':True,'messages':[{'role':'user','content':'hello'}]})
    assert result[0]==200 and 'SECRET' in result[2],result
    RESULT.append({'case':'unsupported_stream_mask_passes','status':result[0],'body':result[2]})
    for name,model,text,status,label in [('pool_input','safe','SECRET',422,'deny'),('pool_output','output','hello',422,'deny'),('pool_input','safe','hello',200,'after_deny'),('pool_output','safe','hello',200,'after_deny'),('pool_closed','safe','hello',503,'unavailable'),('pool_closed','safe','hello',200,'after_unavailable'),('pool_output_closed','safe','hello',503,'unavailable'),('pool_output_closed','safe','hello',200,'after_unavailable'),('pool_failover','pool_fail','hello',200,'model_failure')]:
        start=len(CALLS)
        result=request(name,{'model':model,'messages':[{'role':'user','content':text}]})
        assert result[0]==status,(name,result)
        calls=CALLS[start:]
        models=[call for call in calls if not call['path'].endswith('/request') and not call['path'].endswith('/response')]
        checks=[call for call in calls if call not in models]
        ports=[call['serverPort'] for call in models]
        if label=='deny':assert ports==([] if name=='pool_input' else [18098]),(name,calls,result)
        if label=='after_deny':assert ports==[18098],(name,calls,result)
        if label=='unavailable':assert len(checks)==1 and ports==([] if name=='pool_closed' else [18098]),(name,calls,result)
        if label=='model_failure':assert 2<=len(ports)<=3 and ports[-1]==18097 and all(port==18098 for port in ports[:-1]),(name,calls,result)
        RESULT.append({'case':name+'_'+label,'status':result[0],'modelPorts':ports,'checkerCalls':len(checks),'body':result[2]})
    for path in ['/v1/chat/completions','/v1/responses','/v1/messages']:
        if path.endswith('/responses'):
            request_body={'model':'safe','input':'SECRET'}
        else:
            request_body={'model':'safe','messages':[{'role':'user','content':'SECRET'}]}
            if path.endswith('/messages'):request_body['max_tokens']=4096
        result=request('structured_request',request_body,path)
        assert result[0]==422,(path,result)
        error=json.loads(result[2])['error']
        assert error['code']=='content_policy_violation' and error['guardrail']['matchedScope']=='conversation',(path,error)
        assert error['guardrail']['checkId']=='fixture-check' and error['guardrail']['phase']=='request',error
        if path.endswith('/messages'):assert json.loads(result[2])['type']=='error',result
        RESULT.append({'case':'structured_input_'+path.rsplit('/',1)[-1],'status':result[0],'context':error['guardrail']})
        request_body['model']='output'
        if path.endswith('/responses'):request_body['input']='hello'
        else:request_body['messages'][0]['content']='hello'
        result=request('structured_response',request_body,path)
        assert result[0]==422,(path,result)
        error=json.loads(result[2])['error']
        assert error['guardrail']['phase']=='response' and error['guardrail']['matchedScope']=='conversation',error
        RESULT.append({'case':'structured_buffered_output_'+path.rsplit('/',1)[-1],'status':result[0]})
        request_body['stream']=True
        result=request('structured_response',request_body,path)
        assert result[0]==200 and 'SECRET' not in result[2] and 'content_policy_violation' in result[2],(path,result)
        frames=[json.loads(line[6:]) for line in result[2].splitlines() if line.startswith('data: ') and line!='data: [DONE]']
        final=frames[-1]
        if path.endswith('/messages'):
            assert 'event: error' in result[2] and final['type']=='error' and final['error']['guardrail']['phase']=='response',final
        elif path.endswith('/responses'):
            error_event=next(frame for frame in frames if frame.get('type')=='error')
            assert 'event: error' in result[2] and error_event['guardrail']['phase']=='response' and 'sequence_number' in error_event,error_event
            assert final['type']=='response.failed' and final['response']['id']=='resp_test' and final['response']['status']=='failed',final
            assert final['response']['error']['guardrail']['phase']=='response' and final['sequence_number']>error_event['sequence_number'],final
        else:assert final['error']['guardrail']['phase']=='response',final
        RESULT.append({'case':'structured_stream_'+path.rsplit('/',1)[-1],'status':result[0],'final':final})
    for path in ['/v1/chat/completions','/v1/messages','/v1/responses']:
        body={'model':'safe','messages':[{'role':'user','content':'hello'}],'max_tokens':64} if not path.endswith('/responses') else {'model':'safe','input':'hello'}
        for phase in ['request','response']:
            result=request('structured_failure_'+phase,body,path)
            assert result[0]==503,(phase,path,result)
            error=json.loads(result[2])['error']
            assert error['code']=='guardrail_unavailable' and error['guardrail']['reason']=='checker_error' and error['guardrail']['phase']==phase,error
            RESULT.append({'case':'structured_checker_failure_'+phase+'_'+path.rsplit('/',1)[-1],'status':result[0]})
        body['stream']=True
        result=request('structured_failure_response',body,path)
        assert result[0]==200 and 'guardrail_unavailable' in result[2] and 'checker_error' in result[2],(path,result)
        RESULT.append({'case':'structured_stream_checker_failure_'+path.rsplit('/',1)[-1],'status':result[0]})
    scoped_messages={
        'instructions':[{'role':'system','content':'SECRET'},{'role':'user','content':'hello'}],
        'conversation':[{'role':'user','content':'SECRET'}],
        'toolArguments':[{'role':'assistant','content':None,'tool_calls':[{'id':'call_test','type':'function','function':{'name':'lookup','arguments':'{"value":"SECRET"}'}}]}],
        'toolResults':[{'role':'tool','tool_call_id':'call_test','content':'SECRET'}],
    }
    for scope,messages in scoped_messages.items():
        result=request('scope_'+scope,{'model':'safe','messages':messages})
        assert result[0]==422,(scope,result)
        error=json.loads(result[2])['error']
        assert error['guardrail']['matchedScope']==scope,(scope,error)
        RESULT.append({'case':'context_'+scope,'status':result[0]})
    if os.environ.get('MODEL_ARMOR_TEST_TEMPLATE'):
        for text,status in [('The weather is clear today.',200),('Credit card: 4111 1111 1111 1111',422)]:
            result=request('model_armor_request',{'model':'safe','messages':[{'role':'user','content':text}]})
            assert result[0]==status,('model armor input',status,result)
            if status==422:
                context=json.loads(result[2])['error']['guardrail']
                assert context['scopes']==['instructions','conversation'] and not context.get('matchedScope'),context
            RESULT.append({'case':'live_model_armor_input_'+str(status),'status':result[0]})
        result=request('model_armor_response',{'model':'pii_output','messages':[{'role':'user','content':'hello'}]})
        assert result[0]==422,('model armor output',result)
        RESULT.append({'case':'live_model_armor_output','status':result[0]})
    if os.environ.get('BEDROCK_TEST_GUARDRAIL'):
        for text in ['The weather is clear today.','My name is John Smith. My email is john.smith@example.com.']:
            start=len(CALLS)
            result=request('bedrock_request',{'model':'safe','messages':[{'role':'user','content':text}]})
            assert result[0]==200,('bedrock input',result)
            forwarded=CALLS[start:][-1]['body']['messages'][0]['content']
            assert 'John Smith' not in forwarded,forwarded
            RESULT.append({'case':'live_bedrock_mask' if 'John Smith' in text else 'live_bedrock_allow','status':result[0]})
    if '--opencode' in sys.argv:
        work=ROOT/'opencode-work';work.mkdir(exist_ok=True)
        for sdk in ['openai-compatible','openai']:
            delivery_case='structured_response'
            probe='structured_response_'+sdk
            start=len(CALLS)
            config={'provider':{'fixture':{'npm':'@ai-sdk/'+sdk,'name':'Fixture','options':{'baseURL':'http://127.0.0.1:'+str(PORTS[delivery_case])+'/v1','apiKey':'fixture'},'models':{'output':{'name':'output','limit':{'context':16384,'output':4096}}}}},'model':'fixture/output','small_model':'fixture/output'}
            cfgfile=ROOT/('opencode-'+probe+'.json');cfgfile.write_text(json.dumps(config))
            env=dict(os.environ,OPENCODE_CONFIG=str(cfgfile),OPENCODE_DISABLE_PROJECT_CONFIG='1',OPENCODE_DISABLE_MODELS_FETCH='1',OPENCODE_DISABLE_SHARE='1',XDG_CONFIG_HOME=str(ROOT/'xdg-config'),XDG_DATA_HOME=str(ROOT/'xdg-data'),XDG_CACHE_HOME=str(ROOT/'xdg-cache'))
            cli=subprocess.run([os.environ.get('OPENCODE_BINARY') or shutil.which('opencode') or 'opencode','run','--pure','--format','json','-m','fixture/output','--dir',str(work),'hello'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
            (ROOT/('opencode-'+probe+'.stdout')).write_bytes(cli.stdout)
            (ROOT/('opencode-'+probe+'.stderr')).write_bytes(cli.stderr)
            translated=next(event['error'] for line in cli.stdout.decode().splitlines() for event in [json.loads(line)] if event.get('type')=='error')
            assert translated['name'] in ['APIError','UnknownError'],translated
            assert 'Conversation output blocked by Secret check' in json.dumps(translated),translated
            model_calls=[call for call in CALLS[start:] if call['body'].get('model')=='output']
            attempts=[call for call in model_calls if not any(message.get('role')=='system' and message.get('content','').startswith('You are a title generator.') for message in call['body'].get('messages',call['body'].get('input',[])))]
            assert len(attempts)==1,('policy violation was retried',sdk)
            RESULT.append({'case':'opencode_'+probe,'status':cli.returncode,'typedContextLost':translated['name']=='UnknownError','stdout':cli.stdout.decode(),'stderr':cli.stderr.decode()})
    if '--codex' in sys.argv:
        home=ROOT/'codex-home';home.mkdir(exist_ok=True)
        env=dict(os.environ,CODEX_HOME=str(home),FIXTURE_API_KEY='fixture')
        cli=subprocess.run([os.environ.get('CODEX_BINARY','/root/.local/bin/codex'),'exec','--skip-git-repo-check','--ephemeral','--json','-c','model_provider="fixture"','-c','model_providers.fixture.name="Fixture"','-c','model_providers.fixture.base_url="http://127.0.0.1:'+str(PORTS['structured_response'])+'/v1"','-c','model_providers.fixture.wire_api="responses"','-c','model_providers.fixture.env_key="FIXTURE_API_KEY"','-c','model_providers.fixture.stream_max_retries=0','-c','model_providers.fixture.request_max_retries=0','-m','output','hello'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
        (ROOT/'codex.stdout').write_bytes(cli.stdout);(ROOT/'codex.stderr').write_bytes(cli.stderr)
        assert cli.returncode!=0 and b'Conversation output blocked by Secret check' in cli.stdout+cli.stderr,(cli.returncode,cli.stdout.decode(),cli.stderr.decode())
        RESULT.append({'case':'codex_structured_response','status':cli.returncode})
    if '--claude' in sys.argv:
        env=dict(os.environ,CLAUDE_CONFIG_DIR=str(ROOT/'claude-home'),ANTHROPIC_API_KEY='fixture',ANTHROPIC_BASE_URL='http://127.0.0.1:'+str(PORTS['structured_response']),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_AUTOUPDATER='1')
        env.pop('ANTHROPIC_AUTH_TOKEN',None)
        cli=subprocess.run([os.environ.get('CLAUDE_BINARY','claude'),'-p','hello','--output-format','json','--max-turns','1','--model','output','--no-session-persistence'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
        (ROOT/'claude.stdout').write_bytes(cli.stdout);(ROOT/'claude.stderr').write_bytes(cli.stderr)
        assert cli.returncode!=0 and b'Conversation output blocked by Secret check' in cli.stdout+cli.stderr,(cli.returncode,cli.stdout.decode(),cli.stderr.decode())
        RESULT.append({'case':'claude_structured_response','status':cli.returncode})
    for call in CALLS:
        if call['path'].endswith('/request') or call['path'].endswith('/response'):
            headers={key.lower():value for key,value in call['headers'].items()}
            assert headers.get('authorization')=='Bearer guardrail-auth',call
            assert 'cookie' not in headers and 'x-api-key' not in headers,call
            assert 'client-secret' not in json.dumps(headers),call
    time.sleep(.2)
    events=[event for line in (ROOT/'gateway.log').read_text().splitlines() if line.startswith('{') for event in json.loads(line).get('test.guardrails',[])]
    assert events,'missing exported per-check evaluations'
    assert all('agentz' not in event for event in events),'private runtime context still present'
    assert any(event['action']=='reject' for event in events),events
    assert any(event['action']=='audit' for event in events),events
    assert any(event['action']=='failOpen' for event in events),events
finally:
    for child in [process]:
        child.terminate()
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:child.kill()
    log.close();server.shutdown();alternate_server.shutdown()
    (ROOT/'results.json').write_text(json.dumps(RESULT,indent=2));(ROOT/'calls.json').write_text(json.dumps(CALLS,indent=2))
print(json.dumps({'passed':sum(not row['case'].startswith(('opencode_','codex_','claude_')) for row in RESULT),'clientProbes':sum(row['case'].startswith(('opencode_','codex_','claude_')) for row in RESULT),'results':str(ROOT/'results.json'),'logs':str(ROOT/'gateway.log')}))
