import Link from 'next/link';
import { NONCASH_CONFIGURATION_REASONS } from '@/lib/payroll-noncash-error';
import { getLocale, getTranslations } from 'next-intl/server';
import { Badge, Card, EmployeeName, SectionHeader } from '@/components/ui';
import type { RecomputeDisclosureRow, ReprocessEmployeeOutcome } from '@/packs/payroll/service';
import { formatMoney } from '@/lib/money';
import type { PayrollResultRun } from '../../payroll-result-href';
import { reprocessResultHrefs } from './result-links';

const TAX_SELECTION_CODES = new Set(['confirmation_required', 'invalid_scheme', 'not_resident', 'citizenship_unknown']);
const TAX_CODES = new Set([
  'missing_declaration', 'declaration_revoked', 'declaration_outside_period',
  'not_resident', 'citizenship_unknown', 'overlap',
]);

/** Displays a recorded attempt; it never recalculates or substitutes a current employee profile. */
export async function ReprocessOutcomeStatus({ outcome }: { outcome: ReprocessEmployeeOutcome }) {
  const t = await getTranslations('payroll.batch');
  return <Badge variant={outcome.status === 'reprocessed' ? 'success' : outcome.status === 'skipped' ? 'default' : 'warning'}>
    {t(`reprocessOutcomeStatus.${outcome.status}`)}
  </Badge>;
}

export async function ReprocessOutcomeRemarks({
  outcome, batchId, from, jobId,
}: { outcome: ReprocessEmployeeOutcome; batchId: string; from?: string; jobId?: string }) {
  const t = await getTranslations('payroll.batch');
  const tp = await getTranslations('payroll.process');
  const locale = await getLocale();
  const noncashReason = outcome.validationDetails?.length === 1 ? outcome.validationDetails[0].gap : '';
  const fullReason = outcome.status === 'skipped' ? t('reprocessNothingPayableFull')
    : outcome.status === 'reprocessed' ? t('reprocessSucceededReason')
    : outcome.reasonCode === 'TAX_SCHEME_CONFIGURATION_INCOMPLETE' && TAX_SELECTION_CODES.has(outcome.validationCode ?? '')
      ? tp(`taxSelection_${outcome.validationCode}`)
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
  return <div className="space-y-1 text-xs">
    <p>{outcome.status === 'skipped' ? t('reprocessNothingPayableShort') : fullReason}</p>
    {outcome.resultRetained && <p className="font-medium text-amber-800 dark:text-amber-300">{t('reprocessPreviousResultRetained')}</p>}
    {outcome.status === 'skipped' && <details className="text-muted-foreground">
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

export async function ReprocessOutcomePanel({ outcomes, history, slips, run, currency, batchId, from, jobId, selected, stopped }: {
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
}) {
  const t = await getTranslations('payroll.batch');
  const ts = await getTranslations('people.detail.incentiveDeclarations');
  const resultHrefs = reprocessResultHrefs(outcomes.map(outcome => ({...outcome, id:outcome.employmentId})), slips, run, from);
  const byHistory = new Map(history.map(row => [row.id, row]));
  const counts = { reprocessed: 0, skipped: 0, validation_failed: 0 };
  for (const outcome of outcomes) counts[outcome.status]++;
  return <Card className="overflow-hidden">
    <SectionHeader title={t('reprocessOutcomeTitle')} count={outcomes.length} />
    <p className="px-4 pb-3 text-sm">{t('reprocessOutcomeSummary', {
      selected, succeeded: counts.reprocessed, skipped: counts.skipped, failed: counts.validation_failed,
    })}</p>
    {(stopped || outcomes.length < selected) && <p className="border-y border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      {t('reprocessStoppedPartial')}
    </p>}
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>
          <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
          <th className="px-3 py-2 font-medium">{t('reprocessOutcomeStatusHeading')}</th>
          <th className="px-3 py-2 font-medium">{t('reprocessOutcomeCategoryHeading')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('reprocessColNetBefore')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('reprocessColNetAfter')}</th>
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
            <td className="max-w-sm px-3 py-3"><ReprocessOutcomeRemarks outcome={outcome} batchId={batchId} from={from} jobId={jobId} /></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </Card>;
}
