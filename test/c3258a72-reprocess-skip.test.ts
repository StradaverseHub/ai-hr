/**
 * c3258a72 — ON THE REPROCESS SCREEN, AN EMPLOYEE WITH NO MONTHLY BASIC AND NOTHING PAYABLE IS "SKIPPED",
 * NOT "NEW / PENDING".
 *
 * The run already left them out (r369, `NOTHING_PAYABLE_THIS_PERIOD`) and its own page already said so. The
 * Reprocess screen did not: every payslip-less employee went into New / Pending, ticked, so each reprocess
 * retried and re-skipped them. And the screen's "deliberately left out" label came from the salary record
 * alone, so a director whose fee was keyed since was labelled as left out although processing would pay him.
 *
 * What this file pins, against a real processed run:
 *   • ONE PREDICATE (`nothingPayableSkipKind`, core/payroll-view.ts) answers for the run page's notice, this
 *     screen and the kernel — pure cases first, then the narrowing on real data.
 *   • keyed money ⇒ pending (and the engine then pays them); deduction-only ⇒ skipped in its own words;
 *   • a BLOCKED candidate and one OUTSIDE the run's chosen list are never skipped;
 *   • ticking a skipped employee by hand records a completed 'skipped' outcome and writes nothing.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, reprocessSelectedEmployees, setPayrollDeductionInput } from '../core/payroll';
import {
  listPayslipLessEligibleWithSkip,
  narrowToNothingPayable,
  nothingPayableSkipKind,
  type PendingBatchMoney,
  type PendingMoneyLine,
} from '../core/payroll-view';
import { seedPayComponentCatalog, setEmploymentPayComponent } from '../core/pay-components';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const PERIOD = '2026-05';
const REMARK = 'Paid by quarterly director fees — no monthly basic';

// ── 1 · THE PREDICATE, PURE ─────────────────────────────────────────────────────────────────────────

const line = (employmentId: string, amount: number): PendingMoneyLine => ({
  employmentId,
  employeeName: employmentId,
  employeeCode: null,
  door: amount > 0 ? 'individualTxn' : 'tp1',
  itemName: null,
  amount,
  note: null,
});
const card = (lines: PendingMoneyLine[], overtime?: PendingBatchMoney['formulaOvertimeReview']): PendingBatchMoney => ({
  lines,
  byDoor: [],
  employees: 0,
  earnings: 0,
  deductions: 0,
  inertRows: 0,
  formulaOvertimeReview: overtime,
});

describe('c3258a72 · nothingPayableSkipKind — one answer per employment', () => {
  it('no line ⇒ NOTHING_PAYABLE; a positive line ⇒ paid (null); only deductions ⇒ DEDUCTION_ONLY', () => {
    const money = card([line('fee', 30000), line('fee', -200), line('loan', -150), line('other', 500)]);
    expect(nothingPayableSkipKind('none', money)).toBe('NOTHING_PAYABLE_THIS_PERIOD');
    expect(nothingPayableSkipKind('fee', money), 'a keyed fee is paid, deduction or not').toBeNull();
    expect(nothingPayableSkipKind('loan', money)).toBe('DEDUCTION_ONLY_THIS_PERIOD');
  });

  it('an unavailable overtime read can never justify a definite skip', () => {
    expect(nothingPayableSkipKind('none', card([], { status: 'unavailable', code: 'stale' } as never))).toBeNull();
  });

  it('no card (the wizard, before a batch exists) ⇒ the forward-looking NOTHING_PAYABLE sentence', () => {
    expect(nothingPayableSkipKind('none', null)).toBe('NOTHING_PAYABLE_THIS_PERIOD');
  });

  it('narrowToNothingPayable is the same predicate — kept rows are exactly the non-null answers', () => {
    const money = card([line('fee', 30000), line('loan', -150)]);
    const rows = [{ employmentId: 'fee' }, { employmentId: 'loan' }, { employmentId: 'none' }];
    expect(narrowToNothingPayable(rows, money).map((r) => r.employmentId)).toEqual(['loan', 'none']);
    expect(narrowToNothingPayable(rows, null)).toHaveLength(3);
    expect(narrowToNothingPayable(rows, card([], { status: 'unavailable', code: 'stale' } as never))).toEqual([]);
  });
});

// ── 2 · ON A REAL PROCESSED RUN ─────────────────────────────────────────────────────────────────────

describe('c3258a72 · listPayslipLessEligibleWithSkip on a processed run', () => {
  let base: Base;
  let a: SessionContext;
  let icSeq = 0;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    icSeq = 0;
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    // The typed-component doors are where a fixed fee lives; granted before the snapshot is taken.
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    a = await entitledCtx(base);
  });
  afterAll(async () => {
    await closeAll();
  });

  async function hire(name: string, basicSalary: number | null) {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `c3258a72_${randomUUID().slice(0, 8)}@skip.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    if (basicSalary !== null) {
      await setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary,
        monthlyAllowance: 0,
        effectiveFrom: '2024-01-01',
        ...(basicSalary === 0 ? { remarks: REMARK } : {}),
      });
    }
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `900101${String(520000 + icSeq++).padStart(6, '0')}` });
    return e;
  }
  const slipOf = async (batchId: string, employmentId: string) => {
    const [row] = await owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    return row ?? null;
  };
  const housingId = async () => {
    const [row] = await owner.db
      .select({ id: schema.payComponent.id })
      .from(schema.payComponent)
      .where(eq(schema.payComponent.code, 'HOUSING'))
      .limit(1);
    if (!row) throw new Error('HOUSING not seeded');
    return row.id;
  };
  const rowFor = async (batchId: string, employmentId: string) => {
    const rows = await listPayslipLessEligibleWithSkip(a, { batchId });
    const row = rows.find((r) => r.employmentId === employmentId);
    expect(row, 'the employee is payslip-less on the run, so the list must name them').toBeTruthy();
    return row!;
  };

  it('a no-basic employee with nothing payable is SKIPPED with NOTHING_PAYABLE_THIS_PERIOD; others stay pending', async () => {
    const director = await hire('Director Dina', 0);
    await hire('Paid Pete', 4000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    // A genuinely new hire after processing — the New / Pending case this screen exists for.
    const late = await hire('Late Lina', 3500);

    const rows = await listPayslipLessEligibleWithSkip(a, { batchId });
    const byId = new Map(rows.map((r) => [r.employmentId, r]));
    expect(byId.get(director.employmentId)!.skip).toBe('NOTHING_PAYABLE_THIS_PERIOD');
    expect(byId.get(director.employmentId)!.blockers).toEqual([]);
    expect(byId.get(late.employmentId)!.skip, 'a payable new hire is pending, never skipped').toBeNull();
  });

  it('a no-basic employee with a fee keyed SINCE the run is New / Pending — and the engine then pays them', async () => {
    await seedPayComponentCatalog(a);
    const director = await hire('Director Dina', 0);
    await hire('Paid Pete', 4000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    expect(await slipOf(batchId, director.employmentId), 'fixture: the run skipped them').toBeNull();
    expect((await rowFor(batchId, director.employmentId)).skip).toBe('NOTHING_PAYABLE_THIS_PERIOD');

    await setEmploymentPayComponent(a, {
      employmentId: director.employmentId,
      componentId: await housingId(),
      amount: 900,
      effectiveFrom: '2024-01-01',
    });

    const row = await rowFor(batchId, director.employmentId);
    // The record still names no monthly basic (the warning stays), but the run WILL pay them now.
    expect(row.warnings).toContain('nothingPayable');
    expect(row.skip, 'keyed money must move them back to New / Pending').toBeNull();

    const job = await reprocessSelectedEmployees(a, { batchId, employmentIds: [director.employmentId] });
    expect(job).toMatchObject({ status: 'completed', outcomes: [{ employmentId: director.employmentId, status: 'reprocessed' }] });
    expect(Number((await slipOf(batchId, director.employmentId))!.grossPay)).toBeCloseTo(900, 2);
  });

  it('a deduction-only employee is SKIPPED with DEDUCTION_ONLY_THIS_PERIOD, matching what the run stamped', async () => {
    const director = await hire('Director Dina', 0);
    await hire('Paid Pete', 4000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await setPayrollDeductionInput(a, { batchId, employmentId: director.employmentId, tp1Deduction: 200 });
    const gen = await generatePayslips(a, { batchId });
    const stamped = 'skipped' in gen && Array.isArray(gen.skipped) ? gen.skipped : [];
    expect(stamped.map((s) => s.reason)).toEqual(['DEDUCTION_ONLY_THIS_PERIOD']);

    expect((await rowFor(batchId, director.employmentId)).skip).toBe('DEDUCTION_ONLY_THIS_PERIOD');
  });

  it('a BLOCKED candidate (no salary record) is never skipped — a fault stays a fault', async () => {
    await hire('Paid Pete', 4000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    const noSalary = await hire('No Salary Nora', null);

    const row = await rowFor(batchId, noSalary.employmentId);
    expect(row.blockers).toContain('missingCompensation');
    expect(row.skip).toBeNull();
  });

  it('someone OUTSIDE the run’s chosen list is never skipped — the card cannot see their money', async () => {
    const director = await hire('Director Dina', 0);
    const paid = await hire('Paid Pete', 4000);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [paid.employmentId] },
    });
    await generatePayslips(a, { batchId });

    const row = await rowFor(batchId, director.employmentId);
    expect(row.outsideScope).toBe(true);
    expect(row.skip).toBeNull();
  });

  it('ticking a skipped employee by hand records a completed skip and writes no payslip', async () => {
    const director = await hire('Director Dina', 0);
    await hire('Paid Pete', 4000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    expect((await rowFor(batchId, director.employmentId)).skip).toBe('NOTHING_PAYABLE_THIS_PERIOD');

    const job = await reprocessSelectedEmployees(a, { batchId, employmentIds: [director.employmentId] });
    expect(job).toMatchObject({
      status: 'completed',
      skipped: 1,
      outcomes: [{ employmentId: director.employmentId, status: 'skipped', reasonCode: 'NOTHING_PAYABLE' }],
    });
    expect(await slipOf(batchId, director.employmentId)).toBeNull();
    // Still skipped on the next visit — the screen re-derives it, it does not flip to pending.
    expect((await rowFor(batchId, director.employmentId)).skip).toBe('NOTHING_PAYABLE_THIS_PERIOD');
  });
});
