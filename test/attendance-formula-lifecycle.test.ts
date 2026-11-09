import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {createPayComponent,seedPayComponentCatalog} from '../core/pay-components';
import {checkIn,checkOut,setAttendancePolicy,saveAttendanceFormula,testAttendanceFormula,activateAttendanceFormula,changeAttendanceFormulaStatus,getAttendanceFormula,attendanceFormulaSetup,listAttendanceFormulas,searchAttendanceFormulaEmployees,readAttendanceFormulaTest} from '../packs/attendance/service';
import {attendanceFormula,attendanceFormulaRevision,payComponent} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {AttendanceFormulaConfiguration} from '../lib/attendance-formula-model';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
async function fixture(){const ctx=adminCtx(base),date=todayInKualaLumpur();const hired=await hireEmployee(ctx,{person:{fullName:'Fictional formula lifecycle employee',primaryEmail:'formula-lifecycle@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});await setAttendancePolicy(ctx,{companyId:base.companyId,workStart:'09:00',workEnd:'17:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});await checkIn(ctx,{employmentId:hired.employmentId,date,time:'09:00'});await checkOut(ctx,{employmentId:hired.employmentId,date,time:'19:00'});await seedPayComponentCatalog(ctx);const [item]=await owner.db.select().from(payComponent).where(eq(payComponent.code,'ATTENDANCE'));expect(item).toBeTruthy();const configuration:AttendanceFormulaConfiguration={code:'WORKED_HOURS',description:'Fictional reference earning only',companyId:base.companyId,payItemId:item.id,effectiveFrom:'2024-01-01',period:{method:'daily'},outputUnit:'amount',purpose:'earning',eligibility:{mode:'all'},posting:{kind:'exclusive'},library:{conditions:[],formulas:[{code:'WORKED_HOURS',source:'Return {#FormulaID}("TotalWorkingMins") / 60 * 10'}]}};return {ctx,date,employmentId:hired.employmentId,configuration};}
async function saved(){const f=await fixture();const version=await saveAttendanceFormula(f.ctx,{configuration:f.configuration});return {...f,...version};}
describe('native Attendance formula lifecycle',()=>{
 it('saves immutable versions, tests actual attendance, explicitly activates and retains archive history',async()=>{const f=await saved();expect((await getAttendanceFormula(f.ctx,f.id)).status).toBe('inactive');const proof=await testAttendanceFormula(f.ctx,{...f});expect(proof.passed).toBe(true);expect((proof.payload.result as {amount:string}).amount).toBe('100');await activateAttendanceFormula(f.ctx,{...f,testId:proof.id});expect((await getAttendanceFormula(f.ctx,f.id)).activeRevisionId).toBe(f.revisionId);await changeAttendanceFormulaStatus(f.ctx,{id:f.id,command:'deactivate',reason:'Fictional test deactivation'});expect((await getAttendanceFormula(f.ctx,f.id)).status).toBe('inactive');await changeAttendanceFormulaStatus(f.ctx,{id:f.id,command:'archive',reason:'Retain this fictional version history'});const retained=await getAttendanceFormula(f.ctx,f.id);expect(retained.status).toBe('archived');expect(retained.versions).toHaveLength(1);expect(retained.tests).toHaveLength(1);await expect(saveAttendanceFormula(f.ctx,{id:f.id,expectedRevisionId:f.revisionId,configuration:f.configuration})).rejects.toThrow(/archived/);});
 it('refuses native activation without an actual successful test',async()=>{const f=await saved();await expect(withTenant(f.ctx,tx=>tx.execute(sql`insert into attendance_formula_event(tenant_id,company_id,formula_id,revision_id,test_id,kind,created_by) values(${base.tenantId}::uuid,${base.companyId}::uuid,${f.id}::uuid,${f.revisionId}::uuid,gen_random_uuid(),'activated',${f.ctx.userId!}::uuid)`))).rejects.toThrow();expect((await getAttendanceFormula(f.ctx,f.id)).status).toBe('inactive');});
 it('refuses stale actual attendance and an old version',async()=>{const f=await saved(),proof=await testAttendanceFormula(f.ctx,{...f});await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time:'20:00'});await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time:'21:00'});await expect(activateAttendanceFormula(f.ctx,{...f,testId:proof.id})).rejects.toThrow(/changed/);const changed={...f.configuration,description:'Second immutable definition'};await saveAttendanceFormula(f.ctx,{id:f.id,expectedRevisionId:f.revisionId,configuration:changed});await expect(activateAttendanceFormula(f.ctx,{...f,testId:proof.id})).rejects.toThrow(/current/);});
 it('serializes concurrent saves against one expected version',async()=>{const f=await saved();const outcomes=await Promise.allSettled(['First','Second'].map(description=>saveAttendanceFormula(f.ctx,{id:f.id,expectedRevisionId:f.revisionId,configuration:{...f.configuration,description}})));expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(outcome=>outcome.status==='rejected')).toHaveLength(1);expect((await getAttendanceFormula(f.ctx,f.id)).versions).toHaveLength(2);});
 it('denies a real foreign tenant and makes every recorded version append-only',async()=>{const f=await saved(),other=await seedBase(),foreign=adminCtx(other);await expect(getAttendanceFormula(foreign,f.id)).rejects.toThrow();expect(await withTenant(foreign,tx=>tx.select().from(attendanceFormula).where(eq(attendanceFormula.id,f.id)))).toEqual([]);await expect(owner.db.update(attendanceFormulaRevision).set({contentHash:'a'.repeat(64)}).where(eq(attendanceFormulaRevision.id,f.revisionId))).rejects.toThrow();});
});

it('lists only scoped formula metadata, searches actual identities and reads private evidence on demand',async()=>{
 const f=await saved(),options=await attendanceFormulaSetup(f.ctx,[base.companyId]);expect(options.companies.map(row=>row.id)).toContain(base.companyId);expect(options.payItems.map(row=>row.id)).toContain(f.configuration.payItemId);
 const rows=await listAttendanceFormulas(f.ctx,{companyIds:[base.companyId],query:'WORKED'});expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({code:'WORKED_HOURS',status:'inactive'});expect(JSON.stringify(rows)).not.toContain('TotalWorkingMins');
 const choices=await searchAttendanceFormulaEmployees(f.ctx,{id:f.id,revisionId:f.revisionId,date:f.date,query:'Fictional formula lifecycle',page:1});expect(choices.rows.map(row=>row.id)).toEqual([f.employmentId]);
 const proof=await testAttendanceFormula(f.ctx,{...f}),detail=await readAttendanceFormulaTest(f.ctx,{id:f.id,testId:proof.id});expect(detail.payload).toEqual(proof.payload);const savedView=await getAttendanceFormula(f.ctx,f.id);expect(savedView.tests[0]).not.toHaveProperty('payload');expect(savedView.latest.registryVersion).toBeTruthy();expect(savedView.latest.evaluatorVersion).toBeTruthy();
 await expect(searchAttendanceFormulaEmployees(f.ctx,{id:f.id,revisionId:'10000000-0000-4000-8000-000000000099',date:f.date,query:'',page:1})).rejects.toThrow(/current/);
});
it('permits historical validation of a future-effective rule without applying pay',async()=>{
 const f=await fixture(),version=await saveAttendanceFormula(f.ctx,{configuration:{...f.configuration,effectiveFrom:'2099-01-01'}});
 const proof=await testAttendanceFormula(f.ctx,{...f,...version});expect(proof.passed).toBe(true);expect((await getAttendanceFormula(f.ctx,version.id)).status).toBe('inactive');
});

it('distinguishes the current saved revision from a still-active prior version',async()=>{
 const f=await saved(),proof=await testAttendanceFormula(f.ctx,{...f});await activateAttendanceFormula(f.ctx,{...f,testId:proof.id});
 await saveAttendanceFormula(f.ctx,{id:f.id,expectedRevisionId:f.revisionId,configuration:{...f.configuration,description:'Fictional next-version draft'}});
 const view=await getAttendanceFormula(f.ctx,f.id);expect(view.latest.ordinal).toBe(2);expect(view.activeOrdinal).toBe(1);expect(view.activeRevisionId).toBe(f.revisionId);
});

async function secondEmployer(f: Awaited<ReturnType<typeof fixture>>) {
 const {company,department,appUser,roleAssignment}=await import('../db/schema');
 const [employer]=await owner.db.insert(company).values({tenantId:base.tenantId,legalName:'Fictional formula company B'}).returning();
 const [dept]=await owner.db.insert(department).values({tenantId:base.tenantId,companyId:employer.id,name:'Operations'}).returning();
 const worker=await hireEmployee(f.ctx,{person:{fullName:'Fictional company B employee',primaryEmail:'formula-company-b@example.test'},companyId:employer.id,departmentId:dept.id,employmentType:'full_time',hiredOn:'2024-01-01'});
 const [user]=await owner.db.insert(appUser).values({tenantId:base.tenantId,workosUserId:'fictional-attendance-company-b'}).returning();
 await owner.db.insert(roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:employer.id,role:'hr_admin'});
 const scoped={...f.ctx,userId:user.id,grants:[{role:'hr_admin' as const,companyId:employer.id}]};
 await setAttendancePolicy(f.ctx,{companyId:employer.id,workStart:'09:00',workEnd:'17:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
 await checkIn(f.ctx,{employmentId:worker.employmentId,date:f.date,time:'09:00'});
 await checkOut(f.ctx,{employmentId:worker.employmentId,date:f.date,time:'17:00'});
 return {id:employer.id,employmentId:worker.employmentId,scoped};
}

it('uses one formula identity for two dated companies without exposing the other company’s authoring and test records',async()=>{
 const f=await fixture(),second=await secondEmployer(f);
 const {attendanceFormulaChoicesForDay,calculateAttendanceFormulaResult,listAttendanceFormulaResults}=await import('../packs/attendance/service');
 const companyIds=[base.companyId,second.id].sort();
 expect((await attendanceFormulaSetup(f.ctx,companyIds)).canSelectAll).toBe(true);
 expect((await attendanceFormulaSetup(second.scoped,[second.id])).canSelectAll).toBe(false);
 const configuration={...f.configuration,companyScope:{mode:'all' as const,companyIds},
  eligibility:{mode:'selected' as const,employmentIds:[f.employmentId,second.employmentId]}};
 const version=await saveAttendanceFormula(f.ctx,{configuration});
 const proof=await testAttendanceFormula(f.ctx,{...version,employmentId:second.employmentId,date:f.date});
 expect(proof.companyId).toBe(second.id);
 await activateAttendanceFormula(f.ctx,{...version,testId:proof.id});
 expect((await getAttendanceFormula(f.ctx,version.id)).latest.definition.companyScope).toEqual(configuration.companyScope);
 await expect(getAttendanceFormula(second.scoped,version.id)).rejects.toThrow(/scope/);
 const choices=await attendanceFormulaChoicesForDay(second.scoped,{employmentId:second.employmentId,date:f.date,companyIds:[second.id]});
 expect(choices.map(row=>row.id)).toEqual([version.id]);
 const calculated=await calculateAttendanceFormulaResult(second.scoped,{...version,employmentId:second.employmentId,date:f.date,companyIds:[second.id]});
 expect(calculated).toMatchObject({formulaId:version.id,companyId:second.id,amount:'80.00'});
 expect((await listAttendanceFormulaResults(second.scoped,{employmentId:second.employmentId,date:f.date}))[0].code).toBe(configuration.code);
 const [execution]=await withTenant(second.scoped,tx=>tx.execute<{definition:{eligibility:{employmentIds:string[]};companyScope?:unknown}}>(sql`
  select definition from app.attendance_formula_subject_versions(${second.id}::uuid,${second.employmentId}::uuid,${f.date}::date)`));
 expect(execution.definition.eligibility.employmentIds).toEqual([second.employmentId]);
 expect(execution.definition).not.toHaveProperty('companyScope');
 await expect(calculateAttendanceFormulaResult(second.scoped,{...version,employmentId:f.employmentId,date:f.date,companyIds:[second.id]})).rejects.toThrow();

 const {setModule,entitledCtx}=await import('./harness');
 const {createBatch,transferAttendanceFormulaResults}=await import('../packs/payroll/service');
 const {reviewAttendanceFormulaResult}=await import('../packs/attendance/service');
 await setModule(base.tenantId,'typed_pay_components','active');
 const payrollAdmin=await entitledCtx(base);
 const firstResult=await calculateAttendanceFormulaResult(payrollAdmin,{...version,employmentId:f.employmentId,date:f.date});
 for(const result of [firstResult,calculated]){
  await reviewAttendanceFormulaResult(payrollAdmin,{resultId:result.id,command:'review',reason:'Checked Attendance evidence'});
  await reviewAttendanceFormulaResult(payrollAdmin,{resultId:result.id,command:'approve',reason:'Approved company result'});
  const {batchId}=await createBatch(payrollAdmin,{companyId:result.companyId,payPeriod:f.date.slice(0,7)});
  const posted=await transferAttendanceFormulaResults(payrollAdmin,{batchId,resultIds:[result.id],reason:'Transfer company result'});
  expect(posted.posted).toEqual([result.id]);
 }
});

it('rejects incomplete All Companies coverage, a company-limited Pay Item and overlapping exclusive activation',async()=>{
 const f=await fixture(),second=await secondEmployer(f);
 const companyIds=[base.companyId,second.id];
 const all={...f.configuration,companyScope:{mode:'all' as const,companyIds}};
 await expect(saveAttendanceFormula(f.ctx,{configuration:{...all,companyScope:{mode:'all',companyIds:[base.companyId]}}}))
  .rejects.toMatchObject({cause:expect.objectContaining({code:'AF002'})});
 const limited=await createPayComponent(f.ctx,{code:'LIMITED_FORMULA_PAY',name:'Company A earning',label:'Company A',kind:'allowance',
  includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false,
  appliedCompanyIds:[base.companyId]});
 await expect(saveAttendanceFormula(f.ctx,{configuration:{...all,payItemId:limited.id}})).rejects.toThrow(/every selected company/);
 const first=await saveAttendanceFormula(f.ctx,{configuration:all});
 const firstProof=await testAttendanceFormula(f.ctx,{...first,employmentId:f.employmentId,date:f.date});
 await activateAttendanceFormula(f.ctx,{...first,testId:firstProof.id});
 const code='SECOND_RULE';
 const duplicate=await saveAttendanceFormula(f.ctx,{configuration:{...f.configuration,code,companyScope:{mode:'selected',companyIds:[second.id]},library:{formulas:[{code,source:'Return 1'}],conditions:[]}}});
 const proof=await testAttendanceFormula(f.ctx,{...duplicate,employmentId:second.employmentId,date:f.date});
 await expect(activateAttendanceFormula(f.ctx,{...duplicate,testId:proof.id})).rejects.toThrow(/overlaps/);
 expect((await getAttendanceFormula(f.ctx,duplicate.id)).status).toBe('inactive');
});
