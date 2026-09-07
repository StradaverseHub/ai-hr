/**
 * e440991b — "Enhance Payroll Process Workflow and User Experience", the four of seven points that were
 * real. Two of the reporter's seven (per-company already-processed indicators; Reprocess on a processed
 * run) were already built and are NOT re-tested here; their guards live where they were built.
 *
 * What is pinned:
 *   1. POINT 1 — the wizard has a way back, and it goes to the run listing.
 *   5. POINT 5 — the payslip rows link to the employee's full result, and the destination still REFUSES
 *      an employmentId outside the viewer's scope. The link is only safe because of that refusal, so the
 *      refusal is asserted, not the happy path.
 *   6. POINT 6 — the exported figures are the payslip's STORED snapshot, proven on the case where a
 *      recomputation would differ: a run reprocessed after its first calculation.
 *   4. POINT 4 — the History card came off the run screen WITHOUT taking the live recalculation controls
 *      with it. Close must still be refused while the run owes a recalculation.
 *
 * Page-level assertions are source-text checks (the house idiom for server components — cf.
 * test/payroll-flyout-nav.test.ts); the export half runs against a real run in the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { listPayrollRegisterAcross, type PayrollRegisterRow } from '../core/payroll-view';
import {
  TRANSACTION_DETAIL_COLUMNS,
  rowsForRun,
  transactionDetailReport,
} from '../app/payroll/[batchId]/transaction-detail-report';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped — a comment DESCRIBING a control must never satisfy a guard for it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const BATCH_PAGE = code('app/payroll/[batchId]/page.tsx');

describe('e440991b point 1 — the Payroll Process wizard has a way back', () => {
  /**
   * UPDATED BY d75b0c11, NOT WEAKENED. This case used to require the literal
   * `back={{ href: '/payroll' … }}`, which was the right assertion while the destination was a constant.
   * It is no longer one: the wizard is reached FROM the Payroll Process list (the New-run button, and
   * Continue on a draft row), both of which now hand it the operator's own filter query as `?from=…`, so
   * Back returns the listing AS IT WAS LEFT. The destination is unchanged whenever nothing is carried —
   * `payrollProcessBack` resolves an absent or hostile `from` to exactly `/payroll` — which is why the
   * claim this case exists to make ("the wizard has a way back, and it goes to the run listing") is the
   * same claim, stated against the shape that can also carry a selection.
   *
   * The literal is gone deliberately: pinning it would forbid the fix, and two tests asserting opposite
   * things about the same line are invisible to a targeted run.
   * test/payroll-filter-roundtrip-d75b0c11.test.ts case F renders this page and proves both halves —
   * the selection when one is carried, the bare `/payroll` when none is.
   */
  it('renders a back link, and it points at the run listing', () => {
    const src = code('app/payroll/process/page.tsx');
    expect(src, 'PageHeader still has no `back` prop').toMatch(/back=\{back\}/);
    expect(src, 'the back must be resolved through the shared payroll-list helper').toMatch(
      /const back = await payrollProcessBack\(from\);/,
    );
    expect(src).toContain("import { payrollProcessBack } from '../back';");
  });
});

describe('e440991b point 5 — the payslip rows open the employee’s full result', () => {
  it('the run screen links each payslip row at Transaction View, carrying the employee in the URL', () => {
    expect(BATCH_PAGE, 'no payslip detail link on the run screen').toContain('payslipDetailHref');
    expect(BATCH_PAGE).toContain('/payroll/transaction-view?');
    // The selection travels as a param, not across the RSC boundary — that is what keeps the server-side
    // scope guard on the destination applicable at all.
    expect(BATCH_PAGE).toMatch(/employmentId,/);
    expect(BATCH_PAGE).toMatch(/payslipDetailHref\(sl\.employmentId\)/);
  });

  it('THE REFUSAL: Transaction View still coerces an out-of-scope employmentId to “no selection”', () => {
    // This is the assertion the new link depends on. Transaction View resolves ?employmentId only when
    // it appears in the employees the caller is scoped to; anything else becomes `undefined`, which the
    // reads treat as "no employee filter" within an already company-fenced scope — never as "that
    // employee". Deleting this line would turn a convenience link into a way to read another company's
    // payroll by editing the address bar, and nothing else in the tree would notice.
    const view = code('app/payroll/transaction-view/page.tsx');
    expect(view).toMatch(
      /const employmentId\s*=\s*\n?\s*sp\.employmentId && employees\.some\(\(e\) => e\.employmentId === sp\.employmentId\) \? sp\.employmentId : undefined;/,
    );
    // …and the company fence it sits behind.
    expect(view).toMatch(/const companyId = sp\.companyId && scopeIds\.includes\(sp\.companyId\) \? sp\.companyId : undefined;/);
  });
});

describe('efe1d230 fallout — /payroll/<not-a-uuid> must 404, not 500', () => {
  /**
   * FOUND ON A DEV SERVER, NOT REASONED ABOUT. `/payroll/<segment>` is a catch-all, so every unmatched
   * path under the workbench lands on the batch page with `batchId` set to the segment. Deleting
   * /payroll/guide made a formerly valid URL — every bookmark anyone saved — fall through to it, and
   * `batchDetail('guide')` had Postgres reject the parameter (`invalid input syntax for type uuid`),
   * which is a 500. tsc, the suite and next build were all green; only the dev log showed it.
   */
  it('the batch page shape-checks the id before it reaches a query', () => {
    expect(BATCH_PAGE).toMatch(/UUID_RE\.test\(batchId\)/);
    expect(BATCH_PAGE).toMatch(/if \(!UUID_RE\.test\(batchId\)\) notFound\(\);/);
  });

  it('and so does the export route, which would otherwise throw the same query error', () => {
    const route = code('app/payroll/[batchId]/export/route.ts');
    expect(route).toMatch(/if \(!UUID_RE\.test\(batchId\)\) return new Response\('Not found', \{ status: 404 \}\);/);
  });
});

describe('e440991b point 4 — History came off the run screen, the live controls did not', () => {
  it('the per-run History card is gone', () => {
    expect(BATCH_PAGE, 'the History card is still rendered').not.toContain("t('historyTitle')");
    expect(BATCH_PAGE, 'humanizeEvent was only used by the History card').not.toContain('humanizeEvent');
  });

  it('but the events are still READ, because the publication line depends on them', () => {
    // ef31d251's "published by X on Y" finds the most recent payroll-batch.closed event in this read.
    // Removing the read along with the card would have downgraded every closed run to "no record".
    expect(BATCH_PAGE).toContain('auditEvents(s, { aggregateId: batchId');
    expect(BATCH_PAGE).toContain("'payroll-batch.closed'");
  });

  it('the recalculation banner and the Close-blocked-by-recalc guard survive (49e7e0a2)', () => {
    // These are LIVE CONTROLS, not history: without them a run can be closed owing a recalculation,
    // publishing figures the system already knows are stale.
    expect(BATCH_PAGE).toContain('needsRecalc');
    expect(BATCH_PAGE).toContain("t('recalcBannerTitle'");
    expect(BATCH_PAGE).toContain("t('closeBlockedRecalc')");
    // The disabled-Close branch specifically — the banner alone would not stop anyone.
    expect(BATCH_PAGE).toMatch(/needsRecalc \?\s*\(?\s*<Button type="button" variant="secondary" disabled/);
  });

  it('the RECALCULATION HISTORY card has MOVED off this screen — and it still exists', () => {
    // r168b held this card back from point 4 with a finding, and that finding still stands: it renders
    // `payroll_employee_result_history` through listRecomputeDisclosure, the Audit Trail does not carry
    // that table, and DELETING it would lose the only account of why a statutory figure moved.
    //
    // e440991b's revised plan resolves that properly: it moves to /payroll/<id>/reprocess, which becomes
    // its only reader. Both halves are asserted together on purpose — an assertion that it is gone from
    // here, alone, is satisfied by having deleted it, which is the outcome the finding forbids.
    expect(BATCH_PAGE, 'the disclosure card is still on the run screen').not.toContain("t('disclosureTitle')");
    expect(BATCH_PAGE, 'the run screen still reads the disclosure').not.toContain('listRecomputeDisclosure');
    const reprocessPage = code('app/payroll/[batchId]/reprocess/page.tsx');
    expect(reprocessPage, 'the disclosure lost its last reader').toContain('listRecomputeDisclosure');
    expect(reprocessPage).toContain("t('disclosureTitle')");
  });
});

describe('e440991b point 6 — the Transaction Detail Report reports what the payslips STORE', () => {
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

  async function hirePayrollReady(a: SessionContext, name: string, ic: string, salary: number) {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: salary, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    return e;
  }

  it('every exported cell equals the stored payslip, on a run that was RECALCULATED after processing', async () => {
    const a = adminCtx(base);
    const e = await hirePayrollReady(a, 'Detail Subject', '900101011234', 3000);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    // The divergence case the plan named. Raise the salary and reprocess just this employee: the STORED
    // payslip now holds the new figures at version 2. A report that recomputed from source data — or
    // that read the first calculation — would disagree with the payslip it claims to summarise, and the
    // reporter would be reconciling against a number nobody can see on screen.
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4200, monthlyAllowance: 0, effectiveFrom: '2026-05-01' });
    await generatePayslips(a, {
      batchId: b.batchId,
      reprocessSubset: { employmentIds: [e.employmentId], reason: 'salary correction' },
    });

    const [stored] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, b.batchId));
    expect(stored.version, 'the run was not actually reprocessed').toBeGreaterThan(1);

    const register = await listPayrollRegisterAcross(a, { companyIds: [base.companyId], year: 2026, month: 5 });
    const rows = rowsForRun(register, { payPeriod: '2026-05', runType: 'regular', runSeq: 1 });
    expect(rows).toHaveLength(1);
    const report = transactionDetailReport(
      { company: rows[0]!.company, payPeriod: '2026-05', runType: 'regular', runSeq: 1 },
      rows,
    );

    const cell = (label: string) => report.rows[0]![report.columns.indexOf(label)];
    // Earnings, total, deductions and nett all come off the stored row — not off a recomputation, and
    // not off the superseded first calculation (basic 3000).
    expect(cell('Basic Salary')).toBe(stored.basicSalary);
    expect(cell('Total Earnings (Gross)')).toBe(stored.grossPay);
    expect(cell('Total Deductions')).toBe(stored.totalDeductions);
    expect(cell('Nett Wage')).toBe(stored.netPay);
    expect(cell('Total Employer Cost')).toBe(stored.employerCost);
    expect(Number(stored.basicSalary), 'the export is reporting the pre-reprocess figure').toBeCloseTo(4200, 2);

    // The statutory lines come out of the payslip's own immutable jsonb snapshot, key for key.
    const st = (stored.statutory ?? {}) as Record<string, number>;
    expect(cell('EPF (Employee)')).toBe(st.epfEmployee ?? 0);
    expect(cell('EPF (Employer)')).toBe(st.epfEmployer ?? 0);
    expect(cell('SOCSO (Employee)')).toBe(st.socsoEmployee ?? 0);
    expect(cell('PCB (Tax)')).toBe(st.pcb ?? 0);

    // The organisation columns the reporter asked for by name are present and populated.
    expect(cell('Employee Name')).toBe('Detail Subject');
    expect(cell('Department')).toBeTruthy();
    expect(cell('Company')).toBeTruthy();
    expect(cell('Payroll Period')).toBe('2026-05');
  });

  it('rowsForRun keeps THIS run only — the register is keyed by company+period, not by batch', async () => {
    // The read this export reuses (`listPayrollRegisterAcross`, shared with the custom-report runner)
    // takes company + period + cycle, and a company can hold several runs of one period: an adjustment
    // run, or a re-run after an unlock. Without the runSeq/cycle narrowing the "download this run"
    // button would hand back somebody else's run folded in with this one. Exercised as pure data so all
    // four collision shapes are covered — the DB path can only produce one of them per test.
    const row = (over: Partial<PayrollRegisterRow>): PayrollRegisterRow =>
      ({ payPeriod: '2026-05', payrollCycle: 'regular', runSeq: 1, employeeName: 'x', ...over }) as PayrollRegisterRow;
    const mine = row({ employeeName: 'mine' });
    const all = [
      mine,
      row({ employeeName: 'later run, same cycle', runSeq: 2 }),
      row({ employeeName: 'bonus run, same period', payrollCycle: 'bonus' }),
      row({ employeeName: 'same run number, next month', payPeriod: '2026-06' }),
    ];
    const picked = rowsForRun(all, { payPeriod: '2026-05', runType: 'regular', runSeq: 1 });
    expect(picked.map((r) => r.employeeName)).toEqual(['mine']);
    expect(picked[0]).toBe(mine);
  });

  it('the column headers are English and cover earnings, deductions, employer contributions and totals', () => {
    // Export payloads are read by spreadsheets and accountants, so headers are resolved from a constant
    // rather than the message catalogs (ADR-0047 §9) — a header that changes with the reader's UI
    // language breaks whatever is parsing the file, and a half-translated header set is worse.
    const labels = TRANSACTION_DETAIL_COLUMNS.map((c) => c.label);
    for (const required of [
      'Employee ID',
      'Employee Name',
      'Company',
      'Department',
      'Payroll Period',
      'Basic Salary',
      'Allowances',
      'Overtime',
      'Total Earnings (Gross)',
      'EPF (Employee)',
      'PCB (Tax)',
      'Total Deductions',
      'Nett Wage',
      'EPF (Employer)',
      'HRD Corp Levy',
      'Total Employer Cost',
    ]) {
      expect(labels, `the report lost its "${required}" column`).toContain(required);
    }
    expect(new Set(labels).size, 'duplicate column label').toBe(labels.length);
  });

  it('the download button is on the run screen, and only once the run has payslips', () => {
    expect(BATCH_PAGE).toContain("t('transactionDetail')");
    expect(BATCH_PAGE).toMatch(/\/export\?format=xlsx/);
    // Draft-gated: a draft has no payslips, so an empty workbook would read as "this run pays nobody".
    const route = code('app/payroll/[batchId]/export/route.ts');
    expect(route).toContain("batch.status === 'draft'");
    // Fails closed twice — RLS through batchDetail, then the caller's own company scope.
    expect(route).toContain('scopedAdmin');
    expect(route).toMatch(/!scopeIds\.includes\(data\.batch\.companyId\)/);
  });
});
