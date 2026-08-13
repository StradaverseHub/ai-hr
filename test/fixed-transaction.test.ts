/**
 * 1.2.1 Fixed Transaction — per-employee fixed allowance/deduction with currency, prorate override,
 * remarks, and an effective start/end window. Reuses employment_pay_component's valid_from/valid_to axis;
 * the kernel + list queries are period-aware. Covers: start<=end validation, MYR-only currency guard,
 * prorate override (inherit/yes/no) against the EA-1955 employee tenure factor, the period window with its
 * inclusive/exclusive boundaries, the legacy-window no-op, supersession-vs-end-date reconciliation, the
 * active/ended list distinction, and the event payload (carries the new refs, never `amount`).
 *
 * TYPED PAY COMPONENTS — HOW THIS FILE TURNS THE GATE ON (ADR-0077 slice 3).
 * Every payslip-producing helper/test below needs `typed_pay_components` ON, because that gate is what
 * makes the kernel source earnings from the component tables at all — with it off, `earningsOf` reads
 * compensation + payroll_input and the payslip `allowance` column would be the compensation allowance
 * (0 here), so every window/prorate assertion would read 0 and the file would prove nothing.
 *
 * That used to be an env write of the TYPED_PAY_COMPONENTS_ENABLED flag immediately before
 * `generatePayslips`. (Spelled without the `process.env.` prefix on purpose: the slice-3 worklist scan
 * in test/module-catalog-drift.test.ts greps this tree for env-gate assignments, and a comment quoting
 * one verbatim would re-list this file as still unconverted.)
 *
 * It is now a `tenant_module` ROW (`setModule(tenantId, 'typed_pay_components',
 * 'active')`) plus the CONTEXT that can see it. The context half is not optional: `adminCtx` carries a
 * SYNTHETIC snapshot derived from `legacyEnabledModulesIn(process.env)` (test/harness.ts), and
 * test/env.ts deletes that var — so an `adminCtx` would report the module OFF no matter what row
 * exists. `generatePayslips` is therefore driven through `entitledCtx`, a real snapshot resolved from
 * this tenant's rows, and it is resolved AFTER the `setModule` write (the snapshot is point-in-time).
 *
 * The `beforeEach`/`afterEach` that used to `delete` the var are gone rather than translated: seedBase
 * seeds NO `tenant_module` row for this code under the suite's env, and a missing row is disabled (C7),
 * so the pre-test state this file starts from is already "off" — and `resetDb()` truncates
 * `tenant_module` between tests, so a grant cannot leak into the next one.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import {
  FixedTransactionAmountError,
  FixedTransactionBackwardsError,
  FixedTransactionDateError,
  FixedTransactionMidMonthError,
  FixedTransactionNotFoundError,
  FixedTransactionOverlapError,
  FixedTransactionPaidError,
  archiveEmploymentPayComponent,
  backfillEmploymentComponentsFromCompensation,
  endEmploymentPayComponent,
  listEmploymentPayComponents,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  updateEmploymentPayComponent,
  UnsupportedFixedCurrencyError,
} from '../core/pay-components';
// 2aed39d4 — the data repair is rehearsed in this file, in the production sequence (repair, then
// constraint), because neither half is provable on its own.
import { runRepair } from '../scripts/repair-fixed-transaction-overlaps';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

/**
 * Grant `typed_pay_components` to the fixture tenant and hand back a context that can SEE the grant.
 *
 * Resolved after the write on purpose — `entitledCtx` is a point-in-time read, exactly like a real
 * session, so a row written afterwards would not be in the snapshot.
 */
async function typedComponentsCtx(b: Base): Promise<SessionContext> {
  await setModule(b.tenantId, 'typed_pay_components', 'active');
  return entitledCtx(b);
}

const hire = (ctx: SessionContext, b: Base, name: string, hiredOn: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });

/** Resolve a catalog component id by code (after seeding). */
async function codeId(ctx: SessionContext, code: string): Promise<string> {
  const cat = await listPayComponents(ctx);
  return cat.find((c) => c.code === code)!.id;
}

/** The single payslip for a batch (owner read, bypasses RLS). */
async function payslipOf(batchId: string) {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
}

/** The raw stored row for a recurring component value (owner read). */
async function rowOf(id: string) {
  const [row] = await owner.db.select().from(schema.employmentPayComponent).where(eq(schema.employmentPayComponent.id, id));
  return row;
}

describe('1.2.1 Fixed Transaction', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // No gate reset needed: seedBase seeds no `typed_pay_components` row under the suite's env and a
    // missing row is disabled (C7), so each test starts with the module OFF. See the file header.
  });
  afterAll(async () => {
    await closeAll();
  });

  // ───────────────────── validation ─────────────────────

  it('start<=end is accepted; effectiveTo < effectiveFrom throws FixedTransactionDateError', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'DateOk', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');

    // start <= end accepted (equal and proper ranges).
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-03-01', effectiveTo: '2026-03-01' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-04-01', effectiveTo: '2026-06-30' }),
    ).resolves.toMatchObject({ id: expect.any(String) });

    // end before start rejected, before any write.
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-05-01', effectiveTo: '2026-04-30' }),
    ).rejects.toBeInstanceOf(FixedTransactionDateError);
  });

  it('currency persists; a non-MYR currency throws UnsupportedFixedCurrencyError at write time', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'Cur', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');

    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 250, effectiveFrom: '2026-01-01', currency: 'MYR', remarks: 'phone' });
    const row = await rowOf(id);
    expect(row.currency).toBe('MYR');
    expect(row.remarks).toBe('phone');

    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 250, effectiveFrom: '2026-02-01', currency: 'USD' }),
    ).rejects.toBeInstanceOf(UnsupportedFixedCurrencyError);
  });

  // ───────────────────── prorate override ─────────────────────
  // A mid-month joiner on 2026-05-16 (May has 31 days) is employed days 16..31 = 16 days ⇒ factor 16/31.
  // ALLOWANCE prorates=true in the catalog. The payslip `allowance` column is exactly the applied
  // ALLOWANCE value (basic never lands in it), so it cleanly reflects the resolved prorate. Basic is a
  // small positive figure — feedback 64fb5e48 made a zero Personnel basic a pre-processing BLOCKER.
  async function joinerAllowance(prorateOverride: boolean | null): Promise<number> {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, `Joiner${prorateOverride}`, '2026-05-16');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-05-16' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    // BASIC mirrors the compensation basic; ALLOWANCE 1000 with the override under test.
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-05-16' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 1000, effectiveFrom: '2026-05-16', prorateOverride });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    const ps = await payslipOf(batchId);
    return Number(ps.allowance);
  }

  it('prorate override=false pays the full amount for a mid-period joiner (catalog prorates=true)', async () => {
    expect(await joinerAllowance(false)).toBeCloseTo(1000, 2);
  });

  it('prorate override=true prorates by the employee tenure factor (16/31)', async () => {
    expect(await joinerAllowance(true)).toBeCloseTo(1000 * (16 / 31), 2);
  });

  it('prorate override=null inherits the catalog flag (ALLOWANCE prorates=true ⇒ prorated)', async () => {
    // Same as override=true because the catalog flag is true — proves null = inherit, not a hidden default.
    expect(await joinerAllowance(null)).toBeCloseTo(1000 * (16 / 31), 2);
  });

  // ───────────────────── period window + boundaries ─────────────────────
  // String 'YYYY-MM-DD' comparison; period 2026-05 ⇒ periodStart 2026-05-01, periodEnd 2026-05-31.
  // A full-month employee (hired well before) so factor = 1 and the allowance is full-amount when included.
  // We probe whether a single ALLOWANCE item with a given [validFrom, validTo] window is APPLIED in May by
  // reading the payslip `allowance` column (basic never lands in it; positive per feedback 64fb5e48).
  async function appliedInMay(validFrom: string, validTo: string | null): Promise<number> {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, `Win${validFrom}${validTo ?? 'open'}`, '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-01-01' });
    // prorateOverride=false ⇒ full amount when in-window, so the value cleanly signals included (777) vs not (0).
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: validFrom, effectiveTo: validTo, prorateOverride: false });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    return Number((await payslipOf(batchId)).allowance);
  }

  // ───────────────────── 2f889bae: the regression that pays money, not row shape ─────────────────────
  // THE TEST THAT WOULD HAVE CAUGHT IT. The pre-existing "no double-count" cases assert the ROW SHAPE after
  // a supersession and never generate a payslip, so they stayed green while the defect paid twice on real
  // payslips. This one restates an item INSIDE the month being paid and reads the money.
  //
  // Before the fix the prior row was closed ON the new start date; validTo is INCLUSIVE, so both rows sat
  // in May and the kernel paid each its FULL amount — 777 + 777. Four employments on production carried
  // overlapping rows this way and three issued payslips overpaid.
  it('restating an item at a MONTH BOUNDARY pays it once — the production case', async () => {
    // This is the shape that actually overpaid on production: a prior row ending ON the new start date
    // (2026-01-01 -> 2026-08-01 alongside 2026-08-01 -> open). Closing the day before moves the old row
    // out of the paid month entirely.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'BoundaryRestate', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-01-01', prorateOverride: false });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-05-01', prorateOverride: false });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    // 777, not 1554. Asserted as a number so a failure prints the doubled figure.
    expect(Number((await payslipOf(batchId)).allowance)).toBeCloseTo(777, 2);
  });

  // ───────────────────── a3d485f6: the mid-month restatement, CLOSED ─────────────────────
  //
  // THIS BLOCK WAS AN `it.fails` UNTIL a3d485f6. It recorded, deliberately and in the same idiom this
  // repo uses for the known width no-op, that closing the prior row the day before the new start is
  // necessary but NOT sufficient: for a restatement INSIDE the month being paid the two windows are
  // adjacent (…-05-09 and 05-10-…), both overlap May, and the kernel pays each returned row its FULL
  // amount — so the item paid 777 + 777. The comment said the gate would go red the moment someone
  // fixed it, and that fixing it was a design decision belonging to the board. It is now decided: the
  // writer REFUSES the entry, the kernel is untouched (flipping its gte to gt was rejected in r180 —
  // it would change what every existing end-dated row pays in its final month), and no existing figure
  // moves. The assertions below are the same shape, no longer inverted.
  //
  // Kept as an `it.fails`-shaped pair on purpose: first that the entry is refused, then — the half that
  // actually matters and the half whose absence let this class ship — that the MONEY on a generated
  // payslip is 777 and not 1554.
  it('refuses a mid-month restatement, and the month pays 777 not 1554', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthRestate', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-01-01', prorateOverride: false });

    // The write that used to produce the second May row. `today` is pinned so the suggested date is a
    // fixed value rather than a function of when the suite runs; production callers omit it and get the
    // MYT calendar day (a UTC instant would name YESTERDAY between 00:00 and 08:00 MYT).
    const err = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-05-10',
      prorateOverride: false, today: '2026-05-04',
    }).catch((x) => x);
    // Identity, not `rejects.toThrow()` — that passes on the WRONG throw, and three other refusals in
    // this writer would satisfy a message match.
    expect(err).toBeInstanceOf(FixedTransactionMidMonthError);
    expect(err).toMatchObject({ code: 'ALLOWANCE', effectiveFrom: '2026-05-10', nextFirstOfMonth: '2026-06-01' });

    // THE MONEY. Row-shape assertions are what let this class ship, so the figure is read off a
    // generated payslip: the refused write left the table alone, so May pays the one 777 line once.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    expect(Number((await payslipOf(batchId)).allowance)).toBeCloseTo(777, 2);
  });

  // The same defect WITHOUT an overlap and WITHOUT a clash: stop the item on the 9th (a legal end date,
  // and endEmploymentPayComponent is deliberately untouched by a3d485f6), then start the next line on
  // the 15th. Nothing overlaps, so the 0426 EXCLUDE constraint, the overlap refusal and the backwards
  // refusal all stay silent — and May pays 777 + 777 all the same. This is why the refusal is scanned
  // over the calendar MONTH rather than over the clash list.
  it('refuses a mid-month RESTART after a mid-month stop — no overlap, no clash, still two lines in one month', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthRestart', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-01-01', prorateOverride: false });
    // Stopping mid-month is still allowed — one row ending mid-month cannot pay anyone twice.
    await endEmploymentPayComponent(a, { id, employmentId: e.employmentId, effectiveTo: '2026-05-09' });
    const err = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-05-15', today: '2026-05-04',
    }).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionMidMonthError);
    // The first of the NEXT month is offered, not the first of the month they typed.
    expect(err).toMatchObject({ nextFirstOfMonth: '2026-06-01' });
    // …and the same restart from the first of the next month is accepted.
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-06-01' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  // THE CASE THIS MUST NEVER REFUSE. 24 live rows on production start part-way through a month — mid-month
  // joiners, earliest 2016-10-04 — and every one of them is paid a full month today. A rule keyed on the
  // DATE rather than on a surviving sibling would have refused every one of them, and that is a real bill.
  it('ALLOWS a mid-month FIRST line for a pay item the employee does not already hold (the new-hire case)', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthJoiner', '2026-05-16');
    const allowId = await codeId(a, 'ALLOWANCE');
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 1000, effectiveFrom: '2026-05-16' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  // …and the corollary: those 24 rows must stay CORRECTABLE. Restating one from its own start date
  // supersedes it outright (supersededAt is set, and the kernel filters on isNull(supersededAt)), so one
  // row remains and the month pays once — there is nothing to refuse. Refusing it would have made every
  // mid-month row on production permanently unamendable.
  it('ALLOWS restating a mid-month line from its OWN start date — the row is superseded, not doubled', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthAmend', '2026-05-16');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-05-16' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-05-16' });
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-05-16', prorateOverride: false });
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-05-16', prorateOverride: false }),
    ).resolves.toMatchObject({ id: expect.any(String) });
    // The money confirms it: the corrected amount once, not the old one plus the new one.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    expect(Number((await payslipOf(batchId)).allowance)).toBeCloseTo(777, 2);
  });

  // A first-of-month restatement is the whole point of the refusal's message — it must still work, and
  // it must still pay once. This is 2f889bae's case re-read through a3d485f6's guard.
  it('ALLOWS a first-of-month restatement and still pays it once', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'FirstOfMonthRestate', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-01-01' });
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 400, effectiveFrom: '2026-01-01', prorateOverride: false });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-05-01', prorateOverride: false });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    expect(Number((await payslipOf(batchId)).allowance)).toBeCloseTo(777, 2);
  });

  // A mid-month line whose only live sibling ended in an EARLIER month is not a restatement of anything
  // that pays this month — the gap is genuine and the write is allowed. Guards the refusal against
  // becoming "no mid-month dates, ever".
  it('ALLOWS a mid-month line when the only live sibling ended in an earlier month', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthAfterGap', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' });
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-05-10' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  // The refusal is per PAY ITEM, not per employee: a mid-month line for a DIFFERENT component cannot
  // double-pay the first one, and two different items in one month is ordinary.
  it('ALLOWS a mid-month line for a DIFFERENT pay item the employee already holds', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthOtherItem', '2026-01-01');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'ALLOWANCE'), amount: 300, effectiveFrom: '2026-01-01' });
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-05-10' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  // The suggested date never points backwards. Entering a date in a month that has already passed still
  // yields a first-of-month the operator can adopt going forward, computed off the MYT calendar day.
  it('suggests a first-of-month that has not already gone by', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthBackdated', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01' });
    const err = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-05-10', today: '2026-08-13',
    }).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionMidMonthError);
    expect(err).toMatchObject({ nextFirstOfMonth: '2026-09-01' });
  });

  // DECEMBER ROLLS OVER TO JANUARY OF THE NEXT YEAR. The suggestion is month arithmetic
  // (`addMonths(monthOf(iso), 1)`), not a `+1` on a two-digit month, and December is the only month
  // where those two differ — a naive version suggests "2026-13-01", which is not a date at all and
  // which every other month in this file would pass over in silence.
  it('suggests January of the NEXT YEAR when the entered date is in December', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthDecember', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01' });
    const err = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-12-15', today: '2026-08-13',
    }).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionMidMonthError);
    expect(err).toMatchObject({ effectiveFrom: '2026-12-15', nextFirstOfMonth: '2027-01-01' });
    // …and the suggestion it gives is genuinely accepted, which is the only thing that makes a
    // suggested date worth printing.
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2027-01-01' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  // An EDIT (updateEmploymentPayComponent → replacesId) is the same aggregate and the same defect:
  // moving an open row's start date into the middle of a month closes it on the 9th and starts the new
  // version on the 10th, and May pays both. `replacesId` exempts a row from the overlap/backwards
  // refusals — it must NOT exempt it from this one.
  it('refuses an EDIT that moves an item to a mid-month start', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthEdit', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01' });
    const err = await updateEmploymentPayComponent(a, {
      id, employmentId: e.employmentId, amount: 500, effectiveFrom: '2026-05-10',
    }).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionMidMonthError);
  });

  it('restating an item from its OWN start date supersedes it rather than inverting the window', async () => {
    // Closing at effectiveFrom-1 would write an end date before the row's own start. Production still
    // carries one such row from before this guard existed.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'SameDayRestate', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id: first } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-03-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 250, effectiveFrom: '2026-03-01' });
    const firstRow = await rowOf(first);
    expect(firstRow.supersededAt, 'a zero-day row must be superseded, never closed into an inverted window').not.toBeNull();
    expect(firstRow.validTo).toBeNull();
  });

  it('refuses a restatement dated BEFORE the row it would close', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'BackwardRestate', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-03-01' });
    // 2aed39d4 — was FixedTransactionDateError, which the UI resolved through
    // `payroll.transactions.fixed.dateError`: "End date cannot be before the start date". Nothing is
    // wrong with the end date here — the START date is behind an existing record — so this refusal now
    // has its own type and its own message, and names the row that blocks it.
    const err = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 250, effectiveFrom: '2026-02-01',
    }).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionBackwardsError);
    expect(err).toMatchObject({ code: 'ALLOWANCE', validFrom: '2026-03-01' });
  });

  it('window boundaries: validTo == periodStart is INCLUDED (inclusive gte)', async () => {
    expect(await appliedInMay('2026-01-01', '2026-05-01')).toBeCloseTo(777, 2);
  });
  it('window boundaries: validTo one day before periodStart is EXCLUDED', async () => {
    expect(await appliedInMay('2026-01-01', '2026-04-30')).toBeCloseTo(0, 2);
  });
  it('window boundaries: validFrom == periodEnd is INCLUDED (inclusive lte)', async () => {
    expect(await appliedInMay('2026-05-31', null)).toBeCloseTo(777, 2);
  });
  it('window boundaries: validFrom one day after periodEnd is EXCLUDED', async () => {
    expect(await appliedInMay('2026-06-01', null)).toBeCloseTo(0, 2);
  });
  it('window boundaries: validFrom == periodStart is INCLUDED', async () => {
    expect(await appliedInMay('2026-05-01', '2026-05-31')).toBeCloseTo(777, 2);
  });

  it('legacy-window no-op: validFrom in a PRIOR month with validTo NULL is still included (new lte clause is a no-op for legacy rows)', async () => {
    // 2026-01-01 is months before May; the new lte(validFrom, periodEnd) clause must NOT exclude it.
    expect(await appliedInMay('2026-01-01', null)).toBeCloseTo(777, 2);
  });

  // ───────────────────── supersession vs end-date ─────────────────────

  // 2aed39d4 — THIS TEST IS STILL CORRECT AND WAS DELIBERATELY NOT REVERSED. The approved plan's step 5
  // said to reverse the assertion here, but the two windows below do NOT touch (2026-01-01..2026-03-31
  // and 2026-06-01..open), so there is no overlap and the gap genuinely is intended: the old item ended
  // in March, a new one begins in June. What changed is the OVERLAPPING sibling of this case — an ended
  // row the new window runs into — which is now refused, and is covered in the 2aed39d4 block below.
  it('end-dating an item then setting the same component again inserts a fresh open row WITHOUT overwriting the ended one (gap is intended)', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'Gap', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');

    // 1) An end-dated item (validTo set, supersededAt null).
    const { id: ended } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' });
    // 2) A later set for the SAME component — the cur lookup only matches OPEN (validTo null) rows, so the
    //    ended row is NOT matched/overwritten: a fresh open row is inserted and the ended row keeps its validTo.
    const { id: fresh } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-06-01' });

    const endedRow = await rowOf(ended);
    const freshRow = await rowOf(fresh);
    expect(ended).not.toBe(fresh);
    expect(endedRow.validTo).toBe('2026-03-31'); // untouched
    expect(endedRow.supersededAt).toBeNull();
    expect(freshRow.validFrom).toBe('2026-06-01');
    expect(freshRow.validTo).toBeNull();
  });

  it('superseding an OPEN item truncates its window at the new effectiveFrom (no double-count)', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'Trunc', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');

    // 1) An OPEN item (validTo null).
    const { id: open } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01' });
    // 2) A new value effective mid-stream — the existing OPEN row is closed the DAY BEFORE the new start.
    const { id: next } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 600, effectiveFrom: '2026-04-01' });

    const openRow = await rowOf(open);
    const nextRow = await rowOf(next);
    // 2f889bae — this used to assert '2026-04-01' and called it "no overlap". It WAS an overlap: validTo is
    // INCLUSIVE for pay components, so both rows sat in April and the item paid twice. That is not
    // hypothetical — it reached issued payslips before this was fixed.
    expect(openRow.validTo).toBe('2026-03-31'); // closed the day before the new start — no overlap
    expect(nextRow.validFrom).toBe('2026-04-01');
    expect(nextRow.validTo).toBeNull();
  });

  // ───────────────────── list: active vs ended distinction ─────────────────────

  it('listEmploymentPayComponents surfaces active + (validTo) ended rows, and excludes supersededAt rows', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'ListAE', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const housingId = await codeId(a, 'HOUSING');
    const colaId = await codeId(a, 'COLA');

    // ALLOWANCE: set once (open) then re-set — the first row is CLOSED at the new start (validTo set,
    // supersededAt null = "ended"), the second is open. Both are real history, so BOTH surface.
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 200, effectiveFrom: '2026-03-01' });
    // HOUSING: a single end-dated item (ended) — must still surface (with its validTo + remarks).
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: housingId, amount: 400, effectiveFrom: '2026-01-01', effectiveTo: '2026-02-28', currency: 'MYR', remarks: 'temp' });
    // COLA: an open row that we then mark superseded directly (the only path that hard-hides a row) — it must
    // NOT surface, distinguishing a superseded row from a merely ended one.
    const { id: colaRow } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: colaId, amount: 50, effectiveFrom: '2026-01-01' });
    await owner.db.update(schema.employmentPayComponent).set({ supersededAt: new Date() }).where(eq(schema.employmentPayComponent.id, colaRow));

    const list = await listEmploymentPayComponents(a, e.employmentId);
    const allow = list.filter((r) => r.code === 'ALLOWANCE');
    const housing = list.filter((r) => r.code === 'HOUSING');
    const cola = list.filter((r) => r.code === 'COLA');

    // Both ALLOWANCE rows surface: the ended one (validTo = 2026-02-28, the day before the new start —
    // see 2f889bae) and the open one (validTo null).
    expect(allow).toHaveLength(2);
    const allowOpen = allow.find((r) => r.validTo == null)!;
    const allowEnded = allow.find((r) => r.validTo != null)!;
    expect(Number(allowOpen.amount)).toBeCloseTo(200, 2);
    expect(allowEnded.validTo).toBe('2026-02-28');
    // The ended HOUSING row IS returned, with its end-date + remarks intact for the "ended" badge.
    expect(housing).toHaveLength(1);
    expect(housing[0].validTo).toBe('2026-02-28');
    expect(housing[0].remarks).toBe('temp');
    // The supersededAt COLA row is hidden entirely.
    expect(cola).toHaveLength(0);
  });

  // ───────────────────── event payload (substrate / PII) ─────────────────────

  it('the set event payload carries effectiveTo / currency / prorateOverride and never the amount', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'Evt', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: allowId,
      amount: 999,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      currency: 'MYR',
      prorateOverride: false,
      remarks: 'note',
    });
    const payload = await latestEventPayload(base.tenantId, id, 'employment-pay-component.set');
    expect(payload).toMatchObject({
      employmentId: e.employmentId,
      componentId: allowId,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      currency: 'MYR',
      prorateOverride: false,
    });
    // ADR-0030 Layer-0: the amount is a reference on the row, never inlined into the immutable event log.
    expect(payload).not.toHaveProperty('amount');
  });

  // ───────────────────── Fixed Transaction screen: run_type cycle (feedback b7fc8583) ─────────────────────

  it('persists runType and coerces an unknown cycle value to null', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'Cycle', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');

    // A valid cycle persists as the enum value.
    const { id: bonusId } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01', runType: 'bonus',
    });
    expect((await rowOf(bonusId)).runType).toBe('bonus');

    // An unknown/tampered value is coerced to null (unspecified), never persisted verbatim.
    const { id: badId } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-02-01', runType: 'monthly' as never,
    });
    expect((await rowOf(badId)).runType).toBeNull();

    // Omitting runType leaves it null (byte-identical to the people-editor path, which never sends it).
    const { id: noneId } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-03-01',
    });
    expect((await rowOf(noneId)).runType).toBeNull();
  });

  it('the set event payload carries the cleaned runType and still never carries amount or remarks', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'CycleEvt', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-01-01',
      runType: 'off_cycle', remarks: 'phone bill',
    });
    const payload = await latestEventPayload(base.tenantId, id, 'employment-pay-component.set');
    expect(payload).toMatchObject({ employmentId: e.employmentId, componentId: allowId, runType: 'off_cycle' });
    // Constrained enum is safe in the log; the free-text remarks + the amount are PDPA-excluded (ADR-0030 L0).
    expect(payload).not.toHaveProperty('amount');
    expect(payload).not.toHaveProperty('remarks');

    // An unknown cycle is cleaned to null in the payload too (never leaks the raw value).
    const { id: id2 } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-02-01', runType: 'garbage' as never,
    });
    const payload2 = await latestEventPayload(base.tenantId, id2, 'employment-pay-component.set');
    expect(payload2).toMatchObject({ runType: null });
  });

  it('listEmploymentPayComponents returns run_type for the table', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'CycleList', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const housingId = await codeId(a, 'HOUSING');
    // One row with a cycle, one without (legacy/people-editor style) — the list surfaces both, null preserved.
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01', runType: 'adjustment' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: housingId, amount: 200, effectiveFrom: '2026-01-01' });

    const list = await listEmploymentPayComponents(a, e.employmentId);
    expect(list.find((r) => r.code === 'ALLOWANCE')!.runType).toBe('adjustment');
    expect(list.find((r) => r.code === 'HOUSING')!.runType).toBeNull();
  });

  // ───────────────────── amount>0 guard (feedback b7fc8583) ─────────────────────

  it('amount <= 0 throws FixedTransactionAmountError at the service boundary for a normal write', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'AmtGuard', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');

    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 0, effectiveFrom: '2026-01-01' }),
    ).rejects.toBeInstanceOf(FixedTransactionAmountError);
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: -5, effectiveFrom: '2026-01-01' }),
    ).rejects.toBeInstanceOf(FixedTransactionAmountError);
    // A strictly-positive amount is accepted.
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 0.01, effectiveFrom: '2026-01-01' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("the backfill's allowZeroAmount path still writes a 0-amount row without throwing", async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    // A compensation row with a ZERO monthly allowance — the backfill must seed a 0-amount ALLOWANCE row.
    const e = await hire(a, base, 'BackfillZero', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    await expect(backfillEmploymentComponentsFromCompensation(a)).resolves.toBeDefined();
    const list = await listEmploymentPayComponents(a, e.employmentId);
    const allow = list.find((r) => r.code === 'ALLOWANCE');
    expect(allow).toBeDefined();
    expect(Number(allow!.amount)).toBeCloseTo(0, 2);
  });

  it('effectiveTo < effectiveFrom still throws FixedTransactionDateError with a runType present', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'CycleDate', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    await expect(
      setEmploymentPayComponent(a, {
        employmentId: e.employmentId, componentId: allowId, amount: 100,
        effectiveFrom: '2026-05-01', effectiveTo: '2026-04-30', runType: 'regular',
      }),
    ).rejects.toBeInstanceOf(FixedTransactionDateError);
  });

  it('run_type does NOT alter payslip output (calculation-unchanged guarantee)', async () => {
    // Two identical mid-month joiners in the SAME company/period; one carries a cycle tag, one does not. The
    // payslip allowance column must be byte-identical — the stored run_type is decorative for payout here.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');

    async function allowanceOf(name: string, ic: string, withCycle: boolean): Promise<string> {
      const e = await hire(a, base, name, '2026-05-16');
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-05-16' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
      await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-05-16' });
      await setEmploymentPayComponent(a, {
        employmentId: e.employmentId, componentId: allowId, amount: 1000, effectiveFrom: '2026-05-16', prorateOverride: false,
        runType: withCycle ? 'bonus' : null,
      });
      return e.employmentId;
    }
    const withId = await allowanceOf('CycleCalcYes', '900101011234', true);
    const withoutId = await allowanceOf('CycleCalcNo', '900202022345', false);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });

    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const withSlip = slips.find((p) => p.employmentId === withId)!;
    const withoutSlip = slips.find((p) => p.employmentId === withoutId)!;
    // Both joined 2026-05-16 with an identical 1000 non-prorating allowance ⇒ identical allowance column.
    expect(withSlip.allowance).toBe(withoutSlip.allowance);
  });

  // ───────────────── Edit / Stop / Remove lifecycle (feedback 1e2704f2) ─────────────────

  it('updateEmploymentPayComponent VERSIONS the value: prior open row is closed at effectiveFrom, a new open row carries the new amount (no double-count)', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'EditVer', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');

    const { id: original } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01', runType: 'regular' });
    // Edit: raise the amount from 2026-04-01 forward.
    const { id: edited } = await updateEmploymentPayComponent(a, { id: original, employmentId: e.employmentId, amount: 600, effectiveFrom: '2026-04-01', runType: 'bonus' });

    expect(edited).not.toBe(original);
    const orig = await rowOf(original);
    const now = await rowOf(edited);
    // 2f889bae — was '2026-04-01', which overlapped the new row for the whole of April and double-paid.
    expect(orig.validTo).toBe('2026-03-31'); // closed the day before the new start — no overlap
    expect(orig.supersededAt).toBeNull();
    expect(Number(now.amount)).toBeCloseTo(600, 2);
    expect(now.validFrom).toBe('2026-04-01');
    expect(now.validTo).toBeNull();
    expect(now.runType).toBe('bonus');
    // The list shows the ended prior version + the current one (both non-superseded).
    const allow = (await listEmploymentPayComponents(a, e.employmentId)).filter((r) => r.code === 'ALLOWANCE');
    expect(allow).toHaveLength(2);
  });

  it('updateEmploymentPayComponent re-runs the guards (amount>0, end>=start)', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'EditGuard', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01' });

    await expect(
      updateEmploymentPayComponent(a, { id, employmentId: e.employmentId, amount: 0, effectiveFrom: '2026-02-01' }),
    ).rejects.toBeInstanceOf(FixedTransactionAmountError);
    await expect(
      updateEmploymentPayComponent(a, { id, employmentId: e.employmentId, amount: 100, effectiveFrom: '2026-05-01', effectiveTo: '2026-04-30' }),
    ).rejects.toBeInstanceOf(FixedTransactionDateError);
  });

  it('updateEmploymentPayComponent rejects a foreign/stale id with FixedTransactionNotFoundError', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'EditNF', '2026-01-01');
    await expect(
      updateEmploymentPayComponent(a, { id: '00000000-0000-0000-0000-000000000000', employmentId: e.employmentId, amount: 100, effectiveFrom: '2026-01-01' }),
    ).rejects.toBeInstanceOf(FixedTransactionNotFoundError);
  });

  it('archiveEmploymentPayComponent drops the row from the list AND from the kernel calculation for the affected period', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'ArchDrop', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-01-01' });
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-01-01', prorateOverride: false });

    // Present before archive.
    expect((await listEmploymentPayComponents(a, e.employmentId)).some((r) => r.id === id)).toBe(true);
    await archiveEmploymentPayComponent(a, { id, employmentId: e.employmentId });
    // Gone from the list.
    expect((await listEmploymentPayComponents(a, e.employmentId)).some((r) => r.id === id)).toBe(false);
    // Gone from payroll: the May payslip pays 0 allowance (kernel requires supersededAt IS NULL).
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    expect(Number((await payslipOf(batchId)).allowance)).toBeCloseTo(0, 2);
  });

  it('archiveEmploymentPayComponent appends an employment-pay-component.archived event (no amount, no remarks)', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'ArchEvt', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-01-01', remarks: 'phone' });
    await archiveEmploymentPayComponent(a, { id, employmentId: e.employmentId });
    const payload = await latestEventPayload(base.tenantId, id, 'employment-pay-component.archived');
    expect(payload).toMatchObject({ employmentId: e.employmentId });
    expect(payload).not.toHaveProperty('amount');
    expect(payload).not.toHaveProperty('remarks');
  });

  it('archiveEmploymentPayComponent rejects a foreign id and an already-archived row with FixedTransactionNotFoundError', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'ArchNF', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-01-01' });
    await archiveEmploymentPayComponent(a, { id, employmentId: e.employmentId });
    // Second archive finds no non-superseded row.
    await expect(archiveEmploymentPayComponent(a, { id, employmentId: e.employmentId })).rejects.toBeInstanceOf(FixedTransactionNotFoundError);
  });

  it('endEmploymentPayComponent end-dates the row: it keeps paying THROUGH validTo then stops, and shows as ended', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'StopDate', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-01-01' });
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-01-01', prorateOverride: false });

    // Stop it at 2026-05-31 (inclusive) — May is the last month it pays.
    await endEmploymentPayComponent(a, { id, employmentId: e.employmentId, effectiveTo: '2026-05-31' });
    const row = await rowOf(id);
    expect(row.validTo).toBe('2026-05-31');
    expect(row.supersededAt).toBeNull();
    // Still listed (ended, not superseded).
    expect((await listEmploymentPayComponents(a, e.employmentId)).some((r) => r.id === id)).toBe(true);

    // Pays in May (validTo == periodEnd is inclusive) …
    const may = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    // One grant, one snapshot, reused for BOTH runs — the June run must see the module ON too, or its
    // 0 allowance would be the gate being off rather than the end-date taking effect.
    const gated = await typedComponentsCtx(base);
    await generatePayslips(gated, { batchId: may.batchId });
    expect(Number((await payslipOf(may.batchId)).allowance)).toBeCloseTo(500, 2);
    // … and NOT in June (validTo < periodStart).
    const jun = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(gated, { batchId: jun.batchId });
    const junSlip = (await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, jun.batchId), eq(schema.payslip.employmentId, e.employmentId))))[0];
    expect(Number(junSlip.allowance)).toBeCloseTo(0, 2);
  });

  it('endEmploymentPayComponent rejects an end-date before the row start (FixedTransactionDateError) and a foreign id (FixedTransactionNotFoundError)', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'StopGuard', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-03-01' });
    await expect(
      endEmploymentPayComponent(a, { id, employmentId: e.employmentId, effectiveTo: '2026-02-01' }),
    ).rejects.toBeInstanceOf(FixedTransactionDateError);
    await expect(
      endEmploymentPayComponent(a, { id: '00000000-0000-0000-0000-000000000000', employmentId: e.employmentId, effectiveTo: '2026-05-01' }),
    ).rejects.toBeInstanceOf(FixedTransactionNotFoundError);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // 2aed39d4 — TWO RECORDS FOR THE SAME PAY ITEM MAY NEVER COVER THE SAME DAY
  //
  // Every case below asserts MONEY where money is the point, through the same seed-then-read-the-payslip
  // harness the rest of this file uses. Row-shape assertions are exactly what let the previous version of
  // this defect ship: the pre-existing "no double-count" cases checked validTo after a supersession and
  // never generated a payslip, so they stayed green while real payslips overpaid.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════

  /** The X000001 shape, seeded BEHIND the service (which now refuses it) so the fixtures can be built. */
  async function insertRaw(p: {
    employmentId: string; componentId: string; amount: number; validFrom: string; validTo: string | null;
    runType?: 'regular' | 'off_cycle' | 'bonus' | 'adjustment' | null;
  }) {
    const [row] = await owner.db
      .insert(schema.employmentPayComponent)
      .values({
        tenantId: base.tenantId,
        employmentId: p.employmentId,
        componentId: p.componentId,
        amount: String(p.amount),
        validFrom: p.validFrom,
        validTo: p.validTo,
        prorateOverride: false,
        runType: p.runType ?? null,
      })
      .returning({ id: schema.employmentPayComponent.id });
    return row.id;
  }

  it('a create whose window runs into a live END-DATED row is refused, and the item still pays once', async () => {
    // The reporter's expected-behaviour point 2, verbatim: an existing 2026-01-01..2026-12-31 record,
    // and a new one starting 2026-06-01. Before this it inserted silently and BOTH rows paid in full.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'OverlapRefuse', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', prorateOverride: false });

    const err = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-06-01', prorateOverride: false,
    }).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionOverlapError);
    // NAMED: the banner has to be able to say which record and which dates.
    expect(err).toMatchObject({ code: 'ALLOWANCE', validFrom: '2026-01-01', validTo: '2026-12-31' });

    // Refused BEFORE any write — one live row, not two, and May pays 777 once.
    const live = (await listEmploymentPayComponents(a, e.employmentId)).filter((r) => r.code === 'ALLOWANCE');
    expect(live).toHaveLength(1);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    expect(Number((await payslipOf(batchId)).allowance)).toBeCloseTo(777, 2);
  });

  it('two rows differing ONLY by Payroll Cycle are refused — the cycle is deliberately NOT in the key', async () => {
    // The reporting ticket asked for employee + pay item + period + Payroll Cycle. The kernel never reads
    // run_type, so two rows differing only by cycle BOTH pay in full — which is why the cycle is out of
    // the key. Two of the ten clashes measured on production are exactly this shape.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'CycleOverlap', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', runType: 'regular' });
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', runType: 'bonus' }),
    ).rejects.toBeInstanceOf(FixedTransactionOverlapError);
  });

  it('two DIFFERENT pay items with identical windows stay legal', async () => {
    // The key is employment + component. An employee holding a phone allowance and a travel allowance
    // over the same dates is ordinary, and must not be caught by any of this.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'TwoItems', '2026-01-01');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'ALLOWANCE'), amount: 100, effectiveFrom: '2026-07-01', effectiveTo: '2026-07-01' });
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'HOUSING'), amount: 400, effectiveFrom: '2026-07-01', effectiveTo: '2026-07-01' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('EDITING AN ENDED ROW CHANGES IT INSTEAD OF CLONING IT — the X000001 one-click duplicate', async () => {
    // X000001 pressed Save on an already-ended HANDPHONE ALLOWANCE row and got a COPY of it, twice, two
    // minutes apart, because the prior-row lookup required validTo IS NULL and the employee had no open
    // row. Asserted in money: a re-run of the covered month must pay the item ONCE.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'EndedEditClone', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-01-01' });
    const allowId = await codeId(a, 'ALLOWANCE');
    // An ENDED row entirely inside May — the shape the [id] page renders an Edit form for.
    const { id: ended } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-05-01', effectiveTo: '2026-05-01', prorateOverride: false,
    });
    // Save with the dates unchanged and a new amount — exactly what the form posts.
    const { id: edited } = await updateEmploymentPayComponent(a, {
      employmentId: e.employmentId, id: ended, amount: 150, effectiveFrom: '2026-05-01', effectiveTo: '2026-05-01', prorateOverride: false,
    });
    expect(edited).not.toBe(ended);
    // The row that was edited is SUPERSEDED, not left live beside its copy.
    expect((await rowOf(ended)).supersededAt).not.toBeNull();
    expect((await listEmploymentPayComponents(a, e.employmentId)).filter((r) => r.code === 'ALLOWANCE')).toHaveLength(1);
    // And the money: 150 once, not 250 and not 100.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    expect(Number((await payslipOf(batchId)).allowance)).toBeCloseTo(150, 2);
  });

  it('editing an ended row from a LATER date versions it: the old window is truncated, both rows survive', async () => {
    // The reporter's expected-behaviour point 3 applied to an END-DATED row: 100 from January to
    // December, changed to 150 from July, must become 100 Jan–Jun and 150 Jul–Dec.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'EndedEditLater', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id: original } = await setEmploymentPayComponent(a, {
      employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
    });
    const { id: next } = await updateEmploymentPayComponent(a, {
      employmentId: e.employmentId, id: original, amount: 150, effectiveFrom: '2026-07-01', effectiveTo: '2026-12-31',
    });
    expect((await rowOf(original)).validTo).toBe('2026-06-30');
    expect((await rowOf(original)).supersededAt).toBeNull();
    expect((await rowOf(next)).validFrom).toBe('2026-07-01');
    expect((await listEmploymentPayComponents(a, e.employmentId)).filter((r) => r.code === 'ALLOWANCE')).toHaveLength(2);
  });

  it('editing a row to start EARLIER corrects that record — it does not reach backwards through another', async () => {
    // The backwards refusal is about restating THROUGH a row the admin is not looking at. Pulling the
    // start date of the record they DO have open back a month is the ticket's Edit function, and it
    // rewrites nothing: the row is superseded outright, never closed into an inverted window (which is
    // how production came to carry one).
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'EditStartEarlier', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-07-01', effectiveTo: '2026-07-31' });
    const { id: moved } = await updateEmploymentPayComponent(a, { employmentId: e.employmentId, id, amount: 100, effectiveFrom: '2026-06-01', effectiveTo: '2026-07-31' });
    expect((await rowOf(id)).supersededAt).not.toBeNull();
    expect((await rowOf(moved)).validFrom).toBe('2026-06-01');
    // No inverted window anywhere.
    const live = (await listEmploymentPayComponents(a, e.employmentId)).filter((r) => r.code === 'ALLOWANCE');
    expect(live).toHaveLength(1);
    for (const r of live) expect(r.validTo == null || r.validTo >= r.validFrom).toBe(true);
  });

  it('an edit is still refused when it runs into a THIRD row that is not the one being edited', async () => {
    // replacesId exempts exactly one row — the one the admin opened. Everything else it collides with is
    // still a refusal, or the edit form would become a way around the rule.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'EditThirdRow', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id: first } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 200, effectiveFrom: '2026-06-01', effectiveTo: '2026-09-30' });
    // Stretch the FIRST row's end date over the second one.
    await expect(
      updateEmploymentPayComponent(a, { employmentId: e.employmentId, id: first, amount: 100, effectiveFrom: '2026-01-01', effectiveTo: '2026-07-31' }),
    ).rejects.toBeInstanceOf(FixedTransactionOverlapError);
  });

  // ───────────────────── the constraint (migration 0426) is the backstop ─────────────────────

  it('the 0426 EXCLUDE constraint rejects an overlapping row inserted BEHIND the service', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'ConstraintBackstop', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    await insertRaw({ employmentId: e.employmentId, componentId: allowId, amount: 100, validFrom: '2026-07-01', validTo: '2026-07-01' });
    // ⚠️ NOT `.rejects.toThrow()` — that passes on ANY throw, including a NOT NULL failure in the fixture
    // that never reaches the constraint under test. The constraint is asserted BY NAME.
    const err = await insertRaw({ employmentId: e.employmentId, componentId: allowId, amount: 150, validFrom: '2026-07-01', validTo: '2026-07-01' }).catch((x) => x);
    expect(err).toBeInstanceOf(Error);
    const text = `${(err as Error).message} ${(err as { cause?: Error }).cause?.message ?? ''}`;
    expect(text).toContain('employment_pay_component_no_overlap');
  });

  it('the constraint is INCLUSIVE-INCLUSIVE: abutting rows are legal, rows meeting ON a day are not', async () => {
    // This is the single line not to copy from compensation_no_overlap / employee_cp38_no_overlap, both
    // of which are HALF-OPEN. valid_to is INCLUSIVE here, so [..,07-01] and [07-01,..] DO collide — and
    // that pair is exactly what reached issued payslips before 34cc8137.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'ConstraintBounds', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const housingId = await codeId(a, 'HOUSING');
    // Legal: closed the day before.
    await insertRaw({ employmentId: e.employmentId, componentId: allowId, amount: 100, validFrom: '2026-01-01', validTo: '2026-06-30' });
    await expect(insertRaw({ employmentId: e.employmentId, componentId: allowId, amount: 150, validFrom: '2026-07-01', validTo: null })).resolves.toEqual(expect.any(String));
    // Illegal: closed ON the new start date.
    await insertRaw({ employmentId: e.employmentId, componentId: housingId, amount: 100, validFrom: '2026-01-01', validTo: '2026-07-01' });
    const err = await insertRaw({ employmentId: e.employmentId, componentId: housingId, amount: 150, validFrom: '2026-07-01', validTo: null }).catch((x) => x);
    expect(`${(err as Error).message} ${(err as { cause?: Error }).cause?.message ?? ''}`).toContain('employment_pay_component_no_overlap');
  });

  // ───────────────────── removal / edit by PAY RUN STATUS (expected behaviour point 7) ─────────────────────

  it('REMOVAL IS ALLOWED while the covering run is processed — and refused once it is CLOSED', async () => {
    // The reporter's point 7, and a deliberate REVERSAL of what f1123afd shipped. Their worked example is
    // "payroll processed -> HR finds the wrong item -> delete -> reprocess", which used to be refused.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'RemoveByStatus', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-01-01' });
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id: keep } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-01-01', prorateOverride: false });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    // The payslip really does itemise it — so this is NOT passing because the evidence is absent.
    const st = (await payslipOf(batchId)).statutory as { componentLines?: { code: string }[] };
    expect(st.componentLines?.map((l) => l.code)).toContain('ALLOWANCE');
    // PROCESSED, not closed: removal goes through.
    await expect(archiveEmploymentPayComponent(a, { id: keep, employmentId: e.employmentId })).resolves.toMatchObject({ id: keep });

    // Now close the run and try again with a second item covering the same month.
    const { id: second } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01', prorateOverride: false });
    await closeBatch(a, { batchId });
    const err = await archiveEmploymentPayComponent(a, { id: second, employmentId: e.employmentId }).catch((x) => x);
    expect(err).toBeInstanceOf(FixedTransactionPaidError);
    expect(err).toMatchObject({ code: 'ALLOWANCE', payPeriod: '2026-05' });
    // Refused BEFORE any write.
    expect((await rowOf(second)).supersededAt).toBeNull();
  });

  it('a row whose window does NOT reach the closed month is still removable', async () => {
    // The refusal is about the row's own window, not "this employee has a closed run".
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'RemoveOutsideClosed', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    await closeBatch(a, { batchId });
    const { id: later } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'ALLOWANCE'), amount: 700, effectiveFrom: '2026-09-01' });
    await expect(archiveEmploymentPayComponent(a, { id: later, employmentId: e.employmentId })).resolves.toMatchObject({ id: later });
  });

  it('the closed-month boundary is INCLUSIVE: a row ending ON the last day of a closed month is frozen', async () => {
    // overlapsClosedPeriod treats its `to` as EXCLUSIVE (it was written for compensation). valid_to is
    // INCLUSIVE here, so it is converted with +1 day on the way in. Without that conversion a row whose
    // LAST PAID month is the closed one slips straight past the guard — which is the whole bug class.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'ClosedBoundary', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-01-01' });
    const allowId = await codeId(a, 'ALLOWANCE');
    const { id } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-01-01', effectiveTo: '2026-05-01', prorateOverride: false });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    await closeBatch(a, { batchId });
    // validTo 2026-05-01 is INSIDE closed 2026-05 — frozen.
    await expect(archiveEmploymentPayComponent(a, { id, employmentId: e.employmentId })).rejects.toBeInstanceOf(FixedTransactionPaidError);
  });

  it('a WRITE into a closed month is refused too, not just a removal', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'WriteIntoClosed', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await codeId(a, 'BASIC'), amount: 1000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    await closeBatch(a, { batchId });
    const allowId = await codeId(a, 'ALLOWANCE');
    // Starts inside the closed month.
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-05-10' }),
    ).rejects.toBeInstanceOf(FixedTransactionPaidError);
    // Starts after it — fine.
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 500, effectiveFrom: '2026-06-01' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  // ───────────────────── the backfill must not start throwing (step 8) ─────────────────────

  it('the compensation backfill still runs clean OVER an existing overlapping row, and leaves no overlap', async () => {
    // backfillEmploymentComponentsFromCompensation re-states BASIC/ALLOWANCE from each open compensation
    // row at THAT ROW'S OWN validFrom, which is routinely behind whatever the component table holds — it
    // PRODUCED one of the ten overlaps measured on production, and 34cc8137's backwards guard had already
    // put it one run away from throwing. It opts out explicitly (supersedeOverlaps + allowClosedPeriod).
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'BackfillOverRow', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 250, effectiveFrom: '2026-01-01' });
    const basicId = await codeId(a, 'BASIC');
    // A LATER, still-live BASIC row — the backfill's 2026-01-01 restatement runs backwards into it.
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 6800, effectiveFrom: '2026-08-01' });

    await expect(backfillEmploymentComponentsFromCompensation(a)).resolves.toBeDefined();

    // And the result is overlap-free — which the 0426 constraint would have enforced anyway, so a failure
    // here would have surfaced as a raw 23P01 out of a housekeeping script.
    const live = (await listEmploymentPayComponents(a, e.employmentId)).filter((r) => r.code === 'BASIC');
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const [x, y] = [live[i], live[j]];
        expect(x.validFrom <= (y.validTo ?? '9999-12-31') && y.validFrom <= (x.validTo ?? '9999-12-31')).toBe(false);
      }
    }
  });

  it('the backfill is idempotent: running it twice changes nothing and throws nothing', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'BackfillTwice', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 250, effectiveFrom: '2026-01-01' });
    await backfillEmploymentComponentsFromCompensation(a);
    await expect(backfillEmploymentComponentsFromCompensation(a)).resolves.toBeDefined();
    const live = await listEmploymentPayComponents(a, e.employmentId);
    expect(live.filter((r) => r.code === 'BASIC')).toHaveLength(1);
    expect(live.filter((r) => r.code === 'ALLOWANCE')).toHaveLength(1);
  });

  // ───────────────────── the data repair, rehearsed in the production sequence ─────────────────────

  it('the repair script clears the production shapes, and 0426 cannot be applied until it has', async () => {
    // REPAIR FIRST, CONSTRAINT SECOND — rehearsed here in that order, against a real cluster, because it
    // is the order the release has to run in and neither half is provable on its own.
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'RepairRehearsal', '2026-01-01');
    const allowId = await codeId(a, 'ALLOWANCE');
    const housingId = await codeId(a, 'HOUSING');
    const url = process.env.TEST_MIGRATION_DATABASE_URL!;
    const addConstraint = () =>
      owner.db.execute(sql`ALTER TABLE employment_pay_component ADD CONSTRAINT employment_pay_component_no_overlap
        EXCLUDE USING gist (employment_id WITH =, component_id WITH =,
          daterange(valid_from, COALESCE(valid_to, DATE '9999-12-31'), '[]') WITH &&) WHERE (superseded_at IS NULL)`);

    await owner.db.execute(sql`ALTER TABLE employment_pay_component DROP CONSTRAINT employment_pay_component_no_overlap`);
    try {
      // (a) X000001's three rows, all 2026-07-01..2026-07-01, newest last.
      const oldest = await insertRaw({ employmentId: e.employmentId, componentId: allowId, amount: 100, validFrom: '2026-07-01', validTo: '2026-07-01', runType: 'regular' });
      const middle = await insertRaw({ employmentId: e.employmentId, componentId: allowId, amount: 150, validFrom: '2026-07-01', validTo: '2026-07-01', runType: 'regular' });
      const newest = await insertRaw({ employmentId: e.employmentId, componentId: allowId, amount: 150, validFrom: '2026-07-01', validTo: '2026-07-01', runType: 'regular' });
      // (b) the INVERTED row — production carries exactly one (EMP-0001 ALLOWANCE 200.00).
      const invertedId = await insertRaw({ employmentId: e.employmentId, componentId: housingId, amount: 200, validFrom: '2026-01-31', validTo: '2026-01-06' });

      // THE INVERTED ROW ABORTS THE ALTER WITH A RANGE ERROR, NOT A CONFLICT ERROR. Proving which failure
      // comes first is the point: someone reading only "conflicting key value" would repair the overlaps,
      // re-run, and hit a second wall they had no warning of.
      const first = await addConstraint().catch((x) => x);
      expect(`${(first as Error).message} ${(first as { cause?: Error }).cause?.message ?? ''}`).toContain(
        'range lower bound must be less than or equal to range upper bound',
      );

      // Report-only: writes nothing.
      const dry = await runRepair(url, { apply: false });
      expect(dry.inverted).toHaveLength(1);
      expect(dry.overlaps).toHaveLength(2); // three mutually-overlapping rows -> keep 1, clear 2
      expect(dry.residual).toHaveLength(0);
      expect((await rowOf(oldest)).supersededAt).toBeNull();

      // Apply.
      const wet = await runRepair(url, { apply: true, tag: 'r185b-rehearsal' });
      expect(wet.inverted.map((x) => x.row.id)).toEqual([invertedId]);
      // NEWEST WRITTEN WINS — the plan's "keeping the most recent line of each group".
      expect(new Set(wet.overlaps.map((x) => x.row.id))).toEqual(new Set([oldest, middle]));
      expect((await rowOf(newest)).supersededAt).toBeNull();
      expect((await rowOf(oldest)).supersededAt).not.toBeNull();
      expect((await rowOf(middle)).supersededAt).not.toBeNull();
      expect((await rowOf(invertedId)).supersededAt).not.toBeNull();

      // NOW the constraint applies — which is the actual release gate.
      await expect(addConstraint()).resolves.toBeDefined();

      // Re-running finds nothing.
      const again = await runRepair(url, { apply: false });
      expect(again.inverted).toHaveLength(0);
      expect(again.overlaps).toHaveLength(0);
    } finally {
      // Never leave the worker DB without the constraint — every later test in this file depends on it.
      const has = await owner.db.execute(
        sql`SELECT 1 FROM pg_constraint WHERE conname = 'employment_pay_component_no_overlap'`,
      );
      if (has.length === 0) await addConstraint();
    }
  });
});
