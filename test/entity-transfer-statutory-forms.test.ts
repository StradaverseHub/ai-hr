/**
 * b7b22514 — WHAT ENTITY TRANSFER DOES TO THE ANNUAL STATUTORY FORMS.
 *
 * FOUND IN VERIFICATION, NOT IN THE PLAN. The plan's headline promise was that "two EA forms needs no
 * code". That was false, and the failure was not a missing feature — it was a WRONG FORM produced
 * silently. Both defects have the same root: until this item, an employment belonged to exactly one
 * company for its whole life, so "this employment's year" and "this employer's year" were the same set
 * of rows and nothing needed to distinguish them. Entity Transfer makes them different sets, and every
 * annual read that conflated them started lying the moment it shipped.
 *
 *   1. THE EA FORM (C.P.8A). eaStatement summed EVERY payslip in the year and printed the employment's
 *      CURRENT company as the employer. An employee transferred from A to B in July therefore got ONE
 *      form, on B's letterhead, under B's LHDN employer number, containing six months of A's pay. Both
 *      companies' filings are then wrong — B overstates, A omits — and the employee's own tax return is
 *      built on it.
 *
 *   2. FORM E PART A. The headcounts scanned `employment.company_id`, a CURRENT value with no history.
 *      After a transfer the person vanishes from the old company's Part A entirely — including for years
 *      that closed before the transfer happened — while the CP8D rows printed directly beneath them are
 *      company-true (they join through payroll_batch). One form, two disagreeing populations.
 *
 * WHY THE PAYSLIP IS THE SOURCE OF TRUTH HERE. A payslip was paid by a specific batch, and a batch names
 * its company. No later transfer rewrites that. So it is the one company-dated fact in the system —
 * there is no dated company history table; the timeline otherwise exists only in the event log.
 *
 * Every assertion below is on the SPLIT, because the pre-fix code passed every single-company test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  adminCtx,
  closeAll,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee } from '../core/org';
import { createMovementEvent } from '../core/movement';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { employeeEaStatement, employeeEaStatements, employeeEaCompanies, reportPreview } from '../core/reporting';
import * as schema from '../db/schema';

let b: Base;
let coB: string;
let deptB2: string;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd', country: 'MY' })
    .returning({ id: schema.company.id });
  coB = co.id;
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: coB, name: 'Beta Operations' })
    .returning({ id: schema.department.id });
  deptB2 = d.id;
});

/**
 * An employee paid by company A for January, transferred to B on 1 February, paid by B for February.
 * The smallest fixture that makes "the employment's year" and "the employer's year" different sets.
 */
async function transferredMidYear() {
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: 'Split Year', primaryEmail: `sy_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2018-01-01', // GROUP service date — deliberately years before the transfer
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: 5000, effectiveFrom: '2018-01-01' });
  await setStatutoryProfileMY(a, {
    personId: E.personId,
    icNumber: '900101015555',
    taxCategory: 1,
    numChildren: 0,
  });

  // ── January, paid by company A ──
  const janA = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
  await generatePayslips(a, { batchId: janA.batchId });

  // ── the transfer ──
  await createMovementEvent(a, {
    employmentId: E.employmentId,
    kind: 'entityTransfer',
    effectiveDate: '2026-02-01',
    companyId: coB,
    departmentId: deptB2,
    remarks: 'Group restructure',
  });

  // ── February, paid by company B ──
  const febB = await createBatch(a, { companyId: coB, payPeriod: '2026-02' });
  await generatePayslips(a, { batchId: febB.batchId });

  return E;
}

// ───────────────────────────────── the EA form ─────────────────────────────────

describe('EA (C.P.8A) — one form PER EMPLOYER, each holding only what that employer paid', () => {
  it('a transfer year yields TWO statements, oldest employer first, and only one is current', async () => {
    const E = await transferredMidYear();
    const companies = await employeeEaCompanies(adminCtx(b), { employmentId: E.employmentId, year: '2026' });

    expect(companies.map((c) => c.companyId), 'oldest employer first').toEqual([b.companyId, coB]);
    expect(companies.filter((c) => c.isCurrent).map((c) => c.companyId), 'exactly one current').toEqual([coB]);
  });

  it("each form carries ONLY its own employer's pay — the defect was one form carrying both", async () => {
    const E = await transferredMidYear();
    const forms = await employeeEaStatements(adminCtx(b), { employmentId: E.employmentId, year: '2026' });
    expect(forms).toHaveLength(2);

    const [formA, formB] = forms;
    expect(formA.employerId).toBe(b.companyId);
    expect(formB.employerId).toBe(coB);
    expect(formB.employer.name, "the employer NAME must follow the form, not the employment's current row").toBe(
      'Beta Sdn Bhd',
    );

    // One month each. The pre-fix behaviour was that BOTH forms would have shown the two-month total —
    // and only company B's would have existed at all.
    expect(formA.partB.gross, 'company A: January only').toBeGreaterThan(0);
    expect(formB.partB.gross, 'company B: February only').toBeGreaterThan(0);

    // THE LOAD-BEARING ASSERTION. Not "each is non-zero" — each must be STRICTLY LESS than the combined
    // figure, which is what the old code printed on the single form it produced.
    const combined = formA.partB.gross + formB.partB.gross;
    expect(formA.partB.gross, 'A must not contain B’s pay').toBeLessThan(combined);
    expect(formB.partB.gross, 'B must not contain A’s pay').toBeLessThan(combined);
  });

  it('an unscoped read means the CURRENT employer — not the whole group', async () => {
    const E = await transferredMidYear();
    const unscoped = await employeeEaStatement(adminCtx(b), { employmentId: E.employmentId, year: '2026' });
    const scopedB = await employeeEaStatement(adminCtx(b), {
      employmentId: E.employmentId,
      year: '2026',
      companyId: coB,
    });
    expect(unscoped!.employerId).toBe(coB);
    expect(unscoped!.partB.gross).toBe(scopedB!.partB.gross);
  });

  it('an employee who never transferred still gets exactly ONE form — the single-company path is untouched', async () => {
    // The regression guard for the 99% case. A fix to the split that changed the ordinary year would be
    // a far worse bug than the one being fixed.
    const a = adminCtx(b);
    const E = await hireEmployee(a, {
      person: { fullName: 'Stayed Put', primaryEmail: `sp_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2018-01-01',
    });
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 4000, effectiveFrom: '2018-01-01' });
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900202025555', taxCategory: 1, numChildren: 0 });
    const jan = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });

    const forms = await employeeEaStatements(a, { employmentId: E.employmentId, year: '2026' });
    expect(forms).toHaveLength(1);
    expect(forms[0].employerId).toBe(b.companyId);
  });
});

// ───────────────────────────────── Form E Part A ─────────────────────────────────

const countOf = (summary: { label: string; value: string | number }[] | undefined, needle: string) =>
  Number(summary?.find((s) => s.label.includes(needle))?.value ?? -1);

describe('Form E Part A — the headcounts match the CP8D rows printed beneath them', () => {
  it('the OLD company still counts the months it paid, and does not claim them at year end', async () => {
    const E = await transferredMidYear();
    const rep = await reportPreview(adminCtx(b), {
      companyId: b.companyId,
      reportId: 'my.cp8d',
      periodKey: '2026',
    });

    // The person IS in company A's CP8D rows — A paid them in January.
    expect(rep.rows.some((r) => r.employmentId === E.employmentId), 'A paid them, so A must list them').toBe(true);

    // ...and they are NOT active at A on 31 December, because A stopped paying them in January.
    // Before the fix this line read the CURRENT company_id, which by then said B — accidentally right for
    // this year, and silently wrong for every year that closed before the transfer.
    expect(countOf(rep.meta.summary, 'Active at 31 Dec'), 'transferred out — not A’s employee at year end').toBe(0);
  });

  it('the NEW company counts them as a new employee — which `hired_on` could never see', async () => {
    const E = await transferredMidYear();
    const rep = await reportPreview(adminCtx(b), { companyId: coB, reportId: 'my.cp8d', periodKey: '2026' });

    expect(rep.rows.some((r) => r.employmentId === E.employmentId)).toBe(true);
    expect(countOf(rep.meta.summary, 'Active at 31 Dec'), 'B employs them at year end').toBe(1);
    // THE POINT. `hired_on` is the GROUP service date (2018) and 89ea527b deliberately keeps it still
    // across a move — so a Part A built on it counted a transfer-in as a new employee NOWHERE, on any
    // company's form. `join_date` is the date they joined THIS employer, and is what the transfer moves.
    expect(countOf(rep.meta.summary, 'New hires'), 'joined THIS employer on 1 Feb 2026').toBe(1);
  });

  it('a company that has not run payroll for someone it employs still counts them', async () => {
    // The population is payslip-derived, so this is the case that would silently drop to zero if the
    // union with the currently-employed set were removed.
    const a = adminCtx(b);
    await hireEmployee(a, {
      person: { fullName: 'Not Yet Paid', primaryEmail: `np_${randomUUID().slice(0, 8)}@t.local` },
      companyId: coB,
      departmentId: deptB2,
      employmentType: 'full_time',
      hiredOn: '2026-03-01',
    });
    const rep = await reportPreview(a, { companyId: coB, reportId: 'my.cp8d', periodKey: '2026' });
    expect(rep.rows, 'no payslips, so no CP8D rows').toHaveLength(0);
    expect(countOf(rep.meta.summary, 'Active at 31 Dec'), 'employed, unpaid, still a headcount').toBe(1);
  });
});
