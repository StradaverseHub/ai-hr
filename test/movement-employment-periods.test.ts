/** Board 8cff7fef Stage 1: employment period ownership survives the complete Movement lifecycle. */
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import { domainEvent, employment, movementTypeFieldRule, payPeriod, payrollBatch, payslip } from '../db/schema';
import { setCompensation } from '../core/comp';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { createMovementEvent, editMovementEvent, movementDetail, movementHistory, movementPendingEditInput, reverseMovementEvent } from '../core/movement';
import { applyDueMovementsTx } from '../core/movement';
import { previewMovementImport, commitMovementImport } from '../core/movement-import';
import { saveMovementEventType } from '../core/movement-type';
import { MOVEMENT_EMPLOYMENT_PERIOD_FIELDS } from '../lib/movement-employment-periods';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);
const day = (offset: number) => new Date(Date.parse(todayInKualaLumpur() + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
const initial = { probationValue: '3', probationUnit: 'month', extendedProbationValue: '1', extendedProbationUnit: 'week', noticeBeforeConfirmationValue: '1', noticeBeforeConfirmationUnit: 'month', noticeAfterConfirmationValue: '2', noticeAfterConfirmationUnit: 'month' };
const revised = { probationValue: '6', probationUnit: 'week', extendedProbationValue: '14', extendedProbationUnit: 'day', noticeBeforeConfirmationValue: '7', noticeBeforeConfirmationUnit: 'day', noticeAfterConfirmationValue: '4', noticeAfterConfirmationUnit: 'week' };
async function subject() {
  const ctx = adminCtx(base);
  const { employmentId } = await hireEmployee(ctx, { person: { fullName: 'Fictional period subject', primaryEmail: randomUUID() + '@period.invalid' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: day(-90) });
  await setEmploymentInfo(ctx, { employmentId, ...initial });
  return { ctx, employmentId };
}
async function periods(id: string) {
  const [row] = await owner.db.select().from(employment).where(eq(employment.id, id));
  return Object.fromEntries(MOVEMENT_EMPLOYMENT_PERIOD_FIELDS.map(field => [field, row[field] == null ? null : String(row[field])]));
}
async function events(id: string) { return owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId, id)).orderBy(asc(domainEvent.sequence)); }
async function applied(ctx: ReturnType<typeof adminCtx>, id: string) { return (await movementHistory(ctx, id)).find(row => row.kind === 'promotion' && row.status === 'applied')!; }

describe('Movement employment period fields', () => {
  it('records all four value/unit pairs in one event with dated before/after values and reverses through the owner', async () => {
    const { ctx, employmentId } = await subject();
    await createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(-30), ...revised });
    const movement = await applied(ctx, employmentId);
    expect(movement).toMatchObject({ effectiveDate: day(-30), canEdit: true, canReverse: true });
    expect(await periods(employmentId)).toEqual(revised);
    const detail = await movementDetail(ctx, employmentId, movement.id);
    for (const field of MOVEMENT_EMPLOYMENT_PERIOD_FIELDS) expect(detail?.flatChanges).toContainEqual({ field, before: initial[field], after: revised[field] });
    expect((await movementPendingEditInput(ctx, employmentId, movement.id))?.values).toMatchObject(revised);
    expect((await movementHistory(ctx, employmentId)).filter(row => row.kind === 'promotion')).toHaveLength(1);
    await reverseMovementEvent(ctx, { employmentId, movementId: movement.id, reason: 'Correct fictional period entry' });
    expect(await periods(employmentId)).toEqual(initial);
    expect((await movementHistory(ctx, employmentId)).find(row => row.id === movement.id)?.status).toBe('reversed');
  });

  it('allows a period-only edit on the same effective date and retains the original audited values', async () => {
    const { ctx, employmentId } = await subject();
    await createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(-30), ...revised });
    const original = await applied(ctx, employmentId);
    await editMovementEvent(ctx, { employmentId, movementId: original.id, kind: 'promotion', effectiveDate: day(-30), ...revised, noticeAfterConfirmationValue: '5', reason: 'Signed offer has five weeks' });
    expect(await periods(employmentId)).toEqual({ ...revised, noticeAfterConfirmationValue: '5' });
    const originalEvent = (await events(employmentId)).find(event => event.id === original.id)!;
    expect(originalEvent.payload).toMatchObject({ after: { noticeAfterConfirmationValue: 4 }, movement: { effectiveDate: day(-30) } });
    const current = await applied(ctx, employmentId);
    await reverseMovementEvent(ctx, { employmentId, movementId: current.id, reason: 'Restore fictional baseline' });
    expect(await periods(employmentId)).toEqual(initial);
  });

  it('keeps scheduled periods separate from live data and applies exactly the saved values when due', async () => {
    const { ctx, employmentId } = await subject();
    await createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(7), ...revised });
    const pending = (await movementHistory(ctx, employmentId)).find(row => row.status === 'pending')!;
    expect(await periods(employmentId)).toEqual(initial);
    expect((await movementPendingEditInput(ctx, employmentId, pending.id))?.values).toMatchObject(revised);
    const detail = await movementDetail(ctx, employmentId, pending.id);
    for (const field of MOVEMENT_EMPLOYMENT_PERIOD_FIELDS) expect(detail?.pendingIntent?.values).toContainEqual({ field, value: revised[field] });
    await withTenant(ctx, tx => applyDueMovementsTx(tx, ctx, employmentId, day(7)));
    expect(await periods(employmentId)).toEqual(revised);
  });

  it('replays the later period decision after an older movement is corrected', async () => {
    const { ctx, employmentId } = await subject();
    await createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(-30), probationValue: '4' });
    const first = await applied(ctx, employmentId);
    await createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(-10), probationValue: '5' });
    await editMovementEvent(ctx, { employmentId, movementId: first.id, kind: 'promotion', effectiveDate: day(-30), probationValue: '6', reason: 'Correct the earlier offer only' });
    expect((await periods(employmentId)).probationValue).toBe('5');
    const active = (await movementHistory(ctx, employmentId)).filter(row => row.kind === 'promotion' && row.status === 'applied');
    expect(active.map(row => row.effectiveDate).sort()).toEqual([day(-30), day(-10)]);
    expect((await movementDetail(ctx, employmentId, active.find(row => row.effectiveDate === day(-10))!.id))?.flatChanges).toContainEqual({ field: 'probationValue', before: '6', after: '5' });
  });

  it('preserves a closed payroll and its payslip during an acknowledged period correction', async () => {
    const { ctx, employmentId } = await subject();
    await setCompensation(ctx, { employmentId, basicSalary: 3000, effectiveFrom: day(-90) });
    await createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(-30), ...revised });
    const movement = await applied(ctx, employmentId), period = day(-20).slice(0, 7);
    const [payMonth] = await owner.db.insert(payPeriod).values({ tenantId: base.tenantId, companyId: base.companyId, period, status: 'closed' }).returning({ id: payPeriod.id });
    const [batch] = await owner.db.insert(payrollBatch).values({ tenantId: base.tenantId, companyId: base.companyId, payPeriodId: payMonth.id, payPeriod: period, batchDate: period + '-25', status: 'closed' }).returning({ id: payrollBatch.id });
    await owner.db.insert(payslip).values({ tenantId: base.tenantId, batchId: batch.id, employmentId, basicSalary: '3000.00', grossPay: '3000.00', statutory: {}, totalDeductions: '0.00', netPay: '3000.00', employerCost: '3000.00' });
    const batchBefore = await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id, batch.id));
    const slipBefore = await owner.db.select().from(payslip).where(eq(payslip.employmentId, employmentId));
    await editMovementEvent(ctx, { employmentId, movementId: movement.id, kind: 'promotion', effectiveDate: day(-30), ...revised, noticeAfterConfirmationValue: '5', acknowledgeClosedPayroll: true, reason: 'Correct signed notice without changing paid payroll' });
    expect(await owner.db.select().from(payrollBatch).where(eq(payrollBatch.id, batch.id))).toEqual(batchBefore);
    expect(await owner.db.select().from(payslip).where(eq(payslip.employmentId, employmentId))).toEqual(slipBefore);
    expect((await periods(employmentId)).noticeAfterConfirmationValue).toBe('5');
  });

  it('imports the same period fields through canonical Movement admission', async () => {
    const { ctx, employmentId } = await subject();
    const [employee] = await owner.db.select({ code: employment.employeeCode }).from(employment).where(eq(employment.id, employmentId));
    const csv = `employee_code,event_type,effective_date,probation_value,probation_unit,notice_after_confirmation_value,notice_after_confirmation_unit\n${employee.code},promotion,${day(-30)},6,week,4,week\n`;
    const preview = await previewMovementImport(ctx, { companyId: base.companyId, csv });
    expect(preview.fileErrors).toEqual([]);
    expect(preview.employees).toHaveLength(1);
    expect(preview.employees[0].rows[0]).toMatchObject({ status: 'valid', errors: [] });
    const result = await commitMovementImport(ctx, { companyId: base.companyId, csv, fingerprints: Object.fromEntries(preview.employees.filter(row => row.fingerprint).map(row => [row.employeeCode, row.fingerprint!])), acknowledgeExcluded: true });
    expect(result).toMatchObject({ imported: 1, failed: 0 });
    expect(await periods(employmentId)).toEqual({ ...initial, probationValue: '6', probationUnit: 'week', noticeAfterConfirmationValue: '4', noticeAfterConfirmationUnit: 'week' });
  });

  it('enforces field controls and value/unit validation transactionally rather than trusting the form', async () => {
    const { ctx, employmentId } = await subject();
    const { code } = await saveMovementEventType(ctx, { label: 'Fictional Period Review', behaviourKind: 'promotion' });
    await owner.db.insert(movementTypeFieldRule).values({ tenantId: base.tenantId, typeCode: code, field: 'probationValue', included: false, editable: false, mustChange: false, document: 'none' });
    const before = await events(employmentId);
    await expect(createMovementEvent(ctx, { employmentId, kind: code, effectiveDate: day(-30), probationValue: '6' })).rejects.toThrow();
    await expect(createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(-30), probationValue: '2.5' })).rejects.toThrow('whole numbers');
    await expect(createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(-30), probationUnit: 'year' })).rejects.toThrow('Month, Week or Day');
    await expect(createMovementEvent(ctx, { employmentId, kind: 'promotion', effectiveDate: day(-30), probationUnit: null })).rejects.toThrow('Month, Week or Day');
    expect(await periods(employmentId)).toEqual(initial);
    expect(await events(employmentId)).toEqual(before);
    // Reading the configuration above never granted maintenance authority to an ordinary employee.
    await expect(createMovementEvent({ ...ctx, roles: ['employee'], grants: [] }, { employmentId, kind: 'promotion', effectiveDate: day(-30), ...revised })).rejects.toThrow();
  });
});
