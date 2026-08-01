/**
 * Payroll Transaction View (feedback a4a05174) — the three centralized READ-ONLY inquiry reads in
 * core/payroll-view.ts. Pinned properties:
 *   • cross-employee / cross-company aggregation (rows span employees and companies in one call)
 *   • SCOPE FENCING: companyIds is an application fence — out-of-scope companies never leak, and an
 *     EMPTY scope fails CLOSED (no rows), never open
 *   • filters narrow correctly: by pay item (all employees assigned), by employee, by year/month,
 *     by cycle; Fixed's active/ended split follows the same validTo-vs-today rule as the keying UI
 *   • History is processed-results-only by construction (a draft batch has no payslip rows)
 *   • row shape carries employee + company so the UI needs no second query
 * These functions are pure SELECTs — read-only, no domain event — so no event assertions here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { createIndividualTxn } from '../core/payroll-individual-txn';
import { listPayComponents, seedPayComponentCatalog, setEmploymentPayComponent } from '../core/pay-components';
import {
  listFixedTransactionsAcross,
  listIndividualTxnCreators,
  listIndividualTxnsAcross,
  listPayrollRegisterAcross,
  listProcessedPayslipsAcross,
} from '../core/payroll-view';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** A second company in the same tenant — the out-of-scope side of every fencing assertion. */
async function seedCompanyB(b: Base): Promise<{ companyId: string; deptId: string }> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c.id, name: 'Ops B' })
    .returning({ id: schema.department.id });
  return { companyId: c.id, deptId: d.id };
}

const hire = (ctx: SessionContext, companyId: string, departmentId: string, name: string, hiredOn = '2026-01-01') =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn,
  });

async function codeId(ctx: SessionContext, code: string): Promise<string> {
  const cat = await listPayComponents(ctx);
  return cat.find((c) => c.code === code)!.id;
}

describe('payroll transaction view (a4a05174) — centralized read-only inquiry', () => {
  let base: Base;
  let companyB: { companyId: string; deptId: string };
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    companyB = await seedCompanyB(base);
    // ADR-0077 slice 3: the typed-pay-components gate is a `tenant_module` row, not an env var. This
    // beforeEach used to unset TYPED_PAY_COMPONENTS_ENABLED to keep the legacy earnings path selected
    // for the history fixtures; that is now the fixture BASELINE rather than something this file
    // forces — `seedBase` seeds no `typed_pay_components` row (a missing row is disabled, C7) and
    // `resetDb` truncates `tenant_module` between tests, so OFF is true by construction.
    //
    // (No `setModule(..., null)` replaces it: this file builds sessions with `adminCtx`, whose snapshot
    // is derived rather than resolved from rows, so deleting an already-absent row would not be what
    // decides the gate. Nothing here exercises that gate — see the note in module-catalog-drift.)
  });
  afterAll(async () => {
    await closeAll();
  });

  // ───────────────────── 1. Fixed Transaction View ─────────────────────

  it('fixed: returns rows across multiple employees AND companies in one call, with employee/company shape', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const allowId = await codeId(a, 'ALLOWANCE');
    const e1 = await hire(a, base.companyId, base.deptA, 'Alice A');
    const e2 = await hire(a, base.companyId, base.deptA, 'Bob A');
    const e3 = await hire(a, companyB.companyId, companyB.deptId, 'Cara B');
    await setEmploymentPayComponent(a, { employmentId: e1.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e2.employmentId, componentId: allowId, amount: 200, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e3.employmentId, componentId: allowId, amount: 300, effectiveFrom: '2026-01-01' });

    const rows = await listFixedTransactionsAcross(a, { companyIds: [base.companyId, companyB.companyId] });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.employmentId)).size).toBe(3);
    expect(new Set(rows.map((r) => r.company))).toEqual(new Set(['Acme Sdn Bhd', 'Beta Sdn Bhd']));
    const alice = rows.find((r) => r.employmentId === e1.employmentId)!;
    expect(alice).toMatchObject({
      employeeName: 'Alice A',
      companyId: base.companyId,
      company: 'Acme Sdn Bhd',
      code: 'ALLOWANCE',
      componentId: allowId,
      validFrom: '2026-01-01',
      validTo: null,
    });
    expect(Number(alice.amount)).toBeCloseTo(100, 2);
  });

  it('fixed: scope fencing — out-of-scope company rows are excluded; empty scope fails CLOSED', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const allowId = await codeId(a, 'ALLOWANCE');
    const e1 = await hire(a, base.companyId, base.deptA, 'InScope');
    const e2 = await hire(a, companyB.companyId, companyB.deptId, 'OutScope');
    await setEmploymentPayComponent(a, { employmentId: e1.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e2.employmentId, componentId: allowId, amount: 200, effectiveFrom: '2026-01-01' });

    const scoped = await listFixedTransactionsAcross(a, { companyIds: [base.companyId] });
    expect(scoped.map((r) => r.employmentId)).toEqual([e1.employmentId]);
    // An out-of-scope employmentId filter cannot pull the row back in — the company fence still applies.
    const tampered = await listFixedTransactionsAcross(a, { companyIds: [base.companyId], employmentId: e2.employmentId });
    expect(tampered).toEqual([]);
    // Empty scope ⇒ no rows (fail closed), NOT "all companies".
    expect(await listFixedTransactionsAcross(a, { companyIds: [] })).toEqual([]);
  });

  it('fixed: view-by-pay-item returns ALL employees assigned to that component only', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const allowId = await codeId(a, 'ALLOWANCE');
    const bonusId = await codeId(a, 'BONUS');
    const e1 = await hire(a, base.companyId, base.deptA, 'Has Allowance');
    const e2 = await hire(a, base.companyId, base.deptA, 'Also Allowance');
    const e3 = await hire(a, base.companyId, base.deptA, 'Only Bonus');
    await setEmploymentPayComponent(a, { employmentId: e1.employmentId, componentId: allowId, amount: 100, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e2.employmentId, componentId: allowId, amount: 150, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e3.employmentId, componentId: bonusId, amount: 999, effectiveFrom: '2026-01-01' });

    const rows = await listFixedTransactionsAcross(a, { companyIds: [base.companyId], componentId: allowId });
    expect(new Set(rows.map((r) => r.employmentId))).toEqual(new Set([e1.employmentId, e2.employmentId]));
    expect(rows.every((r) => r.componentId === allowId)).toBe(true);
  });

  it('fixed: status filter splits active vs ended on the validTo-vs-today rule', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const allowId = await codeId(a, 'ALLOWANCE');
    // Dates computed relative to NOW so the split cannot rot with the calendar.
    const iso = (daysFromToday: number) => {
      const d = new Date();
      d.setDate(d.getDate() + daysFromToday);
      return d.toISOString().slice(0, 10);
    };
    const e = await hire(a, base.companyId, base.deptA, 'Status Case', iso(-400));
    // Ended: validTo in the past. Active: open-ended. (A different-window pair for one component:
    // the first is end-dated, so the second insert does NOT supersede it — both stay visible.)
    const { id: endedId } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 100, effectiveFrom: iso(-400), effectiveTo: iso(-200) });
    const { id: activeId } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 200, effectiveFrom: iso(-100) });

    const active = await listFixedTransactionsAcross(a, { companyIds: [base.companyId], status: 'active' });
    expect(active.map((r) => r.id)).toEqual([activeId]);
    const ended = await listFixedTransactionsAcross(a, { companyIds: [base.companyId], status: 'ended' });
    expect(ended.map((r) => r.id)).toEqual([endedId]);
    // No status ⇒ both visible (ended rows are shown, superseded rows are not — same as the keying list).
    const all = await listFixedTransactionsAcross(a, { companyIds: [base.companyId] });
    expect(new Set(all.map((r) => r.id))).toEqual(new Set([endedId, activeId]));

    // Superseding the open row closes it at the new effectiveFrom (10 days ago), which is < today —
    // so it moves from the ACTIVE split to the ENDED split and the new open row becomes the active one.
    const { id: newId } = await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: allowId, amount: 300, effectiveFrom: iso(-10) });
    const after = await listFixedTransactionsAcross(a, { companyIds: [base.companyId], status: 'active' });
    expect(after.map((r) => r.id)).toEqual([newId]);
    const endedAfter = await listFixedTransactionsAcross(a, { companyIds: [base.companyId], status: 'ended' });
    expect(new Set(endedAfter.map((r) => r.id))).toEqual(new Set([endedId, activeId]));
  });

  // ───────────────────── 2. Individual Transaction View ─────────────────────

  it('individual: aggregates across batches/companies with period+batch shape, and year/month narrows', async () => {
    const a = adminCtx(base);
    const e1 = await hire(a, base.companyId, base.deptA, 'Txn A');
    const e2 = await hire(a, companyB.companyId, companyB.deptId, 'Txn B');
    const bMay = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const bJun = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    const bMayB = await createBatch(a, { companyId: companyB.companyId, payPeriod: '2026-05' });
    await createIndividualTxn(a, { batchId: bMay.batchId, employmentId: e1.employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 111 });
    await createIndividualTxn(a, { batchId: bJun.batchId, employmentId: e1.employmentId, kind: 'deduction', txnDate: '2026-06-05', amount: 222 });
    await createIndividualTxn(a, { batchId: bMayB.batchId, employmentId: e2.employmentId, kind: 'overtime', txnDate: '2026-05-20', amount: 333 });

    // Cross-batch + cross-company in one call (the keying screen is one-draft-batch-only).
    const all = await listIndividualTxnsAcross(a, { companyIds: [base.companyId, companyB.companyId] });
    expect(all).toHaveLength(3);
    expect(new Set(all.map((r) => r.payPeriod))).toEqual(new Set(['2026-05', '2026-06']));
    const otRow = all.find((r) => r.kind === 'overtime')!;
    expect(otRow).toMatchObject({
      employeeName: 'Txn B',
      company: 'Beta Sdn Bhd',
      companyId: companyB.companyId,
      payPeriod: '2026-05',
      batchStatus: 'draft',
      txnDate: '2026-05-20',
    });

    // year+month narrows to the exact period; year-only covers the year.
    const may = await listIndividualTxnsAcross(a, { companyIds: [base.companyId, companyB.companyId], year: 2026, month: 5 });
    expect(new Set(may.map((r) => r.payPeriod))).toEqual(new Set(['2026-05']));
    expect(may).toHaveLength(2);
    const y2026 = await listIndividualTxnsAcross(a, { companyIds: [base.companyId], year: 2026 });
    expect(y2026).toHaveLength(2);
    // employee filter
    const onlyE1 = await listIndividualTxnsAcross(a, { companyIds: [base.companyId, companyB.companyId], employmentId: e1.employmentId });
    expect(onlyE1.every((r) => r.employmentId === e1.employmentId)).toBe(true);
    expect(onlyE1).toHaveLength(2);
  });

  it('individual: payroll-item / department / transaction-status / created-date filters narrow (feedback 7b2d4228)', async () => {
    const a = adminCtx(base);
    const e1 = await hire(a, base.companyId, base.deptA, 'Filt A');
    const e2 = await hire(a, companyB.companyId, companyB.deptId, 'Filt B');
    const bMay = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const bMayB = await createBatch(a, { companyId: companyB.companyId, payPeriod: '2026-05' });
    await createIndividualTxn(a, { batchId: bMay.batchId, employmentId: e1.employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 100 });
    await createIndividualTxn(a, { batchId: bMay.batchId, employmentId: e1.employmentId, kind: 'deduction', txnDate: '2026-05-11', amount: 50 });
    await createIndividualTxn(a, { batchId: bMayB.batchId, employmentId: e2.employmentId, kind: 'earning', txnDate: '2026-05-12', amount: 70 });
    const companyIds = [base.companyId, companyB.companyId];

    // Payroll item (kind) narrows to the two earnings.
    const earnings = await listIndividualTxnsAcross(a, { companyIds, kind: 'earning' });
    expect(earnings.every((r) => r.kind === 'earning')).toBe(true);
    expect(earnings).toHaveLength(2);

    // Department narrows to e1's department only (deptA has e1's two rows; e2 is in company B's dept).
    const deptA = await listIndividualTxnsAcross(a, { companyIds, departmentId: base.deptA });
    expect(deptA.every((r) => r.employmentId === e1.employmentId)).toBe(true);
    expect(deptA).toHaveLength(2);

    // Transaction status: every batch is draft; a 'closed' filter returns nothing.
    expect(await listIndividualTxnsAcross(a, { companyIds, batchStatus: 'draft' })).toHaveLength(3);
    expect(await listIndividualTxnsAcross(a, { companyIds, batchStatus: 'closed' })).toHaveLength(0);

    // Created date: rows are created "now"; a yesterday lower-bound keeps all, a well-future lower-bound
    // drops all. Bounds are ±2 days from now so server-vs-UTC timezone skew (created_at is date-cast in the
    // DB's local zone, which can sit a calendar day ahead of the test's UTC "today") can't flip the result.
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    const all = await listIndividualTxnsAcross(a, { companyIds, createdFrom: yesterday });
    expect(all).toHaveLength(3);
    expect(all.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.createdOn))).toBe(true);
    expect(await listIndividualTxnsAcross(a, { companyIds, createdFrom: future })).toHaveLength(0);

    // Created-by: an unknown actor id matches nothing; the creators option list is a well-formed array.
    expect(await listIndividualTxnsAcross(a, { companyIds, createdBy: '00000000-0000-0000-0000-000000000000' })).toHaveLength(0);
    expect(Array.isArray(await listIndividualTxnCreators(a, { companyIds }))).toBe(true);
  });

  it('individual: scope fencing excludes the out-of-scope company; empty scope fails closed', async () => {
    const a = adminCtx(base);
    const e1 = await hire(a, base.companyId, base.deptA, 'Fence A');
    const e2 = await hire(a, companyB.companyId, companyB.deptId, 'Fence B');
    const bA = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const bB = await createBatch(a, { companyId: companyB.companyId, payPeriod: '2026-05' });
    await createIndividualTxn(a, { batchId: bA.batchId, employmentId: e1.employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 10 });
    await createIndividualTxn(a, { batchId: bB.batchId, employmentId: e2.employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 20 });

    const scoped = await listIndividualTxnsAcross(a, { companyIds: [base.companyId] });
    expect(scoped.map((r) => r.companyId)).toEqual([base.companyId]);
    expect(await listIndividualTxnsAcross(a, { companyIds: [] })).toEqual([]);
  });

  // ───────────────────── 3. Transaction History (processed results) ─────────────────────

  /** Hire + compensation + statutory profile so generatePayslips can run. */
  async function hirePayrollReady(a: SessionContext, companyId: string, deptId: string, name: string, ic: string) {
    const e = await hire(a, companyId, deptId, name);
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    return e;
  }

  it('history: only PROCESSED results appear (draft batches have no payslips by construction), with full pay shape', async () => {
    const a = adminCtx(base);
    const e = await hirePayrollReady(a, base.companyId, base.deptA, 'Hist One', '900101011234');
    const bMay = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const bJun = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });

    // Nothing processed yet ⇒ no history at all, even though two draft batches exist.
    expect(await listProcessedPayslipsAcross(a, { companyIds: [base.companyId] })).toEqual([]);

    await generatePayslips(a, { batchId: bMay.batchId });
    const rows = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId] });
    expect(rows).toHaveLength(1); // May processed, June still draft ⇒ excluded by construction
    const r = rows[0];
    expect(r).toMatchObject({
      employmentId: e.employmentId,
      employeeName: 'Hist One',
      company: 'Acme Sdn Bhd',
      payPeriod: '2026-05',
      runType: 'regular',
    });
    expect(Number(r.gross)).toBeGreaterThan(0);
    expect(Number(r.net)).toBeGreaterThan(0);
    expect(Number(r.totalDeductions)).toBeGreaterThanOrEqual(0);
    const st = r.statutory as Record<string, number>;
    expect(st.epfEmployee).toBeGreaterThan(0); // statutory blob rides along for the EPF/SOCSO/EIS/PCB columns

    // Unused: bJun keeps the one-regular-run-per-month invariant honest in this fixture.
    void bJun;
  });

  it('history: year/month + employee filters narrow; scope fencing excludes the other company; empty scope fails closed', async () => {
    const a = adminCtx(base);
    await hirePayrollReady(a, base.companyId, base.deptA, 'Hist A', '900101011234');
    await hirePayrollReady(a, companyB.companyId, companyB.deptId, 'Hist B', '900202021235');
    const bA = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const bB = await createBatch(a, { companyId: companyB.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: bA.batchId });
    await generatePayslips(a, { batchId: bB.batchId });

    const both = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId, companyB.companyId] });
    expect(both).toHaveLength(2);

    // Scope fence: only company A's processed results.
    const onlyA = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId] });
    expect(onlyA.map((r) => r.company)).toEqual(['Acme Sdn Bhd']);

    // Period filters.
    const may = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId, companyB.companyId], year: 2026, month: 5 });
    expect(may.map((r) => r.payPeriod)).toEqual(['2026-05']);
    expect(await listProcessedPayslipsAcross(a, { companyIds: [base.companyId, companyB.companyId], year: 2025 })).toEqual([]);

    // Cycle filter: both fixtures are regular runs; an unknown cycle value is IGNORED (not a pg enum
    // cast error), and a valid non-matching one yields no rows.
    const regular = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], cycle: 'regular' });
    expect(regular).toHaveLength(1);
    const bonus = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], cycle: 'bonus' });
    expect(bonus).toEqual([]);
    const junk = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], cycle: 'DROP TABLE' });
    expect(junk).toHaveLength(1); // ignored ⇒ same as no cycle filter

    expect(await listProcessedPayslipsAcross(a, { companyIds: [] })).toEqual([]);
  });

  it('history: the row cap bounds the read, keeps the newest, and is absent by default (862ed0ad)', async () => {
    // This read had NO limit and no pagination — every payslip in scope for all time, each carrying its
    // whole statutory blob. That became load-bearing when History was made the tab that OPENS, so the cap
    // is what makes the default-tab change safe. Three properties matter and each is a way it could hurt:
    //   1. the cap actually reaches the QUERY (a render-side slice would still fetch everything);
    //   2. it keeps the NEWEST rows, or "the 200 most recent" would be a lie;
    //   3. an absent cap is still unbounded, because the CSV export and the report registry pass none and
    //      must never be clipped.
    const a = adminCtx(base);
    await hirePayrollReady(a, base.companyId, base.deptA, 'Cap One', '900101011234');
    const bApr = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId: bApr.batchId });
    const bMay = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: bMay.batchId });
    const bJun = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: bJun.batchId });

    const uncapped = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId] });
    expect(uncapped.map((r) => r.payPeriod)).toEqual(['2026-06', '2026-05', '2026-04']);

    const capped = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], limit: 2 });
    expect(capped).toHaveLength(2);
    expect(capped.map((r) => r.payPeriod), 'the cap must keep the NEWEST periods').toEqual(['2026-06', '2026-05']);

    // The page asks for CAP + 1 to detect truncation: with 3 rows and a cap of 2 it gets 3 back and knows.
    expect(await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], limit: 3 })).toHaveLength(3);
    // …and a cap larger than the result set is not padded or truncated.
    expect(await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], limit: 99 })).toHaveLength(3);

    // A nonsensical cap is IGNORED (unbounded), never silently turned into "no rows" — a zero/negative
    // limit reaching the query would blank the landing tab.
    for (const limit of [0, -5, 1.5, Number.NaN]) {
      expect(
        await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], limit }),
        `limit ${limit} must fall back to unbounded`,
      ).toHaveLength(3);
    }
  });

  // ───────────────────── 4. Payroll Register (feedback 622e12eb) ─────────────────────

  it('register: breaks the statutory blob out into employee deductions + employer contributions', async () => {
    const a = adminCtx(base);
    await hirePayrollReady(a, base.companyId, base.deptA, 'Reg One', '900101011234');
    const bMay = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    expect(await listPayrollRegisterAcross(a, { companyIds: [base.companyId] })).toEqual([]);

    await generatePayslips(a, { batchId: bMay.batchId });
    const rows = await listPayrollRegisterAcross(a, { companyIds: [base.companyId] });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({
      employeeName: 'Reg One',
      company: 'Acme Sdn Bhd',
      department: 'Finance',
      payPeriod: '2026-05',
      payrollCycle: 'regular',
    });
    // The register's reason for existing: EPF/SOCSO/EIS/PCB split into the employee's deduction and the
    // employer's contribution, both read off the payslip's immutable statutory snapshot.
    expect(r.epfEmployee).toBeGreaterThan(0);
    expect(r.epfEmployer).toBeGreaterThan(0);
    expect(r.socsoEmployee).toBeGreaterThan(0);
    expect(r.socsoEmployer).toBeGreaterThan(0);
    expect(r.eisEmployee).toBeGreaterThan(0);
    expect(r.eisEmployer).toBeGreaterThan(0);
    // Keys a plain monthly slip never stamps must read as 0, not NaN/undefined.
    expect(r.cp38).toBe(0);
    expect(r.zakat).toBe(0);
    // Totals reconcile: gross − total deductions = nett wage.
    expect(Number(r.gross) - Number(r.totalDeductions)).toBeCloseTo(Number(r.net), 2);
    expect(Number(r.employerCost)).toBeGreaterThan(0);
  });

  it('register: period + cycle filters narrow; scope fencing holds; empty scope fails closed', async () => {
    const a = adminCtx(base);
    await hirePayrollReady(a, base.companyId, base.deptA, 'Reg A', '900101011234');
    await hirePayrollReady(a, companyB.companyId, companyB.deptId, 'Reg B', '900202021235');
    const bA = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const bB = await createBatch(a, { companyId: companyB.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: bA.batchId });
    await generatePayslips(a, { batchId: bB.batchId });

    const scoped = [base.companyId, companyB.companyId];
    expect(await listPayrollRegisterAcross(a, { companyIds: scoped })).toHaveLength(2);
    expect((await listPayrollRegisterAcross(a, { companyIds: [base.companyId] })).map((r) => r.company)).toEqual([
      'Acme Sdn Bhd',
    ]);
    expect((await listPayrollRegisterAcross(a, { companyIds: scoped, year: 2026, month: 5 })).map((r) => r.payPeriod)).toEqual([
      '2026-05',
    ]);
    expect(await listPayrollRegisterAcross(a, { companyIds: scoped, cycle: 'bonus' })).toEqual([]);
    // An unknown cycle is IGNORED rather than cast to the pg enum (which would throw).
    expect(await listPayrollRegisterAcross(a, { companyIds: scoped, cycle: 'DROP TABLE' })).toHaveLength(2);
    expect(await listPayrollRegisterAcross(a, { companyIds: [] })).toEqual([]);
  });
});
