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
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
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
// 65e2d5de — the reset destination is composed from payrollListAfterReset + withQueryParam (it was
// resumeHref until the reporter reversed it — see a3); the Step-2 search is the predicate below.
import { adjustmentReturnTo, payrollListAfterReset, payrollListReturnTo, withQueryParam } from '../lib/return-to';
import { matchesEmployeeSearch } from '../lib/employee-search';
// a3b runs the LIST's own filter arithmetic over the post-reset row, rather than asserting another string.
import { applyFilters } from '../app/payroll/dashboard-logic';
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

  /**
   * a3 — WHERE A RESET LANDS. Decided twice; this case now states the SECOND answer and records the first.
   *
   * 7076f8af's reported defect was one line: a successful reset redirected to `/payroll/<id>`, the long
   * draft screen, whose payslip list is empty at that exact moment because resetProcessedBatch deletes the
   * run's payslips. That round sent it to `resumeHref` instead — the guided run flow.
   *
   * 65e2d5de is the reporter REVERSING that: "Payroll Process → Reset Payroll → Confirm → Submit → Payroll
   * Process". The destination is now composed from `payrollListAfterReset` over the filter query the reset
   * form posts, so the list comes back exactly as it was left. `resumeHref` is untouched and still the one
   * rule for "where does a draft resume?" — case a. above still pins it — it is simply no longer what the
   * reset follows. Pinned as the composed string because that string is what the browser follows.
   *
   * AND THE STATUS FILTER IS DROPPED, which is the half a "keep the filters" destination gets wrong on its
   * own. Reset is offered on PROCESSED runs only, so Status = Processed is the natural filter to be
   * standing in; the reset makes the run DRAFT; `applyFilters` intersects on status. Round-tripping the
   * query verbatim therefore delivers the operator to a list the row they just acted on has fallen out of
   * — a success toast over a table with no sign of the run. Cleared rather than widened because the Status
   * control is a single `<select>` bound to `statuses[0]`: a two-value query would paint "Processed" over a
   * table also listing Draft rows. See `payrollListAfterReset` for the full argument, and case D below for
   * the single-select premise it rests on.
   */
  it('a3. the reset destination is the Payroll Process list with the filters kept (not the wizard, not the run screen)', () => {
    const dest = withQueryParam(
      payrollListAfterReset('/payroll?year=2026&m=5&company=abc&status=processed'),
      'toast',
      'Payroll reset',
    );
    // Year, month and company survive untouched. `status=processed` does NOT: it is the one filter that
    // would hide the run this reset just made Draft, on the very screen the operator was sent to see it.
    expect(dest).toBe('/payroll?year=2026&m=5&company=abc&toast=Payroll%20reset');
    // No status filter ⇒ every status is already shown ⇒ nothing changes. A filter is never invented…
    expect(payrollListAfterReset('/payroll?year=2026&m=5')).toBe('/payroll?year=2026&m=5');
    // …and one that already admits the reset run is left exactly as the operator set it.
    expect(payrollListAfterReset('/payroll?year=2026&status=draft')).toBe('/payroll?year=2026&status=draft');
    // A status that was the whole query leaves a bare list, not a dangling '?'.
    expect(payrollListAfterReset('/payroll?status=processed')).toBe('/payroll');
    // A form that posts nothing (or anything hostile) still lands on the list, never off-site.
    expect(withQueryParam(payrollListAfterReset(''), 'toast', 'Payroll reset')).toBe('/payroll?toast=Payroll%20reset');
    expect(payrollListAfterReset('https://evil.example/payroll?status=processed')).toBe('/payroll');
    // The whitelist underneath is unchanged — this only ever removes a status from a destination that has
    // already passed `payrollListReturnTo`.
    expect(payrollListAfterReset('/payroll?year=2026&toast=done')).toBe(payrollListReturnTo('/payroll?year=2026&toast=done'));
    // Both retired destinations, pinned negatively: the run screen a reset has just emptied (7076f8af's
    // defect) and the Continue Progress flow the reporter asked not to be dropped into (65e2d5de).
    expect(dest.startsWith('/payroll/b1')).toBe(false);
    expect(dest.startsWith('/payroll/process')).toBe(false);
  });

  /**
   * a3b — THE RESET RUN IS ACTUALLY ON THE LIST IT LANDS ON. a3 above pins the string; this pins the fact
   * the string exists for, by running the list's own filter arithmetic over the row as it is AFTER the
   * reset. Every guard on this path was a source-shape or string assertion, so nothing was evaluating the
   * destination's filters against the post-reset row — which is exactly how a destination that hides it
   * passed review.
   */
  it('a3b. applyFilters over the reset destination still contains the run — the point of dropping the status', () => {
    const row = { payPeriod: '2026-05', companyId: 'abc', runType: 'monthly', status: 'draft' as const };
    const parse = (href: string) => {
      const q = new URLSearchParams(href.split('?', 2)[1] ?? '');
      return {
        periods: q.getAll('m').map((m) => `${q.get('year')}-${String(m).padStart(2, '0')}`),
        companyIds: q.getAll('company'),
        cycles: q.getAll('cycle'),
        statuses: q.getAll('status'),
      };
    };
    const from = '/payroll?year=2026&m=5&company=abc&status=processed';
    // The destination the operator is handed: the run they just reset is on it.
    expect(applyFilters([row], parse(payrollListAfterReset(from)))).toEqual([row]);
    // …and the destination that was there before this was fixed: it is not. Kept as the negative half so
    // the case cannot quietly become vacuous.
    expect(applyFilters([row], parse(payrollListReturnTo(from)))).toEqual([]);
  });

  /**
   * 7076f8af a4 — the panel's actions may only be sent back to a screen that RENDERS the panel. The value
   * arrives in a FormData, so it is whitelisted rather than sanitised; anything else falls back to the run
   * screen, which is the behaviour every one of those actions had before this round.
   */
  it('a4. adjustmentReturnTo accepts only the screens that render the panel, and falls back to the run', () => {
    expect(adjustmentReturnTo('/payroll/process?resume=b1', 'b1')).toBe('/payroll/process?resume=b1');
    expect(adjustmentReturnTo('/payroll/transactions/adjustments?batchId=b1', 'b1')).toBe(
      '/payroll/transactions/adjustments?batchId=b1',
    );
    // Absent / empty ⇒ the run screen (unchanged behaviour for any caller that posts nothing).
    expect(adjustmentReturnTo(undefined, 'b1')).toBe('/payroll/b1');
    expect(adjustmentReturnTo('', 'b1')).toBe('/payroll/b1');
    // Off-site, protocol-relative and unlisted internal paths are all rejected the same way.
    expect(adjustmentReturnTo('https://evil.example/payroll/process', 'b1')).toBe('/payroll/b1');
    expect(adjustmentReturnTo('//evil.example', 'b1')).toBe('/payroll/b1');
    expect(adjustmentReturnTo('/admin/users', 'b1')).toBe('/payroll/b1');
    // A posted toast/error is dropped so the caller's own one cannot be doubled or spoofed.
    expect(adjustmentReturnTo('/payroll/process?resume=b1&toast=Everything%20is%20fine', 'b1')).toBe(
      '/payroll/process?resume=b1',
    );
  });

  /**
   * 7076f8af h — STEP 2's SEARCH BOX. It is an eighth FILTER over the same list, sharing the folding rule
   * with the Personnel switcher (lib/employee-search.ts) so "emp0008" finds "EMP-0008" here too. The
   * AND-combination with the seven dropdowns and the "never clobbers an edited selection" property are
   * structural (the component passes the predicate into the same `filtered` memo and routes typing through
   * markFilterTouch/materializeToggle); what is pinned here is the rule itself.
   */
  it('h. matchesEmployeeSearch: partial name, partial code, separator-folded code, and empty ⇒ everyone', () => {
    const aisyah = { name: 'Aisyah Rahman', employeeCode: 'EMP-0001' };
    const daniel = { name: 'Daniel Tan', employeeCode: 'EMP-0002' };
    const noCode = { name: 'Mei Ling', employeeCode: null };

    // Empty / whitespace is "filter not set": it narrows nothing, the opposite of the jump-list rule.
    expect(matchesEmployeeSearch(aisyah, '')).toBe(true);
    expect(matchesEmployeeSearch(aisyah, '   ')).toBe(true);

    // Partial name, case-insensitive, anywhere in the name.
    expect(matchesEmployeeSearch(aisyah, 'rahm')).toBe(true);
    expect(matchesEmployeeSearch(aisyah, 'AISYAH')).toBe(true);
    expect(matchesEmployeeSearch(daniel, 'rahm')).toBe(false);

    // Partial Employee ID, with and without the separator the operator will not type.
    expect(matchesEmployeeSearch(aisyah, 'EMP-000')).toBe(true);
    expect(matchesEmployeeSearch(aisyah, 'emp0001')).toBe(true);
    expect(matchesEmployeeSearch(daniel, 'emp0001')).toBe(false);

    // A row with no Employee ID is still searchable by name and is simply not a code match.
    expect(matchesEmployeeSearch(noCode, 'mei')).toBe(true);
    expect(matchesEmployeeSearch(noCode, 'emp')).toBe(false);
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
    const verifiedStatutory = async (ps: typeof schema.payslip.$inferSelect) => {
      const [batch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,ps.batchId));
      const [selection]=await owner.db.select().from(schema.employmentTaxSelectionMy).where(and(eq(schema.employmentTaxSelectionMy.tenantId,ps.tenantId),eq(schema.employmentTaxSelectionMy.employmentId,ps.employmentId),eq(schema.employmentTaxSelectionMy.companyId,batch.companyId)));
      expect(selection).toBeDefined();expect(batch.tenantId).toBe(ps.tenantId);expect(selection.transitionState).toBe('resolved');
      const statutory=ps.statutory as Record<string,unknown>,meta=statutory.pcbMeta as Record<string,unknown>;
      expect(meta).toMatchObject({taxSelectionId:selection.id,taxSelectionVersion:selection.version,taxSelectionSource:'income_tax_resident',calculationScheme:selection.scheme});
      // Resolve each independent fixture's salary owner before resetDb removes it. The stamp
      // cannot choose its own owner; fixed inputs and the exclusive applicability range are checked.
      expect(ps.tenantId).toBe(base.tenantId);
      expect(batch).toMatchObject({ tenantId: base.tenantId, companyId: base.companyId, payPeriod: '2026-05' });
      const salaryOwners = await owner.db.select().from(schema.compensation).where(and(
        eq(schema.compensation.tenantId, base.tenantId),
        eq(schema.compensation.employmentId, ps.employmentId),
        isNull(schema.compensation.supersededAt),
        lte(schema.compensation.validFrom, '2026-05-31'),
        or(isNull(schema.compensation.validTo), gt(schema.compensation.validTo, '2026-05-31')),
      ));
      expect(salaryOwners).toHaveLength(1);
      expect(salaryOwners[0]).toMatchObject({ basicSalary: '4321.00', payMode: 'monthly',
        validFrom: '2026-01-01', validTo: null, supersededAt: null });
      const basis = statutory.salaryBasis as Record<string, unknown>;
      expect(basis).toEqual({ version: 1, referenceDate: '2026-05-31',
        compensationId: salaryOwners[0].id, effectiveFrom: '2026-01-01',
        basicSalary: '4321.00', payMode: 'monthly' });
      // Independent fixtures have different owner UUIDs. Every other saved field remains exact.
      return {...statutory,salaryBasis:{...basis,compensationId:'validated-compensation-selection'},
        pcbMeta:{...meta,taxSelectionId:'validated-employment-selection'}};
    };
    // Path A — plain create + generate (the pre-feature direct path).
    await hire(base, 'Golden A', 4321);
    const { batchId: directId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: directId });
    const [directPs] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, directId));
    // Validate this owner before resetDb removes the first independent fixture.
    const directStatutory=await verifiedStatutory(directPs);

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
    expect(await verifiedStatutory(resumePs)).toEqual(directStatutory);
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
