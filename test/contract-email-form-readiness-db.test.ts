/** Actual immutable email/Form creation; private SMTP helpers verify real lease/origin/document capability without tenant/user GUC. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {migrateTestDb,closeAll,owner,createAppUser,setModule,entitledCtx} from './harness';
import {fixture,finish,visible,actForm,submit} from './helpers/contract-document-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {startContractSharedManualWorkflow} from '../core/contract-shared-manual';
import {readContractSharedForm} from '../core/contract-shared-form';
import {readContractSharedLetter,contractSharedContext,actContractSharedLetter,contractAutomationJobHandler} from '../packs/contracts/service';
import {contractPostingFixture,releaseContractPosting,approveAppliedContractPosting} from './helpers/contract-posting-fixture';
import type {Field} from '../lib/lifecycle-v9-model';
import {createPosition} from '../core/admin';
import {setEmploymentAssignment} from '../core/org';
import {setCompensation} from '../core/comp';
import {todayInKualaLumpur} from '../lib/hr-date';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {automationEmailBodyDoc} from '../lib/automation/email';
beforeAll(migrateTestDb);afterAll(closeAll);
const origin='https://fictional-native-form.example.test';
async function emailForm(bank:string|null,base?:Awaited<ReturnType<typeof contractPostingFixture>>|Awaited<ReturnType<typeof fixture>>,options:{extraFields?:Field[];expectedDecisionRevision?:number;ordinary?:boolean}={}){
 const f=base??await fixture('renew'),userId=base&&'employeeActor' in base?base.employeeActor.userId!:await createAppUser(f.b.tenantId,f.employee.personId,'employee');
 const employeeActor:SessionContext={...f.admin,userId,personId:f.employee.personId,roles:['employee'],grants:undefined};
 for(const user of [userId,f.admin.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${f.b.tenantId+'/'+user},${user}::uuid)`);
 await owner.db.execute(sql`insert into employee_statutory_my(tenant_id,person_id,ic_number,bank_account_no) values(${f.b.tenantId}::uuid,${f.employee.personId}::uuid,'990101011234',${bank})`);
 const templateId=randomUUID(),emailId=randomUUID(),workflowId=randomUUID();
 const fields:Field[]=[{id:'ic',label:'Published identity',type:'text',owner:'pmLocked',pmKey:'icNo',required:true,sensitive:true,options:[],section:'main',when:null},{id:'bank',label:'Published bank',type:'text',owner:'pmLocked',pmKey:'bankAcc',required:true,sensitive:true,options:[],section:'main',when:null},...(options.extraFields??[])];
 await saveAutomationDocumentTemplate(f.admin,{template:{id:templateId,module:'contract_staff',name:'Employee-only native Form',description:'Fictional private readiness fixture',rules:{},blocks:[{id:'intro',type:'text',text:'For {Full name}. Original {contract.start} to {contract.end}. Decision {decision.type} {contract.newStart}.',section:''},...(options.ordinary?[]:[{id:'fields',type:'fields' as const,text:'',section:'main'}])],fields:options.ordinary?[]:fields,routing:[{id:'employee',order:1,action:'sign',owner:true,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
 await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Native predecision Form email',active:true,subject:'Your Form',body:'Open your assigned Form: {case.link}',bodyDoc:automationEmailBodyDoc({body:'Open your assigned Form: {case.link}'}),cc:[],documentIds:[templateId]},expectedRevision:0,retired:false,reason:'Fictional canonical source'});
 await saveAutomationWorkflow(f.admin,{workflow:{id:workflowId,module:'contract_staff',name:'Native manual Form',description:'',status:'live',required:false,trigger:{event:'manual',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'email',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:0,reason:'Actual immutable email and document pin'});
 const started=await startContractSharedManualWorkflow(f.admin,{caseId:f.caseId,revision:(await contractSharedContext(f.admin,f.caseId)).flow!.revision,workflowId,workflowRevision:1,requestId:randomUUID()});if(bank===null){
  let waiting=false;
  for(let n=0;n<100;n++){
   const [run]=await owner.db.execute<{waiting:boolean}>(sql`select true as waiting from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid and workflow_id=${workflowId}::uuid and status='waiting'`);
   if(run?.waiting){waiting=true;break;}
   await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]});
  }
  expect(waiting).toBe(true); // This is a genuine prerequisite hold, not a completed job.
 }else await finish(started.jobId,f.admin,'contract_automation');
 const [letter]=await owner.db.execute<{id:string;revision:number}>(sql`select id,decision_revision as revision from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and purpose='email'`);expect(letter.revision).toBe(options.expectedDecisionRevision??0);
 const [pin]=await owner.db.execute<{id:string;documents:Record<string,string>}>(sql`select id,documents from contract_shared_email_document_step where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);expect(pin.documents[templateId]).toBe(letter.id);
 return {...f,employeeActor,letterId:letter.id,emailId,pinId:pin.id,manualJobId:started.jobId};
}
describe('native Employee-only Form prerequisites',()=>{
 it('resolves a corrected selected Personnel field without requiring a Form read or fabricated action',async()=>{
  const f=await emailForm(null);
  const before=await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true)`;return (await tx<{ready:{ready:boolean;reason:string}}[]>`select app.contract_shared_email_document_readiness(${f.letterId}::uuid) as ready`)[0].ready;});expect(before).toMatchObject({ready:false,reason:'hr_steps'});
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-CORRECTED-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
  const after=await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true)`;return (await tx<{ready:{ready:boolean;reason:string}}[]>`select app.contract_shared_email_document_readiness(${f.letterId}::uuid) as ready`)[0].ready;});expect(after).toEqual({ready:true,reason:'employee'});
  const [run]=await owner.db.execute<{waiting:string}>(sql`select waiting_for as waiting from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid and waiting_for=${f.pinId}::uuid`);expect(run.waiting).toBe(f.pinId);
 },120000);
 it('uses the same live native Position and Payroll source for routed and verified unscoped defaults, then freezes at signature',async()=>{
  const base=await fixture('renew'),today=todayInKualaLumpur(),first=await createPosition(base.admin,{companyId:base.b.companyId,title:'Fictional initial native Position'}),second=await createPosition(base.admin,{companyId:base.b.companyId,title:'Fictional corrected native Position'});
  await setEmploymentAssignment(base.admin,{employmentId:base.employee.employmentId,effectiveDate:today,positionId:first.id});await setCompensation(base.admin,{employmentId:base.employee.employmentId,basicSalary:4100.25,effectiveFrom:today});await submit(base,'renew');
  const field={owner:'pmLocked' as const,type:'text' as const,required:true,sensitive:false,options:[],section:'main',when:null};
  const f=await emailForm('FICTIONAL-BANK',base,{expectedDecisionRevision:1,extraFields:[{...field,id:'position',label:'Position',pmKey:'employee.position'},{...field,id:'pay',label:'Current salary',pmKey:'contract.salary'}]});
  expect(visible(await readContractSharedForm(f.employeeActor,f.letterId)).values).toMatchObject({position:'Fictional initial native Position',pay:'4100.25'});
  const [delivery]=await owner.db.execute<{id:string}>(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${f.emailId}`);expect(delivery).toBeTruthy();const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '2 minutes' where id=${delivery.id}::uuid`);
  const readiness=async()=>(await owner.client<{ready:{ready:boolean}}[]>`select app.contract_shared_email_document_readiness(${delivery.id}::uuid,${token}::uuid,${origin},${f.letterId}::uuid) as ready`)[0].ready.ready;
  await setEmploymentAssignment(f.admin,{employmentId:f.employee.employmentId,effectiveDate:today,positionId:null});expect(await readiness()).toBe(false);
  await setEmploymentAssignment(f.admin,{employmentId:f.employee.employmentId,effectiveDate:today,positionId:second.id});await setCompensation(f.admin,{employmentId:f.employee.employmentId,basicSalary:5200.75,effectiveFrom:today});expect(await readiness()).toBe(true);
  expect(visible(await readContractSharedForm(f.employeeActor,f.letterId)).values).toMatchObject({position:'Fictional corrected native Position',pay:'5200.75'});expect((await readContractSharedLetter(f.employeeActor,f.letterId)).body?.values).toMatchObject({'employee.jobTitle':'Fictional corrected native Position','contract.salary':'5200.75'});
  await actForm(f.employeeActor,f.letterId,'signed');await setEmploymentAssignment(f.admin,{employmentId:f.employee.employmentId,effectiveDate:today,positionId:first.id});await setCompensation(f.admin,{employmentId:f.employee.employmentId,basicSalary:6300.99,effectiveFrom:today});
  expect(visible(await readContractSharedForm(f.employeeActor,f.letterId)).values).toMatchObject({position:'Fictional corrected native Position',pay:'5200.75'});
 },120000);
 it('denies an actual assigned ordinary email Letter action when only another company retains Lifecycle',async()=>{
  const f=await emailForm('FICTIONAL-BANK',undefined,{ordinary:true}),before=await readContractSharedLetter(f.employeeActor,f.letterId);expect(before.pendingAction?.kind).toBe('sign');
  const [companyB]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${f.b.tenantId}::uuid,'Fictional unrelated Lifecycle B') returning id`);
  await setModule(f.b.tenantId,'lifecycle',null);await setModule(f.b.tenantId,'lifecycle','active',companyB.id);const actor={...f.employeeActor,entitlements:(await entitledCtx(f.b)).entitlements};
  const [native]=await withTenant(actor,tx=>tx.execute<{a:boolean;b:boolean;canSign:boolean}>(sql`select app.contract_company_entitled(${f.b.companyId}::uuid) as a,app.contract_company_entitled(${companyB.id}::uuid) as b,app.document_signing_subject_access('contract',${f.letterId}::uuid,'sign') as "canSign"`));expect(native).toEqual({a:false,b:true,canSign:false});
  await expect(actContractSharedLetter(actor,{id:f.letterId,actionId:randomUUID(),stepId:before.pendingAction!.stepId,revision:before.contentRevision,hash:before.contentHash!,action:'signed',method:'typed',value:'Fictional employee',consent:true})).rejects.toThrow();
  await setModule(f.b.tenantId,'lifecycle','active',f.b.companyId);const restored={...f.employeeActor,entitlements:(await entitledCtx(f.b)).entitlements};const after=await readContractSharedLetter(restored,f.letterId);expect(after.pendingAction?.kind).toBe('sign');expect(after.history).toEqual(before.history);
 },120000);
 it('keeps the original predecision Form independent after actual approved posting closes the business case',async()=>{
  const posting=await contractPostingFixture({payChanges:false}),f=await emailForm(null,posting);
  const original=await readContractSharedLetter(f.employeeActor,f.letterId),before=visible(await readContractSharedForm(f.employeeActor,f.letterId));expect(before.values.bank).toBe('');expect(original.body?.values).toMatchObject({'contract.start':posting.start,'contract.end':posting.end,'contract.newStart':''});expect(original.body?.values).not.toHaveProperty('decision.type','Renew');
  const nativePosting=await releaseContractPosting(posting);await approveAppliedContractPosting(posting.approver,{id:nativePosting.id,revision:nativePosting.revision});
  const closed=await contractSharedContext(posting.proposer,posting.caseId);expect(closed.flow?.stage).toBe('renewed');
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-NEW-PERIOD-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
  const historical=visible(await readContractSharedForm(f.employeeActor,f.letterId));expect(historical.values.bank).toBe('FICTIONAL-NEW-PERIOD-BANK');const held=await readContractSharedLetter(f.employeeActor,f.letterId);expect(held.body?.values).toMatchObject({'contract.start':posting.start,'contract.end':posting.end,'contract.newStart':''});expect(held.body?.values).not.toHaveProperty('decision.type','Renew');
  await actForm(f.employeeActor,f.letterId,'signed');expect((await readContractSharedLetter(f.employeeActor,f.letterId)).state).toBe('released');await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-LATER-UNSIGNED-SOURCE' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);expect(visible(await readContractSharedForm(f.employeeActor,f.letterId)).values.bank).toBe('FICTIONAL-NEW-PERIOD-BANK');
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
  await actForm(f.employeeActor,f.letterId,'signed');expect((await readContractSharedLetter(f.employeeActor,f.letterId)).state).toBe('released');
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-LATER-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);expect(visible(await readContractSharedForm(f.employeeActor,f.letterId)).values.bank).toBe('FICTIONAL-ACTUAL-SIGNED-BANK');
  expect(await readiness()).toEqual({ready:true,reason:'released'});
  await expect(withTenant(f.employeeActor,tx=>tx.execute(sql`select app.document_merge_values_my(${f.b.tenantId}::uuid,${f.employee.personId}::uuid,ARRAY['bankAcc'])`))).rejects.toThrow();
 },120000);
});
