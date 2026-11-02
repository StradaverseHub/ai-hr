import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {hireEmployee} from '../core/org';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {setCompensation} from '../core/comp';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {LetterDocument} from '../lib/letter-model';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import * as S from '../db/schema';
import {canConfigureContractWorkflows,setupContractManagement,contractWorkflowWorkspace,assignContractRole,captureContractRetirementEvidence,saveContractTemplate,publishContractTemplate,saveContractWorkflow,saveContractConfiguration,contractSettings,intakeContract,previewContractIntake,contractCase,contractCases,submitContractDecision,confirmContractDecision,decideContractApproval,acceptContract,retryContractRecords,amendContractEnd,contractLetterEditor,sweepContractManagement} from '../packs/contracts/service';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);});
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
async function account(name:string){const [p]=await owner.db.insert(S.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:randomUUID()+'@contract.test'}).returning();const userId=await createAppUser(b.tenantId,p.id,'employee');return {...admin,userId,personId:p.id,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;}
async function employee(name:string,manager?:string,contract=false){const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@contract.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:contract?'contract':'full_time',hiredOn:`${year}-01-01`,provisionalEndOn:contract?`${year}-12-31`:undefined,reportingManagerEmploymentId:manager});const userId=await createAppUser(b.tenantId,e.personId,'employee');return {...e,ctx:{...admin,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext};}
const letter=(renewal:boolean):LetterDocument=>({version:1,language:'en',blocks:(renewal?['employee.name','employee.id','contract.newStart','contract.newEnd','pay.basicSalary','pay.fixedAllowance']:['employee.name','employee.id','contract.lastWorkingDay']).map(key=>({type:'paragraph',content:[{type:'field',key}]}))});
async function liveModule(){
 const manager=await employee('Fictional line manager'),chief=await employee('Fictional independent chief'),subject=await employee('Fictional contract employee',manager.employmentId,true),pbp=await account('Fictional assigned PBP'),gbs=await account('Fictional GBS owner'),legal=await account('Fictional independent Legal');
 await setCompensation(admin,{employmentId:subject.employmentId,basicSalary:5000,monthlyAllowance:17,effectiveFrom:`${year}-01-01`});
 const [component]=await owner.db.insert(S.payComponent).values({tenantId:b.tenantId,code:'CONTRACT_FIXED',name:'Contract fixed allowance',kind:'allowance'}).returning();
 await v9Setup(admin);const native=(await v9Workspace(admin)).config!;const groupId=randomUUID();await v9SaveConfig(admin,native.revision,{...native,groups:[...native.groups,{id:groupId,name:'Fictional actual People Ops group',members:[gbs.userId!],limit:10}],peopleOpsGroup:groupId,bpRules:[{rules:{company:[b.companyId]},userId:pbp.userId!}]});
 await setupContractManagement(admin,b.companyId,component.id);
 for(const [actor,role] of [[pbp,'pbp'],[gbs,'gbs'],[legal,'legal']] as const)await assignContractRole(admin,{companyId:b.companyId,businessUnitId:null,userId:actor.userId,role,from:`${year}-01-01`,to:null,reason:'Confirmed independent company contract role'});
 for(const type of ['renewal','end','declined','retirement'] as const){const id=randomUUID();await saveContractTemplate(gbs,{id,companyId:b.companyId,type,expectedRevision:0,document:letter(type==='renewal'),signatoryName:'Authorised legal entity signatory',signatoryTitle:'Director',letterhead:null,submit:true});await publishContractTemplate(legal,{id,revision:1,approve:true,reason:'Wording and signatory independently reviewed'});}
 const workspace=await contractWorkflowWorkspace(admin);let renewalId='',endId='';
 for(const row of workspace.workflows){const draft={...row.draft,steps:row.draft.steps.map(step=>step.type==='request_approval'&&step.approver.type==='employee_record'&&step.approver.field==='ceo'?{...step,approver:{type:'named_employee' as const,userIds:[chief.ctx.userId!]}}:step)};await saveContractWorkflow(admin,{companyId:b.companyId,id:row.id,expectedRevision:row.revision,draft,publish:true});if(draft.conditions.some(c=>c.field==='decision'&&c.value==='renew'))renewalId=row.id;if(draft.conditions.some(c=>c.field==='decision'&&c.value==='end'))endId=row.id;}
 const [configuration]=(await contractSettings(admin)).configurations;await saveContractConfiguration(admin,{companyId:b.companyId,expectedRevision:configuration.revision,data:{...configuration.data,ownersConfirmed:true},runtimeEnabled:true,activationOn:today,effectPrincipalId:admin.userId});
 const source=await previewContractIntake(gbs,subject.employmentId);const {id:caseId}=await intakeContract(gbs,{employmentId:subject.employmentId,kind:'maternity_cover',sourceRevision:source.sourceRevision});
 return {manager,chief,subject,pbp,gbs,legal,caseId,renewalId,endId};
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
  const f=await liveModule();const view=await contractCase(f.pbp,f.caseId),changed=await amendContractEnd(f.pbp,{caseId:f.caseId,revision:view.record.revision,endOn:`${year+1}-01-31`,reason:'Actual maternity cover return date was rescheduled'});expect(changed.term.endOn).toBe(`${year+1}-01-31`);
  const [actual]=await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId));expect(actual).toMatchObject({contractStartDate:`${year}-01-01`,contractEndDate:`${year+1}-01-31`,terminatedOn:null});
  expect(await withTenant(f.pbp,tx=>tx.execute(sql`update employment set contract_end_date=${`${year+1}-02-28`}::date where id=${f.subject.employmentId}::uuid returning id`))).toEqual([]);expect((await owner.db.select().from(S.employment).where(eq(S.employment.id,f.subject.employmentId)))[0].contractEndDate).toBe(`${year+1}-01-31`);
  await submitContractDecision(f.pbp,{caseId:f.caseId,revision:changed.revision,kind:'end',months:null,basicSalary:'5000',fixedAllowance:'0',reason:'Coverage ends after the return date'});const pending=await contractCase(f.pbp,f.caseId);await confirmContractDecision(f.pbp,{caseId:f.caseId,revision:pending.record.revision,workflowId:f.endId});
  const editable=await contractLetterEditor(f.gbs,f.caseId,'end');expect(editable.body).toEqual(letter(false));expect(editable.templateVersion).toBe(1);
 });

});
