import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import {
  backPayRunDetail,
  detectArrears,
  listBackPayRuns,
  type BackPayReviewReason,
  type BackPayStatus,
} from '@/core/back-pay';
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  SectionHeader,
  inputCls,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { payrollProcessBack } from '../back';
import {
  approveAndPostBackPayAction,
  calculateBackPayAction,
  cancelBackPayAction,
  verifyBackPayAction,
} from './actions';

/**
 * Back Pay (Arrears) — item 2ef69d1e, pass 1.
 *
 * ONE route, three states, chosen by the query string (the house single-pager convention, as
 * /payroll/transaction-view does with `?tab=`):
 *   • no `?run=`  — WHAT IS OWED: every backdated salary revision a closed payroll never saw, with the
 *                   months it should have affected, and the form that calculates a run for them.
 *   • `?run=<id>` — THE VERIFICATION SCREEN: the month-by-month grid (one line per pay item, one column
 *                   per affected month, a total), the export links, and the approve/cancel controls.
 *   • always      — the run history underneath, so a posted or cancelled run stays findable.
 *
 * A single route rather than a `[runId]` child keeps `lib/permissions.ts` to one entry and the access
 * grid to one column; there is nothing on the detail view that is not the same scopedAdmin data.
 *
 * ⚠️ NOTHING ON THIS SCREEN CHANGES A CLOSED PAYSLIP. Calculate is arithmetic on a read; Approve and
 * Post writes one-off transactions onto the CURRENT month. That is the whole promise of the feature and
 * the reason it exists instead of "reopen the month and run it again".
 *
 * ── 6b018920, presentation only ─────────────────────────────────────────────────────────────────────
 * THE PLAN'S PREMISE WAS WRONG AND THE CORRECTION MATTERS MORE THAN THE CHANGE. The board plan said
 * this screen "sits in the narrower page frame" and left "a large empty margin on both sides". It did
 * not. `pageWideCls` is exactly `'w-full space-y-6'` (components/ui.tsx) and this page's root div
 * already carried that literal string, so it has rendered at the full window width since it shipped.
 * The plan measured `grep -c pageWideCls`, which counts the IDENTIFIER and not the effective class —
 * a false negative on any page that inlined the same value. There was no width defect to fix.
 *
 * What IS real, and what this change does: adopt the named constant so the width is stated by the same
 * means as every other wide screen, and bring the filter row into the transaction-view arrangement
 * (Card → Field → Button) that the rest of Payroll uses. Buttons and status text move to the shared
 * <Button>/<Badge> primitives. No query param, no reader argument and no server logic is touched.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Reason codes the engine can emit, pinned here so a new one cannot reach the screen untranslated. */
const REVIEW_REASONS: readonly BackPayReviewReason[] = [
  'manualOvertime',
  'overtimeDeferred',
  'hoursNotStored',
  'blendedOriginal',
  'nonMonthlyPayMode',
  'nonPayableItem',
  'noBaselineSalary',
  'unpaidLeaveInPeriod',
];

const ERROR_CODES = ['nothingToCalculate', 'targetRunNotDraft', 'wrongStatus', 'notFound', 'unknown'] as const;

/**
 * Run status → the house badge tone (item 6b018920). Payroll renders run/record status as a <Badge>
 * everywhere else — transaction-view's history and fixed tabs, process/result, the individual
 * workspace — and this screen was the odd one out with bare text in a cell. Exhaustive BY TYPE over
 * BackPayStatus, so a new status fails the build rather than rendering an untoned badge.
 */
const STATUS_VARIANT: Record<BackPayStatus, 'default' | 'info' | 'success' | 'danger'> = {
  draft: 'default',
  verified: 'info',
  posted: 'success',
  cancelled: 'danger',
};

const money = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Signed rendering — a backdated REDUCTION is a real, negative figure and is shown as one. */
const signed = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${money(Math.abs(n))}`;
const amountTone = (n: number) => (n < 0 ? 'text-red-600 dark:text-red-400' : n > 0 ? 'text-emerald-700 dark:text-emerald-400' : '');

export default async function BackPayPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; run?: string; err?: string; ok?: string; from?: string }>;
}) {
  const sp = await searchParams;
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.backPay');

  const companies = (await listCompanies(s)).filter((c) => scopeIds.includes(c.id));
  const companyId = companies.find((c) => c.id === sp.company)?.id ?? companies[0]?.id ?? null;
  const runs = await listBackPayRuns(s, { companyIds: scopeIds });
  // SCOPE. `listBackPayRuns` above is fenced by scopeIds; this was not, and the omission was the whole
  // defect: an hr_admin scoped to Company A could open ?run=<Company B's run id> and read B's employee
  // names, codes and per-month salary differences. RLS does not stop it — `app.is_admin()` is true for a
  // grant on ANY company in the tenant. Same fail-closed shape as app/payroll/[batchId]/export/route.ts:
  // not-found and not-yours are ONE answer, so the page cannot be used to probe which run ids exist.
  const detailRaw = sp.run ? await backPayRunDetail(s, sp.run) : null;
  const detail = detailRaw && scopeIds.includes(detailRaw.run.companyId) ? detailRaw : null;
  const candidates = companyId && !detail ? await detectArrears(s, { companyId }) : [];

  const err = ERROR_CODES.includes(sp.err as (typeof ERROR_CODES)[number]) ? sp.err : undefined;
  const today = todayInKualaLumpur();
  const defaultPeriod = today.slice(0, 7);

  return (
    // 6b018920 — the SAME named width constant every other wide payroll screen uses. The class string
    // here was already `w-full space-y-6` (byte-identical to pageWideCls), so this is not a width change
    // and the screen was never actually narrow — see the note in this file's header. What it fixes is the
    // drift the constant exists to prevent: two screens going full-width by two different means is how
    // one of them silently gets a cap put back on it.
    <div className={pageWideCls}>
      <PageHeader back={await payrollProcessBack(sp.from)} title={t('title')} description={t('subtitle')} />

      {err && <ErrorBanner message={t(`errors.${err}`)} />}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t(`ok.${sp.ok === 'posted' ? 'posted' : sp.ok === 'cancelled' ? 'cancelled' : 'verified'}`)}
        </div>
      )}

      {/* The standing promise, stated on the screen and not only in a plan nobody re-reads. */}
      <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        {t('noHistoryChange')}
      </div>

      {!detail && (
        <>
          {/* ── Filters (GET form — pure navigation, no mutation) ──
              6b018920: the transaction-view arrangement — the row of controls sits in a Card, each
              control is a shared <Field>, and the submit is the shared <Button variant="secondary">.
              ⚠️ `name="company"` IS THE URL PARAM, read back as `sp.company` at the top of this file.
              Renaming it (to `companyId`, say, to match the reader's argument) silently breaks every
              bookmarked ?company=… link — the filter stops applying and nothing errors. Pinned in
              test/payroll-backpay-statutory-layout.test.ts. */}
          {companies.length > 1 && (
            <Card className="p-4">
              <form method="GET" className="flex flex-wrap items-end gap-3">
                <Field label={t('company')}>
                  <select name="company" defaultValue={companyId ?? ''} className={inputCls}>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit" variant="secondary">
                  {t('apply')}
                </Button>
              </form>
            </Card>
          )}

          <SectionHeader title={t('detected')} count={candidates.length} />
          {candidates.length === 0 ? (
            <Card className="p-6 text-sm text-muted-foreground">{t('noneDetected')}</Card>
          ) : (
            <form action={calculateBackPayAction} className="space-y-4">
              <input type="hidden" name="companyId" value={companyId ?? ''} />
              <div className={tableWrapCls}>
                <table className="w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      <th className={thCls}></th>
                      <th className={thCls}>{t('employee')}</th>
                      <th className={thCls}>{t('effectiveFrom')}</th>
                      <th className={thCls}>{t('revisedSalary')}</th>
                      <th className={thCls}>{t('keyedOn')}</th>
                      <th className={thCls}>{t('affectedMonths')}</th>
                    </tr>
                  </thead>
                  <tbody className={tbodyCls}>
                    {candidates.map((c) => (
                      <tr key={c.compensationId}>
                        <td className="px-3 py-2">
                          <input type="checkbox" name="compensationId" value={c.compensationId} defaultChecked />
                        </td>
                        <td className="px-3 py-2">
                          {c.employeeName}
                          {c.employeeCode ? <span className="ml-2 text-xs text-muted-foreground">{c.employeeCode}</span> : null}
                        </td>
                        <td className="px-3 py-2">{c.validFrom}</td>
                        <td className="px-3 py-2 tabular-nums">{money(c.newBasic)}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.recordedAt.toISOString().slice(0, 10)}</td>
                        <td className="px-3 py-2 text-xs">{c.affectedPeriods.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('targetPeriod')}</span>
                  <input
                    name="targetPayPeriod"
                    defaultValue={defaultPeriod}
                    pattern={PERIOD_RE.source}
                    placeholder="YYYY-MM"
                    className={inputCls}
                    required
                  />
                </label>
                <Button type="submit">{t('calculate')}</Button>
                <p className="text-xs text-muted-foreground">{t('targetPeriodHint')}</p>
              </div>
            </form>
          )}
        </>
      )}

      {detail && (
        <>
          <SectionHeader title={t('verification')} />
          <Card className="space-y-1 p-4 text-sm">
            <p>
              <span className="text-muted-foreground">{t('company')}: </span>
              {detail.run.companyName}
            </p>
            <p>
              <span className="text-muted-foreground">{t('targetPeriod')}: </span>
              {detail.run.targetPayPeriod}
            </p>
            <p className="flex items-center gap-2">
              <span className="text-muted-foreground">{t('statusLabel')}: </span>
              <Badge variant={STATUS_VARIANT[detail.run.status]}>{t(`status.${detail.run.status}`)}</Badge>
            </p>
            <p>
              <span className="text-muted-foreground">{t('calculatedBy')}: </span>
              {detail.run.createdByName ?? '—'} · {detail.run.createdAt.toISOString().slice(0, 10)}
            </p>
            {detail.run.approvedAt && (
              <p>
                <span className="text-muted-foreground">{t('approvedBy')}: </span>
                {detail.run.approvedByName ?? '—'} · {detail.run.approvedAt.toISOString().slice(0, 10)}
              </p>
            )}
          </Card>

          {/* THE GRID: one line per pay item, one column per affected month, and a total. */}
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('employee')}</th>
                  <th className={thCls}>{t('payItem')}</th>
                  {detail.periods.map((p) => (
                    <th key={p} className={`${thCls} text-right`}>
                      {p}
                    </th>
                  ))}
                  <th className={`${thCls} text-right`}>{t('total')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {detail.rows.map((r) => (
                  <tr key={`${r.employmentId}-${r.payCode}`} className={r.needsReview ? 'bg-amber-50/60 dark:bg-amber-500/5' : ''}>
                    <td className="px-3 py-2">
                      {r.employeeName}
                      {r.employeeCode ? <span className="ml-2 text-xs text-muted-foreground">{r.employeeCode}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      {r.payItemName}
                      {r.needsReview && r.reviewReason && REVIEW_REASONS.includes(r.reviewReason) && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-400">
                          {t(`review.${r.reviewReason}`)}
                        </span>
                      )}
                    </td>
                    {detail.periods.map((p) => {
                      const cell = r.byPeriod[p];
                      return (
                        <td key={p} className="px-3 py-2 text-right tabular-nums">
                          {cell == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : r.needsReview ? (
                            <span className="text-xs text-muted-foreground">{t('needsYourFigure')}</span>
                          ) : (
                            <span className={amountTone(cell.diff)} title={`${money(cell.old)} → ${money(cell.new ?? 0)}`}>
                              {signed(cell.diff)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className={`px-3 py-2 text-right font-medium tabular-nums ${r.needsReview ? '' : amountTone(r.total)}`}>
                      {r.needsReview ? <span className="text-xs text-muted-foreground">—</span> : signed(r.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="px-3 py-2" colSpan={2 + detail.periods.length}>
                    {t('grandTotal')}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${amountTone(detail.total)}`}>{signed(detail.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {detail.run.needsReviewCount > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
              {t('needsReviewNote', { count: detail.run.needsReviewCount })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {(['csv', 'xlsx', 'pdf'] as const).map((f) => (
              <Button key={f} asChild variant="outline" size="sm">
                <Link href={`/payroll/back-pay/export?run=${detail.run.id}&format=${f}`}>{t(`export.${f}`)}</Link>
              </Button>
            ))}
          </div>

          {!detail.targetWritable && (
            <ErrorBanner message={t('errors.targetRunNotDraft')} />
          )}

          <div className="flex flex-wrap items-center gap-3">
            {detail.run.status === 'draft' && (
              <form action={verifyBackPayAction}>
                <input type="hidden" name="runId" value={detail.run.id} />
                <Button type="submit" variant="outline">
                  {t('markVerified')}
                </Button>
              </form>
            )}
            {(detail.run.status === 'draft' || detail.run.status === 'verified') && detail.targetWritable && (
              <form action={approveAndPostBackPayAction}>
                <input type="hidden" name="runId" value={detail.run.id} />
                <Button type="submit">{t('approveAndPost')}</Button>
              </form>
            )}
            {detail.run.status !== 'cancelled' && (
              // Deliberately `outline` + destructive TEXT, not the solid `destructive` variant. Cancel
              // voids a calculated run and belongs in the quiet register the screen already put it in;
              // promoting it to a filled red button while "normalising variants" would make the most
              // dangerous control the loudest thing on the page.
              <form action={cancelBackPayAction}>
                <input type="hidden" name="runId" value={detail.run.id} />
                <Button type="submit" variant="outline" className="text-destructive">
                  {t('cancel')}
                </Button>
              </form>
            )}
            <Link href="/payroll/back-pay" className="text-sm underline">
              {t('backToList')}
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">{t('postingNote')}</p>
        </>
      )}

      <SectionHeader title={t('history')} count={runs.length} />
      {runs.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">{t('noRuns')}</Card>
      ) : (
        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>{t('targetPeriod')}</th>
                <th className={thCls}>{t('company')}</th>
                <th className={thCls}>{t('statusLabel')}</th>
                <th className={`${thCls} text-right`}>{t('employees')}</th>
                <th className={`${thCls} text-right`}>{t('months')}</th>
                <th className={`${thCls} text-right`}>{t('total')}</th>
                <th className={thCls}>{t('calculatedBy')}</th>
                <th className={thCls}></th>
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">{r.targetPayPeriod}</td>
                  <td className="px-3 py-2">{r.companyName}</td>
                  <td className="px-3 py-2">
                    <Badge variant={STATUS_VARIANT[r.status]}>{t(`status.${r.status}`)}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.employeeCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.periodCount}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${amountTone(r.total)}`}>{signed(r.total)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.createdByName ?? '—'} · {r.createdAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/payroll/back-pay?run=${r.id}`} className="text-sm underline">
                      {t('open')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
