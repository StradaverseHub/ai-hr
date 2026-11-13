import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LeaveRecommendationView, TeamCoverageView } from '@/app/assistant/centre/recommendation';

/** How many short days are named before the rest are counted ("and 3 more days"). */
const NAMED_DAYS = 7;

/** Presentational, so tests and evidence render each state without a server.
 *
 * AI v2 W6, on the approval pages: `detail` lists all four checks with their result and the version each ran
 * under (not only the failed rules), `prepared` adds "How this was prepared" (the outcome record) and
 * `decideHere` says the decision is made right there. `inset={false}` drops the indent that lines the panel
 * up under a Today card. The approval pages and Manager Today render it.
 *
 * When the company sets a "minimum people present" (owner decision, 12 November 2026), team cover is worded from it:
 * met on every day, or the days below it with how many of the team would be present, on both the detailed list and the
 * short failed-rule list Manager Today shows. */
export function RecommendationPanel({ view, id, detail = false, prepared, decideHere = false, inset = true }: {
  view: LeaveRecommendationView; id?: string; detail?: boolean; decideHere?: boolean; inset?: boolean;
  prepared?: Readonly<{ summary: string; rows: readonly (readonly [string, string])[] }>;
}) {
  const t = useTranslations('aiCentre.recommendation');
  const format = useFormatter();
  const locale = useLocale();
  const checks = view.kind === 'recommendation' && detail ? view.checks ?? [] : [];
  const coverage: TeamCoverageView | null = view.kind === 'recommendation' ? view.teamCoverage ?? null : null;
  // The minimum's own words for team cover, or null where the generic wording applies (no minimum, or not read).
  const minimumText = (result: string): string | null => {
    if (!coverage) return null;
    if (result === 'pass') return t('result.team_coverage.passMinimum', { minimum: coverage.minimum });
    if (result !== 'fail' || coverage.shortDays.length === 0) return null;
    const named = coverage.shortDays.slice(0, NAMED_DAYS).map(day => t('teamDay', {
      date: format.dateTime(new Date(`${day.date}T00:00:00Z`), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
      present: day.present,
    }));
    const more = coverage.shortDays.length - named.length;
    const days = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(more > 0 ? [...named, t('teamMoreDays', { count: more })] : named);
    return t('result.team_coverage.failMinimum', { minimum: coverage.minimum, count: coverage.shortDays.length, days });
  };
  return (
    <section id={id} tabIndex={id ? -1 : undefined} role="status" data-recommendation={view.kind === 'recommendation' ? view.verdict : 'unavailable'}
      className={cn(inset && 'ml-12', 'mt-1 rounded-lg border border-border bg-muted/40 p-3 text-xs')}>
      {view.kind === 'unavailable' ? <p className="text-muted-foreground">{t(`unavailable.${view.reason}`)}</p> : <>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {view.verdict === 'recommend_approve' ? <CheckCircle2 aria-hidden className="size-4 text-emerald-700 dark:text-emerald-300" /> : <AlertTriangle aria-hidden className="size-4 text-amber-700 dark:text-amber-300" />}
          {t(`verdict.${view.verdict}`)}
        </p>
        {checks.length > 0 ? <ul className="mt-2 space-y-1.5" data-recommendation-checks>{checks.map(check => (
          <li key={check.check} data-check={check.check} data-result={check.result} className="flex items-start gap-1.5">
            {check.result === 'pass' ? <CheckCircle2 aria-hidden className="mt-px size-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" /> : <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />}
            <div className="min-w-0">
              <p>{(check.check === 'team_coverage' ? minimumText(check.result) : null) ?? t(`result.${check.check}.${check.result}`)}</p>
              {check.result === 'fail' && check.blocking && <p className="text-amber-800 dark:text-amber-300">{t('blocking')}</p>}
              {check.version && <p className="text-muted-foreground">{t(`version.${check.version.kind}`, { version: check.version.version })}</p>}
            </div>
          </li>
        ))}</ul> : view.failedRules.length > 0 && <ul className="mt-2 space-y-1.5">{view.failedRules.map(rule => (
          <li key={rule.check} data-failed-rule={rule.check}>
            <p>{(rule.check === 'team_coverage' ? minimumText('fail') : null) ?? t(`check.${rule.check}`)}</p>
            {rule.blocking && <p className="text-amber-800 dark:text-amber-300">{t('blocking')}</p>}
            {rule.version && <p className="text-muted-foreground">{t(`version.${rule.version.kind}`, { version: rule.version.version })}</p>}
          </li>
        ))}</ul>}
        <p className="mt-2 text-muted-foreground">{t(decideHere ? 'youDecideHere' : 'youDecide')}</p>
        {prepared && (
          <details className="group mt-1" data-recommendation-prepared>
            <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />{prepared.summary}
            </summary>
            <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 rounded-lg bg-muted p-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
              {prepared.rows.map(([term, value]) => <div key={term} className="contents"><dt className="text-muted-foreground">{term}</dt><dd className="mb-1 sm:mb-0">{value}</dd></div>)}
            </dl>
          </details>
        )}
      </>}
    </section>
  );
}
