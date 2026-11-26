import Link from 'next/link';
import { NONCASH_CONFIGURATION_REASONS } from '@/lib/payroll-noncash-error';
import { getLocale, getTranslations } from 'next-intl/server';
import { Badge, Card, EmployeeName, SectionHeader } from '@/components/ui';
import type { RecomputeDisclosureRow, ReprocessEmployeeOutcome } from '@/packs/payroll/service';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import type { PayrollResultRun } from '../../payroll-result-href';
import { reprocessResultHrefs } from './result-links';

const TAX_SELECTION_CODES = new Set(['confirmation_required', 'invalid_scheme', 'not_resident', 'citizenship_unknown', 'custom_value_missing']);
const TAX_CODES = new Set([
  'missing_declaration', 'declaration_revoked', 'declaration_outside_period',
  'not_resident', 'citizenship_unknown', 'overlap',
]);

/**
 * 3244584c — the run-level reason a reprocess stopped, as a message key. A recognised code names the
 * blocker (and what to do); anything else, including jobs recorded before this item, keeps the generic line.
 */
export function reprocessStoppedMessageKey(code: string | null | undefined) {
  return code && REPROCESS_STOPPED_CODES.has(code) ? `reprocessStopped_${code}` : 'reprocessStoppedPartial';
}
const REPROCESS_STOPPED_CODES = new Set(['BATCH_NOT_PROCESSED', 'PERIOD_CLOSED', 'PERMISSION_DENIED', 'SUPERSEDED', 'LATER_CYCLE_FINALIZED', 'TAX_BASIS_SOURCE_CHANGED']);

/** a1a80747 — the job held this employee for income tax recalculation (a skipped outcome that still needs a person). */
export const isReprocessTaxHold = (outcome: Pick<ReprocessEmployeeOutcome, 'status' | 'reasonCode'>) =>
  outcome.status === 'skipped' && (outcome.reasonCode === 'TAX_RECALC_REQUIRED' || outcome.reasonCode === 'TAX_RECALC_IN_PROGRESS');

/** Displays a recorded attempt; it never recalculates or substitutes a current employee profile. */
export async function ReprocessOutcomeStatus({ outcome }: { outcome: ReprocessEmployeeOutcome }) {
  const t = await getTranslations('payroll.batch');
  // 3244584c — an exclusion is the run doing the right thing (neutral); not_eligible still needs a person, and so does
  // an employee held for income tax recalculation (a1a80747).
  return <Badge variant={outcome.status === 'reprocessed' ? 'success' : (outcome.status === 'skipped' && !isReprocessTaxHold(outcome)) || outcome.status === 'excluded' ? 'default' : 'warning'}>
    {t(`reprocessOutcomeStatus.${outcome.status}`)}
  </Badge>;
}

const PAY_ITEM_REPRICE_REASONS = new Set(['formula_failed', 'not_positive', 'zero_divisor', 'input_missing', 'no_longer_calculates']);
const PAY_ITEM_QUANTITY_UNITS = new Set(['hours', 'days', 'qty', 'units']);

export async function ReprocessOutcomeRemarks({
  outcome, batchId, from, jobId, currency = null, taxReviewHref = null,
}: { outcome: ReprocessEmployeeOutcome; batchId: string; from?: string; jobId?: string; currency?: string | null;
  /** a1a80747 — Income Tax Recalculation for this run, or null when the viewer may not open it. */
  taxReviewHref?: string | null }) {
  const t = await getTranslations('payroll.batch');
  const tp = await getTranslations('payroll.process');
  const locale = await getLocale();
  const noncashReason = outcome.validationDetails?.length === 1 ? outcome.validationDetails[0].gap : '';
  // 3244584c — WHY the employee no longer belongs to the month, with the date that decided it.
  const exclusionDate = outcome.validationDetails?.[0]?.date;
  // ad6ed930 — a transaction dated after the employee's last day is not a formula fault: the remark names the
  // leaving date and the way forward, and does not send HR to Payroll Items.
  const leftOn = outcome.reasonCode === 'PAY_ITEM_FORMULA_FAILED' && outcome.formulaFailure?.reason === 'after_leaving_date'
    ? outcome.formulaFailure.leftOn ?? null : null;
  // a1a80747 — held for income tax recalculation: the tax readiness reason (blocked) is the detail, not a gap code.
  const taxHold = isReprocessTaxHold(outcome);
  const taxHoldReason = outcome.reasonCode === 'TAX_RECALC_REQUIRED' ? outcome.validationDetails?.[0]?.gap ?? null : null;
  const fullReason = leftOn ? t('reprocessPayItemAfterLeavingDate', { date: formatDate(leftOn) })
    : taxHold ? t(outcome.reasonCode === 'TAX_RECALC_IN_PROGRESS' ? 'reprocessTaxRecalcInProgress' : 'reprocessTaxRecalcRequired')
    : outcome.status === 'excluded' || outcome.status === 'not_eligible'
    ? t(`reprocessExclusion_${outcome.reasonCode}${exclusionDate ? 'Dated' : ''}`, exclusionDate ? { date: formatDate(exclusionDate) } : {})
    : outcome.status === 'skipped' ? t('reprocessNothingPayableFull')
    // 289634a6 — an imported month's Income Tax Correction superseded by a newer import is said so plainly. The generic
    // "previous correction retained" sentence stays only for a genuine retained/replayed correction elsewhere.
    : outcome.status === 'reprocessed' && outcome.taxCorrectionsReplaced?.length
      ? [t('reprocessTaxCorrectionReplacedByImport', { periods: outcome.taxCorrectionsReplaced.map(entry => entry.period).join(', ') }),
        ...(outcome.taxBasisRecalculated ? [t('reprocessTaxBasisUpdated')] : [])].join(' ')
    : outcome.status === 'reprocessed' ? t(outcome.taxBasisRecalculated ? 'reprocessTaxBasisUpdated' : 'reprocessSucceededReason')
    : outcome.reasonCode === 'PAY_ITEM_FORMULA_FAILED' ? t('reprocessPayItemFormulaReason')
    : outcome.reasonCode === 'TAX_SCHEME_CONFIGURATION_INCOMPLETE' && TAX_SELECTION_CODES.has(outcome.validationCode ?? '')
      ? tp(`taxSelection_${outcome.validationCode}`)
    : outcome.validationCode === 'payroll_tax_evidence' && noncashReason ? t('reprocessTaxEvidenceIssue', { reason: noncashReason })
    : outcome.validationCode === 'pcb_non_cash_configuration_invalid'
      ? tp(NONCASH_CONFIGURATION_REASONS.has(noncashReason) ? `nonCash_${noncashReason}` : 'nonCash_configuration_invalid')
    : outcome.reasonCode === 'TAX_SCHEME_CONFIGURATION_INCOMPLETE' && TAX_CODES.has(outcome.validationCode ?? '')
      ? tp(`taxScheme_${outcome.validationCode}`)
      : outcome.validationCode === 'pcb_child_relief_configuration_invalid'
        ? t('reprocessChildConfigurationReason') : t('reprocessConfigurationReason');
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (jobId) query.set('job', jobId);
  const taxHref = `/payroll/${batchId}/tax-configuration/${outcome.employmentId}${query.size ? `?${query}` : ''}`;
  const failure = outcome.reasonCode === 'PAY_ITEM_FORMULA_FAILED' ? outcome.formulaFailure : undefined;
  return <div className="space-y-1 text-xs">
    <p className={taxHold ? 'font-medium text-amber-800 dark:text-amber-300' : undefined}>
      {outcome.status === 'skipped' && !taxHold ? t('reprocessNothingPayableShort') : fullReason}
    </p>
    {taxHoldReason && <p className="text-muted-foreground" data-testid="reprocess-tax-hold-reason">{taxHoldReason}</p>}
    {taxHold && <p className="text-muted-foreground">{t('reprocessTaxRecalcNext')}</p>}
    {taxHold && taxReviewHref && <Link href={taxReviewHref} target="_blank" rel="noopener noreferrer" className="inline-block text-primary hover:underline">
      {t('reprocessOpenTaxReview')}
    </Link>}
    {/* 792053e5 — which Pay Item an updated formula re-priced, for how many transactions, old and new amounts. */}
    {outcome.status === 'reprocessed' && outcome.repricedItems?.map(item => <div key={item.componentId} className="rounded-md bg-muted/60 px-2 py-1.5" data-testid="reprocess-repriced-item">
      <p>{t('reprocessPayItemRepriced', { name: item.name })}</p>
      <p className="font-medium tabular-nums">{t('reprocessPayItemRepricedDetail', {
        count: item.count,
        quantity: item.unit && PAY_ITEM_QUANTITY_UNITS.has(item.unit) && item.quantity > 0 ? t(`reprocessPayItemQuantity_${item.unit}`, { qty: item.quantity.toFixed(2) }) : '',
        before: formatMoney(item.before, currency), after: formatMoney(item.after, currency),
      })}</p>
    </div>)}
    {failure && <div className="rounded-md bg-red-50 px-2 py-1.5 text-red-800 dark:bg-red-500/10 dark:text-red-300" role="alert" data-testid="reprocess-formula-failure">
      <p><strong>{t(leftOn ? 'reprocessPayItemDatedAfterLeaving' : 'reprocessPayItemFormulaFailed', { name: failure.name, code: failure.code, count: failure.dates.length, dates: failure.dates.map(d => formatDate(d)).join(', ') })}</strong></p>
      {!leftOn && PAY_ITEM_REPRICE_REASONS.has(failure.reason) && <p>{t(`reprocessPayItemReason_${failure.reason}`)}</p>}
      {failure.detail && <p className="text-red-700/80 dark:text-red-300/80">{failure.detail}</p>}
    </div>}
    {failure && <p className="space-x-3">
      {!leftOn && <Link href={`/admin/pay-components/${encodeURIComponent(failure.code)}`} className="text-primary hover:underline">{t('reprocessOpenPayItem')}</Link>}
      <Link href="/payroll/transactions/individual" className="text-primary hover:underline">{t('reprocessOpenTransactions')}</Link>
    </p>}
    {outcome.status === 'excluded' && outcome.historyId && <p className="text-muted-foreground">{t('reprocessExcludedRemoved')}</p>}
    {outcome.status === 'not_eligible' && <p className="font-medium text-amber-800 dark:text-amber-300">
      {t(outcome.validationCode === 'last_on_run' ? 'reprocessNotEligibleLastOnRun' : 'reprocessNotEligibleRemovalOff')}
    </p>}
    {outcome.resultRetained && outcome.status !== 'not_eligible' && <p className="font-medium text-amber-800 dark:text-amber-300">{t('reprocessPreviousResultRetained')}</p>}
    {outcome.status === 'skipped' && !taxHold && <details className="text-muted-foreground">
      <summary className="cursor-pointer text-primary">{t('reprocessOutcomeDetails')}</summary>
      <p className="pt-1">{fullReason}</p>
    </details>}
    {outcome.reasonCode === 'TAX_SCHEME_CONFIGURATION_INCOMPLETE' && <Link href={taxHref} className="inline-block text-primary hover:underline">
      {t('reprocessReviewTaxConfiguration')}
    </Link>}
    {outcome.validationCode === 'pcb_child_relief_configuration_invalid' && <Link href="/payroll/configuration/pcb" className="inline-block text-primary hover:underline">
      {t('reprocessReviewPcbConfiguration')}
    </Link>}
    <p className="text-muted-foreground">{t('reprocessOutcomeRecordedAt', { at: new Intl.DateTimeFormat(locale, {
      timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(outcome.at)) })}</p>
  </div>;
}

export async function ReprocessOutcomePanel({ outcomes, history, slips, run, currency, batchId, from, jobId, selected, stopped, stoppedCode, stoppedEmployee, taxReviewHref = null }: {
  outcomes: readonly ReprocessEmployeeOutcome[];
  history: readonly RecomputeDisclosureRow[];
  slips: readonly { id: string; employmentId: string; version: number }[];
  run: PayrollResultRun;
  currency: string | null;
  batchId: string;
  from?: string;
  jobId: string;
  selected: number;
  stopped: boolean;
  /** 3244584c — the job's recorded run-level reason (payroll_reprocess_job.error), when it stopped. */
  stoppedCode?: string | null;
  stoppedEmployee?:{employmentId:string;name:string;employeeCode:string|null}|null;
  /** a1a80747 — Income Tax Recalculation for this run, when the viewer holds payroll.tax-basis.view; else null. */
  taxReviewHref?: string | null;
}) {
  const t = await getTranslations('payroll.batch');
  const ts = await getTranslations('people.detail.incentiveDeclarations');
  const resultHrefs = reprocessResultHrefs(outcomes.map(outcome => ({...outcome, id:outcome.employmentId})), slips, run, from);
  const byHistory = new Map(history.map(row => [row.id, row]));
  const counts = { reprocessed: 0, skipped: 0, validation_failed: 0, excluded: 0, not_eligible: 0 };
  for (const outcome of outcomes) counts[outcome.status]++;
  return <Card className="overflow-hidden">
    <SectionHeader title={t('reprocessOutcomeTitle')} count={outcomes.length} />
    {/* a1a80747 — the totals: Selected, Reprocessed, Skipped (nothing payable and held for income tax recalculation)
        and Failed (configuration incomplete, and the employee a stopped run stopped at). */}
    <dl className="grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-4" data-testid="reprocess-outcome-totals">
      {([
        ['reprocessTotalSelected', selected, 'text-foreground'],
        ['reprocessTotalReprocessed', counts.reprocessed, 'text-emerald-700 dark:text-emerald-400'],
        ['reprocessTotalSkipped', counts.skipped, 'text-amber-700 dark:text-amber-400'],
        ['reprocessTotalFailed', counts.validation_failed+(stopped&&stoppedEmployee?1:0), 'text-red-700 dark:text-red-400'],
      ] as const).map(([key, value, tone]) => <div key={key} className="flex flex-col-reverse rounded-lg border border-border px-3 py-2">
        <dt className="text-xs text-muted-foreground">{t(key)}</dt>
        <dd className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</dd>
      </div>)}
    </dl>
    {counts.excluded + counts.not_eligible > 0 && <p className="-mt-2 px-4 pb-3 text-sm">{t('reprocessOutcomeExclusionSummary', {
      excluded: counts.excluded, notEligible: counts.not_eligible,
    })}</p>}
    {stopped && <p className="border-y border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      {t(reprocessStoppedMessageKey(stopped ? stoppedCode : null))}
    </p>}
    {stoppedEmployee&&stopped&&<p className="px-4 py-3 text-sm" role="alert"><strong>{t('reprocessFailedEmployee')}: </strong><EmployeeName name={stoppedEmployee.name} code={stoppedEmployee.employeeCode}/></p>}
    {selected>outcomes.length+(stopped&&stoppedEmployee?1:0)&&<p className="px-4 py-3 text-sm" role="status">{t('reprocessPendingEmployees',{count:selected-outcomes.length-(stopped&&stoppedEmployee?1:0)})}</p>}
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>
          <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
          <th className="px-3 py-2 font-medium">{t('reprocessOutcomeStatusHeading')}</th>
          <th className="px-3 py-2 font-medium">{t('reprocessOutcomeCategoryHeading')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('reprocessColNetBefore')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('reprocessColNetAfter')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('reprocessPcbBefore')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('reprocessPcbAfter')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('reprocessPcbDifference')}</th>
          <th className="px-3 py-2 font-medium">{t('reprocessOutcomeRemarksHeading')}</th>
        </tr></thead>
        <tbody className="divide-y divide-border">{outcomes.map(outcome => {
          const snapshot = outcome.historyId ? byHistory.get(outcome.historyId) : undefined;
          const exactSnapshot = snapshot?.employmentId === outcome.employmentId
            && snapshot.diff.versionBefore === outcome.versionBefore && snapshot.diff.versionAfter === outcome.versionAfter
            ? snapshot : undefined;
          const href = resultHrefs.get(outcome.employmentId);
          const scheme = outcome.effectiveTaxScheme ?? outcome.configuredTaxScheme;
          return <tr key={outcome.employmentId}>
            <td className="px-3 py-3 font-medium">{href ? <Link href={href} className="text-primary hover:underline">
              <EmployeeName name={outcome.name} code={outcome.employeeCode} />
            </Link> : <EmployeeName name={outcome.name} code={outcome.employeeCode} />}</td>
            <td className="px-3 py-3"><ReprocessOutcomeStatus outcome={outcome} /></td>
            <td className="px-3 py-3 text-xs">{scheme ? ts(`scheme_${scheme}`) : '—'}</td>
            <td className="px-3 py-3 text-right tabular-nums">{exactSnapshot && outcome.classification !== 'added' ? formatMoney(exactSnapshot.diff.netBefore, currency) : '—'}</td>
            <td className="px-3 py-3 text-right tabular-nums">{exactSnapshot ? formatMoney(exactSnapshot.diff.netAfter, currency) : '—'}</td>
            <td className="px-3 py-3 text-right tabular-nums">{exactSnapshot?.pcbBefore!=null?formatMoney(exactSnapshot.pcbBefore,currency):'—'}</td>
            <td className="px-3 py-3 text-right tabular-nums">{exactSnapshot?.pcbAfter!=null?formatMoney(exactSnapshot.pcbAfter,currency):'—'}</td>
            <td className="px-3 py-3 text-right tabular-nums">{exactSnapshot?.pcbBefore!=null&&exactSnapshot.pcbAfter!=null?formatMoney(Math.round((exactSnapshot.pcbAfter-exactSnapshot.pcbBefore)*100)/100,currency):'—'}</td>
            <td className="max-w-sm px-3 py-3"><ReprocessOutcomeRemarks outcome={outcome} batchId={batchId} from={from} jobId={jobId} currency={currency} taxReviewHref={taxReviewHref} /></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </Card>;
}
