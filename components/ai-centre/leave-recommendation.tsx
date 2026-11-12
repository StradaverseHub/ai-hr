import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LeaveRecommendationView } from '@/app/assistant/centre/recommendation';

/** Presentational, so tests and evidence render each state without a server.
 *
 * AI v2 W6, on the approval pages: `detail` lists all four checks with their result and the version each ran
 * under (not only the failed rules), `prepared` adds "How this was prepared" (the outcome record) and
 * `decideHere` says the decision is made right there. `inset={false}` drops the indent that lines the panel
 * up under a Today card. The approval pages and Manager Today render it. */
export function RecommendationPanel({ view, id, detail = false, prepared, decideHere = false, inset = true }: {
  view: LeaveRecommendationView; id?: string; detail?: boolean; decideHere?: boolean; inset?: boolean;
  prepared?: Readonly<{ summary: string; rows: readonly (readonly [string, string])[] }>;
}) {
  const t = useTranslations('aiCentre.recommendation');
  const checks = view.kind === 'recommendation' && detail ? view.checks ?? [] : [];
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
              <p>{t(`result.${check.check}.${check.result}`)}</p>
              {check.result === 'fail' && check.blocking && <p className="text-amber-800 dark:text-amber-300">{t('blocking')}</p>}
              {check.version && <p className="text-muted-foreground">{t(`version.${check.version.kind}`, { version: check.version.version })}</p>}
            </div>
          </li>
        ))}</ul> : view.failedRules.length > 0 && <ul className="mt-2 space-y-1.5">{view.failedRules.map(rule => (
          <li key={rule.check}>
            <p>{t(`check.${rule.check}`)}</p>
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
