import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import {
  getStatutoryAdjustmentDetail,
  listAdjustableBatches,
  listAdjustmentEmployees,
  STATUTORY_ADJUSTMENT_EMPLOYER_LINES,
  STATUTORY_ADJUSTMENT_LINES,
  type StatutoryAdjustmentLine,
} from '@/packs/payroll/service';
import {
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  inputCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { AdjustmentForm, type AdjustmentLine } from './adjustment-form';
import { revertAdjustmentAction } from './actions';

/**
 * Payroll → Statutory Adjustment (feedback 2961a7ae).
 *
 * ONE ROUTE, THREE STATES, driven by the query string — the single-pager convention Transaction View and
 * Back Pay already use. No `?batch=` ⇒ pick a run. `?batch=` ⇒ pick an employee. `?batch=&?employment=`
 * ⇒ the nine-line grid, its Review step and Revert.
 *
 * ONLY PROCESSED, UNCLOSED RUNS ARE OFFERED. `listAdjustableBatches` filters on status='processed', which
 * is also the window `saveStatutoryAdjustment` enforces server-side — the list is a convenience, not the
 * boundary. A closed run is frozen at trigger level (0011_payroll_immutability.sql) and is reopened
 * through the Unlock control that already exists, exactly as the request says.
 *
 * SCOPE IS FENCED ON EVERY READ. `scopedAdmin` narrows to the companies this session may administer, and
 * the batch/employee reads are checked against it. RLS alone does not fence this: `app.is_admin()` is
 * true for a grant on ANY company in the tenant, so an hr_admin scoped to Company A could otherwise open
 * `?batch=<Company B's run>` and read B's per-employee statutory figures. Not-found and not-yours are ONE
 * answer, so the page cannot be used to probe which run ids exist.
 *
 * NINE LINES, NOT THE TEN THE REQUEST LISTS. SKBBK / Lindung 24 Jam has only an EMPLOYEE leg in the
 * engine (localization/my/payroll.ts socso() → { employer, employee, skbbk }), so the screen shows nine
 * rows rather than rendering an always-zero tenth that would imply a figure the system does not compute.
 */

const money = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ERROR_CODES = ['batchNotOpen', 'reasonRequired', 'amountInvalid', 'notFound', 'unknown'] as const;

/** "Payroll Cycle" on the request is `payroll_batch.run_type` here — payroll_cycle is a per-company
 *  CATALOG with no foreign key from a batch, so run_type is the only cycle fact a run actually carries.
 *  Exhaustive BY TYPE over the enum, so a new run type fails the build rather than rendering blank. */
const RUN_TYPES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
type RunType = (typeof RUN_TYPES)[number];
const RUN_TYPE_LABEL: Record<RunType, string> = {
  regular: 'cycleRegular',
  off_cycle: 'cycleOffCycle',
  bonus: 'cycleBonus',
  adjustment: 'cycleAdjustment',
};

/** Line key → its label key in this screen's namespace. Exhaustive BY TYPE, so adding a line to
 *  STATUTORY_ADJUSTMENT_LINES without a label fails the build rather than rendering `lineundefined`. */
const LINE_LABEL: Record<StatutoryAdjustmentLine, string> = {
  pcb: 'linePcb',
  epfEmployee: 'lineEpfEmployee',
  socsoEmployee: 'lineSocsoEmployee',
  socsoSkbbk: 'lineSocsoSkbbk',
  eisEmployee: 'lineEisEmployee',
  hrdf: 'lineHrdf',
  epfEmployer: 'lineEpfEmployer',
  socsoEmployer: 'lineSocsoEmployer',
  eisEmployer: 'lineEisEmployer',
};

export default async function StatutoryAdjustmentPage({
  searchParams,
}: {
  searchParams: Promise<{
    company?: string; year?: string; month?: string; runType?: string;
    batch?: string; employment?: string; q?: string; err?: string; ok?: string;
  }>;
}) {
  const sp = await searchParams;
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryAdjustment');

  const companies = (await listCompanies(s)).filter((c) => scopeIds.includes(c.id));
  const err = ERROR_CODES.includes(sp.err as (typeof ERROR_CODES)[number]) ? sp.err : undefined;

  // ── State 3: one employee on one run ────────────────────────────────────────────────────────────
  const detailRaw =
    sp.batch && sp.employment
      ? await getStatutoryAdjustmentDetail(s, { batchId: sp.batch, employmentId: sp.employment })
      : null;
  const detail = detailRaw && scopeIds.includes(detailRaw.companyId) ? detailRaw : null;

  if (detail) {
    const lines: AdjustmentLine[] = STATUTORY_ADJUSTMENT_LINES.map((line) => ({
      line,
      label: t(LINE_LABEL[line]),
      system: detail.system[line],
      current: detail.current?.[line] ?? null,
      employer: STATUTORY_ADJUSTMENT_EMPLOYER_LINES.includes(line),
    }));
    const hasOverride = detail.current != null;
    return (
      <div className="w-full space-y-6">
        <PageHeader
          title={t('title')}
          description={t('employeeSubtitle', {
            code: detail.employeeCode ?? '—',
            name: detail.employeeName ?? '—',
            period: detail.payPeriod,
          })}
        />
        {err && <ErrorBanner message={t(`errors.${err}`)} />}
        {sp.ok && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
            {t(sp.ok === 'reverted' ? 'okReverted' : 'okApplied')}
          </div>
        )}

        {/* The same "already left the building" derivation the Unlock control and the Individual
            Transaction screen show — batchDownstreamWarnings, reused rather than written a second time.
            It WARNS and does not stop: the figure may still need correcting, but nobody should key it
            without knowing the month has already been filed or paid out. */}
        {(detail.statutoryFiled || detail.paymentDisbursed) && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
            {detail.statutoryFiled && <p>{t('warnFiled', { count: detail.statutoryReportCount })}</p>}
            {detail.paymentDisbursed && <p>{t('warnDisbursed')}</p>}
          </div>
        )}

        <Card className="space-y-4 p-6">
          <SectionHeader title={t('gridHeading')} />
          <AdjustmentForm
            batchId={detail.batchId}
            employmentId={detail.employmentId}
            lines={lines}
            initialReason={detail.reason}
            labels={{
              colItem: t('colItem'),
              colSystem: t('colSystem'),
              colAdjustment: t('colAdjustment'),
              colFinal: t('colFinal'),
              employeeHeading: t('employeeHeading'),
              employerHeading: t('employerHeading'),
              reason: t('reason'),
              reasonHint: t('reasonHint'),
              review: t('review'),
              backToEdit: t('backToEdit'),
              confirmApply: t('confirmApply'),
              reviewHeading: t('reviewHeading'),
              noChanges: t('noChanges'),
              reasonRequired: t('errors.reasonRequired'),
              beforeCol: t('beforeCol'),
              afterCol: t('afterCol'),
              rowGross: t('rowGross'),
              rowDeductions: t('rowDeductions'),
              rowNet: t('rowNet'),
              rowEmployerCost: t('rowEmployerCost'),
              netFloorWarning: t('netFloorWarning'),
              blankMeansSystem: t('blankMeansSystem'),
            }}
          />
        </Card>

        {hasOverride && (
          <Card className="space-y-3 p-6">
            <SectionHeader title={t('revertHeading')} />
            <p className="text-xs text-muted-foreground">{t('revertHint')}</p>
            <form action={revertAdjustmentAction}>
              <input type="hidden" name="batchId" value={detail.batchId} />
              <input type="hidden" name="employmentId" value={detail.employmentId} />
              <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-sm">
                {t('revert')}
              </button>
            </form>
          </Card>
        )}

        <Link
          href={`/payroll/statutory-adjustment?batch=${encodeURIComponent(detail.batchId)}`}
          className="inline-block text-sm text-muted-foreground underline"
        >
          {t('backToEmployees')}
        </Link>
      </div>
    );
  }

  // ── State 2: the employees on one run ───────────────────────────────────────────────────────────
  if (sp.batch) {
    const runs = await listAdjustableBatches(s, {});
    const run = runs.find((r) => r.batchId === sp.batch && scopeIds.includes(r.companyId)) ?? null;
    if (!run) {
      return (
        <div className="w-full space-y-6">
          <PageHeader title={t('title')} description={t('subtitle')} />
          <ErrorBanner message={t('errors.notFound')} />
          <Link href="/payroll/statutory-adjustment" className="inline-block text-sm underline">
            {t('backToRuns')}
          </Link>
        </div>
      );
    }
    const employees = await listAdjustmentEmployees(s, { batchId: run.batchId, q: sp.q });
    return (
      <div className="w-full space-y-6">
        <PageHeader
          title={t('title')}
          description={t('runSubtitle', { company: run.companyName, period: run.payPeriod })}
        />
        {err && <ErrorBanner message={t(`errors.${err}`)} />}

        <form method="GET" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="batch" value={run.batchId} />
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('searchEmployee')}</span>
            <input name="q" defaultValue={sp.q ?? ''} className={inputCls} placeholder={t('searchPlaceholder')} />
          </label>
          <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-sm">
            {t('search')}
          </button>
        </form>

        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>{t('colEmployeeCode')}</th>
                <th className={thCls}>{t('colEmployeeName')}</th>
                <th className={`${thCls} text-right`}>{t('colNetPay')}</th>
                <th className={thCls}>{t('colAdjustmentStatus')}</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {employees.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {t('noEmployees')}
                  </td>
                </tr>
              )}
              {employees.map((e) => (
                <tr key={e.employmentId}>
                  <td className="px-3 py-2 font-mono text-xs">{e.employeeCode ?? '—'}</td>
                  <td className="px-3 py-2">{e.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(Number(e.netPay))}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {e.adjustedAt ? t('statusAdjusted') : t('statusSystemCalculated')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/payroll/statutory-adjustment?batch=${encodeURIComponent(run.batchId)}&employment=${encodeURIComponent(e.employmentId)}`}
                      className="text-sm underline"
                    >
                      {t('adjust')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Link href="/payroll/statutory-adjustment" className="inline-block text-sm text-muted-foreground underline">
          {t('backToRuns')}
        </Link>
      </div>
    );
  }

  // ── State 1: pick a run ─────────────────────────────────────────────────────────────────────────
  const runs = await listAdjustableBatches(s, {
    companyId: sp.company,
    year: sp.year,
    month: sp.month,
    runType: sp.runType,
  });
  const visible = runs.filter((r) => scopeIds.includes(r.companyId));
  const years = [...new Set(runs.map((r) => r.payPeriod.slice(0, 4)))].sort().reverse();

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      {err && <ErrorBanner message={t(`errors.${err}`)} />}

      {/* Stated on the screen rather than only in a plan nobody re-reads. */}
      <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        {t('windowNote')}
      </div>

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('company')}</span>
          <select name="company" defaultValue={sp.company ?? ''} className={inputCls}>
            <option value="">{t('allCompanies')}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('year')}</span>
          <select name="year" defaultValue={sp.year ?? ''} className={inputCls}>
            <option value="">{t('allYears')}</option>
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('month')}</span>
          <select name="month" defaultValue={sp.month ?? ''} className={inputCls}>
            <option value="">{t('allMonths')}</option>
            {['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        {/* "Payroll Cycle" on the request is the run's own RUN TYPE here: payroll_cycle is a per-company
            catalog with no foreign key from a batch, so run_type is the only cycle fact a run carries. */}
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('cycle')}</span>
          <select name="runType" defaultValue={sp.runType ?? ''} className={inputCls}>
            <option value="">{t('allCycles')}</option>
            {RUN_TYPES.map((rt) => (
              <option key={rt} value={rt}>{t(RUN_TYPE_LABEL[rt])}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-sm">
          {t('search')}
        </button>
      </form>

      <div className={tableWrapCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>{t('colCompany')}</th>
              <th className={thCls}>{t('colPeriod')}</th>
              <th className={thCls}>{t('colCycle')}</th>
              <th className={thCls}>{t('colRunStatus')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody className={tbodyCls}>
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('noRuns')}
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={r.batchId}>
                <td className="px-3 py-2">{r.companyName}</td>
                <td className="px-3 py-2 tabular-nums">{r.payPeriod}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {t(RUN_TYPE_LABEL[r.runType])}
                  {r.runSeq > 1 ? ` #${r.runSeq}` : ''}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.needsRecalcAt ? t('runNeedsRecalc') : t('runProcessed')}
                </td>
                <td className="px-3 py-2 text-right">
                  <Link
                    href={`/payroll/statutory-adjustment?batch=${encodeURIComponent(r.batchId)}`}
                    className="text-sm underline"
                  >
                    {t('selectEmployees')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
