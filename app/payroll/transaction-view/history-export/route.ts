/**
 * Feedback 0fcb2557 — Excel export of Transaction View › History.
 *
 * TWO CHOICES, ONE ROUTE. `?scope=current` reproduces the screen's own filters (company / employee / year
 * / month / payroll cycle); `?scope=all` drops them and takes every processed payslip the caller is
 * allowed to see. Both produce the SAME one wide sheet — see history-export.ts for why it is one sheet and
 * why it carries no grand-total row.
 *
 * NOT CLIPPED TO THE SCREEN'S 200 ROWS. `limit` is deliberately NOT passed to
 * `listProcessedPayslipsAcross`: the param is optional precisely so an export is never truncated (the
 * comment on it says so, and `exportIndividualTxnsCsv` is unclipped for the same reason). The screen's cap
 * exists because History is the tab that OPENS; a file the operator asked for by name has no such excuse,
 * and a silently short spreadsheet is the worst possible failure for a reconciliation.
 *
 * Read-only, and therefore NO DomainEvent — downloading a report mutates nothing (the same posture as the
 * Grid export next door and the Employee Balances export; the Individual Transaction CSV logs one because
 * it goes through a core service that already did).
 *
 * SCOPE: `scopedAdmin()` exactly like the page, and every param is re-guarded HERE rather than trusted —
 * an out-of-scope companyId/employmentId is treated as "no selection", so a hand-edited export link can
 * never cross the company fence. `scope=all` widens to `scopeIds` and NEVER beyond it.
 */
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listProcessedPayslipsAcross } from '@/core/payroll-view';
import { packFor } from '@/localization/registry';
import { toXlsxReport } from '@/lib/report-export';
import { employeeLabel } from '@/lib/employee-code';
import { buildHistoryExport } from '../history-export';

const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;

/** Parse an optional integer query param within [min, max]; anything else ⇒ undefined ("All"). */
function intParam(v: string | null, min: number, max: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8 `filename*`. Same helper the grid
 *  export beside it uses — a raw non-Latin-1 name makes the `Response` constructor THROW and the download
 *  500s instead of arriving, and two export routes on one screen must not disagree about it. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request) {
  const { s, scopeIds } = await scopedAdmin();
  const sp = new URL(req.url).searchParams;
  // Anything that is not the explicit opt-out means "this view": a mangled scope must narrow, never widen.
  const scope = sp.get('scope') === 'all' ? 'all' : 'current';

  const t = await getTranslations('payroll.transactions');
  const tList = await getTranslations('payroll.list');

  const employees = await listEmployees(s, scopeIds);
  const rawCompany = sp.get('companyId');
  const companyId = rawCompany && scopeIds.includes(rawCompany) ? rawCompany : undefined;
  const rawEmployment = sp.get('employmentId');
  const selectedEmployee = rawEmployment ? employees.find((e) => e.employmentId === rawEmployment) : undefined;
  const rawCycle = sp.get('cycle');
  const cycle = rawCycle && (CYCLES as readonly string[]).includes(rawCycle) ? rawCycle : undefined;

  // `scope=all` = "every processed payslip you are allowed to see, ignoring the filters above". It drops
  // the filters and NOTHING ELSE: the company fence is still `scopeIds`, resolved from the session.
  const filters =
    scope === 'all'
      ? { companyIds: scopeIds, companyId: undefined, employmentId: undefined, year: undefined, month: undefined, cycle: undefined }
      : {
          companyIds: companyId ? [companyId] : scopeIds,
          companyId,
          employmentId: selectedEmployee?.employmentId,
          year: intParam(sp.get('year'), 2000, 2100),
          month: intParam(sp.get('month'), 1, 12),
          cycle,
        };

  // NO `limit` — see the header note. Volume is small (tens of payslips today) and the plan took the
  // decision explicitly rather than inheriting the screen's cap.
  const rows = await listProcessedPayslipsAcross(s, {
    companyIds: filters.companyIds,
    year: filters.year,
    month: filters.month,
    employmentId: filters.employmentId,
    cycle: filters.cycle,
  });

  const hrdfRegisteredCompanyIds = ((await packFor('MY')?.companyStatutory.list(s)) ?? [])
    .filter((r) => r.hrdfStatus !== 'not_registered')
    .map((r) => r.companyId);

  // Dynamic lookups resolved HERE so the pure builder stays i18n-free and single-namespace.
  const cycleLabels: Record<string, string> = {
    regular: t('individual.cycle.regular'),
    off_cycle: t('individual.cycle.off_cycle'),
    bonus: t('individual.cycle.bonus'),
    adjustment: t('individual.cycle.adjustment'),
  };
  // The three payroll-batch states a payslip row can carry. Draft is unreachable here (a payslip only
  // exists after generation) but is mapped anyway so a status can never print as a raw enum value.
  const statusLabels: Record<string, string> = {
    draft: tList('status.draft'),
    processed: tList('status.processed'),
    closed: tList('status.closed'),
  };

  const all = t('view.filters.all');
  const companyName =
    filters.companyId ? ((await listCompanies(s)).find((c) => c.id === filters.companyId)?.name ?? all) : all;

  // Which download this is. The filters follow on their own line; this line says whose file it is.
  const scopeLabel = scope === 'all' ? t('view.history.exportAll') : t('view.history.exportCurrent');
  const captionParts = [scopeLabel];
  if (scope === 'current') {
    if (selectedEmployee) {
      captionParts.push(`${employeeLabel(selectedEmployee.employeeCode, selectedEmployee.name)} · ${selectedEmployee.company}`);
    } else if (filters.companyId) {
      captionParts.push(companyName);
    }
  }

  // The filters the file was taken under, printed ON the sheet — a spreadsheet that does not say what it
  // was filtered to cannot be filed. For `scope=all` every one of them reads "All", which is the truth.
  const filterDescription = [
    `${t('view.filters.company')}: ${companyName}`,
    `${t('view.filters.employee')}: ${
      selectedEmployee && scope === 'current'
        ? employeeLabel(selectedEmployee.employeeCode, selectedEmployee.name)
        : all
    }`,
    `${t('view.filters.year')}: ${filters.year ?? all}`,
    `${t('view.filters.month')}: ${filters.month != null ? String(filters.month).padStart(2, '0') : all}`,
    `${t('view.filters.cycle')}: ${filters.cycle ? cycleLabels[filters.cycle] : all}`,
  ].join('  ·  ');

  const filename = [
    'payroll-transaction-history',
    scope === 'all' ? 'all' : null,
    filters.year != null ? String(filters.year) : null,
    filters.month != null ? String(filters.month).padStart(2, '0') : null,
  ]
    .filter(Boolean)
    .join('-');

  const data = buildHistoryExport({
    rows,
    hrdfRegisteredCompanyIds,
    cycleLabels,
    statusLabels,
    title: t('view.history.exportTitle'),
    filename,
    filterCaption: captionParts.join(' — '),
    filterDescription,
    detailNote: t('view.history.exportDetailNote'),
  });

  const file = toXlsxReport(data);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': contentDisposition(data.filename, file.ext),
    },
  });
}
