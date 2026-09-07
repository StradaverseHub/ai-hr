/**
 * b372e923 — A PAYROLL RESULT LINK ON EVERY ROW OF A COMPLETED REPROCESS.
 *
 * The reprocess result table named every employee it had just recalculated and gave you no way to open
 * any of them: `app/payroll/[batchId]/reprocess/page.tsx` imported `next/link` zero times. To read one
 * person's result you had to leave the screen, go back to the Payroll Process list, find the same person
 * on the run and open them from there.
 *
 * THREE THINGS CAN FAIL HERE, and only one of them is "is there an anchor".
 *
 *   1. WHOSE RESULT IT OPENS. "It should not accidentally open the previous payroll result or another
 *      employee's result" (requirement 4). The result rows come from `payroll_employee_result_history`
 *      and the run's payslips come from `batchDetail`'s `slips` — two independently-ordered lists that
 *      share only `employmentId`. A link built from the wrong row's ids renders, looks right, and opens
 *      somebody else. So the join is exercised AGAINST A REAL REPROCESSED RUN and every href is checked,
 *      row by row, against what Postgres actually holds for that employee on that run.
 *
 *   2. WHICH SCREEN IT OPENS. "There should not be a separate or different payroll-result interface for
 *      Reprocess" (requirement 3). Two screens each writing their own version of that URL is exactly how
 *      "the same result screen" quietly stops being the same one, and no amount of asserting that the
 *      page contains some path string would notice. So the destination is checked as an EQUALITY against
 *      the href the normal Payroll Process run screen renders for the same employee on the same run.
 *
 *   3. WHETHER BACK STILL WORKS. The operator arrives from a filtered Payroll Process list, and the
 *      submit is a redirect — a brand-new URL, on which nothing survives that the form did not post.
 *      The result table only exists AFTER that redirect, so a `from` the page reads out of its own
 *      address bar is a `from` that is never there when the links are drawn. That round trip is driven
 *      end to end below, through the real action.
 *
 * SOURCE-SHAPE GUARDS ARE THE FLOOR, NOT THE PROOF. Where one is used it pins a relationship (this call
 * is fed this screen's rows; the empty-state row spans as many columns as the header has) rather than a
 * formatting choice, so running a formatter over the page cannot turn this file red.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { batchDetail, createBatch, generatePayslips, getReprocessJob, reprocessSelectedEmployees } from '../core/payroll';
import { listRecomputeDisclosure } from '../core/payroll-view';
import { PAYROLL_RESULT_PATH, payrollResultHref } from '../app/payroll/payroll-result-href';
import { reprocessResultHrefs } from '../app/payroll/[batchId]/reprocess/result-links';
import { reprocessSelectedAction } from '../app/payroll/actions';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

// `reprocessSelectedAction` resolves its own session/translations and always redirects; mirror the
// wiring the other action-driving suites use so the redirect target is observable instead of fatal.
// None of `core/*` imports next/* or next-intl, so the real-run cases below are untouched by this.
let SESSION: SessionContext;
let LAST_REDIRECT = '';
vi.mock('../lib/session', () => ({ getSession: async () => SESSION }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

const ROOT = path.resolve(__dirname, '..');
/** Source with comments stripped — a comment DESCRIBING a link must never satisfy a guard for one. */
const code = (rel: string) =>
  fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const REPROCESS_DIR = 'app/payroll/[batchId]/reprocess';
const PAGE = code(`${REPROCESS_DIR}/page.tsx`);
const RUN_SCREEN = code('app/payroll/[batchId]/page.tsx');
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

const RUN = { companyId: 'co-1', payPeriod: '2026-05', runType: 'regular' };

describe('b372e923 — the contract between the page and the join it renders', () => {
  it('the page links at all — it imported next/link zero times before this', () => {
    expect(PAGE).toMatch(/^import Link from 'next\/link';$/m);
  });

  it('resolves the hrefs from THIS run’s jobRows, THIS run’s slips and THIS run, and looks each one up BY ROW', () => {
    // The arguments in order, whitespace-tolerant so wrapping the call across lines is not a failure.
    // Handing it `disclosure` instead of `jobRows` would link the earlier-reprocessing card's rows too;
    // handing it a different run's slips or a different run is the cross-run version of the failure the
    // reporter named. The fourth argument is the whitelisted list query, never the raw search param —
    // `listFrom` is derived from `payrollListReturnTo`, which case F below pins.
    expect(PAGE).toMatch(/reprocessResultHrefs\(\s*jobRows\s*,\s*slips\s*,\s*batch\s*,\s*listFrom\s*,?\s*\)/);
    // Keyed by the HISTORY ROW's id, which is what `jobRows.map` is iterating. Keying by employmentId
    // would still render one link per row and would still be right on a one-employee run — the shape
    // that is easiest to get wrong and hardest to see.
    expect(PAGE).toMatch(/resultHrefs\.get\(\s*r\.id\s*,?\s*\)/);
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

  it('the new action column is a column — the empty-state row still spans the WHOLE result table', () => {
    expect(PAGE).toContain("t('reprocessColResult')");
    // The invariant, not a literal: whatever this table's header count becomes, the "nothing moved" row
    // spans all of it. A `colSpan` left behind at the old width leaves a ragged cell under the new
    // column, and hard-coding the number here would go red the next time a column is added anywhere.
    const marker = PAGE.indexOf("t('reprocessColResult')");
    const table = PAGE.slice(PAGE.lastIndexOf('<thead', marker), PAGE.indexOf('</table>', marker));
    const headerCols = (table.match(/<th[\s>]/g) ?? []).length;
    expect(headerCols, 'the result table’s header could not be located').toBeGreaterThanOrEqual(6);
    const spans = [...table.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(spans.length, 'the result table has no full-width row left to check').toBeGreaterThan(0);
    for (const s of spans) expect(s, `a row spans ${s} of ${headerCols} columns`).toBe(headerCols);
  });

  it('reaches the destination through the shared builder, and builds no URL of its own', () => {
    expect(PAGE).toContain("from './result-links'");
    expect(code(`${REPROCESS_DIR}/result-links.ts`)).toContain("from '../../payroll-result-href'");
  });

  it('and no reprocess-only payroll-result screen was built under this route', () => {
    // Requirement 3 read structurally: "There should not be a separate or different payroll-result
    // interface for Reprocess." A second surface would have to be a route, and this route has none.
    const dirs = fs
      .readdirSync(path.join(ROOT, REPROCESS_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs, 'a sub-route appeared under Reprocess').toEqual([]);
  });

  it('F. the `from` it hands the links is whitelisted by shape, never the raw search param', () => {
    expect(PAGE).toContain('payrollListReturnTo');
    expect(PAGE).toMatch(/const listBack = payrollListReturnTo\(\s*sp\.from\s*\)/);
    expect(PAGE, 'the raw search param reached a link').not.toMatch(/reprocessResultHrefs\([^)]*sp\.from/);
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

  it('gives each row its OWN employment, and the run’s own period and cycle', () => {
    const hrefs = reprocessResultHrefs(rows, slips, RUN);
    const a = paramsOf(hrefs.get('row-a')!);
    expect(a.params.get('employmentId')).toBe('emp-a');
    const c = paramsOf(hrefs.get('row-c')!);
    expect(c.params.get('employmentId')).toBe('emp-c');
    // …and nobody got the bystander, or the first employment in the list.
    expect([...hrefs.values()].some((h) => h.includes('emp-bystander'))).toBe(false);
    // The record is identified by the RUN, not by today: year, month and cycle come off `payPeriod` and
    // `runType`, which is what the reporter's expected-function note asks to be passed.
    expect(a.params.get('companyId')).toBe('co-1');
    expect(a.params.get('year')).toBe('2026');
    expect(a.params.get('month')).toBe('5');
    expect(a.params.get('cycle')).toBe('regular');
  });

  it('leaves a row with no payslip on this run unmapped, rather than pointing it at someone else’s', () => {
    const hrefs = reprocessResultHrefs(rows, slips, RUN);
    expect(hrefs.has('row-gone'), 'a row with no payslip was given a link').toBe(false);
    expect(hrefs.size).toBe(2);
  });

  it('carries the list’s filter query as `from`, and omits it when there is none', () => {
    const withFrom = paramsOf(
      reprocessResultHrefs(rows, slips, RUN, '/payroll?year=2026&m=5&status=processed').get('row-a')!,
    );
    expect(withFrom.pathname).toBe(PAYROLL_RESULT_PATH);
    expect(withFrom.params.get('from')).toBe('/payroll?year=2026&m=5&status=processed');
    expect(paramsOf(reprocessResultHrefs(rows, slips, RUN).get('row-a')!).params.has('from')).toBe(false);
    expect(paramsOf(reprocessResultHrefs(rows, slips, RUN, '').get('row-a')!).params.has('from')).toBe(false);
  });
});

describe('b372e923 — requirement 3: the SAME screen the normal Payroll Process run screen opens', () => {
  it('the run screen builds its per-employee links with the shared builder, not a URL of its own', () => {
    // If this ever stops being true the equality below is comparing the reprocess link with something
    // nobody renders, and requirement 3 is unguarded again.
    expect(RUN_SCREEN).toMatch(/payslipDetailHref\s*=\s*\([^)]*\)\s*=>\s*payrollResultHref\(/);
    expect(RUN_SCREEN).toMatch(/payslipDetailHref\(sl\.employmentId\)/);
    // …and it does not ALSO hand-roll one. The run screen still builds other Transaction View links (the
    // outstanding-transactions one, a different tab and a different destination); what must not come
    // back is a second spelling of the RESULT url beside the shared builder.
    expect(RUN_SCREEN, 'the run screen went back to spelling the result URL itself').not.toMatch(
      /tab: 'history'/,
    );
  });

  it('and the two hrefs are the same URL for the same employee on the same run', () => {
    const rows = [{ id: 'row-a', employmentId: 'emp-a' }];
    const slips = [{ id: 'slip-a', employmentId: 'emp-a' }];
    // What the run screen renders for this employee, and what the reprocess result renders for the same
    // employee on the same run. Not "both contain the path" — identical, param for param.
    expect(reprocessResultHrefs(rows, slips, RUN).get('row-a')).toBe(payrollResultHref(RUN, 'emp-a'));
    // …and the only difference the reprocess link is allowed to add is where Back goes.
    const withFrom = reprocessResultHrefs(rows, slips, RUN, '/payroll?year=2026').get('row-a')!;
    const { params } = paramsOf(withFrom);
    params.delete('from');
    expect(`${PAYROLL_RESULT_PATH}?${params.toString()}`).toBe(payrollResultHref(RUN, 'emp-a'));
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
    SESSION = a;
    LAST_REDIRECT = '';
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

  it('every reprocessed row — recalculation AND addition — links to that employee’s own result on this run', async () => {
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
    const { batch, slips } = detail!;
    const thisJob = (await getReprocessJob(a, job.jobId))!;
    const disclosure = await listRecomputeDisclosure(a, { batchId: b.batchId });
    const jobRows = disclosure.filter(
      (r) => thisJob.employmentIds.includes(r.employmentId) && r.at >= thisJob.createdAt,
    );
    expect(jobRows.map((r) => r.employmentId).sort()).toEqual([zoe.employmentId, mo.employmentId].sort());
    expect(jobRows.some((r) => r.action === 'add'), 'the late joiner was not recorded as an addition').toBe(true);

    const hrefs = reprocessResultHrefs(jobRows, slips, batch, '/payroll?year=2026&m=5');

    // THE ASSERTION THE REPORTER ASKED FOR. Every row's link opens that row's OWN employee on THIS run —
    // and it is the very href the run screen would render for them, checked against the run Postgres
    // holds rather than against the projection the link was built from.
    expect(hrefs.size, 'a reprocessed employee was left without a link').toBe(jobRows.length);
    for (const r of jobRows) {
      const { pathname, params } = paramsOf(hrefs.get(r.id)!);
      const slip = await slipOf(b.batchId, r.employmentId);
      expect(slip, `${r.employeeName} has no payslip on this run`).not.toBeNull();
      expect(pathname).toBe(PAYROLL_RESULT_PATH);
      expect(params.get('employmentId'), `${r.employeeName}'s link points at another employment`).toBe(r.employmentId);
      expect(params.get('companyId'), `${r.employeeName}'s link points at another company`).toBe(batch.companyId);
      expect(params.get('year')).toBe('2026');
      expect(params.get('month')).toBe('5');
      expect(params.get('cycle'), `${r.employeeName}'s link points at another cycle`).toBe(batch.runType);
      expect(params.get('from')).toBe('/payroll?year=2026&m=5');
      // Requirement 3, on the real run: identical to what the normal Payroll Process run screen renders.
      params.delete('from');
      expect(`${pathname}?${params.toString()}`, `${r.employeeName} opens a different screen from the run`).toBe(
        payrollResultHref(batch, r.employmentId),
      );
    }

    // Two rows, two DIFFERENT employees: the failure where every row inherits the first row's employment
    // would satisfy every per-row check above if both rows happened to be the same person.
    const linkedIds = jobRows.map((r) => paramsOf(hrefs.get(r.id)!).params.get('employmentId'));
    expect(new Set(linkedIds).size, 'two rows were given the same employee').toBe(jobRows.length);

    // Nobody who was not reprocessed acquired a row, and in particular the untouched bystander — who IS
    // in `slips` — appears in no link on this table.
    expect(await slipOf(b.batchId, bystander.employmentId)).not.toBeNull();
    expect(
      [...hrefs.values()].some((h) => h.includes(bystander.employmentId)),
      'a reprocessed row links to an employee who was not reprocessed',
    ).toBe(false);
  });

  it('the ADD’s link is the employee the reprocess added, whose payslip it created at version 1', async () => {
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
    const href = reprocessResultHrefs(jobRows, detail!.slips, detail!.batch).get(jobRows[0].id);
    expect(href, 'the addition was left as plain text').toBeDefined();
    expect(paramsOf(href!).params.get('employmentId'), 'the addition was linked to somebody else').toBe(
      added.employmentId,
    );
  });

  // ─────────────────── requirement: Back from the result still returns the list as left ───────────────────

  it('the submit carries `from` across the redirect, so the links the result table draws still have it', async () => {
    // THE WHOLE POINT. The result table exists ONLY on the URL this redirect produces. If `from` does not
    // survive the round trip there is nothing for the links to carry, however correctly the page reads
    // its own address bar — which is precisely the state this branch shipped in before the fix.
    const e = await hire('Round Trip', 'rt@acme.test', '900101015555', 3000);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    const fd = new FormData();
    fd.set('batchId', b.batchId);
    fd.append('employmentIds', e.employmentId);
    fd.set('reason', 'round trip');
    fd.set('from', '/payroll?year=2026&m=5&status=processed');
    await expect(reprocessSelectedAction(fd)).rejects.toThrow('NEXT_REDIRECT');

    const { pathname, params } = paramsOf(LAST_REDIRECT);
    expect(pathname).toBe(`/payroll/${b.batchId}/reprocess`);
    expect(params.get('job'), 'the redirect lost the job id').toBeTruthy();
    expect(params.get('from'), 'the filter query did not survive the submit').toBe(
      '/payroll?year=2026&m=5&status=processed',
    );

    // …and end to end: re-render the page's reads off that redirect's own query, exactly as the operator
    // would land on it, and the Payroll Result link carries the filters through to the result screen.
    const detail = await batchDetail(a, b.batchId);
    const thisJob = (await getReprocessJob(a, params.get('job')!))!;
    const jobRows = (await listRecomputeDisclosure(a, { batchId: b.batchId })).filter(
      (r) => thisJob.employmentIds.includes(r.employmentId) && r.at >= thisJob.createdAt,
    );
    expect(jobRows.length).toBeGreaterThan(0);
    const hrefs = reprocessResultHrefs(jobRows, detail!.slips, detail!.batch, params.get('from')!);
    expect(paramsOf(hrefs.get(jobRows[0].id)!).params.get('from')).toBe('/payroll?year=2026&m=5&status=processed');
  });

  it('an unfiltered submit keeps a clean URL, and a hostile `from` never reaches it', async () => {
    const e = await hire('No Filters', 'nf@acme.test', '900101016666', 3000);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    const submit = async (from?: string) => {
      LAST_REDIRECT = '';
      const fd = new FormData();
      fd.set('batchId', b.batchId);
      fd.append('employmentIds', e.employmentId);
      fd.set('reason', 'no filters');
      if (from !== undefined) fd.set('from', from);
      await expect(reprocessSelectedAction(fd)).rejects.toThrow('NEXT_REDIRECT');
      return paramsOf(LAST_REDIRECT).params;
    };

    expect((await submit()).has('from'), 'an unfiltered submit still emitted a from=').toBe(false);
    // Whitelisted by shape: an off-site destination degrades to the plain list, i.e. to no `from` at all,
    // rather than riding out on a link this screen renders.
    expect((await submit('https://evil.example/payroll')).has('from')).toBe(false);
    expect((await submit('/admin/users')).has('from')).toBe(false);
  });

  it('and the refusal path carries it too — a rejected submit must not strand the operator either', async () => {
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    const fd = new FormData();
    fd.set('batchId', b.batchId);
    fd.set('from', '/payroll?year=2026&m=5');
    // Nothing ticked: the earliest refusal, before the service is even called.
    await expect(reprocessSelectedAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    const { params } = paramsOf(LAST_REDIRECT);
    expect(params.get('error')).toBe('reprocessNoneSelected');
    expect(params.get('from'), 'a refusal threw the filters away').toBe('/payroll?year=2026&m=5');
  });

  it('the screen hands the form its whitelisted `from` rather than the raw search param', () => {
    // The one end of the round trip neither the cases above nor the DOM test can reach: the page is a
    // server component. That the FORM then posts the value it is given is proved by rendering, in
    // test/payroll-reprocess-form.dom.test.tsx; that the ACTION puts it back is proved above.
    expect(PAGE).toMatch(/<ReprocessForm[\s\S]*?from=\{\s*listFrom\s*\??\??\s*(?:null)?\s*\}/);
    expect(PAGE, 'the raw search param was handed to the form').not.toMatch(/from=\{\s*sp\.from/);
  });
});
