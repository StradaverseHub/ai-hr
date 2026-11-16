import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {setCompensation,compensationAmendmentHistory,compensationHistoryDetailed} from '../core/comp';
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
async function closedSalaryMonth(period:string){
 const [parent]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'closed'}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:parent.id,payPeriod:period,batchDate:period+'-25',status:'closed'}).returning();
 await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',totalDeductions:'0.00',employerCost:'3000.00',statutory:{fixture:'finalized'}});
}
describe('salary recording choices share deterministic owners',()=>{
 it('shows a wholly closed HR amendment without replacing paid salary, later intent or Employment History',async()=>{
  const ctx=adminCtx(b);await setCompensation(ctx,{employmentId:id,basicSalary:4000,effectiveFrom:'2026-03-01'});
  await closedSalaryMonth('2026-01');await closedSalaryMonth('2026-02');
  const paid=await owner.db.select().from(s.payslip).orderBy(s.payslip.id),batches=await owner.db.select().from(s.payrollBatch).orderBy(s.payrollBatch.id);
  const physical=await compensationHistoryDetailed(ctx,id),events=(await movementHistory(ctx,id)).map(row=>row.id);
  await recordPersonnelSalary(ctx,{employmentId:id,choice:'amendment',effectiveDate:'2026-01-15',basicSalary:3400,paymentMethod:'cash',reason:'Fictional corrected signed January salary'});
  const history=await compensationAmendmentHistory(ctx,id);expect(history).toMatchObject({page:1,hasMore:false,rows:[{basicSalary:'3400.00',currency:'MYR',effectiveFrom:'2026-01-15',payrollFrom:null,until:'2026-03-01',informationOnly:true,reason:'Fictional corrected signed January salary'}]});
  expect(await compensationHistoryDetailed(ctx,id)).toEqual(physical);
  expect(await owner.db.select().from(s.payslip).orderBy(s.payslip.id)).toEqual(paid);expect(await owner.db.select().from(s.payrollBatch).orderBy(s.payrollBatch.id)).toEqual(batches);
  expect((await movementHistory(ctx,id)).map(row=>row.id)).toEqual(events);expect(await movementCurrentState(ctx,id)).toMatchObject({basicSalary:'4000.00'});
  // A method-only follow-up must reference the corrected semantic salary, not the immutable paid source.
  await recordPersonnelSalary(ctx,{employmentId:id,choice:'amendment',effectiveDate:'2026-01-15',basicSalary:3400,paymentMethod:'cheque',reason:'Fictional corrected January routing'});
  const latest=await owner.db.select({payload:s.domainEvent.payload}).from(s.domainEvent).where(eq(s.domainEvent.eventType,'employment.salary.amended')).orderBy(s.domainEvent.sequence);
  expect(latest.at(-1)?.payload).toMatchObject({compensationId:history.rows[0].compensationId,salaryChanged:false,paymentMethodChanged:true});
  expect((await compensationAmendmentHistory(ctx,id)).rows).toHaveLength(1);
 });
 it('pages the actual native amendment ledger newest-first without returning another employee reference',async()=>{
  const ctx=adminCtx(b);
  for(let ordinal=1;ordinal<=51;ordinal++)await recordPersonnelSalary(ctx,{employmentId:id,choice:'amendment',effectiveDate:'2026-02-01',basicSalary:3000+ordinal,reason:'Fictional amendment '+ordinal});
  const first=await compensationAmendmentHistory(ctx,id),second=await compensationAmendmentHistory(ctx,id,2);
  expect(first).toMatchObject({page:1,hasMore:true});expect(first.rows).toHaveLength(50);expect(first.rows[0].basicSalary).toBe('3051.00');
  expect(second).toMatchObject({page:2,hasMore:false,rows:[{basicSalary:'3001.00',reason:'Fictional amendment 1'}]});
  expect(new Set([...first.rows,...second.rows].map(row=>row.id)).size).toBe(51);
  const other=(await hireEmployee(ctx,{person:{fullName:'Fictional Other Salary',primaryEmail:'other-salary@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
  expect((await compensationAmendmentHistory(ctx,other)).rows).toEqual([]);
 },180_000); // 51 genuine composite native writes exercise ledger pagination; allow hosted transaction overhead.
 it('refuses a no-op amendment without manufacturing salary or audit history',async()=>{
  const ctx=adminCtx(b),before=await owner.db.select().from(s.domainEvent).orderBy(s.domainEvent.sequence);
  await expect(recordPersonnelSalary(ctx,{employmentId:id,choice:'amendment',effectiveDate:'2026-01-01',basicSalary:3000,reason:'Fictional unchanged record'})).rejects.toThrow('Nothing to amend');
  expect(await owner.db.select().from(s.domainEvent).orderBy(s.domainEvent.sequence)).toEqual(before);expect((await compensationAmendmentHistory(ctx,id)).rows).toEqual([]);
 });

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
