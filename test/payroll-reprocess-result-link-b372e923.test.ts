/**
 * b372e923 — A PAYROLL RESULT LINK ON EVERY ROW OF A COMPLETED REPROCESS.
 *
 * The reprocess result table named every employee it had just recalculated and gave you no way to open
 * any of them: `app/payroll/[batchId]/reprocess/page.tsx` imported `next/link` zero times. To read one
 * person's result you had to leave the screen, go back to the Payroll Process list, find the same person
 * on the run and open them from there.
 *
 * WHAT THIS FILE PINS, AND WHY IT IS NOT AN ANCHOR COUNT. The reporter's fourth requirement is the one
 * that can fail silently: "It should not accidentally open the previous payroll result or another
 * employee's result." The result rows come from `payroll_employee_result_history` and the payslip ids
 * come from `batchDetail`'s `slips` — two independently-ordered lists that share only `employmentId`. A
 * link built from the wrong row's ids renders, looks right, and opens somebody else. Counting anchors,
 * or asserting that the page contains the string `/payroll/individual-payslip`, passes throughout that
 * failure. So the join is exercised AGAINST A REAL REPROCESSED RUN and every href is checked, id by id,
 * against the payslip row Postgres actually holds for that employee.
 *
 * AND ACROSS BOTH FILES. The join is `reprocessResultHrefs` (a pure function, checkable row by row) and
 * the rendering is the page, so the defect can also live in the CONTRACT between them — the page could
 * key the lookup by employment instead of by row, or hand it the wrong `from`. A unit test of either
 * half alone passes throughout that, so the wiring is pinned by source shape as well.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { batchDetail, createBatch, generatePayslips, getReprocessJob, reprocessSelectedEmployees } from '../core/payroll';
import { listRecomputeDisclosure } from '../core/payroll-view';
import { PAYROLL_RESULT_PATH, reprocessResultHrefs } from '../app/payroll/[batchId]/reprocess/result-links';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
/** Source with comments stripped — a comment DESCRIBING a link must never satisfy a guard for one. */
const code = (rel: string) =>
  fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGE = code('app/payroll/[batchId]/reprocess/page.tsx');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const MESSAGES = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]),
) as Record<(typeof LOCALES)[number], Record<string, never>>;
const msg = (locale: (typeof LOCALES)[number], dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), MESSAGES[locale]);

/** Read an href's query the way a browser would, so an assertion cannot pass on a substring. */
const paramsOf = (href: string) => {
  const [pathname, query = ''] = href.split('?', 2);
  return { pathname, params: new URLSearchParams(query) };
};

describe('b372e923 — the contract between the page and the join it renders', () => {
  it('the page links at all — it imported next/link zero times before this', () => {
    expect(PAGE).toMatch(/^import Link from 'next\/link';$/m);
  });

  it('resolves the hrefs from THIS run’s jobRows and THIS run’s slips, and looks each one up BY ROW', () => {
    // The two lists and the list filter query, in that order. Handing it `disclosure` instead of
    // `jobRows` would link the earlier-reprocessing card's rows too; handing it a different run's slips
    // is the cross-run version of the failure the reporter named.
    expect(PAGE).toContain('reprocessResultHrefs(jobRows, slips, sp.from)');
    // Keyed by the HISTORY ROW's id, which is what `jobRows.map` is iterating. Keying by employmentId
    // would still render one link per row and would still be right on a one-employee run — the shape
    // that is easiest to get wrong and hardest to see.
    expect(PAGE).toContain('resultHrefs.get(r.id)');
  });

  it('renders the link as a Link carrying that row’s href, and plain text when there is none', () => {
    expect(PAGE).toMatch(/<Link href=\{resultHref\}/);
    expect(PAGE).toContain("t('reprocessResultLink')");
    // The fallback is text, never an anchor to nowhere: a dead link is a promise this screen would break.
    expect(PAGE).toMatch(/resultHref \? \(/);
    expect(PAGE).toMatch(/<span className="text-muted-foreground">—<\/span>/);
    // The cell is decided by `resultHref` ALONE. An `isAdd` inside it would be the special case the plan
    // rules out — an addition's payslip was created by this very reprocess, so it links like the rest,
    // and the real-run case below proves it does.
    expect(PAGE.match(/\{resultHref \? \([\s\S]*?\)\}/)?.[0] ?? '', 'the link cell branches on something else').not.toContain('isAdd');
  });

  it('the new action column is a column — the empty-state row still spans the whole table', () => {
    expect(PAGE).toContain("t('reprocessColResult')");
    expect(PAGE).toContain('colSpan={6}');
    expect(PAGE, 'the empty-state row is one column short of the table').not.toContain('colSpan={5}');
  });

  it('and it is the EXISTING payroll result screen, the one pcb-detail and statutory-detail send Back to', () => {
    expect(PAYROLL_RESULT_PATH).toBe('/payroll/individual-payslip');
    for (const rel of ['app/payroll/pcb-detail/page.tsx', 'app/payroll/statutory-detail/page.tsx']) {
      expect(code(rel), `${rel} no longer builds this href`).toContain(`${PAYROLL_RESULT_PATH}?`);
    }
    // No second payroll-result surface was built for reprocessing: the page renders no route of its own
    // under the run for this, only the shared one, and it reaches it through the module above.
    expect(PAGE).toContain("from './result-links'");
    expect(PAGE).not.toContain(PAYROLL_RESULT_PATH);
  });

  it('the label and the column header are translated in all six locales, not echoed from English', () => {
    for (const key of ['reprocessColResult', 'reprocessResultLink']) {
      for (const l of LOCALES) {
        const v = msg(l, `payroll.batch.${key}`);
        expect(typeof v === 'string' && v.length > 0, `payroll.batch.${key} missing in ${l}`).toBe(true);
      }
      // A stale English VALUE passes key-parity, so the five non-English locales are checked against en.
      for (const l of LOCALES.filter((x) => x !== 'en')) {
        expect(msg(l, `payroll.batch.${key}`), `${key} is still English in ${l}`).not.toBe(
          msg('en', `payroll.batch.${key}`),
        );
      }
    }
  });
});

describe('b372e923 — the join, on rows and slips that do not line up', () => {
  const rows = [
    { id: 'row-c', employmentId: 'emp-c' },
    { id: 'row-a', employmentId: 'emp-a' },
    { id: 'row-gone', employmentId: 'emp-gone' },
  ];
  // Deliberately in a THIRD order, and carrying an employment that is not in the result at all: `slips`
  // is ordered by employee name and `jobRows` by employment id, so the two are never parallel arrays.
  const slips = [
    { id: 'slip-a', employmentId: 'emp-a' },
    { id: 'slip-bystander', employmentId: 'emp-bystander' },
    { id: 'slip-c', employmentId: 'emp-c' },
  ];

  it('gives each row its OWN employment and its OWN payslip', () => {
    const hrefs = reprocessResultHrefs(rows, slips);
    const a = paramsOf(hrefs.get('row-a')!);
    expect(a.params.get('employmentId')).toBe('emp-a');
    expect(a.params.get('payslipId')).toBe('slip-a');
    const c = paramsOf(hrefs.get('row-c')!);
    expect(c.params.get('employmentId')).toBe('emp-c');
    expect(c.params.get('payslipId')).toBe('slip-c');
    // …and nobody got the bystander's payslip, or the first slip in the list.
    expect([...hrefs.values()].some((h) => h.includes('slip-bystander'))).toBe(false);
  });

  it('leaves a row with no payslip on this run unmapped, rather than pointing it at someone else’s', () => {
    const hrefs = reprocessResultHrefs(rows, slips);
    expect(hrefs.has('row-gone'), 'a row with no payslip was given a link').toBe(false);
    expect(hrefs.size).toBe(2);
  });

  it('carries the list’s filter query as `from`, and omits it when there is none', () => {
    const withFrom = paramsOf(reprocessResultHrefs(rows, slips, '/payroll?year=2026&m=5&status=processed').get('row-a')!);
    expect(withFrom.pathname).toBe(PAYROLL_RESULT_PATH);
    expect(withFrom.params.get('from')).toBe('/payroll?year=2026&m=5&status=processed');
    expect(paramsOf(reprocessResultHrefs(rows, slips).get('row-a')!).params.has('from')).toBe(false);
    expect(paramsOf(reprocessResultHrefs(rows, slips, '').get('row-a')!).params.has('from')).toBe(false);
  });
});

// ────────────────────────────── against a real reprocessed run ──────────────────────────────

describe('b372e923 — against a real reprocessed run', () => {
  let base: Base;
  let a: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    a = await entitledCtx(base);
  });
  afterAll(async () => {
    await closeAll();
  });

  async function hire(name: string, email: string, ic: string, salary: number, hiredOn = '2026-01-01') {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: salary,
      monthlyAllowance: 0,
      effectiveFrom: hiredOn,
    });
    return e;
  }

  const slipOf = async (batchId: string, employmentId: string) => {
    const [row] = await owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    return row ?? null;
  };

  it('every reprocessed row — recalculation AND addition — links to that employee’s own payslip on this run', async () => {
    // Three people whose names sort in the OPPOSITE order to the employment ids the disclosure is
    // ordered by, because `slips` comes back ordered by full name: if the two lists ever line up by
    // accident, a positional join would pass and the reporter's failure would ship.
    const zoe = await hire('Zoe Recalculated', 'zoe@acme.test', '900101011234', 3000);
    const bystander = await hire('Alice Untouched', 'alice@acme.test', '900101012222', 3000);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    // Someone whose record reaches the company only after the run was processed: the ADD case, whose
    // payslip is created BY this reprocess and which must link exactly like a recalculated row.
    const mo = await hire('Mo Added', 'mo@acme.test', '900101013333', 4000, '2026-02-01');
    expect(await slipOf(b.batchId, mo.employmentId), 'fixture is wrong — the late hire already has a payslip').toBeNull();

    // One job covering both kinds. The salary move is what makes Zoe's row a real recalculation.
    await setCompensation(a, {
      employmentId: zoe.employmentId,
      basicSalary: 4200,
      monthlyAllowance: 0,
      effectiveFrom: '2026-05-01',
    });
    const job = await reprocessSelectedEmployees(a, {
      batchId: b.batchId,
      employmentIds: [zoe.employmentId, mo.employmentId],
      reason: 'salary correction and a late joiner',
    });
    expect(job.status).toBe('completed');

    // ── Re-derive exactly what the page holds at render time, through the same three reads. ──
    const detail = await batchDetail(a, b.batchId);
    const slips = detail!.slips;
    const thisJob = (await getReprocessJob(a, job.jobId))!;
    const disclosure = await listRecomputeDisclosure(a, { batchId: b.batchId });
    const jobRows = disclosure.filter(
      (r) => thisJob.employmentIds.includes(r.employmentId) && r.at >= thisJob.createdAt,
    );
    expect(jobRows.map((r) => r.employmentId).sort()).toEqual([zoe.employmentId, mo.employmentId].sort());
    expect(jobRows.some((r) => r.action === 'add'), 'the late joiner was not recorded as an addition').toBe(true);

    const hrefs = reprocessResultHrefs(jobRows, slips, '/payroll?year=2026&m=5');

    // THE ASSERTION THE REPORTER ASKED FOR. Every row's link carries that row's OWN employment and the
    // payslip Postgres holds for that employment on THIS run — checked against the table, not against
    // the same projection the href was built from.
    expect(hrefs.size, 'a reprocessed employee was left without a link').toBe(jobRows.length);
    for (const r of jobRows) {
      const { pathname, params } = paramsOf(hrefs.get(r.id)!);
      const slip = await slipOf(b.batchId, r.employmentId);
      expect(slip, `${r.employeeName} has no payslip on this run`).not.toBeNull();
      expect(pathname).toBe(PAYROLL_RESULT_PATH);
      expect(params.get('employmentId'), `${r.employeeName}'s link points at another employment`).toBe(r.employmentId);
      expect(params.get('payslipId'), `${r.employeeName}'s link points at another payslip`).toBe(slip!.id);
      expect(params.get('from')).toBe('/payroll?year=2026&m=5');
    }

    // Two rows, two DIFFERENT payslips: the failure where every row inherits the first slip's id would
    // satisfy every per-row check above if both rows happened to be the same person.
    const payslipIds = jobRows.map((r) => paramsOf(hrefs.get(r.id)!).params.get('payslipId'));
    expect(new Set(payslipIds).size, 'two employees were given the same payslip id').toBe(jobRows.length);

    // Nobody who was not reprocessed acquired a row, and in particular the untouched bystander's payslip
    // — which IS in `slips` — appears in no link on this table.
    const bystanderSlip = await slipOf(b.batchId, bystander.employmentId);
    expect(bystanderSlip).not.toBeNull();
    expect(
      [...hrefs.values()].some((h) => h.includes(bystanderSlip!.id)),
      'a reprocessed row links to an employee who was not reprocessed',
    ).toBe(false);
  });

  it('the ADD’s link is the payslip the reprocess created, at version 1', async () => {
    // Stated separately because "an addition links like the rest" is the one behaviour the plan calls
    // out by name, and it is the row whose payslip did not exist when the operator pressed the button.
    await hire('Already Paid', 'paid@acme.test', '900101011234', 3000);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });
    const added = await hire('Late Joiner', 'late@acme.test', '900101014444', 4000, '2026-02-01');

    const job = await reprocessSelectedEmployees(a, {
      batchId: b.batchId,
      employmentIds: [added.employmentId],
      reason: 'added after processing',
    });
    expect(job.status).toBe('completed');

    const detail = await batchDetail(a, b.batchId);
    const thisJob = (await getReprocessJob(a, job.jobId))!;
    const jobRows = (await listRecomputeDisclosure(a, { batchId: b.batchId })).filter(
      (r) => thisJob.employmentIds.includes(r.employmentId) && r.at >= thisJob.createdAt,
    );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0].action).toBe('add');

    const addedSlip = await slipOf(b.batchId, added.employmentId);
    expect(addedSlip!.version).toBe(1);
    const { params } = paramsOf(reprocessResultHrefs(jobRows, detail!.slips).get(jobRows[0].id)!);
    expect(params.get('employmentId')).toBe(added.employmentId);
    expect(params.get('payslipId'), 'the addition was linked to somebody else’s payslip').toBe(addedSlip!.id);
  });
});
