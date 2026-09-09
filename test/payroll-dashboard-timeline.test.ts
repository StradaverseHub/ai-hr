/**
 * 7f6ca478 — the Payroll Process dashboard (year selector + twelve-month timeline + full-width grid).
 *
 * Four groups, each pinning something that a green tsc / green suite / HTTP 200 would NOT have caught:
 *
 *  1. THE WIDENED READ. `listBatches` now takes a SET of periods. The property that matters is not that
 *     a set works — it is that an EMPTY set means "no rows", not "all rows". A period filter that
 *     silently widens to everything when the caller's computed set comes back empty is how a filter
 *     turns into a disclosure, so that case is asserted directly, alongside byte-compatibility for the
 *     single-string and omitted forms the three pre-existing callers rely on.
 *
 *  2. THE PROCESSED DATE AND ITS TIMEZONE. `listBatchProcessedDates` reduces a timestamptz to a
 *     calendar date. Do that in UTC and every run processed after 16:00 UTC — i.e. after 00:00 MYT — is
 *     dated to the previous day, which on a YEAR-MONTH timeline can put it in the previous MONTH. The
 *     boundary test writes an event at 17:00 UTC on 31 May and requires 1 June back.
 *
 *  3. THE FILTER ARITHMETIC, as pure functions: no month ticked means the whole year (not nothing), the
 *     year dropdown always contains the selected year however far it is from today, and the address the
 *     controls write round-trips back through the parsers.
 *
 *  4. THE THINGS THE MOCK ASKED FOR THAT DO NOT EXIST. `payroll_status` is exactly
 *     ('draft','processed','closed'); the request also listed Processing, Failed and Cancelled. This
 *     file fails if any of those reach the screen, because the only way to make them appear is to add
 *     enum values for states nothing can produce.
 *
 * Plus an i18n check the shared guard structurally cannot do here: `test/i18n-coverage.test.ts` check C
 * SKIPS any file that binds more than one namespace, and app/payroll/page.tsx binds two
 * (`payroll.list` + `payroll.batch`, the latter so the Reset confirm copy is written once). Every key
 * this dashboard adds therefore sits in exactly the blind spot the guard is documented to have — so the
 * keys are resolved here, per binding, across all six catalogs.
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
import { createBatch, generatePayslips, listBatches } from '../core/payroll';
import { listBatchProcessedDates } from '../core/payroll-view';
import {
  ALL_MONTHS,
  MONTHS,
  applyFilters,
  asArray,
  currentTenantMonth,
  dashboardHref,
  monthCells,
  monthOfPeriod,
  parseMonths,
  parseYear,
  periodsForYear,
  selectedPeriods,
  summarise,
  toggleMonth,
  yearOptions,
} from '../app/payroll/dashboard-logic';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
type Dict = Record<string, unknown>;
const catalog = (loc: string): Dict =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
const getPath = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

// ───────────────────────────── 3 + 4. Pure filter arithmetic (no DB) ─────────────────────────────

describe('7f6ca478 — dashboard filter arithmetic (pure)', () => {
  it('an unticked timeline means the WHOLE year, never an empty result', () => {
    expect(selectedPeriods(2026, [])).toEqual(periodsForYear(2026));
    expect(selectedPeriods(2026, [])).toHaveLength(12);
    // …and ticking narrows to exactly the ticked months, consecutive or not.
    expect(selectedPeriods(2026, [1, 3, 8])).toEqual(['2026-01', '2026-03', '2026-08']);
  });

  it('parseMonths sorts, de-duplicates, accepts repeated AND comma params, and drops impossible months', () => {
    expect(parseMonths(['8', '5', '5', '6'], 3)).toEqual([5, 6, 8]);
    expect(parseMonths('5,6,7', 3)).toEqual([5, 6, 7]);
    // 0, 13 and junk are DROPPED, not clamped — a hand-typed ?m=13 must mean "no such month" rather
    // than silently becoming December and showing the reader data they did not ask for.
    expect(parseMonths(['0', '13', 'december', '-1', '7'], 3)).toEqual([7]);
  });

  it('e440991b point 7 — an ABSENT ?m opens on the current month, and ?m=all still means the year', () => {
    // The default moved: it used to be "all twelve", which is what the reporter was seeing and did not
    // want. UPDATED, not deleted — the old `parseMonths(undefined) === []` assertion above became this
    // pair, because the whole-year state still has to be reachable or unticking becomes a one-way door.
    expect(parseMonths(undefined, 3)).toEqual([3]);
    expect(parseMonths(ALL_MONTHS, 3)).toEqual([]);
    expect(parseMonths([ALL_MONTHS], 3)).toEqual([]);
    // 'all' wins over anything else in the same param, so a stale ?m=5&m=all is unambiguous.
    expect(parseMonths(['5', ALL_MONTHS], 3)).toEqual([]);
    // …and an empty set round-trips through the address bar as the explicit token, not as silence.
    const href = dashboardHref({ year: 2026, months: [], companyIds: [], cycles: [], statuses: [] });
    const sp = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect(sp.getAll('m')).toEqual([ALL_MONTHS]);
    expect(parseMonths(sp.getAll('m'), 3)).toEqual([]);
  });

  it('e440991b point 7 — the month default comes off the TENANT clock, asserted at 00:30 MYT on 1 January', () => {
    // THE BUG THIS PINS. 2026-01-01T00:30+08:00 is 2025-12-31T16:30Z. `new Date().getMonth()` on a UTC
    // host says December; the tenant is in January. The dashboard's YEAR default already takes this
    // care (app/payroll/page.tsx says so in as many words), and a month default that did not would
    // open New Year's morning on December of the year the reader is no longer in — for eight hours,
    // every year, on the morning payroll is most likely to be opened.
    const newYearMorningMYT = new Date('2025-12-31T16:30:00.000Z');
    expect(newYearMorningMYT.getUTCMonth() + 1, 'the trap: UTC still says December').toBe(12);
    expect(currentTenantMonth(newYearMorningMYT)).toBe(1);
    expect(parseMonths(undefined, currentTenantMonth(newYearMorningMYT))).toEqual([1]);
    // The default argument is the same clock, so a caller that passes nothing is not on a worse one.
    expect(currentTenantMonth()).toBe(Number(todayInKualaLumpur().slice(5, 7)));
    // Mid-year sanity: no timezone shift, no off-by-one.
    expect(currentTenantMonth(new Date('2026-06-15T12:00:00.000Z'))).toBe(6);
  });

  it('parseYear falls back to the CALLER\'S year, which the page derives in MYT', () => {
    expect(parseYear('2024', 2026)).toBe(2024);
    expect(parseYear(undefined, 2026)).toBe(2026);
    expect(parseYear('not-a-year', 2026)).toBe(2026);
    expect(parseYear('12', 2026)).toBe(2026); // out of the plausible range
  });

  it('the year dropdown ALWAYS contains the selected year, however far outside the window it is', () => {
    // The arrows step freely, so a tenant whose oldest run is 2015 can walk back to it — and when they
    // do, the dropdown must still be able to render the value it is showing.
    expect(yearOptions(2015, 2026)).toContain(2015);
    expect(yearOptions(2040, 2026)).toContain(2040);
    expect(yearOptions(2026, 2026)).toContain(2026);
    // Descending, contiguous, no duplicates.
    const ys = yearOptions(2015, 2026);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    expect(new Set(ys).size).toBe(ys.length);
  });

  it('applyFilters intersects; an empty selection means "no filter", never "nothing"', () => {
    const rows = [
      { payPeriod: '2026-05', companyId: 'c1', runType: 'regular', status: 'processed' },
      { payPeriod: '2026-06', companyId: 'c1', runType: 'bonus', status: 'draft' },
      { payPeriod: '2026-05', companyId: 'c2', runType: 'regular', status: 'closed' },
    ];
    const all = { periods: periodsForYear(2026), companyIds: [], cycles: [], statuses: [] };
    expect(applyFilters(rows, all)).toHaveLength(3);
    expect(applyFilters(rows, { ...all, companyIds: ['c1'] })).toHaveLength(2);
    expect(applyFilters(rows, { ...all, cycles: ['regular'] })).toHaveLength(2);
    expect(applyFilters(rows, { ...all, statuses: ['draft'] })).toHaveLength(1);
    expect(applyFilters(rows, { ...all, periods: ['2026-05'], companyIds: ['c2'] })).toHaveLength(1);
    // Combined filters intersect rather than union.
    expect(applyFilters(rows, { ...all, companyIds: ['c1'], statuses: ['closed'] })).toHaveLength(0);
  });

  it('monthCells counts runs per month so an unticked month still shows what is in it', () => {
    const labels = MONTHS.map((m) => `M${m}`);
    const rows = [{ payPeriod: '2026-05' }, { payPeriod: '2026-05' }, { payPeriod: '2026-08' }];
    const cells = monthCells(labels, [8], rows);
    expect(cells).toHaveLength(12);
    expect(cells.find((c) => c.month === 5)).toMatchObject({ runs: 2, selected: false });
    expect(cells.find((c) => c.month === 8)).toMatchObject({ runs: 1, selected: true });
    expect(cells.find((c) => c.month === 1)).toMatchObject({ runs: 0, selected: false });
  });

  it('timeline counts follow company/cycle/status but NOT the month selection', () => {
    // The composition the page performs: filter by everything EXCEPT the months, count that, then apply
    // the months to get the grid. Counting before the company filter would badge months the chosen
    // company never ran in (click it, get an empty table); counting after the MONTH filter would blank
    // every unticked cell, which is the one thing the badges exist to prevent.
    const labels = MONTHS.map((m) => `M${m}`);
    const rows = [
      { payPeriod: '2026-05', companyId: 'c1', runType: 'regular', status: 'processed' },
      { payPeriod: '2026-08', companyId: 'c1', runType: 'regular', status: 'processed' },
      { payPeriod: '2026-08', companyId: 'c2', runType: 'regular', status: 'processed' },
    ];
    const months = [5];
    const scopeMatched = applyFilters(rows, {
      periods: periodsForYear(2026),
      companyIds: ['c1'],
      cycles: [],
      statuses: [],
    });
    const cells = monthCells(labels, months, scopeMatched);
    // c2's August run is excluded by the company filter…
    expect(cells.find((c) => c.month === 8)).toMatchObject({ runs: 1, selected: false });
    // …and August still carries its count even though only May is ticked.
    expect(cells.find((c) => c.month === 5)).toMatchObject({ runs: 1, selected: true });
    // The GRID, by contrast, is the month-narrowed set.
    const grid = applyFilters(scopeMatched, {
      periods: selectedPeriods(2026, months),
      companyIds: [],
      cycles: [],
      statuses: [],
    });
    expect(grid.map((r) => r.payPeriod)).toEqual(['2026-05']);
  });

  it('the address the controls write parses back to the same filter state, and never carries page/size', () => {
    const href = dashboardHref({
      year: 2026,
      months: [5, 6, 7, 8],
      companyIds: ['c1', 'c2'],
      cycles: ['regular'],
      statuses: ['processed'],
    });
    const sp = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect(parseYear(sp.get('year') ?? undefined, 1999)).toBe(2026);
    expect(parseMonths(sp.getAll('m'), 3)).toEqual([5, 6, 7, 8]);
    expect(asArray(sp.getAll('company'))).toEqual(['c1', 'c2']);
    expect(asArray(sp.getAll('cycle'))).toEqual(['regular']);
    expect(asArray(sp.getAll('status'))).toEqual(['processed']);
    // Changing a filter changes which rows exist, so staying on page 4 would land past the end.
    expect(sp.has('page')).toBe(false);
    expect(sp.has('size')).toBe(false);
  });

  it('toggleMonth ticks and unticks one month, keeping the set sorted', () => {
    expect(toggleMonth([], 5)).toEqual([5]);
    expect(toggleMonth([5, 7], 6)).toEqual([5, 6, 7]);
    expect(toggleMonth([5, 6, 7], 6)).toEqual([5, 7]);
  });

  it('monthOfPeriod reads only real YYYY-MM periods', () => {
    expect(monthOfPeriod('2026-05')).toBe(5);
    expect(monthOfPeriod('2026-12')).toBe(12);
    expect(monthOfPeriod('2026-13')).toBeNull();
    expect(monthOfPeriod('2026-00')).toBeNull();
    expect(monthOfPeriod('2026-05-01')).toBeNull();
  });

  it('summarise counts ONLY the three states that exist', () => {
    const s = summarise([
      { status: 'draft' },
      { status: 'processed' },
      { status: 'processed' },
      { status: 'closed' },
    ]);
    expect(s).toEqual({ total: 4, draft: 1, processed: 2, closed: 1 });
    expect(Object.keys(s).sort()).toEqual(['closed', 'draft', 'processed', 'total']);
  });
});

describe('7f6ca478 — the three statuses in the request that do not exist stay off the screen', () => {
  const INVENTED = ['processing', 'failed', 'cancelled'] as const;

  it('payrollStatusEnum is exactly draft/processed/closed', () => {
    expect([...schema.payrollStatusEnum.enumValues].sort()).toEqual(['closed', 'draft', 'processed']);
  });

  // 0b326d5f (r256) — UPDATED, NOT WEAKENED. The listing now renders a fourth PILL, "Reprocess
  // Required", for a processed run carrying `needs_recalc_at`. That is not an invented status and this
  // case still holds it out: the derived state is `processed` + a real column (app/payroll/dashboard-
  // logic.ts `payrollListState`), it styles from a SEPARATE constant (REPROCESS_PILL), and STATUS_STYLE
  // below stays keyed by exactly the enum — which is precisely what keeps "no fourth payroll status"
  // enforced while the screen says what the reporter asked it to say.
  it('the dashboard styles exactly the real statuses — no invented state can render a badge', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'app', 'payroll', 'page.tsx'), 'utf8'));
    const block = /const STATUS_STYLE: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src);
    expect(block, 'STATUS_STYLE not found in app/payroll/page.tsx').toBeTruthy();
    const styled = [...block![1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();
    expect(styled).toEqual([...schema.payrollStatusEnum.enumValues].sort());
  });

  it('no invented status name appears in the dashboard sources or the catalogs', () => {
    const files = ['app/payroll/page.tsx', 'app/payroll/dashboard-logic.ts', 'app/payroll/dashboard-filters.tsx'];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      for (const bad of INVENTED) {
        expect(src.toLowerCase(), `${f} must not render a '${bad}' payroll status`).not.toContain(`'${bad}'`);
        expect(src.toLowerCase(), `${f} must not render a '${bad}' payroll status`).not.toContain(`status.${bad}`);
      }
    }
    for (const loc of LOCALES) {
      for (const bad of INVENTED) {
        expect(getPath(catalog(loc), `payroll.list.status.${bad}`), `${loc}: payroll.list.status.${bad}`).toBeUndefined();
      }
    }
  });
});

// ─────────────────────── i18n: the two-namespace blind spot in check C ───────────────────────

describe('7f6ca478 — every dashboard label resolves in all six catalogs', () => {
  const BINDING = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:getTranslations|useTranslations)\(\s*'([^']+)'/g;
  const CALL = /(?<![\w$])(\w+)\(\s*'([a-zA-Z][\w.]*)'/g;

  it('app/payroll/page.tsx: literal keys resolve under the namespace their binding names', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'app', 'payroll', 'page.tsx'), 'utf8'));
    const ns = new Map<string, string>();
    for (const m of src.matchAll(BINDING)) ns.set(m[1], m[2]);
    // The premise of this whole test: the file binds MORE THAN ONE namespace, which is exactly what
    // makes i18n-coverage check C skip it. If that ever stops being true the shared guard covers the
    // file and this test can go — but it must not go silently.
    expect(ns.size, 'page.tsx now binds one namespace — check C covers it; this test can be retired').toBeGreaterThan(1);

    const checked: string[] = [];
    for (const m of src.matchAll(CALL)) {
      const namespace = ns.get(m[1]);
      if (!namespace) continue; // not a translator binding this file declares
      const key = `${namespace}.${m[2]}`;
      for (const loc of LOCALES) {
        expect(getPath(catalog(loc), key), `${loc}: ${key} (read by app/payroll/page.tsx)`).toBeTruthy();
      }
      checked.push(key);
    }
    // A regex that silently matched nothing would make every assertion above vacuous.
    expect(checked.length, 'no t() call sites found in app/payroll/page.tsx').toBeGreaterThan(20);
  });

  it('the dashboard\'s dynamic label keys exist for every enum value they can be built from', () => {
    for (const loc of LOCALES) {
      const c = catalog(loc);
      for (const v of schema.payrollRunTypeEnum.enumValues) {
        expect(getPath(c, `payroll.list.runType.${v}`), `${loc}: payroll.list.runType.${v}`).toBeTruthy();
      }
      for (const v of schema.payrollStatusEnum.enumValues) {
        expect(getPath(c, `payroll.list.status.${v}`), `${loc}: payroll.list.status.${v}`).toBeTruthy();
      }
    }
  });

  it('the filter bar accepts NO function-typed prop, so no server caller can pass a closure', () => {
    // THIS ONE WAS LIVE FOR AN HOUR. The first draft typed two labels as `(n: number) => string` and
    // passed `labels={{ runsInMonth: (n) => t(…), selectedCount: (n) => t(…) }}`. Every request to
    // /payroll returned 500 — "Functions cannot be passed directly to Client Components" — while tsc,
    // the suite and next build all stayed green. Only rendering it on a dev server showed it.
    //
    // test/server-client-boundary.test.ts pins exactly this class, and did not catch it: its scan
    // matches a function at the TOP level of a JSX attribute (`prop={(…) =>`), and these sat one level
    // down inside an object literal. That hole is general, not specific to this page, and is reported
    // for a separate widening.
    //
    // The check here is on the TYPE rather than the call site, which is both stricter and stable: an
    // island whose props are all serialisable cannot be handed a closure by anyone. Same idea as that
    // file's "the wrapper takes only serialisable props" test.
    const src = stripComments(
      fs.readFileSync(path.join(ROOT, 'app', 'payroll', 'dashboard-filters.tsx'), 'utf8'),
    );
    const region = (startMarker: string, endMarker: string) => {
      const from = src.indexOf(startMarker);
      expect(from, `${startMarker} not found in dashboard-filters.tsx`).toBeGreaterThan(-1);
      const to = src.indexOf(endMarker, from);
      expect(to, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(from);
      return src.slice(from, to);
    };
    const declared = [
      region('export type DashboardFilterLabels = {', '\n};'),
      region('export type TimelineCell', '\n'),
      // The component's own inline props object: everything between `}: {` and `}) {`.
      region('export function DashboardFilterBar({', '}) {'),
    ];
    for (const block of declared) {
      expect(block, `a function-typed prop reintroduces the 500:\n${block}`).not.toMatch(/=>/);
      expect(block).not.toMatch(/\bFunction\b/);
    }
  });

  it('the filter bar island holds NO t() lookups — every string arrives pre-translated', () => {
    // If a label lookup moves into components/ or into this island, it leaves the reach of BOTH the
    // shared i18n guard and test/payroll-run-type-label-namespace.test.ts (which walks app/payroll and
    // resolves each call site's binding). That is precisely how r134's MISSING_MESSAGE reached prod.
    const src = fs.readFileSync(path.join(ROOT, 'app', 'payroll', 'dashboard-filters.tsx'), 'utf8');
    expect(src).not.toMatch(/\buseTranslations\(/);
    expect(src).not.toMatch(/\bgetTranslations\(/);
  });
});

// ───────────────────────── 1 + 2. The reads (DB) ─────────────────────────

describe('7f6ca478 — listBatches period SET + listBatchProcessedDates', () => {
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

  /** Hire + compensation + statutory profile so generatePayslips can run. */
  async function hirePayrollReady(a: SessionContext, name: string, ic: string) {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    return e;
  }

  it('a SET of periods returns exactly those months — the timeline\'s multi-month selection', async () => {
    const a = adminCtx(base);
    for (const p of ['2026-05', '2026-06', '2026-07', '2026-08']) {
      await createBatch(a, { companyId: base.companyId, payPeriod: p });
    }
    const some = await listBatches(a, [base.companyId], ['2026-05', '2026-07']);
    expect(some.map((r) => r.payPeriod).sort()).toEqual(['2026-05', '2026-07']);

    // The dashboard's actual read shape: the twelve periods of a year.
    const year = await listBatches(a, [base.companyId], periodsForYear(2026));
    expect(year).toHaveLength(4);
    // …and a year with nothing in it comes back empty rather than falling back to "everything".
    expect(await listBatches(a, [base.companyId], periodsForYear(2025))).toEqual([]);
  });

  it('an EMPTY period set means NO rows — it must never widen to "all periods"', async () => {
    const a = adminCtx(base);
    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    expect(await listBatches(a, [base.companyId], [])).toEqual([]);
    // The single-string and omitted forms are untouched (the three pre-existing callers pass ≤2 args).
    expect(await listBatches(a, [base.companyId], '')).toHaveLength(1);
    expect(await listBatches(a, [base.companyId])).toHaveLength(1);
    expect(await listBatches(a, [base.companyId], '2026-05')).toHaveLength(1);
  });

  it('listBatches carries the company currency, so Net Pay is never labelled by assumption', async () => {
    const a = adminCtx(base);
    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const [row] = await listBatches(a, [base.companyId], ['2026-05']);
    expect(row).toHaveProperty('currency');
  });

  it('Employees IS the payslip count: employee_count matches the rows generatePayslips wrote', async () => {
    const a = adminCtx(base);
    await hirePayrollReady(a, 'Dash One', '900101011234');
    await hirePayrollReady(a, 'Dash Two', '900202022345');
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    const slips = await owner.db
      .select({ id: schema.payslip.id })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, b.batchId));
    const [row] = await listBatches(a, [base.companyId], ['2026-05']);
    expect(row.employeeCount).toBe(slips.length);
    expect(row.employeeCount).toBe(2);
  });

  it('the processed date comes from the domain event, and a draft run simply has none', async () => {
    const a = adminCtx(base);
    await hirePayrollReady(a, 'Dash Three', '900303033456');
    const done = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const draft = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: done.batchId });

    const dates = await listBatchProcessedDates(a, [done.batchId, draft.batchId]);
    expect(dates.has(draft.batchId), 'a draft run has no processed event and must not get a date').toBe(false);
    expect(dates.get(done.batchId)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Fails closed on an empty id set (no query, no rows).
    expect(await listBatchProcessedDates(a, [])).toEqual(new Map());
  });

  it('THE TIMEZONE: an event at 17:00 UTC on 31 May is dated 1 JUNE, because that is the MYT day', async () => {
    // This is the whole reason the derivation names Asia/Kuala_Lumpur explicitly. 2026-05-31T17:00:00Z
    // is 2026-06-01 01:00 MYT. Reduced in UTC the run is dated 31 May — which on a year-month timeline
    // is not merely the wrong DAY, it is the wrong MONTH, and the reader has no way to see it is wrong.
    const a = adminCtx(base);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await owner.db.insert(schema.domainEvent).values({
      tenantId: base.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: b.batchId,
      eventType: 'payroll-batch.processed',
      actorType: 'user',
      occurredAt: new Date('2026-05-31T17:00:00Z'),
      payload: { count: 0 },
    });
    const dates = await listBatchProcessedDates(a, [b.batchId]);
    expect(dates.get(b.batchId)).toBe('2026-06-01');

    // …and the same instant one hour earlier is still 31 May, so the rule is a timezone shift and not
    // a blanket "+1 day" that would be equally wrong in the other direction.
    await owner.db.delete(schema.domainEvent).where(eq(schema.domainEvent.aggregateId, b.batchId));
    await owner.db.insert(schema.domainEvent).values({
      tenantId: base.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: b.batchId,
      eventType: 'payroll-batch.processed',
      actorType: 'user',
      occurredAt: new Date('2026-05-31T15:00:00Z'),
      payload: { count: 0 },
    });
    expect((await listBatchProcessedDates(a, [b.batchId])).get(b.batchId)).toBe('2026-05-31');
  });

  it('a re-processed run is dated by its LATEST pass, not its first', async () => {
    // A run can be processed, reset back to draft (a03b2d9b) and processed again; each pass appends its
    // own event. The figures on screen are the last pass's, so the date beside them must be too.
    const a = adminCtx(base);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    for (const at of ['2026-05-20T02:00:00Z', '2026-05-27T02:00:00Z']) {
      await owner.db.insert(schema.domainEvent).values({
        tenantId: base.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: b.batchId,
        eventType: 'payroll-batch.processed',
        actorType: 'user',
        occurredAt: new Date(at),
        payload: { count: 0 },
      });
    }
    expect((await listBatchProcessedDates(a, [b.batchId])).get(b.batchId)).toBe('2026-05-27');
  });

  it('only payroll-batch.processed dates a run — no other event on the same aggregate does', async () => {
    const a = adminCtx(base);
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    // createBatch already appended 'payroll-batch.created' on this aggregate. If the derivation keyed on
    // the aggregate alone, every draft run would show a "processed" date it never earned.
    expect((await listBatchProcessedDates(a, [b.batchId])).size).toBe(0);
  });
});
