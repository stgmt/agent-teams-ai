import json,os,urllib.request
tok=open(os.path.expanduser('~/.spec-registry/mcp-token.txt'),encoding='utf-8').read().strip()
def rpc(p):
    r=urllib.request.Request('http://127.0.0.1:8650/mcp',data=json.dumps(p).encode(),headers={'content-type':'application/json','accept':'application/json, text/event-stream','authorization':f'Bearer {tok}'})
    raw=urllib.request.urlopen(r,timeout=90).read().decode()
    return json.loads([l for l in raw.splitlines() if l.startswith('{')][-1])
rpc({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'probe','version':'1'}}})
n=[10]
def call(tool,args):
    n[0]+=1
    pl=json.loads(rpc({'jsonrpc':'2.0','id':n[0],'method':'tools/call','params':{'name':tool,'arguments':args}})['result']['content'][0]['text'])
    e=pl.get('error') or {}
    return pl.get('ok'), e.get('code'), str(e.get('message'))[:110], [f.get('code') for f in (e.get('findings') or [])]
S={'project':'stgmt/tokenplan','spec':'chain-check-20261110'}
cases=[
 ('createSpec existing', 'spec_patch', {**S,'intent':'createSpec','title':'x','reason':'r','requestId':'rv1','dryRun':True}),
 ('amendRequirement ok', 'spec_patch', {**S,'intent':'amendRequirement','requirement':'FR-1','body':'доп','reason':'r','requestId':'rv2','dryRun':True}),
 ('addAC ok', 'spec_patch', {**S,'intent':'addAcceptanceCriterion','requirement':'FR-1','criterion':'критерий','reason':'r','requestId':'rv3','dryRun':True}),
 ('metas ok', 'spec_patch', {**S,'intent':'setRequirementMetadata','requirement':'FR-1','metadata':{'owner':'x'},'reason':'r','requestId':'rv4','dryRun':True}),
 ('task dup', 'spec_patch', {**S,'intent':'confirmTaskCreation','entity':'TASK-1','subject':'x','requirements':['FR-1'],'reason':'r','requestId':'rv5','dryRun':True}),
 ('update status deleted', 'spec_patch', {**S,'intent':'updateTask','entity':'TASK-1','status':'deleted','reason':'r','requestId':'rv6','dryRun':True}),
 ('comment missing task', 'spec_patch', {**S,'intent':'addTaskComment','entity':'TASK-999','text':'x','reason':'r','requestId':'rv7','dryRun':True}),
 ('claim', 'spec_patch', {**S,'intent':'patch','operations':[],'reason':'r','requestId':'rv8','dryRun':True}),
 ('read missing doc', 'spec_documents', {**S,'action':'read','doc':'NOPE.md'}),
 ('docs unknown spec', 'spec_documents', {'project':'stgmt/tokenplan','spec':'nope-spec','action':'list'}),
 ('inspect unknown spec', 'spec_inspect', {'project':'stgmt/tokenplan','check':'validation','specSlugs':['nope-spec']}),
 ('tasks bad status', 'spec_tasks', {**S,'statuses':['bogus']}),
 ('tasks bad cursor', 'spec_tasks', {**S,'cursor':'zzz'}),
]
for label,tool,args in cases:
    ok,code,msg,findings=call(tool,args)
    print(f"{label:26s} ok={ok} code={code} findings={findings} msg={msg}")
