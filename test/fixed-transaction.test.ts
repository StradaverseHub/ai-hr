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
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  FixedTransactionAmountError,
  FixedTransactionDateError,
  FixedTransactionNotFoundError,
  UnsupportedFixedCurrencyError,
  archiveEmploymentPayComponent,
  backfillEmploymentComponentsFromCompensation,
  endEmploymentPayComponent,
  listEmploymentPayComponents,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  updateEmploymentPayComponent,
} from '../core/pay-components';
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

  // ⚠️ STILL BROKEN, DELIBERATELY RECORDED — restating an item MID-MONTH still pays it twice.
  //
  // Closing the prior row the day before the new start is necessary but NOT sufficient. For a restatement
  // inside the month being paid, the two windows are adjacent (…-05-09 and 05-10-…) and BOTH overlap May,
  // and the kernel pays each row its FULL amount for any overlap (core/payroll.ts documents that rule
  // explicitly). So the item pays 777 + 777.
  //
  // Fixing it is a DESIGN DECISION, not a patch: either prorate a partial window by days, or take the
  // latest row per code per period, or refuse a restatement that lands mid-period. Each changes what
  // existing correctly-dated rows pay, so it belongs with board item 2f889bae and its owner, not here.
  //
  // Recorded with it.fails on purpose (the same idiom this repo uses for the known width no-op): the gate
  // goes RED the moment someone fixes it, which is the prompt to delete this block and assert 777.
  it.fails('KNOWN: restating an item mid-month still pays it twice', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'MidMonthRestate', '2026-01-01');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const basicId = await codeId(a, 'BASIC');
    const allowId = await codeId(a, 'ALLOWANCE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 1000, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-01-01', prorateOverride: false });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 777, effectiveFrom: '2026-05-10', prorateOverride: false });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(await typedComponentsCtx(base), { batchId });
    expect(Number((await payslipOf(batchId)).allowance)).toBeCloseTo(777, 2);
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
    await expect(
      setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 250, effectiveFrom: '2026-02-01' }),
    ).rejects.toBeInstanceOf(FixedTransactionDateError);
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
});
