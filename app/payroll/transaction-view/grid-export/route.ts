/**
 * Feedback 080de5cf — Excel export of Transaction View › History › Grid.
 *
 * "Export exactly what is displayed on screen" is the reporter's wording, so this route does NOT rebuild
 * the report: it re-runs the SAME scope-guarded read, the SAME `pivotHistoryGrid` and the SAME
 * `filterGridRows` the screen ran, with the two switch states carried on the query string. Anything
 * assembled independently here would be free to drift from the grid it claims to reproduce.
 *
 * Read-only, and therefore NO DomainEvent — downloading a report mutates nothing (the same posture as the
 * Employee Balances export next door; the Individual Transaction CSV logs one because it goes through a
 * core service that already did).
 *
 * Scope: `scopedAdmin()` exactly like the page, and every param is re-guarded HERE rather than trusted —
 * an out-of-scope companyId/employmentId is treated as "no selection", so a hand-edited export link can
 * never cross the company fence.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { listProcessedPayslipsAcross } from '@/core/payroll-view';
import { packFor } from '@/localization/registry';
import { toXlsxReport, type ReportData } from '@/lib/report-export';
import { employeeLabel } from '@/lib/employee-code';
import { cleanMonths, filterGridRows, pivotHistoryGrid } from '../history-pivot';

const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;

/** Locale month names, index 0 = January — the same twelve captions the screen's headers use. */
function monthLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2001, i, 1))));
}

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8 `filename*`. Same helper the
 *  statutory-forms export uses — kept identical on purpose rather than shared, because the two routes have
 *  no other reason to import from each other. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request) {
  const { s, scopeIds } = await scopedAdmin();
  const url = new URL(req.url);
  const sp = url.searchParams;

  const rawCompany = sp.get('companyId');
  const companyId = rawCompany && scopeIds.includes(rawCompany) ? rawCompany : undefined;
  const companyIds = companyId ? [companyId] : scopeIds;

  const employees = await listEmployees(s, scopeIds);
  const rawEmployment = sp.get('employmentId');
  const selected = rawEmployment ? employees.find((e) => e.employmentId === rawEmployment) : undefined;

  const rawYear = Number(sp.get('year'));
  const year =
    Number.isInteger(rawYear) && rawYear >= 2000 && rawYear <= 2100 ? rawYear : new Date().getFullYear();
  const months = cleanMonths(sp.getAll('months'));
  const rawCycle = sp.get('cycle');
  const cycle = rawCycle && (CYCLES as readonly string[]).includes(rawCycle) ? rawCycle : undefined;
  const hideZero = sp.get('hideZero') !== '0';
  const hideSystem = sp.get('hideSystem') === '1';

  const locale = await getLocale();
  const t = await getTranslations('payroll.transactions');

  // No employee selected ⇒ the grid on screen is empty, so the file is a header-only sheet rather than a
  // whole-company dump nobody asked for. `toXlsxReport` produces a valid, openable workbook from that.
  const payslips = selected
    ? await listProcessedPayslipsAcross(s, {
        companyIds,
        year,
        employmentId: selected.employmentId,
        cycle,
      })
    : [];
  const hrdfRegisteredCompanyIds = selected
    ? ((await packFor('MY')?.companyStatutory.list(s)) ?? [])
        .filter((r) => r.hrdfStatus !== 'not_registered')
        .map((r) => r.companyId)
    : [];

  const grid = pivotHistoryGrid({ rows: payslips, year, months, hrdfRegisteredCompanyIds });
  const rows = filterGridRows(grid.rows, { hideZero, hideSystem });
  const labels = monthLabels(locale);

  const data: ReportData = {
    filename: `payroll-history-${selected?.employeeCode ?? 'employee'}-${year}`,
    title: t('view.grid.title'),
    // The screen's columns, in the screen's order. `freeze: 3` below reproduces its frozen block as an
    // Excel split pane, which is what makes the file usable for the same reconciliation.
    columns: [
      t('view.grid.colCode'),
      t('view.grid.colDescription'),
      t('view.grid.colCycle'),
      ...grid.months.map((m) => labels[m - 1]),
      t('view.grid.colTotal'),
    ],
    rows: rows.map((r) => [
      r.code,
      // A synthetic row's caption is a dynamic key in this same namespace; an item row carries the name the
      // payslip stored. test/history-pivot.test.ts asserts every synthetic key resolves in en.json, which is
      // the coverage a computed t() key cannot get from the static i18n scan.
      r.labelKey ? r.name || t(`view.grid.row.${r.labelKey}`) : r.name,
      t(`individual.cycle.${r.runType}`),
      // Figures go in UNFORMATTED. `toXlsxReport` marks a cell `x:num` only when it parses as a bare
      // number, and a cell carrying "RM 2,500.00" is text an operator cannot sum — which would defeat the
      // one thing this export exists for.
      ...grid.months.map((m) => (r.notRegistered ? '' : r.months[m - 1].toFixed(2))),
      r.notRegistered ? '' : r.total.toFixed(2),
    ]),
    layout: {
      orientation: 'landscape',
      freeze: 3,
      // The filters the file was taken under, printed on it — the reporter asked that the export "include
      // all filters applied", and a spreadsheet that does not say whose year it is cannot be filed.
      subtitle: selected
        ? `${employeeLabel(selected.employeeCode, selected.name)} · ${selected.company} · ${year}`
        : String(year),
      description: [
        `${t('view.filters.month')}: ${grid.months.map((m) => labels[m - 1]).join(', ')}`,
        `${t('view.filters.cycle')}: ${cycle ? t(`individual.cycle.${cycle}`) : t('view.filters.all')}`,
      ].join('  ·  '),
    },
  };

  const file = toXlsxReport(data);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': file.contentType,
      // The filename carries an operator-controlled employee code. Interpolating it raw into a quoted
      // header lets a double quote or backslash truncate it, and a non-Latin-1 character makes the Response
      // constructor THROW — the download 500s instead of arriving. The statutory export added in this same
      // round already does this properly; two export routes written together must not disagree about it.
      'Content-Disposition': contentDisposition(data.filename, file.ext),
    },
  });
}
