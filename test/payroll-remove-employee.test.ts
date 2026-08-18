/**
 * 9066bd6c — REMOVE EMPLOYEE PAYROLL: take ONE person's calculated result off a PROCESSED run without
 * destroying everybody else's.
 *
 * WHY THE FEATURE EXISTS. Until now the only tool on a processed run was Reset, which clears every
 * employee on it. Production shows the cost: the ISEDECOR August run was reset twice at 23 employees
 * each, July once at 22, January once at 19 — 87 employee results destroyed inside eighteen minutes to
 * correct a handful of people, and the August run is still sitting in Draft.
 *
 * WHAT THESE TESTS PIN, in the order the service does it:
 *   a. The arithmetic — totals and headcount move by EXACTLY the removed payslips, every other payslip
 *      row is byte-identical afterwards, and the run stays PROCESSED.
 *   b. The unwind is per-employee — the removed employee's loan instalment is reversed and their
 *      auto-settled loan reopened, while a SECOND employee on the same run keeps their applied
 *      instalment, their paid claim and their consumed one-off transaction markers untouched.
 *   c. The snapshot is sufficient — `payroll_employee_result_history.before` carries the WHOLE payslip
 *      row (every non-derived column), because after a removal there is no other copy anywhere. A
 *      reprocess records six keys; that is not enough to rebuild a payslip, which is the r194 lesson.
 *      A statutory adjustment goes with it and is in the same snapshot.
 *   d. The refusals — the WHOLE run (that is a Reset), a CLOSED pay period, a blank reason (before any
 *      write), an employment with no payslip on the run, and a caller without payroll.remove.employee.
 *   e. The round trip — remove ⇒ the employee reappears on the Reprocess screen's New / Pending list
 *      (`listPayslipLessEligible`) ⇒ `reprocessSelectedEmployees` puts them back with the same gross
 *      and net. This is the claim the plan makes about "the way back is not something new".
 *   f. The selection list returns ONE ROW PER PAYSLIP even when an employment carries several
 *      non-superseded assignment rows — the verified production hazard on batch 368c67fc, where a naive
 *      department join turns 19 payslips into 23 tickable rows.
 *   h. The unwind reaches the ANOMALY VERDICTS too. `openBlockingVerdicts` is keyed on batchId and joins
 *      no payslip, so an unresolved BLOCK verdict outlives the payslip it describes and refuses the run's
 *      Close — naming somebody who is not on the run, on the operator's very next action. Superseded per
 *      removed employment, and the survivor's verdict is left alone.
 *
 * WHAT THESE TESTS CANNOT SEE, stated so it is not mistaken for covered: they call the SERVICE with a list
 * of employment ids, so nothing here can prove WHICH ids the screen submits. That contract — a ticked row
 * the search box has since hidden is unmounted, and its checkbox with it, while the count, review list,
 * button label and confirmation body still name the person — is pinned in
 * test/payroll-remove-form.dom.test.tsx against the real FormData.
 *
 * ADR-0077 CONTEXTS. `removeEmployeePayroll` reads TWO gates — the `payroll.reset_enabled` SETTING (the
 * same risk switch Reset rides) and the `multi_cycle_payroll` MODULE (the Reprocess screen is the way
 * back; removal must never be offered where re-adding is impossible). `adminCtx` carries a synthetic
 * snapshot that cannot see a setSetting/setModule written afterwards, so every call under test goes
 * through `entitledCtx`, resolved AFTER those writes. `adminCtx` is kept for gate-independent fixture
 * work exactly as the reset tests keep it.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  BatchHasBlockingAnomaliesError,
  BatchNotResettableError,
  PayrollPermissionDeniedError,
  RemoveNoEmployeesError,
  RemovePeriodClosedError,
  RemoveReasonRequiredError,
  RemoveWholeRunError,
  closeBatch,
  createBatch,
  generatePayslips,
  listPayslipLessEligible,
  listRemovableEmployees,
  removeEligibility,
  removeEmployeePayroll,
  reprocessSelectedEmployees,
  saveStatutoryAdjustment,
} from '../core/payroll';
import { createIndividualTxn } from '../core/payroll-individual-txn';
import { createLoan, prefillLoansForBatch } from '../core/loans';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

let icSeq = 0;
const nextIc = () => `9105050${String(10000 + icSeq++).slice(-5)}`;

let base: Base;

async function hire(name: string, basic = 5000) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

const batchRow = async (batchId: string) => {
  const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  return b;
};

const slipsOf = async (batchId: string) =>
  (await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).sort((x, y) =>
    x.employmentId.localeCompare(y.employmentId),
  );

const totalsOf = async (batchId: string) => ((await batchRow(batchId)).totals ?? {}) as Record<string, number>;

/** `numeric` columns arrive as strings; sum the removed payslips' contribution in the same shape. */
const num = (v: unknown) => Number(v ?? 0);

describe('Payroll — removeEmployeePayroll (DB)', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // Both gates ON for this tenant, written BEFORE any entitledCtx is resolved (the snapshot is
    // point-in-time). The suite's env seeds neither, and both catalog defaults are false.
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  });
  afterAll(async () => {
    await closeAll();
  });

  it('a. totals + headcount move by exactly the removed payslips; every other payslip row is untouched; run stays processed', async () => {
    const a = adminCtx(base);
    const gone = await hire('Remove Gone', 5000);
    const stay1 = await hire('Remove Stay One', 4200);
    const stay2 = await hire('Remove Stay Two', 6100);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const before = await slipsOf(batchId);
    expect(before).toHaveLength(3);
    const beforeTotals = await totalsOf(batchId);
    const removedSlip = before.find((s) => s.employmentId === gone.employmentId)!;
    const st = (removedSlip.statutory ?? {}) as Record<string, number>;

    const g = await entitledCtx(base);
    const res = await removeEmployeePayroll(g, {
      batchId,
      employmentIds: [gone.employmentId],
      reason: 'duplicate hire keyed twice',
    });
    expect(res.payslipsRemoved).toBe(1);
    expect(res.headcountAfter).toBe(2);

    // The run is STILL PROCESSED — that is the whole feature. Reset drops it to draft; this does not.
    const after = await batchRow(batchId);
    expect(after.status).toBe('processed');
    expect(after.employeeCount).toBe(2);

    // Totals moved by EXACTLY that payslip's contribution, key by key.
    const afterTotals = (after.totals ?? {}) as Record<string, number>;
    const expected: Record<string, number> = {
      gross: num(beforeTotals.gross) - num(removedSlip.grossPay),
      net: num(beforeTotals.net) - num(removedSlip.netPay),
      deductions: num(beforeTotals.deductions) - num(removedSlip.totalDeductions),
      employerCost: num(beforeTotals.employerCost) - num(removedSlip.employerCost),
      epfEmployee: num(beforeTotals.epfEmployee) - num(st.epfEmployee),
      epfEmployer: num(beforeTotals.epfEmployer) - num(st.epfEmployer),
      socsoEmployee: num(beforeTotals.socsoEmployee) - num(st.socsoEmployee),
      socsoEmployer: num(beforeTotals.socsoEmployer) - num(st.socsoEmployer),
      eisEmployee: num(beforeTotals.eisEmployee) - num(st.eisEmployee),
      eisEmployer: num(beforeTotals.eisEmployer) - num(st.eisEmployer),
      pcb: num(beforeTotals.pcb) - num(st.pcb),
      // The totals key is `hrdfEmployer`; the payslip's own blob spells the same figure `hrdf`.
      hrdfEmployer: num(beforeTotals.hrdfEmployer) - num(st.hrdf),
    };
    for (const [k, v] of Object.entries(expected)) {
      expect(afterTotals[k], `totals.${k}`).toBeCloseTo(v, 2);
    }

    // NOBODY ELSE'S PAYSLIP MOVED — compared row by row, not by summary. A delta that silently rewrote
    // an untouched slip would still balance the totals.
    const remaining = await slipsOf(batchId);
    expect(remaining.map((s) => s.employmentId).sort()).toEqual([stay1.employmentId, stay2.employmentId].sort());
    for (const r of remaining) {
      const b = before.find((s) => s.id === r.id)!;
      expect(r).toEqual(b);
    }

    // The audited trail: one per-employee history row, one run-level status row, one domain event.
    const empHist = await owner.db
      .select()
      .from(schema.payrollEmployeeResultHistory)
      .where(eq(schema.payrollEmployeeResultHistory.batchId, batchId));
    expect(empHist).toHaveLength(1);
    expect(empHist[0].action).toBe('remove');
    expect(empHist[0].employmentId).toBe(gone.employmentId);
    expect(empHist[0].reason).toBe('duplicate hire keyed twice');
    expect(empHist[0].versionBefore).toBe(removedSlip.version);
    expect(empHist[0].versionAfter).toBeNull();

    const statusHist = await owner.db
      .select()
      .from(schema.payrollStatusHistory)
      .where(eq(schema.payrollStatusHistory.batchId, batchId));
    expect(statusHist).toHaveLength(1);
    expect(statusHist[0].action).toBe('remove-employee');
    // The run does not change status, and the row says so rather than inventing a transition.
    expect(statusHist[0].fromStatus).toBe('processed');
    expect(statusHist[0].toStatus).toBe('processed');

    expect(await eventTypesFor(base.tenantId, batchId)).toContain('payroll-batch.employee-payroll-removed');
    const payload = await latestEventPayload(base.tenantId, batchId, 'payroll-batch.employee-payroll-removed');
    expect(payload).toMatchObject({
      employmentIds: [gone.employmentId],
      payslipsRemoved: 1,
      headcountAfter: 2,
      reason: 'duplicate hire keyed twice',
    });
  });

  it('b. the unwind is per-employee: loan reversed + reopened for the removed one only; a second employee keeps their instalment, paid claim and consumed one-off', async () => {
    // The one-off ledger only reaches a payslip (and is therefore only marked consumed) with the pay
    // flag on — the marker's whole claim is "this run paid it", and a record-only ledger pays nothing.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    const a = adminCtx(base);
    const gone = await hire('Unwind Gone', 5000);
    const stay = await hire('Unwind Stay', 5000);

    // A loan for each. `gone`'s is a ONE-instalment loan, so processing auto-settles it and the removal
    // must REOPEN it; `stay`'s must be left exactly as processing left it.
    await createLoan(a, {
      employmentId: gone.employmentId,
      loanType: 'personal',
      principal: 300,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 1,
      startDate: '2026-05-01',
    });
    await createLoan(a, {
      employmentId: stay.employmentId,
      loanType: 'personal',
      principal: 2400,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: '2026-01-01',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillLoansForBatch(a, { batchId });

    // A one-off overtime row for each, which the fold pays and the generation stamps consumed.
    await createIndividualTxn(a, { batchId, employmentId: gone.employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 120 });
    await createIndividualTxn(a, { batchId, employmentId: stay.employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 140 });

    // An approved taxable claim STAMPED onto the run for each — generation marks both paid.
    const [ct] = await owner.db
      .insert(schema.claimType)
      .values({ tenantId: base.tenantId, code: `MED_${randomUUID().slice(0, 8)}`, name: 'Medical' })
      .returning({ id: schema.claimType.id });
    const claimIds: Record<string, string> = {};
    for (const [label, e] of [['gone', gone], ['stay', stay]] as const) {
      const [c] = await owner.db
        .insert(schema.claimRequest)
        .values({
          tenantId: base.tenantId,
          employmentId: e.employmentId,
          claimTypeId: ct.id,
          amount: '55.00',
          incurredOn: '2026-05-03',
          taxable: true,
          status: 'approved',
          payrollBatchId: batchId,
        })
        .returning({ id: schema.claimRequest.id });
      claimIds[label] = c.id;
    }

    const gp = await entitledCtx(base);
    await generatePayslips(gp, { batchId });

    const loanRow = async (employmentId: string) => {
      const [l] = await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.employmentId, employmentId));
      return l;
    };
    expect((await loanRow(gone.employmentId)).status).toBe('settled');
    const stayLoanAfterGen = await loanRow(stay.employmentId);
    expect(stayLoanAfterGen.instalmentsPaid).toBe(1);

    const txnRow = async (employmentId: string) => {
      const [r] = await owner.db
        .select()
        .from(schema.payrollIndividualTxn)
        .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
      return r;
    };
    expect((await txnRow(gone.employmentId)).consumedBatchId).toBe(batchId);
    expect((await txnRow(stay.employmentId)).consumedBatchId).toBe(batchId);

    const claimRow = async (id: string) => {
      const [c] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
      return c;
    };
    expect((await claimRow(claimIds.gone)).status).toBe('paid');
    expect((await claimRow(claimIds.stay)).status).toBe('paid');

    // ── Remove ONE of them ──
    const g = await entitledCtx(base);
    const res = await removeEmployeePayroll(g, {
      batchId,
      employmentIds: [gone.employmentId],
      reason: 'wrong salary keyed',
    });
    expect(res).toMatchObject({ payslipsRemoved: 1, loanInstalmentsReversed: 1, loansReopened: 1, claimsReverted: 1 });

    // Removed employee: loan back to active with the instalment restored, claim un-paid but still
    // queued on the run, one-off released so the corrected re-run pays it.
    const goneLoan = await loanRow(gone.employmentId);
    expect(goneLoan.status).toBe('active');
    expect(goneLoan.instalmentsPaid).toBe(0);
    expect(Number(goneLoan.outstandingBalance)).toBeCloseTo(300, 2);
    const goneClaim = await claimRow(claimIds.gone);
    expect(goneClaim.status).toBe('approved');
    expect(goneClaim.paidAt).toBeNull();
    expect(goneClaim.payoutRef).toBeNull();
    expect(goneClaim.payrollBatchId).toBe(batchId);
    expect((await txnRow(gone.employmentId)).consumedBatchId).toBeNull();

    // The OTHER employee on the SAME run: nothing moved. This is the assertion the whole-run Reset
    // cannot make, and the reason the unwind takes an employment filter at all.
    const stayLoan = await loanRow(stay.employmentId);
    expect(stayLoan).toEqual(stayLoanAfterGen);
    expect((await claimRow(claimIds.stay)).status).toBe('paid');
    expect((await txnRow(stay.employmentId)).consumedBatchId).toBe(batchId);
  });

  it('c. the before-snapshot is the WHOLE payslip row (every non-derived column) plus the statutory adjustment that went with it', async () => {
    const a = adminCtx(base);
    const gone = await hire('Snapshot Gone', 5000);
    await hire('Snapshot Stay', 5000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    // An adjustment describing the payslip that is about to disappear.
    await saveStatutoryAdjustment(a, {
      batchId,
      employmentId: gone.employmentId,
      values: { pcb: 12.5 },
      reason: 'agency correction',
    });

    const slip = (await slipsOf(batchId)).find((s) => s.employmentId === gone.employmentId)!;
    const g = await entitledCtx(base);
    const res = await removeEmployeePayroll(g, { batchId, employmentIds: [gone.employmentId], reason: 'keyed twice' });
    expect(res.statutoryAdjustmentsRemoved).toBe(1);

    // The adjustment row is gone from the live table…
    expect(
      await owner.db
        .select()
        .from(schema.payrollStatutoryAdjustment)
        .where(eq(schema.payrollStatutoryAdjustment.batchId, batchId)),
    ).toHaveLength(0);

    const [hist] = await owner.db
      .select()
      .from(schema.payrollEmployeeResultHistory)
      .where(eq(schema.payrollEmployeeResultHistory.batchId, batchId));
    const before = hist.before as { payslip: Record<string, unknown>; statutoryAdjustment: Record<string, unknown> | null };

    // …and is IN the snapshot, which is now the only copy of either.
    expect(before.statutoryAdjustment).not.toBeNull();
    expect(Number(before.statutoryAdjustment!.pcb)).toBeCloseTo(12.5, 2);

    // EVERY column of the payslip row is present. A reprocess records six keys (gross/net/deductions/
    // employerCost/version/statutory) and that is not enough to rebuild a payslip — after a removal
    // there is no other copy to fall back on, which is the r194 restore lesson.
    for (const col of Object.keys(slip)) {
      expect(before.payslip, `payslip.${col} missing from the removal snapshot`).toHaveProperty(col);
    }
    expect(String(before.payslip.grossPay)).toBe(String(slip.grossPay));
    expect(String(before.payslip.netPay)).toBe(String(slip.netPay));
    expect(String(before.payslip.employmentId)).toBe(slip.employmentId);
  });

  it('d1. removing EVERY employee on the run is refused — that is a Reset — and nothing is mutated', async () => {
    const a = adminCtx(base);
    const e1 = await hire('All One', 5000);
    const e2 = await hire('All Two', 5000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const before = await slipsOf(batchId);

    const g = await entitledCtx(base);
    await expect(
      removeEmployeePayroll(g, { batchId, employmentIds: [e1.employmentId, e2.employmentId], reason: 'all of them' }),
    ).rejects.toBeInstanceOf(RemoveWholeRunError);

    expect(await slipsOf(batchId)).toEqual(before);
    expect((await batchRow(batchId)).status).toBe('processed');
  });

  it('d2. a CLOSED pay period is refused; d3. a blank reason is refused BEFORE any write; d4. an employment with no payslip on the run is refused', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Closed One', 5000);
    const e2 = await hire('Closed Two', 5000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const before = await slipsOf(batchId);
    const g = await entitledCtx(base);

    // d3 — blank / whitespace-only reason, thrown before anything is touched. Asserted by the payslip
    // still existing, not merely by the throw: the point of the ordering is that nothing is mutated.
    await expect(removeEmployeePayroll(g, { batchId, employmentIds: [e1.employmentId], reason: '   ' })).rejects.toBeInstanceOf(
      RemoveReasonRequiredError,
    );
    await expect(removeEmployeePayroll(g, { batchId, employmentIds: [e1.employmentId] })).rejects.toBeInstanceOf(
      RemoveReasonRequiredError,
    );
    expect(await slipsOf(batchId)).toEqual(before);

    // d4 — an id with no payslip on THIS run (a stale tick or a cross-company id).
    const stranger = await hire('Not On Run', 5000);
    await expect(
      removeEmployeePayroll(g, { batchId, employmentIds: [stranger.employmentId], reason: 'x' }),
    ).rejects.toBeInstanceOf(RemoveNoEmployeesError);
    expect(await slipsOf(batchId)).toEqual(before);

    // d2 — close the run, which closes its (single-run) pay period, then try again.
    await closeBatch(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
    // A closed BATCH is not processed, so the processed guard answers first — the closed PERIOD refusal
    // is what a second, still-processed run in the same closed month would hit.
    await expect(
      removeEmployeePayroll(g, { batchId, employmentIds: [e2.employmentId], reason: 'too late' }),
    ).rejects.toBeInstanceOf(BatchNotResettableError);
    expect(await slipsOf(batchId)).toEqual(before);
  });

  it('d2b. a PROCESSED run inside a CLOSED pay period is refused with RemovePeriodClosedError', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Period One', 5000);
    await hire('Period Two', 5000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    // Close the PERIOD directly, leaving the run processed — the exact state the guard is for.
    const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    await owner.db.update(schema.payPeriod).set({ status: 'closed' }).where(eq(schema.payPeriod.id, b.payPeriodId));

    const g = await entitledCtx(base);
    await expect(
      removeEmployeePayroll(g, { batchId, employmentIds: [e1.employmentId], reason: 'too late' }),
    ).rejects.toBeInstanceOf(RemovePeriodClosedError);
    expect((await removeEligibility(g, { batchId, enabled: true }))!.periodClosed).toBe(true);
  });

  it('d5. a caller without payroll.remove.employee is refused — the key is its OWN, not payroll.rollback', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Rbac One', 5000);
    await hire('Rbac Two', 5000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const partner: SessionContext = { ...(await entitledCtx(base)), roles: ['payroll_partner'] };
    await expect(
      removeEmployeePayroll(partner, { batchId, employmentIds: [e1.employmentId], reason: 'x' }),
    ).rejects.toThrow(/'payroll\.remove\.employee' payroll permission/);
    await expect(
      removeEmployeePayroll(partner, { batchId, employmentIds: [e1.employmentId], reason: 'x' }),
    ).rejects.toBeInstanceOf(PayrollPermissionDeniedError);
    expect(await slipsOf(batchId)).toHaveLength(2);
    expect((await removeEligibility(partner, { batchId, enabled: true }))!.permitted).toBe(false);
  });

  it('d6. the payroll.reset_enabled setting OFF refuses before touching anything', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Gate One', 5000);
    await hire('Gate Two', 5000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    await setSetting(base.tenantId, 'payroll.reset_enabled', false);
    const g = await entitledCtx(base);
    await expect(
      removeEmployeePayroll(g, { batchId, employmentIds: [e1.employmentId], reason: 'x' }),
    ).rejects.toThrow(/not enabled/);
    expect(await slipsOf(batchId)).toHaveLength(2);

    // …AND THE SCREEN KNOWS IT BEFORE THE BUTTON IS PRESSED. Both entry points hide their link while the
    // setting is off, so the only way onto the Remove route is a direct visit — which rendered the whole
    // selection form until `enabled` joined this reader. Without it the operator learns the answer by
    // pressing a destructive button and gets the service's raw English back, untranslated, in six locales.
    // `enabled` is now the PAGE's answer handed in, not the reader's own lookup — core/ may not use the
    // degrade-to-default form (test/module-catalog-drift.test.ts), so the resolution moved to app/ where
    // that idiom belongs. Asserting the passthrough here would be vacuous, so the claim this case protects
    // — the screen knows before the button is pressed — is pinned where the mechanism now lives: the page
    // resolves the setting and feeds it to the reader. A contract across two files, so source-shape.
    const removePage = readFileSync(
      resolve(__dirname, '..', 'app/payroll/[batchId]/remove/page.tsx'),
      'utf8',
    );
    expect(removePage, 'the page must resolve the setting itself').toContain(
      "settingEnabledOrDefault(s, 'payroll.reset_enabled')",
    );
    expect(removePage, 'and feed it to the reader, or the refusal reason goes dark').toMatch(
      /removeEligibility\(s, \{ batchId, enabled: \w+ \}\)/,
    );
  });

  it('e. round trip: remove → the employee is on the Reprocess New/Pending list → reprocess adds them back at the same gross and net', async () => {
    const a = adminCtx(base);
    const gone = await hire('Round Trip', 5000);
    await hire('Round Trip Other', 4000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const beforeSlip = (await slipsOf(batchId)).find((s) => s.employmentId === gone.employmentId)!;
    const beforeTotals = await totalsOf(batchId);

    const g = await entitledCtx(base);
    await removeEmployeePayroll(g, { batchId, employmentIds: [gone.employmentId], reason: 'correcting basic' });

    // THE WAY BACK, and it is not new: the same list the Reprocess screen already renders.
    const pending = await listPayslipLessEligible(g, { batchId });
    expect(pending.map((r) => r.employmentId)).toContain(gone.employmentId);
    expect(pending.find((r) => r.employmentId === gone.employmentId)!.blockers).toEqual([]);

    await reprocessSelectedEmployees(g, { batchId, employmentIds: [gone.employmentId], reason: 'put back' });

    const restored = (await slipsOf(batchId)).find((s) => s.employmentId === gone.employmentId)!;
    expect(Number(restored.grossPay)).toBeCloseTo(Number(beforeSlip.grossPay), 2);
    expect(Number(restored.netPay)).toBeCloseTo(Number(beforeSlip.netPay), 2);
    const afterTotals = await totalsOf(batchId);
    for (const k of Object.keys(beforeTotals)) {
      expect(afterTotals[k], `totals.${k} after the round trip`).toBeCloseTo(Number(beforeTotals[k]), 2);
    }
    expect((await batchRow(batchId)).employeeCount).toBe(2);
  });

  it('f. the selection list returns ONE ROW PER PAYSLIP even when an employment carries several non-superseded assignment rows', async () => {
    const a = adminCtx(base);
    const dupe = await hire('Dupe Assignments', 5000);
    await hire('Single Assignment', 5000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    // The verified production shape: THREE non-superseded assignment rows on one employment, all naming
    // the same department. `superseded_at` records a CORRECTION, not the end of an effective period, so
    // an ordinary transfer/promotion history leaves every earlier version with `superseded_at` null —
    // which is exactly why the obvious `left join assignment … where superseded_at is null` is wrong.
    // (The ranges below are closed and non-overlapping because `assignment_no_overlap` is an exclusion
    // constraint on the employment's daterange; production's three rows are three such periods.)
    const [live] = await owner.db
      .select()
      .from(schema.assignment)
      .where(and(eq(schema.assignment.employmentId, dupe.employmentId), eq(schema.assignment.tenantId, base.tenantId)));
    for (const [validFrom, validTo] of [
      ['2024-01-01', '2025-01-01'],
      ['2025-01-01', '2026-01-01'],
    ] as const) {
      const { id: _id, createdAt: _c, ...rest } = live;
      await owner.db.insert(schema.assignment).values({ ...rest, validFrom, validTo });
    }
    const liveCount = await owner.db
      .select()
      .from(schema.assignment)
      .where(and(eq(schema.assignment.employmentId, dupe.employmentId), eq(schema.assignment.tenantId, base.tenantId)));
    expect(liveCount.filter((r) => r.supersededAt == null).length).toBe(3);

    const g = await entitledCtx(base);
    const rows = await listRemovableEmployees(g, { batchId });
    expect(rows).toHaveLength((await slipsOf(batchId)).length);
    expect(rows.filter((r) => r.employmentId === dupe.employmentId)).toHaveLength(1);
    expect(rows.every((r) => r.department != null)).toBe(true);
  });

  it('g. a later PROCESSED month for the same employee is reported as a warning, never as a gate', async () => {
    const a = adminCtx(base);
    const gone = await hire('Later Months', 5000);
    await hire('Later Months Other', 5000);
    const may = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: may.batchId });
    const jun = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: jun.batchId });

    const g = await entitledCtx(base);
    const listed = await listRemovableEmployees(g, { batchId: may.batchId });
    expect(listed.find((r) => r.employmentId === gone.employmentId)!.laterPeriods).toEqual(['2026-06']);

    // A warning, not a gate: the removal goes through and RECORDS what was known at the time.
    const res = await removeEmployeePayroll(g, {
      batchId: may.batchId,
      employmentIds: [gone.employmentId],
      reason: 'May was wrong',
    });
    expect(res.laterProcessedPeriods).toEqual(['2026-06']);
  });

  it('h. the removed employee’s anomaly verdicts are superseded, so Close is no longer blocked by somebody who is not on the run', async () => {
    // THE FAILURE MODE THIS PINS. `openBlockingVerdicts` is keyed on batchId alone and joins no payslip
    // (core/payroll-anomaly.ts), so an unresolved BLOCK verdict survives the deletion of the payslip it
    // describes and keeps refusing `closeBatch` — naming an employee the run no longer contains, on the
    // operator’s very next action after a removal. Reset never hit it because it drops the run to draft
    // and a regeneration supersedes every verdict on the batch; removal deliberately leaves the run
    // PROCESSED and regenerates nothing.
    const a = adminCtx(base);
    const gone = await hire('Verdict Gone', 5000);
    const stays = await hire('Verdict Stays', 4000);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    // Written directly rather than through `evaluateBatchAnomalies`: what is under test is what removal
    // does to a STANDING verdict, and a detector that happens to fire is not a dependable way to get one.
    const [blocking] = await owner.db
      .insert(schema.payrollAnomalyVerdict)
      .values({ tenantId: base.tenantId, batchId, employmentId: gone.employmentId, disposition: 'block' })
      .returning({ id: schema.payrollAnomalyVerdict.id });
    const [review] = await owner.db
      .insert(schema.payrollAnomalyVerdict)
      .values({ tenantId: base.tenantId, batchId, employmentId: stays.employmentId, disposition: 'review' })
      .returning({ id: schema.payrollAnomalyVerdict.id });

    // The guard is live: Close refuses while the BLOCK stands.
    await expect(closeBatch(a, { batchId })).rejects.toBeInstanceOf(BatchHasBlockingAnomaliesError);

    const g = await entitledCtx(base);
    const res = await removeEmployeePayroll(g, {
      batchId,
      employmentIds: [gone.employmentId],
      reason: 'wrong basic salary',
    });
    expect(res.anomalyVerdictsSuperseded).toBe(1);

    const verdictRow = async (id: string) =>
      (await owner.db
        .select()
        .from(schema.payrollAnomalyVerdict)
        .where(eq(schema.payrollAnomalyVerdict.id, id)))[0];
    // SUPERSEDED, NOT DELETED — the row is the record of what the system believed when a human looked at
    // it, and after a removal there is nothing left to recompute it from.
    expect((await verdictRow(blocking.id)).supersededAt).not.toBeNull();
    // …and narrowed to the removed employment, exactly like the loan/claim unwind in case b.
    expect((await verdictRow(review.id)).supersededAt).toBeNull();

    // The point of all of it: the very next thing the operator does now works.
    await closeBatch(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
  });
});
