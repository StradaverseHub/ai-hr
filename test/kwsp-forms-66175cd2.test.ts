/**
 * Board 66175cd2 (plan r1) — EPF (KWSP) statutory forms: the contracts between files, DB-free.
 *
 * Commit 1 — the Open Form step lists only payroll months with processed EPF payroll, for Borang A and BBCD
 * only; every other form keeps the generic Year and Month selects. The query itself is pinned against a real
 * database in test/kwsp-periods-66175cd2.test.ts and the browser behaviour in
 * test/kwsp-period-criterion-66175cd2.dom.test.tsx.
 *
 * Commit 2 — a clear Back at the top left of both forms (viewer behaviour in
 * test/kwsp-viewer-back-66175cd2.dom.test.tsx), and "EPF contributions (KWSP)" off the shelf, its Open Form
 * step and Filing history's forms to produce — while staying registered for everything else that reads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MY_REPORTS } from '../localization/my/reports';
import { STATUTORY_FORM_TYPES } from '../core/payroll-audit/types';
import { PERIODS_ENDPOINT } from '../app/payroll/statutory-forms/criteria';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with block comments, JSX comments and whole-line `//` comments removed. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalog = (l: string) => JSON.parse(read(`messages/${l}.json`));

/** A slice between two markers that REFUSES to be vacuous: both found, and long. */
function slice(src: string, from: string, to: string, minLength: number): string {
  const a = src.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `marker not found after the first: ${to}`).toBeGreaterThanOrEqual(0);
  const out = src.slice(a, b);
  expect(out.length, `the slice ${from} … ${to} is too short to mean anything`).toBeGreaterThan(minLength);
  return out;
}

describe('commit 1 — the period lists', () => {
  it('is declared by Borang A and BBCD only, sharing one read', () => {
    const declaring = MY_REPORTS.filter((r) => typeof r.availablePeriods === 'function').map((r) => r.id).sort();
    expect(declaring).toEqual(['my.borang-a', 'my.borang-bbcd']);
    const [a, bbcd] = ['my.borang-a', 'my.borang-bbcd'].map((id) => MY_REPORTS.find((r) => r.id === id)!);
    expect(a.availablePeriods).toBe(bbcd.availablePeriods);
    // Both are monthly and filed per payroll cycle, so the step has a month and a cycle box to fill.
    for (const r of [a, bbcd]) {
      expect(r.periodKind).toBe('month');
      expect(r.runSelection).toBeTruthy();
    }
  });

  it('reads with one set-based statement over processed or closed runs that carry EPF', () => {
    const src = code('localization/my/epf-periods.ts');
    expect(src).toContain('.selectDistinct({ period: payrollBatch.payPeriod })');
    expect(src).toContain("inArray(payrollBatch.status, ['processed', 'closed'])");
    expect(src).toContain('eq(payrollBatch.companyId, p.companyId)');
    expect(src).toContain('eq(payrollBatch.tenantId, ctx.tenantId)');
    expect(src).toContain("->>'epfEmployee'");
    expect(src).toContain("->>'epfEmployer'");
    expect(src).toContain('.orderBy(desc(payrollBatch.payPeriod))');
    // No loop issues a statement: one query, mapped.
    expect(src).not.toMatch(/for \(|\.forEach\(|Promise\.all\(/);
    expect(src.match(/await tx/g)).toHaveLength(1);
  });

  it('serves the list from a scoped route that reaches the pack only through core/reporting', () => {
    expect(PERIODS_ENDPOINT).toBe('/payroll/statutory-forms/open/periods');
    const route = code('app/payroll/statutory-forms/open/periods/route.ts');
    expect(route).toContain("import { scopedAdmin } from '@/lib/scope';");
    expect(route).toContain("import { reportAvailablePeriods } from '@/core/reporting';");
    expect(route).toContain('reportAvailablePeriods(s, { companyIds: scopeIds, companyId, reportId })');
    expect(route).not.toMatch(/localization\/my|packs\//);
    expect(route).not.toContain('isAdmin');
    expect(route).toContain("'Cache-Control': 'private, no-store'");
    // The seam fails closed on scope before it resolves anything.
    const seam = slice(code('core/reporting.ts'), 'export async function reportAvailablePeriods(', 'export async function reportPreview(', 200);
    expect(seam).toContain('if (p.companyIds.length === 0 || !p.companyIds.includes(p.companyId)) return [];');
    expect(seam.indexOf('return [];')).toBeLessThan(seam.indexOf('resolveDef('));
  });

  it('draws the period list only for a form that declares one, and the generic selects otherwise', () => {
    const open = code('app/payroll/statutory-forms/open/page.tsx');
    expect(open).toContain("const periodsFromPayroll = Boolean(report?.periodsFromPayroll && field('company') && field('year') && field('month'));");
    expect(open).toContain('reportAvailablePeriods(s, { companyIds: scopeIds, companyId: defaultCompany, reportId: report!.id })');
    expect(open).toContain('choosePeriod(initialPeriods, { year: sp.year, month: sp.month })');
    expect(open).toContain("{field('year') && !periodsFromPayroll && (");
    expect(open).toContain("{field('month') && !periodsFromPayroll && (");
    // Every other form keeps the generic year list and the twelve months.
    expect(open).toContain('const years = yearOptions(today, defaultYear);');
    expect(open).toContain('{MONTHS.map((m) => (');
    // With nothing listed, Continue arrives held and the cycle box is hidden.
    expect(open).toContain('disabled={noPeriods}');
    expect(open).toContain('group-data-[periods-empty=true]/criteria:hidden');
    // Still a plain GET form that produces nothing.
    expect(open).toContain('<form method="get" action={parsed.action}');
    expect(open).not.toContain('reportPreview(');
  });

  it('lets neither island re-enable a Continue the other holds', () => {
    const cycles = code('app/payroll/statutory-forms/open/cycles-criterion.tsx');
    const periods = code('app/payroll/statutory-forms/open/period-criterion.tsx');
    expect(cycles).toContain('holdContinue(ref.current?.closest(\'form\'), HOLD_CYCLES, available > 0 && picked === 0);');
    expect(cycles).not.toContain('button.disabled =');
    expect(periods).toContain('holdContinue(form, HOLD_PERIODS, empty || loading);');
    expect(periods).not.toContain('button.disabled =');
  });

  it('has the three new sentences in all six locales, translated', () => {
    for (const l of LOCALES) {
      const ns = catalog(l).payroll.statutoryForms as Record<string, string>;
      for (const k of ['criteria_fromPayroll', 'periods_hint', 'periods_none']) {
        expect(ns[k], `${l} ${k}`).toBeTruthy();
        if (l !== 'en') expect(ns[k], `${l} ${k} is still English`).not.toBe(catalog('en').payroll.statutoryForms[k]);
      }
    }
  });
});

describe('commit 2 — Back, at the top left of Borang A and BBCD', () => {
  it.each(['app/payroll/borang-a/preview/page.tsx', 'app/payroll/borang-bbcd/preview/page.tsx'])(
    '%s: the viewer and the not-ready screen both go back to the step with the same selection',
    (file) => {
      const page = code(file);
      expect(page).toContain('const criteria = { companyId, year, month, runSeqs };');
      expect(page).toContain('const backToCriteria = criteriaReturnHref(');
      const viewer = slice(page, '<StatutoryPdfViewer', 'openInNewTabLabel=', 100);
      expect(viewer).toContain("back={{ href: backToCriteria, label: tf('viewer_back') }}");
      expect(viewer).toContain('backPlacement="leading"');
      expect(page).toContain("<PageHeader title={t('title')} description={subtitle} back={{ href: backToCriteria, label: tf('viewer_back') }} />");
      expect(page).not.toContain("t('viewerBack')");
    },
  );

  it('leaves every other form on the trailing link it had', () => {
    for (const f of [
      'app/payroll/borang-8a/preview/page.tsx',
      'app/payroll/borang-8b/preview/page.tsx',
      'app/payroll/cp39/preview/page.tsx',
      'app/payroll/cp8d/preview/page.tsx',
      'app/payroll/sip-contribution/preview/page.tsx',
    ]) {
      expect(code(f), f).not.toContain('backPlacement');
    }
    expect(code('components/statutory-pdf-viewer.tsx')).toContain("backPlacement = 'trailing',");
  });
});

describe('commit 2 — "EPF contributions (KWSP)" off the screens, not out of the registry', () => {
  const epf = MY_REPORTS.find((r) => r.id === 'my.epf')!;

  it('is the one form off the shelf, and keeps its definition, deadline and audit identity', () => {
    expect(MY_REPORTS.filter((r) => r.shelf === false).map((r) => r.id)).toEqual(['my.epf']);
    expect(epf).toBeTruthy();
    // The submission drives the suspended-tenant statutory override (core/reporting.ts statutoryCtx).
    expect(epf.submission).toEqual({ body: 'epf', agency: 'EPF (KWSP)', channel: 'i-Akaun (Employer)', dueDayOfNextMonth: 15 });
    expect(typeof epf.generate).toBe('function');
    expect(STATUTORY_FORM_TYPES.epf).toContain('my.epf');
    expect(code('core/reporting.ts')).toContain('if (!def.submission) return ctx;');
    expect(code('core/reporting.ts')).toContain('onShelf: r.shelf !== false,');
  });

  it('the shelf, the Open Form step, the figures screen and Filing history all honour it', () => {
    const shelf = code('app/payroll/statutory-forms/page.tsx');
    expect(shelf).toContain('const shelfReports = catalog.reports.filter((r) => r.onShelf);');
    expect(shelf).toContain('const submissions = shelfReports.filter((r) => r.submission != null);');
    expect(shelf).toContain('const catalogSize = shelfReports.length + catalog.links.length + catalog.planned.length;');

    const open = code('app/payroll/statutory-forms/open/page.tsx');
    const guard = slice(open, 'if (report && !report.onShelf) {', 'if (!report && !link) {', 60);
    expect(guard).toContain("redirect(`/payroll/statutory-forms${report.submission ? `?body=${encodeURIComponent(report.submission.body)}` : ''}`);");

    const figures = code('app/payroll/statutory-forms/[formId]/page.tsx');
    expect(figures).toContain('if (!def.onShelf) {');
    expect(figures.indexOf('if (!def.onShelf) {')).toBeLessThan(figures.indexOf('reportPreview(s, {'));

    const history = code('app/payroll/statutory-forms/filing-history/page.tsx');
    expect(history).toContain('const reports = allReports.filter((r) => r.onShelf);');
    expect(history).toContain('const retired = allReports.find((r) => r.id === sp.reportId && !r.onShelf);');
    // Generations already recorded are still listed: the recent list is not filtered by the shelf.
    expect(history).toContain('const recent = companyId ? await recentReports(s, companyId) : [];');
    expect(history.indexOf('if (retired) {')).toBeLessThan(history.indexOf('reportPreview(s, { companyId, reportId, periodKey })'));
  });

  it('keeps the Recent generations and Worksheet links on the shelf page', () => {
    const shelf = code('app/payroll/statutory-forms/page.tsx');
    expect(shelf).toContain('href="/payroll/statutory-forms/filing-history"');
    expect(shelf).toContain('href="/payroll/multi-cycle-worksheet"');
  });
});
