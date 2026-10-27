import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Card } from '@/components/ui/card';
// Button is a client component: rendered with a server Link child (asChild), never called as a function here.
import { Button } from '@/components/ui/button';
import { Status, type StatusTone } from '@/components/monolith';
import { MONO_LABEL } from '@/components/monolith/classes';
import { cn } from '@/lib/utils';
import { getPerformanceHomeBlock, type HomeStepState, type PerformanceHomeBlock } from '@/packs/performance/service';

/**
 * WP-A2 (APR-015) — the Performance block on Home, for employees and line managers.
 *
 * RENDERING ONLY. Every fact comes from packs/performance/onehr/home-cards.ts, which reads the owners (the
 * workspace derivation, the bell's task projection, the own-person review projection). Theme-aware by CSS
 * alone (Card, Status, Button paint Classic, Monolith and Atelier from the same markup), so the three themes
 * show the same content in the same order. A state is always a word; the dot only reinforces it.
 */
const TONE: Record<HomeStepState, StatusTone> = {
  done: 'ink', released: 'ink', yourTurn: 'signal', waiting: 'signal', inProgress: 'mid', locked: 'mid', notRequired: 'mid',
};
const DOT: Record<StatusTone, string> = {
  ink: 'bg-emerald-500 monolith:bg-ink',
  signal: 'bg-amber-500 monolith:bg-signal',
  mid: 'border border-muted-foreground/60 bg-transparent monolith:border-mid',
};

export async function PerformanceHomeView({ block }: { block: PerformanceHomeBlock }) {
  const t = await getTranslations('performanceHome');
  const tTask = await getTranslations('employeeHome.taskNames');
  const format = await getFormatter();
  const day = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00Z`), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const { next, team, standing } = block;
  const word = (state: HomeStepState, count?: number) => (state === 'waiting' ? t('states.waiting', { count: count ?? 0 }) : t(`states.${state}`));
  const nextTitle = next.kind === 'none' ? t('next.none') : next.kind === 'feedback360' ? t('next.feedback360Title', { count: next.colleagues }) : t(`next.${next.kind}Title`);
  const nextLine = next.kind === 'none' ? (next.nextDate ? t(next.nextDate.kind === 'opens' ? 'next.opens' : 'next.closesOn', { date: day(next.nextDate.on) }) : null)
    : next.kind === 'feedback360' ? t('next.feedback360Line') : next.total > 0 ? t(`next.${next.kind}Line`, { done: next.done, total: next.total }) : null;
  const rows: { key: string; label: string; value: string; strong: boolean }[] = [];
  if (standing.performance) rows.push({ key: 'performance', label: t('standing.performance'), value: standing.performance.state === 'released' ? standing.performance.band : t(`standing.${standing.performance.state}`), strong: standing.performance.state === 'released' });
  if (standing.competency) rows.push({ key: 'competency', label: t('standing.competency'), value: t(`standing.${standing.competency}`), strong: standing.competency === 'reviewed' });
  rows.push({ key: 'feedback360', label: t('standing.feedback360'), value: t(standing.feedback360 === 'released' ? 'standing.reportReleased' : 'standing.notReleased'), strong: standing.feedback360 === 'released' });
  rows.push({ key: 'careerTarget', label: t('standing.careerTarget'), value: standing.careerTarget.state === 'set' ? standing.careerTarget.title : t('standing.notSet'), strong: standing.careerTarget.state === 'set' });

  return (
    <section aria-labelledby="performance-home-title" data-performance-home className="min-w-0 space-y-4">
      <h2 id="performance-home-title" className="sr-only">{t('title')}</h2>
      <Card data-performance-strip className="min-w-0 p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="min-w-0">
            <span className="font-semibold">{block.cycle.name}</span>
            <span className="ml-2 text-sm text-muted-foreground">{t('closes', { date: day(block.cycle.closesOn) })}</span>
          </p>
          <p className={cn('text-sm text-muted-foreground tabular-nums', MONO_LABEL)}>{t('progress', { done: block.done, total: block.total })}</p>
        </div>
        <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <ol aria-label={t('stripLabel')} className="flex min-w-max gap-0">
            {block.steps.map((step) => (
              <li key={step.key} data-step={step.key} data-state={step.state} aria-current={step.state === 'yourTurn' ? 'step' : undefined}
                className="relative flex w-36 shrink-0 flex-col gap-1 pr-3">
                <span className="flex items-center gap-2">
                  <i aria-hidden="true" className={cn('inline-block size-2.5 shrink-0 rounded-full', DOT[TONE[step.state]])} />
                  <i aria-hidden="true" className="h-px flex-1 bg-border monolith:bg-hairline" />
                </span>
                <span className={cn('text-sm font-medium', step.state === 'locked' || step.state === 'notRequired' ? 'text-muted-foreground' : '')}>{t(`steps.${step.key}`)}</span>
                <Status word={word(step.state, step.count)} tone={TONE[step.state]} className="w-fit normal-case" />
              </li>
            ))}
          </ol>
        </div>
      </Card>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card data-performance-next className="min-w-0 space-y-4 p-4 sm:p-5">
          <div className="space-y-1">
            <p className={cn('text-xs text-muted-foreground', MONO_LABEL)}>{t('next.label')}</p>
            <h3 className="text-lg font-semibold">{nextTitle}</h3>
            {(nextLine || (next.kind !== 'none' && next.dueOn)) && (
              <p className="text-sm text-muted-foreground">
                {[nextLine, next.kind !== 'none' && next.dueOn ? t('next.due', { date: day(next.dueOn) }) : null].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          {next.kind !== 'none' && (
            <Button asChild className="min-h-11"><Link href={next.href}>{t('next.open')}</Link></Button>
          )}
          {team && (
            <div data-performance-team className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 monolith:border-hairline">
              <div className="min-w-0 space-y-2">
                <p className="text-sm"><span className="font-semibold">{t('team.title')}</span> · {t('team.waiting', { count: team.total })}</p>
                {team.chips.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {team.chips.map((chip) => (
                      <li key={chip.kind} data-chip={chip.kind}><Status word={`${tTask(chip.kind)} ${chip.count}`} tone="mid" className="normal-case" /></li>
                    ))}
                  </ul>
                )}
              </div>
              <Button asChild variant="outline" className="min-h-11"><Link href={team.href}>{t('team.open')}</Link></Button>
            </div>
          )}
        </Card>
        <Card data-performance-standing className="min-w-0 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">{t('standing.title')}</h3>
            <Link href={block.detailsHref} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">{t('standing.details')}</Link>
          </div>
          <dl className="mt-2 divide-y divide-border monolith:divide-hairline">
            {rows.map((row) => (
              <div key={row.key} data-standing={row.key} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className={cn('text-right', row.strong ? 'font-semibold' : 'text-muted-foreground')}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </section>
  );
}

/**
 * The block's slot on every Home. Reads its own facts; renders nothing when there is nothing to show. A
 * failed read hides the block rather than failing Home (the task providers do the same in the bell); the error
 * is logged, never shown as an empty or calm state.
 */
export async function PerformanceHomeSlot({ session, scopeIds }: { session: SessionContext; scopeIds: string[] | undefined }) {
  const block = await getPerformanceHomeBlock(session, scopeIds).catch((error: unknown) => {
    console.error('[performance-home] block unavailable', error);
    return null;
  });
  return block ? <PerformanceHomeView block={block} /> : null;
}
