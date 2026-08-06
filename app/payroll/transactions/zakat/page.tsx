import Link from 'next/link';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { employeeDetail, listCompanies, listEmployees } from '@/core/read';
import { listZakatElections, listZakatTxnsAcross } from '@/core/payroll-view';
import { getStatutoryProfileMY } from '@/localization/my/statutory';
import { MY_STATES } from '@/localization/my/holidays';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { saveZakatElectionAction } from './election-actions';
import { isModuleEnabledOrFalse } from '@/core/entitlements';

/**
 * Zakat screen (feedback 58755260; simplified by feedback d435673e) — the single home for zakat.
 *
 *  A. ELECTION (durable, per-employee) — relocated from Personnel > Statutory (MY). Employee-first flow:
 *     pick an employee (?employmentId=), see their basic info, edit state/method/rate/effective dates.
 *     Saves via saveZakatElectionAction → the existing setStatutoryProfileMY (validation + event intact).
 *     The payroll kernel reads this election on every regular run (fixed auto-applied; percent derived
 *     live from the month's pre-offset MTD).
 *
 *  B. TRANSACTION HISTORY (read-only, feedback d435673e) — two lists below the editor: "Saved elections"
 *     (every employee with a saved election) and "Applied in payroll" (the zakat actually deducted in each
 *     processed run, filterable by year/month/employee/company/cycle/status, with a CSV export). Both are pure
 *     reads (listZakatElections / listZakatTxnsAcross); the CSV route appends the egress event.
 *
 * The old "one-off override (per payroll run)" section was REMOVED by d435673e — the Zakat screen no longer
 * writes payroll_input.zakat; that manual tier survives ONLY on the batch input grid / prefill / import (see
 * the kernel precedence note in core/payroll.ts). The history filter params are h*-prefixed so they never
 * collide with the election picker's ?employmentId; each form carries the other's selection as a hidden input.
 *
 * i18n note: the statutory EA Part-D line "Zakat via salary deduction" (payroll.ea.zakatViaSalary) is LHDN
 * form wording and is deliberately NOT renamed to plain "Zakat" — it is not a UI label.
 *
 * r168a (feedback 6a1f2bd6) REPLACED THE EMPLOYEE CONTROL AND NOTHING ELSE. The plain dropdown + "Employee"
 * submit button became the shared searchable side panel (search by employee ID or name, filtered by
 * Company / Business Unit / Department / Employee Status), collapsible so the history tables can use the
 * full width. Not the rates, not the effective dates, not how a deduction reaches payroll, and not one
 * figure in either history list. The SCOPE GUARD below is untouched: selection still arrives as
 * `?employmentId=` and is still resolved against the server's own employee set before anything is read.
 */

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
// A payslip row only exists post-generation, so 'draft' is impossible in this history by construction.
const STATUSES = ['processed', 'closed'] as const;

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One cookie per screen — each collapses independently (the convention f3ae3245 set for Fixed). */
export const ZAKAT_PANEL_COOKIE = 'txn_zakat_panel';

/** Parse an optional positive-int query param within [min, max]; anything else ⇒ undefined. */
function intParam(v: string | undefined, min: number, max: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export default async function ZakatTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{
    employmentId?: string;
    error?: string;
    toast?: string;
    // "Applied in payroll" history filters — h*-prefixed so they never collide with the election picker.
    hCompanyId?: string;
    hEmploymentId?: string;
    hYear?: string;
    hMonth?: string;
    hCycle?: string;
    hStatus?: string;
    // Two independently paged lists sit below the editor, so each carries its own page/size pair.
    ePage?: string;
    eSize?: string;
    hPage?: string;
    hSize?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const tList = await getTranslations('payroll.list');
  const sp = await searchParams;
  const { employmentId, error } = sp;
  const typedComponentsOn = isModuleEnabledOrFalse(s, 'typed_pay_components');

  // ── Section A data — employee election ─────────────────────────────────────
  const [allEmployees, companies] = await Promise.all([listEmployees(s, scopeIds), listCompanies(s)]);
  const employees = allEmployees.filter((e) => !e.terminatedOn);
  const selectedEmploymentId =
    employmentId && employees.some((e) => e.employmentId === employmentId) ? employmentId : null;
  const emp = selectedEmploymentId ? await employeeDetail(s, selectedEmploymentId) : null;
  const statutory = emp ? await getStatutoryProfileMY(s, emp.personId) : null;

  // Resolved on the SERVER from the cookie so first paint is already correct; absent ⇒ expanded.
  const panelDefaultOpen = (await cookies()).get(ZAKAT_PANEL_COOKIE)?.value !== '0';
  // The panel is fed EXACTLY the set the guard above accepts (`employees`, i.e. non-terminated), so it can
  // never offer a row the server would then refuse. Feeding it `allEmployees` would render terminated
  // people as clickable and silently drop the selection — a dead click is worse than an absent one.
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

  // ── Section B data — transaction history (read-only) ───────────────────────
  const scopedCompanies = companies.filter((c) => scopeIds.includes(c.id));
  // Scope-guard every history ?param (mirror transaction-view/page.tsx): an out-of-scope value ⇒ ignored.
  const hCompanyId = sp.hCompanyId && scopeIds.includes(sp.hCompanyId) ? sp.hCompanyId : undefined;
  const historyCompanyIds = hCompanyId ? [hCompanyId] : scopeIds;
  const hEmploymentId =
    sp.hEmploymentId && allEmployees.some((e) => e.employmentId === sp.hEmploymentId) ? sp.hEmploymentId : undefined;
  const hYear = intParam(sp.hYear, 2000, 2100);
  const hMonth = intParam(sp.hMonth, 1, 12);
  const hCycle = CYCLES.includes(sp.hCycle as (typeof CYCLES)[number]) ? sp.hCycle : undefined;
  const hStatus = STATUSES.includes(sp.hStatus as (typeof STATUSES)[number]) ? sp.hStatus : undefined;

  const [elections, appliedRows] = await Promise.all([
    listZakatElections(s, { companyIds: scopeIds }),
    listZakatTxnsAcross(s, {
      companyIds: historyCompanyIds,
      year: hYear,
      month: hMonth,
      employmentId: hEmploymentId,
      cycle: hCycle,
      status: hStatus,
    }),
  ]);

  // fc776376 — both read-only history lists grow with headcount and with every processed run.
  const electionPage = paginateRows(elections, parsePageQuery({ page: sp.ePage, size: sp.eSize }));
  const appliedPage = paginateRows(appliedRows, parsePageQuery({ page: sp.hPage, size: sp.hSize }));
  const historyParams = {
    employmentId: sp.employmentId,
    hCompanyId: sp.hCompanyId,
    hEmploymentId: sp.hEmploymentId,
    hYear: sp.hYear,
    hMonth: sp.hMonth,
    hCycle: sp.hCycle,
    hStatus: sp.hStatus,
  };

  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => nowYear + 1 - i);
  const methodLabel = (m: string | null) =>
    m === 'percent_of_pcb'
      ? t('zakat.election.methodPercentOfPcb')
      : m === 'fixed'
        ? t('zakat.election.methodFixed')
        : '—';
  // Carry the "Applied in payroll" filter selection across a change of employee in the panel. These are the
  // ALREADY SCOPE-GUARDED values, not the raw params, so a tampered filter cannot survive the round trip by
  // hitching a ride on the next click. Paging params are deliberately absent: page 4 of the previous
  // employee's list is not page 4 of the next one's.
  const panelPreserve: Record<string, string> = {
    ...(hCompanyId ? { hCompanyId } : {}),
    ...(hEmploymentId ? { hEmploymentId } : {}),
    ...(hYear != null ? { hYear: String(hYear) } : {}),
    ...(hMonth != null ? { hMonth: String(hMonth).padStart(2, '0') } : {}),
    ...(hCycle ? { hCycle } : {}),
    ...(hStatus ? { hStatus } : {}),
  };

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('zakat.title')}
        description={t('zakat.subtitle')}
      />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <ErrorBanner message={error} />

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={ZAKAT_PANEL_COOKIE}
        panel={
          /* ── Section A control — the searchable employee panel (6a1f2bd6) ── */
          <Card className="p-4">
            <h2 className="text-sm font-semibold">{t('zakat.election.pickEmployee')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('zakat.election.subtitle')}</p>
            {employees.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('zakat.election.noEmployees')}</p>
            ) : (
              <div className="mt-3">
                <EmployeeScopePanel
                  employees={panelEmployees}
                  selectedId={selectedEmploymentId}
                  basePath="/payroll/transactions/zakat"
                  preserve={panelPreserve}
                />
              </div>
            )}
          </Card>
        }
      >
        <div className="space-y-6">
      {!emp && (
        <Card className="px-6 py-16 text-center">
          <p className="text-sm font-medium text-foreground">{t('zakat.election.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('zakat.election.subtitle')}</p>
        </Card>
      )}

      {emp && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('zakat.election.title')} />
          {/* Step 1 basic info: name, employee number, company (ticket's employee card). */}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-border px-4 py-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakat.election.name')}</dt>
              <dd className="font-medium">{emp.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakat.election.employeeNo')}</dt>
              <dd className="font-medium tabular-nums">{emp.employeeCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakat.election.company')}</dt>
              <dd className="font-medium">{emp.company}</dd>
            </div>
          </dl>
          {statutory ? (
            /* Step 2 — the exact field set relocated from Personnel > Statutory (MY). Percent shows as
               a %, stored as a decimal; both amount inputs render and the setter keeps only the one for
               the chosen method. Effective dates are display-only metadata (no calc-path filtering). */
            <form action={saveZakatElectionAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
              <input type="hidden" name="employmentId" value={emp.employmentId} />
              <input type="hidden" name="personId" value={emp.personId} />
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  name="zakatActive"
                  defaultChecked={statutory.zakatActive ?? false}
                  className="size-4 rounded"
                />
                {t('zakat.election.active')}
              </label>
              <Field label={t('zakat.election.state')}>
                <select name="zakatState" defaultValue={statutory.zakatState ?? ''} className={inputCls}>
                  <option value="">—</option>
                  {MY_STATES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('zakat.election.method')}>
                <select name="zakatMethod" defaultValue={statutory.zakatMethod ?? ''} className={inputCls}>
                  <option value="">—</option>
                  <option value="percent_of_pcb">{t('zakat.election.methodPercentOfPcb')}</option>
                  <option value="fixed">{t('zakat.election.methodFixed')}</option>
                </select>
              </Field>
              <Field label={t('zakat.election.percent')}>
                <input
                  name="zakatPercent"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={statutory.zakatPercent ? (Number(statutory.zakatPercent) * 100).toString() : ''}
                  placeholder="2.5"
                  className={inputCls}
                />
              </Field>
              <Field label={t('zakat.election.fixed')}>
                <input
                  name="zakatFixed"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={statutory.zakatFixed ?? ''}
                  className={inputCls}
                />
              </Field>
              <Field label={t('zakat.election.effectiveFrom')}>
                <input
                  name="zakatEffectiveFrom"
                  type="date"
                  defaultValue={statutory.zakatEffectiveFrom ?? ''}
                  className={inputCls}
                />
              </Field>
              <Field label={t('zakat.election.effectiveTo')}>
                <input
                  name="zakatEffectiveTo"
                  type="date"
                  defaultValue={statutory.zakatEffectiveTo ?? ''}
                  className={inputCls}
                />
              </Field>
              <p className="sm:col-span-2 text-xs text-muted-foreground">{t('zakat.election.nonResidentHint')}</p>
              <div className="flex items-end justify-end sm:col-span-2">
                <Button type="submit">{t('zakat.election.save')}</Button>
              </div>
            </form>
          ) : (
            /* No MY statutory row yet (no IC): the election has nowhere to live. Point at Personnel. */
            <p className="p-4 text-sm text-muted-foreground">
              {t('zakat.election.noProfile')}{' '}
              <Link
                href={`/admin/personnel/${emp.employmentId}`}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {t('zakat.election.openPersonnel')}
              </Link>
            </p>
          )}
        </Card>
      )}

      {/* ── Section B — transaction history (read-only, feedback d435673e) ── */}
      <div className="space-y-2">
        <h2 className="text-base font-semibold">{t('zakat.history.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('zakat.history.subtitle')}</p>
      </div>

      {/* B1 — Saved elections (every employee with a saved election) */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('zakat.history.electionsTitle')} count={elections.length} />
        <p className="px-4 pt-2 text-xs text-muted-foreground">{t('zakat.history.electionsSubtitle')}</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colEmployee')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colCompany')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colMethod')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('zakat.history.colAmount')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colState')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colEffective')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {electionPage.rows.map((r) => {
                const amount =
                  r.zakatMethod === 'fixed'
                    ? rm(r.zakatFixed)
                    : r.zakatMethod === 'percent_of_pcb'
                      ? `${(Number(r.zakatPercent ?? 0) * 100).toFixed(2)}%`
                      : '—';
                const effective =
                  r.zakatEffectiveFrom || r.zakatEffectiveTo
                    ? `${r.zakatEffectiveFrom ?? '—'} – ${r.zakatEffectiveTo ?? '—'}`
                    : '—';
                return (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2.5 font-medium">
                      {r.employeeName}
                      {r.employeeCode && (
                        <span className="ml-1 font-mono text-xs text-muted-foreground">({r.employeeCode})</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.company}</td>
                    <td className="px-4 py-2.5">{methodLabel(r.zakatMethod)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{amount}</td>
                    <td className="px-4 py-2.5">{r.zakatState ?? '—'}</td>
                    <td className="px-4 py-2.5 tabular-nums">{effective}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant={r.zakatActive ? 'success' : 'default'}>
                        {r.zakatActive ? t('zakat.history.active') : t('zakat.history.inactive')}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
              {electionPage.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('zakat.history.electionsEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath="/payroll/transactions/zakat"
          params={{ ...historyParams, hPage: sp.hPage, hSize: sp.hSize }}
          paramNames={{ page: 'ePage', size: 'eSize' }}
          state={electionPage.state}
        />
      </Card>

      {/* B2 — Applied in payroll (zakat deducted in each processed run) — filterable + CSV export */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('zakat.history.appliedTitle')} count={appliedRows.length} />
          {/* CSV export honouring the current (scope-guarded) filters — opens in Excel. */}
          <a
            href={`/payroll/transactions/zakat/history-export?${new URLSearchParams({
              ...(hCompanyId ? { hCompanyId } : {}),
              ...(hEmploymentId ? { hEmploymentId } : {}),
              ...(hYear != null ? { hYear: String(hYear) } : {}),
              ...(hMonth != null ? { hMonth: String(hMonth) } : {}),
              ...(hCycle ? { hCycle } : {}),
              ...(hStatus ? { hStatus } : {}),
            }).toString()}`}
            className="inline-flex shrink-0 items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t('zakat.history.exportCsv')}
          </a>
        </div>
        <p className="px-4 pt-2 text-xs text-muted-foreground">{t('zakat.history.appliedSubtitle')}</p>

        {/* Filters (GET form — pure navigation, no mutation). Carries the election picker's ?employmentId. */}
        <form method="GET" className="flex flex-wrap items-end gap-3 px-4 pt-3">
          {selectedEmploymentId && <input type="hidden" name="employmentId" value={selectedEmploymentId} />}
          <Field label={t('zakat.history.company')}>
            <select name="hCompanyId" defaultValue={hCompanyId ?? ''} className={inputCls}>
              <option value="">{t('zakat.history.all')}</option>
              {scopedCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('zakat.history.employee')}>
            <select name="hEmploymentId" defaultValue={hEmploymentId ?? ''} className={inputCls}>
              <option value="">{t('zakat.history.all')}</option>
              {allEmployees.map((e) => (
                <option key={e.employmentId} value={e.employmentId}>
                  {e.name}
                  {e.employeeCode ? ` (${e.employeeCode})` : ''} · {e.company}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('zakat.history.year')}>
            <select name="hYear" defaultValue={hYear != null ? String(hYear) : ''} className={inputCls}>
              <option value="">{t('zakat.history.all')}</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('zakat.history.month')}>
            <select
              name="hMonth"
              defaultValue={hMonth != null ? String(hMonth).padStart(2, '0') : ''}
              className={inputCls}
            >
              <option value="">{t('zakat.history.all')}</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('zakat.history.colCycle')}>
            <select name="hCycle" defaultValue={hCycle ?? ''} className={inputCls}>
              <option value="">{t('zakat.history.all')}</option>
              {CYCLES.map((c) => (
                <option key={c} value={c}>
                  {t(`individual.cycle.${c}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('zakat.history.status')}>
            {/* Reuses the payroll-list batch-status labels — the same wording the Status column renders. */}
            <select name="hStatus" defaultValue={hStatus ?? ''} className={inputCls}>
              <option value="">{t('zakat.history.all')}</option>
              {STATUSES.map((st) => (
                <option key={st} value={st}>
                  {tList(`status.${st}`)}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary">
            {t('zakat.history.apply')}
          </Button>
        </form>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colPeriod')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colCycle')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colEmployee')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colCompany')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('zakat.history.colAmount')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.status')}</th>
                <th className="px-4 py-2 font-medium">{t('zakat.history.colCreated')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {appliedPage.rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5 tabular-nums">{r.payPeriod}</td>
                  <td className="px-4 py-2.5">
                    {t(`individual.cycle.${r.runType}`)}
                    {r.runSeq > 1 ? ` #${r.runSeq}` : ''}
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    {r.employeeName}
                    {r.employeeCode && (
                      <span className="ml-1 font-mono text-xs text-muted-foreground">({r.employeeCode})</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.company}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(r.zakat)}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant="success">{tList(`status.${r.batchStatus}`)}</Badge>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.createdOn}</td>
                </tr>
              ))}
              {appliedPage.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('zakat.history.appliedEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath="/payroll/transactions/zakat"
          params={{ ...historyParams, ePage: sp.ePage, eSize: sp.eSize }}
          paramNames={{ page: 'hPage', size: 'hSize' }}
          state={appliedPage.state}
        />
      </Card>
        </div>
      </CollapsibleEmployeePanel>
    </div>
  );
}
