/** Actual immutable email/Form creation; private SMTP helpers verify real lease/origin/document capability without tenant/user GUC. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {migrateTestDb,closeAll,owner,createAppUser} from './harness';
import {fixture,finish,visible,actForm} from './helpers/contract-document-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {startContractSharedManualWorkflow} from '../core/contract-shared-manual';
import {readContractSharedForm} from '../core/contract-shared-form';
import {readContractSharedLetter,approveContractSharedPosting,contractSharedContext} from '../packs/contracts/service';
import {contractPostingFixture,releaseContractPosting} from './helpers/contract-posting-fixture';
import type {Field} from '../lib/lifecycle-v9-model';
import {automationEmailBodyDoc} from '../lib/automation/email';
beforeAll(migrateTestDb);afterAll(closeAll);
const origin='https://fictional-native-form.example.test';
async function emailForm(bank:string|null,base?:Awaited<ReturnType<typeof contractPostingFixture>>){
 const f=base??await fixture('renew'),userId=base?.employeeActor.userId??await createAppUser(f.b.tenantId,f.employee.personId,'employee');
 const employee:SessionContext={...f.admin,userId,personId:f.employee.personId,roles:['employee'],grants:undefined};
 for(const user of [userId,f.admin.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${f.b.tenantId+'/'+user},${user}::uuid)`);
 await owner.db.execute(sql`insert into employee_statutory_my(tenant_id,person_id,ic_number,bank_account_no) values(${f.b.tenantId}::uuid,${f.employee.personId}::uuid,'990101011234',${bank})`);
 const templateId=randomUUID(),emailId=randomUUID(),workflowId=randomUUID();
 const fields:Field[]=[{id:'ic',label:'Published identity',type:'text',owner:'pmLocked',pmKey:'icNo',required:true,sensitive:true,options:[],section:'main',when:null},{id:'bank',label:'Published bank',type:'text',owner:'pmLocked',pmKey:'bankAcc',required:true,sensitive:true,options:[],section:'main',when:null}];
 await saveAutomationDocumentTemplate(f.admin,{template:{id:templateId,module:'contract_staff',name:'Employee-only native Form',description:'Fictional private readiness fixture',rules:{},blocks:[{id:'intro',type:'text',text:'For {Full name}.',section:''},{id:'fields',type:'fields',text:'',section:'main'}],fields,routing:[{id:'employee',order:1,action:'sign',owner:true,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
 await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Native predecision Form email',active:true,subject:'Your Form',body:'Open your assigned Form: {case.link}',bodyDoc:automationEmailBodyDoc({body:'Open your assigned Form: {case.link}'}),cc:[],documentIds:[templateId]},expectedRevision:0,retired:false,reason:'Fictional canonical source'});
 await saveAutomationWorkflow(f.admin,{workflow:{id:workflowId,module:'contract_staff',name:'Native manual Form',description:'',status:'live',required:false,trigger:{event:'manual',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'email',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:0,reason:'Actual immutable email and document pin'});
 const started=await startContractSharedManualWorkflow(f.admin,{caseId:f.caseId,revision:1,workflowId,workflowRevision:1,requestId:randomUUID()});await finish(started.jobId,f.admin,'contract_automation');
 const [letter]=await owner.db.execute<{id:string;revision:number}>(sql`select id,decision_revision as revision from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and purpose='email'`);expect(letter.revision).toBe(0);
 const [pin]=await owner.db.execute<{id:string;documents:Record<string,string>}>(sql`select id,documents from contract_shared_email_document_step where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);expect(pin.documents[templateId]).toBe(letter.id);
 return {...f,employee,letterId:letter.id,emailId,pinId:pin.id};
}
describe('native Employee-only Form prerequisites',()=>{
 it('resolves a corrected selected Personnel field without requiring a Form read or fabricated action',async()=>{
  const f=await emailForm(null);
  const before=await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true)`;return (await tx<{ready:{ready:boolean;reason:string}}[]>`select app.contract_shared_email_document_readiness(${f.letterId}::uuid) as ready`)[0].ready;});expect(before).toMatchObject({ready:false,reason:'hr_steps'});
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-CORRECTED-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
  const after=await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true)`;return (await tx<{ready:{ready:boolean;reason:string}}[]>`select app.contract_shared_email_document_readiness(${f.letterId}::uuid) as ready`)[0].ready;});expect(after).toEqual({ready:true,reason:'employee'});
  const [run]=await owner.db.execute<{waiting:string}>(sql`select waiting_for as waiting from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid and waiting_for=${f.pinId}::uuid`);expect(run.waiting).toBe(f.pinId);
 },120000);
 it('keeps the original predecision Form independent after actual approved posting closes the business case',async()=>{
  const posting=await contractPostingFixture({payChanges:false}),f=await emailForm('FICTIONAL-ORIGINAL-PERIOD-BANK',posting);
  const original=await readContractSharedLetter(f.employee,f.letterId),before=visible(await readContractSharedForm(f.employee,f.letterId));expect(before.values.bank).toBe('FICTIONAL-ORIGINAL-PERIOD-BANK');
  const nativePosting=await releaseContractPosting(posting);await approveContractSharedPosting(posting.approver,{id:nativePosting.id,revision:nativePosting.revision});
  const closed=await contractSharedContext(posting.proposer,posting.caseId);expect(closed.flow?.stage).toBe('renewed');
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-NEW-PERIOD-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
  const historical=visible(await readContractSharedForm(f.employee,f.letterId));expect(historical.values.bank).toBe('FICTIONAL-ORIGINAL-PERIOD-BANK');expect((await readContractSharedLetter(f.employee,f.letterId)).body?.values).not.toHaveProperty('contract.newStart',posting.newStart);
  await actForm(f.employee,f.letterId,'signed');expect((await readContractSharedLetter(f.employee,f.letterId)).state).toBe('released');
  const after=await contractSharedContext(posting.proposer,posting.caseId);expect(after.flow).toEqual(closed.flow);
  const [source]=await owner.db.execute<{revision:number;pinRevision:number}>(sql`select letter.decision_revision as revision,pin.decision_revision as "pinRevision" from contract_shared_letter letter join contract_shared_email_document_step pin on pin.tenant_id=letter.tenant_id and pin.case_id=letter.case_id and pin.documents->>(letter.data->>'templateId')=letter.id::text where letter.tenant_id=${f.b.tenantId}::uuid and letter.id=${f.letterId}::uuid`);expect(source).toEqual({revision:0,pinRevision:0});expect(original.body?.definition.fields).toHaveLength(2);
 },120000);
 it('rechecks current source after queue without tenant scope, and respects actual first-signature freezing',async()=>{
  const f=await emailForm('FICTIONAL-INITIAL-BANK');
  const [delivery]=await owner.db.execute<{id:string}>(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${f.emailId}`);expect(delivery).toBeTruthy();const token=randomUUID();
  await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '2 minutes' where id=${delivery.id}::uuid`);
  const readiness=async()=>{const [row]=await owner.client<{ready:{ready:boolean;reason:string};tenant:string|null;actor:string|null}[]>`select app.contract_shared_email_document_readiness(${delivery.id}::uuid,${token}::uuid,${origin},${f.letterId}::uuid) as ready,app.current_tenant_id() as tenant,app.current_user_id() as actor`;expect(row.tenant).toBeNull();expect(row.actor).toBeNull();return row.ready;};
  expect(await readiness()).toEqual({ready:true,reason:'employee'});
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no=null where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);expect(await readiness()).toMatchObject({ready:false,reason:'hr_steps'});
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-ACTUAL-SIGNED-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);expect(await readiness()).toEqual({ready:true,reason:'employee'});
  await actForm(f.employee,f.letterId,'signed');expect((await readContractSharedLetter(f.employee,f.letterId)).state).toBe('released');
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-LATER-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);expect(visible(await readContractSharedForm(f.employee,f.letterId)).values.bank).toBe('FICTIONAL-ACTUAL-SIGNED-BANK');
  expect(await readiness()).toEqual({ready:true,reason:'released'});
  await expect(withTenant(f.employee,tx=>tx.execute(sql`select app.document_merge_values_my(${f.b.tenantId}::uuid,${f.employee.personId}::uuid,ARRAY['bankAcc'])`))).rejects.toThrow();
 },120000);
});
