import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { payrollBatch, payslip, domainEvent } from '../db/schema';
import { createBatch } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { resumeRunAction } from '../app/payroll/process/actions';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let caller: ReturnType<typeof adminCtx>;
vi.mock('../lib/session', () => ({ getSession: async () => caller }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (href: string) => { throw new Error('REDIRECT:' + href); } }));

describe('resumed payroll respects explicit empty versus untouched selection', () => {
 let base: Base;
 beforeAll(migrateTestDb);
 beforeEach(async () => { await resetDb(); base = await seedBase(); caller = adminCtx(base); });
 afterAll(closeAll);
 async function fixture() {
  const ids: string[] = [];
  for (const [i, name] of ['Selected', 'Other'].entries()) {
   const e = await hireEmployee(caller, { person: { fullName: name, primaryEmail: name.toLowerCase()+'@acme.test' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
   await setCompensation(caller, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
   await setStatutoryProfileMY(caller, { personId: e.personId, icNumber: '90010101500'+(i+1) });
   ids.push(e.employmentId);
  }
  return ids;
 }
 function form(batchId: string, touched: boolean, ids: string[] = []) {
  const data = new FormData(); data.set('batchId', batchId); data.set('filtersTouched', String(touched));
  for (const id of ids) data.append('employmentIds', id);
  return data;
 }
 async function state(batchId: string) {
  return {
   batches: await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id, batchId)),
   slips: await owner.db.select().from(payslip).where(eq(payslip.batchId, batchId)),
   events: await owner.db.select().from(domainEvent).where(eq(domainEvent.aggregateId, batchId)).orderBy(domainEvent.id),
  };
 }
 it('Clear All refuses without widening or mutating an existing selected draft', async () => {
  const [selected] = await fixture();
  const { batchId } = await createBatch(caller, { companyId: base.companyId, payPeriod: '2026-05', scope: { employmentIds: [selected] } });
  const before = await state(batchId);
  expect(before.batches[0].scope).toEqual({ employmentIds: [selected] });
  await expect(resumeRunAction(form(batchId, true))).rejects.toThrow('REDIRECT:/payroll/process?resume='+batchId+'&error=');
  expect(await state(batchId)).toEqual(before);
 });
 it.each([false, true])('an untouched draft preserves existing scope (whole company: %s)', async (wholeCompany) => {
  const ids = await fixture();
  const { batchId } = await createBatch(caller, { companyId: base.companyId, payPeriod: '2026-05', ...(wholeCompany ? {} : { scope: { employmentIds: [ids[0]] } }) });
  await expect(resumeRunAction(form(batchId, false))).rejects.toThrow('REDIRECT:/payroll/process/result?');
  const result = await state(batchId);
  expect(result.batches[0].status).toBe('processed');
  expect(result.slips.map(slip => slip.employmentId).sort()).toEqual((wholeCompany ? ids : [ids[0]]).sort());
 });
 it('a touched nonempty selection processes only that employee', async () => {
  const ids = await fixture();
  const { batchId } = await createBatch(caller, { companyId: base.companyId, payPeriod: '2026-05' });
  await expect(resumeRunAction(form(batchId, true, [ids[1]]))).rejects.toThrow('REDIRECT:/payroll/process/result?');
  const result = await state(batchId);
  expect(result.batches[0].scope).toEqual({ employmentIds: [ids[1]] });
  expect(result.slips.map(slip => slip.employmentId)).toEqual([ids[1]]);
 });
});
