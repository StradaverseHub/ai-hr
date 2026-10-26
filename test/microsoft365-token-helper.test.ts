/** Executes the actual Python token leaf with a captured HTTPS opener; no real tenant or network. */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
it('pins Microsoft app-only grant, verified TLS, bounded responses, lifetime and the no-redirect policy in the installed Python leaf',()=>{
 const output=execFileSync('python3',['-I','-c',String.raw`
import importlib.util,json,urllib.parse
s=importlib.util.spec_from_file_location('token','deploy/identity-email/smtp-token-peer.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
request={'tenantId':'11111111-1111-4111-8111-111111111111','clientId':'22222222-2222-4222-8222-222222222222','clientSecret':'fictional-secret'}
body={'access_token':'fictional-token','token_type':'Bearer','expires_in':3600}
class Response:
 status=200
 def __init__(self,body):self.body=body
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,n):assert n==32769;return self.body[:n]
class Opener:
 def __init__(self,body):self.body=body;self.calls=0
 def open(self,req,timeout):
  self.calls+=1;assert timeout==8 and req.full_url=='https://login.microsoftonline.com/'+request['tenantId']+'/oauth2/v2.0/token'
  assert urllib.parse.parse_qs(req.data.decode())=={'client_id':[request['clientId']],'client_secret':[request['clientSecret']],'grant_type':['client_credentials'],'scope':['https://outlook.office365.com/.default']}
  return Response(self.body)
opener=Opener(json.dumps(body).encode());assert m.acquire(request,opener,lambda:1000)=={'accessToken':'fictional-token','accessTokenExpiresAt':4600000};assert opener.calls==1
bad=[b'x'*32769,b'not-json',json.dumps({**body,'expires_in':True}).encode(),json.dumps({**body,'expires_in':30}).encode(),json.dumps({**body,'access_token':'x\r\ny'}).encode(),json.dumps({**body,'token_type':'MAC'}).encode(),json.dumps({**body,'access_token':'x'*16385}).encode()]
for raw in bad:
 try:m.acquire(request,Opener(raw),lambda:1000)
 except Exception:pass
 else:raise RuntimeError('bad provider response accepted')
for patch in [{'tenantId':'../common'},{'endpoint':'https://evil.test'},{'clientSecret':''}]:
 try:m.acquire({**request,**patch},opener,lambda:1000)
 except Exception:pass
 else:raise RuntimeError('bad request accepted')
clock=iter([1000,1061])
try:m.acquire(request,Opener(json.dumps({**body,'expires_in':120}).encode()),lambda:next(clock))
except Exception:pass
else:raise RuntimeError('slow expired token accepted')
try:m.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://evil.test')
except ValueError:pass
else:raise RuntimeError('redirect accepted')
print('bounded fixed Microsoft token capability passed')
`],{cwd:process.cwd(),encoding:'utf8',timeout:10000});
 expect(output.trim()).toBe('bounded fixed Microsoft token capability passed');
});
it('keeps the Auth broker loopback-only and the token helper keyless, privately socketed and bounded',()=>{
 const read=(path:string)=>readFileSync('deploy/identity-email/'+path,'utf8');
 expect(read('aihr-report-auth@.service')).toContain('IPAddressDeny=any\nIPAddressAllow=localhost');
 const service=read('aihr-smtp-token@.service');expect(service).toContain('DynamicUser=yes');expect(service).not.toContain('EnvironmentFile=');expect(service).toContain('MemoryMax=32M');expect(service).toContain('RuntimeMaxSec=14');expect(service).toContain('ProtectProc=invisible');expect(service).toContain('InaccessiblePaths=/etc/aihr-internal-report');
 const socket=read('aihr-smtp-token.socket');expect(socket).toContain('SocketUser=@WEB_USER@\nSocketMode=0600');expect(socket).toContain('MaxConnections=1');
 const peer=read('smtp-token-peer.py');expect(peer).toContain('socket.SO_PEERCRED');expect(peer).toContain('uid==int(expected) and uid!=os.getuid()');expect(peer).toContain('signal.alarm(12)');expect(peer).toContain('urllib.request.ProxyHandler({})');expect(peer).not.toContain('print(');
 expect(read('report-auth-broker.ts')).toContain('prepareRelay:prepareReportSmtpRelay');
 for(const name of ['build-internal-reports.ts','upgrade-internal-reports.ts'])expect(read(name)).toContain("'smtp-token-peer.py','aihr-smtp-token.socket','aihr-smtp-token@.service'");
});
