import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { employeeDetail, listCompanies, listEmployees } from '@/core/read';
import { listZakatElections, listZakatTxnsAcross } from '@/core/payroll-view';
import { getStatutoryProfileMY } from '@/localization/my/statutory';
import { MY_STATES } from '@/localization/my/holidays';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { employeeLabel } from '@/lib/employee-code';
import { PayrollTabs } from '@/components/payroll-tabs';
import { saveZakatElectionAction } from './election-actions';
import { isModuleEnabled } from '@/core/entitlements';

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
 */

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
// A payslip row only exists post-generation, so 'draft' is impossible in this history by construction.
const STATUSES = ['processed', 'closed'] as const;

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const tList = await getTranslations('payroll.list');
  const sp = await searchParams;
  const { employmentId, error } = sp;
  const typedComponentsOn = isModuleEnabled(s, 'typed_pay_components');

  // ── Section A data — employee election ─────────────────────────────────────
  const [allEmployees, companies] = await Promise.all([listEmployees(s, scopeIds), listCompanies(s)]);
  const employees = allEmployees.filter((e) => !e.terminatedOn);
  const selectedEmploymentId =
    employmentId && employees.some((e) => e.employmentId === employmentId) ? employmentId : null;
  const emp = selectedEmploymentId ? await employeeDetail(s, selectedEmploymentId) : null;
  const statutory = emp ? await getStatutoryProfileMY(s, emp.personId) : null;

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

  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => nowYear + 1 - i);
  const methodLabel = (m: string | null) =>
    m === 'percent_of_pcb'
      ? t('zakat.election.methodPercentOfPcb')
      : m === 'fixed'
        ? t('zakat.election.methodFixed')
        : '—';
  // Carry the "Applied in payroll" filter selection across the election picker's GET submit (and vice versa).
  const historyHidden = (
    <>
      {hCompanyId && <input type="hidden" name="hCompanyId" value={hCompanyId} />}
      {hEmploymentId && <input type="hidden" name="hEmploymentId" value={hEmploymentId} />}
      {hYear != null && <input type="hidden" name="hYear" value={String(hYear)} />}
      {hMonth != null && <input type="hidden" name="hMonth" value={String(hMonth).padStart(2, '0')} />}
      {hCycle && <input type="hidden" name="hCycle" value={hCycle} />}
      {hStatus && <input type="hidden" name="hStatus" value={hStatus} />}
    </>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('zakat.title')}
        description={t('zakat.subtitle')}
      />
      <PayrollTabs active="transactions" />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <ErrorBanner message={error} />

      {/* ── Section A — durable per-employee election (relocated from Personnel) ── */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('zakat.election.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('zakat.election.subtitle')}</p>
        <form method="GET" className="mt-3 flex flex-wrap items-end gap-3">
          {/* Keep the history-filter selection when switching employees. */}
          {historyHidden}
          <Field label={t('zakat.election.pickEmployee')}>
            <select name="employmentId" defaultValue={selectedEmploymentId ?? ''} className={inputCls}>
              <option value="">—</option>
              {employees.map((e) => (
                <option key={e.employmentId} value={e.employmentId}>
                  {/* Employee ID left-of-name (feedback 38668d9b) */}
                  {employeeLabel(e.employeeCode, e.name)} · {e.company}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary">
            {t('zakat.election.pickEmployee')}
          </Button>
        </form>
        {employees.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">{t('zakat.election.noEmployees')}</p>
        )}
      </Card>

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
              {elections.map((r) => {
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
              {elections.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('zakat.history.electionsEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
              {appliedRows.map((r) => (
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
              {appliedRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('zakat.history.appliedEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
