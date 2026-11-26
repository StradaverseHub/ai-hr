/**
 * cc8bd87f — the Fixed Transaction View / Edit pop-up's ONE save, `editFixedTransaction`.
 *
 * The old page had two boxes for one stored date (employment_pay_component.valid_to, INCLUSIVE): Edit
 * versioned the row (closed-run guard over the whole window), Stop updated it in place with no closed-run,
 * overlap or same-month check at all. The pop-up has one End Date (Last Date to Pay) field, so the service
 * routes: nothing changed writes nothing; only the end date changed updates the SAME row (still possible
 * after a closed month, as Stop was) behind the checks Stop lacked; anything else versions exactly as Edit
 * did. Every refusal is asserted to leave the row as it was, and the end-date rule is asserted in MONEY
 * (the end month paid in full, the month after not paid), not just in row shape.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import {
  FixedTransactionDateError,
  FixedTransactionEndClosedMonthError,
  FixedTransactionEndSameMonthError,
  FixedTransactionNotFoundError,
  FixedTransactionOverlapError,
  editFixedTransaction,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
} from '../packs/payroll/service';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;

async function typedComponentsCtx(b: Base): Promise<SessionContext> {
  await setModule(b.tenantId, 'typed_pay_components', 'active');
  return entitledCtx(b);
}

const codeId = async (ctx: SessionContext, code: string) => (await listPayComponents(ctx)).find((c) => c.code === code)!.id;

/** One paid employee (BASIC from compensation, so every run gives them a payslip) and one ALLOWANCE line. */
async function employeeWithAllowance(opts: { from?: string; to?: string | null; remarks?: string | null } = {}) {
  const a = adminCtx(base);
  await seedPayComponentCatalog(a);
  const e = await hireEmployee(a, {
    person: { fullName: 'Popup Edit', primaryEmail: `popup${randomUUID().slice(0, 8)}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-01-01' });
  const allowId = await codeId(a, 'ALLOWANCE');
  const { id } = await setEmploymentPayComponent(a, {
    employmentId: e.employmentId,
    componentId: allowId,
    amount: 500,
    effectiveFrom: opts.from ?? '2026-01-01',
    effectiveTo: opts.to ?? null,
    remarks: opts.remarks ?? 'phone',
    prorateOverride: false,
  });
  return { a, employmentId: e.employmentId, allowId, id };
}

const rowOf = async (id: string) =>
  (await owner.db.select().from(schema.employmentPayComponent).where(eq(schema.employmentPayComponent.id, id)))[0];

const liveAllowance = async (employmentId: string, componentId: string) =>
  owner.db
    .select()
    .from(schema.employmentPayComponent)
    .where(
      and(
        eq(schema.employmentPayComponent.employmentId, employmentId),
        eq(schema.employmentPayComponent.componentId, componentId),
      ),
    )
    .orderBy(schema.employmentPayComponent.validFrom, schema.employmentPayComponent.createdAt);

const eventsOf = async (aggregateId: string, eventType?: string) =>
  owner.db
    .select({ type: schema.domainEvent.eventType, payload: schema.domainEvent.payload, actorType: schema.domainEvent.actorType })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.aggregateId, aggregateId),
        eventType ? eq(schema.domainEvent.eventType, eventType) : undefined,
      ),
    )
    .orderBy(schema.domainEvent.sequence);

/** The input that changes nothing: the row's own stored values, as the pop-up would post them untouched. */
const unchanged = (r: { id: string; employmentId: string }, over: Partial<Parameters<typeof editFixedTransaction>[1]> = {}) => ({
  id: r.id,
  employmentId: r.employmentId,
  amount: 500,
  effectiveFrom: '2026-01-01',
  effectiveTo: null as string | null,
  remarks: 'phone' as string | null,
  ...over,
});

/** A processed run for `period`, then closed. */
async function closedRun(a: SessionContext, period: string) {
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(await typedComponentsCtx(base), { batchId });
  await closeBatch(a, { batchId });
  return batchId;
}

describe('cc8bd87f — one save for the View / Edit pop-up', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  // ───────────────────── routing ─────────────────────

  it('saving with NOTHING changed writes nothing: same row, no event, no version (amount and remarks compared as stored)', async () => {
    const r = await employeeWithAllowance();
    const before = await rowOf(r.id);
    const eventsBefore = await eventsOf(r.id);
    expect(eventsBefore.length).toBeGreaterThan(0);

    // 500 vs the stored "500.00", and remarks with stray spaces, are the same values.
    await expect(editFixedTransaction(r.a, unchanged(r, { remarks: '  phone ' }))).resolves.toEqual({ id: r.id, changed: false });
    // An untouched cycle (no payrollCycleId) and one naming the row's own link are both "unchanged".
    await expect(editFixedTransaction(r.a, unchanged(r))).resolves.toEqual({ id: r.id, changed: false });

    expect(await rowOf(r.id)).toEqual(before);
    expect(await eventsOf(r.id)).toEqual(eventsBefore);
    expect(await liveAllowance(r.employmentId, r.allowId)).toHaveLength(1);
  });

  it('changing ONLY the end date updates the SAME row in place and appends .ended with the previous end date', async () => {
    const r = await employeeWithAllowance();
    await expect(editFixedTransaction(r.a, unchanged(r, { effectiveTo: '2026-12-31' }))).resolves.toEqual({ id: r.id, changed: true });

    const rows = await liveAllowance(r.employmentId, r.allowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.id, validFrom: '2026-01-01', validTo: '2026-12-31', amount: '500.00', remarks: 'phone', supersededAt: null });
    const ended = await eventsOf(r.id, 'employment-pay-component.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0].actorType).toBe('user');
    expect(ended[0].payload).toEqual({ employmentId: r.employmentId, effectiveTo: '2026-12-31', previousEffectiveTo: null });
    // ADR-0030 Layer 0: no amount and no free-text remarks in the immutable log.
    expect(JSON.stringify(ended[0].payload)).not.toContain('500');
    expect(JSON.stringify(ended[0].payload)).not.toContain('phone');
  });

  it('CLEARING the end date makes the same row open-ended again', async () => {
    const r = await employeeWithAllowance({ to: '2026-06-30' });
    await expect(editFixedTransaction(r.a, unchanged(r, { effectiveTo: null }))).resolves.toEqual({ id: r.id, changed: true });
    expect((await rowOf(r.id)).validTo).toBeNull();
    const ended = await eventsOf(r.id, 'employment-pay-component.ended');
    expect(ended.at(-1)!.payload).toEqual({ employmentId: r.employmentId, effectiveTo: null, previousEffectiveTo: '2026-06-30' });
  });

  it('amount, start date, cycle and remarks changes still VERSION the row, exactly as the old Edit did', async () => {
    const r = await employeeWithAllowance();
    // Amount from a later start: the row closes the day before and a new line starts (2f889bae).
    const amount = await editFixedTransaction(r.a, unchanged(r, { amount: 600, effectiveFrom: '2026-03-01' }));
    expect(amount.changed).toBe(true);
    expect(amount.id).not.toBe(r.id);
    let rows = (await liveAllowance(r.employmentId, r.allowId)).filter((x) => x.supersededAt == null);
    expect(rows.map((x) => [x.validFrom, x.validTo, x.amount])).toEqual([
      ['2026-01-01', '2026-02-28', '500.00'],
      ['2026-03-01', null, '600.00'],
    ]);

    // Remarks only, same start: the edited line is superseded and replaced (a new id), history kept.
    const remarks = await editFixedTransaction(r.a, { ...unchanged({ id: amount.id, employmentId: r.employmentId }), amount: 600, effectiveFrom: '2026-03-01', remarks: 'new plan' });
    expect(remarks.id).not.toBe(amount.id);
    expect((await rowOf(amount.id)).supersededAt).not.toBeNull();
    expect((await rowOf(remarks.id)).remarks).toBe('new plan');

    // A TOUCHED cycle versions and links it.
    await seedPayrollCycleCatalog(r.a, base.companyId);
    const [monthly] = await owner.db
      .select({ id: schema.payrollCycle.id })
      .from(schema.payrollCycle)
      .where(and(eq(schema.payrollCycle.companyId, base.companyId), eq(schema.payrollCycle.name, 'Monthly')));
    const cycle = await editFixedTransaction(r.a, {
      ...unchanged({ id: remarks.id, employmentId: r.employmentId }),
      amount: 600,
      effectiveFrom: '2026-03-01',
      remarks: 'new plan',
      payrollCycleId: monthly.id,
    });
    expect(cycle.id).not.toBe(remarks.id);
    expect((await rowOf(cycle.id)).payrollCycleId).toBe(monthly.id);
    // And no .ended event was written by any of the versioning saves.
    expect(await eventsOf(r.id, 'employment-pay-component.ended')).toHaveLength(0);
    rows = (await liveAllowance(r.employmentId, r.allowId)).filter((x) => x.supersededAt == null);
    expect(rows).toHaveLength(2);
  });

  it('a foreign or removed row is not found', async () => {
    const r = await employeeWithAllowance();
    await expect(editFixedTransaction(r.a, unchanged({ id: randomUUID(), employmentId: r.employmentId }))).rejects.toBeInstanceOf(FixedTransactionNotFoundError);
    // The right id under ANOTHER employee: matched on both, so not found.
    const other = await hireEmployee(r.a, {
      person: { fullName: 'Other Person', primaryEmail: `other${randomUUID().slice(0, 8)}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await expect(editFixedTransaction(r.a, unchanged({ id: r.id, employmentId: other.employmentId }))).rejects.toBeInstanceOf(FixedTransactionNotFoundError);
    expect((await rowOf(r.id)).validTo).toBeNull();
  });

  // ───────────────────── refusals of the in-place end date ─────────────────────

  it('refuses an end date before the start, and one that is not a real date, writing nothing', async () => {
    const r = await employeeWithAllowance({ from: '2026-03-01' });
    for (const bad of ['2026-02-28', '2026-02-30']) {
      await expect(
        editFixedTransaction(r.a, unchanged(r, { effectiveFrom: '2026-03-01', effectiveTo: bad })),
      ).rejects.toBeInstanceOf(FixedTransactionDateError);
    }
    expect((await rowOf(r.id)).validTo).toBeNull();
    expect(await eventsOf(r.id, 'employment-pay-component.ended')).toHaveLength(0);
  });

  it('CLOSED MONTH, shortening: ending before a closed month that paid the item is refused and names it', async () => {
    const r = await employeeWithAllowance();
    await closedRun(r.a, '2026-05');
    const err = await editFixedTransaction(r.a, unchanged(r, { effectiveTo: '2026-04-30' })).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionEndClosedMonthError);
    expect(err).toMatchObject({ code: 'ALLOWANCE', payPeriod: '2026-05' });
    expect((await rowOf(r.id)).validTo).toBeNull();
  });

  it('CLOSED MONTH, extending: running an ended item into a closed month it did not pay is refused too', async () => {
    const r = await employeeWithAllowance({ to: '2026-04-30' });
    await closedRun(r.a, '2026-05');
    for (const to of ['2026-06-30', null]) {
      const err = await editFixedTransaction(r.a, unchanged(r, { effectiveTo: to })).catch((x) => x);
      expect(err).toBeInstanceOf(FixedTransactionEndClosedMonthError);
      expect(err).toMatchObject({ payPeriod: '2026-05' });
    }
    expect((await rowOf(r.id)).validTo).toBe('2026-04-30');
  });

  it('CLOSED MONTH, allowed: ending part-way through or at the end of a closed month keeps it paid, so it saves (the Stop escape survives)', async () => {
    const r = await employeeWithAllowance();
    await closedRun(r.a, '2026-05');
    // The existing paid-guard case: end 2026-05-31 after a closed May, through the new path.
    await expect(editFixedTransaction(r.a, unchanged(r, { effectiveTo: '2026-05-31' }))).resolves.toEqual({ id: r.id, changed: true });
    await expect(editFixedTransaction(r.a, unchanged(r, { effectiveTo: '2026-05-15' }))).resolves.toEqual({ id: r.id, changed: true });
    expect((await rowOf(r.id)).validTo).toBe('2026-05-15');
  });

  it('OVERLAP: the end date cannot run into the next line for the same pay item (typed, never a raw 23P01)', async () => {
    const r = await employeeWithAllowance({ to: '2026-03-31' });
    await setEmploymentPayComponent(r.a, { employmentId: r.employmentId, componentId: r.allowId, amount: 700, effectiveFrom: '2026-05-01' });
    for (const to of ['2026-06-30', null]) {
      const err = await editFixedTransaction(r.a, unchanged(r, { effectiveTo: to })).catch((x) => x);
      expect(err).toBeInstanceOf(FixedTransactionOverlapError);
      expect(err).toMatchObject({ code: 'ALLOWANCE', validFrom: '2026-05-01', validTo: null });
    }
    expect((await rowOf(r.id)).validTo).toBe('2026-03-31');
  });

  it('SAME MONTH: the end date cannot fall in the month the next line starts, and the refusal names the latest safe end', async () => {
    const r = await employeeWithAllowance({ to: '2026-03-31' });
    // A mid-month first line for May (nothing else covers May), allowed by the a3d485f6 rule.
    await setEmploymentPayComponent(r.a, { employmentId: r.employmentId, componentId: r.allowId, amount: 700, effectiveFrom: '2026-05-10' });
    const err = await editFixedTransaction(r.a, unchanged(r, { effectiveTo: '2026-05-05' })).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionEndSameMonthError);
    expect(err).toMatchObject({ code: 'ALLOWANCE', nextFrom: '2026-05-10', latestEnd: '2026-04-30' });
    expect((await rowOf(r.id)).validTo).toBe('2026-03-31');
    // The suggested date is accepted.
    await expect(editFixedTransaction(r.a, unchanged(r, { effectiveTo: '2026-04-30' }))).resolves.toEqual({ id: r.id, changed: true });
  });

  // ───────────────────── money ─────────────────────

  it('MONEY: the month containing the end date is paid IN FULL, the month after is not paid', async () => {
    const r = await employeeWithAllowance();
    // Mid-month on purpose: the plan's promise is that the end month still pays the whole amount.
    await editFixedTransaction(r.a, unchanged(r, { effectiveTo: '2026-05-15' }));
    expect((await rowOf(r.id)).validTo).toBe('2026-05-15');

    const gated = await typedComponentsCtx(base);
    const may = await createBatch(r.a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(gated, { batchId: may.batchId });
    const jun = await createBatch(r.a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(gated, { batchId: jun.batchId });
    const slip = async (batchId: string) =>
      (
        await owner.db
          .select()
          .from(schema.payslip)
          .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, r.employmentId)))
      )[0];
    const maySlip = await slip(may.batchId);
    const junSlip = await slip(jun.batchId);
    expect(maySlip, 'May produced a payslip').toBeDefined();
    expect(junSlip, 'June produced a payslip (BASIC still pays), so its 0 allowance is the end date').toBeDefined();
    expect(Number(maySlip.allowance)).toBeCloseTo(500, 2);
    expect(Number(junSlip.allowance)).toBeCloseTo(0, 2);
  });
});
