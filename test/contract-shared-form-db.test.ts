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

beforeAll(migrateTestDb);afterAll(closeAll);
async function fixture(kind:'renew'|'end',twoDocuments=false,period?:{start:string;end:string}){
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');let admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional ending administrator',${randomUUID()+'@ending.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};
 await v9Setup(admin);const config=(await v9Workspace(admin)).config!,groupId=randomUUID();
 await v9SaveConfig(admin,config.revision,{...config,groups:[...config.groups,{id:groupId,name:'Contract ending People Ops',members:[admin.userId!],limit:0}],peopleOpsGroup:groupId});
 const year=Number(todayInKualaLumpur().slice(0,4)),start=period?.start??`${year}-01-01`,end=period?.end??`${year}-12-31`;
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional ending subject',primaryEmail:randomUUID()+'@ending.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end});
 await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:3});
 const termId=randomUUID(),caseId=randomUUID();
 await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) values(${termId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,1,'project',${start}::date,${end}::date,'fixture-ending-period')`);
 await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,${termId}::uuid,'CT-ENDING-1',1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn',${start}::text,'endOn',${end}::text),'decision',NULL,'decisionDraft',NULL))`);
 await adoptContractSharedCase(admin,caseId);
 const templateIds:string[]=[];
 async function template(employeeSign:boolean,name:string){
  const id=randomUUID();await saveAutomationDocumentTemplate(admin,{template:{id,module:'contract_staff',name,description:'Fictional ending wording',rules:{},blocks:[{id:'intro',type:'text',text:'Dear {employee.name}. Current end: {contract.end}.',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'group',groupId}},...(employeeSign?[{id:randomUUID(),order:2,action:'sign' as const,owner:false,who:{kind:'employee' as const}}]:[])]},expectedRevision:0,publish:true,retired:false});return id;
 }
 templateIds.push(await template(kind==='renew','Contract outcome'));
 if(twoDocuments)templateIds.push(await template(false,'Second ending letter'));
 const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Contract ending decision',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[...templateIds.map(letterTemplateId=>({id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId}})),...(kind==='end'?[{id:randomUUID(),type:'startOffboarding',conditions:[],to:[],cc:[],params:{}}]:[])]};
 await saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Reviewed ending workflow fixture'});
 const declineTemplate=await template(false,'Declined renewal ending');
 await saveAutomationWorkflow(admin,{workflow:{...workflow,id:randomUUID(),name:'Recorded decline ending',trigger:{...workflow.trigger,event:'employeeDeclined'},steps:[{id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:declineTemplate}},{id:randomUUID(),type:'startOffboarding',conditions:[],to:[],cc:[],params:{}}]},expectedRevision:0,reason:'Reviewed employee decline fixture'});
 return {b,admin,employee,caseId,start,end,workflow,groupId};
}
async function finish(id:string,as:SessionContext,kind:'contract_preview'|'contract_automation'){
 let failure:unknown;const original=kind==='contract_preview'?contractPreviewJobHandler:contractAutomationJobHandler;
 const diagnostic={...original,describeFailure:async(...args:Parameters<NonNullable<typeof original.describeFailure>>)=>{failure=args[1];return original.describeFailure!(...args);}};
 for(let n=0;n<100;n++){
  const job=await readBulkJob(as,id,kind);if(job.state==='failed')throw failure??new Error(job.error??'Ending worker failed');if(job.state==='completed')return;
  await runBulkJobTick(owner.client,{handlers:[diagnostic]});
 }
 throw new Error('The actual ending kernel job did not finish');
}
async function submit(f:Awaited<ReturnType<typeof fixture>>,kind:'renew'|'end'){
 const preview=await previewContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,draft:kind==='end'?{kind,payChanges:false,endReason:'contract_expiry',reason:'The agreed period ends'}:{kind,payChanges:false,months:6,reason:'Continue the role'}});
 await finish(preview.jobId,f.admin,'contract_preview');const accepted=await submitContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,previewId:preview.previewId});await finish(accepted.jobId,f.admin,'contract_automation');return accepted;
}
async function letters(f:Awaited<ReturnType<typeof fixture>>){return owner.db.execute<{id:string;purpose:string;state:string}>(sql`select id,purpose,data->>'state' as state from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid order by updated_at,id`);}
async function review(f:Awaited<ReturnType<typeof fixture>>,id:string){
 const before=await readContractSharedLetter(f.admin,id);expect(before.pendingAction?.kind).toBe('review');
 const after=await actContractSharedLetter(f.admin,{id,actionId:randomUUID(),stepId:before.pendingAction!.stepId,revision:before.contentRevision,hash:before.contentHash!,action:'reviewed'});
 const events=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='letterReleased' and data->>'letterId'=${id} order by created_at,id`);
 for(const event of events)await finish(event.job,f.admin,'contract_automation');return after;
}

function visible(form:ContractSharedForm){expect(form?.visible).toBe(true);if(!form?.visible)throw new Error('Expected actual routed Form body');return form;}
const fields:Field[]=[
 {id:'hrChoice',label:'HR decision',type:'select',owner:'hr',pmKey:null,required:true,sensitive:false,options:['Yes','No'],section:'main',when:null},
 {id:'lockedIC',label:'Identity number',type:'text',owner:'pmLocked',pmKey:'icNo',required:true,sensitive:true,options:[],section:'main',when:null},
 {id:'lockedBank',label:'Bank account',type:'text',owner:'pmLocked',pmKey:'bankAcc',required:false,sensitive:true,options:[],section:'main',when:null},
 {id:'employeeAck',label:'Employee answer',type:'checkbox',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'main',when:{field:'hrChoice',value:'Yes'}},
 {id:'employeeRows',label:'Employee table',type:'table',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],columns:['Name','Value'],section:'main',when:{field:'hrChoice',value:'Yes'}},
];
async function formFixture(){
 const f=await fixture('renew');const userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');const employee:SessionContext={...f.admin,userId,personId:f.employee.personId,roles:['employee'],grants:undefined};
 await owner.db.execute(sql`insert into employee_statutory_my(tenant_id,person_id,ic_number,bank_account_no) values(${f.b.tenantId}::uuid,${f.employee.personId}::uuid,'990101-01-1234','FICTIONAL-BANK-001') on conflict(person_id) do update set ic_number=excluded.ic_number,bank_account_no=excluded.bank_account_no`);
 const setup=(await v9Workspace(f.admin)).config!;await v9SaveConfig(f.admin,setup.revision,{...setup,companies:[...(setup.companies??[]).filter(x=>x.companyId!==f.b.companyId),{companyId:f.b.companyId,signatoryUserId:null,signatoryTitle:'',letterhead:{registrationNo:'FICTIONAL-REG',address:'Fictional Shared address',color:'#123456'}}]});
 const templateId=f.workflow.steps[0].params.letterTemplateId as string;
 await saveAutomationDocumentTemplate(f.admin,{template:{id:templateId,module:'contract_staff',name:'Fictional shared employment Form',description:'Real Form owner regression',rules:{},blocks:[{id:'head',type:'letterhead',text:'',section:''},{id:'intro',type:'text',text:'For {employee.name}, {decision.type}, last day {contract.lastDay}.',section:''},{id:'fields',type:'fields',text:'',section:'main'}],fields,routing:[{id:'hr-review',order:1,action:'review',owner:true,who:{kind:'group',groupId:f.groupId}},{id:'hr-sign',order:2,action:'sign',owner:false,who:{kind:'group',groupId:f.groupId}},{id:'employee-sign',order:3,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:1,publish:true,retired:false});
 await submit(f,'renew');const [letter]=await letters(f);return {...f,employeeActor:employee,letterId:letter.id};
}
async function saveAnswers(as:SessionContext,id:string,patch:Record<string,string>){const letter=await readContractSharedLetter(as,id),form=visible(await readContractSharedForm(as,id));return visible(await saveContractSharedForm(as,{id,contentRevision:letter.contentRevision,contentHash:letter.contentHash!,responseRevision:form.responseRevision,responseHash:form.responseHash,values:patch}));}
async function actForm(as:SessionContext,id:string,action:'reviewed'|'signed',extra:Record<string,unknown>={}){const letter=await readContractSharedLetter(as,id),form=visible(await readContractSharedForm(as,id));return actContractSharedLetter(as,{id,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,responseRevision:form.responseRevision,responseHash:form.responseHash,action,...(action==='signed'?{method:'typed' as const,value:'Fictional verified signer',consent:true}:{}),...extra});}
describe('actual shared Contract Form owner',()=>{
 it('uses selected country fields, native ownership, scoped immutable signatures and strict released privacy',async()=>{
  const f=await formFixture();expect(requirePackFor('MY').documentMerge?.keys).toEqual(MY_DOCUMENT_MERGE_KEYS);
  expect(await readContractSharedForm(f.employeeActor,f.letterId)).toEqual({letterId:f.letterId,kind:'Form',visible:false});
  const initial=visible(await readContractSharedForm(f.admin,f.letterId));expect(initial.values).toMatchObject({lockedIC:'990101-01-1234',lockedBank:'FICTIONAL-BANK-001'});expect(initial.editableFieldIds).toEqual(['hrChoice']);
  const letter=await readContractSharedLetter(f.admin,f.letterId);expect(letter.body?.values).toMatchObject({'company.regNo':'FICTIONAL-REG','company.address':'Fictional Shared address','company.color':'#123456','decision.type':'Renew'});expect(letter.body?.values).not.toHaveProperty('contract.salary');
  await expect(saveAnswers(f.admin,f.letterId,{lockedIC:'forged'})).rejects.toThrow();await expect(saveAnswers(f.admin,f.letterId,{hrChoice:'Not an option'})).rejects.toThrow();
  await expect(actForm(f.admin,f.letterId,'reviewed')).rejects.toThrow();await saveAnswers(f.admin,f.letterId,{hrChoice:'Yes'});await actForm(f.admin,f.letterId,'reviewed');
  const signed=await actForm(f.admin,f.letterId,'signed');expect(signed.valuesFixed).toBe(true);
  const before=visible(await readContractSharedForm(f.employeeActor,f.letterId));expect(before.editableFieldIds).toEqual(['employeeAck','employeeRows']);const hrReceipt=before.receipts.find(x=>x.scope==='hr')!;expect(hrReceipt.fieldIds).not.toContain('employeeAck');expect(hrReceipt.values).not.toHaveProperty('employeeAck');
  await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-LATER-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
  expect(visible(await readContractSharedForm(f.employeeActor,f.letterId)).values.lockedBank).toBe('FICTIONAL-BANK-001');await expect(saveAnswers(f.employeeActor,f.letterId,{hrChoice:'No'})).rejects.toThrow();
  await expect(actForm(f.employeeActor,f.letterId,'signed')).rejects.toThrow();await saveAnswers(f.employeeActor,f.letterId,{employeeAck:'true',employeeRows:'[["Fictional","Value"]]'});
  const employeeLetter=await readContractSharedLetter(f.employeeActor,f.letterId);
  const [signing]=await owner.db.execute<{id:string}>(sql`select signing_document_id as id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and id=${f.letterId}::uuid`);
  await expect(withTenant(f.employeeActor,tx=>recordDocumentSigningActionTx(tx,f.employeeActor,{id:signing.id,actionId:randomUUID(),stepId:employeeLetter.pendingAction!.stepId,revision:employeeLetter.contentRevision,hash:employeeLetter.contentHash!,action:'signed',method:'typed',value:'Fictional direct call',consent:true})))).rejects.toThrow();
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
  await expect(saveContractSharedForm(f.admin,{...base,values:{constructor:'forged'}})).rejects.toThrow();
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
