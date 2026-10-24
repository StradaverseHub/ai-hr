/** Fictional stored-receipt probes, not real-app capture or payable-execution acceptance. */
import {randomUUID} from 'node:crypto';
import {asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {recordedPolicyClockSourceTx} from '../packs/attendance/policy-clock-input';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext;
const date=()=>todayInKualaLumpur();
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});
async function fixture(){
 const worker=await hireEmployee(ctx,{person:{fullName:'Fictional stored capture source',primaryEmail:randomUUID()+'@fixture.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:date()});
 const [day]=await owner.db.insert(s.attendance).values({tenantId:b.tenantId,employmentId:worker.employmentId,attendanceDate:date()}).returning();
 const base=Date.parse(date()+'T00:00:00+08:00');
 const captures=await owner.db.insert(s.attendanceClockCapture).values([
  {tenantId:b.tenantId,employmentId:worker.employmentId,attendanceDate:date(),direction:'in' as const,requestId:randomUUID(),
   serverRecordedAt:new Date(base+86399950),commandDigest:'a'.repeat(64)},
  {tenantId:b.tenantId,employmentId:worker.employmentId,attendanceDate:date(),direction:'out' as const,requestId:randomUUID(),
   serverRecordedAt:new Date(base+86459900),commandDigest:'b'.repeat(64)},
 ]).returning();
 const input=captures.find(c=>c.direction==='in')!,output=captures.find(c=>c.direction==='out')!;
 await owner.db.insert(s.attendancePunch).values([
  {tenantId:b.tenantId,employmentId:worker.employmentId,attendanceId:day.id,attendanceDate:date(),punchAt:'23:59:59',direction:'in',clockCaptureId:input.id},
  {tenantId:b.tenantId,employmentId:worker.employmentId,attendanceId:day.id,attendanceDate:date(),punchAt:'00:00:59',direction:'out',clockCaptureId:output.id},
 ]);
 const punches=await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.attendanceId,day.id)).orderBy(asc(s.attendancePunch.id));
 return {worker,day,base,input,output,punches};
}
const read=(f:Awaited<ReturnType<typeof fixture>>,punches=f.punches,actor=ctx)=>withTenant(actor,tx=>recordedPolicyClockSourceTx(tx,actor,
 {attendanceId:f.day.id,employmentId:f.worker.employmentId,date:date(),punches}));
describe('canonical stored capture provenance for policy snapshots',()=>{
 it('retains exact midnight placement and subsecond gap from receipts, without inventing a completed duration',async()=>{
  const f=await fixture(),value=await read(f);expect(value.state).toBe('known');if(value.state!=='known')throw Error('Expected recorded capture source');
  expect(value).toMatchObject({authority:'sourceOnly',timeZone:'Asia/Kuala_Lumpur',periodMilliseconds:259200000});
  expect(value.clocks.map(clock=>({direction:clock.direction,at:clock.atMilliseconds}))).toEqual([{direction:'in',at:86399950},{direction:'out',at:86459900}]);
  expect(value.clocks[1].atMilliseconds-value.clocks[0].atMilliseconds).toBe(59950);
  expect(JSON.stringify(value)).not.toMatch(/photo|latitude|longitude|salary|approved|payable/);
 });
 it('never promotes manual/imported labels or row creation time into an absolute instant',async()=>{
  const f=await fixture();expect(await read(f,f.punches.map(punch=>({...punch,clockCaptureId:null})))).toEqual({state:'unavailable',authority:'sourceOnly',reason:'missingCapture'});
 });
 it.each(['label','direction','subject','day'] as const)('refuses mismatched %s corroboration rather than retaining a partial known set',async kind=>{
  const f=await fixture(),punches=f.punches.map(punch=>({...punch}));const punch=punches.find(row=>row.direction==='out')!;
  if(kind==='label')punch.punchAt='00:01:59';if(kind==='direction')punch.direction='in';
  if(kind==='subject')punch.employmentId=randomUUID();if(kind==='day')punch.attendanceDate='2000-01-01';
  expect(await read(f,punches)).toEqual({state:'unavailable',authority:'sourceOnly',reason:'captureMismatch'});
 });
 it('refuses unreadable capture receipts and never reuses foreign-tenant IDs as source evidence',async()=>{
  const f=await fixture();expect(await read(f,f.punches,adminCtx(await seedBase()))).toEqual({state:'unavailable',authority:'sourceOnly',reason:'missingCapture'});
 });
 it('refuses a receipt beyond the source period rather than folding its clock label into another day',async()=>{
  const f=await fixture();await owner.db.update(s.attendanceClockCapture).set({serverRecordedAt:new Date(f.base+4*86400000+59900)})
   .where(eq(s.attendanceClockCapture.id,f.output.id));
  expect(await read(f)).toEqual({state:'unavailable',authority:'sourceOnly',reason:'outsidePeriod'});
 });
});
