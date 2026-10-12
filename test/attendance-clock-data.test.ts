import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection, attendancePunchesForRange, attendancePunchesForDays } from '../core/attendance';
import { attendanceClockData } from '../core/attendance-clock-data';
import { ClockDataChangedError, AttendancePayrollClosedError, validateClockEntries } from '../core/attendance-punch-change';
import { createBatch, generatePayslips } from '../packs/payroll/service';
import { setCompensation } from '../core/comp';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b:Base;
const date='2026-07-15';
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function fixture() {
 const a=adminCtx(b);
 const e=await hireEmployee(a,{person:{fullName:'Clock data worker',primaryEmail:'clock-data@test.local'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await checkIn(a,{employmentId:e.employmentId,date,time:'08:00',manual:true});
 await checkOut(a,{employmentId:e.employmentId,date,time:'17:00',manual:true});
 return {a,...e};
}
const day=async(employmentId:string)=>(await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId,employmentId),eq(schema.attendance.attendanceDate,date))))[0];
async function save(a:ReturnType<typeof adminCtx>,employmentId:string,entries:{id?:string;punchAt:string;direction:'in'|'out'}[]) {
 const data=await attendanceClockData(a,employmentId,date);
 const {correctionId}=await requestAttendanceCorrection(a,{employmentId,date,reason:'Verified gate log',clockChanges:{version:1,baseline:data.baseline,entries}});
 await decideAttendanceCorrection(a,{correctionId,decision:'approved'});
 return correctionId;
}
describe('approved attendance clock-data corrections',()=>{
 it('edits retain original evidence and all effective readers agree with the corrected day',async()=>{
  const {a,employmentId}=await fixture();const before=await attendanceClockData(a,employmentId,date);
  await save(a,employmentId,before.rows.map(r=>({id:r.id,punchAt:r.direction==='in'?'09:00':'18:00',direction:r.direction})));
  const raw=await attendanceClockData(a,employmentId,date);
  expect(raw.rows).toHaveLength(4);expect(raw.rows.filter(r=>r.voidedAt).map(r=>r.punchAt)).toEqual(['08:00:00','17:00:00']);
  expect(raw.rows.filter(r=>!r.voidedAt).every(r=>r.method==='admin')).toBe(true);
  expect(raw.rows.filter(r=>r.voidedAt).every(r=>r.voidReason==='Verified gate log')).toBe(true);
  const d=await day(employmentId);expect([d.checkInAt,d.checkOutAt,d.workedMinutes]).toEqual(['09:00:00','18:00:00',480]);
  expect((await attendancePunchesForRange(a,employmentId,date,date)).get(d.id)?.map(r=>r.punchAt)).toEqual(['09:00:00','18:00:00']);
  expect((await attendancePunchesForDays(a,[d.id])).get(d.id)?.map(r=>r.punchAt)).toEqual(['09:00:00','18:00:00']);
 });
 it('remove-all clears paid figures, preserves records, and restore recomputes the day',async()=>{
  const {a,employmentId}=await fixture();const original=await attendanceClockData(a,employmentId,date);
  await save(a,employmentId,[]);const cleared=await day(employmentId);
  expect([cleared.checkInAt,cleared.checkOutAt,cleared.workedMinutes,cleared.otMinutes,cleared.lateMinutes]).toEqual([null,null,null,null,null]);
  expect((await attendanceClockData(a,employmentId,date)).rows.every(r=>!!r.voidedAt)).toBe(true);
  await expect(checkIn(a,{employmentId,date,time:'19:00',manual:true})).rejects.toThrow(/correction owns/);
  await save(a,employmentId,original.rows.map(r=>({id:r.id,punchAt:r.punchAt,direction:r.direction})));
  expect((await attendanceClockData(a,employmentId,date)).rows).toHaveLength(2);
  expect((await day(employmentId)).workedMinutes).toBe(480);
 });
 it('legacy pair corrections also replace effective clockings without destroying originals',async()=>{
  const {a,employmentId}=await fixture();const {correctionId}=await requestAttendanceCorrection(a,{employmentId,date,checkIn:'09:00',checkOut:'18:00',reason:'Gate log'});
  await decideAttendanceCorrection(a,{correctionId,decision:'approved'});
  const raw=await attendanceClockData(a,employmentId,date);expect(raw.rows.filter(r=>!r.voidedAt).map(r=>r.punchAt)).toEqual(['09:00:00','18:00:00']);expect(raw.rows.filter(r=>r.voidedAt)).toHaveLength(2);
 });
 it('rejects stale approval atomically when new clocking arrived after the request',async()=>{
  const {a,employmentId}=await fixture();const raw=await attendanceClockData(a,employmentId,date);
  const {correctionId}=await requestAttendanceCorrection(a,{employmentId,date,reason:'Proposed before a new clocking',clockChanges:{version:1,baseline:raw.baseline,entries:[]}});
  await checkIn(a,{employmentId,date,time:'18:00',manual:true});
  await expect(decideAttendanceCorrection(a,{correctionId,decision:'approved'})).rejects.toBeInstanceOf(ClockDataChangedError);
  expect((await attendanceClockData(a,employmentId,date)).rows.filter(r=>r.voidedAt)).toHaveLength(0);
  expect((await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,correctionId)))[0].status).toBe('pending');
 });
 it('refuses duplicate restores and unknown or foreign punch ids',async()=>{
  const {a,employmentId}=await fixture();const raw=await attendanceClockData(a,employmentId,date);const e=raw.rows[0];
  expect(()=>validateClockEntries([{punchAt:e.punchAt,direction:e.direction},{punchAt:e.punchAt.slice(0,5),direction:e.direction}])).toThrow(/already in use/);
  await expect(save(a,employmentId,[{id:'00000000-0000-0000-0000-000000000000',punchAt:'09:00',direction:'in'}])).rejects.toThrow(/does not belong/);
 });
 it('keeps self-approval refused and records the pending request',async()=>{
  const {a,employmentId,personId}=await fixture();const self={...a,personId};
  const raw=await attendanceClockData(self,employmentId,date);
  const {correctionId}=await requestAttendanceCorrection(self,{employmentId,date,reason:'Own attendance',clockChanges:{version:1,baseline:raw.baseline,entries:[]}});
  await expect(decideAttendanceCorrection(self,{correctionId,decision:'approved'})).rejects.toThrow(/cannot decide your own/);
  expect((await attendanceClockData(a,employmentId,date)).rows.filter(r=>r.voidedAt)).toHaveLength(0);
 });
 it('refuses changes to dates owned by a closed payroll',async()=>{
  const {a,employmentId}=await fixture();
  await setCompensation(a,{employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
  const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-07'});await generatePayslips(a,{batchId});
  await owner.db.update(schema.payrollBatch).set({status:'closed'}).where(eq(schema.payrollBatch.id,batchId));
  await expect(save(a,employmentId,[])).rejects.toBeInstanceOf(AttendancePayrollClosedError);
  expect((await attendanceClockData(a,employmentId,date)).rows.filter(r=>r.voidedAt)).toHaveLength(0);
 });
});
