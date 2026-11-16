import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {recordPersonnelSalary} from '../core/personnel-salary-recording';
import {createMovementEvent,movementCurrentState,movementDetail,movementHistory} from '../core/movement';
import {saveMovementEventType} from '../core/movement-type';
let b:Base,id:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();const ctx=adminCtx(b);
 id=(await hireEmployee(ctx,{person:{fullName:'Fictional Salary Choice',primaryEmail:'salary-choice@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 await setCompensation(ctx,{employmentId:id,basicSalary:3000,effectiveFrom:'2026-01-01'});
});
afterAll(closeAll);
describe('salary recording choices share deterministic owners',()=>{
 it('creates the configured event with salary, payment method and Effective Date together',async()=>{
  const ctx=adminCtx(b),type=await saveMovementEventType(ctx,{label:'Fictional Merit Award',behaviourKind:'increment'});
  await recordPersonnelSalary(ctx,{employmentId:id,choice:'newEvent',eventType:type.code,effectiveDate:'2026-02-01',basicSalary:3500,paymentMethod:'cash'});
  const rows=(await movementHistory(ctx,id)).filter(row=>row.kind===type.code);expect(rows).toHaveLength(1);
  expect((await movementDetail(ctx,id,rows[0].id))?.after).toMatchObject({salaryAmount:'3500.00',paymentMethod:'cash'});
 });
 it('updates the latest applicable event by Effective Date even when an older event was entered last',async()=>{
  const ctx=adminCtx(b);
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-06-01',basicSalary:3500});
  await createMovementEvent(ctx,{employmentId:id,kind:'transfer',effectiveDate:'2026-03-01',departmentId:b.deptB,remarks:'Fictional backdated placement'});
  const selected=(await movementHistory(ctx,id)).find(row=>row.kind==='increment'&&!row.reversed)!;
  await recordPersonnelSalary(ctx,{employmentId:id,choice:'updateLatest',movementId:selected.id,effectiveDate:'2026-06-01',basicSalary:3600,paymentMethod:'cheque',reason:'Fictional latest event correction'});
  expect((await movementHistory(ctx,id)).find(row=>row.id===selected.id)?.reversed).toMatchObject({corrected:true});
  expect(await movementCurrentState(ctx,id)).toMatchObject({basicSalary:'3600.00',paymentMethod:'cheque',departmentId:b.deptB});
 });
 it('updates the Hired event when it is the latest applicable decision, atomically with its dated payment method',async()=>{
  const ctx=adminCtx(b),hired=(await movementHistory(ctx,id)).find(row=>row.kind==='hired')!;
  await recordPersonnelSalary(ctx,{employmentId:id,choice:'updateLatest',movementId:hired.id,effectiveDate:hired.effectiveDate,basicSalary:3250,paymentMethod:'cash',reason:'Fictional original hire correction from Salary History'});
  expect((await movementHistory(ctx,id)).filter(row=>row.kind==='hired')).toHaveLength(1);
  expect((await movementDetail(ctx,id,hired.id))?.after).toMatchObject({salaryAmount:'3250.00',paymentMethod:'cash'});
  expect(await movementCurrentState(ctx,id)).toMatchObject({basicSalary:'3250.00',paymentMethod:'cash'});
 });
 it('records an amendment with audit evidence and no new Employment History event',async()=>{
  const ctx=adminCtx(b),before=await movementHistory(ctx,id);
  await recordPersonnelSalary(ctx,{employmentId:id,choice:'amendment',effectiveDate:'2026-02-01',basicSalary:3400,paymentMethod:'cash',reason:'Fictional information amendment'});
  expect((await movementHistory(ctx,id)).map(row=>row.id)).toEqual(before.map(row=>row.id));
  expect(await movementCurrentState(ctx,id)).toMatchObject({basicSalary:'3400.00',paymentMethod:'cash'});
  const audit=await owner.db.select({payload:s.domainEvent.payload}).from(s.domainEvent).where(eq(s.domainEvent.eventType,'employment.salary.amended'));
  expect(audit).toEqual([{payload:expect.objectContaining({effectiveDate:'2026-02-01',movementCreated:false,reason:'Fictional information amendment',compensationId:expect.any(String)})}]);
  expect(audit[0].payload).not.toHaveProperty('basicSalary');
  expect(audit[0].payload).not.toHaveProperty('amount');
 });
 it('amends an earlier recorded interval while retaining the later salary and Employment History event identities',async()=>{
  const ctx=adminCtx(b);
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-03-01',basicSalary:4000});
  const events=(await movementHistory(ctx,id)).map(row=>row.id);
  await recordPersonnelSalary(ctx,{employmentId:id,choice:'amendment',effectiveDate:'2026-02-01',basicSalary:3400,paymentMethod:'cash',reason:'Fictional earlier salary amendment'});
  expect((await movementHistory(ctx,id)).map(row=>row.id)).toEqual(events);
  expect(await movementCurrentState(ctx,id)).toMatchObject({basicSalary:'4000.00'});
  const rows=await owner.db.select({from:s.compensation.validFrom,to:s.compensation.validTo,amount:s.compensation.basicSalary,superseded:s.compensation.supersededAt}).from(s.compensation).orderBy(s.compensation.validFrom);
  expect(rows.filter(row=>!row.superseded).map(({superseded,...row})=>row)).toEqual([{from:'2026-01-01',to:'2026-02-01',amount:'3000.00'},{from:'2026-02-01',to:'2026-03-01',amount:'3400.00'},{from:'2026-03-01',to:null,amount:'4000.00'}]);
 });
 it('rolls salary and audit back when the selected bank-transfer method is unpayable',async()=>{
  const ctx=adminCtx(b),before=await owner.db.select().from(s.compensation).where(eq(s.compensation.employmentId,id)).orderBy(s.compensation.id);
  await expect(recordPersonnelSalary(ctx,{employmentId:id,choice:'amendment',effectiveDate:'2026-02-01',basicSalary:3400,paymentMethod:'bank_transfer',reason:'Fictional unpayable method'})).rejects.toThrow();
  expect(await owner.db.select().from(s.compensation).where(eq(s.compensation.employmentId,id)).orderBy(s.compensation.id)).toEqual(before);
  expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'employment.salary.amended'))).toEqual([]);
 });
 it('rejects an older target or a different date rather than silently replacing another event',async()=>{
  const ctx=adminCtx(b);
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-02-01',basicSalary:3500});
  const older=(await movementHistory(ctx,id)).find(row=>row.kind==='increment')!;
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-06-01',basicSalary:3700});
  await expect(recordPersonnelSalary(ctx,{employmentId:id,choice:'updateLatest',movementId:older.id,effectiveDate:'2026-02-01',basicSalary:3600,reason:'Fictional stale target'})).rejects.toThrow(/latest applicable event changed/);
  const latest=(await movementHistory(ctx,id)).find(row=>row.kind==='increment'&&row.effectiveDate==='2026-06-01')!;
  await expect(recordPersonnelSalary(ctx,{employmentId:id,choice:'updateLatest',movementId:latest.id,effectiveDate:'2026-07-01',basicSalary:3600,reason:'Fictional date mismatch'})).rejects.toThrow(/Keep that date/);
  expect(await movementCurrentState(ctx,id)).toMatchObject({basicSalary:'3700.00'});
 });
});
