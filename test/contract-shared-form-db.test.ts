import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {adoptContractSharedCase,previewContractSharedDecision,submitContractSharedDecision,contractSharedContext,contractPreviewJobHandler,contractAutomationJobHandler,readContractSharedLetter,actContractSharedLetter} from '../packs/contracts/service';
import {readContractSharedForm,saveContractSharedForm,type ContractSharedForm} from '../core/contract-shared-form';
import {MY_DOCUMENT_MERGE_KEYS} from '../localization/my/document-merge';
import {requirePackFor} from '../localization/registry';
import type {Field} from '../lib/lifecycle-v9-model';
import {reservedSqlExecutor} from '../db/sql-executor';
import {recordDocumentSigningActionTx,replaceDocumentSignerTx} from '../packs/document-signing/service';
import {saveAutomationDocumentTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../packs/automation/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {readBulkJob} from '../core/bulk-job';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {pgSqlState} from '../lib/db-error';

import {recordSigningAction,type SigningDocument} from '../lib/document-signing-model';
import {fixture,formFixture,submit,letters,review,visible,saveAnswers,actForm} from './helpers/contract-document-fixture';
beforeAll(migrateTestDb);afterAll(closeAll);
describe('actual shared Contract Form owner',()=>{
 it('uses selected country fields, native ownership, scoped immutable signatures and strict released privacy',async()=>{
  const f=await formFixture();expect(requirePackFor('MY').documentMerge?.keys).toEqual(MY_DOCUMENT_MERGE_KEYS);
  expect(await readContractSharedForm(f.employeeActor,f.letterId)).toEqual({letterId:f.letterId,kind:'Form',visible:false});
  const initial=visible(await readContractSharedForm(f.admin,f.letterId));expect(initial.values).toMatchObject({lockedIC:'990101-01-1234',lockedBank:'FICTIONAL-BANK-001'});expect(initial.editableFieldIds).toEqual(['hrChoice']);
  const letter=await readContractSharedLetter(f.admin,f.letterId);expect(letter.body?.values).toMatchObject({'company.regNo':'FICTIONAL-REG','company.address':'Fictional Shared address','company.color':'#123456','decision.type':'Renew'});expect(letter.body?.values).not.toHaveProperty('contract.salary');
  await expect(saveAnswers(f.admin,f.letterId,{lockedIC:'forged'})).rejects.toThrow();await expect(saveAnswers(f.admin,f.letterId,{hrChoice:'Not an option'})).rejects.toThrow();
  expect(letter.body?.values).toHaveProperty('employee.name','Fictional ending subject');expect(initial.missingLockedFields).not.toContain('inactiveLocked');
  for(const [index,bank] of ['FICTIONAL-BANK-002','FICTIONAL-BANK-003'].entries()){
   await owner.db.execute(sql`update employee_statutory_my set bank_account_no=${bank} where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
   const live=await readContractSharedLetter(f.admin,f.letterId);expect(visible(await readContractSharedForm(f.admin,f.letterId)).values.lockedBank).toBe(bank);
   if(index===0)await withTenant(f.admin,tx=>tx.execute(sql`select app.contract_shared_letter_action_prepare(${f.letterId}::uuid,${live.pendingAction!.stepId},${randomUUID()},'reviewed','',${live.contentHash},${live.contentRevision},'null'::jsonb)`));
  }
  await expect(actForm(f.admin,f.letterId,'reviewed')).rejects.toThrow();await saveAnswers(f.admin,f.letterId,{hrChoice:'Yes'});await actForm(f.admin,f.letterId,'reviewed');
  const signed=await actForm(f.admin,f.letterId,'signed');expect(signed.valuesFixed).toBe(true);
  const before=visible(await readContractSharedForm(f.employeeActor,f.letterId));expect(before.editableFieldIds).toEqual(['employeeAck','employeeRows']);const hrReceipt=before.receipts.find(x=>x.scope==='hr')!;expect(hrReceipt.fieldIds).not.toContain('employeeAck');expect(hrReceipt.values).not.toHaveProperty('employeeAck');
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-LATER-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
  expect(visible(await readContractSharedForm(f.employeeActor,f.letterId)).values.lockedBank).toBe('FICTIONAL-BANK-003');await expect(saveAnswers(f.employeeActor,f.letterId,{hrChoice:'No'})).rejects.toThrow();
  await expect(actForm(f.employeeActor,f.letterId,'signed')).rejects.toThrow();await saveAnswers(f.employeeActor,f.letterId,{employeeAck:'true',employeeRows:'[["Fictional","Value"]]'});
  const employeeLetter=await readContractSharedLetter(f.employeeActor,f.letterId);
  const [signing]=await owner.db.execute<{id:string}>(sql`select signing_document_id as id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and id=${f.letterId}::uuid`);
  const [canonical]=await owner.db.execute<{data:SigningDocument}>(sql`select data from document_signing_document where tenant_id=${f.b.tenantId}::uuid and id=${signing.id}::uuid`);
  const forgedDirect=recordSigningAction(canonical.data,{requiredRoles:[]},{revision:canonical.data.contentRevision,hash:canonical.data.contentHash,id:randomUUID(),stepId:employeeLetter.pendingAction!.stepId,actorId:f.employeeActor.userId!,actorPersonId:f.employee.personId,actorName:'Fictional ending subject',action:'signed',method:'typed',value:'Fictional direct call',consent:true,at:new Date().toISOString()}).actions.at(-1)!;
  await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id',${f.employeeActor.userId!},true)`;const [guard]=await tx<{allowed:boolean}[]>`select app.document_signing_subject_action_allowed_before_forms('contract',${f.letterId}::uuid,${JSON.stringify(forgedDirect)}::jsonb) as allowed`;expect(guard.allowed).toBe(false);});
  await expect(owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id',${f.employeeActor.userId!},true)`;await tx`update document_signing_document set data=jsonb_set(data,'{actions}',(data->'actions')||${JSON.stringify([forgedDirect])}::jsonb) where tenant_id=${f.b.tenantId}::uuid and id=${signing.id}::uuid`;})).rejects.toThrow();
  await expect(withTenant(f.employeeActor,tx=>recordDocumentSigningActionTx(tx,f.employeeActor,{id:signing.id,actionId:randomUUID(),stepId:employeeLetter.pendingAction!.stepId,revision:employeeLetter.contentRevision,hash:employeeLetter.contentHash!,action:'signed',method:'typed',value:'Fictional direct call',consent:true}))).rejects.toThrow();
  const released=await actForm(f.employeeActor,f.letterId,'signed');expect(released.state).toBe('released');const final=visible(await readContractSharedForm(f.admin,f.letterId));expect(final.receipts.find(x=>x.actionId===hrReceipt.actionId)).toEqual(hrReceipt);expect(final.receipts.some(x=>x.scope==='employee')).toBe(true);
  const [evidence]=await owner.db.execute<{hash:string;form:unknown}>(sql`select fingerprint as hash,evidence->'form' as form from contract_shared_release_receipt where tenant_id=${f.b.tenantId}::uuid and letter_id=${f.letterId}::uuid`);expect(evidence.hash).toMatch(/^[a-f0-9]{64}$/);expect(evidence.form).toBeTruthy();
  const [viewerPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional case-only viewer',${randomUUID()+'@forms.test'}) returning id`);const viewerId=await createAppUser(f.b.tenantId,viewerPerson.id,'hr_admin');const viewer={...f.admin,userId:viewerId,personId:viewerPerson.id};
  expect(await withTenant(viewer,tx=>tx.execute(sql`select 1 where app.contract_shared_case_permitted(${f.caseId}::uuid,'view')`))).toHaveLength(1);
  expect(await readContractSharedForm(viewer,f.letterId)).toEqual({letterId:f.letterId,kind:'Form',visible:false});expect((await readContractSharedLetter(viewer,f.letterId)).body).toBeNull();
  const [personnel]=await owner.db.execute<{ended:string|null;counter:number}>(sql`select terminated_on::text as ended,contract_number as counter from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);expect(personnel).toEqual({ended:null,counter:3});
 },120_000);
 it('serializes actual competing response saves and refuses stale proof, account relinking and arbitrary fields',async()=>{
  const f=await formFixture(),letter=await readContractSharedLetter(f.admin,f.letterId),form=visible(await readContractSharedForm(f.admin,f.letterId));
  const base={id:f.letterId,contentRevision:letter.contentRevision,contentHash:letter.contentHash!,responseRevision:form.responseRevision,responseHash:form.responseHash};
  const results=await Promise.allSettled([saveContractSharedForm(f.admin,{...base,values:{hrChoice:'Yes'}}),saveContractSharedForm(f.admin,{...base,values:{hrChoice:'No'}})]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  await expect(saveAnswers(f.admin,f.letterId,{constructor:'forged'})).rejects.toThrow();
  await expect(actContractSharedLetter(f.admin,{id:f.letterId,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,responseRevision:form.responseRevision,responseHash:form.responseHash,action:'reviewed'})).rejects.toThrow();
  const [foreign]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional unrelated identity',${randomUUID()+'@forms.test'}) returning id`);await owner.db.execute(sql`update app_user set person_id=${foreign.id}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.admin.userId}::uuid`);
  expect(await readContractSharedForm({...f.admin,personId:foreign.id},f.letterId)).toEqual({letterId:f.letterId,kind:'Form',visible:false});
 },120_000);
 it('hands a retrospective End to actual Offboarding with truthful notice/date review and no automatic termination',async()=>{
  const lastDay=addDaysIso(todayInKualaLumpur(),-30),f=await fixture('end',false,{start:addDaysIso(lastDay,-365),end:lastDay});await submit(f,'end');const [letter]=await letters(f);const released=await review(f,letter.id);expect(released.state).toBe('released');
  const [offboarding]=await owner.db.execute<{data:{facts:{lastDay:string;noticeDate:string};contractSharedNoticeReviewRequired:boolean;contractSharedClearance:string}}>(sql`select data from lc_v9_case where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and module='off'`);
  expect(offboarding.data.facts.lastDay).toBe(lastDay);expect(offboarding.data.facts.noticeDate).toBe(todayInKualaLumpur());expect(offboarding.data.contractSharedNoticeReviewRequired).toBe(true);expect(offboarding.data.contractSharedClearance).toBe('pending-manual-personnel');
  const [personnel]=await owner.db.execute<{ended:string|null;lastDay:string|null;counter:number}>(sql`select terminated_on::text as ended,last_working_date::text as "lastDay",contract_number as counter from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);expect(personnel).toEqual({ended:null,lastDay:null,counter:3});
 },120_000);

});
