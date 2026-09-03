import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { openExceptionsAcrossRuns } from '@/core/payroll-anomaly';
import { HYPOTHESIS_DETECTOR_ID } from '@/core/payroll-anomaly-detectors';
import { Button, Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { resolveAnomalyAction } from '@/app/payroll/actions';

/**
 * ADR-0074 — THE EXCEPTIONS QUEUE ACROSS EVERY RUN.
 *
 * ⚠️ **WHY, MEASURED ON PRODUCTION RATHER THAN ASSUMED.** 81 flagged verdicts were live and unresolved
 * across **23 different batches**, and not one had ever been dispositioned. That is structural, not
 * negligence: the only place to resolve one was that batch's own queue, so clearing the backlog meant
 * twenty-three separate visits — and the Control Tower, the screen an operator actually opens, listed
 * the RUNS and linked into each of them.
 *
 * **IT IS ALSO WHAT HAS BEEN BLOCKING THE TOWER'S OWN HEADLINE.** `falsePositiveRate` and `mttrSeconds`
 * stay NULL until a human dispositions a flag, and `impliedOperators` refuses to print without them. The
 * staffing answer the owner keeps asking for has been waiting on a signal the product made expensive to
 * give.
 *
 * NOTHING HERE IS A SECOND IMPLEMENTATION. The rows come from one reader that returns the same shape the
 * per-run queue renders, and the three buttons post to the SAME server action — so the ledger stamp
 * r238 hangs off `resolveAnomalyVerdict` cannot be forgotten on one screen and not the other.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY, so it stays a working queue rather than a second control tower:
 * no metrics strip (the tower has it), no circuit breaker (a per-run fact), no re-evaluate button (the
 * nightly sweep and the run's own screen own that), and no auto-cleared rows — raising a false negative
 * needs the whole run in front of you, and a cross-run list of everything the system cleared would be
 * thousands of rows nobody is being asked to act on.
 */
const TONE: Record<string, string> = {
  block: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200',
  review: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
};

/** Every number a finding prints comes from `facts`; the model never produced any of them. */
const factLine = (facts: Record<string, string | number>) =>
  Object.entries(facts)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`)
    .join(' · ');

export default async function CrossRunExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('anomaly');
  const tx = await getTranslations('payroll.controlTower.exceptions');
  const sp = await searchParams;
  const { rows, total, cappedOut } = await openExceptionsAcrossRuns(s);

  const blocks = rows.filter((r) => r.disposition === 'block').length;

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: '/control-tower', label: tx('backToTower') }}
        title={tx('title')}
        description={tx('description')}
      />

      <ErrorBanner message={sp.error} />
      {sp.toast ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
          {sp.toast}
        </div>
      ) : null}

      <Card className="p-5">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <p className="text-xs text-muted-foreground">{tx('outstanding')}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{total}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{tx('blocking')}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{blocks}</p>
          </div>
        </div>
        {/* ⚠️ SAYS WHEN IT IS SHOWING A SUBSET. A page that silently rendered the first hundred of nine
            hundred would read as a queue somebody had nearly finished. */}
        {cappedOut && <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">{tx('capped', { shown: rows.length, total })}</p>}
        <p className="mt-3 text-[11px] text-muted-foreground">{tx('help')}</p>
      </Card>

      {rows.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="font-medium">{tx('emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{tx('emptyBody')}</p>
        </Card>
      ) : null}

      {rows.map((row) => (
        <Card key={row.verdictId} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {row.employeeName}
                {row.employeeCode ? <EmployeeCode code={row.employeeCode} /> : null}
                {/* THE RUN, ON THE ROW. Out of its own batch a verdict has to say which period it is
                    about, or an operator cannot tell whether they are looking at last month or last year
                    — and the link back to that run is how they check the rest of it. */}
                <Link
                  href={`/payroll/${row.batchId}/anomalies`}
                  className="text-[11px] font-medium text-primary underline-offset-2 hover:underline"
                >
                  {row.payPeriod}
                </Link>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {tx('waitingSince', { date: row.computedAt.toISOString().slice(0, 10) })}
              </p>
            </div>
            <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${TONE[row.disposition] ?? ''}`}>
              {row.disposition === 'block' ? t('dispositionBlock') : t('dispositionReview')}
            </span>
          </div>

          <ul className="mt-3 space-y-2">
            {row.findings.map((f, i) => (
              <li key={`${f.detectorId}-${i}`} className={`rounded-md border p-3 text-xs ${TONE[f.severity] ?? ''}`}>
                <p className="font-medium">
                  {f.detectorId === HYPOTHESIS_DETECTOR_ID ? t('hypothesisLabel') : f.detectorId}
                </p>
                {/* The prose, when an operator has already asked for it on the run's own screen. It is
                    never generated from here: narration costs a provider call on the tenant's own key
                    and belongs where somebody chose to spend it. */}
                {f.narrative && <p className="mt-1 text-[12px] leading-snug">{f.narrative}</p>}
                <p className="mt-1 font-mono text-[11px] opacity-80">{factLine(f.facts)}</p>
              </li>
            ))}
          </ul>

          {/* THE SAME ACTION THE PER-RUN QUEUE POSTS TO. `returnTo` only decides where you land. */}
          <form action={resolveAnomalyAction} className="mt-4 space-y-2">
            <input type="hidden" name="batchId" value={row.batchId} />
            <input type="hidden" name="verdictId" value={row.verdictId} />
            <input type="hidden" name="returnTo" value="tower" />
            <input name="note" placeholder={t('noteLabel')} className={inputCls} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" name="resolution" value="accepted" variant="secondary">
                {t('resolveAccepted')}
              </Button>
              <Button type="submit" size="sm" name="resolution" value="fixed_upstream" variant="secondary">
                {t('resolveFixedUpstream')}
              </Button>
              <Button type="submit" size="sm" name="resolution" value="false_positive" variant="secondary">
                {t('resolveFalsePositive')}
              </Button>
            </div>
          </form>
        </Card>
      ))}

      <Card className="p-5">
        <SectionHeader title={tx('whyTitle')} />
        {/* The honest reason this screen exists, said to the person working it: their decisions are the
            only route to three of the tower's own figures. */}
        <p className="mt-1 text-sm text-muted-foreground">{tx('whyBody')}</p>
      </Card>
    </div>
  );
}
