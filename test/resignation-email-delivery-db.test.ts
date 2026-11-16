/** Real Offboarding delivery custody: actual signed service receipts, native queue checks and the private sender protocol. No SMTP. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {hireEmployee} from '../core/org';
import {commandResignationJourney,submitResignationJourney} from '../packs/lifecycle/service';
import {deliverAutomationEmails,queueAutomationEmailTx} from '../core/automation-email-delivery';
import {prepareResignationProofTx,resignationRuntimeKey} from '../core/resignation-proof';
import {client,type SessionContext,type Tx} from '../db/client';
import {generate} from 'otplib';
import {bootstrapInternalOwner} from '../lib/internal-auth/bootstrap';
import {changeInitialPassword,credentialByLogin,startLogin,verifyMfa} from '../lib/internal-auth/service';
import {assertActiveCredential,type Credential} from '../lib/internal-auth/credential';
import {admittedAuthSql,readRecord} from '../lib/internal-auth/store';
import type {Document,EmailAsset,Template} from '../lib/lifecycle-v9-model';
import type {ResignationCaseView} from '../lib/resignation-journey';
import type {AutomationDeliveryRequest,AutomationDeliveryResult,AutomationEmailContent,AutomationMailTarget} from '../lib/automation-email-ipc';

const ORIGIN='https://resignation-mail-fixture.example',MASTER='ab'.repeat(32);
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const port={withTenant:async<T>(ctx:SessionContext,work:(tx:Tx)=>Promise<T>)=>owner.withTenant(ctx,work)};
type Fixture=Awaited<ReturnType<typeof resignationJourneyFixture>>;
type Delivery={id:string;subject_id:string;mail_key:string;status:string;error_code:string|null;payload:AutomationMailTarget['payload']};
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await resetDb();vi.stubEnv('AUTH_PUBLIC_ORIGIN',ORIGIN);vi.stubEnv('AUTH_SESSION_KEY',MASTER);
 await owner.db.execute(sql`insert into app.resignation_runtime_verifier(singleton,secret) values(true,${resignationRuntimeKey(MASTER)}) on conflict(singleton) do update set secret=excluded.secret`);
});
const identity=(f:Fixture,userId:string)=>owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${ORIGIN+'/auth/'+f.base.tenantId},${randomUUID()},${userId}::uuid)`);
const deliveries=(f:Fixture)=>owner.db.execute<Delivery>(sql`select id,subject_id,mail_key,status,error_code,payload from automation_email_delivery where tenant_id=${f.base.tenantId}::uuid and module='off' order by mail_key`);
const runtime=(f:Fixture)=>({...f.admin,userId:undefined,personId:undefined,roles:[],grants:undefined} as SessionContext);

/** The aggregate is released through an actual assigned HR signature, never by forging a signed JSON row. */
async function signedFixture(){
 const f=await resignationJourneyFixture({sessionKey:MASTER,origin:ORIGIN}),templateId=randomUUID(),emailId=randomUUID();
 const template:Template={id:templateId,name:'Fictional acceptance letter',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'before',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:f.managerUserId,fields:[],blocks:[{id:'heading',type:'heading',text:'Resignation acceptance',section:''},{id:'body',type:'text',text:'Dear {employee.name}. Last working day: {resignation.lastDay}.',section:''},{id:'company-signature',type:'signature',text:'',label:'For the company',role:'step:company-sign',section:''}],routing:[{id:'company-sign',order:1,action:'sign',who:{kind:'group',groupId:f.groupId},owner:true}]}]};
 f.config.templates.push(template);const sourceEmail=f.config.emails.find(email=>email.module==='off');expect(sourceEmail).toBeDefined();
 f.config.emails.push({...structuredClone(sourceEmail!),id:emailId,name:'Fictional release email',active:true,subject:'Signed letter',body:'Open {{case.link}}',cc:[],links:[],attachments:[],slots:[],files:[],images:[]});
 await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
 await f.workflow('accepted',[{id:'generate',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}}]);
 const release=async(journey:ResignationCaseView)=>{
  let value=await commandResignationJourney(f.admin,{caseId:journey.id,revision:journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:true}});
  expect(value.letters).toHaveLength(1);let letter=value.letters[0];expect(letter.capabilities.sign).toBe(true);
  value=await commandResignationJourney(f.admin,{caseId:value.id,revision:value.revision,command:{type:'openLetter',documentId:letter.id,documentRevision:letter.revision}});letter=value.letters[0];
  value=await commandResignationJourney(f.admin,{caseId:value.id,revision:value.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Journey manager',consent:true}});
  const [row]=await owner.db.execute<{documents:Document[]}>(sql`select data->'releasedDocuments' as documents from resignation_journey where tenant_id=${f.base.tenantId}::uuid and id=${value.id}::uuid`);
  expect(row.documents).toHaveLength(1);expect(row.documents[0]).toMatchObject({id:letter.id,templateId,status:'signed'});expect(Object.values(row.documents[0].stepSignatures??{})).toEqual([expect.objectContaining({by:expect.objectContaining({id:f.managerUserId}),value:'Journey manager',consent:true})]);
  return{value,document:row.documents[0]};
 };
 const signed=await release(f.journey);
 const another=async()=>{
  const person=await hireEmployee(f.admin,{person:{fullName:'Second mail fixture employee'},companyId:f.base.companyId,departmentId:f.base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'}),userId=await createAppUser(f.base.tenantId,person.personId,'employee');
  const ctx:SessionContext={tenantId:f.base.tenantId,userId,personId:person.personId,roles:['employee'],entitlements:harnessSnapshot(f.base.tenantId)};
  return release(await submitResignationJourney(ctx,{employmentId:person.employmentId,lastWorkingDay:f.lastWorkingDay,reason:'Second independent case.'}));
 };
 return{f,...signed,templateId,emailId,another};
}

/** An authorized command establishes native custody; exact queue arguments still undergo native validation. */
async function queue(f:Fixture,value:ResignationCaseView,key:string,to:string[],cc:string[],content:AutomationEmailContent|null=null,raw=false){
 const command={type:'taskProgress',taskId:value.replacementRequest!.id,status:'progress'};
 return owner.withTenant(f.admin,async tx=>{
  await prepareResignationProofTx(tx,f.admin,{operation:'begin',caseId:value.id,revision:value.revision,command,args:{}});
  const input={module:'off' as const,subjectId:value.id,key,to,cc,subject:'Signed fixture letter',body:'Open {{case.link}}',...(content?{content}:{})};
  if(!raw)return queueAutomationEmailTx(tx,input,f.admin);
  await prepareResignationProofTx(tx,f.admin,{operation:'email',caseId:value.id,args:{key,to,cc,subject:input.subject,body:input.body,content}});
  const[row]=await tx.execute<{data:{queued:number;to:string[];cc:string[];unreachable:string[]}}>(sql`select app.resignation_email_queue(${value.id}::uuid,${key},${'{'+to.join(',')+'}'}::uuid[],${'{'+cc.join(',')+'}'}::uuid[],${input.subject},${input.body},${JSON.stringify(content)}::jsonb) as data`);return row.data;
 });
}
async function storedContent(f:Fixture,value:ResignationCaseView,document:Document,emailId:string){
 const assetId=randomUUID(),fileId=randomUUID(),assetBytes=Buffer.from('Immutable template attachment.'),fileBytes=Buffer.from('Confidential per-person evidence.');
 await owner.db.execute(sql`insert into lc_v9_email_asset(id,tenant_id,email_template_id,kind,filename,mime_type,content,uploaded_by,uploaded_by_name) values(${assetId}::uuid,${f.base.tenantId}::uuid,${emailId},'file','template-note.txt','text/plain',${assetBytes},${f.managerUserId}::uuid,'Journey manager')`);
 await owner.db.execute(sql`insert into resignation_journey_file(tenant_id,id,case_id,slot,content_hash,name,mime_type,size,content,uploaded_by) values(${f.base.tenantId}::uuid,${fileId}::uuid,${value.id}::uuid,'fixture-evidence',${digest(fileBytes)},'case-evidence.txt','text/plain',${fileBytes.byteLength},${fileBytes},${f.managerUserId}::uuid)`);
 const asset:EmailAsset={id:assetId,kind:'file',name:'template-note.txt',mimeType:'text/plain',size:assetBytes.byteLength,contentHash:digest(assetBytes),at:new Date().toISOString(),by:f.managerUserId};
 const content:AutomationEmailContent={number:value.number,emailTemplateId:emailId,documents:[document],pdfDocumentIds:[document.id],linkDocumentIds:[document.id],assets:[asset],files:[{id:fileId,storageId:fileId,name:'case-evidence.txt',contentHash:digest(fileBytes)}]};
 return{content,assetBytes,fileBytes};
}
const target=async(request:AutomationDeliveryRequest,origin=ORIGIN)=>{const[row]=await owner.db.execute<{target:AutomationMailTarget|null}>(sql`select app.automation_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin}) as target`);return row.target;};
const files=(request:AutomationDeliveryRequest)=>owner.db.execute<{id:string;filename:string;bytes:string;content_hash:string}>(sql`select * from app.resignation_email_files(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${ORIGIN})`);
const assets=(request:AutomationDeliveryRequest)=>owner.db.execute<{id:string;filename:string;bytes:string;content_hash:string}>(sql`select * from app.resignation_email_assets(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${ORIGIN})`);
async function start(request:AutomationDeliveryRequest,mail:AutomationMailTarget){const proof={bindings:mail.bindings,addresses:mail.bindings.map((_,i)=>`recipient${i}@resignation-fixture.invalid`),relayRevision:'1'};const[row]=await owner.db.execute<{started:boolean}>(sql`select app.automation_email_start(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${ORIGIN},${JSON.stringify(proof)}::jsonb) as started`);return row.started;}

describe('Offboarding signed email delivery custody',()=>{
 it('freezes actual signed PDF metadata, preserves To/CC, queues a duplicate event key once and scopes bytes to the live sender lease',async()=>{
  const {f,value,document,emailId}=await signedFixture();await identity(f,f.employeeUserId);await identity(f,f.managerUserId);
  // A reachable CC must never become To when the intended To has no address.
  expect(await queue(f,value,'missing-to',[f.fyiUserId],[f.managerUserId])).toMatchObject({queued:0,to:[],cc:[f.managerUserId],unreachable:[f.fyiUserId]});expect(await deliveries(f)).toHaveLength(0);
  await identity(f,f.fyiUserId);const {content,assetBytes,fileBytes}=await storedContent(f,value,document,emailId);
  expect(await queue(f,value,'signed-release',[f.employeeUserId],[f.employeeUserId,f.managerUserId,f.fyiUserId],content)).toMatchObject({queued:1,to:[f.employeeUserId],cc:[f.managerUserId,f.fyiUserId]});
  expect((await queue(f,value,'signed-release',[f.employeeUserId],[f.employeeUserId,f.managerUserId,f.fyiUserId],content)).queued).toBe(0);
  const rows=await deliveries(f);expect(rows).toHaveLength(1);expect(rows[0].payload).toMatchObject({module:'off',subjectId:value.id,linkPath:'/lifecycle/resignations/'+value.id,content,mail:{to:[f.employeeUserId],cc:[f.managerUserId,f.fyiUserId]}});
  expect(JSON.stringify(rows[0].payload)).not.toContain(fileBytes.toString());expect(await owner.db.execute(sql`select 1 from domain_event where tenant_id=${f.base.tenantId}::uuid and event_type='automation.email-queued' and payload->>'key'='signed-release'`)).toHaveLength(1);
  expect(await target({deliveryId:rows[0].id,leaseToken:randomUUID()})).toBeNull();
  const sent=await deliverAutomationEmails(runtime(f),port,async(request):Promise<AutomationDeliveryResult>=>{
   const mail=await target(request);expect(mail).not.toBeNull();expect(mail!.payload.content).toEqual(content);expect(mail!.bindings.map(binding=>binding.userId)).toEqual([f.employeeUserId,f.managerUserId,f.fyiUserId]);
   expect(await target({...request,leaseToken:randomUUID()})).toBeNull();expect(await start({...request,leaseToken:randomUUID()},mail!)).toBe(false);expect(await target(request,'https://unrelated-sender.example')).toBeNull();
   expect(await files(request)).toEqual([expect.objectContaining({id:content.files![0].id,filename:'case-evidence.txt',bytes:fileBytes.toString('base64'),content_hash:digest(fileBytes)})]);
   expect(await assets(request)).toEqual([expect.objectContaining({id:content.assets![0].id,filename:'template-note.txt',bytes:assetBytes.toString('base64'),content_hash:digest(assetBytes)})]);
   expect(await files({...request,deliveryId:randomUUID()})).toEqual([]);expect(await assets({...request,leaseToken:randomUUID()})).toEqual([]);
   await owner.db.execute(sql`update automation_email_delivery set lease_until=now()-interval '1 second' where id=${request.deliveryId}::uuid`);expect(await target(request)).toBeNull();expect(await assets(request)).toEqual([]);expect(await files(request)).toEqual([]);await owner.db.execute(sql`update automation_email_delivery set lease_until=now()+interval '3 minutes' where id=${request.deliveryId}::uuid`);
   expect(await start(request,mail!)).toBe(true);expect(await target(request)).toBeNull();expect(await files(request)).toEqual([]);expect(await assets(request)).toEqual([]);
   await owner.db.execute(sql`select app.automation_email_finish(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'sent',null)`);return{outcome:'sent',error:null};
  });
  expect(sent).toEqual({attempted:1,sent:1,held:0,failed:0,cancelled:0});expect((await deliveries(f))[0].status).toBe('sent');expect(await deliverAutomationEmails(runtime(f),port,async()=>{throw Error('Completed delivery must never call SMTP again.');})).toMatchObject({attempted:0});
 },90000);
 it('delivers to an account-only HR recipient through its actual verified credential and native issuer/subject binding',async()=>{
  const {f,value}=await signedFixture(),userId=await createAppUser(f.base.tenantId,null,'hr_admin');
  const[account]=await owner.db.execute<{person_id:string|null}>(sql`select person_id from app_user where id=${userId}::uuid`);expect(account.person_id).toBeNull();
  const temporary='Fictional temporary credential 771!',password='Fictional replacement credential 992!',email='account-only-hr@resignation-fixture.invalid';
  await bootstrapInternalOwner(owner.client,{appUserId:userId,organization:'accountonly',username:'recipient.hr',email,password:temporary,installationOperator:false});
  const login=await startLogin({organization:'accountonly',username:'recipient.hr',password:temporary,native:false});
  if(login.step!=='password')throw Error('Expected account-only fixture initial password challenge.');
  const setup=await changeInitialPassword(login.challenge,password);if(setup.step!=='enroll'||!setup.secret)throw Error('Expected account-only fixture MFA enrollment.');
  expect((await verifyMfa(setup.challenge,await generate({secret:setup.secret}))).step).toBe('complete');
  const credential=(await credentialByLogin('accountonly','recipient.hr'))!;expect(credential).toMatchObject({email,emailVerified:true,enabled:true,issuer:ORIGIN+'/auth/'+f.base.tenantId});
  expect(await assertActiveCredential(admittedAuthSql,credential)).toEqual({app_user_id:userId,tenant_id:f.base.tenantId});
  const[principal]=await client`select * from app.principal_by_identity(${credential.issuer},${credential.subject})`;expect(principal.person_id).toBeNull();expect(principal.app_user_id).toBe(userId);
  expect(await queue(f,value,'account-only-hr',[userId],[])).toMatchObject({queued:1,to:[userId],cc:[],unreachable:[]});
  const sent=await deliverAutomationEmails(runtime(f),port,async request=>{
   const mail=await target(request);expect(mail).not.toBeNull();expect(mail!.payload.mail.to).toEqual([userId]);expect(mail!.bindings).toEqual([{userId,issuer:credential.issuer,subject:credential.subject}]);
   // This is the same private credential/principal check used before constructing the SMTP envelope.
   const current=await readRecord<Credential>(admittedAuthSql,'credential:'+mail!.bindings[0].subject);expect(current).not.toBeNull();expect(current!.email).toBe(email);expect(await assertActiveCredential(admittedAuthSql,current!)).toEqual({app_user_id:userId,tenant_id:f.base.tenantId});
   const proof={bindings:mail!.bindings,addresses:[current!.email],relayRevision:'1'};
   const[started]=await owner.db.execute<{started:boolean}>(sql`select app.automation_email_start(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${ORIGIN},${JSON.stringify(proof)}::jsonb) as started`);expect(started.started).toBe(true);
   await owner.db.execute(sql`select app.automation_email_finish(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'sent',null)`);return{outcome:'sent',error:null};
  });
  expect(sent).toEqual({attempted:1,sent:1,held:0,failed:0,cancelled:0});expect((await deliveries(f))[0]).toMatchObject({status:'sent',mail_key:'account-only-hr:0'});
 },90000);
 it('rejects unsigned, altered and same-tenant foreign-case documents plus mismatched template, asset hash and case-file references at the native boundary',async()=>{
  const {f,value,document,emailId,another}=await signedFixture();await identity(f,f.employeeUserId);const foreign=await another();const {content}=await storedContent(f,value,document,emailId),foreignStored=await storedContent(f,foreign.value,foreign.document,emailId);
  const attempts:AutomationEmailContent[]=[{...content,documents:[{...document,status:'draft'}]},{...content,documents:[{...document,name:'Changed after signing'}]},{...content,documents:[foreign.document],pdfDocumentIds:[foreign.document.id],linkDocumentIds:[]},{...content,emailTemplateId:randomUUID()},{...content,assets:[{...content.assets![0],contentHash:'0'.repeat(64)}]},{...content,assets:[{...content.assets![0],name:'changed-name.txt'}]},{...content,assets:[{...content.assets![0],size:content.assets![0].size+1}]},{...content,files:[{...content.files![0],storageId:randomUUID()}]},{...content,files:[{...content.files![0],contentHash:'0'.repeat(64)}]},{...content,files:foreignStored.content.files}];
  for(const[index,bad]of attempts.entries())await expect(queue(f,value,'refused-'+index,[f.employeeUserId],[],bad,true)).rejects.toThrow();
  expect(await deliveries(f)).toEqual([]);
  // The exact own-case snapshot remains sendable after every refused attempt rolled back.
  expect((await queue(f,value,'accepted-exact',[f.employeeUserId],[],content,true)).queued).toBe(1);
 },90000);
 it('holds a missing relay before start, but never replays an uncertain send after the native SMTP start receipt',async()=>{
  const {f,value}=await signedFixture();await identity(f,f.employeeUserId);await queue(f,value,'transport-state',[f.employeeUserId],[]);
  expect(await deliverAutomationEmails(runtime(f),port,async()=>({outcome:'skipped',error:'relayUnavailable'}))).toMatchObject({attempted:1,held:1});expect((await deliveries(f))[0]).toMatchObject({status:'queued',error_code:'relayUnavailable'});
  expect(await deliverAutomationEmails(runtime(f),port,async()=>{throw Error('Held message is not due.');})).toMatchObject({attempted:0});await owner.db.execute(sql`update automation_email_delivery set next_attempt_at=now() where tenant_id=${f.base.tenantId}::uuid`);
  let requests=0;expect(await deliverAutomationEmails(runtime(f),port,async request=>{requests++;const mail=await target(request);expect(mail).not.toBeNull();expect(await start(request,mail!)).toBe(true);throw Error('Private sender lost its post-SMTP receipt.');})).toMatchObject({attempted:1,held:1});
  expect(requests).toBe(1);expect((await deliveries(f))[0]).toMatchObject({status:'uncertain',error_code:'uncertain'});expect(await deliverAutomationEmails(runtime(f),port,async()=>{throw Error('An uncertain message cannot be replayed.');})).toMatchObject({attempted:0});
  await expect(owner.db.execute(sql`update automation_email_delivery set started_at=null where tenant_id=${f.base.tenantId}::uuid and mail_key='transport-state:0'`)).rejects.toThrow();
 },90000);
});
