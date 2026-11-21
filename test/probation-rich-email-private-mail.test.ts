import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
const fixture=vi.hoisted(()=>({sql:vi.fn(),credential:vi.fn(),active:vi.fn(),principal:vi.fn()}));
vi.mock('../db/client',()=>({client:fixture.sql,withSystemWork:(work:()=>unknown)=>work()}));
vi.mock('../lib/internal-auth/config',()=>({internalConfig:()=>({origin:'https://fictional.example'}),internalIssuer:(tenant:string)=>'https://fictional.example/auth/'+tenant}));
vi.mock('../lib/internal-auth/store',()=>({admittedAuthSql:fixture.sql,readRecord:fixture.credential}));
vi.mock('../lib/internal-auth/active-relay',()=>({readLifecycleRelayTx:fixture.active}));
vi.mock('../lib/internal-auth/service',()=>({assertActiveCredential:fixture.principal,InternalAuthError:class extends Error{}}));
import {internalAutomationMail} from '../lib/internal-auth/automation-mail';
import type {AutomationMailTarget} from '../lib/automation-email-ipc';
const request={deliveryId:randomUUID(),leaseToken:randomUUID()},userId=randomUUID(),tenantId=randomUUID(),subject=randomUUID(),documentId=randomUUID(),imageId=randomUUID(),fileId=randomUUID();
const relay={revision:'fixture-applied-revision',senderName:'OneHR',relay:{config:{from:'verified@fictional.invalid',fromName:'Fictional relay'},password:'fictional-private-relay-secret'}};
let target:AutomationMailTarget,documentBytes:Buffer,imageBytes:Buffer,fileBytes:Buffer,materialization:unknown;
const called=(fragment:string)=>fixture.sql.mock.calls.some(call=>call[0].join('?').includes(fragment));
beforeEach(()=>{
 vi.resetAllMocks();materialization={version:1,deliveryId:request.deliveryId,sourceDigest:'d'.repeat(64),renderDigest:'e'.repeat(64)};documentBytes=Buffer.from('%PDF-frozen-exact-outcome');imageBytes=Buffer.from('frozen-image-bytes');fileBytes=Buffer.from('frozen-personal-file');
 const caseId=randomUUID();target={id:request.deliveryId,tenantId,module:'probation',subjectId:caseId,payload:{version:1,module:'probation',subjectId:caseId,linkPath:'/lifecycle/probation/'+caseId,mail:{id:'fixture-saved-mail',to:[userId],cc:[],subject:'Your saved probation letter',body:'Hello <Fictional> {{case.link}}',delivery:{version:2,sender:'noreply',html:'<p>Hello &lt;Fictional&gt; &#123;&#123;case.link&#125;&#125;</p><img src="cid:v9-image.'+imageId+'@aihr" alt="Fictional image"><script>unsafe()</script>',documents:[{id:documentId,templateId:'confirm',name:'Fictional outcome.pdf',contentHash:'a'.repeat(64),path:'/lifecycle/probation/'+caseId+'/files/'+documentId,link:true,attach:true,outcome:true,outcomeId:randomUUID()}],caseFiles:[{id:fileId,slotId:randomUUID(),name:'Fictional.txt',contentHash:'b'.repeat(64)}],assets:[{id:imageId,kind:'image',contentHash:'c'.repeat(64)}]}}},bindings:[{userId,subject,issuer:'https://fictional.example/auth/'+tenantId}]};
 fixture.sql.mockImplementation(async(strings:TemplateStringsArray)=>{const sql=strings.join('?');if(sql.includes('email_target'))return[{target}];if(sql.includes('probation_email_materialization'))return[{proof:materialization}];if(sql.includes('email_document_files'))return[{id:documentId,filename:'Fictional outcome.pdf',mime_type:'application/pdf',bytes:documentBytes.toString('base64')}];if(sql.includes('email_case_files'))return[{id:fileId,filename:'Fictional.txt',mime_type:'text/plain',bytes:fileBytes.toString('base64')}];if(sql.includes('email_assets'))return[{id:imageId,kind:'image',filename:'Fictional.png',mime_type:'image/png',bytes:imageBytes.toString('base64')}];if(sql.includes('email_start'))return[{started:true}];if(sql.includes('email_finish'))return[{finished:true}];throw Error('Unexpected private SQL');});
 fixture.active.mockResolvedValue(relay);fixture.credential.mockResolvedValue({subject,tenantId,issuer:target.bindings[0].issuer,email:'employee@fictional.invalid'});fixture.principal.mockResolvedValue({app_user_id:userId,tenant_id:tenantId});
});
it('sends sanitized frozen rich MIME, exact outcome and per-person bytes, inline CID and the canonical OneHR sender only after start',async()=>{
 const transport=vi.fn(async()=>{expect(called('email_start')).toBe(true);expect(called('email_finish')).toBe(false);});
 expect(await internalAutomationMail(request,transport)).toEqual({outcome:'sent',error:null});
 expect(called('probation_automation_email_assets(')).toBe(true);
 const proofCall=fixture.sql.mock.calls.find(call=>call[0].join('?').includes('email_start'));expect(JSON.parse(String(proofCall?.at(-1)))).toMatchObject({probationMaterialization:materialization});
 const names=fixture.sql.mock.calls.map(call=>call[0].join('?'));expect(names.findIndex(name=>name.includes('probation_email_materialization'))).toBeLessThan(names.findIndex(name=>name.includes('email_document_files')));
 expect(transport).toHaveBeenCalledOnce();const mail=transport.mock.calls[0] as unknown as [unknown,{html:string;text:string;attachments:{bytes:Uint8Array;cid?:string}[];senderName:string}];
 expect(mail[1].senderName).toBe('OneHR');expect(mail[1].html).not.toContain('<script');expect(mail[1].html).toContain('https://fictional.example'+target.payload.linkPath);expect(mail[1].text).toContain('Hello <Fictional> https://fictional.example');
 expect(mail[1].attachments.map(file=>Buffer.from(file.bytes))).toEqual([documentBytes,fileBytes,imageBytes]);expect(mail[1].attachments[2].cid).toBe('v9-image.'+imageId+'@aihr');expect(called('email_finish')).toBe(true);
});
it('refuses an over-budget snapshot before starting or sending',async()=>{
 const transport=vi.fn();documentBytes=Buffer.alloc(20_000_000,1);expect(await internalAutomationMail(request,transport)).toEqual({outcome:'skipped',error:'notEligible'});expect(called('email_start')).toBe(false);expect(transport).not.toHaveBeenCalled();
});
it('retains the original plain-text delivery path for unconverted emails',async()=>{
 target.payload.mail.delivery={version:1,sender:'noreply'};const transport=vi.fn(async()=>{});expect(await internalAutomationMail(request,transport)).toEqual({outcome:'sent',error:null});expect(transport).toHaveBeenCalledWith(relay.relay,expect.objectContaining({subject:target.payload.mail.subject,attachments:[],senderName:'OneHR'}));expect(called('email_assets')).toBe(false);
});

it('refuses an unavailable frozen document before start rather than substituting another PDF',async()=>{
 target.payload.mail.delivery.documents![0].id=randomUUID();const transport=vi.fn();
 expect(await internalAutomationMail(request,transport)).toEqual({outcome:'skipped',error:'notEligible'});expect(called('email_start')).toBe(false);expect(transport).not.toHaveBeenCalled();
});

it('refuses missing probation materialization before reading any attachment bytes or starting SMTP',async()=>{
 materialization=null;const transport=vi.fn();
 expect(await internalAutomationMail(request,transport)).toEqual({outcome:'skipped',error:'notEligible'});
 expect(called('email_document_files')).toBe(false);expect(called('email_case_files')).toBe(false);expect(called('email_assets')).toBe(false);expect(called('email_start')).toBe(false);expect(transport).not.toHaveBeenCalled();
});
it('does not send when the native start rejects a stale probation materialization after the bytes were read',async()=>{
 const original=fixture.sql.getMockImplementation()!;fixture.sql.mockImplementation(async(strings:TemplateStringsArray,...values:unknown[])=>strings.join('?').includes('email_start')?[{started:false}]:original(strings,...values));
 const transport=vi.fn();expect(await internalAutomationMail(request,transport)).toEqual({outcome:'skipped',error:'notEligible'});
 expect(called('probation_email_materialization')).toBe(true);expect(called('email_document_files')).toBe(true);expect(called('email_start')).toBe(true);expect(called('email_finish')).toBe(false);expect(transport).not.toHaveBeenCalled();
});
