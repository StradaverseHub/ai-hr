/** Full private adapter with fake native responses and fake SMTP; no real credentials or mail. */
import {createHash} from 'node:crypto';
import {beforeEach,it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({queries:[] as string[],files:[] as Record<string,unknown>[],start:true,target:null as any,send:vi.fn(),relay:vi.fn(),principal:vi.fn()}));
vi.mock('../db/client',()=>({withSystemWork:<T>(work:()=>T)=>work(),client:async(q:TemplateStringsArray)=>{const text=q.join('?');f.queries.push(text);if(text.includes('automation_email_target('))return[{target:f.target}];if(text.includes('automation_email_assets('))return f.files;if(text.includes('automation_email_start('))return[{started:f.start}];if(text.includes('automation_email_finish('))return[{finished:true}];throw Error('Unexpected native query');}}));
vi.mock('../lib/internal-auth/config',()=>({internalConfig:()=>({origin:'https://fictional.invalid'}),internalIssuer:()=> 'https://fictional.invalid/auth/tenant'}));
vi.mock('../lib/internal-auth/active-relay',()=>({readLifecycleRelayTx:f.relay}));
vi.mock('../lib/internal-auth/store',()=>({admittedAuthSql:{},readRecord:async()=>({subject:'human',tenantId:'tenant',issuer:'https://fictional.invalid/auth/tenant',email:'human@fictional.invalid'})}));
vi.mock('../lib/internal-auth/service',()=>({assertActiveCredential:f.principal,InternalAuthError:class extends Error{}}));
vi.mock('../lib/internal-auth/smtp',()=>({sendSmtp:f.send}));
import {internalAutomationMail} from '../lib/internal-auth/automation-mail';
const id='10000000-0000-4000-8000-000000000001',token='10000000-0000-4000-8000-000000000002',user='10000000-0000-4000-8000-000000000003',bytes=Buffer.from('Fictional private file');
beforeEach(()=>{vi.resetAllMocks();f.queries=[];f.start=true;f.relay.mockResolvedValue({revision:'r1',senderName:'OneHR',relay:{config:{from:'noreply@fictional.invalid',fromName:'OneHR'}}});f.principal.mockResolvedValue({app_user_id:user});f.send.mockResolvedValue(undefined);f.files=[{id,kind:'file',filename:'information.txt',mime_type:'text/plain',bytes:bytes.toString('base64')}];f.target={id,tenantId:'tenant',module:'contract_staff',subjectId:id,bindings:[{userId:user,subject:'human',issuer:'https://fictional.invalid/auth/tenant'}],payload:{version:1,module:'contract_staff',subjectId:id,linkPath:'/lifecycle/contracts/'+id,mail:{id,to:[user],cc:[],subject:'Fictional information',body:'Your file.',delivery:{version:1,sender:'noreply',assets:[{id,kind:'file',name:'information.txt',mimeType:'text/plain',size:bytes.length,contentHash:createHash('sha256').update(bytes).digest('hex'),at:'2026-11-17T00:00:00.000Z',by:'Fictional author'}]}}}};});
it('passes immutable bytes and verified addresses through the existing OneHR sender after native start',async()=>{
 expect(await internalAutomationMail({deliveryId:id,leaseToken:token},f.send)).toEqual({outcome:'sent',error:null});
 expect(f.send).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({to:'human@fictional.invalid',cc:[],senderName:'OneHR',attachments:[{filename:'information.txt',contentType:'text/plain',bytes}]}));
 expect(f.queries.findIndex(q=>q.includes('automation_email_assets('))).toBeLessThan(f.queries.findIndex(q=>q.includes('automation_email_start(')));expect(f.queries.at(-1)).toContain('automation_email_finish(');
});
for(const failure of ['missingBytes','changedPerson','startRefused'])it(`never invokes SMTP after ${failure}`,async()=>{
 if(failure==='missingBytes')f.files=[];if(failure==='changedPerson')f.principal.mockResolvedValue({app_user_id:id});if(failure==='startRefused')f.start=false;
 expect(await internalAutomationMail({deliveryId:id,leaseToken:token},f.send)).toMatchObject({outcome:'skipped'});expect(f.send).not.toHaveBeenCalled();
});
