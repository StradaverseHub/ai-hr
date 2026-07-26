/**
 * Payroll Process — draft-resume workflow (feedback: "Payroll Process Workflow for Draft Status").
 *
 * The subject bug: clicking a DRAFT payroll run skipped the Employee-Selection step and jumped straight to
 * the Transaction Key-In screen. The fix restores that step for drafts (resume routing), plus two contained
 * bugs found along the way (the checkbox singleton bug and the loan/claim orphan-cleanup on removal).
 *
 * Tests, mirroring test/payroll-process-wizard.test.ts conventions (harness migrateTestDb/resetDb/seedBase/
 * adminCtx, owner-role assertions, events-table query pattern):
 *   a. Routing rule — a draft row/resume link resolves to /payroll/process?resume=<id>; a processed/closed
 *      one stays /payroll/<id> unchanged (pure resumeHref).
 *   b. updateBatchScope persists a new scope on a draft, re-runs the cross-company intersection guard, and
 *      appends a payroll-batch.scope.updated DomainEvent.
 *   c. updateBatchScope throws BatchNotDraftError against a processed batch.
 *   d. Checkbox-edit regression — deselecting one from a 50-strong whole-company default yields 49, not 1,
 *      including when a filter is also touched after the manual deselect (pure materializeToggle).
 *   e. Loan cleanup — removing an employee from a draft's scope clears their payroll_input row and RELEASES
 *      their reserved loan instalment back to 'scheduled' (reservedBatchId cleared), not orphaned.
 *   f. Regression — generatePayslips output is unchanged whether reached directly or via updateBatchScope
 *      (unmodified scope) then generate.
 *   g. Off-cycle draft resume — cycle/paymentDate/remarks survive the resume round-trip unchanged.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  BatchNotDraftError,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  setPayrollInput,
  updateBatchScope,
} from '../core/payroll';
import { createLoan, prefillLoansForBatch } from '../core/loans';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import { resumeHref, materializeToggle } from '../app/payroll/process/selection-logic';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let icSeq = 0;
const nextIc = () => `9002020${String(10000 + icSeq++).slice(-5)}`;

async function hire(b: Base, name: string, basic = 4000) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

const batchRow = async (batchId: string) => {
  const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  return row;
};

const scopeUpdatedEvents = async (tenantId: string, batchId: string) => {
  const rows = await owner.db
    .select({ payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, tenantId),
        eq(schema.domainEvent.aggregateId, batchId),
        eq(schema.domainEvent.eventType, 'payroll-batch.scope.updated'),
      ),
    );
  return rows;
};

describe('Payroll draft-resume — pure UI logic', () => {
  it('a. resumeHref: a draft routes to the wizard resume; processed/closed stay a direct view', () => {
    expect(resumeHref('b1', 'draft')).toBe('/payroll/process?resume=b1');
    expect(resumeHref('b2', 'processed')).toBe('/payroll/b2');
    expect(resumeHref('b3', 'closed')).toBe('/payroll/b3');
  });

  it('d. materializeToggle: deselecting one from the whole-company default yields "all but one", not a singleton', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `e${i}`);
    // Whole-company default: nothing touched, no filter — `selected` still empty, all 50 rendered checked.
    const afterDeselect = materializeToggle('e7', new Set<string>(), ids, /*filtersTouched*/ false, /*anyFilterActive*/ false);
    expect(afterDeselect.size).toBe(49); // NOT 1 — the bug this feature would otherwise trigger
    expect(afterDeselect.has('e7')).toBe(false);
    expect(afterDeselect.has('e0')).toBe(true);

    // Now a filter is ALSO touched afterwards (filtersTouched=true) and narrows the view to a subset —
    // toggling within it must edit the already-materialised 49, not reset to the filtered view.
    const filteredView = ids.slice(0, 10); // e0..e9 visible
    const afterFilterToggle = materializeToggle('e3', afterDeselect, filteredView, /*filtersTouched*/ true, /*anyFilterActive*/ true);
    expect(afterFilterToggle.size).toBe(48); // 49 − e3
    expect(afterFilterToggle.has('e3')).toBe(false);
    expect(afterFilterToggle.has('e7')).toBe(false); // the earlier deselect survives the filter touch
    expect(afterFilterToggle.has('e0')).toBe(true);
  });

  it('d2. materializeToggle: re-checking a previously-deselected row adds it back', () => {
    const ids = ['a', 'b', 'c'];
    const set = new Set(['a', 'c']); // b previously deselected
    const next = materializeToggle('b', set, ids, true, false);
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('Payroll draft-resume — updateBatchScope (DB)', () => {
  let base: Base;
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

  it('b. persists a new scope on a draft, intersects out a cross-company id, and appends a scope.updated event', async () => {
    const a = adminCtx(base);
    const e1 = await hire(base, 'Resume One');
    const e2 = await hire(base, 'Resume Two');

    // A second company + employee in the SAME tenant — its employment id must be rejected by the intersection.
    const [otherCo] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [otherDept] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: otherCo.id, name: 'OtherDept' })
      .returning({ id: schema.department.id });
    const otherEmp = await hireEmployee(a, {
      person: { fullName: 'Foreigner', primaryEmail: 'foreigner@other.test' },
      companyId: otherCo.id,
      departmentId: otherDept.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });

    await updateBatchScope(a, {
      batchId,
      scope: { employmentIds: [e1.employmentId, e2.employmentId, otherEmp.employmentId] },
    });

    const row = await batchRow(batchId);
    // The cross-company id is intersected OUT; the two in-company ids persist.
    const persisted = (row.scope as { employmentIds?: string[] }).employmentIds ?? [];
    expect(persisted.sort()).toEqual([e1.employmentId, e2.employmentId].sort());
    expect(persisted).not.toContain(otherEmp.employmentId);

    const events = await scopeUpdatedEvents(base.tenantId, batchId);
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { before: unknown; after: { employmentIds?: string[] } };
    expect(payload.before).toBeNull(); // batch was created with no scope (whole company)
    expect((payload.after.employmentIds ?? []).sort()).toEqual([e1.employmentId, e2.employmentId].sort());
  });

  it('b2. an empty selection normalises the scope back to whole-company (null)', async () => {
    const a = adminCtx(base);
    const e1 = await hire(base, 'Solo');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05', scope: { employmentIds: [e1.employmentId] } });
    // Widen back to whole company by submitting an empty selection.
    await updateBatchScope(a, { batchId, scope: { employmentIds: [] } });
    const row = await batchRow(batchId);
    expect(row.scope).toBeNull();
  });

  it('c. throws BatchNotDraftError against a processed batch', async () => {
    const a = adminCtx(base);
    const e1 = await hire(base, 'Processed');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId }); // flips status to 'processed'
    await expect(updateBatchScope(a, { batchId, scope: { employmentIds: [e1.employmentId] } })).rejects.toBeInstanceOf(
      BatchNotDraftError,
    );
  });

  it('e. removing an employee from scope clears their payroll_input and RELEASES their reserved loan instalment', async () => {
    const a = adminCtx(base);
    const keep = await hire(base, 'Keep', 5000);
    const drop = await hire(base, 'Drop', 5000);
    // A loan on the employee who will be dropped.
    const loan = await createLoan(a, {
      employmentId: drop.employmentId,
      loanType: 'personal',
      principal: 2400,
      interestRate: 0,
      interestMethod: 'none',
      durationMonths: 12,
      startDate: '2026-01-01',
    });

    // Draft scoped to BOTH; prefill reserves the loan onto the batch and writes drop's loan_deduction input.
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [keep.employmentId, drop.employmentId] },
    });
    await prefillLoansForBatch(a, { batchId });
    // Also hand-key an OT input for the dropped employee so we can prove the payroll_input row is cleared.
    await setPayrollInput(a, { batchId, employmentId: drop.employmentId, overtimeAmount: 123 });

    // Sanity: a reserved repayment + a payroll_input row exist for `drop` before removal.
    const reservedBefore = await owner.db
      .select()
      .from(schema.loanRepayment)
      .where(and(eq(schema.loanRepayment.reservedBatchId, batchId), eq(schema.loanRepayment.employmentId, drop.employmentId)));
    expect(reservedBefore.length).toBe(1);
    expect(reservedBefore[0].status).toBe('reserved');
    const inputBefore = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, drop.employmentId)));
    expect(inputBefore.length).toBe(1);

    // Remove `drop`, keeping only `keep`.
    const res = await updateBatchScope(a, { batchId, scope: { employmentIds: [keep.employmentId] } });
    expect(res.removedEmploymentIds).toContain(drop.employmentId);

    // The reservation is RELEASED (back to 'scheduled', reservedBatchId cleared) — not stranded.
    const repaymentAfter = await owner.db
      .select()
      .from(schema.loanRepayment)
      .where(eq(schema.loanRepayment.id, reservedBefore[0].id));
    expect(repaymentAfter[0].status).toBe('scheduled');
    expect(repaymentAfter[0].reservedBatchId).toBeNull();

    // The payroll_input row for `drop` is gone; `keep` is unaffected.
    const inputAfter = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, drop.employmentId)));
    expect(inputAfter.length).toBe(0);

    // A release event was appended for the repayment.
    const releaseEvents = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, base.tenantId),
          eq(schema.domainEvent.aggregateId, reservedBefore[0].id),
          eq(schema.domainEvent.eventType, 'loan.instalment.reservation-released'),
        ),
      );
    expect(releaseEvents.length).toBe(1);

    void loan;
  });

  it('f. regression: generatePayslips output is identical whether reached directly or via updateBatchScope (unmodified scope) then generate', async () => {
    const a = adminCtx(base);
    // Path A — plain create + generate (the pre-feature direct path).
    await hire(base, 'Golden A', 4321);
    const { batchId: directId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: directId });
    const [directPs] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, directId));

    // Reset + rebuild an IDENTICAL scenario, but route through updateBatchScope (no real change) first.
    await resetDb();
    base = await seedBase();
    const a2 = adminCtx(base);
    await hire(base, 'Golden A', 4321);
    const { batchId: resumeId } = await createBatch(a2, { companyId: base.companyId, payPeriod: '2026-05' });
    // Resume with an unchanged (empty ⇒ whole-company) scope, then generate.
    await updateBatchScope(a2, { batchId: resumeId, scope: { employmentIds: [] } });
    await generatePayslips(a2, { batchId: resumeId });
    const [resumePs] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, resumeId));

    // The payslip figures match to the cent, and the statutory blob is identical.
    expect(Number(resumePs.grossPay)).toBeCloseTo(Number(directPs.grossPay), 2);
    expect(Number(resumePs.netPay)).toBeCloseTo(Number(directPs.netPay), 2);
    expect(Number(resumePs.totalDeductions)).toBeCloseTo(Number(directPs.totalDeductions), 2);
    expect(resumePs.statutory).toEqual(directPs.statutory);
  });

  it('g. off-cycle draft resume: cycle/paymentDate/remarks survive an updateBatchScope round-trip unchanged', async () => {
    // ADR-0077 slice 3: the off-cycle run is gated on the `multi_cycle_payroll` MODULE, which seedBase
    // does not seed. Grant the row, then resolve the context from the database (`entitledCtx`) — the
    // synthetic snapshot `adminCtx` builds is derived from process.env and would not see this grant.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e1 = await hire(base, 'OffCycle One');
    const e2 = await hire(base, 'OffCycle Two');
    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' }); // regular must exist first
    const { batchId } = await createAdditionalRun(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'off_cycle',
      remarks: 'Advance Salary',
      paymentDate: '2026-05-10',
      scope: { employmentIds: [e1.employmentId, e2.employmentId] },
    });

    // Resume-edit the selection down to one — the batch IDENTITY (runType/batchDate/remarks) must be untouched.
    await updateBatchScope(a, { batchId, scope: { employmentIds: [e1.employmentId] } });
    const row = await batchRow(batchId);
    expect(row.runType).toBe('off_cycle');
    expect(row.remarks).toBe('Advance Salary');
    expect(row.batchDate).toBe('2026-05-10');
    expect((row.scope as { employmentIds?: string[] }).employmentIds).toEqual([e1.employmentId]);
  });
});
