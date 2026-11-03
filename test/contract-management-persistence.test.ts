import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {hireEmployee,setEmploymentGrade,setEmploymentInfo} from '../core/org';
import {archiveCompany} from '../core/admin';
import {setAppUserArchived} from '../core/auth';
import {createMovementEvent} from '../core/movement';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {setCompensation} from '../core/comp';
import {dispatchNotificationsFromSweep} from '../core/notifications';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {LetterDocument} from '../lib/letter-model';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import * as S from '../db/schema';
import {contractNavigationAccess,contractInbox,reconcileContractSource,contractCompanies,canConfigureContractWorkflows,setupContractManagement,contractWorkflowWorkspace,assignContractRole,captureContractRetirementEvidence,saveContractTemplate,publishContractTemplate,saveContractWorkflow,saveContractConfiguration,contractSettings,intakeContract,previewContractIntake,contractCase,contractCases,submitContractDecision,confirmContractDecision,decideContractApproval,acceptContract,retryContractRecords,amendContractEnd,contractLetterEditor,releaseContractLetter,handoffContract,sweepContractManagement} from '../packs/contracts/service';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);});
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
async function account(name:string){const [p]=await owner.db.insert(S.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:randomUUID()+'@contract.test'}).returning();const userId=await createAppUser(b.tenantId,p.id,'employee');return {...admin,userId,personId:p.id,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;}
async function employee(name:string,manager?:string,contract=false,hireYear=year){const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@contract.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:contract?'contract':'full_time',hiredOn:`${hireYear}-01-01`,provisionalEndOn:contract?`${year}-12-31`:undefined,reportingManagerEmploymentId:manager});const userId=await createAppUser(b.tenantId,e.personId,'employee');return {...e,ctx:{...admin,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext};}
const letter=(renewal:boolean):LetterDocument=>({version:1,language:'en',blocks:(renewal?['employee.name','employee.id','contract.newStart','contract.newEnd','pay.basicSalary','pay.fixedAllowance']:['employee.name','employee.id','contract.lastWorkingDay']).map(key=>({type:'paragraph',content:[{type:'field',key}]}))});
async function liveModule(endApproval=false,priorStart=false,manualGrade=false){
 const manager=await employee('Fictional line manager'),chief=await employee('Fictional independent chief'),subject=await employee('Fictional contract employee',manager.employmentId,true,priorStart?year-1:year),pbp=await account('Fictional assigned PBP'),gbs=await account('Fictional GBS owner'),legal=await account('Fictional independent Legal');
 if(manualGrade){const [grade]=await owner.db.insert(S.jobGrade).values({tenantId:b.tenantId,code:'H',name:'Fictional Grade H'}).returning();await setEmploymentGrade(admin,{employmentId:subject.employmentId,gradeId:grade.id});}
 await setCompensation(admin,{employmentId:subject.employmentId,basicSalary:5000,monthlyAllowance:17,effectiveFrom:`${year}-01-01`});
 const [component]=await owner.db.insert(S.payComponent).values({tenantId:b.tenantId,code:'CONTRACT_FIXED',name:'Contract fixed allowance',kind:'allowance'}).returning();
 await v9Setup(admin);const native=(await v9Workspace(admin)).config!;const groupId=randomUUID();await v9SaveConfig(admin,native.revision,{...native,groups:[...native.groups,{id:groupId,name:'Fictional actual People Ops group',members:[gbs.userId!],limit:10}],peopleOpsGroup:groupId,bpRules:[{rules:{company:[b.companyId]},userId:pbp.userId!}]});
 await setupContractManagement(admin,b.companyId,component.id);
 for(const [actor,role] of [[pbp,'pbp'],[gbs,'gbs'],[legal,'legal']] as const)await assignContractRole(admin,{companyId:b.companyId,businessUnitId:null,userId:actor.userId,role,from:`${year}-01-01`,to:null,reason:'Confirmed independent company contract role'});
 for(const type of ['renewal','end','declined','retirement'] as const){const id=randomUUID();await saveContractTemplate(gbs,{id,companyId:b.companyId,type,expectedRevision:0,document:letter(type==='renewal'),signatoryName:'Authorised legal entity signatory',signatoryTitle:'Director',letterhead:null,submit:true});await publishContractTemplate(legal,{id,revision:1,approve:true,reason:'Wording and signatory independently reviewed'});}
 const workspace=await contractWorkflowWorkspace(admin);let renewalId='',endId='';
 for(const row of workspace.workflows){const draft={...row.draft,steps:row.draft.steps.map(step=>step.type==='request_approval'&&step.approver.type==='employee_record'&&step.approver.field==='ceo'?{...step,approver:{type:'named_employee' as const,userIds:[chief.ctx.userId!]}}:step)};if(endApproval&&draft.conditions.some(c=>c.field==='decision'&&c.value==='end'))draft.steps.splice(1,0,{id:randomUUID(),type:'request_approval',name:'Independent ending review',approver:{type:'named_employee',userIds:[chief.ctx.userId!]},quorum:'all',conditions:[],reminderDays:2,escalationDays:3,escalationTarget:{type:'employee_record',field:'pbp'},rejectedWorkflowId:null});await saveContractWorkflow(admin,{companyId:b.companyId,id:row.id,expectedRevision:row.revision,draft,publish:true});if(draft.conditions.some(c=>c.field==='decision'&&c.value==='renew'))renewalId=row.id;if(draft.conditions.some(c=>c.field==='decision'&&c.value==='end'))endId=row.id;}
 const [configuration]=(await contractSettings(admin)).configurations;await saveContractConfiguration(admin,{companyId:b.companyId,expectedRevision:configuration.revision,data:{...configuration.data,ownersConfirmed:true,endApprovalEnabled:endApproval},runtimeEnabled:true,activationOn:today,effectPrincipalId:admin.userId});
 const source=await previewContractIntake(gbs,subject.employmentId);const {id:caseId}=await intakeContract(gbs,{employmentId:subject.employmentId,kind:'maternity_cover',sourceRevision:source.sourceRevision});
 return {manager,chief,subject,pbp,gbs,legal,caseId,renewalId,endId};
}
async function issuedRenewal(f:Awaited<ReturnType<typeof liveModule>>){
 let view=await contractCase(f.manager.ctx,f.caseId);await submitContractDecision(f.manager.ctx,{caseId:f.caseId,revision:view.record.revision,kind:'renew',months:6,basicSalary:'5000.00',fixedAllowance:'0.00',reason:'Private manager assessment retained only for reviewers'});
 view=await contractCase(f.pbp,f.caseId);await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,workflowId:f.renewalId});await sweepContractManagement({...admin,userId:undefined,personId:null},owner);
 view=await contractCase(f.chief.ctx,f.caseId);await decideContractApproval(f.chief.ctx,{caseId:f.caseId,revision:view.record.revision,stepId:view.choices.approvalStepIds[0],decisionRevision:view.record.decision!.revision,approve:true,comment:'Private chief review comment'});return contractCase(f.subject.ctx,f.caseId);
}
async function moveToOtherCompany(f:Awaited<ReturnType<typeof liveModule>>){
 const [company]=await owner.db.insert(S.company).values({tenantId:b.tenantId,legalName:'Fictional different legal employer'}).returning();const [department]=await owner.db.insert(S.department).values({tenantId:b.tenantId,companyId:company.id,name:'Other employer department'}).returning();const manager=await hireEmployee(admin,{person:{fullName:'Fictional destination manager',primaryEmail:randomUUID()+'@contract.test'},companyId:company.id,departmentId:department.id,hiredOn:`${year}-01-01`,employmentType:'full_time'});
 await createMovementEvent(admin,{employmentId:f.subject.employmentId,kind:'entityTransfer',effectiveDate:today,companyId:company.id,departmentId:department.id,managerEmploymentId:manager.employmentId,remarks:'Actual transfer to a separate legal employer'});
 await setCompensation(admin,{employmentId:f.subject.employmentId,basicSalary:7000,effectiveFrom:today});return company.id;
}
describe('isolated Contract Staff native custody',()=>{
 it('creates five isolated draft workflows with runtime off and admits no legacy role label alone',async()=>{
  await setupContractManagement(admin,b.companyId,randomUUID());
  const workspace=await contractWorkflowWorkspace(admin);expect(workspace.workflows).toHaveLength(5);expect(workspace.workflows.every(w=>w.draft.module==='contract_staff'&&w.publishedVersion===null)).toBe(true);
  const [runtime]=await withTenant(admin,tx=>tx.execute<{enabled:boolean}>(sql`select app.contract_runtime(${b.companyId}::uuid) as enabled`));expect(runtime.enabled).toBe(false);
  const [p]=await owner.db.insert(S.person).values({tenantId:b.tenantId,fullName:'Fictional bounded contract reviewer',primaryEmail:randomUUID()+'@contract.test'}).returning();const userId=await createAppUser(b.tenantId,p.id,'employee');
  const actor={...admin,userId,personId:p.id,roles:['hr_admin'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  expect(await canConfigureContractWorkflows(actor)).toBe(false);
  await expect(assignContractRole(actor,{companyId:b.companyId,businessUnitId:null,userId,role:'gbs',from:'2026-01-01',to:null,reason:'Forged role claim must be refused'})).rejects.toThrow();
 });
 it('refuses direct app writes and forged retirement proof events',async()=>{
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into contract_configuration(tenant_id,company_id,data,updated_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,'{}',${admin.userId}::uuid)`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${b.tenantId}::uuid,'retirement',${randomUUID()}::uuid,'retirement.contract-approved','user',${admin.userId}::uuid,'{}')`))).rejects.toMatchObject({cause:{code:'42501'}});
 });
 it('requires scoped PBP custody with real retirement and separate employee-file references',async()=>{
  await expect(captureContractRetirementEvidence(admin,{employmentId:randomUUID(),retirementCaseId:randomUUID(),approvalDocumentId:randomUUID(),healthDocumentId:randomUUID(),sourceRevision:'a'.repeat(64),reason:'Actual records are required, no client boolean bypass.'})).rejects.toThrow();
 });
 it('takes a real unchanged-pay renewal through independent approvals, frozen PDF acceptance and idempotent canonical records',async()=>{
  const f=await liveModule();await expect(contractCase(admin,f.caseId)).rejects.toThrow();expect(await contractCases(admin,[b.companyId])).toEqual([]);let view=await contractCase(f.manager.ctx,f.caseId);
  expect(await withTenant(f.subject.ctx,tx=>tx.execute(sql`select id from contract_case where id=${f.caseId}::uuid`))).toEqual([]);expect((await contractCases(f.subject.ctx,[b.companyId]))[0].record).toMatchObject({decision:null,decisionHistory:[],approvals:[]});
  await submitContractDecision(f.manager.ctx,{caseId:f.caseId,revision:view.record.revision,kind:'renew',months:6,basicSalary:'5000.00',fixedAllowance:'0.00',reason:'Approved project continuation'});
  view=await contractCase(f.pbp,f.caseId);expect(view.choices.routes.some(r=>r.id===f.renewalId&&!r.blockedReason)).toBe(true);
  await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,workflowId:f.renewalId});
  view=await contractCase(f.chief.ctx,f.caseId);expect(view.documents).toEqual([]);expect(view.choices.approvalStepIds).toEqual([]);expect(view.effects.find(e=>e.kind==='generation')?.status).toBe('pending');
  await expect(withTenant(f.pbp,tx=>tx.execute(sql`select app.contract_store_document(${f.caseId}::uuid,${view.record.revision},${randomUUID()}::uuid,1,'renewal',decode('25504446','hex'),'{}'::jsonb,'{}'::jsonb)`))).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(withTenant(f.subject.ctx,tx=>tx.execute(sql`select * from contract_generation_request`))).rejects.toMatchObject({cause:{code:'42501'}});
  await sweepContractManagement({...admin,userId:undefined,personId:null},owner);
  view=await contractCase(f.chief.ctx,f.caseId);expect(view.record.approvals[0].state).toBe('skipped');const step=view.choices.approvalStepIds[0];expect(step).toBeTruthy();
  await decideContractApproval(f.chief.ctx,{caseId:f.caseId,revision:view.record.revision,stepId:step,decisionRevision:view.record.decision!.revision,approve:true,comment:'Term and unchanged pay independently approved'});
  view=await contractCase(f.subject.ctx,f.caseId);expect(view.record.state).toBe('e_acceptance');expect(view.activity).toEqual([]);expect(view.record.approvals).toEqual([]);const doc=view.documents.find(d=>d.issuedAt&&!d.supersededAt)!;
  await expect(acceptContract(f.subject.ctx,{caseId:f.caseId,revision:view.record.revision,documentId:doc.id,hash:'b'.repeat(64),action:'accept',reason:'',signature:{method:'typed',value:'Fictional contract employee',consent:true}})).rejects.toThrow();
  for(const signature of [null,{}, {value:'Name',consent:true},{method:'typed',value:'Name',consent:'true'},{method:'drawn',value:'data:image/png;base64,AAAA',consent:true}]){
   await expect(withTenant(f.subject.ctx,tx=>tx.execute(sql`select app.contract_accept_document(${f.caseId}::uuid,${view.record.revision},${doc.id}::uuid,${doc.hash},'accept','',${JSON.stringify(signature)}::jsonb,decode('25504446','hex'))`))).rejects.toMatchObject({cause:{code:'23514'}});
  }
  await acceptContract(f.subject.ctx,{caseId:f.caseId,revision:view.record.revision,documentId:doc.id,hash:doc.hash,action:'accept',reason:'',signature:{method:'typed',value:'Fictional contract employee',consent:true}});
  expect((await owner.db.execute<{sealed:boolean}>(sql`select signed_content is not null as sealed from contract_document where id=${doc.id}::uuid`))[0].sealed).toBe(false);
  expect((await contractCase(f.gbs,f.caseId)).record.state).toBe('records_pending');const maintenance={...admin,userId:undefined,personId:null};await sweepContractManagement(maintenance,owner);const result=await contractCase(f.gbs,f.caseId);expect(result.record.state).toBe('renewed');expect(result.effects.find(e=>e.kind==='records')?.status).toBe('done');
  const [employment]=await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId));expect(employment).toMatchObject({contractStartDate:`${year+1}-01-01`,contractEndDate:`${year+1}-06-30`,terminatedOn:null});
  const before=await owner.db.execute<{count:number}>(sql`select count(*)::integer as count from contract_case where tenant_id=${b.tenantId}::uuid`);await sweepContractManagement(maintenance,owner);expect(await owner.db.execute(sql`select count(*)::integer as count from contract_case where tenant_id=${b.tenantId}::uuid`)).toEqual(before);
  expect(await owner.db.execute(sql`select id from employee_document where tenant_id=${b.tenantId}::uuid and contract_document_id=${doc.id}::uuid`)).toHaveLength(1);
 });
 it('changes only the reasoned maternity ED through its protected PBP intent and retains the approved case-letter body',async()=>{
  const f=await liveModule();const view=await contractCase(f.pbp,f.caseId),queued=await amendContractEnd(f.pbp,{caseId:f.caseId,revision:view.record.revision,endOn:`${year+1}-01-31`,reason:'Actual maternity cover return date was rescheduled'});expect(queued.term.endOn).toBe(`${year}-12-31`);expect((await contractCase(f.subject.ctx,f.caseId)).dateAmendmentPending).toBe(true);await sweepContractManagement({...admin,userId:undefined,personId:null,roles:[],grants:[]},owner);const changed=(await contractCase(f.pbp,f.caseId)).record;expect(changed.term.endOn).toBe(`${year+1}-01-31`);expect((await contractCase(f.subject.ctx,f.caseId)).dateAmendmentPending).toBe(false);
  const [actual]=await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId));expect(actual).toMatchObject({contractStartDate:`${year}-01-01`,contractEndDate:`${year+1}-01-31`,terminatedOn:null});
  expect(await withTenant(f.pbp,tx=>tx.execute(sql`update employment set contract_end_date=${`${year+1}-02-28`}::date where id=${f.subject.employmentId}::uuid returning id`))).toEqual([]);expect((await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId)))[0].contractEndDate).toBe(`${year+1}-01-31`);
  await submitContractDecision(f.pbp,{caseId:f.caseId,revision:changed.revision,kind:'end',months:null,basicSalary:'5000',fixedAllowance:'0',reason:'Coverage ends after the return date'});const pending=await contractCase(f.pbp,f.caseId);await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:pending.record.revision,workflowId:f.endId});
  const editable=await contractLetterEditor(f.gbs,f.caseId,'end');expect(editable.body).toEqual(letter(false));expect(editable.templateVersion).toBe(1);
 });

 it.each(['end','end_with_approval','decline'] as const)('files and hands off the exact %s letter with a real employee release occurrence',async branch=>{
  const f=await liveModule(branch==='end_with_approval');
  const maintenance={...admin,userId:undefined,personId:null,roles:[],grants:[]};
  if(branch==='decline'){
   const view=await issuedRenewal(f),issued=view.documents.find(d=>d.id===view.record.document?.id)!;
   await acceptContract(f.subject.ctx,{caseId:f.caseId,revision:view.record.revision,documentId:issued.id,hash:issued.hash,action:'decline',reason:'I decline the renewal under the offered terms',signature:null});
  }else{
   let view=await contractCase(f.pbp,f.caseId);
   await submitContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,kind:'end',months:null,basicSalary:'5000',fixedAllowance:'0',reason:'Agreed cover period has ended'});
   view=await contractCase(f.pbp,f.caseId);await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,workflowId:f.endId});
   if(branch==='end_with_approval'){
    await sweepContractManagement(maintenance,owner);view=await contractCase(f.chief.ctx,f.caseId);
    expect(view.record.state).toBe('in_approval');expect(view.choices.approvalStepIds).toHaveLength(1);expect(view.documents.find(d=>d.type==='end')?.issuedAt).toBeNull();
    await decideContractApproval(f.chief.ctx,{caseId:f.caseId,revision:view.record.revision,stepId:view.choices.approvalStepIds[0],decisionRevision:view.record.decision!.revision,approve:true,comment:'Ending letter independently reviewed'});
   }
  }
  await sweepContractManagement(maintenance,owner);
  const ending=await contractCase(f.gbs,f.caseId),letter=ending.documents.find(d=>d.type===(branch==='decline'?'declined':'end')&&!d.supersededAt)!;
  expect(ending.record.state).toBe('ending');expect(letter).toBeTruthy();
  await releaseContractLetter(f.gbs,{caseId:f.caseId,revision:ending.record.revision,documentId:letter.id,hash:letter.hash,reason:'Current reviewed letter approved for employee release'});
  await sweepContractManagement(maintenance,owner);await sweepContractManagement(maintenance,owner);
  const finished=await contractCase(f.gbs,f.caseId);expect(finished.record.state).toBe('handed_off');
  expect((await contractCase(f.subject.ctx,f.caseId)).documents.find(d=>d.id===letter.id)?.releasedAt).toBeTruthy();
  const [file]=await owner.db.execute<{id:string}>(sql`select id from employee_document where tenant_id=${b.tenantId}::uuid and contract_document_id=${letter.id}::uuid`);
  expect(file.id).toBeTruthy();
  const exits=await owner.db.execute<{data:{contractSourceLetter:unknown;facts:{lastDay:string;noticeDate:string}}}>(sql`select data from lc_v9_case where tenant_id=${b.tenantId}::uuid and data->>'contractSourceCaseId'=${f.caseId}`);
  expect(exits).toHaveLength(1);expect(exits[0].data.contractSourceLetter).toEqual({documentId:letter.id,employeeDocumentId:file.id,hash:letter.hash});
  expect(exits[0].data.facts).toMatchObject({lastDay:ending.record.term.endOn,noticeDate:today});
  const messages=await owner.db.execute<{source_event_id:string}>(sql`select source_event_id from contract_message where case_id=${f.caseId}::uuid and recipient_user_id=${f.subject.ctx.userId}::uuid and occurrence_key like 'letter-released:%' and source_event_id is not null`);
  expect(messages).toHaveLength(1);
  await setModule(b.tenantId,'notifications','active');
  const notificationOwner={...(await entitledCtx(b)),userId:undefined,personId:null};
  await dispatchNotificationsFromSweep(notificationOwner,owner);await dispatchNotificationsFromSweep(notificationOwner,owner);
  expect(await owner.db.execute(sql`select id from notification where tenant_id=${b.tenantId}::uuid and recipient_employment_id=${f.subject.employmentId}::uuid and source_event_id=${messages[0].source_event_id}::uuid`)).toHaveLength(1);
 });
 it('requires a distinct Grade H manual receipt without creating a V9 exit',async()=>{
  const f=await liveModule(false,false,true),maintenance={...admin,userId:undefined,personId:null,roles:[],grants:[]};
  let view=await contractCase(f.pbp,f.caseId);await submitContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,kind:'end',months:null,basicSalary:'5000',fixedAllowance:'0',reason:'Grade H contract ends on the recorded date'});
  view=await contractCase(f.pbp,f.caseId);await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,workflowId:f.endId});
  await sweepContractManagement(maintenance,owner);view=await contractCase(f.gbs,f.caseId);const letter=view.documents.find(d=>d.type==='end')!;
  await releaseContractLetter(f.gbs,{caseId:f.caseId,revision:view.record.revision,documentId:letter.id,hash:letter.hash,reason:'Approved for exact employee release'});
  await sweepContractManagement(maintenance,owner);expect((await contractCase(f.gbs,f.caseId)).record.state).toBe('ending');
  await expect(handoffContract(f.subject.ctx,{caseId:f.caseId,manualReason:'Cannot attest on behalf of People Ops'})).rejects.toMatchObject({cause:{code:'42501'}});
  await handoffContract(f.gbs,{caseId:f.caseId,manualReason:'Recorded People Ops handoff outside V9'});
  await handoffContract(f.gbs,{caseId:f.caseId,manualReason:'Retry must not replace the original manual receipt'});
  const finished=await contractCase(f.gbs,f.caseId);expect(finished.record.state).toBe('handed_off');expect(finished.effects.find(e=>e.kind==='manual_handoff')?.receipt).toMatchObject({manualHandoff:true,confirmedBy:f.gbs.userId,letterDocumentId:letter.id,letterHash:letter.hash,reason:'Recorded People Ops handoff outside V9'});
  expect(await owner.db.execute(sql`select id from lc_v9_case where tenant_id=${b.tenantId}::uuid and data->>'contractSourceCaseId'=${f.caseId}`)).toHaveLength(0);
 });
 it('blocks confirmation when the published workflow condition removes its required record step',async()=>{
  const f=await liveModule();
  const row=(await contractWorkflowWorkspace(admin)).workflows.find(w=>w.id===f.renewalId)!;
  const draft={...row.draft,steps:row.draft.steps.map(step=>step.type==='update_record'?{...step,conditions:[{field:'payChanges' as const,op:'is' as const,value:'true'}]}:step)};
  await saveContractWorkflow(admin,{companyId:b.companyId,id:row.id,expectedRevision:row.revision,draft,publish:true});
  let view=await contractCase(f.manager.ctx,f.caseId);
  await submitContractDecision(f.manager.ctx,{caseId:f.caseId,revision:view.record.revision,kind:'renew',months:6,basicSalary:'5000.00',fixedAllowance:'0.00',reason:'Keep current approved terms for the cover'});
  view=await contractCase(f.pbp,f.caseId);expect(view.choices.routes.find(r=>r.id===f.renewalId)?.blockedReason).toMatch(/required Contract step/);
  await expect(confirmContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,workflowId:f.renewalId})).rejects.toMatchObject({cause:{code:'23514'}});
  expect((await contractCase(f.pbp,f.caseId)).record.state).toBe('decision_pending');
 });
 it('audits unsigned expiry once and retains the active approval and employment',async()=>{
  const f=await liveModule(false,true),maintenance={...admin,userId:undefined,personId:null,roles:[],grants:[]};
  let view=await contractCase(f.pbp,f.caseId);
  const endOn=new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
  await amendContractEnd(f.pbp,{caseId:f.caseId,revision:view.record.revision,endOn,reason:'Actual shortened cover period retained from Personnel'});
  await sweepContractManagement(maintenance,owner);
  view=await contractCase(f.manager.ctx,f.caseId);expect(view.record.expiredUnsignedAt).toBeTruthy();
  await submitContractDecision(f.manager.ctx,{caseId:f.caseId,revision:view.record.revision,kind:'renew',months:6,basicSalary:'5000.00',fixedAllowance:'0.00',reason:'Continue the cover with a reviewed renewal'});
  view=await contractCase(f.pbp,f.caseId);await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,workflowId:f.renewalId});
  await sweepContractManagement(maintenance,owner);await sweepContractManagement(maintenance,owner);
  const pending=await contractCase(f.chief.ctx,f.caseId);expect(pending.record.state).toBe('in_approval');expect(pending.choices.approvalStepIds).toHaveLength(1);
  expect(await owner.db.execute(sql`select id from contract_case_activity where case_id=${f.caseId}::uuid and action='expiry.unsigned'`)).toHaveLength(1);
  const [actual]=await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId));expect(actual).toMatchObject({contractEndDate:endOn,terminatedOn:null,lastWorkingDate:null});
 });
 it('holds late Offboarding with the real notice and end dates while preserving the released letter',async()=>{
  const f=await liveModule(false,true),maintenance={...admin,userId:undefined,personId:null,roles:[],grants:[]};
  const endOn=new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
  let view=await contractCase(f.pbp,f.caseId);
  await amendContractEnd(f.pbp,{caseId:f.caseId,revision:view.record.revision,endOn,reason:'Actual earlier cover end retained from Personnel'});
  await sweepContractManagement(maintenance,owner);view=await contractCase(f.pbp,f.caseId);
  await submitContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,kind:'end',months:null,basicSalary:'5000',fixedAllowance:'0',reason:'Cover has ended; release the actual letter'});
  view=await contractCase(f.pbp,f.caseId);await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,workflowId:f.endId});
  await sweepContractManagement(maintenance,owner);view=await contractCase(f.gbs,f.caseId);const letter=view.documents.find(d=>d.type==='end')!;
  await releaseContractLetter(f.gbs,{caseId:f.caseId,revision:view.record.revision,documentId:letter.id,hash:letter.hash,reason:'Released on the actual review date'});
  await sweepContractManagement(maintenance,owner);
  const held=await contractCase(f.gbs,f.caseId);expect(held.record.state).toBe('ending');expect(held.effects.find(e=>e.kind==='offboarding')?.status).toBe('failed');
  expect(held.documents.find(d=>d.id===letter.id)).toMatchObject({hash:letter.hash,employeeDocumentId:expect.any(String)});
  expect(await owner.db.execute(sql`select id from lc_v9_case where tenant_id=${b.tenantId}::uuid and data->>'contractSourceCaseId'=${f.caseId}`)).toHaveLength(0);
  const [actual]=await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId));expect(actual).toMatchObject({contractEndDate:endOn,lastWorkingDate:null,terminatedOn:null});
 });
 it('keeps canonical People Ops and PBP ownership authoritative across alternate logins and removal',async()=>{
  const f=await liveModule();const [otherCompany]=await owner.db.insert(S.company).values({tenantId:b.tenantId,legalName:'Fictional company outside Contract opt-in'}).returning();expect((await contractCompanies(f.gbs)).map(c=>c.id)).not.toContain(otherCompany.id);const [scope]=await withTenant(f.gbs,tx=>tx.execute<{allowed:boolean}>(sql`select app.contract_has_role(${otherCompany.id}::uuid,NULL,'gbs') as allowed`));expect(scope.allowed).toBe(false);const altGbsId=await createAppUser(b.tenantId,f.gbs.personId!,'employee'),altPbpId=await createAppUser(b.tenantId,f.pbp.personId!,'employee');
  for(const [userId,role] of [[altGbsId,'gbs'],[altPbpId,'pbp']] as const)await expect(assignContractRole(admin,{companyId:b.companyId,businessUnitId:null,userId,role,from:`${year}-01-01`,to:null,reason:'An alternate login cannot invent canonical custody'})).rejects.toMatchObject({cause:{code:'23514'}});
  expect(await canConfigureContractWorkflows(f.gbs)).toBe(true);expect((await contractCase(f.pbp,f.caseId)).pbp).toBe(true);
  const config=(await v9Workspace(admin)).config!;await v9SaveConfig(admin,config.revision,{...config,groups:config.groups.map(g=>g.id===config.peopleOpsGroup?{...g,members:[f.legal.userId!]}:g),bpRules:[]});
  expect(await canConfigureContractWorkflows(f.gbs)).toBe(false);await expect(contractCase(f.gbs,f.caseId)).rejects.toMatchObject({code:'forbidden'});await expect(contractCase(f.pbp,f.caseId)).rejects.toMatchObject({code:'forbidden'});expect((await contractCase(f.manager.ctx,f.caseId)).manager).toBe(true);
 });
 it('holds an ambiguous highest-specificity canonical PBP mapping instead of selecting a login arbitrarily',async()=>{
  const f=await liveModule(),other=await account('Fictional conflicting canonical PBP'),config=(await v9Workspace(admin)).config!;
  await v9SaveConfig(admin,config.revision,{...config,bpRules:[{rules:{company:[b.companyId]},userId:f.pbp.userId!},{rules:{company:[b.companyId]},userId:other.userId!}]});
  await expect(contractCase(f.pbp,f.caseId)).rejects.toMatchObject({code:'forbidden'});expect((await contractCase(f.manager.ctx,f.caseId)).manager).toBe(true);
 });
 it('returns only employee-safe data from direct native decline, without reviewer reasons or comments',async()=>{
  const f=await liveModule(),view=await issuedRenewal(f),doc=view.documents.find(d=>d.id===view.record.document?.id)!;
  const [result]=await withTenant(f.subject.ctx,tx=>tx.execute<{data:Record<string,unknown>}>(sql`select app.contract_accept_document(${f.caseId}::uuid,${view.record.revision},${doc.id}::uuid,${doc.hash},'decline','I decline this offered renewal',NULL,NULL) as data`));
  expect(result.data.decision).not.toHaveProperty('submittedPersonId');expect(result.data.decision).not.toHaveProperty('confirmedPersonId');expect(result.data).toMatchObject({state:'ending',decisionDraft:null,decisionHistory:[],approvals:[]});expect(JSON.stringify(result.data)).not.toContain('Private manager assessment');expect(JSON.stringify(result.data)).not.toContain('Private chief review');
 });
 it('does not expose a newly unissued decision through an old superseded issued PDF',async()=>{
  const f=await liveModule(),view=await issuedRenewal(f);const before=view.documents.find(d=>d.issuedAt)!;const staff=await contractCase(f.pbp,f.caseId);await amendContractEnd(f.pbp,{caseId:f.caseId,revision:staff.record.revision,endOn:`${year+1}-01-31`,reason:'Actual maternity cover return date was corrected'});await sweepContractManagement({...admin,userId:undefined,personId:null,roles:[],grants:[]},owner);
  const current=await contractCase(f.manager.ctx,f.caseId);await submitContractDecision(f.manager.ctx,{caseId:f.caseId,revision:current.record.revision,kind:'renew',months:6,basicSalary:'5300.00',fixedAllowance:'0.00',reason:'Unissued confidential replacement decision'});
  const [old]=await owner.db.execute<{issued:boolean;superseded:boolean}>(sql`select issued_at is not null as issued,superseded_at is not null as superseded from contract_document where id=${before.id}::uuid`);expect(old).toEqual({issued:true,superseded:true});
  const [projection]=await withTenant(f.subject.ctx,tx=>tx.execute<{data:{decision:unknown}}>(sql`select app.contract_case_projection(${f.caseId}::uuid)->'data' as data`));expect(projection.data.decision).toBeNull();expect((await contractCases(f.subject.ctx,[b.companyId]))[0].record.decision).toBeNull();
 });

 it('cancels an uncommitted reasoned date request without changing Personnel or invalidating its current case',async()=>{
  const f=await liveModule(),before=await contractCase(f.pbp,f.caseId);await amendContractEnd(f.pbp,{caseId:f.caseId,revision:before.record.revision,endOn:`${year+1}-01-31`,reason:'Review the actual expected cover return date'});const pending=await contractCase(f.pbp,f.caseId),employeeView=await contractCase(f.subject.ctx,f.caseId);expect(employeeView.dateAmendmentPending).toBe(true);expect(employeeView.dateAmendment).toBeNull();expect((await contractInbox(f.pbp)).items.some(i=>i.kind==='date_amendment')).toBe(true);
  await reconcileContractSource(f.pbp,{caseId:f.caseId,revision:pending.record.revision,reason:'Cancel this unapplied correction after checking the original Personnel date'});const after=await contractCase(f.pbp,f.caseId);expect(after.dateAmendmentPending).toBe(false);expect(after.record).toMatchObject({state:before.record.state,term:before.record.term,decision:before.record.decision,approvals:before.record.approvals});expect(after.effects.find(e=>e.kind==='date_amendment')?.receipt).toMatchObject({cancelled:true});expect(after.effects.find(e=>e.kind==='date_amendment')?.receipt).not.toHaveProperty('employmentEventId');expect((await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId)))[0].contractEndDate).toBe(`${year}-12-31`);
 });
 it('holds a queued date correction after a canonical source change and lets actual PBP reconcile without overwriting Personnel',async()=>{
  const f=await liveModule(),view=await contractCase(f.pbp,f.caseId);await amendContractEnd(f.pbp,{caseId:f.caseId,revision:view.record.revision,endOn:`${year+1}-01-31`,reason:'Actual expected maternity cover return date review'});await setEmploymentInfo(admin,{employmentId:f.subject.employmentId,contractEndDate:`${year+1}-02-28`});await sweepContractManagement({...admin,userId:undefined,personId:null,roles:[],grants:[]},owner);const failed=await contractCase(f.pbp,f.caseId);expect(failed.dateAmendmentPending).toBe(true);expect(failed.dateAmendment?.status).toBe('failed');expect(failed.sourceConflict).toBeTruthy();
  await reconcileContractSource(f.pbp,{caseId:f.caseId,revision:failed.record.revision,reason:'Keep the actual Personnel correction and cancel the stale request'});expect((await contractCase(f.pbp,f.caseId)).dateAmendmentPending).toBe(false);expect((await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId)))[0].contractEndDate).toBe(`${year+1}-02-28`);
 });
 it('requires linked human reviewers and pins maker identity before later approval',async()=>{
  const f=await liveModule();await expect(assignContractRole(admin,{companyId:b.companyId,businessUnitId:null,userId:admin.userId!,role:'legal',from:`${year}-01-01`,to:null,reason:'An unlinked setup account cannot be a human signoff'})).rejects.toMatchObject({cause:{code:'23514'}});
  const view=await contractCase(f.manager.ctx,f.caseId);await submitContractDecision(f.manager.ctx,{caseId:f.caseId,revision:view.record.revision,kind:'renew',months:6,basicSalary:'5000.00',fixedAllowance:'0.00',reason:'Terms submitted by this actual verified person'});const submitted=await contractCase(f.pbp,f.caseId);expect(submitted.record.decision?.submittedPersonId).toBe(f.manager.personId);const other=await account('Fictional corrected account binding');await owner.db.update(S.appUser).set({personId:other.personId}).where(eq(S.appUser.id,f.manager.ctx.userId!));const changed=await contractCase(f.pbp,f.caseId);expect(changed.sourceConflict).toContain('identity');await expect(confirmContractDecision(f.pbp,{caseId:f.caseId,revision:changed.record.revision,workflowId:f.renewalId})).rejects.toMatchObject({cause:{code:'40001'}});expect((await contractInbox(f.pbp)).items.some(i=>i.kind==='reconciliation')).toBe(true);
 });
 it('routes a blocked employee login to People Ops without accepting or reopening the account',async()=>{
  const f=await liveModule(),view=await issuedRenewal(f),document=view.documents.find(d=>d.id===view.record.document?.id)!;
  await setAppUserArchived(admin,{appUserId:f.subject.ctx.userId!,archived:true});
  const [blocked]=await owner.db.execute<{blocked:boolean}>(sql`select app.login_blocked(${f.subject.ctx.userId}::uuid) as blocked`);expect(blocked.blocked).toBe(true);
  await expect(withTenant(f.subject.ctx,tx=>tx.execute(sql`select app.contract_accept_document(${f.caseId}::uuid,${view.record.revision},${document.id}::uuid,${document.hash},'accept','',${JSON.stringify({method:'typed',value:'Fictional contract employee',consent:true})}::jsonb,NULL)`))).rejects.toMatchObject({cause:{code:'42501'}});
  const held=await contractCase(f.gbs,f.caseId);expect(held.employeeIdentityUnavailable).toBe(true);expect(held.record.state).toBe('e_acceptance');
  expect((await contractInbox(f.gbs)).items).toContainEqual(expect.objectContaining({caseId:f.caseId,kind:'reconciliation'}));
  const [retained]=await owner.db.execute<{signature:unknown}>(sql`select signature from contract_document where id=${document.id}::uuid`);expect(retained.signature).toBeNull();
  expect((await owner.db.execute<{blocked:boolean}>(sql`select app.login_blocked(${f.subject.ctx.userId}::uuid) as blocked`))[0].blocked).toBe(true);
  await setAppUserArchived(admin,{appUserId:f.subject.ctx.userId!,archived:false});
  expect((await contractCase(f.gbs,f.caseId)).employeeIdentityUnavailable).toBe(false);
  expect((await contractCase(f.subject.ctx,f.caseId)).record.document?.hash).toBe(document.hash);
 });
 it('retains authorised history while an archived company stops runtime mutations and intake navigation',async()=>{
  const f=await liveModule(),view=await issuedRenewal(f);await archiveCompany(admin,{id:b.companyId,archived:true});const history=await contractCase(f.gbs,f.caseId);expect(history.writable).toBe(false);expect(history.documents.some(d=>d.id===view.record.document?.id)).toBe(true);const nav=await contractNavigationAccess(f.gbs);expect(nav).toMatchObject({page:true,configure:false,intake:false});await expect(assignContractRole(admin,{companyId:b.companyId,businessUnitId:null,userId:f.legal.userId!,role:'legal',from:`${year}-01-01`,to:null,reason:'Archived companies cannot gain new active review assignments'})).rejects.toMatchObject({cause:{code:'42501'}});
 });

 it('cancels only uncommitted work after an actual company transfer and never returns the destination pay to the former scope',async()=>{
  const f=await liveModule(),issued=await issuedRenewal(f),destination=await moveToOtherCompany(f);expect(destination).not.toBe(b.companyId);const prior=await contractCase(f.gbs,f.caseId);expect(prior.writable).toBe(false);expect(prior.source).toMatchObject({companyId:b.companyId,salaryCents:'500000'});expect(prior.sourceConflict).toContain('another company');
  await expect(reconcileContractSource(f.gbs,{caseId:f.caseId,revision:prior.record.revision,reason:'Cannot re-pin another employer into the old case'})).rejects.toMatchObject({cause:{code:'42501'}});await expect(previewContractIntake(f.gbs,f.subject.employmentId)).rejects.toMatchObject({code:'forbidden'});
  await sweepContractManagement({...admin,userId:undefined,personId:null,roles:[],grants:[]},owner);const cancelled=await contractCase(f.gbs,f.caseId);expect(cancelled.record.state).toBe('cancelled');expect(cancelled.documents.some(d=>d.id===issued.record.document?.id&&!!d.issuedAt)).toBe(true);expect(cancelled.activity.some(a=>a.action==='source.cancelled')).toBe(true);
 });
 it('retains committed employee acceptance but refuses all old-company Personnel and Payroll effects after transfer',async()=>{
  const f=await liveModule(),issued=await issuedRenewal(f),doc=issued.documents.find(d=>d.id===issued.record.document?.id)!;await acceptContract(f.subject.ctx,{caseId:f.caseId,revision:issued.record.revision,documentId:doc.id,hash:doc.hash,action:'accept',reason:'',signature:{method:'typed',value:'Fictional contract employee',consent:true}});const destination=await moveToOtherCompany(f);
  await sweepContractManagement({...admin,userId:undefined,personId:null,roles:[],grants:[]},owner);const retained=await contractCase(f.gbs,f.caseId);expect(retained.record.state).toBe('records_pending');expect(retained.record.document?.acceptedAt).toBeTruthy();expect(retained.writable).toBe(false);expect(retained.source.salaryCents).toBe('500000');expect(retained.effects.find(e=>e.kind==='records')?.receipt).toBeNull();const [actual]=await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId));expect(actual).toMatchObject({companyId:destination,contractStartDate:`${year}-01-01`,contractEndDate:`${year}-12-31`});const [pay]=await owner.db.execute<{amount:string}>(sql`select basic_salary::text as amount from compensation where employment_id=${f.subject.employmentId}::uuid and valid_to is null and superseded_at is null`);expect(pay.amount).toBe('7000.00');
 });

 it('requires a new submitted decision after rejection and retains the actual prior approval snapshot',async()=>{
  const f=await liveModule();let view=await contractCase(f.manager.ctx,f.caseId);const input={caseId:f.caseId,kind:'renew' as const,months:6,basicSalary:'5000.00',fixedAllowance:'0.00',reason:'Proposed continuation within the approved staffing period'};await submitContractDecision(f.manager.ctx,{...input,revision:view.record.revision});view=await contractCase(f.pbp,f.caseId);await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:view.record.revision,workflowId:f.renewalId});await sweepContractManagement({...admin,userId:undefined,personId:null},owner);
  view=await contractCase(f.chief.ctx,f.caseId);await decideContractApproval(f.chief.ctx,{caseId:f.caseId,revision:view.record.revision,stepId:view.choices.approvalStepIds[0],decisionRevision:view.record.decision!.revision,approve:false,comment:'The actual delivery schedule needs another review'});const rejected=await contractCase(f.pbp,f.caseId);expect(rejected.record.requiresResubmission).toBe(true);await expect(confirmContractDecision(f.pbp,{caseId:f.caseId,revision:rejected.record.revision,workflowId:f.renewalId})).rejects.toMatchObject({cause:{code:'42501'}});
  await submitContractDecision(f.manager.ctx,{...input,revision:rejected.record.revision,reason:'Revised submission after review of the actual delivery schedule'});const updated=await contractCase(f.pbp,f.caseId);expect(updated.record.decision?.revision).toBe(2);expect(updated.record.requiresResubmission).toBe(false);expect(updated.record.decisionHistory[0].approvalSnapshot?.find(s=>s.state==='rejected')?.actions[0]).toMatchObject({actorPersonId:f.chief.personId,comment:'The actual delivery schedule needs another review'});expect(await withTenant(f.subject.ctx,tx=>tx.execute(sql`select data from contract_case_revision where case_id=${f.caseId}::uuid`))).toEqual([]);
 });

});
