import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,revertPayrollHistoryUpload,listPayrollHistoryAttempts,payrollHistorySource} from '../core/payroll-history-revisions';
import {hireEmployee} from '../core/org';
import {createBatch,myPayslipDetail} from '../core/payroll';
import {myReleasedPayslipRuns,dashboardStats} from '../core/read';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext,employeeId:string,employeePersonId:string;
const year=Number(todayInKualaLumpur().slice(0,4))-2,period=`${year}-01`;
const rows=(amount='5000.00',company='000AC',employee='0007')=>[
 [employee,period,'ME','BASIC',company,amount,'1'],[employee,period,'ME','EEEPF',company,'0.00','1'],
 [employee,period,'ME','EESOCSO',company,'0.00','1'],[employee,period,'ME','EEEIS',company,'0.00','1'],[employee,period,'ME','PCB',company,'0.00','1'],
];
const upload=(amount='5000.00')=>previewPayrollHistoryUpload(ctx,{name:'history.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows(amount)])),operationKey:randomUUID()});
const confirm=(preview:Awaited<ReturnType<typeof upload>>,replacement=true)=>confirmPayrollHistoryUpload(ctx,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:replacement});
const effective=()=>withTenant(ctx,tx=>tx.select().from(schema.payslip));
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
 await owner.db.update(schema.company).set({companyLabel:'000AC'}).where(eq(schema.company.id,b.companyId));
 await seedPayrollCycleCatalog(ctx,b.companyId);
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic'});
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional history employee',primaryEmail:'history@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'0007',hiredOn:`${year-1}-01-01`});
 employeeId=hired.employmentId;
 const [employee]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employeeId));employeePersonId=employee.personId;
});
afterAll(closeAll);

describe('immutable payroll history correction and recovery',()=>{
 it('preserves original rows while replacing and reverting the effective money exactly once',async()=>{
  const first=await upload();expect(first.plan.counts).toEqual({created:1,replaced:0,unchanged:0,invalid:0});
  const initial=await confirm(first);const original=(await effective())[0];expect(Number(original.grossPay)).toBe(5000);
  expect((await confirm(first)).alreadyCommitted).toBe(true);expect(await owner.db.select().from(schema.payslip)).toHaveLength(1);
  const correction=await upload('6000.00');expect(correction.plan.counts.replaced).toBe(1);expect(correction.plan.rows[0].beforeValues?.grossPay).toBe('5000.00');
  await expect(confirm(correction,false)).rejects.toThrow(/Confirm replacement/);expect(await effective()).toHaveLength(1);
  await confirm(correction);expect((await effective()).map(row=>Number(row.grossPay))).toEqual([6000]);
  expect(await owner.db.select().from(schema.payslip)).toHaveLength(2);
  const dashboard=await dashboardStats(ctx,[b.companyId]);expect(Number(dashboard.latestPayroll?.net)).toBe(6000);
  await revertPayrollHistoryUpload(ctx,correction.attemptId);expect((await effective()).map(row=>Number(row.grossPay))).toEqual([5000]);
  const [unchanged]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,original.id));expect(unchanged).toEqual(original);
  await expect(revertPayrollHistoryUpload(ctx,correction.attemptId)).rejects.toThrow(/already been reverted/);
  await expect(owner.db.update(schema.payslip).set({grossPay:'1.00'}).where(eq(schema.payslip.id,initial.changes[0].snapshotId!))).rejects.toThrow(/immutable/);
 });
 it('retires a newly created effective entry without erasing its physical snapshot or audit',async()=>{
  const first=await upload();await confirm(first);await revertPayrollHistoryUpload(ctx,first.attemptId);
  expect(await effective()).toEqual([]);expect(await owner.db.select().from(schema.payslip)).toHaveLength(1);
  const logs=await listPayrollHistoryAttempts(ctx);expect(logs.items[0].events.map(event=>event.kind)).toEqual(['confirmed','reverted']);
  expect((await payrollHistorySource(ctx,first.attemptId))?.content.toString()).toContain('0007');
 });
 it('refuses a stale confirmation and a revert after a later correction',async()=>{
  const first=await upload();await confirm(first);
  const a=await upload('6000.00'),b=await upload('7000.00');await confirm(a);
  await expect(confirm(b)).rejects.toThrow(/changed/);
  await expect(revertPayrollHistoryUpload(ctx,first.attemptId)).rejects.toThrow(/later correction/);
  expect((await effective()).map(row=>Number(row.grossPay))).toEqual([6000]);
 });
 it('serializes concurrent confirmations with the same expected revision',async()=>{
  const a=await upload(),b=await upload('6000.00');
  const outcomes=await Promise.allSettled([confirm(a),confirm(b)]);
  expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(await effective()).toHaveLength(1);expect(await owner.db.select().from(schema.payslip)).toHaveLength(1);
 });
 it('validates an entire multi-company file before writing any payroll result',async()=>{
  const content=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows(),...rows('100.00','UNKNOWN','0008')]));
  const preview=await previewPayrollHistoryUpload(ctx,{name:'mixed.csv',content});expect(preview.plan.counts.invalid).toBeGreaterThan(0);
  await expect(confirm(preview)).rejects.toThrow(/Correct the file/);expect(await owner.db.select().from(schema.payslip)).toHaveLength(0);
  expect(await listPayrollHistoryAttempts(ctx)).toMatchObject({items:[{sourceName:'mixed.csv'}]});
 });
 it('does not turn imported history into an issued own payslip or change an ordinary payroll run',async()=>{
  const first=await upload();const committed=await confirm(first);
  const userId=await createAppUser(b.tenantId,employeePersonId,'employee');
  const own={...ctx,userId,personId:employeePersonId,roles:['employee'],grants:undefined};
  expect(await myReleasedPayslipRuns(own)).toEqual([]);expect(await myPayslipDetail(own,committed.changes[0].snapshotId!)).toBeNull();
  const next=`${year}-02`;const ordinary=await createBatch(ctx,{companyId:b.companyId,payPeriod:next});
  const content=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows().map(row=>row.map((cell,index)=>index===1?next:cell))]));
  const preview=await previewPayrollHistoryUpload(ctx,{name:'ordinary.csv',content});expect(preview.plan.counts.invalid).toBeGreaterThan(0);
  await expect(confirm(preview)).rejects.toThrow();
  const [batch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,ordinary.batchId));expect(batch.status).toBe('draft');
 });
 it('refuses recovery after a generated statutory artifact and keeps the original effective basis',async()=>{
  const first=await upload();await confirm(first);
  await owner.db.insert(schema.statutoryReport).values({tenantId:b.tenantId,companyId:b.companyId,jurisdiction:'MY',reportType:'my.contributions',periodKind:'month',periodKey:period,status:'draft',generatedBy:ctx.userId});
  await expect(revertPayrollHistoryUpload(ctx,first.attemptId)).rejects.toThrow(/statutory/);
  expect((await effective()).map(row=>Number(row.grossPay))).toEqual([5000]);
 });
 it('keeps source files private across tenants and retains failed validation attempts',async()=>{
  const invalid=await previewPayrollHistoryUpload(ctx,{name:'invalid.csv',content:Buffer.from('Repeated,Repeated\n1,2')});
  expect(invalid.plan.counts.invalid).toBe(1);expect((await listPayrollHistoryAttempts(ctx)).items).toHaveLength(1);
  const other=await seedBase();await setModule(other.tenantId,'payroll','active');
  expect(await payrollHistorySource(await entitledCtx(other),invalid.attemptId)).toBeNull();
  expect((await listPayrollHistoryAttempts(await entitledCtx(other))).items).toEqual([]);
 });
});
