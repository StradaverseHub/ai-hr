import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentPaymentMethod,MissingBankForTransferError} from '../core/org';
import {employmentPaymentMethodHistory,employmentPaymentMethodOnTx} from '../core/employment-payment-method';
import {createMovementEvent,editMovementEvent,movementDetail,movementHistory,reverseMovementEvent} from '../core/movement';
import {setCompensation} from '../core/comp';
import {employeeDetail} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,id:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 id=(await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Dated Method',primaryEmail:'dated@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
});
afterAll(closeAll);
const on=(date:string)=>withTenant(adminCtx(b),tx=>employmentPaymentMethodOnTx(tx,id,date));
describe('employment-effective payment method owner',()=>{
 it('resolves historical, current and future dates without moving today to the newest-created row',async()=>{
  const ctx=adminCtx(b),future=new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+30*86400000).toISOString().slice(0,10);
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cash',effectiveDate:'2026-01-01'});
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cheque',effectiveDate:'2026-04-01'});
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cash',effectiveDate:future});
  expect(await on('2026-03-31')).toBe('cash');expect(await on('2026-04-01')).toBe('cheque');expect(await on(future)).toBe('cash');
  expect((await employeeDetail(ctx,id,'workforce'))?.paymentMethod).toBe('cheque');
  const [master]=await owner.db.select({method:s.employment.paymentMethod}).from(s.employment).where(eq(s.employment.id,id));expect(master.method).toBe('cheque');
 });
 it('inserts a backdated method while keeping later explicit methods and corrects a same-date row visibly',async()=>{
  const ctx=adminCtx(b);
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cash',effectiveDate:'2026-01-01'});
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cheque',effectiveDate:'2026-05-01'});
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:null,effectiveDate:'2026-03-01'});
  expect(await on('2026-03-01')).toBeNull();expect(await on('2026-05-01')).toBe('cheque');
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cash',effectiveDate:'2026-05-01',reason:'Fictional same-date correction'});
  const history=await employmentPaymentMethodHistory(ctx,id);
  expect(history.filter(row=>row.effectiveOn==='2026-05-01')).toHaveLength(2);
  expect(history.filter(row=>row.effectiveOn==='2026-05-01'&&!row.supersededAt)).toMatchObject([{paymentMethod:'cash'}]);
 });
 it('keeps salary and payment method in one movement, correction and compensating delete',async()=>{
  const ctx=adminCtx(b);
  await setCompensation(ctx,{employmentId:id,basicSalary:3000,effectiveFrom:'2026-01-01'});
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-02-01',basicSalary:3500,paymentMethod:'cash'});
  const rows=(await movementHistory(ctx,id)).filter(row=>row.kind==='increment');expect(rows).toHaveLength(1);
  expect((await movementDetail(ctx,id,rows[0].id))?.after).toMatchObject({salaryAmount:'3500.00',paymentMethod:'cash'});
  await editMovementEvent(ctx,{employmentId:id,movementId:rows[0].id,kind:'increment',effectiveDate:'2026-02-01',basicSalary:3600,paymentMethod:'cheque',reason:'Fictional paired correction'});
  expect(await on('2026-02-01')).toBe('cheque');
  const replacement=(await movementHistory(ctx,id)).find(row=>row.kind==='increment'&&!row.reversed)!;
  await reverseMovementEvent(ctx,{employmentId:id,movementId:replacement.id,reason:'Fictional paired removal'});
  expect(await on('2026-02-01')).toBeNull();
 });
 it('deleting a later method restores the corrected hire owner without inventing a new boundary',async()=>{
  const ctx=adminCtx(b);
  await setEmploymentPaymentMethod(ctx,{employmentId:id,effectiveDate:'2026-01-01',paymentMethod:'cash'});
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-03-01',paymentMethod:'cheque'});
  const movement=(await movementHistory(ctx,id)).find(row=>row.kind==='increment')!;
  await setEmploymentPaymentMethod(ctx,{employmentId:id,effectiveDate:'2026-01-01',paymentMethod:null,reason:'Fictional corrected original routing'});
  await reverseMovementEvent(ctx,{employmentId:id,movementId:movement.id,reason:'Fictional removal of later routing decision'});
  expect(await on('2026-03-01')).toBeNull();
  await setEmploymentPaymentMethod(ctx,{employmentId:id,effectiveDate:'2026-01-01',paymentMethod:'cash',reason:'Fictional second original correction'});
  expect(await on('2026-03-01')).toBe('cash');
  expect((await employmentPaymentMethodHistory(ctx,id)).filter(row=>row.effectiveOn==='2026-03-01'&&!row.supersededAt)).toEqual([]);
  expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'employment.payment-method.reverted'))).toHaveLength(1);
 });
 it('enforces date, bank readiness, tenant isolation and table grants',async()=>{
  const ctx=adminCtx(b);
  await expect(setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cash',effectiveDate:'2025-12-31'})).rejects.toThrow(/Group Join Date/);
  await expect(setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'bank_transfer',effectiveDate:'2026-03-01'})).rejects.toBeInstanceOf(MissingBankForTransferError);
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cash',effectiveDate:'2026-01-01'});
  const other=await seedBase();
  expect(await withTenant(adminCtx(other),tx=>tx.select().from(s.employmentPaymentMethodHistory))).toEqual([]);
  const [grants]=await withTenant(ctx,tx=>tx.execute<{read:boolean;insert:boolean;update:boolean;delete:boolean}>(sql`select has_table_privilege(current_user,'employment_payment_method_history','SELECT') as read,has_table_privilege(current_user,'employment_payment_method_history','INSERT') as insert,has_table_privilege(current_user,'employment_payment_method_history','UPDATE') as update,has_table_privilege(current_user,'employment_payment_method_history','DELETE') as delete`));
  expect(grants).toEqual({read:true,insert:true,update:true,delete:false});
  expect(await owner.db.select().from(s.employmentPaymentMethodHistory).where(eq(s.employmentPaymentMethodHistory.employmentId,id))).toHaveLength(1);
 });
});
