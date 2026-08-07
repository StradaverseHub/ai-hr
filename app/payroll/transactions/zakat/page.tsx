import Link from 'next/link';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listZakatElections, listZakatTxnsAcross } from '@/core/payroll-view';
import { getStatutoryProfileMY } from '@/localization/my/statutory';
import { Button, Card, EmployeeName, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { AppliedInPayrollList, type AppliedInPayrollRow } from '@/components/applied-in-payroll-list';
import { ZakatElectionsList, type ZakatElectionListRow } from './elections-list';
import { isModuleEnabledOrFalse } from '@/core/entitlements';

/**
 * Zakat screen (feedback 58755260; simplified by d435673e; redesigned by 6a1f2bd6) — the single home for
 * zakat, now built the way Fixed Transaction is: choose a person, read their record, press Add or Edit when
 * you actually want to change something.
 *
 * 6a1f2bd6 CAME BACK REJECTED ONCE AND THIS IS WHAT WAS WRONG WITH IT. r168a put the shared searchable
 * employee panel on this screen and stopped there, so picking somebody did two things the reporter had not
 * asked for and none of the thing they had:
 *   - the election editor rendered UNCONDITIONALLY as soon as an employee resolved, so selecting a person
 *     to READ their record opened a form to CHANGE it;
 *   - both lists underneath still showed EVERYBODY — `listZakatElections` was called with the whole company
 *     scope, and the applied-in-payroll list was filtered by a SEPARATE dropdown that ignored the panel.
 * So picking John Tan told the screen almost nothing. Both are fixed here, and the narrowing happens IN THE
 * QUERY (core/payroll-view.ts) rather than in a filter over rows that were read and then thrown away.
 *
 * THE THREE SURFACES, AND WHAT EACH ONE IS:
 *  A. The employee panel (shared, components/collapsible-employee-panel.tsx) + a header row carrying the
 *     selected person and ONE button — Add when they have no zakat setup, Edit when they do. The editor
 *     itself lives at `zakat/election` (its own page, room for every field, Save and Cancel at the bottom).
 *  B. Transaction history — the saved zakat setup(s). ONE ROW PER EMPLOYEE, NEVER A VERSION CHAIN:
 *     `employee_statutory_my` holds a single row per person, saving overwrites it, and switching zakat off
 *     nulls every zakat field (resolveZakatElection). With somebody selected this list is exactly one row.
 *  C. Applied in payroll — the zakat actually deducted in each processed run. THIS is the month-by-month
 *     record, and it renders through the shared components/applied-in-payroll-list.tsx so Zakat, Loans and
 *     TP1 Relief produce the same table rather than three lookalikes.
 *
 * WITH NOBODY SELECTED THE EVERYONE-AT-ONCE VIEW IS UNCHANGED, deliberately — it is the only place that
 * view exists, filters and CSV export included, and the no-selection reads are byte-identical to what this
 * page did before. Selection NARROWS; it never gates.
 *
 * The old "one-off override (per payroll run)" section was REMOVED by d435673e — the Zakat screen no longer
 * writes payroll_input.zakat; that manual tier survives ONLY on the batch input grid / prefill / import (see
 * the kernel precedence note in core/payroll.ts). The history filter params stay h*-prefixed so they never
 * collide with the panel's ?employmentId; the panel carries the scope-guarded filter values across a change
 * of employee.
 *
 * RSC BOUNDARY: this is a server component driving GET forms, and the panel plus the two list tables are the
 * only client islands. Selection stays in the URL — lifting it into a client wrapper would move the scope
 * guard to where a user can edit it. Every prop crossing into an island is plain data: r123's 500 was a
 * function prop crossing this exact boundary while tsc, the suite and `next build` all stayed green.
 *
 * i18n note: the statutory EA Part-D line "Zakat via salary deduction" (payroll.ea.zakatViaSalary) is LHDN
 * form wording and is deliberately NOT renamed to plain "Zakat" — it is not a UI label.
 */

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
// A payslip row only exists post-generation, so 'draft' is impossible in this history by construction.
const STATUSES = ['processed', 'closed'] as const;

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
    // Two independently paged listings sit below the header, so each carries its own page/size pair.
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

  // ── Selection ──────────────────────────────────────────────────────────────
  const [allEmployees, companies] = await Promise.all([listEmployees(s, scopeIds), listCompanies(s)]);
  const employees = allEmployees.filter((e) => !e.terminatedOn);
  const selectedEmploymentId =
    employmentId && employees.some((e) => e.employmentId === employmentId) ? employmentId : null;
  const selectedEmp = selectedEmploymentId
    ? (employees.find((e) => e.employmentId === selectedEmploymentId) ?? null)
    : null;
  // Add vs Edit, decided by the SAME predicate the history list uses for "has a setup on file", so the
  // button and the row underneath it can never disagree about which one this person is.
  const statutory = selectedEmp ? await getStatutoryProfileMY(s, selectedEmp.personId) : null;
  const hasElection = statutory != null && (statutory.zakatMethod != null || statutory.zakatActive === true);

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

  // ── History filters (read-only lists) ──────────────────────────────────────
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
  // THE SELECTION WINS. Picking somebody in the panel is the reader saying "show me this person"; the
  // Employee filter below is the same statement made a second way. With a selection the filter dropdown is
  // replaced by a hidden input carrying its value, so switching back to the everyone view restores it
  // rather than silently discarding it — and the no-selection case falls back to hEmploymentId exactly as
  // it did before, which is what keeps that view byte-identical to today.
  const effectiveEmploymentId = selectedEmploymentId ?? hEmploymentId;

  const [elections, appliedRows] = await Promise.all([
    listZakatElections(s, { companyIds: scopeIds, employmentId: selectedEmploymentId ?? undefined }),
    listZakatTxnsAcross(s, {
      companyIds: historyCompanyIds,
      year: hYear,
      month: hMonth,
      employmentId: effectiveEmploymentId,
      cycle: hCycle,
      status: hStatus,
    }),
  ]);

  const electionRows: ZakatElectionListRow[] = elections.map((r) => ({
    employmentId: r.employmentId,
    employeeName: r.employeeName,
    employeeCode: r.employeeCode,
    company: r.company,
    zakatActive: r.zakatActive,
    zakatMethod: r.zakatMethod,
    zakatPercent: r.zakatPercent,
    zakatFixed: r.zakatFixed,
    zakatState: r.zakatState,
    zakatEffectiveFrom: r.zakatEffectiveFrom,
    zakatEffectiveTo: r.zakatEffectiveTo,
  }));
  // Cycle and batch-status labels are resolved HERE because they live in namespaces the shared list does
  // not own (`payroll.transactions.individual.cycle.*`, `payroll.list.status.*`); resolving them inside it
  // would make it a two-namespace file, the shape i18n-coverage check C skips ENTIRELY.
  const appliedList: AppliedInPayrollRow[] = appliedRows.map((r) => ({
    id: r.id,
    payPeriod: r.payPeriod,
    cycleLabel: `${t(`individual.cycle.${r.runType}`)}${r.runSeq > 1 ? ` #${r.runSeq}` : ''}`,
    employeeName: r.employeeName,
    employeeCode: r.employeeCode,
    company: r.company,
    amount: r.zakat,
    statusLabel: tList(`status.${r.batchStatus}`),
    createdOn: r.createdOn,
  }));

  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => nowYear + 1 - i);
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
  // The export streams the list it sits above, so it takes the EFFECTIVE employee filter, not the raw one.
  const exportQuery = new URLSearchParams({
    ...(hCompanyId ? { hCompanyId } : {}),
    ...(effectiveEmploymentId ? { hEmploymentId: effectiveEmploymentId } : {}),
    ...(hYear != null ? { hYear: String(hYear) } : {}),
    ...(hMonth != null ? { hMonth: String(hMonth) } : {}),
    ...(hCycle ? { hCycle } : {}),
    ...(hStatus ? { hStatus } : {}),
  }).toString();

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
          /* ── The searchable employee panel (r168a, shared with Loans / Individual Payslip) ── */
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
          {/* ── The header row: who is selected, and the ONE button that opens the editor ──
              Copied from the selectedEmp block of app/payroll/transactions/fixed/page.tsx on purpose —
              same three facts, same place on the screen, same action on the right of the same row. */}
          {selectedEmp ? (
            <Card className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <EmployeeName
                  code={selectedEmp.employeeCode}
                  name={selectedEmp.name}
                  className="text-sm font-semibold text-foreground"
                />
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {selectedEmp.company} · {selectedEmp.department ?? '—'} · {selectedEmp.position ?? '—'}
                </p>
              </div>
              <Button asChild size="sm">
                <Link
                  href={`/payroll/transactions/zakat/election?employmentId=${encodeURIComponent(selectedEmp.employmentId)}`}
                >
                  {hasElection ? t('zakat.election.editButton') : t('zakat.election.addButton')}
                </Link>
              </Button>
            </Card>
          ) : (
            /* No selection is a legitimate state here, not an empty one: this is the only screen carrying
               the everyone-at-once view. Say what picking somebody would do instead of gating the lists. */
            <p className="text-xs text-muted-foreground">{t('zakat.election.pickEmployeeHint')}</p>
          )}

          {/* ── B. Transaction history — the saved zakat setup (ONE row per employee) ── */}
          <Card className="overflow-hidden">
            <SectionHeader title={t('zakat.history.title')} count={elections.length} />
            <p className="px-4 pt-2 text-xs text-muted-foreground">{t('zakat.history.electionsSubtitle')}</p>
            <ZakatElectionsList rows={electionRows} />
          </Card>

          {/* ── C. Applied in payroll — zakat deducted in each processed run, filterable + CSV export ── */}
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 pr-4">
              <SectionHeader title={t('zakat.history.appliedTitle')} count={appliedRows.length} />
              {/* CSV export honouring the current (scope-guarded) filters — opens in Excel. */}
              <a
                href={`/payroll/transactions/zakat/history-export?${exportQuery}`}
                className="inline-flex shrink-0 items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                {t('zakat.history.exportCsv')}
              </a>
            </div>
            <p className="px-4 pt-2 text-xs text-muted-foreground">{t('zakat.history.appliedSubtitle')}</p>

            {/* Filters (GET form — pure navigation, no mutation). Carries the panel's ?employmentId. */}
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
              {selectedEmploymentId ? (
                /* The panel already answered "which employee". A dropdown that still offered the choice
                   would be a control that changes nothing — the same disagreement between the picker and
                   the filter that made this screen ignore the selection in the first place. */
                hEmploymentId && <input type="hidden" name="hEmploymentId" value={hEmploymentId} />
              ) : (
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
              )}
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

            <div className="mt-3">
              <AppliedInPayrollList
                rows={appliedList}
                emptyLabel={t('zakat.history.appliedEmpty')}
                paramNames={{ page: 'hPage', size: 'hSize' }}
              />
            </div>
          </Card>
        </div>
      </CollapsibleEmployeePanel>
    </div>
  );
}
