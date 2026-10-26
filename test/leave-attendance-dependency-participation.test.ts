/** Actual two-connection root-owner cases, authored UNRUN. This fixture proves Attendance root
 * participation/no effects on a held leave interval; existing TOIL suites must separately prove
 * actual credit eligibility/arithmetic. No mocked lock, schedule, authority or writer. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setRestDay} from '../core/roster';
import {setToilPolicy} from '../core/toil';
import {checkInTx,checkOutTx,requestAttendanceCorrection,decideAttendanceCorrection,cancelOwnAttendanceCorrection,cancelAttendanceApplication} from '../core/attendance';
import {captureEmployeeClock} from '../core/attendance-clock';
import {commitClockingImport} from '../core/attendance-clocking-import';
import {attendanceDayEditor,amendExistingAttendanceApplication} from '../packs/attendance/day-adjustment';
import {lockLeaveDependenciesTx} from '../packs/leave/service';
import {BUILTIN_MAPPING_ID} from '../lib/clocking-file';
import {adminCtx,entitledCtx,setModule,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
const date='2026-07-15';
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function fixture(){
 const admin=adminCtx(b),e=await hireEmployee(admin,{person:{fullName:'Fictional Attendance Barrier Subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 const self:SessionContext={...admin,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {admin,self,...e};
}
async function state(){
 const tables=['attendance','attendance_punch','attendance_clock_capture','attendance_correction','toil_accrual','leave_ledger','payroll_batch','attendance_day_adjustment','leave_type','attendance_workflow_request','attendance_workflow_decision','attendance_workflow_participant_decision'];
 const result:Record<string,unknown>={};
 for(const table of tables){const [row]=await owner.db.execute<{image:unknown}>(sql`select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) as image from ${sql.raw(table)} r where r.tenant_id=${b.tenantId}::uuid`);result[table]=row.image;}
 // Imports deliberately retain a failed run/audit after rollback; those logs are not Attendance effects.
 const [events]=await owner.db.execute<{image:unknown}>(sql`select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) as image from domain_event r where r.tenant_id=${b.tenantId}::uuid and r.aggregate_type<>'attendance-clocking-import'`);
 result.events=events.image;return result;
}
async function held(employmentId:string,work:()=>Promise<void>){
 let ready!:()=>void,fail!:(e:unknown)=>void,release!:()=>void;
 const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const timer=setTimeout(()=>{fail(Error('owned Attendance handshake timed out'));release();},10000);
 const holder=withTenant(adminCtx(b),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[employmentId]);ready();await finish;});void holder.catch(fail);
 try{await started;await work();}finally{release();clearTimeout(timer);await holder;}
}
describe('Attendance roots join leave dependency ownership before existing locks',()=>{
 it.each(['in','out','decide','own-cancel','admin-cancel','amend','web'] as const)('%s refuses without day/punch/capture/credit/ledger/workflow/payroll/event changes, then executes after release',async command=>{
  const f=await fixture();let correctionId='';
  if(!['in','web'].includes(command)){
   await checkInTx(f.admin,{employmentId:f.employmentId,date,time:'08:00',manual:true});
   if(command!=='out')await checkOutTx(f.admin,{employmentId:f.employmentId,date,time:'17:00',manual:true});
  }
  if(['decide','own-cancel','admin-cancel','amend'].includes(command))correctionId=(await requestAttendanceCorrection(f.self,{employmentId:f.employmentId,date,checkIn:'09:00',checkOut:'18:00',reason:'Fictional verified clock correction'})).correctionId;
  const editor=command==='amend'?(await attendanceDayEditor(f.admin,f.employmentId,date))!:null;
  const capture={action:'in' as const,requestId:randomUUID(),lat:null,lng:null,accuracy:null};
  const mutate=()=>{
   switch(command){
    case 'in':return withTenant(f.admin,tx=>checkInTx(f.admin,{employmentId:f.employmentId,date,time:'08:00',manual:true},tx));
    case 'out':return withTenant(f.admin,tx=>checkOutTx(f.admin,{employmentId:f.employmentId,date,time:'17:00',manual:true},tx));
    case 'decide':return decideAttendanceCorrection(f.admin,{correctionId,decision:'approved'});
    case 'own-cancel':return cancelOwnAttendanceCorrection(f.self,{correctionId});
    case 'admin-cancel':return cancelAttendanceApplication(f.admin,{correctionId,kind:'cancelled',reason:'Fictional administrator cancellation'});
    case 'amend':return amendExistingAttendanceApplication(f.admin,{employmentId:f.employmentId,date,correctionId,baseline:editor!.baseline,reason:'Fictional verified administrator correction',checkIn:'09:00',checkOut:'18:00'});
    case 'web':return captureEmployeeClock(f.self,capture);
   }
  };
  const before=await state();
  await held(f.employmentId,async()=>{await expect(mutate()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);});
  await mutate();expect(await state()).not.toEqual(before);
  if(command==='web'){
   const rows=await owner.db.select().from(s.attendanceClockCapture).where(eq(s.attendanceClockCapture.employmentId,f.employmentId));expect(rows).toHaveLength(1);
   const replayBefore=await state();await mutate();expect(await state()).toEqual(replayBefore);
   expect(await owner.db.select().from(s.attendanceClockCapture).where(eq(s.attendanceClockCapture.employmentId,f.employmentId))).toEqual(rows);
  }else if(['decide','amend','own-cancel','admin-cancel'].includes(command)){
   const [row]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,correctionId));expect(row.status).toBe(command.includes('cancel')?'cancelled':'approved');
  }
 });
 it('protects actual automatic TOIL banking before approval and banks exactly once after release',async()=>{
  const f=await fixture();await setModule(b.tenantId,'toil','active');const admin=await entitledCtx(b,['hr_admin']);
  await setCompensation(admin,{employmentId:f.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
  await setToilPolicy(admin,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:true,carryForwardAtYearEnd:false});
  await setRestDay(admin,{employmentId:f.employmentId,shiftDate:date});
  const {correctionId}=await requestAttendanceCorrection(admin,{employmentId:f.employmentId,date,checkIn:'08:00',checkOut:'17:00',reason:'Fictional verified rest-day work'});
  const before=await state(),approve=()=>decideAttendanceCorrection(admin,{correctionId,decision:'approved'});
  await held(f.employmentId,async()=>{await expect(approve()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);});
  await approve();const credits=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId));
  expect(credits).toHaveLength(1);expect(credits[0]).toMatchObject({workedDate:date,dayType:'rest_day',daysCredited:'1.00'});
  const after=await state();await expect(approve()).rejects.toThrow();expect(await state()).toEqual(after);
 });
 it('refuses an actual file before mapping/day effects, retains honest failed-run semantics, then imports once after release',async()=>{
  const f=await fixture();const [employee]=await owner.db.select().from(s.employment).where(eq(s.employment.id,f.employmentId));
  const text=`staff,time\n${employee.employeeCode},${date} 08:00\n${employee.employeeCode},${date} 17:00`;
  const p={mappingId:BUILTIN_MAPPING_ID,text,fileName:'fictional-barrier.csv',fileBytes:Buffer.byteLength(text)};
  const before=await state();
  await held(f.employmentId,async()=>{const failed=await commitClockingImport(f.admin,p);expect(failed.status).toBe('failed');expect(failed.imported).toBe(0);expect(await state()).toEqual(before);});
  const result=await commitClockingImport(f.admin,p);expect(result.imported).toBe(2);
  const rows=await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId));expect(rows).toHaveLength(2);
  expect((await commitClockingImport(f.admin,p)).imported).toBe(0);
  expect(await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId))).toEqual(rows);
 });
});
