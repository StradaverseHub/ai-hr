import Link from 'next/link';
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listPayComponents } from '@/core/pay-components';
import {
  listFixedTransactionsAcross,
  listIndividualTxnCreators,
  listIndividualTxnsAcross,
  listProcessedPayslipsAcross,
  listUnattachedTxnSummary,
} from '@/core/payroll-view';
import { TXN_KINDS } from '@/core/payroll-individual-txn';
import { Badge, Button, Card, EmployeeName, Field, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { CollapsibleEmployeePanel, EmployeeScopePanel, type ScopeEmployee } from '@/components/collapsible-employee-panel';
import { employeeLabel } from '@/lib/employee-code';
import { packFor } from '@/localization/registry';
import { IndividualTxnTable } from './individual-table';
import { OutstandingTable } from './outstanding-table';
import { HistoryTable } from './history-table';
import { HistoryGrid } from './history-grid';
import { cleanMonths, pivotHistoryGrid } from './history-pivot';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Transaction View (feedback a4a05174; relocated to a top-level Payroll tab by feedback 59178702) —
 * the centralized READ-ONLY payroll transaction inquiry. Now a standalone module tab at
 * /payroll/transaction-view, peer to Payroll Process / Transactions / Reports / Settings; the old
 * /payroll/transactions/view path redirects here. Three tabs on one page (?tab= switch, single-pager
 * convention): Fixed (recurring items across every employee, incl. "by pay item → all employees
 * assigned"), Individual (dated one-offs across ALL batches by year/month/employee/company — the
 * keying screen is draft-batch-only), History (processed payslip results by
 * year/month/employee/company/cycle).
 *
 * STRICTLY read-only by design: no server actions, no create/edit/stop/archive controls — the
 * keying screens (fixed/, individual/, tp1/, zakat/) remain the only write surfaces. Filters are
 * plain GET forms, so the whole page stays a server component.
 *
 * i18n note: strings deliberately stay under the `payroll.transactions.view.*` namespace (and reuse
 * `payroll.list` / `payroll.batch` sibling column labels) — the page shares those keys with the
 * keying screens, so the namespace is NOT moved despite the route relocation.
 */

// 'outstanding' (feedback d0d2c9d1) is a 4th SUB-TAB, deliberately not a new top-level nav entry:
// test/payroll-flyout-nav.test.ts pins the six payroll destinations character for character and
// asserts no entry is invented, and a new one would also need packs/payroll/index.ts +
// lib/permissions.ts. A sub-tab needs none of that and inherits this route's scopedAdmin() fence.
// 080de5cf — 'grid' is a 5th SUB-TAB for the same reason 'outstanding' is a 4th: it is a second VIEW of
// the History data (item down the left, month across the top), not a new destination. A sub-tab needs no
// nav entry, no packs/payroll/index.ts change and no lib/permissions.ts column, and it inherits this
// route's scopedAdmin() fence — whereas a new route would need all three and would let the two views of
// one dataset drift apart.
const TABS = ['fixed', 'individual', 'history', 'grid', 'outstanding'] as const;

/**
 * 862ed0ad — the most recent N processed payslips the History tab will render.
 *
 * The History read was unbounded: every payslip in scope for all time, each carrying its whole
 * `statutory` jsonb blob, each rendering an expandable breakdown. Making that the tab that OPENS would
 * have meant every visit to Transaction View paid for the entire payroll history, which is precisely
 * why the approved plan made bounding a PRECONDITION of the default-tab change.
 *
 * A cap rather than a pager, deliberately: the rows are ordered newest-period-first, so the cap keeps
 * what someone opening the screen came to check, and the filters above the table (year / month /
 * employee / cycle) are the existing, already-built way to reach anything older. Note the carried debt
 * the plan called out — r75's paginateRows still fetches everything then slices on about ten tables, so
 * routing this through it would not have bounded the QUERY, only the render. A LIMIT does.
 *
 * The page asks for CAP + 1 and says so on screen when the extra row comes back: a truncation the
 * operator cannot see would be a worse failure than the slow page it replaces.
 */
const HISTORY_ROW_CAP = 200;

/** 080de5cf — one cookie per screen, the convention f3ae3245 set for Fixed Transaction. */
const GRID_PANEL_COOKIE = 'txnview_grid_panel';

type Tab = (typeof TABS)[number];
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
const TXN_STATUSES = ['unattached', 'draft', 'processed', 'closed'] as const; // 'unattached' = no run yet (f1564110 Phase 2)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an optional positive-int query param within [min, max]; anything else ⇒ undefined. */
function intParam(v: string | undefined, min: number, max: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export default async function TransactionViewPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    companyId?: string;
    employmentId?: string;
    componentId?: string;
    status?: string;
    year?: string;
    month?: string;
    /** 080de5cf (Grid tab only) — repeated params from the month checkboxes, or one comma-joined value
     *  when the employee panel carries the selection across a switch. `cleanMonths` accepts both. */
    months?: string | string[];
    cycle?: string;
    // Individual-tab History filters (feedback 7b2d4228)
    kind?: string;
    departmentId?: string;
    txnStatus?: string;
    createdBy?: string;
    createdFrom?: string;
    createdTo?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const tList = await getTranslations('payroll.list');
  const sp = await searchParams;

  // 862ed0ad — History is the tab that OPENS. The reporter's point is that Transaction View is where you
  // check a payroll after it has been calculated, so landing on the recurring-items list meant the first
  // thing you saw was not the thing you came for. Every ?tab= value still resolves exactly as before, so
  // saved links keep working; only the no-tab default moves.
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : 'history';

  const [employees, companies, components, creators] = await Promise.all([
    listEmployees(s, scopeIds),
    listCompanies(s),
    tab === 'fixed' ? listPayComponents(s) : Promise.resolve([]),
    tab === 'individual' ? listIndividualTxnCreators(s, { companyIds: scopeIds }) : Promise.resolve([]),
  ]);
  // Department options for the Individual History filter — distinct current-assignment departments in scope.
  const departmentOptions = (() => {
    const seen = new Map<string, string>();
    for (const e of employees) if (e.departmentId && e.department) seen.set(e.departmentId, e.department);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  })();
  // Narrow the company dropdown to the authorised scope — the filter can only narrow, never widen.
  const scopedCompanies = companies.filter((c) => scopeIds.includes(c.id));

  // SCOPE-GUARD every ?param (mirror fixed/page.tsx): an out-of-scope companyId/employmentId is
  // treated as "no selection", so URL tampering cannot cross the company fence.
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : undefined;
  const companyIds = companyId ? [companyId] : scopeIds;
  const employmentId =
    sp.employmentId && employees.some((e) => e.employmentId === sp.employmentId) ? sp.employmentId : undefined;
  const componentId =
    sp.componentId && components.some((c) => c.id === sp.componentId) ? sp.componentId : undefined;
  const status = sp.status === 'active' || sp.status === 'ended' ? sp.status : undefined;
  const year = intParam(sp.year, 2000, 2100);
  const month = intParam(sp.month, 1, 12);
  const cycle = CYCLES.includes(sp.cycle as (typeof CYCLES)[number]) ? sp.cycle : undefined;

  // 080de5cf (Grid tab) — the grid is twelve columns of ONE calendar year, so unlike the other tabs its
  // year is never "all": an absent/tampered ?year= falls back to this year rather than to an unbounded
  // read across every year the employee has ever been paid.
  const gridYear = year ?? new Date().getFullYear();
  const gridMonths = cleanMonths(sp.months);

  // Individual-tab History filters — each scope-guarded / whitelist-coerced (a tampered value ⇒ ignored).
  const kind = TXN_KINDS.includes(sp.kind as (typeof TXN_KINDS)[number]) ? sp.kind : undefined;
  const departmentId =
    sp.departmentId && departmentOptions.some((d) => d.id === sp.departmentId) ? sp.departmentId : undefined;
  const txnStatus = TXN_STATUSES.includes(sp.txnStatus as (typeof TXN_STATUSES)[number]) ? sp.txnStatus : undefined;
  const createdBy = sp.createdBy && creators.some((c) => c.id === sp.createdBy) ? sp.createdBy : undefined;
  const createdFrom = sp.createdFrom && ISO_DATE.test(sp.createdFrom) ? sp.createdFrom : undefined;
  const createdTo = sp.createdTo && ISO_DATE.test(sp.createdTo) ? sp.createdTo : undefined;

  // Only the active tab's query runs — the others stay empty (single round-trip per view).
  const [fixedRows, individualRows, historyRows, gridPayslips, outstandingRows] = await Promise.all([
    tab === 'fixed'
      ? listFixedTransactionsAcross(s, { companyIds, employmentId, componentId, status })
      : Promise.resolve([]),
    tab === 'individual'
      ? listIndividualTxnsAcross(s, {
          companyIds,
          year,
          month,
          employmentId,
          kind,
          departmentId,
          batchStatus: txnStatus,
          createdBy,
          createdFrom,
          createdTo,
        })
      : Promise.resolve([]),
    // 862ed0ad — bounded, because History is now the landing tab. One row more than we mean to show, so
    // truncation can be STATED rather than silently applied. See HISTORY_ROW_CAP.
    tab === 'history'
      ? listProcessedPayslipsAcross(s, { companyIds, year, month, employmentId, cycle, limit: HISTORY_ROW_CAP + 1 })
      : Promise.resolve([]),
    // 080de5cf — the Grid pivot's source. NO row cap and none needed: one employee × one calendar year is
    // twelve months of runs. It reads nothing until an employee is chosen, which is also what makes the
    // absence of a cap safe — an unscoped variant of this query would be the whole payroll history.
    tab === 'grid' && employmentId
      ? listProcessedPayslipsAcross(s, { companyIds, year: gridYear, employmentId, cycle })
      : Promise.resolve([]),
    // d0d2c9d1 — money entered but never paid, grouped and totalled. Same scope-guarded filters as the
    // other tabs; deliberately NO default run-state filter (see the read's doc comment).
    tab === 'outstanding'
      ? listUnattachedTxnSummary(s, { companyIds, year, month, employmentId })
      : Promise.resolve([]),
  ]);

  // Feedback efece4ce — which companies are actually registered for the HRD Corp levy. The breakdown used
  // to drop its HRDF line whenever the amount was 0, so a company that legitimately pays nothing (no HRDF
  // Contribution Rate set) looked exactly like a levy that failed to compute. Read once per render for the
  // History tab only; `packFor('MY')` follows the Organization page — the levy is Malaysia-specific.
  const hrdfRegisteredCompanyIds =
    tab === 'history' || tab === 'grid'
      ? ((await packFor('MY')?.companyStatutory.list(s)) ?? [])
          .filter((r) => r.hrdfStatus !== 'not_registered')
          .map((r) => r.companyId)
      : [];

  // 862ed0ad — the CAP + 1 row, if it came back, is the proof there is more; it is dropped from the render
  // and reported instead.
  const historyTruncated = historyRows.length > HISTORY_ROW_CAP;
  const shownHistoryRows = historyTruncated ? historyRows.slice(0, HISTORY_ROW_CAP) : historyRows;

  // ── 080de5cf — the Grid tab's pivot + the plain data its client component needs ──
  // The fold happens on the SERVER: the browser gets finished rows, so the two switches over them cost no
  // round-trip. Everything crossing to the client is plain data — a function prop from a server component
  // to a client one returns a 500 on every request while tsc, the suite and `next build` all stay green.
  const grid =
    tab === 'grid'
      ? pivotHistoryGrid({
          rows: gridPayslips,
          year: gridYear,
          months: gridMonths,
          hrdfRegisteredCompanyIds,
        })
      : null;
  const locale = await getLocale();
  // Month captions resolved HERE, not in the browser: Node and the browser can carry different ICU data,
  // and a header formatted on both sides is a hydration mismatch waiting for a locale that differs.
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const monthLabels = Array.from({ length: 12 }, (_, i) => monthFmt.format(new Date(Date.UTC(2001, i, 1))));
  // Dynamic lookups resolved by this page so the grid component stays single-namespace for i18n check C.
  const cycleLabels: Record<string, string> = {
    regular: t('individual.cycle.regular'),
    off_cycle: t('individual.cycle.off_cycle'),
    bonus: t('individual.cycle.bonus'),
    adjustment: t('individual.cycle.adjustment'),
  };
  // The searchable employee panel every keying screen already uses (r168a) — the reporter asked for "the
  // same searchable employee selector as the Fixed and Individual Transaction modules", and this is it.
  const panelEmployees: ScopeEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    company: e.company,
    companyId: e.companyId,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));
  // Resolved on the SERVER from the cookie so first paint is already correct; absent ⇒ expanded.
  const gridPanelDefaultOpen = (await cookies()).get(GRID_PANEL_COOKIE)?.value !== '0';
  // The panel carries the grid's own filters across an employee switch. `months` rides as ONE comma-joined
  // value because `preserve` is a flat string map — `cleanMonths` accepts that form as well as the
  // checkboxes' repeated params, so both routes into this screen mean the same thing.
  const gridPanelPreserve: Record<string, string> = {
    tab: 'grid',
    year: String(gridYear),
    months: gridMonths.join(','),
    ...(cycle ? { cycle } : {}),
    ...(companyId ? { companyId } : {}),
  };
  const gridExportParams: Record<string, string> = {
    ...(companyId ? { companyId } : {}),
    ...(employmentId ? { employmentId } : {}),
    year: String(gridYear),
    months: gridMonths.join(','),
    ...(cycle ? { cycle } : {}),
  };
  const selectedGridEmployee = employees.find((e) => e.employmentId === employmentId);

  // 0fcb2557 — the History tab's Export to Excel. The already scope-guarded filters ride on the "this
  // view" link; the route re-guards every one of them anyway, so a hand-edited link can never widen the
  // download past the caller's own companies.
  const historyExportParams: Record<string, string> = {
    ...(companyId ? { companyId } : {}),
    ...(employmentId ? { employmentId } : {}),
    ...(year != null ? { year: String(year) } : {}),
    ...(month != null ? { month: String(month) } : {}),
    ...(cycle ? { cycle } : {}),
  };
  const historyExportChoices: { scope: 'current' | 'all'; label: string; hint: string }[] = [
    { scope: 'current', label: t('view.history.exportCurrent'), hint: t('view.history.exportCurrentHint') },
    { scope: 'all', label: t('view.history.exportAll'), hint: t('view.history.exportAllHint') },
  ];

  const today = todayInKualaLumpur();
  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => nowYear + 1 - i);

  const companySelect = (
    <Field label={t('view.filters.company')}>
      <select name="companyId" defaultValue={companyId ?? ''} className={inputCls}>
        <option value="">{t('view.filters.all')}</option>
        {scopedCompanies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </Field>
  );
  const employeeSelect = (
    <Field label={t('view.filters.employee')}>
      <select name="employmentId" defaultValue={employmentId ?? ''} className={inputCls}>
        <option value="">{t('view.filters.all')}</option>
        {employees.map((e) => (
          <option key={e.employmentId} value={e.employmentId}>
            {/* Employee ID left-of-name (feedback 38668d9b) */}
            {employeeLabel(e.employeeCode, e.name)} · {e.company}
          </option>
        ))}
      </select>
    </Field>
  );
  const yearMonthSelects = (
    <>
      <Field label={t('view.filters.year')}>
        <select name="year" defaultValue={year != null ? String(year) : ''} className={inputCls}>
          <option value="">{t('view.filters.all')}</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('view.filters.month')}>
        <select name="month" defaultValue={month != null ? String(month).padStart(2, '0') : ''} className={inputCls}>
          <option value="">{t('view.filters.all')}</option>
          {MONTHS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
    </>
  );

  return (
    // 080de5cf — the Grid tab is twelve month columns plus a frozen block, and the reporter's whole point
    // is that the screen "does not fully utilise the available screen width". So that ONE tab drops the
    // 6xl reading measure; every other tab keeps it, because a 6-column table stretched across a 32-inch
    // monitor is worse, not better.
    <div className={tab === 'grid' ? pageWideCls : 'mx-auto max-w-6xl space-y-6'}>
      <PageHeader title={t('view.title')} description={t('view.subtitle')} />

      {/* Sub-tab strip (Fixed | Individual | History | Grid | Outstanding). Switching tabs resets the filters
          on purpose — each view has its own filter set. */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((k) => (
          <Link
            key={k}
            href={`/payroll/transaction-view?tab=${k}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === k
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`view.tabs.${k}`)}
          </Link>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t('view.readOnly')}</p>

      {/* ── Filters (GET form — pure navigation, no mutation) ──
          The Grid tab is excluded: its employee comes from the shared searchable panel rather than a
          dropdown, and its own year / months / cycle row lives inside the panel's workspace. Rendering
          both would put two employee controls that disagree on one screen. */}
      {tab !== 'grid' && (
      <Card className="p-4">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="tab" value={tab} />
          {companySelect}
          {employeeSelect}
          {tab === 'fixed' && (
            <>
              <Field label={t('view.filters.payItem')}>
                <select name="componentId" defaultValue={componentId ?? ''} className={inputCls}>
                  <option value="">{t('view.filters.all')}</option>
                  {components.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('view.filters.status')}>
                <select name="status" defaultValue={status ?? ''} className={inputCls}>
                  <option value="">{t('view.filters.all')}</option>
                  <option value="active">{t('fixed.statusActive')}</option>
                  <option value="ended">{t('fixed.statusEnded')}</option>
                </select>
              </Field>
            </>
          )}
          {tab !== 'fixed' && yearMonthSelects}
          {tab === 'individual' && (
            <>
              <Field label={t('view.filters.payItem')}>
                <select name="kind" defaultValue={kind ?? ''} className={inputCls}>
                  <option value="">{t('view.filters.all')}</option>
                  {TXN_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`individual.kindLabel.${k}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('view.filters.department')}>
                <select name="departmentId" defaultValue={departmentId ?? ''} className={inputCls}>
                  <option value="">{t('view.filters.all')}</option>
                  {departmentOptions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('view.filters.txnStatus')}>
                <select name="txnStatus" defaultValue={txnStatus ?? ''} className={inputCls}>
                  <option value="">{t('view.filters.all')}</option>
                  {TXN_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {tList(`status.${st}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('view.filters.createdBy')}>
                <select name="createdBy" defaultValue={createdBy ?? ''} className={inputCls}>
                  <option value="">{t('view.filters.all')}</option>
                  {creators.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('view.filters.createdFrom')}>
                <input type="date" name="createdFrom" defaultValue={createdFrom ?? ''} className={inputCls} />
              </Field>
              <Field label={t('view.filters.createdTo')}>
                <input type="date" name="createdTo" defaultValue={createdTo ?? ''} className={inputCls} />
              </Field>
            </>
          )}
          {tab === 'history' && (
            <Field label={t('view.filters.cycle')}>
              <select name="cycle" defaultValue={cycle ?? ''} className={inputCls}>
                <option value="">{t('view.filters.all')}</option>
                {CYCLES.map((c) => (
                  <option key={c} value={c}>
                    {t(`individual.cycle.${c}`)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button type="submit" variant="secondary">
            {t('view.filters.apply')}
          </Button>
        </form>
      </Card>
      )}

      {/* ── 1. Fixed Transaction View ── */}
      {tab === 'fixed' && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('view.tabs.fixed')} count={fixedRows.length} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('fixed.colEmployee')}</th>
                  <th className="px-4 py-2 font-medium">{t('fixed.colCompany')}</th>
                  <th className="px-4 py-2 font-medium">{t('fixed.payrollItem')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('fixed.amount')}</th>
                  <th className="px-4 py-2 font-medium">{t('fixed.payrollCycle')}</th>
                  <th className="px-4 py-2 font-medium">{t('fixed.startDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('fixed.endDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('fixed.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fixedRows.map((r) => {
                  const ended = r.validTo != null && r.validTo < today;
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-medium">
                        {/* Employee ID left-of-name (feedback 38668d9b) */}
                        <EmployeeName code={r.employeeCode} name={r.employeeName} />
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.company}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs">{r.code}</span>{' '}
                        <span className="text-muted-foreground">{r.name}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{Number(r.amount).toFixed(2)}</td>
                      <td className="px-4 py-2.5">
                        {r.runType ? t(`individual.cycle.${r.runType}`) : t('fixed.cycleUnspecified')}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{r.validFrom}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.validTo ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={ended ? 'default' : 'success'}>
                          {ended ? t('fixed.statusEnded') : t('fixed.statusActive')}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
                {fixedRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                      {t('view.fixed.empty')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── 2. Individual Transaction View (all batches, any status) ── */}
      {tab === 'individual' && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 pr-4">
            <SectionHeader title={t('view.tabs.individual')} count={individualRows.length} />
            {/* CSV export honouring the current (scope-guarded) filters — opens in Excel. */}
            <a
              href={`/payroll/transaction-view/export?${new URLSearchParams({
                ...(companyId ? { companyId } : {}),
                ...(employmentId ? { employmentId } : {}),
                ...(year != null ? { year: String(year) } : {}),
                ...(month != null ? { month: String(month) } : {}),
                ...(kind ? { kind } : {}),
                ...(departmentId ? { departmentId } : {}),
                ...(txnStatus ? { txnStatus } : {}),
                ...(createdBy ? { createdBy } : {}),
                ...(createdFrom ? { createdFrom } : {}),
                ...(createdTo ? { createdTo } : {}),
              }).toString()}`}
              className="inline-flex shrink-0 items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              {t('view.exportCsv')}
            </a>
          </div>
          {/* Sortable + searchable grid (feedback 7b2d4228): GET filters above narrow the set; this client table
              adds column sorting over the fetched rows. */}
          <IndividualTxnTable rows={individualRows} />
        </Card>
      )}

      {/* ── 3. Transaction History (processed payslip results) ──
          Each summary row expands to the itemized payslip breakdown (feedback 5f8d8395). The client table
          receives the already-fetched, scope-guarded rows (full statutory blob + aggregates) and renders the
          detail inline with no extra round-trip. */}
      {tab === 'history' && (
        // 0fcb2557 — the clip moved OFF the Card and onto the table below. The Card was `overflow-hidden`
        // purely to round the table's bottom corners; an absolutely-positioned dropdown inside it would be
        // clipped by that same rule, and on an empty result set (short card) the second choice would have
        // been cut off — a control that works only when there is data is worse than no control.
        <Card>
          {/* The header row mirrors the Individual tab's (SectionHeader + a download on the right),
              because "in the same place the Individual tab already keeps its download" is what the
              reporter approved. The control is a <details> disclosure rather than a client dropdown so the
              whole page stays a server component: two plain anchors, no state, no server action. */}
          <div className="flex items-center justify-between gap-3 pr-4">
            <SectionHeader title={t('view.tabs.history')} count={shownHistoryRows.length} />
            <details className="relative shrink-0">
              <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
                {t('view.history.export')}
                <span aria-hidden="true" className="text-[10px]">
                  ▼
                </span>
              </summary>
              {/* Opens down and to the LEFT (end-0), so a wide panel never pushes the page sideways. */}
              <div className="absolute end-0 top-full z-20 mt-1 w-80 rounded-md border border-border bg-background p-1 shadow-lg">
                {historyExportChoices.map((choice) => (
                  <a
                    key={choice.scope}
                    href={`/payroll/transaction-view/history-export?${new URLSearchParams(
                      // "All processed payroll" carries NO filters — the link says what the file is, so a
                      // saved or shared one cannot quietly turn back into a filtered download.
                      choice.scope === 'all' ? { scope: 'all' } : { ...historyExportParams, scope: 'current' },
                    ).toString()}`}
                    className="block rounded px-3 py-2 transition-colors hover:bg-muted"
                  >
                    <span className="block text-sm font-medium text-foreground">{choice.label}</span>
                    <span className="block text-xs text-muted-foreground">{choice.hint}</span>
                  </a>
                ))}
              </div>
            </details>
          </div>
          {historyTruncated && (
            <p className="px-4 pb-2 text-xs text-amber-700 dark:text-amber-400">
              {t('view.history.capped', { cap: HISTORY_ROW_CAP })}
            </p>
          )}
          {/* The rounding the Card used to do for the whole box, applied to the table alone — matching
              Card's own `rounded-[1.25rem]` so the bottom corners look exactly as they did. */}
          <div className="overflow-hidden rounded-b-[1.25rem]">
            <HistoryTable rows={shownHistoryRows} hrdfRegisteredCompanyIds={hrdfRegisteredCompanyIds} />
          </div>
        </Card>
      )}

      {/* ── 4. Transaction History GRID (feedback 080de5cf) ──
          The same processed payslips as the tab beside it, turned on their side: pay item down the left,
          month across the top, annual total on the right — the shape the reporter reconciles in. The
          payslip-by-payslip view is NOT replaced; it answers a different question. */}
      {tab === 'grid' && (
        <CollapsibleEmployeePanel
          defaultOpen={gridPanelDefaultOpen}
          cookieKey={GRID_PANEL_COOKIE}
          panel={
            <Card className="p-4">
              <h2 className="text-sm font-semibold">{t('view.grid.pickEmployee')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('view.grid.pickEmployeeHint')}</p>
              <div className="mt-3">
                <EmployeeScopePanel
                  employees={panelEmployees}
                  selectedId={employmentId ?? null}
                  basePath="/payroll/transaction-view"
                  preserve={gridPanelPreserve}
                />
              </div>
            </Card>
          }
        >
          <div className="space-y-4">
            {/* Year / months / cycle — a plain GET form, so the whole screen stays a server component and
                the address bar is the state. `tab` and `employmentId` ride as hidden fields: a submit must
                not silently drop the employee the panel chose. */}
            <Card className="p-4">
              <form method="GET" className="flex flex-wrap items-end gap-4">
                <input type="hidden" name="tab" value="grid" />
                {employmentId && <input type="hidden" name="employmentId" value={employmentId} />}
                {companyId && <input type="hidden" name="companyId" value={companyId} />}
                <Field label={t('view.filters.year')}>
                  <select name="year" defaultValue={String(gridYear)} className={inputCls}>
                    {years.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </Field>
                <fieldset className="min-w-0">
                  <legend className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('view.filters.months')}
                  </legend>
                  {/* Twelve checkboxes rather than a native multi-select: they post the same repeated
                      `months` params without ctrl-clicking, and every choice is visible at a glance —
                      which is the point of a filter you change on every reconciliation. */}
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {MONTHS.map((m, i) => (
                      <label key={m} className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          name="months"
                          value={String(i + 1)}
                          defaultChecked={gridMonths.includes(i + 1)}
                          className="h-4 w-4 rounded border-border"
                        />
                        {monthLabels[i]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label={t('view.filters.cycle')}>
                  <select name="cycle" defaultValue={cycle ?? ''} className={inputCls}>
                    <option value="">{t('view.filters.all')}</option>
                    {CYCLES.map((c) => (
                      <option key={c} value={c}>
                        {t(`individual.cycle.${c}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit" variant="secondary">
                  {t('view.filters.apply')}
                </Button>
              </form>
            </Card>

            <Card className="p-4">
              {selectedGridEmployee ? (
                <>
                  <div className="mb-3 flex flex-wrap items-baseline gap-2">
                    {/* Employee ID left-of-name (feedback 38668d9b) */}
                    <EmployeeName
                      code={selectedGridEmployee.employeeCode}
                      name={selectedGridEmployee.name}
                      className="text-sm font-semibold text-foreground"
                    />
                    <span className="text-xs text-muted-foreground">
                      {selectedGridEmployee.company} · {gridYear}
                    </span>
                  </div>
                  <HistoryGrid
                    rows={grid?.rows ?? []}
                    months={grid?.months ?? gridMonths}
                    monthLabels={monthLabels}
                    cycleLabels={cycleLabels}
                    exportParams={gridExportParams}
                    payslipCount={grid?.payslipCount ?? 0}
                    detailNotRecorded={grid?.detailNotRecorded ?? false}
                  />
                </>
              ) : (
                // No employee, no grid — and said in words rather than shown as an empty table, because the
                // grid is one person's year by definition and a blank one reads as "no data" instead of
                // "choose someone".
                <p className="py-8 text-center text-sm text-muted-foreground">{t('view.grid.noEmployee')}</p>
              )}
            </Card>
          </div>
        </CollapsibleEmployeePanel>
      )}

      {/* ── 5. Outstanding transactions (feedback d0d2c9d1) ──
          Money entered against an employee and a month that has never reached a payslip. The rows were
          always listable on the Individual tab (?txnStatus=unattached); what was missing — and what let
          RM23,170 accumulate unnoticed — is the per-employee/per-month grouping and the grand total. */}
      {tab === 'outstanding' && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('view.tabs.outstanding')} count={outstandingRows.length} />
          <p className="px-4 pb-2 text-xs text-muted-foreground">{t('view.outstanding.hint')}</p>
          <OutstandingTable rows={outstandingRows} />
        </Card>
      )}
    </div>
  );
}
