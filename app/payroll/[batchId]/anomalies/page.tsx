import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { withTenant } from '@/db/client';
import { batchDetail } from '@/core/payroll';
import {
  anomalyMetrics,
  anomalyQueue,
  evaluateCircuitBreaker,
  type QueueRow,
} from '@/core/payroll-anomaly';
import { Button, Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { evaluateAnomaliesAction, narrateAnomalyAction, resolveAnomalyAction } from '../../actions';

/**
 * ADR-0076 slice 6 — the exceptions queue. ADR-0074 calls this "the analyst's whole day".
 *
 * THE PAGE IS BUILT AROUND ONE CLAIM IT MUST NOT LET ANYONE MAKE: that a high clear rate means the run is
 * fine. It does not, if few checks could run. So the cleared figure and the COVERAGE figure sit side by
 * side in the same strip, the same size, with the coverage help text underneath — and on a first cycle,
 * where three detectors cannot run at all, coverage visibly is not 100%.
 *
 * WORST FIRST, UNRESOLVED FIRST. The ordering is done in `anomalyQueue`, not here, so the queue and any
 * later surface (a digest, an export) cannot disagree about what "top of the list" means.
 *
 * NOTHING ON THIS PAGE CHANGES A FIGURE. Running the checks reads payslips and writes verdicts; resolving
 * one records a human's judgement. Neither touches pay. The only thing a verdict can do to the money path
 * is REFUSE a close, which is the batch page's business.
 *
 * A NOTE ON WHO CAN SEE THIS: verdicts are payroll-admin-only by RLS, deliberately unlike payslips, which
 * an employee may read about themselves. A verdict is an operator's working note about a person — "confirm
 * the employee actually worked" — and early cycles are expected to produce false positives.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** Every number a finding prints comes from `facts`; the model never produced any of them. */
function factLine(facts: Record<string, string | number>): string {
  return Object.entries(facts)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`)
    .join(' · ');
}

const TONE: Record<string, string> = {
  block: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200',
  review:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
  auto_clear:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
};

export default async function AnomaliesPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const { batchId } = await params;
  // Same shape-check as the batch page: an unmatched /payroll/<segment>/anomalies must 404, not 500 on a
  // Postgres "invalid input syntax for type uuid".
  if (!UUID_RE.test(batchId)) notFound();

  // requireAdmin resolves the session itself and redirects a non-admin away; verdicts are
  // payroll-admin-only by RLS, so the route gate and the row gate agree.
  const s = await requireAdmin();
  const t = await getTranslations('anomaly');
  const sp = await searchParams;

  const batch = await batchDetail(s, batchId).catch(() => null);
  if (!batch) notFound();

  const [rows, metrics, swing] = await Promise.all([
    anomalyQueue(s, { batchId }),
    anomalyMetrics(s, { batchId }),
    withTenant(s, (tx) => evaluateCircuitBreaker(tx, s.tenantId, batchId)),
  ]);

  const everRun = metrics.total > 0;
  const flagged = rows.filter((r) => r.disposition !== 'auto_clear');
  const cleared = rows.filter((r) => r.disposition === 'auto_clear');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* 9066bd6c — the back link MOVED INTO PageHeader rather than being added: this screen already had
          one, hand-rolled above the header in its own smaller type. Same destination and the same
          (already translated) label; what changes is that it now renders in the one place every other
          screen puts it, so "does this screen have Back?" is answerable by looking at the header. */}
      <PageHeader
        back={{ href: `/payroll/${batchId}`, label: t('backToBatch') }}
        title={t('title')}
        description={t('subtitle')}
      />

      <ErrorBanner message={sp.error} />
      {sp.toast ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
          {sp.toast}
        </div>
      ) : null}

      {!everRun ? (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">{t('neverRun')}</p>
          <form action={evaluateAnomaliesAction} className="mt-4">
            <input type="hidden" name="batchId" value={batchId} />
            <Button type="submit" size="sm">
              {t('runNow')}
            </Button>
          </form>
        </Card>
      ) : (
        <>
          {/* THE MEASUREMENT STRIP. Cleared and coverage are the same size on purpose — see the file
              header. A 100% clear rate on 60% coverage is a thin bill of health, not a clean one. */}
          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">{t('metricAutoClear')}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{pct(metrics.autoClearRate)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('metricCoverage')}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{pct(metrics.coverage)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('metricFlagged')}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {Math.round(metrics.flaggedPerThousand)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('metricUnresolved')}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{metrics.unresolvedFlagged}</p>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">{t('coverageHelp')}</p>
            {metrics.block > 0 ? (
              <p className="mt-2 text-[11px] font-medium text-rose-700 dark:text-rose-300">{t('blockedHelp')}</p>
            ) : null}
            <form action={evaluateAnomaliesAction} className="mt-4">
              <input type="hidden" name="batchId" value={batchId} />
              <Button type="submit" size="sm" variant="secondary">
                {t('runAgain')}
              </Button>
            </form>
          </Card>

          {/* The run-level breaker: a global mis-key moves everyone together, so no per-employee row
              can show it. It is reported whether or not it tripped, because "checked and fine" is
              information too. */}
          <Card className="p-5">
            <SectionHeader title={t('circuitBreakerHeading')} />
            <p
              className={`mt-2 rounded-md border p-3 text-xs ${
                swing.tripped ? TONE.block : swing.skippedReason ? '' : TONE.auto_clear
              }`}
            >
              {swing.skippedReason
                ? t('circuitBreakerSkipped', { reason: swing.skippedReason })
                : swing.tripped
                  ? t('circuitBreakerTripped', {
                      movement: swing.movementPct ?? 0,
                      threshold: swing.thresholdPct,
                    })
                  : t('circuitBreakerOk', { movement: swing.movementPct ?? 0, threshold: swing.thresholdPct })}
            </p>
          </Card>
        </>
      )}

      {everRun && flagged.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="font-medium">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
        </Card>
      ) : null}

      {flagged.map((row) => (
        <VerdictCard key={row.verdictId} row={row} batchId={batchId} explainLabel={t('explain')} />
      ))}

      {/* Cleared employees are listed, not hidden. They are the denominator of the clear rate, and the
          only place a human can tell us we MISSED something — which ADR-0076 §5 says has to be possible
          from day one because a false-negative rate cannot be backfilled. */}
      {cleared.length > 0 ? (
        <Card className="p-5">
          <SectionHeader title={`${t('dispositionAutoClear')} · ${cleared.length}`} />
          <p className="mt-1 text-[11px] text-muted-foreground">{t('raiseHelp')}</p>
          <ul className="mt-3 divide-y text-sm">
            {cleared.map((r) => (
              <li key={r.verdictId} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2">
                  {r.employeeName}
                  {r.employeeCode ? <EmployeeCode code={r.employeeCode} /> : null}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {r.detectorsSkipped.length > 0
                    ? t('skipped', { count: r.detectorsSkipped.length })
                    : t('skippedNone')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

// `explainLabel` is passed in rather than resolved here: this is a plain (non-async) component and
// getTranslations belongs to the page, which is also where every other string on this screen comes from.
function VerdictCard({ row, batchId, explainLabel }: { row: QueueRow; batchId: string; explainLabel: string }) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-medium">
            {row.employeeName}
            {row.employeeCode ? <EmployeeCode code={row.employeeCode} /> : null}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {row.detectorsSkipped.length > 0 ? `${row.detectorsSkipped.length} skipped` : 'all checks ran'}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${TONE[row.disposition]}`}>
          {row.disposition}
        </span>
      </div>

      <ul className="mt-3 space-y-2">
        {row.findings.map((f, i) => (
          <li key={`${f.detectorId}-${i}`} className={`rounded-md border p-3 text-xs ${TONE[f.severity] ?? ''}`}>
            <p className="font-medium">{f.detectorId}</p>
            {/* ADR-0076 §2.6 — the plain-words explanation, when an operator has asked for one. It sits
                ABOVE the facts and never replaces them: it is a reading of the evidence, and the evidence
                stays on the row so the classification can still be checked rather than taken on trust.
                Absent for a tenant with no AI provider, and the row reads exactly as it always has. */}
            {f.narrative && <p className="mt-1 text-[12px] leading-snug">{f.narrative}</p>}
            {/* The facts ARE the evidence. Rendered verbatim rather than summarised, so the operator can
                check the classification rather than take it on trust. */}
            <p className="mt-1 font-mono text-[11px] opacity-80">{factLine(f.facts)}</p>
          </li>
        ))}
      </ul>

      {/* Only offered while there is something to narrate — a row whose findings all carry prose has
          nothing to spend a provider call on, and a button that silently does nothing is worse than none. */}
      {row.findings.some((f) => !f.narrative) && (
        <form action={narrateAnomalyAction} className="mt-3">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="verdictId" value={row.verdictId} />
          <button type="submit" className="text-[11px] font-medium text-primary underline-offset-2 hover:underline">
            {explainLabel}
          </button>
        </form>
      )}

      {row.resolvedAt ? (
        <p className="mt-3 text-[11px] text-muted-foreground">{`resolved: ${row.resolution ?? ''}`}</p>
      ) : (
        <form action={resolveAnomalyAction} className="mt-4 space-y-2">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="verdictId" value={row.verdictId} />
          <input name="note" placeholder="note (optional)" className={inputCls} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" name="resolution" value="accepted" variant="secondary">
              correct as it stands
            </Button>
            <Button type="submit" size="sm" name="resolution" value="fixed_upstream" variant="secondary">
              fixed at the source
            </Button>
            <Button type="submit" size="sm" name="resolution" value="false_positive" variant="secondary">
              not a real problem
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
