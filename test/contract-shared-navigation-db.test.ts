/** Normal migrations must admit 6012 before running this source-only proposal suite. No SQL installation bypass. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {v9Setup} from '../packs/lifecycle/service';
import {saveAutomationWorkflow} from '../packs/automation/service';
import {contractNavigationAccess,contractSharedTracker,contractSharedConfigurationChoices,saveContractSharedRole,saveContractSharedMember,contractSharedSettings,saveContractSharedSettings,openContractSharedPeriod,previewContractSharedDecision,submitContractSharedDecision,contractSharedContext,readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter} from '../packs/contracts/service';
import {contractSharedWorkPage} from '../core/contract-shared-tasks';
import {contractPostingFixture,finishContractPostingJob} from './helpers/contract-posting-fixture';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,admin:SessionContext;
const year=Number(todayInKualaLumpur().slice(0,4)),start=`${year}-01-01`,end=`${year+1}-12-31`;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const[person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional navigation administrator',${randomUUID()+'@navigation.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);
});
async function ordinary(){
 const[person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional navigation actor',${randomUUID()+'@navigation.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,person.id,'employee');return {...admin,userId,personId:person.id,roles:['employee'],grants:undefined} as SessionContext;
}
async function grant(actor:SessionContext,permissions:('view'|'decide'|'access'|'workflows'|'templates'|'groups')[],companyId:string|null=b.companyId){
 const roleId=randomUUID(),memberId=randomUUID();await saveContractSharedRole(admin,{id:roleId,name:randomUUID(),permissions,expectedRevision:0});
 await saveContractSharedMember(admin,{id:memberId,roleId,userId:actor.userId!,companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:false,expectedRevision:0});return {roleId,memberId};
}
async function fixedTerm(manager?:string){const hired=await hireEmployee(admin,{person:{fullName:'Fictional navigation subject',primaryEmail:randomUUID()+'@navigation.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end,reportingManagerEmploymentId:manager});await setEmploymentInfo(admin,{employmentId:hired.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});return hired;}
const legacy=(actor:SessionContext)=>withTenant(actor,async tx=>(await tx.execute<{facts:{page:boolean;configure:boolean;intake:boolean}}>(sql`select app.contract_navigation_access() as facts`))[0].facts);
it('exposes Direct Superior tracker navigation before any case, and holds unrelated, disabled-superior and full-time-only managers',async()=>{
 const manager=await hireEmployee(admin,{person:{fullName:'Fictional real superior',primaryEmail:randomUUID()+'@navigation.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
 const superior={...admin,userId:await createAppUser(b.tenantId,manager.personId,'employee'),personId:manager.personId,roles:['employee'],grants:undefined} as SessionContext;
 expect(await contractNavigationAccess(superior)).toMatchObject({page:false,configure:false,automation:false});
 await hireEmployee(admin,{person:{fullName:'Fictional full-time report',primaryEmail:randomUUID()+'@navigation.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start,reportingManagerEmploymentId:manager.employmentId});
 expect((await contractNavigationAccess(superior)).page).toBe(false);
 const report=await fixedTerm(manager.employmentId),before=await owner.db.execute(sql`select id from contract_case where tenant_id=${b.tenantId}::uuid`);expect(before).toEqual([]);
 expect((await legacy(superior)).page).toBe(false);expect((await contractSharedTracker(superior)).rows.map(row=>row.id)).toEqual([report.employmentId]);
 expect(await contractNavigationAccess(superior)).toEqual({page:true,configure:false,intake:false,automation:false});
 expect(await owner.db.execute(sql`select id from contract_case where tenant_id=${b.tenantId}::uuid`)).toEqual(before);
 const outsider=await ordinary();expect((await contractNavigationAccess(outsider)).page).toBe(false);
 const settings=await contractSharedSettings(admin,b.companyId);await saveContractSharedSettings(admin,{companyId:b.companyId,expectedRevision:settings.revision,settings:{...settings.settings,automaticSuperior:{...settings.settings.automaticSuperior,enabled:false}}});
 expect((await contractNavigationAccess(superior)).page).toBe(false);
},60000);
it('keeps named view, company settings and Automation-only capabilities separate and responds to actual revocation',async()=>{
 await fixedTerm();const viewer=await ordinary(),settings=await ordinary(),builder=await ordinary();const membership=await grant(viewer,['view']);await grant(settings,['access']);await grant(builder,['workflows']);
 expect(await contractNavigationAccess(viewer)).toEqual({page:true,configure:false,intake:false,automation:false});
 const choices=await contractSharedConfigurationChoices(settings);expect(choices.accessAdmin).toBe(false);expect(choices.companies.map(company=>company.id)).toEqual([b.companyId]);
 expect(await contractNavigationAccess(settings)).toEqual({page:true,configure:true,intake:false,automation:false});
 expect(await contractNavigationAccess(builder)).toEqual({page:false,configure:false,intake:false,automation:true});expect((await contractSharedConfigurationChoices(builder)).companies).toEqual([]);
 await saveContractSharedMember(admin,{id:membership.memberId,roleId:membership.roleId,userId:viewer.userId!,companyId:b.companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:true,expectedRevision:1});expect((await contractNavigationAccess(viewer)).page).toBe(false);
 await expect(withTenant(admin,tx=>tx.execute(sql`select * from app.contract_shared_configuration_company_scope()`))).rejects.toThrow();
});
it('retains named legacy readers and historical case visibility without granting moved-company current periods',async()=>{
 const actor=await ordinary(),subject=await fixedTerm();await grant(actor,['view']);const row=(await contractSharedTracker(actor)).rows[0];await openContractSharedPeriod(admin,{employmentId:subject.employmentId,sourceRevision:row.sourceRevision!});
 await setEmploymentInfo(admin,{employmentId:subject.employmentId,contractNumber:5});expect((await contractNavigationAccess(actor)).page).toBe(true);
 const legacyReader=await ordinary();await owner.db.execute(sql`insert into contract_role_assignment(tenant_id,company_id,user_id,role,valid_from,created_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,${legacyReader.userId}::uuid,'legal',${start}::date,${admin.userId}::uuid)`);
 expect((await legacy(legacyReader)).page).toBe(true);expect((await contractNavigationAccess(legacyReader)).page).toBe(true);
 const[other]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${b.tenantId}::uuid,'Fictional moved company') returning id`);
 await owner.db.execute(sql`update employment set company_id=${other.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${subject.employmentId}::uuid`);
 expect((await contractSharedTracker(legacyReader)).total).toBe(0);expect((await contractNavigationAccess(legacyReader)).page).toBe(true);
});
it('keeps a genuine decision approver and employee signer in assigned work without granting tracker navigation',async()=>{
 const f=await contractPostingFixture({future:false,payChanges:false});b=f.b;admin=f.admin;const approver=await ordinary();
 const first=f.workflow.steps[0];await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,steps:[{...first,params:{layers:[{id:randomUUID(),name:'Actual task-only approval',pick:'any',approver:{kind:'person',userId:approver.userId!}}]}},...f.workflow.steps.slice(1)]},expectedRevision:1,reason:'Fictional assigned actor without tracker authority'});
 const revision=(await contractSharedContext(f.proposer,f.caseId)).flow!.revision,preview=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision,draft:f.draft});await finishContractPostingJob(preview.jobId,f.proposer,'contract_preview');const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision,previewId:preview.previewId});await finishContractPostingJob(accepted.jobId,f.proposer,'contract_automation');
 const[approvalId]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_approval where tenant_id=${b.tenantId}::uuid and case_id=${f.caseId}::uuid`);const approval=await readContractSharedApproval(approver,approvalId.id);
 expect(approval.pendingLayerId).toBeTruthy();expect((await contractSharedWorkPage(approver,{category:'approvals'})).total).toBe(1);expect((await contractNavigationAccess(approver)).page).toBe(false);
 await actContractSharedApproval(approver,{id:approval.id,actionId:randomUUID(),layerId:approval.pendingLayerId!,revision:approval.contentRevision,hash:approval.contentHash,action:'approve',reason:'Actual assigned human approval'});
 const[event]=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='approvalsComplete' order by created_at desc,id desc limit 1`);await finishContractPostingJob(event.job,approver,'contract_automation');
 const[id]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_letter where tenant_id=${b.tenantId}::uuid and case_id=${f.caseId}::uuid`);const review=await readContractSharedLetter(f.admin,id.id);await actContractSharedLetter(f.admin,{id:review.id,actionId:randomUUID(),stepId:review.pendingAction!.stepId,revision:review.contentRevision,hash:review.contentHash!,action:'reviewed'});
 const letter=await readContractSharedLetter(f.employeeActor,id.id);expect(letter.pendingAction?.kind).toBe('sign');expect((await contractSharedWorkPage(f.employeeActor,{category:'tasks'})).items.some(task=>task.id===letter.id)).toBe(true);expect((await contractNavigationAccess(f.employeeActor)).page).toBe(false);
 await actContractSharedLetter(f.employeeActor,{id:letter.id,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,action:'signed',method:'typed',value:'Fictional Contract employee',consent:true});expect((await readContractSharedLetter(f.employeeActor,letter.id)).state).toBe('released');
},120000);

it('uses the same bounded visibility and configuration company owner for 1,000 employments in 70 companies',async()=>{
  await owner.db.execute(sql`with companies as(insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Tracker company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name),departments as(insert into department(tenant_id,company_id,name) select ${b.tenantId}::uuid,id,'Tracker department' from companies returning id,company_id),numbered as materialized(select c.id,d.id as department_id,row_number() over(order by c.legal_name) as n from companies c join departments d on d.company_id=c.id),fixture as materialized(select series.n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,c.id as company_id,c.department_id from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1),people as(insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Tracker employee '||lpad(n::text,4,'0'),'scale-'||n||'@tracker.test' from fixture),employments as(insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number) select employment_id,${b.tenantId}::uuid,person_id,company_id,${start}::date,'SCALE-'||n,${start}::date,${end}::date,4 from fixture) insert into assignment(id,tenant_id,employment_id,company_id,department_id,employment_type,valid_from) select gen_random_uuid(),${b.tenantId}::uuid,employment_id,company_id,department_id,'contract',${start}::date from fixture`);
 const all=await contractSharedTracker(admin,{limit:1});expect(all.total).toBe(1000);expect(all.companies).toHaveLength(70);
 const viewer=await ordinary(),outsider=await ordinary();await grant(viewer,['view'],all.companies[0].id);
 for(const actor of [admin,viewer,outsider]){
  const rows=await contractSharedTracker(actor,{limit:1}),navigation=await contractNavigationAccess(actor);
  expect(navigation.page).toBe(rows.total>0);expect(navigation.automation).toBe(actor.userId===admin.userId);
 }
 const single=await contractSharedTracker(viewer,{companyId:all.companies[0].id,limit:100});expect(single.total).toBe(15);
 const forbidden=await contractSharedTracker(viewer,{companyId:all.companies[1].id});expect(forbidden.total).toBe(0);
 const settings=await ordinary();await grant(settings,['access'],all.companies[0].id);const choices=await contractSharedConfigurationChoices(settings);
 expect(choices.companies).toEqual([all.companies[0]]);expect(await contractNavigationAccess(settings)).toEqual({page:true,configure:true,intake:false,automation:false});
 expect(await owner.db.execute(sql`select id from contract_case where tenant_id=${b.tenantId}::uuid`)).toEqual([]);
},180000);

it('does not invoke a generic case, document or directory fallback from the new native hint',async()=>{
 const[row]=await owner.db.execute<{body:string}>(sql`select prosrc as body from pg_proc where oid='app.contract_shared_navigation_access()'::regprocedure`);
 for(const forbidden of ['app.contract_navigation_access(', 'app.contract_case_access(', 'app.contract_document_access(', 'app.contract_shared_configuration_choices('])expect(row.body).not.toContain(forbidden);
 expect(row.body.match(/app\.contract_shared_tracker_subjects\(\)/g)).toHaveLength(1);
});
