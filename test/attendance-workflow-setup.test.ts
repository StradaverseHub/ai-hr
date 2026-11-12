import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {saveAttendanceWorkflow,retireAttendanceWorkflow,getAttendanceWorkflow,attendanceWorkflowWarningPage,listRetiredAttendanceWorkflows} from '../core/attendance-workflow';
import {validateAnyAttendanceWorkflow,attendanceWorkflowConfiguration} from '../lib/attendance-workflow-config';
import {hireEmployee} from '../core/org';
import {adminCtx,migrateTestDb,resetDb,seedBase,closeAll,owner,createAppUser,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const input=()=>({companyId:b.companyId,applicationType:'irregularity' as const,code:'SETUP',name:'Setup workflow',priority:100,criteria:{},stages:[{name:'Review',level:{kind:'hr_admin' as const,employmentId:null,alternates:[]}}],active:false});
describe('durable attendance workflow setup',()=>{
 it('keeps legacy explicit scopes and rejects non-boolean all-company intent',()=>{
  const parsed=validateAnyAttendanceWorkflow(input());expect(parsed.allCompanies).toBe(false);
  expect(attendanceWorkflowConfiguration({...input(),routingVersion:1,description:null}).allCompanies).toBe(false);
  expect(()=>validateAnyAttendanceWorkflow({...input(),allCompanies:'true'})).toThrow();
 });
 it('applies an all-company workflow to future companies without adding a new assignment',async()=>{
  const ctx=adminCtx(b),flow=await saveAttendanceWorkflow(ctx,{...input(),allCompanies:true,active:true});
  const [future]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Future company',country:'MY',currency:'MYR'}).returning();
  const [result]=await withTenant(ctx,tx=>tx.execute<{applies:boolean;companies:string[]}>(sql`select app.attendance_workflow_applies(${flow.id}::uuid,${future.id}::uuid) applies,app.attendance_workflow_companies(${flow.id}::uuid) companies`));
  const [setting]=await owner.db.select().from(schema.attendanceWorkflowSetting).where(eq(schema.attendanceWorkflowSetting.companyId,future.id));expect(setting).toMatchObject({applicationType:'irregularity',enabled:true});
  expect(result.applies).toBe(true);expect(result.companies).toContain(future.id);
  const reopened=await getAttendanceWorkflow(ctx,flow.lineageId,[future.id]);expect(reopened?.allCompanies).toBe(true);
  expect((await owner.db.select().from(schema.attendanceWorkflowCompany).where(eq(schema.attendanceWorkflowCompany.templateId,flow.id))).map(row=>row.companyId)).not.toContain(future.id);
 });
 it('refuses future-company authority for an administrator scoped only to the current company',async()=>{
  const userId=await createAppUser(b.tenantId,null,'hr_admin');
  await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,userId));
  const scoped={...adminCtx(b),userId,grants:[{role:'hr_admin' as const,companyId:b.companyId}]};
  await expect(saveAttendanceWorkflow(scoped,{...input(),allCompanies:true})).rejects.toMatchObject({code:'scope'});
 });
 it('permanently removes every unused version and records deletion without a retained item',async()=>{
  const ctx=adminCtx(b),first=await saveAttendanceWorkflow(ctx,input());
  const second=await saveAttendanceWorkflow(ctx,{...input(),name:'New unused definition'},first.lineageId);
  await retireAttendanceWorkflow(ctx,first.lineageId,second.version);
  expect(await getAttendanceWorkflow(ctx,first.lineageId,[b.companyId],true)).toBeNull();
  expect(await listRetiredAttendanceWorkflows(ctx,[b.companyId])).toEqual([]);
  expect(await owner.db.select().from(schema.attendanceWorkflowTemplate).where(eq(schema.attendanceWorkflowTemplate.lineageId,first.lineageId))).toEqual([]);
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,first.lineageId));
  expect(events.filter(row=>row.eventType==='attendance-workflow-template.deleted')).toHaveLength(1);
 });
 it('saves missing-superior readiness as a warning with employee identity and approval level',async()=>{
  const ctx=adminCtx(b),employee=await hireEmployee(ctx,{person:{fullName:'Missing superior employee',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  await createAppUser(b.tenantId,employee.personId,'employee');
  const flow=await saveAttendanceWorkflow(ctx,{...input(),routingVersion:4,criteria:{employeeIds:[employee.employmentId]},stages:[{name:'Level 1',mode:'any_one',sources:[{kind:'direct_manager',depth:1}],hrAlternative:false}],cc:[],active:true});
  // 4452ba3c: Save checks the configuration only; the per-employee readiness warning is a preview result.
  expect(flow).not.toHaveProperty('warningCount');
  const warnings=await attendanceWorkflowWarningPage(ctx,flow.lineageId,[b.companyId]);
  expect(warnings).toMatchObject({total:1,hasMore:false,rows:[{employmentId:employee.employmentId,name:'Missing superior employee',levelIndex:0,problem:{code:'missing_superior'}}]});
 });
 it('does not treat a forged selected employee as a correctable warning',async()=>{
  await expect(saveAttendanceWorkflow(adminCtx(b),{...input(),routingVersion:4,stages:[{name:'Level 1',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:[randomUUID()]}],hrAlternative:false}],cc:[]})).rejects.toMatchObject({problem:{code:'employee_unavailable'}});
 });
});

it('initialises absent routing switches but preserves an explicit off switch',async()=>{
 const ctx=adminCtx(b);
 await owner.db.insert(schema.attendanceWorkflowSetting).values({tenantId:b.tenantId,companyId:b.companyId,applicationType:'irregularity',enabled:false});
 await saveAttendanceWorkflow(ctx,{...input(),allCompanies:true,active:true});
 const [setting]=await owner.db.select().from(schema.attendanceWorkflowSetting).where(eq(schema.attendanceWorkflowSetting.companyId,b.companyId));expect(setting.enabled).toBe(false);
});

/** Real independent transactions, held until an observed advisory wait establishes the overlap.
 * Completion alone would not establish the race: either writer could otherwise finish first. */
describe('first all-company workflow and new company commit ordering',()=>{
 const futureSetting=async(companyId:string,type:'irregularity'|'self_overtime')=>{
  const rows=await owner.db.select().from(schema.attendanceWorkflowSetting).where(eq(schema.attendanceWorkflowSetting.companyId,companyId));
  expect(rows).toEqual([expect.objectContaining({tenantId:b.tenantId,companyId,applicationType:type,enabled:true})]);
 };
 const waitBehind=async(pid:number)=>{
  await expect.poll(async()=>{
   const [state]=await owner.db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_stat_activity a where ${pid}=any(pg_blocking_pids(a.pid)) and a.wait_event_type='Lock' and a.wait_event='advisory') blocked`);
   return state.blocked;
  },{timeout:5000,interval:10}).toBe(true);
 };
 it.each(['irregularity','self_overtime'] as const)('initialises %s when the global definition commits before the waiting company',async applicationType=>{
  const ctx=adminCtx(b);let companyWrite:Promise<{id:string}>|undefined;
  try{
   await withTenant(ctx,async tx=>{
    const [backend]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);
    await tx.insert(schema.attendanceWorkflowTemplate).values({...input(),tenantId:b.tenantId,applicationType,allCompanies:true,active:true,lineageId:randomUUID(),version:1});
    // The active definition and its initial settings are still uncommitted. A company
    // transaction must wait, then read the committed definition rather than its old snapshot.
    companyWrite=owner.db.transaction(async other=>{
     await other.execute(sql`set local statement_timeout='10s'`);
     const [row]=await other.insert(schema.company).values({tenantId:b.tenantId,legalName:'Concurrent future company',country:'MY',currency:'MYR'}).returning({id:schema.company.id});return row;
    });
    const observed=companyWrite.then(value=>({value}),error=>({error}));
    await waitBehind(backend.pid);
    expect(await owner.db.select().from(schema.attendanceWorkflowTemplate).where(eq(schema.attendanceWorkflowTemplate.code,'SETUP'))).toEqual([]);
    // Keep a rejection handler attached while the held transaction commits or rolls back.
    void observed;
   });
   const company=await companyWrite!;await futureSetting(company.id,applicationType);
  }finally{if(companyWrite)await Promise.allSettled([companyWrite]);}
 });
 it.each(['irregularity','self_overtime'] as const)('initialises %s when the company commits before the waiting global definition',async applicationType=>{
  let saving:ReturnType<typeof saveAttendanceWorkflow>|undefined;let futureId='';
  try{
   await owner.db.transaction(async tx=>{
    await tx.execute(sql`set local statement_timeout='10s'`);
    const [backend]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);
    const [company]=await tx.insert(schema.company).values({tenantId:b.tenantId,legalName:'Company before first global definition',country:'MY',currency:'MYR'}).returning({id:schema.company.id});futureId=company.id;
    // Company creation found no active global definition, but holds both type barriers.
    // The first active global writer must wait and then include this newly committed company.
    saving=saveAttendanceWorkflow(adminCtx(b),{...input(),applicationType,allCompanies:true,active:true});
    const observed=saving.then(value=>({value}),error=>({error}));
    await waitBehind(backend.pid);
    expect(await owner.db.select().from(schema.attendanceWorkflowTemplate).where(eq(schema.attendanceWorkflowTemplate.code,'SETUP'))).toEqual([]);
    void observed;
   });
   await saving!;await futureSetting(futureId,applicationType);
  }finally{if(saving)await Promise.allSettled([saving]);}
 });
});
