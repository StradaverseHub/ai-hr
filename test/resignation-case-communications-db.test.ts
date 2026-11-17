/** Real service ownership and immutable actor-only message tests; no SMTP or transport mocking. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant} from '../db/client';
import {migrateTestDb,resetDb,closeAll,owner} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney} from '../packs/lifecycle/service';
import {resignationCaseCommunications,requestResignationMessageTest} from '../core/resignation-communications';
import {prepareResignationProofTx} from '../core/resignation-proof';
import type {Template} from '../lib/lifecycle-v9-model';
const origin='https://case-message.example.test';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
async function fixture(requiredFile=false,attachedLetter=false){
 const f=await resignationJourneyFixture({origin}),templateId=randomUUID(),emailId=randomUUID();
 const template:Template={id:templateId,name:'Acceptance for message inspection',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'none',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',fields:[],blocks:[{id:'body',type:'text',text:'Dear {employee.name}.',section:'main'},{id:'sign',type:'signature',text:'',role:'step:sign',section:'main'}],routing:[{id:'owner',order:1,action:'review',who:{kind:'people',userIds:[f.managerUserId]},owner:true},{id:'sign',order:2,action:'sign',who:{kind:'people',userIds:[f.fyiUserId]},owner:false}]}]};
 f.config.templates.push(template);f.config.emails.push({id:emailId,name:'Acceptance message',module:'off',active:true,sender:'noreply',subject:'Hello {{employee.name}}',body:'Your case is {{resignation.caseId}}.',cc:[],links:[],attachments:attachedLetter?[templateId]:[],slots:requiredFile?[{id:'evidence',label:'Handover evidence',required:true}]:[],files:[],images:[]});
 await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
 await f.workflow('accepted',[{id:'letter',type:'generateDocument',to:[],cc:[],conditions:[],params:{letterTemplateId:templateId}},{id:'email',type:'sendEmail',to:[{kind:'role',role:'employee'}],cc:[{kind:'person',userId:f.fyiUserId}],conditions:[],params:{emailTemplateId:emailId}}]);
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
  const f=await fixture(),request=randomUUID(),mail={subject:'Hello Journey employee',body:'Your case is '+f.current.number+'.',content:{number:f.current.number,emailTemplateId:randomUUID(),documents:[],pdfDocumentIds:[],linkDocumentIds:[],assets:[],files:[]},holds:[]};
  await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.resignation_communication_test_begin(${f.current.id}::uuid,${f.messages.revision},${f.item.runId}::uuid,'email',${request}::uuid,null,${JSON.stringify(mail)}::jsonb)`))).rejects.toThrow();
  await expect(withTenant(f.admin,async tx=>{await prepareResignationProofTx(tx,f.admin,{operation:'context',caseId:f.current.id,args:{mode:'communicationTest',caseId:f.current.id,revision:f.messages.revision,runId:f.item.runId,stepId:'email',requestId:request,offboardingCaseId:null,mail}});await tx.execute(sql`select app.resignation_communication_test_begin(${f.current.id}::uuid,${f.messages.revision},${f.item.runId}::uuid,'email',${request}::uuid,null,${JSON.stringify(mail)}::jsonb)`);await tx.execute(sql`select app.resignation_communication_test_queue(${f.current.id}::uuid,${f.messages.revision},${f.item.runId}::uuid,'email',${request}::uuid,${JSON.stringify({...mail,body:'Swapped'})}::jsonb)`);})).rejects.toThrow();
  expect(await owner.db.execute(sql`select request_id from resignation_communication_test`)).toEqual([]);
 },90000);
});
