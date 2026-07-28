import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { listPayComponents } from '@/core/pay-components';
import {
  listFixedTransactionsAcross,
  listIndividualTxnCreators,
  listIndividualTxnsAcross,
  listProcessedPayslipsAcross,
} from '@/core/payroll-view';
import { TXN_KINDS } from '@/core/payroll-individual-txn';
import { Badge, Button, Card, EmployeeName, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { employeeLabel } from '@/lib/employee-code';
import { packFor } from '@/localization/registry';
import { IndividualTxnTable } from './individual-table';
import { HistoryTable } from './history-table';

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

const TABS = ['fixed', 'individual', 'history'] as const;
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

  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : 'fixed';

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

  // Individual-tab History filters — each scope-guarded / whitelist-coerced (a tampered value ⇒ ignored).
  const kind = TXN_KINDS.includes(sp.kind as (typeof TXN_KINDS)[number]) ? sp.kind : undefined;
  const departmentId =
    sp.departmentId && departmentOptions.some((d) => d.id === sp.departmentId) ? sp.departmentId : undefined;
  const txnStatus = TXN_STATUSES.includes(sp.txnStatus as (typeof TXN_STATUSES)[number]) ? sp.txnStatus : undefined;
  const createdBy = sp.createdBy && creators.some((c) => c.id === sp.createdBy) ? sp.createdBy : undefined;
  const createdFrom = sp.createdFrom && ISO_DATE.test(sp.createdFrom) ? sp.createdFrom : undefined;
  const createdTo = sp.createdTo && ISO_DATE.test(sp.createdTo) ? sp.createdTo : undefined;

  // Only the active tab's query runs — the other two stay empty (single round-trip per view).
  const [fixedRows, individualRows, historyRows] = await Promise.all([
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
    tab === 'history'
      ? listProcessedPayslipsAcross(s, { companyIds, year, month, employmentId, cycle })
      : Promise.resolve([]),
  ]);

  // Feedback efece4ce — which companies are actually registered for the HRD Corp levy. The breakdown used
  // to drop its HRDF line whenever the amount was 0, so a company that legitimately pays nothing (no HRDF
  // Contribution Rate set) looked exactly like a levy that failed to compute. Read once per render for the
  // History tab only; `packFor('MY')` follows the Organization page — the levy is Malaysia-specific.
  const hrdfRegisteredCompanyIds =
    tab === 'history'
      ? ((await packFor('MY')?.companyStatutory.list(s)) ?? [])
          .filter((r) => r.hrdfStatus !== 'not_registered')
          .map((r) => r.companyId)
      : [];

  const today = new Date().toISOString().slice(0, 10);
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
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('view.title')} description={t('view.subtitle')} />

      {/* Sub-tab strip (Fixed | Individual | History). Switching tabs resets the filters on purpose —
          each view has its own filter set. */}
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

      {/* ── Filters (GET form — pure navigation, no mutation) ── */}
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
        <Card className="overflow-hidden">
          <SectionHeader title={t('view.tabs.history')} count={historyRows.length} />
          <HistoryTable rows={historyRows} hrdfRegisteredCompanyIds={hrdfRegisteredCompanyIds} />
        </Card>
      )}
    </div>
  );
}
