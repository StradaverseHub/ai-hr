import { ActionButton } from '@/components/ui/action-button';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { LoopViewRefused } from '@/core/loops/views';
import { loopPromotion, type PromotionSample } from '@/core/loops/autonomy-views';
import { PROMOTION_RULES } from '@/core/loops/autonomy';
import { ACT_CONDITIONS, AUTONOMY_LEVELS, MAX_ACTIONS_PER_NIGHT, UNDO_WINDOW_DAYS, levelKey, type AutonomyLevel } from '@/core/loops/autonomy-types';
import type { LoopId } from '@/core/loops/types';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../../../operations-tabs';
import { changeLoopLimitsAction, setLoopLevelAction } from '../../autonomy-actions';

/** AI v2 Phase 2 P2-1 — promote a loop, with evidence and limits, for one company (approved mock-up Promote.dc.html).
 *
 * The four levels with where the loop stands; the certificate for the next level, computed from the loop's own records
 * (core/loops/levels.ts, the same computation the promotion re-runs in its own transaction); a sample of recent cards
 * with their outcomes; and the company's limits at that level: most actions a night, the undo window, and the
 * condition to act. Telling each person and the demotion rule are fixed and shown as such. Only a group administrator
 * may promote or move down, and the promotion is refused unless every requirement is met; anyone else sees the page
 * read-only. Guarded by requireAdmin like every Operations page. */
const ERRORS = ['invalid', 'refused', 'capped', 'no_actor', 'not_next_level', 'certificate', 'changed', 'unchanged', 'not_found', 'raise_needs_promotion', 'not_acting', 'failed'] as const;
const TARGET = 'pointer-coarse:min-h-11';
const percent = (value: number) => `${(Math.round(value * 1000) / 10).toString()}%`;
const str = (facts: PromotionSample['facts'], key: string) => (typeof facts[key] === 'string' ? (facts[key] as string) : null);
const count = (facts: PromotionSample['facts'], key: string) => (Array.isArray(facts[key]) ? (facts[key] as readonly string[]).length : 0);

export default async function PromoteLoopPage({ params, searchParams }: { params: Promise<{ loop: string }>; searchParams: Promise<{ company?: string; error?: string; saved?: string }> }) {
  const s = await requireAdmin();
  const [{ loop }, query, t, tl, f] = await Promise.all([params, searchParams, getTranslations('aiCentre.autonomy'), getTranslations('aiCentre.loops'), getFormatter()]);
  let view: Awaited<ReturnType<typeof loopPromotion>>;
  try { view = await loopPromotion(s, loop, query.company); } catch (e) { if (e instanceof LoopViewRefused && e.reason === 'not_found') notFound(); throw e; }
  const id: LoopId = view.workerId, name = tl(`names.${id}`), level = view.level, target = view.targetLevel;
  const levelName = (value: AutonomyLevel) => t(`levels.${levelKey(value)}`);
  const error = ERRORS.find(code => code === query.error);
  const saved = query.saved === 'promoted' || query.saved === 'moved_down' || query.saved === 'limits' ? query.saved : null;
  const when = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const day = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? f.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) : '—');
  const cert = view.certificate, loopHref = `/control-tower/loops/${encodeURIComponent(id)}`;
  const title = target === null ? t('promote.titleAt', { loop: t(`inSentence.${id}`), level: levelName(level), company: view.companyName })
    : t(`promote.titleTo.${levelKey(target)}`, { loop: t(`inSentence.${id}`), company: view.companyName });
  const intro = target === null ? (view.capped ? t('capped') : view.maxLevel > 1 && !view.hasActor ? t('noActor') : view.maxLevel > 1 ? t('promote.top') : t('stayPrepare'))
    : t(`promote.intro.${levelKey(target)}`);
  /** What a sample card was about, from its own facts, as the loop's page says it. */
  const what = (item: PromotionSample) => {
    const facts = item.facts;
    if (id === 'loop_probation_ending') return tl('what.probation', { date: day(str(facts, 'endDate')) });
    if (id === 'loop_payroll_inputs') return tl('what.payroll', { count: count(facts, 'missing'), date: day(str(facts, 'cutOff')) });
    if (id === 'loop_missing_employee_data') return tl('what.record', { count: count(facts, 'gaps') });
    if (id === 'loop_missed_clock_outs') return tl('what.clockOut', { time: str(facts, 'proposedCheckOut') ?? '—', date: day(str(facts, 'date')) });
    return tl('what.passport', { date: day(str(facts, 'expiresOn')) });
  };
  const outcome = (item: PromotionSample) => item.facts.autoApplied === true ? t('promote.autoApplied')
    : item.state === 'open' ? tl('caseState.open') : item.state === 'waiting' ? tl('caseState.waiting')
    : item.closeReason === 'done' ? tl(`caseState.${item.resolution ?? 'completed'}`) : tl(`caseState.${item.closeReason ?? 'superseded'}`);
  const needed = (criterion: NonNullable<typeof cert>['criteria'][number]) => criterion.id === 'prepared' ? t('promote.needed.prepared', { count: criterion.needed })
    : criterion.id === 'changed' ? t('promote.needed.changed', { percent: percent(criterion.needed) })
    : criterion.id === 'rule_broken' ? t('promote.needed.rule_broken') : t('promote.needed.days_at_level', { count: criterion.needed });
  const actual = (criterion: NonNullable<typeof cert>['criteria'][number]) => criterion.id === 'changed'
    ? (criterion.actual === null ? t('promote.actual.unknown') : t('promote.actual.changed', { percent: percent(criterion.actual), count: criterion.count ?? 0 }))
    : criterion.id === 'rule_broken' ? (criterion.actual ? String(criterion.actual) : t('promote.actual.none'))
    : criterion.id === 'days_at_level' ? t('promote.actual.days', { count: criterion.actual ?? 0 }) : String(criterion.actual ?? 0);
  const ladderNote = (value: AutonomyLevel) => value === level ? t('promote.now') : value === target ? t('promote.proposed') : value === 3 ? t('promote.after90') : null;
  const lower = level > 0 ? (level - 1) as AutonomyLevel : null;
  const moveTo: AutonomyLevel | null = lower === null ? null : level >= 2 ? 1 : lower;
  const requests = !view.usesCondition;
  const chosen = view.usesCondition && view.conditionSetAt ? t('limits.chosenBy', { name: view.conditionSetByName ?? t('anAdministrator'), date: when(view.conditionSetAt) }) : null;
  /** The limits a group administrator sets: the most actions a night, the undo window and, for missed clock-outs, the
   * condition to act. `max` and `undoOptions` bound a change made without a promotion (only ever stricter). */
  const limitFields = (max: number, undoOptions: readonly number[]) => <>
    <label className="flex flex-col gap-1.5 text-sm"><span className="text-xs font-medium text-muted-foreground">{t(requests ? 'promote.maxPerNightRequests' : 'promote.maxPerNight')}</span>
      <input name="maxActionsPerNight" type="number" min={1} max={max} step={1} required defaultValue={Math.min(view.limits.maxActionsPerNight, max)} className={cn(inputCls, 'max-w-40', TARGET)} /></label>
    <label className="flex flex-col gap-1.5 text-sm"><span className="text-xs font-medium text-muted-foreground">{t(requests ? 'promote.undoForRequests' : 'promote.undoFor')}</span>
      <select name="undoDays" defaultValue={String(undoOptions.includes(view.limits.undoDays) ? view.limits.undoDays : undoOptions[0])} className={cn(inputCls, 'max-w-40', TARGET)}>
        {undoOptions.map(days => <option key={days} value={days}>{t('promote.undoDays', { count: days })}</option>)}</select></label>
    {view.usesCondition ? <>
      <label className="flex flex-col gap-1.5 text-sm"><span className="text-xs font-medium text-muted-foreground">{t('promote.onlyWhen')}</span>
        <select name="condition" defaultValue={view.limits.condition} className={cn(inputCls, 'max-w-sm', TARGET)}>
          {ACT_CONDITIONS.map(condition => <option key={condition} value={condition}>{t(`promote.conditions.${condition}`)}</option>)}</select></label>
      <p data-autonomy-condition-note className="text-xs text-muted-foreground">{t('promote.rosterEndNote')}</p>
      {!view.siteExitRecorded && <p data-autonomy-site-exit-note className="text-xs text-muted-foreground">{t('promote.siteExitNote')}</p>}
      {chosen && <p className="text-xs text-muted-foreground">{chosen}</p>}
    </> : <input type="hidden" name="condition" value={view.limits.condition} />}
  </>;
  const readOnlyLimits = (
    <dl className="mt-3 space-y-2 text-sm">
      <div><dt className="text-xs text-muted-foreground">{t(requests ? 'promote.maxPerNightRequests' : 'promote.maxPerNight')}</dt><dd>{view.limits.maxActionsPerNight}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t(requests ? 'promote.undoForRequests' : 'promote.undoFor')}</dt><dd>{t('promote.undoDays', { count: view.limits.undoDays })}</dd></div>
      {view.usesCondition && <div><dt className="text-xs text-muted-foreground">{t('promote.onlyWhen')}</dt><dd>{t(`promote.conditions.${view.limits.condition}`)}{chosen && <span className="block text-xs text-muted-foreground">{chosen}</span>}</dd></div>}
    </dl>
  );
  /** The limits in force at Level 2 or 3: a group administrator makes them stricter, or chooses the condition, at any time. */
  const currentLimits = <div data-autonomy-current-limits>
    <h2 className="text-sm font-semibold">{t('promote.currentLimitsTitle', { n: level })}</h2>
    {view.canChange && view.version !== null ? (
      <form id="autonomy-limits" action={changeLoopLimitsAction} className="mt-3 space-y-4">
        <input type="hidden" name="loop" value={id} /><input type="hidden" name="company" value={view.companyId} />
        <input type="hidden" name="expectedVersion" value={view.version} />
        {limitFields(view.limits.maxActionsPerNight, UNDO_WINDOW_DAYS.filter(days => days >= view.limits.undoDays))}
        <p className="text-xs text-muted-foreground">{t('promote.changeLimitsNote')}</p>
        <ActionButton type="submit" className={cn(btnGhost, TARGET)}>{t('promote.saveLimits')}</ActionButton>
      </form>
    ) : readOnlyLimits}
  </div>;
  const fixedRows = (
    <dl className="mt-4 space-y-2 border-t border-border pt-3 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><dt>{t('promote.tell')}</dt><dd className="text-muted-foreground">{t('promote.tellValue')}</dd></div>
      <div className="flex flex-wrap justify-between gap-2"><dt>{t('promote.dropBack')}</dt><dd className="text-muted-foreground">{t('promote.dropBackValue')}</dd></div>
    </dl>
  );
  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="loops" />
      <PageHeader back={{ href: loopHref, label: name }} title={title} description={intro} />
      {error && <ErrorBanner message={t(`promote.errors.${error}`)} />}
      {saved && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t(`promote.saved.${saved}`, { level: levelName(level), company: view.companyName })}</p>}

      <ol data-autonomy-ladder aria-label={t('promote.ladder')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {AUTONOMY_LEVELS.map(value => {
          const note = ladderNote(value), reachable = value <= view.maxLevel;
          return (
            <li key={value} data-autonomy-level={value} aria-current={value === level ? 'step' : undefined}
              className={cn('min-w-0 rounded-xl border bg-card p-4', value === level ? 'border-primary/60' : value === target ? 'border-dashed border-primary/60' : 'border-border', !reachable && 'opacity-60')}>
              <p className="text-xs font-medium text-muted-foreground">{t('levelOnly', { n: value })}{note && <span> · {note}</span>}</p>
              <p className="mt-1 text-sm font-semibold">{levelName(value)}</p>
              {!reachable && <p className="mt-1 text-xs text-muted-foreground">{t('promote.notForThisLoop')}</p>}
            </li>
          );
        })}
      </ol>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <SectionHeader title={t('promote.evidenceTitle', { days: PROMOTION_RULES.windowDays, company: view.companyName })} />
          {cert ? (
            <div className="overflow-x-auto">
              <table data-autonomy-evidence className="w-full min-w-[480px] text-left text-sm">
                <caption className="sr-only">{t('promote.evidenceTitle', { days: PROMOTION_RULES.windowDays, company: view.companyName })}</caption>
                <thead className="border-y border-border bg-muted/40"><tr>{(['requirement', 'needed', 'actual', 'met'] as const).map(key =>
                  <th key={key} scope="col" className="px-4 py-3 font-medium">{t(`promote.columns.${key}`)}</th>)}</tr></thead>
                <tbody className="divide-y divide-border">
                  {cert.criteria.map(criterion => (
                    <tr key={criterion.id} data-autonomy-criterion={criterion.id} data-met={criterion.met ? 'yes' : 'no'}>
                      <th scope="row" className="px-4 py-3 font-normal">{t(`promote.criteria.${criterion.id}`)}</th>
                      <td className="px-4 py-3">{needed(criterion)}</td>
                      <td className="px-4 py-3 tabular-nums">{actual(criterion)}</td>
                      <td className={cn('px-4 py-3 font-medium', criterion.met ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>{criterion.met ? t('promote.yes') : t('promote.no')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="px-4 py-3 text-sm text-muted-foreground">{t('promote.noCertificate')}</p>}
          <div className="border-t border-border px-4 py-3">
            <h3 className="text-sm font-medium">{t('promote.sampleTitle')}</h3>
            {view.sample.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">{t('promote.sampleNone')}</p> : (
              <ul data-autonomy-sample className="mt-2 divide-y divide-border text-sm">
                {view.sample.map(item => (
                  <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                    <span className="min-w-0">{item.personName ?? '—'}<span className="block text-xs text-muted-foreground">{what(item)}</span></span>
                    <span className="text-xs text-muted-foreground">{when(item.at)} · {outcome(item)}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link href={loopHref} className={cn('mt-2 inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline', TARGET)}>
              {t('promote.seeAll', { count: view.evidence.prepared })}</Link>
          </div>
        </Card>

        <Card className="p-4">
          {target !== null && target >= 2 ? (<>
            <h2 className="text-sm font-semibold">{t('promote.limitsTitle', { n: target })}</h2>
            {view.canChange ? (
              <form id="autonomy-promote" action={setLoopLevelAction} className="mt-3 space-y-4">
                <input type="hidden" name="loop" value={id} /><input type="hidden" name="company" value={view.companyId} />
                <input type="hidden" name="toLevel" value={target} /><input type="hidden" name="expectedLevel" value={level} />
                {limitFields(MAX_ACTIONS_PER_NIGHT, UNDO_WINDOW_DAYS)}
              </form>
            ) : readOnlyLimits}
            {fixedRows}
          </>) : level >= 2 ? currentLimits : (
            <p className="text-sm text-muted-foreground">{t('promote.noLimits')}</p>
          )}
          <p className="mt-4 text-xs text-muted-foreground">{t('promote.capNote')}</p>
        </Card>
      </div>

      {target !== null && target >= 2 && level >= 2 && <Card className="p-4">{currentLimits}</Card>}

      <div data-autonomy-commands className="flex flex-wrap items-center gap-3">
        {view.canChange && target !== null && (target < 2 ? (
          <form action={setLoopLevelAction}>
            <input type="hidden" name="loop" value={id} /><input type="hidden" name="company" value={view.companyId} />
            <input type="hidden" name="toLevel" value={target} /><input type="hidden" name="expectedLevel" value={level} />
            <ActionButton type="submit" className={cn(btnPrimary, TARGET)}>{t('promote.submit', { n: target, company: view.companyName })}</ActionButton>
          </form>
        ) : (
          <button type="submit" form="autonomy-promote" disabled={!cert?.met} aria-describedby={cert?.met ? undefined : 'autonomy-not-met'}
            className={cn(btnPrimary, TARGET)}>{t('promote.submit', { n: target, company: view.companyName })}</button>
        ))}
        {target !== null && <Link href={loopHref} className={cn(btnGhost, TARGET)}>{t('promote.notYet')}</Link>}
        {view.canChange && moveTo !== null && (
          <form action={setLoopLevelAction}>
            <input type="hidden" name="loop" value={id} /><input type="hidden" name="company" value={view.companyId} />
            <input type="hidden" name="toLevel" value={moveTo} /><input type="hidden" name="expectedLevel" value={level} />
            <ActionButton type="submit" className={cn(btnGhost, TARGET)}>{t('promote.moveDown', { level: levelName(moveTo) })}</ActionButton>
          </form>
        )}
        <span className="text-xs text-muted-foreground">{view.canChange ? t('promote.groupOnly') : t('promote.readOnly')}</span>
        {view.canChange && target !== null && target >= 2 && !cert?.met && <p id="autonomy-not-met" className="w-full text-sm text-muted-foreground">{t('promote.notMet')}</p>}
      </div>
    </div>
  );
}
