/** Actual two-connection cases for the four automatic Attendance parents ADR-0131 listed as still
 * requiring owner integration: checkOutTx, the attendance-correction decision, approved-plan
 * application and imported-punch batches. Authored UNRUN until a database run records otherwise.
 *
 * ORDER: each parent must already own Access, exclusive leave configuration and the employee interval
 * while it is WAITING for the existing Attendance/credit subject key, i.e. before its protected reads,
 * Payroll/credit locks and row locks. A real holder of that subject key forces the observed wait; the
 * probes then read the actual advisory ownership. A parent that took the subject key first would be
 * observed waiting while the leave keys are still free, and the probes would fail.
 *
 * PLAN: an approved, not-yet-landed overtime plan must neither land nor bank Leave Credit while a leave
 * interval is held, at clock-out or through an imported-punch batch, and must land exactly once after
 * release. No mocked lock, schedule, authority or writer; fictional employees only. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setRestDay} from '../core/roster';
import {setToilPolicy} from '../core/toil';
import {checkInTx,checkOutTx,setAttendancePolicy,requestAttendanceCorrection,decideAttendanceCorrection} from '../core/attendance';
import {commitClockingImport} from '../core/attendance-clocking-import';
import {lockLeaveDependenciesTx} from '../packs/leave/service';
import {BUILTIN_MAPPING_ID} from '../lib/clocking-file';
import {addDaysIso} from '../lib/roster-month';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,entitledCtx,setModule,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
// A worked day derived from the clock: past (clocking files refuse future dates) and never pinned.
const date=addDaysIso(todayInKualaLumpur(),-21);
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function fixture(){
 const admin=adminCtx(b),e=await hireEmployee(admin,{person:{fullName:'Fictional Automatic Attendance Subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 const self:SessionContext={...admin,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const [employee]=await owner.db.select({code:s.employment.employeeCode}).from(s.employment).where(eq(s.employment.id,e.employmentId));
 expect(employee?.code).toBeTruthy();
 return {...e,admin,self,code:employee.code};
}
async function state(){
 const tables=['attendance','attendance_punch','attendance_clock_capture','attendance_correction','toil_accrual','leave_ledger','payroll_batch','attendance_day_adjustment','attendance_policy','leave_type','attendance_workflow_request','attendance_workflow_decision','attendance_workflow_participant_decision'];
 const result:Record<string,unknown>={};
 for(const table of tables){const [row]=await owner.db.execute<{image:unknown}>(sql`select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) as image from ${sql.raw(table)} r where r.tenant_id=${b.tenantId}::uuid`);result[table]=row.image;}
 // Imports deliberately retain a failed run/audit after rollback; those logs are not Attendance effects.
 const [events]=await owner.db.execute<{image:unknown}>(sql`select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) as image from domain_event r where r.tenant_id=${b.tenantId}::uuid and r.aggregate_type<>'attendance-clocking-import'`);
 result.events=events.image;return result;
}
/** Ordinary participating leave interval on one real employee, released only by the test. */
async function held(employmentId:string,work:()=>Promise<void>){
 let ready!:()=>void,fail!:(e:unknown)=>void,release!:()=>void;
 const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const timer=setTimeout(()=>{fail(Error('owned automatic Attendance handshake timed out'));release();},10000);
 const holder=withTenant(adminCtx(b),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[employmentId]);ready();await finish;});void holder.catch(fail);
 try{await started;await work();}finally{release();clearTimeout(timer);await holder;}
}
const subjectKey=(employmentId:string)=>`${b.tenantId}:${employmentId}`;
/** Holds ONLY the existing Attendance/Payroll credit subject key that every automatic parent takes
 * after its leave interval. It holds no Access or leave key, so it cannot refuse a parent by itself. */
async function holdSubjectKey(employmentId:string){
 let ready!:(pid:number)=>void,fail!:(e:unknown)=>void,release!:()=>void;
 const started=new Promise<number>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const timer=setTimeout(()=>{fail(Error('Attendance subject-key handshake timed out'));release();},10000);
 const done=withTenant(adminCtx(b),async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${subjectKey(employmentId)},0))`);
  const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(row.pid);await finish;
 });void done.catch(fail);
 const stop=async()=>{release();clearTimeout(timer);await done;};
 try{return {pid:await started,stop};}catch(error){await stop().catch(()=>{});throw error;}
}
/** Positively observes the parent queued on that exact subject key behind the holder. */
async function observedSubjectWait(holderPid:number,employmentId:string,parent:Promise<unknown>){
 let settled=false;void parent.then(()=>{settled=true;},()=>{settled=true;});
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  if(settled)throw Error('The Attendance parent settled before its subject-key wait was observed');
  const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(
   select 1 from pg_locks l where l.locktype='advisory' and not l.granted and l.objsubid=1
   and l.database=(select oid from pg_database where datname=current_database())
   and ((l.classid::bigint << 32) | l.objid::bigint)=hashtextextended(${subjectKey(employmentId)},0)
   and ${holderPid}::integer=any(pg_blocking_pids(l.pid))) as waiting`);
  if(row?.waiting)return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('No actual Attendance subject-key wait was observed');
}
/** True when another session owns the key in a conflicting mode. A successful probe commits at once. */
async function ownedElsewhere(key:string,shared=false){
 return owner.db.transaction(async tx=>{
  const [row]=await tx.execute<{acquired:boolean}>(shared?sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) as acquired`
   :sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`);
  return row?.acquired!==true;
 });
}
/** An OT-only plan approved ahead of its worked day. The deferral discriminator is the decision date. */
async function approvedPlan(ctx:SessionContext,employmentId:string){
 const {correctionId}=await requestAttendanceCorrection(ctx,{employmentId,date,requestedOtMinutes:240,reason:'Fictional pre-approved overtime',plannedStartTime:'18:00',plannedEndTime:'21:00',otReasonCategory:'project_deadline'});
 expect(await decideAttendanceCorrection(ctx,{correctionId,decision:'approved',today:addDaysIso(date,-1)})).toMatchObject({status:'approved',deferred:true});
 const [plan]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,correctionId));
 expect(plan.appliedAt).toBeNull();
 return correctionId;
}
const planRow=async(id:string)=>(await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,id)))[0];
describe('automatic Attendance parents own the leave interval before the Attendance/credit subject key',()=>{
 it.each(['out','decide','import'] as const)('%s holds Access, exclusive configuration and the employee while queued on the subject key, then completes once released',async command=>{
  const f=await fixture();let correctionId='';
  if(command!=='import')await checkInTx(f.admin,{employmentId:f.employmentId,date,time:'08:00',manual:true});
  if(command==='decide'){
   await checkOutTx(f.admin,{employmentId:f.employmentId,date,time:'17:00',manual:true});
   correctionId=(await requestAttendanceCorrection(f.self,{employmentId:f.employmentId,date,checkIn:'09:00',checkOut:'18:00',reason:'Fictional verified clock correction'})).correctionId;
  }
  const text=`staff,time\n${f.code},${date} 08:00\n${f.code},${date} 17:00`;
  const run=():Promise<unknown>=>{switch(command){
   case 'out':return withTenant(f.admin,tx=>checkOutTx(f.admin,{employmentId:f.employmentId,date,time:'17:00',manual:true},tx));
   case 'decide':return decideAttendanceCorrection(f.admin,{correctionId,decision:'approved'});
   case 'import':return commitClockingImport(f.admin,{mappingId:BUILTIN_MAPPING_ID,text,fileName:'fictional-order.csv',fileBytes:Buffer.byteLength(text)});
  }};
  const tenant=b.tenantId.toLowerCase(),employee=f.employmentId.toLowerCase();
  const before=await state(),holder=await holdSubjectKey(f.employmentId);let parent:Promise<unknown>|undefined;
  try{
   parent=run();void parent.catch(()=>{});
   await observedSubjectWait(holder.pid,f.employmentId,parent);
   expect(await ownedElsewhere(`access-configuration:${b.tenantId}`)).toBe(true);
   // Shared probe conflicts only with an EXCLUSIVE configuration owner: Attendance can bank TOIL.
   expect(await ownedElsewhere(`leave-dependency-configuration:${tenant}`,true)).toBe(true);
   expect(await ownedElsewhere(`leave-dependency-employment:${tenant}:${employee}`)).toBe(true);
   await expect(withTenant(adminCtx(b),tx=>lockLeaveDependenciesTx(tx,b.tenantId,[f.employmentId]))).rejects.toThrow('Leave source is unavailable');
   expect(await state()).toEqual(before);
  }finally{await holder.stop();}
  const outcome=await parent!;expect(await state()).not.toEqual(before);
  if(command==='decide')expect((await planRow(correctionId)).status).toBe('approved');
  if(command==='import'){
   expect(outcome).toMatchObject({imported:2});
   expect(await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId))).toHaveLength(2);
  }
 });
});
describe('approved-plan application joins through its automatic parents',()=>{
 it('clock-out neither lands the plan nor banks Leave Credit while held, then lands and banks exactly once',async()=>{
  const f=await fixture();await setModule(b.tenantId,'toil','active');const admin=await entitledCtx(b,['hr_admin']);
  await setCompensation(admin,{employmentId:f.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
  // The agreed figure, not the clocked one, resolves on landing: the credit amount is then deterministic.
  await setAttendancePolicy(admin,{companyId:b.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5],otApprovalCalculation:'requested'});
  await setToilPolicy(admin,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:true,carryForwardAtYearEnd:false});
  await setRestDay(admin,{employmentId:f.employmentId,shiftDate:date});
  const correctionId=await approvedPlan(admin,f.employmentId);
  await checkInTx(admin,{employmentId:f.employmentId,date,time:'08:00',manual:true});
  const out=(time:string)=>withTenant(admin,tx=>checkOutTx(admin,{employmentId:f.employmentId,date,time,manual:true},tx));
  const before=await state();
  await held(f.employmentId,async()=>{await expect(out('17:00')).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);});
  await out('17:00');
  const landed=await planRow(correctionId);expect(landed.appliedAt).not.toBeNull();expect(landed.approvedOtMinutes).not.toBeNull();
  const credits=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId));
  expect(credits).toHaveLength(1);expect(credits[0].workedDate).toBe(date);expect(Number(credits[0].daysCredited)).toBeGreaterThan(0);
  // A later clock pair re-asserts the landed figure; it is neither a second landing nor a second credit.
  await checkInTx(admin,{employmentId:f.employmentId,date,time:'18:00',manual:true});await out('19:00');
  expect((await planRow(correctionId)).appliedAt).toEqual(landed.appliedAt);
  expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toEqual(credits);
 });
 it('an imported-punch batch refuses before mapping/day/plan effects while held, then lands the plan once',async()=>{
  const f=await fixture();const correctionId=await approvedPlan(f.admin,f.employmentId);
  const text=`staff,time\n${f.code},${date} 09:00\n${f.code},${date} 20:00`;
  const p={mappingId:BUILTIN_MAPPING_ID,text,fileName:'fictional-plan-barrier.csv',fileBytes:Buffer.byteLength(text)};
  const before=await state();
  await held(f.employmentId,async()=>{const failed=await commitClockingImport(f.admin,p);expect(failed.status).toBe('failed');expect(failed.imported).toBe(0);expect(await state()).toEqual(before);});
  expect((await commitClockingImport(f.admin,p)).imported).toBe(2);
  const landed=await planRow(correctionId);expect(landed.appliedAt).not.toBeNull();expect(landed.approvedOtMinutes).not.toBeNull();
  const punches=await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId));expect(punches).toHaveLength(2);
  expect((await commitClockingImport(f.admin,p)).imported).toBe(0);
  expect(await planRow(correctionId)).toEqual(landed);
  expect(await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId))).toEqual(punches);
 });
});
