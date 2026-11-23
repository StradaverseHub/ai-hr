import type { HistoryWorkbookQuery } from '@/core/payroll-transaction-export';
import { employeeLabel } from '@/lib/employee-code';

/**
 * Production 2026-11-23 — the job request behind Transaction View › History "Export to Excel".
 *
 * Both choices used to download straight from a web request (history-export/route.ts). "All processed payroll" reads
 * every processed payslip the caller may see, and in production that passed the 5,000 retained-document ceiling, so
 * every attempt failed with "The download failed". The file is now prepared by the background workbook job, which
 * reads one pay period at a time (core/payroll-view.ts `readProcessedPayslipsForExport`).
 *
 * This module only states what to export and the captions printed on the sheet, exactly as the route did. PURE: the
 * page passes already-translated strings and already scope-guarded selections, and `allowedCompanyIds` comes from the
 * session at the moment the job is queued. Nothing here can widen the export past those companies:
 *   - "All processed payroll" drops the filters and NOTHING ELSE — its companies are `allowedCompanyIds`.
 *   - "This view" keeps the screen's filters; a company outside `allowedCompanyIds` is treated as no selection.
 * The job re-checks the companies and the employee against the database when it is queued and again when it runs.
 */

export type HistoryWorkbookScope = 'current' | 'all';

const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
type Cycle = (typeof CYCLES)[number];

/** The screen's already scope-guarded selections. */
export type HistoryWorkbookView = {
  companyId?: string;
  companyName?: string | null;
  employmentId?: string;
  employee?: { code: string | null; name: string; company: string } | null;
  year?: number;
  month?: number;
  cycle?: string;
  payrollCycleId?: string;
  payrollCycleName?: string | null;
};

/** Already-translated captions. */
export type HistoryWorkbookStrings = {
  title: string;
  exportCurrent: string;
  exportAll: string;
  detailNote: string;
  all: string;
  company: string;
  employee: string;
  year: string;
  month: string;
  cycle: string;
  cycleLabels: Record<Cycle, string>;
  statusLabels: { draft: string; processed: string; closed: string };
};

export function historyWorkbookQuery(
  scope: HistoryWorkbookScope,
  allowedCompanyIds: readonly string[],
  view: HistoryWorkbookView,
  s: HistoryWorkbookStrings,
): HistoryWorkbookQuery {
  const current = scope === 'current';
  const companyId = current && view.companyId && allowedCompanyIds.includes(view.companyId) ? view.companyId : undefined;
  const cycle = current && !view.payrollCycleId && (CYCLES as readonly string[]).includes(view.cycle ?? '')
    ? (view.cycle as Cycle)
    : undefined;
  const employmentId = current ? view.employmentId : undefined;
  const year = current ? view.year : undefined;
  const month = current ? view.month : undefined;
  const payrollCycleId = current ? view.payrollCycleId : undefined;
  const employee = employmentId && view.employee ? view.employee : null;

  const companyName = companyId ? (view.companyName ?? s.all) : s.all;
  const caption = [current ? s.exportCurrent : s.exportAll];
  if (employee) caption.push(`${employeeLabel(employee.code, employee.name)} · ${employee.company}`);
  else if (companyId) caption.push(companyName);

  // The filters the file was taken under, printed ON the sheet. For "All processed payroll" every one reads "All".
  const description = [
    `${s.company}: ${companyName}`,
    `${s.employee}: ${employee ? employeeLabel(employee.code, employee.name) : s.all}`,
    `${s.year}: ${year ?? s.all}`,
    `${s.month}: ${month != null ? String(month).padStart(2, '0') : s.all}`,
    `${s.cycle}: ${payrollCycleId ? (view.payrollCycleName ?? s.all) : cycle ? s.cycleLabels[cycle] : s.all}`,
  ].join('  ·  ');

  const filename = [
    'payroll-transaction-history',
    current ? null : 'all',
    year != null ? String(year) : null,
    month != null ? String(month).padStart(2, '0') : null,
  ].filter(Boolean).join('-');

  return {
    kind: 'history',
    filters: {
      companyIds: companyId ? [companyId] : [...allowedCompanyIds],
      ...(employmentId ? { employmentId } : {}),
      ...(year != null ? { year } : {}),
      ...(month != null ? { month } : {}),
      ...(cycle ? { cycle } : {}),
      ...(payrollCycleId ? { payrollCycleId } : {}),
      exportScope: scope,
      sheet: {
        title: s.title,
        filename,
        filterCaption: caption.join(' — '),
        filterDescription: description,
        detailNote: s.detailNote,
        cycleLabels: s.cycleLabels,
        statusLabels: s.statusLabels,
      },
    },
  };
}
