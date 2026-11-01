import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ProposalTone = 'decide' | 'prepared' | 'finding';
export type ProposalCheck = Readonly<{ label: string; tone: 'ok' | 'warn' | 'info'; ruleVersion?: string }>;

/** The ONE card every AI centre surface renders for something waiting on a person (ADR-0170 §11.3 change 1).
 *
 * It shows what the item is, where it came from, the checks the owning service ran and how it was prepared.
 * It has exactly one action, a link to the page where the person decides: the card itself completes
 * nothing, so a review page can be redesigned but never bypassed. Presentational only; every value it
 * shows is passed in by a caller that read it from the owning module as the viewer. */
export function ProposalCard({ icon, tone, title, meta, checks = [], href, cta, expires, awaitingLabel, prepared }: {
  icon: ReactNode; tone: ProposalTone; title: string; meta: readonly string[]; checks?: readonly ProposalCheck[];
  href: string; cta: string; expires?: string; awaitingLabel?: string;
  prepared?: Readonly<{ summary: string; rows: readonly (readonly [string, string])[] }>;
}) {
  return (
    <article data-proposal-card={tone} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-1 rounded-xl border border-border bg-card p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span aria-hidden className={cn('row-span-3 flex size-8 items-center justify-center rounded-lg [&_svg]:size-4',
        tone === 'decide' ? 'bg-primary/10 text-primary' : tone === 'prepared' ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'bg-muted text-muted-foreground')}>{icon}</span>
      <h3 className="min-w-0 break-words text-sm font-semibold leading-snug">{title}</h3>
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        {awaitingLabel && <span role="img" aria-label={awaitingLabel} className="atelier-unmarked size-5 flex-none rounded-full border-[1.5px] border-dashed border-input" />}
        {meta.map((line, index) => <span key={index}>{line}</span>)}
      </div>
      {checks.length > 0 && (
        <ul className="col-start-2 mt-1.5 flex min-w-0 flex-wrap gap-1.5">
          {checks.map((check, index) => (
            <li key={index} title={check.ruleVersion}
              className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium before:size-1.5 before:rounded-full before:bg-current',
                check.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : check.tone === 'warn' ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300' : 'bg-sky-500/10 text-sky-800 dark:text-sky-300')}>
              {check.label}
            </li>
          ))}
        </ul>
      )}
      <div className="col-span-2 mt-2 flex flex-wrap items-center justify-between gap-2 sm:col-span-1 sm:col-start-3 sm:row-span-3 sm:row-start-1 sm:mt-0 sm:flex-col sm:items-end sm:justify-center">
        <Link href={href} className={cn('inline-flex min-h-9 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          tone === 'finding' ? 'border border-input bg-card hover:bg-accent' : 'bg-primary text-primary-foreground hover:bg-primary/90')}>{cta}</Link>
        {expires && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock aria-hidden className="size-3.5" />{expires}</span>}
      </div>
      {prepared && (
        <details className="group col-span-2 mt-1 text-xs sm:col-span-3">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />{prepared.summary}
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 rounded-lg bg-muted p-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
            {prepared.rows.map(([term, value]) => <div key={term} className="contents"><dt className="text-muted-foreground">{term}</dt><dd className="mb-1 sm:mb-0">{value}</dd></div>)}
          </dl>
        </details>
      )}
    </article>
  );
}
