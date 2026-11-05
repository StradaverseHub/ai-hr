import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { agreementView, controlTowerView, TARGET_AUTO_CLEAR_RATE, type AgreementView, type ControlTowerView } from '@/core/control-tower';
import { Card, SectionHeader } from '@/components/ui';

/** AI Centre restructure (owner decision 29, 4 November 2026) — the accuracy figures the former Operations overview
 * showed, moved verbatim into Insights › AI quality so AI accuracy has one place:
 *  - "Does the AI agree with us?": three rates per proposal type (ADR-0084 Phase 3 item 5), with the same honest refusal
 *    when there is nothing to stand behind;
 *  - the payroll checks' four figures (auto-clear rate, coverage, false-positive rate, median time to resolution), only
 *    while the tenant holds payroll, as on the overview.
 * The staffing ratio the overview printed beside them is removed (owner decision 26): no figure here is a headcount.
 *
 * Read for an administrator only: the Insights view renders this only for one (its sections are admin-only), and the two
 * readers run under the viewer's row-level security. ⚠️ TWO SEPARATE CALLS ON PURPOSE — see agreementView's header: it
 * reads the proposal ledger, which opens its own transaction, and controlTowerView is one big one; folding them would nest
 * `withTenant` inside `withTenant`, which core/agent-proposal.ts property 2 forbids. A failed read leaves its card out. */
/** `payroll`: the tenant holds payroll, as the page read it (the quiet module reader is page-only). */
export async function CheckAccuracySection({ session, payroll }: { session: SessionContext; payroll: boolean }) {
  const [agreement, view] = await Promise.all([
    agreementView(session).catch(() => null),
    payroll ? controlTowerView(session).catch(() => null) : null,
  ]);
  if (!agreement && !view) return null;
  return (
    <div data-check-accuracy className="space-y-4">
      {agreement && <AgreementCard agreement={agreement} />}
      {view && <PayrollChecksCard view={view} />}
    </div>
  );
}

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const mins = (v: number | null) => (v == null ? '—' : `${Math.round(v / 60)}m`);

async function AgreementCard({ agreement }: { agreement: AgreementView }) {
  const t = await getTranslations('payroll.controlTower');
  return (
    <Card id="ai-quality-agreement" className="scroll-mt-4 p-5" data-agreement>
      <SectionHeader title={t('agreementTitle')} />
      {agreement.rates.length === 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="font-medium text-amber-900 dark:text-amber-200">{t('agreementUnavailable')}</p>
          <ul className="mt-2 space-y-1 text-amber-800 dark:text-amber-300/90">
            {agreement.blockedBy.map(b => <li key={b}>• {t(`agreementBlocked_${b}`)}</li>)}
          </ul>
          <p className="mt-3 text-xs text-amber-800 dark:text-amber-300/90">{t('agreementWhyNotGuessed')}</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="sr-only">{t('agreementTitle')}</caption>
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">{t('colProposalType')}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t('colProposed')}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t('colAdjudicationPass')}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t('colAgreement')}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t('colReversal')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {agreement.rates.map(r => (
                  <tr key={r.type} data-agreement-type={r.type}>
                    {/* ⚠️ `r.type` is a TEXT column, so a type can reach this screen with no translation yet, and a bare t()
                        would throw MISSING_MESSAGE. Fall back to the raw id: ugly beats absent. */}
                    <td className="px-4 py-2.5">{t.has(`proposalType_${r.type}`) ? t(`proposalType_${r.type}`) : r.type}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.total.toLocaleString()}</td>
                    {/* Null renders as an em dash, NEVER as 0%: the rate is null precisely when its denominator is zero. */}
                    <td className="px-4 py-2.5 tabular-nums">{pct(r.adjudicationPassRate)}</td>
                    <td className="px-4 py-2.5 tabular-nums">{pct(r.agreementRate)}</td>
                    <td className="px-4 py-2.5 tabular-nums">{pct(r.reversalRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">{t('agreementDashMeaning')}</p>
          {agreement.closuresPending > 0 && <p className="mt-2 text-xs text-muted-foreground">{t('agreementClosuresPending', { n: agreement.closuresPending })}</p>}
          {agreement.blockedBy.includes('nothing_decided') && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('agreementBlocked_nothing_decided')}</p>}
        </>
      )}
    </Card>
  );
}

async function PayrollChecksCard({ view }: { view: ControlTowerView }) {
  const t = await getTranslations('payroll.controlTower');
  const metric = (label: string, value: string, hint: string) => (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
  return (
    <Card id="ai-quality-payroll-checks" className="scroll-mt-4 p-5" data-payroll-checks>
      <SectionHeader title={t('metricsTitle')} />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {metric(t('mAutoClear'), pct(view.totals.autoClearRate), t('mAutoClearHint', { target: Math.round(TARGET_AUTO_CLEAR_RATE * 100) }))}
        {metric(t('mCoverage'), pct(view.totals.coverage), t('mCoverageHint'))}
        {metric(t('mFalsePositive'), pct(view.totals.falsePositiveRate), view.totals.resolvedFlagged === 0 ? t('mNoSignal') : t('mFalsePositiveHint'))}
        {metric(t('mMttr'), mins(view.totals.mttrSeconds), view.totals.resolvedFlagged === 0 ? t('mNoSignal') : t('mMttrHint'))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t('metricsBasis', { verdicts: view.checks.covered, resolved: view.totals.resolvedFlagged, runs: view.totals.runs })}</p>
      {!view.checks.thresholdsTuned && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('thresholdsUntuned')}</p>}
    </Card>
  );
}
