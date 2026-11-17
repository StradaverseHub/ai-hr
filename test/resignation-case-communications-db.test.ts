/** Real service ownership and immutable actor-only message tests; no SMTP or transport mocking. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant} from '../db/client';
import {migrateTestDb,resetDb,closeAll,owner,createAppUser} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney} from '../packs/lifecycle/service';
import {resignationCaseCommunications,resignationOffboardingCommunications,requestResignationMessageTest} from '../core/resignation-communications';
import {prepareResignationProofTx} from '../core/resignation-proof';
import type {Template} from '../lib/lifecycle-v9-model';
const origin='https://case-message.example.test';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
async function fixture(requiredFile=false,attachedLetter=false){
 const f=await resignationJourneyFixture({origin}),templateId=randomUUID(),emailId=randomUUID();
 const template:Template={id:templateId,name:'Acceptance for message inspection',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'none',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',fields:[],blocks:[{id:'body',type:'text',text:'Dear {employee.name}.',section:'main'},{id:'sign',type:'signature',text:'',role:'step:sign',section:'main'}],routing:[{id:'owner',order:1,action:'review',who:{kind:'people',userIds:[f.managerUserId]},owner:true},{id:'sign',order:2,action:'sign',who:{kind:'people',userIds:[f.fyiUserId]},owner:false}]}]};
 f.config.templates.push(template);f.config.emails.push({id:emailId,name:'Acceptance message',module:'off',active:true,sender:'noreply',subject:'Hello {{employee.name}}',body:'Your case is {{resignation.caseId}}.',cc:[],links:[],attachments:attachedLetter?[templateId]:[],slots:requiredFile?[{id:'evidence',label:'Handover evidence',required:true}]:[],files:[],images:[]});
 await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
 await f.workflow('accepted',[{id:'start',type:'startOffboarding',to:[],cc:[],conditions:[],params:{exitReason:'Resignation'}},{id:'letter',type:'generateDocument',to:[],cc:[],conditions:[],params:{letterTemplateId:templateId}},{id:'email',type:'sendEmail',to:[{kind:'role',role:'employee'}],cc:[{kind:'person',userId:f.fyiUserId}],conditions:[],params:{emailTemplateId:emailId}}]);
 const current=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}});
 await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.base.tenantId},${randomUUID()},${f.managerUserId}::uuid)`);
 const messages=await resignationCaseCommunications(f.admin,{caseId:current.id});expect(messages.items).toHaveLength(1);
 return{...f,current,messages,item:messages.items[0]};
}
describe('managed case message inspection and actor-only test intents',()=>{
 it('resolves actual case fields and names, queues one actor-only test, and preserves normal recipients and case state',async()=>{
  const f=await fixture(),input={caseId:f.current.id,revision:f.messages.revision,runId:f.item.runId,stepId:f.item.stepId,requestId:randomUUID()};
  expect(f.item.subject).toBe('Hello Journey employee');expect(f.item.to).toEqual(['Journey employee']);expect(f.item.cc).toEqual(['Journey business partner']);expect(f.item.editable).toBe(true);expect(JSON.stringify(f.item)).not.toContain('releasedDocuments');
  const [before]=await owner.db.execute<{data:unknown;revision:number}>(sql`select data,revision from resignation_journey where id=${f.current.id}::uuid`);
  expect(await requestResignationMessageTest(f.admin,input)).toEqual({requestId:input.requestId,status:'queued',replayed:false});expect(await requestResignationMessageTest(f.admin,input)).toMatchObject({replayed:true});
  const mail=await owner.db.execute<{payload:{mail:{to:string[];cc:string[];subject:string}}}>(sql`select payload from automation_email_delivery where tenant_id=${f.base.tenantId}::uuid and mail_key like 'case-test:%'`);expect(mail).toHaveLength(1);expect(mail[0].payload.mail).toMatchObject({to:[f.managerUserId],cc:[],subject:'[Test] Hello Journey employee'});
  const [after]=await owner.db.execute<{data:unknown;revision:number}>(sql`select data,revision from resignation_journey where id=${f.current.id}::uuid`);expect(after).toEqual(before);
  await expect(requestResignationMessageTest(f.admin,{...input,revision:input.revision+1})).rejects.toMatchObject({code:'conflict'});
  await expect(withTenant(f.admin,tx=>tx.execute(sql`select * from resignation_communication_test`))).rejects.toThrow();
 },90000);
 it('does not grant a future signer, employee or another tenant private preview/test authority',async()=>{
  const f=await fixture(),input={caseId:f.current.id,revision:f.messages.revision,runId:f.item.runId,stepId:f.item.stepId,requestId:randomUUID()};
  expect((await resignationCaseCommunications(f.watcher,{caseId:f.current.id})).items).toEqual([]);expect((await resignationCaseCommunications(f.staff,{caseId:f.current.id})).items).toEqual([]);
  await expect(requestResignationMessageTest(f.watcher,input)).rejects.toMatchObject({code:'forbidden'});await expect(requestResignationMessageTest(f.staff,input)).rejects.toMatchObject({code:'forbidden'});
  const foreign=await resignationJourneyFixture();await expect(requestResignationMessageTest(foreign.admin,input)).rejects.toMatchObject({code:'forbidden'});
  expect(await owner.db.execute(sql`select request_id from resignation_communication_test`)).toEqual([]);
 },90000);
 it.each([{requiredFile:true,attachedLetter:false,hold:'Upload Handover evidence'},{requiredFile:false,attachedLetter:true,hold:'signed and released'}])('retains required file and unsigned attachment holds: $hold',async opts=>{
  const f=await fixture(opts.requiredFile,opts.attachedLetter);expect(f.item.holds.join(' ')).toContain(opts.hold);
  await expect(requestResignationMessageTest(f.admin,{caseId:f.current.id,revision:f.messages.revision,runId:f.item.runId,stepId:f.item.stepId,requestId:randomUUID()})).rejects.toMatchObject({code:'invalid'});
  expect(await owner.db.execute(sql`select request_id from resignation_communication_test`)).toEqual([]);
 },90000);
 it('requires exact native signed context and refuses a swapped payload after admission',async()=>{
  const f=await fixture(),request=randomUUID(),mail={subject:'Hello Journey employee',body:'Your case is '+f.current.number+'.',content:{number:f.current.number,emailTemplateId:f.item.emailTemplateId,documents:[],pdfDocumentIds:[],linkDocumentIds:[],assets:[],files:[]},holds:[]};
  await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.resignation_communication_test_begin(${f.current.id}::uuid,${f.messages.revision},${f.item.runId}::uuid,'email',${request}::uuid,null,${JSON.stringify(mail)}::jsonb)`))).rejects.toThrow();
  await expect(withTenant(f.admin,async tx=>{await prepareResignationProofTx(tx,f.admin,{operation:'context',caseId:f.current.id,args:{mode:'communicationTest',caseId:f.current.id,revision:f.messages.revision,runId:f.item.runId,stepId:'email',requestId:request,offboardingCaseId:null,mail}});await tx.execute(sql`select app.resignation_communication_test_begin(${f.current.id}::uuid,${f.messages.revision},${f.item.runId}::uuid,'email',${request}::uuid,null,${JSON.stringify(mail)}::jsonb)`);await tx.execute(sql`select app.resignation_communication_test_queue(${f.current.id}::uuid,${f.messages.revision},${f.item.runId}::uuid,'email',${request}::uuid,${JSON.stringify({...mail,body:'Swapped'})}::jsonb)`);})).rejects.toThrow();
  expect(await owner.db.execute(sql`select request_id from resignation_communication_test`)).toEqual([]);
 },90000);
});

it('rejects expired context custody before test admission and fails closed after the actor identity changes',async()=>{
 const f=await fixture(),request=randomUUID();
 const{signResignationRuntime}=await import('../lib/resignation-runtime-proof');
 await expect(withTenant(f.admin,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select txid_current()::text as id`);const proof=signResignationRuntime({operation:'context',caseId:f.current.id,args:{}},{tenantId:f.base.tenantId,userId:f.admin.userId!,personId:f.admin.personId!,transactionId:row.id},'a'.repeat(64),Date.now()-120000);await tx.execute(sql`select app.resignation_journey_admit(${proof.payload},${proof.signature})`);})).rejects.toThrow();
 await owner.db.execute(sql`update app_user set person_id=null where tenant_id=${f.base.tenantId}::uuid and id=${f.managerUserId}::uuid`);
 await expect(requestResignationMessageTest(f.admin,{caseId:f.current.id,revision:f.messages.revision,runId:f.item.runId,stepId:f.item.stepId,requestId:request})).rejects.toMatchObject({code:'forbidden'});
 expect(await owner.db.execute(sql`select request_id from resignation_communication_test`)).toEqual([]);
},90000);


it('admits an actual reverse-bound native Offboarding operator without journey participation or raw file access',async()=>{
 const f=await fixture(),operatorId=await createAppUser(f.base.tenantId,f.fyi.personId,'hr_admin');
 const operator={...f.admin,userId:operatorId,personId:f.fyi.personId};
 await owner.db.execute(sql`update lc_onboarding_config set data=jsonb_set(data,'{access,offboarding}',(data->'access'->'offboarding')||${JSON.stringify([operatorId])}::jsonb) where tenant_id=${f.base.tenantId}::uuid`);
 const [before]=await owner.db.execute<{participants:string[]}>(sql`select participant_ids as participants from resignation_journey where id=${f.current.id}::uuid`);expect(before.participants).not.toContain(operatorId);expect(f.current.offboardingCaseId).toBeTruthy();
 // An unreached private letter confers no message preview merely through the HR role.
 const current=await resignationOffboardingCommunications(operator,f.current.offboardingCaseId!);expect(current?.items).toEqual([]);
 let released=await commandResignationJourney(f.admin,{caseId:f.current.id,revision:f.current.revision,command:{type:'letterAction',documentId:f.current.letters[0].id,documentRevision:f.current.letters[0].revision,action:'review'}});
 released=await commandResignationJourney(f.watcher,{caseId:released.id,revision:released.revision,command:{type:'openLetter',documentId:released.letters[0].id,documentRevision:released.letters[0].revision}});
 released=await commandResignationJourney(f.watcher,{caseId:released.id,revision:released.revision,command:{type:'letterAction',documentId:released.letters[0].id,documentRevision:released.letters[0].revision,action:'sign',signature:'Journey business partner',consent:true}});
 const visible=await resignationOffboardingCommunications(operator,f.current.offboardingCaseId!);expect(visible?.items).toHaveLength(1);expect(visible?.items[0].subject).toBe('Hello Journey employee');expect(JSON.stringify(visible)).not.toContain('retention.salary');
 await owner.db.execute(sql`update app_user set person_id=${f.manager.personId}::uuid where tenant_id=${f.base.tenantId}::uuid and id=${f.employeeUserId}::uuid`);
 const [relinked]=await withTenant({...f.staff,personId:f.manager.personId},tx=>tx.execute<{scope:{visible:boolean}}>(sql`select app.resignation_communication_scope(${f.current.id}::uuid,${f.item.runId}::uuid,null) as scope`));expect(relinked.scope.visible).toBe(false);

 await expect(withTenant(operator,tx=>tx.execute(sql`select content from resignation_journey_file where case_id=${f.current.id}::uuid`))).resolves.toEqual([]);
 await expect(resignationOffboardingCommunications(operator,randomUUID())).resolves.toBeNull();
},90000);

it('preserves account-only submitted-decision message authority without granting letter authority',async()=>{
 const f=await resignationJourneyFixture({origin,accountOnlyDecisionMaker:true,decisionWorkflow:false}),emailId=randomUUID();
 f.config.emails.push({id:emailId,name:'Submitted message',module:'off',active:true,sender:'noreply',subject:'Submitted {{employee.name}}',body:'Please record the decision.',cc:[],links:[],attachments:[],slots:[]});
 await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
 await f.workflow('submitted',[{id:'email',type:'sendEmail',to:[{kind:'role',role:'employee'}],cc:[],conditions:[],params:{emailTemplateId:emailId}},{id:'decision',type:'requestDecision',to:[{kind:'person',userId:f.managerUserId}],cc:[],conditions:[],params:{choices:'both',watch:[],canComment:true}}]);
 const repaired=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'runWorkflowsAgain'}});const messages=await resignationCaseCommunications(f.admin,{caseId:repaired.id});expect(messages.items).toHaveLength(1);expect(messages.items[0].subject).toBe('Submitted Journey employee');
 await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.base.tenantId},${randomUUID()},${f.managerUserId}::uuid)`);
 expect(await requestResignationMessageTest(f.admin,{caseId:repaired.id,revision:messages.revision,runId:messages.items[0].runId,stepId:'email',requestId:randomUUID()})).toMatchObject({status:'queued'});
},90000);
