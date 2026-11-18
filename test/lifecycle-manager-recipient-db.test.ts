/** Approved 989bdb77: Personnel employment is the email identity, including without a login. */
import { afterAll, beforeEach, expect, it } from 'vitest';
import { saveEmployeeDraft } from '../core/employee-draft';
import { onboardingList } from '../packs/lifecycle/service';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { v9Setup, v9SaveConfig, v9CreateOffboarding, v9Command, v9CaseDetail, v9Workspace, v9PlanWorkflow, onboardingContext, onboardingSaveConfig } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';
import type { PersonnelManagerRecipient } from '../lib/personnel-manager-recipient';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addDays } from '../lib/lifecycle-v9-model';
let base:Base,admin:SessionContext,subject:string,manager:string;
const day=todayInKualaLumpur();
async function hire(name:string,email:string){return hireEmployee(admin,{companyId:base.companyId,departmentId:base.deptA,positionId:base.positionId,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:name,primaryEmail:email}});}
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'lifecycle','active');admin=await entitledCtx(base);
 subject=(await hire('Fictional subject','subject@example.invalid')).employmentId;manager=(await hire('Fictional Manager','manager@example.invalid')).employmentId;
 await setReportingLine(admin,{subordinateEmploymentId:subject,managerEmploymentId:manager,lineType:'administrative',validFrom:'2026-01-01'});
 await v9Setup(admin);const native=await onboardingContext(admin);native.config.access.offboarding=[admin.userId!];await onboardingSaveConfig(admin,native.revision,native.config);
});afterAll(closeAll);
async function makeCase(){
 const config=(await v9Workspace(admin)).config!;config.checklists=config.checklists.filter(c=>c.module==='onb');config.workflows=[{id:'manager',name:'Manager message',module:'off',status:'published',trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'message',type:'notify',subject:'Fictional',body:'Fictional body',to:'supervisor',cc:[]}],description:''}];await v9SaveConfig(admin,config.revision,config);
 const id=await v9CreateOffboarding(admin,{employmentId:subject,type:'Resignation',noticeDate:day,lastDay:addDays(day,30)});await v9Command(admin,id,1,{type:'submit'});return(await v9CaseDetail(admin,id)).case;
}
async function resolved(ctx:SessionContext,id:string){return withTenant(ctx,async tx=>{const [row]=await tx.execute<{recipient:PersonnelManagerRecipient}>(sql`select app.lifecycle_personnel_manager(${id}::uuid) as recipient`);return row.recipient;});}
it('resolves the current Personnel manager without creating a login and captures the authorised mailbox',async()=>{
 const c=await makeCase();expect(await owner.client`select u.id from app_user u join employment e on e.person_id=u.person_id and e.tenant_id=u.tenant_id where e.id=${manager}::uuid`).toEqual([]);
 expect(await resolved(admin,c.id)).toEqual({employmentId:manager,name:'Fictional Manager',email:'manager@example.invalid',reason:null});
 await v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'manager'});const after=(await v9CaseDetail(admin,c.id)).case;
 expect(after.mails.filter(m=>m.workflowId==='manager')).toMatchObject([{to:['address:manager@example.invalid'],status:'pending'}]);
 const [delivery]=await owner.client`select payload from lc_v9_email_delivery where case_id=${c.id}::uuid`;expect(delivery.payload.mail.to).toEqual(['address:manager@example.invalid']);
 expect(after.supervisorDelivery).toMatchObject({name:'Fictional Manager',problem:null});
});
it('does not use the case-creation snapshot after the Personnel manager changes',async()=>{
 const c=await makeCase(),replacement=(await hire('Replacement','replacement@example.invalid')).employmentId;
 await setReportingLine(admin,{subordinateEmploymentId:subject,managerEmploymentId:replacement,lineType:'administrative',validFrom:day});
 expect(await resolved(admin,c.id)).toMatchObject({employmentId:replacement,email:'replacement@example.invalid'});
 const preview=await v9PlanWorkflow(admin,c.id,(await v9Workspace(admin)).config!.workflows.find(w=>w.id==='manager')!);expect(JSON.stringify(preview)).toContain('replacement@example.invalid');expect(JSON.stringify(preview)).not.toContain('manager@example.invalid');
 await v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'manager'});expect((await v9CaseDetail(admin,c.id)).case.mails.find(m=>m.workflowId==='manager')?.to).toEqual(['address:replacement@example.invalid']);
});
it('names the actual missing work-address problem and keeps Continue held until fixed',async()=>{
 const c=await makeCase();await owner.client`update person set primary_email='' where id=(select person_id from employment where id=${manager}::uuid)`;
 await v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'manager'});let after=(await v9CaseDetail(admin,c.id)).case;
 expect(after.runs[0].hold?.missing).toEqual([{role:'supervisor',label:'Line manager',reason:'Line manager Fictional Manager has no work email'}]);
 await owner.client`update person set primary_email='fixed@example.invalid' where id=(select person_id from employment where id=${manager}::uuid)`;
 await v9Command(admin,c.id,after.revision,{type:'retryWorkflow',workflowId:'manager'});after=(await v9CaseDetail(admin,c.id)).case;
 expect(after.mails.find(m=>m.workflowId==='manager')?.to).toEqual(['address:fixed@example.invalid']);
});
it('rejects an unrelated tenant and reports inactive manager employment without a personal-mail fallback',async()=>{
 const c=await makeCase(),foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');const foreignAdmin=await entitledCtx(foreign);
 await expect(resolved(foreignAdmin,c.id)).rejects.toMatchObject({cause:{message:expect.stringMatching(/Full lifecycle case access|unavailable/)}});
 await owner.client`update employment set terminated_on=${addDays(day,-1)}::date where id=${manager}::uuid`;
 expect(await resolved(admin,c.id)).toMatchObject({employmentId:manager,name:'Fictional Manager',email:null,reason:'inactive'});
});

it('uses a genuine pre-employment draft manager without an employee login',async()=>{
 const draft=await saveEmployeeDraft(admin,{currentStep:1,data:{profile:{fullName:'Draft joiner',primaryEmail:'draft@example.invalid'},employment:{companyId:base.companyId,reportingManagerEmploymentId:manager,departmentId:base.deptA,positionId:base.positionId,hiredOn:addDays(day,7),employmentType:'full_time'}}});
 const native=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!;expect(native.case.employmentId).toBeNull();
 expect(await resolved(admin,native.case.id)).toEqual({employmentId:manager,name:'Fictional Manager',email:'manager@example.invalid',reason:null});
 const system={...admin,userId:undefined,personId:null};
 const rows=await owner.withTenant(system,tx=>tx.execute<{recipient:PersonnelManagerRecipient}>(sql`select app.lifecycle_personnel_manager(${native.case.id}::uuid) as recipient`));
 expect(rows[0].recipient).toMatchObject({employmentId:manager,email:'manager@example.invalid'});
});

it('treats a manager ending today as inactive, while a future exit remains eligible',async()=>{
 const c=await makeCase();await owner.client`update employment set terminated_on=${day}::date where id=${manager}::uuid`;
 expect(await resolved(admin,c.id)).toMatchObject({reason:'inactive',email:null});
 await owner.client`update employment set terminated_on=${addDays(day,1)}::date where id=${manager}::uuid`;
 expect(await resolved(admin,c.id)).toMatchObject({reason:null,email:'manager@example.invalid'});
});

it('holds duplicate current manager candidates for review instead of selecting an arbitrary person',async()=>{
 const c=await makeCase(),second=(await hire('Second manager','second@example.invalid')).employmentId;
 await owner.client`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from) values(${base.tenantId}::uuid,${subject}::uuid,${second}::uuid,'administrative','2026-01-01')`;
 expect(await resolved(admin,c.id)).toEqual({employmentId:null,name:null,email:null,reason:'ambiguous'});
});

it('rechecks held supervisor recipients through the checkpointed worker without replaying on a second pass',async()=>{
 const {managerEmailRecoveryPage,requestManagerEmailRecovery,lifecycleManagerRecoveryHandler}=await import('../core/lifecycle-manager-recovery');
 const {runBulkJobTick}=await import('../core/bulk-job-worker');
 const c=await makeCase();await owner.client`update reporting_line set valid_to=${day}::date where subordinate_employment_id=${subject}::uuid`;
 await v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'manager'});
 const held=(await v9CaseDetail(admin,c.id)).case;expect(held.runs[0].hold?.missing[0].reason).toBe('no supervisor on the Personnel record');
 await owner.client`update reporting_line set valid_to=null where subordinate_employment_id=${subject}::uuid`;
 const report=await managerEmailRecoveryPage(admin);expect(report.items).toHaveLength(1);expect(report.items[0]).toMatchObject({caseId:c.id,classification:'today',revision:held.revision});
 const job=await requestManagerEmailRecovery(admin,report.items);
 for(let i=0;i<10;i++){await runBulkJobTick(owner.client,{handlers:[lifecycleManagerRecoveryHandler]});const [current]=await owner.client`select state from bulk_job where id=${job.row.id}::uuid`;if(current.state==='completed')break;}
 const [receipt]=await owner.client`select state,counters from bulk_job where id=${job.row.id}::uuid`;expect(receipt).toMatchObject({state:'completed',counters:{resumed:1}});
 const after=(await v9CaseDetail(admin,c.id)).case;expect(after.mails.filter(m=>m.workflowId==='manager')).toHaveLength(1);expect(after.runs[0].hold).toBeUndefined();
 expect((await managerEmailRecoveryPage(admin)).items).toEqual([]);
 await withTenant(admin,async tx=>{const {recoverManagerEmailHoldTx}=await import('../packs/lifecycle/v9/service');expect(await recoverManagerEmailHoldTx(tx,admin,report.items[0])).toMatchObject({outcome:'changed'});});
 expect((await v9CaseDetail(admin,c.id)).case.mails.filter(m=>m.workflowId==='manager')).toHaveLength(1);
});

it('requires an explicit revision-guarded HR decision for a late hold and never sends from the sweep',async()=>{
 const {v9Sweep}=await import('../packs/lifecycle/service');
 const c=await makeCase();await owner.client`update reporting_line set valid_to=${day}::date where subordinate_employment_id=${subject}::uuid`;
 await v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'manager'});let held=(await v9CaseDetail(admin,c.id)).case;
 held.runs[0].date=addDays(day,-1);await owner.client`update lc_v9_case set data=${JSON.stringify(held)}::jsonb where id=${c.id}::uuid`;
 await owner.client`update reporting_line set valid_to=null where subordinate_employment_id=${subject}::uuid`;
 await v9Command(admin,c.id,held.revision,{type:'retryWorkflow',workflowId:'manager'});held=(await v9CaseDetail(admin,c.id)).case;
 expect(held.runs[0].lateEmail).toMatchObject({dueOn:addDays(day,-1),stepId:'message'});expect(held.mails.filter(m=>m.workflowId==='manager')).toEqual([]);
 await v9Sweep({...admin,userId:undefined,personId:null},owner);
 held=(await v9CaseDetail(admin,c.id)).case;expect(held.mails.filter(m=>m.workflowId==='manager')).toEqual([]);
 await expect(v9Command(admin,c.id,held.revision-1,{type:'lateEmail',workflowId:'manager',runId:held.runs[0].id,stepId:'message',decision:'send'})).rejects.toThrow(/changed/);
 await v9Command(admin,c.id,held.revision,{type:'lateEmail',workflowId:'manager',runId:held.runs[0].id,stepId:'message',decision:'skip'});
 const after=(await v9CaseDetail(admin,c.id)).case;expect(after.runs[0].status).toBe('done');expect(after.mails.filter(m=>m.workflowId==='manager')).toEqual([]);expect(after.log.map(l=>l.action)).toContain('workflow.lateEmailSkipped');
});

it('SQL-pages recovery in stable order at 70 companies and 1000 employments under All companies and one company',async()=>{
 const {managerEmailRecoveryPage}=await import('../core/lifecycle-manager-recovery');const c=await makeCase();
 const started=performance.now();const timing=(phase:string)=>console.info('manager-recovery-group',phase,Math.round(performance.now()-started));
 const heldAt='2026-11-18T00:00:00.000Z',missing=[{role:'supervisor',label:'Line manager',reason:'no supervisor on the Personnel record'}];
 const run={id:'manager:once',workflowId:'manager',revision:1,date:day,status:'waiting',cursor:0,reason:'Held',at:heldAt,definition:(await v9Workspace(admin)).config!.workflows[0],hold:{stepId:'message',at:heldAt,missing}};
 await owner.client`insert into company(tenant_id,legal_name,country,currency) select ${base.tenantId}::uuid,'Fictional Recovery Company '||lpad(n::text,3,'0'),'MY','MYR' from generate_series(1,70) n`;
 await owner.client`insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'Fictional Recovery Employee '||lpad(n::text,4,'0'),'recovery-'||n||'@example.invalid' from generate_series(1,1000) n`;
 await owner.client`with people as(select id,row_number() over(order by full_name) n from person where tenant_id=${base.tenantId}::uuid and full_name like 'Fictional Recovery Employee %'),companies as(select id,row_number() over(order by legal_name)-1 n from company where tenant_id=${base.tenantId}::uuid and legal_name like 'Fictional Recovery Company %') insert into employment(tenant_id,person_id,company_id,hired_on) select ${base.tenantId}::uuid,p.id,co.id,'2026-01-01'::date from people p join companies co on co.n=(p.n-1)%70`;
 await owner.client`with subjects as(select gen_random_uuid() id,e.id employment_id,e.person_id,e.company_id,p.full_name,row_number() over(order by p.full_name) n from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.tenant_id=${base.tenantId}::uuid and p.full_name like 'Fictional Recovery Employee %')
 insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,data)
 select s.id,${base.tenantId}::uuid,s.company_id,s.employment_id,'off','RECOVERY-SCALE-'||lpad(s.n::text,4,'0'),
 ${JSON.stringify(c)}::jsonb||jsonb_build_object('id',s.id::text,'number','RECOVERY-SCALE-'||lpad(s.n::text,4,'0'),'revision',1,'runs',jsonb_build_array(${JSON.stringify(run)}::jsonb),'mails','[]'::jsonb,'facts',${JSON.stringify(c.facts)}::jsonb||jsonb_build_object('employmentId',s.employment_id::text,'personId',s.person_id::text,'company',s.company_id::text,'name',s.full_name)) from subjects s`;
 await owner.client`insert into lc_v9_email_hold(tenant_id,company_id,module,case_id,case_number,subject_name,run_id,step_id,workflow_name,email_name,missing,held_at)
 select tenant_id,company_id,'off',id,number,data->'facts'->>'name','manager:once','message','Manager message','Fictional',${JSON.stringify(missing)}::jsonb,${heldAt}::timestamptz from lc_v9_case where tenant_id=${base.tenantId}::uuid and number like 'RECOVERY-SCALE-%'`;
 timing('fixture-written');
 const [shape]=await owner.client`select count(distinct company_id)::integer companies,count(*)::integer employments from lc_v9_case where tenant_id=${base.tenantId}::uuid and number like 'RECOVERY-SCALE-%'`;expect(shape).toEqual({companies:70,employments:1000});
 const [one]=await owner.client`select company_id from lc_v9_case where tenant_id=${base.tenantId}::uuid and number='RECOVERY-SCALE-0001'`;
 const scopes:Array<{ctx:SessionContext;companyId:string|null}>=[{ctx:admin,companyId:null},{ctx:{...admin,grants:[{role:'hr_admin',companyId:one.company_id}]},companyId:one.company_id}];
 for(const scope of scopes){
  const {ctx}=scope;
  const actual:string[]=[];let after='';let firstCount:number|undefined;
  for(let page=0;page<11;page++){const result=await managerEmailRecoveryPage(ctx,after,100);firstCount??=result.remainingCount;actual.push(...result.items.map(t=>t.caseId));if(result.items.length<100||!result.after)break;after=result.after;}
  const expected=await owner.client`select id::text from lc_v9_case where tenant_id=${base.tenantId}::uuid and number like 'RECOVERY-SCALE-%' and (${scope.companyId===null} or company_id=${scope.companyId}::uuid) order by id::text`;
  timing(scope.companyId?'single-company-pages':'all-company-pages');
  expect(actual.length).toBeGreaterThan(0);expect(actual).toEqual(expected.map(r=>r.id));expect(firstCount).toBe(expected.length);expect(new Set(actual).size).toBe(actual.length);
 }
 const [managerPerson]=await owner.client`select person_id from employment where id=${manager}::uuid`;
 const unrelatedUser=await createAppUser(base.tenantId,managerPerson.person_id,'hr_admin');
 const unrelated={...admin,userId:unrelatedUser,personId:managerPerson.person_id};
 // A real HR grant alone is insufficient: this user has no Full offboarding case access.
 expect((await managerEmailRecoveryPage(unrelated)).items).toEqual([]);
 const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');
 expect((await managerEmailRecoveryPage(await entitledCtx(foreign))).items).toEqual([]);
 await expect(managerEmailRecoveryPage({...admin,userId:undefined})).rejects.toThrow('Sign in');
 expect(await resolved(admin,c.id)).toMatchObject({employmentId:manager,email:'manager@example.invalid'});
 timing('authorization-denials');
},270000); // Prior hosted aggregate exhausted 90s; 3x headroom includes fixture and both page walks. Phase timings diagnose regressions.
