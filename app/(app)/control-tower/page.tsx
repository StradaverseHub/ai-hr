import Link from 'next/link';
import { isModuleEnabled } from '@/core/entitlements';
import { orchestrationQueue } from '@/core/hr-orchestrator';
import { OrchestrationWorkQueue } from './work-queue';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { agreementView, controlTowerView, EXCEPTIONS_PER_OPERATOR_PER_CYCLE, TARGET_AUTO_CLEAR_RATE } from '@/core/control-tower';
import { Card, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';

/** ADR-0109: shared operations workspace, with payroll and AI quality evidence retained below. */
export default async function ControlTowerPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const s = await requireAdmin();
  const queue = await orchestrationQueue(s);
  const sp = await searchParams;
  const orchestration = await getTranslations('controlTower.orchestrator');
  const t = await getTranslations('payroll.controlTower');
  const view = isModuleEnabled(s, 'payroll') ? await controlTowerView(s) : null;
  // ⚠️ A SECOND, SEPARATE CALL ON PURPOSE — see agreementView's header. It reads the proposal ledger,
  // which opens its own transaction, and controlTowerView is one big one. Folding this into that view
  // would nest `withTenant` inside `withTenant`, which core/agent-proposal.ts property 2 forbids.
  const agreement = await agreementView(s);

  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const mins = (v: number | null) => (v == null ? '—' : `${Math.round(v / 60)}m`);

  return (
    <div data-tour="intelligence-control-tower" className={pageWideCls}>
      <PageHeader title={t('title')} description={t('description')} />

      <OrchestrationWorkQueue view={queue} refresh={sp.refresh} canViewRuns={isGroupAdmin(s)} />
      <details className="space-y-5 rounded-xl border border-border p-5">
        <summary className="cursor-pointer text-base font-semibold focus-visible:outline-2 focus-visible:outline-primary">{orchestration('quality')}</summary>

      {view && <>
      {/* ── THE RATIO. The question the tower exists to answer, and the honest refusal when it cannot. ── */}
      <Card className="p-5">
        <SectionHeader title={t('ratioTitle')} />
        {view.ratio.impliedOperators == null ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
            <p className="font-medium text-amber-900 dark:text-amber-200">{t('ratioUnavailable')}</p>
            <ul className="mt-2 space-y-1 text-amber-800 dark:text-amber-300/90">
              {view.ratio.blockedBy.map((b) => (
                <li key={b}>• {t(`blocked_${b}`)}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-amber-800 dark:text-amber-300/90">{t('ratioWhyNotGuessed')}</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-8">
            <div>
              <p className="text-4xl font-semibold tabular-nums">{view.ratio.impliedOperators}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('impliedOperators')}</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{view.ratio.covered.toLocaleString()}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('employeesCovered')}</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{view.ratio.exceptions.toLocaleString()}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('exceptionsThisCycle')}</p>
            </div>
            <p className="max-w-md text-xs text-muted-foreground">
              {t('ratioAssumption', { n: EXCEPTIONS_PER_OPERATOR_PER_CYCLE })}
            </p>
          </div>
        )}
      </Card>

      {/* ── The four north-star metrics. Coverage is deliberately second, next to the clear rate. ── */}
      <Card className="p-5">
        <SectionHeader title={t('metricsTitle')} />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric
            label={t('mAutoClear')}
            value={pct(view.totals.autoClearRate)}
            hint={t('mAutoClearHint', { target: Math.round(TARGET_AUTO_CLEAR_RATE * 100) })}
          />
          <Metric label={t('mCoverage')} value={pct(view.totals.coverage)} hint={t('mCoverageHint')} />
          <Metric
            label={t('mFalsePositive')}
            value={pct(view.totals.falsePositiveRate)}
            hint={view.totals.resolvedFlagged === 0 ? t('mNoSignal') : t('mFalsePositiveHint')}
          />
          <Metric
            label={t('mMttr')}
            value={mins(view.totals.mttrSeconds)}
            hint={view.totals.resolvedFlagged === 0 ? t('mNoSignal') : t('mMttrHint')}
          />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          {t('metricsBasis', {
            verdicts: view.ratio.covered,
            resolved: view.totals.resolvedFlagged,
            runs: view.totals.runs,
          })}
        </p>
        {!view.ratio.thresholdsTuned && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('thresholdsUntuned')}</p>
        )}
      </Card>


      </>}
      {/* ── ADR-0084 Phase 3 item 5 — DOES THE AI AGREE WITH US? Three rates per proposal type, and the
             same honest refusal the ratio card makes when there is nothing to stand behind. ── */}
      <Card className="p-5">
        <SectionHeader title={t('agreementTitle')} />
        {agreement.rates.length === 0 ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
            <p className="font-medium text-amber-900 dark:text-amber-200">{t('agreementUnavailable')}</p>
            <ul className="mt-2 space-y-1 text-amber-800 dark:text-amber-300/90">
              {agreement.blockedBy.map((b) => (
                <li key={b}>• {t(`agreementBlocked_${b}`)}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-amber-800 dark:text-amber-300/90">{t('agreementWhyNotGuessed')}</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('colProposalType')}</th>
                    <th className="px-4 py-2 font-medium">{t('colProposed')}</th>
                    <th className="px-4 py-2 font-medium">{t('colAdjudicationPass')}</th>
                    <th className="px-4 py-2 font-medium">{t('colAgreement')}</th>
                    <th className="px-4 py-2 font-medium">{t('colReversal')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {agreement.rates.map((r) => (
                    <tr key={r.type}>
                      {/* ⚠️ `r.type` is a TEXT column, and ProposalTypeId is a TypeScript union rather
                          than a SQL CHECK (see 0452's header) — so a type can reach this screen that has
                          no translation yet, and a bare t() would throw MISSING_MESSAGE and take the
                          whole Control Tower down. Fall back to the raw id: ugly beats absent. */}
                      <td className="px-4 py-2.5">
                        {t.has(`proposalType_${r.type}`) ? t(`proposalType_${r.type}`) : r.type}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{r.total.toLocaleString()}</td>
                      {/* Every one of these renders null as an em dash, NEVER as 0% — the rate is null
                          precisely when its denominator is zero, and "0% agreement because nobody has
                          decided anything" is a claim about accuracy that nothing supports. */}
                      <td className="px-4 py-2.5 tabular-nums">{pct(r.adjudicationPassRate)}</td>
                      <td className="px-4 py-2.5 tabular-nums">{pct(r.agreementRate)}</td>
                      {/* ⚠️ Reversal matters most (§2.4). r249 gave it a writer, but the view still
                          blanks it per type until at least one closure has actually been TESTED by the
                          employee's next payroll — "0% reversed" off an untested denominator is the same
                          lie as "0% agreement" off an undecided one. See REVERSAL_HAS_A_WRITER. */}
                      <td className="px-4 py-2.5 tabular-nums">{pct(r.reversalRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">{t('agreementDashMeaning')}</p>
            {/* r249 — a closure is only TESTED when the employee is next paid. Saying how many are still
                untested is what stops "no fix has failed" being read off a denominator that is mostly
                unexamined; agreementView blanks the rate entirely while NONE has been tested. */}
            {agreement.closuresPending > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('agreementClosuresPending', { n: agreement.closuresPending })}
              </p>
            )}
            {agreement.blockedBy.includes('nothing_decided') && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('agreementBlocked_nothing_decided')}</p>
            )}
          </>
        )}
      </Card>

      {view && <>
      {/* ── The queue, across every open run. The per-run screen is where the work is done. ── */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('runsTitle')} count={view.runs.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
                <th className="px-4 py-2 font-medium">{t('colEmployees')}</th>
                <th className="px-4 py-2 font-medium">{t('colCleared')}</th>
                <th className="px-4 py-2 font-medium">{t('colReview')}</th>
                <th className="px-4 py-2 font-medium">{t('colBlocked')}</th>
                <th className="px-4 py-2 font-medium">{t('colWaiting')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.runs.map((r) => (
                <tr key={r.batchId}>
                  <td className="px-4 py-2.5">{r.companyName}</td>
                  <td className="px-4 py-2.5 tabular-nums">{r.payPeriod}</td>
                  <td className="px-4 py-2.5 tabular-nums">{r.employees}</td>
                  {/* A run the evaluator has never seen shows "not checked", never 100% — see the
                      autoClearRate null in core/control-tower.ts. */}
                  <td className="px-4 py-2.5 tabular-nums">
                    {r.autoClearRate == null ? (
                      <span className="text-muted-foreground">{t('notChecked')}</span>
                    ) : (
                      `${r.autoClear} · ${pct(r.autoClearRate)}`
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{r.review}</td>
                  <td className="px-4 py-2.5 tabular-nums">{r.block}</td>
                  <td className="px-4 py-2.5">
                    {r.unresolvedFlagged > 0 ? (
                      <span className="inline-block rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        {r.unresolvedFlagged}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      href={`/payroll/${r.batchId}/anomalies`}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      {t('openQueue')}
                    </Link>
                  </td>
                </tr>
              ))}
              {view.runs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noRuns')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      </>}
      </details>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}
