import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { LoopAutonomyDetail, AutonomyActionView, AutonomyCompany } from '@/core/loops/autonomy-views';
import { LOOP_AUTONOMY, touchesCapped } from '@/core/loops/autonomy';
import { levelKey, type AutonomyLevel } from '@/core/loops/autonomy-types';
import type { LoopId } from '@/core/loops/types';
import { Card, SectionHeader, btnGhost } from '@/components/ui';
import { cn } from '@/lib/utils';
import { reviewLoopSampleAction, undoLoopActionFromDetailAction } from '@/app/control-tower/loops/autonomy-actions';

/** AI v2 Phase 2 P2-1 — a loop's level, its automatic actions and its limits, on the loop's own page (approved mock-up
 * Main.dc.html: the level badges, Recent actions with Undo, "Limits it can never cross" and "Who answers for it").
 * Every value comes from core/loops/autonomy-views.ts, read under the viewer's row-level security. Undo posts to the
 * owner through core/loops/undo.ts, which checks everything again; the page itself decides nothing. Each section is an
 * async function the page awaits (`{await LoopLevelsCard({...})}`), as the other loop sections render inline. */
const TARGET = 'pointer-coarse:min-h-11';
const BADGE = 'rounded-full border border-border px-2.5 py-1 text-xs font-medium';
const percent = (value: number) => `${(Math.round(value * 1000) / 10).toString()}%`;
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

export const AUTONOMY_NOTICES = ['undone', 'expired', 'changed', 'access', 'ask_hr', 'unavailable', 'invalid', 'reviewed', 'review_failed'] as const;
export type AutonomyNotice = (typeof AUTONOMY_NOTICES)[number];

/** The header badges: each level the loop stands at, with the companies there ("Act within limits · A, B"). */
export async function LoopLevelBadges({ autonomy }: { autonomy: LoopAutonomyDetail }) {
  const t = await getTranslations('aiCentre.autonomy');
  const groups = new Map<AutonomyLevel, AutonomyCompany[]>();
  for (const item of autonomy.companies) groups.set(item.level, [...(groups.get(item.level) ?? []), item]);
  const order = [...groups.keys()].sort((a, b) => b - a);
  if (!order.length) return <span data-loop-level="1" className={BADGE}>{t(`levels.${levelKey(1)}`)}</span>;
  return <>{order.map(level => {
    const list = groups.get(level)!;
    const label = t(`levels.${levelKey(level)}`);
    return <span key={level} data-loop-level={level} className={cn(BADGE, level >= 2 && 'border-primary/40 bg-primary/5')}>
      {level >= 2 ? t('summaryNamed', { level: label, companies: list.map(item => item.companyName).join(', ') }) : t('summaryCount', { level: label, count: list.length })}
    </span>;
  })}</>;
}

/** The action figures over the window, once the loop has acted at least once. */
export async function LoopAutonomyFigures({ autonomy }: { autonomy: LoopAutonomyDetail }) {
  if (!autonomy.hasActor || (autonomy.figures.applied === 0 && !autonomy.companies.some(item => item.level >= 2))) return null;
  const t = await getTranslations('aiCentre.autonomy');
  const tile = (label: string, value: string) => (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4">
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
  const f = autonomy.figures, requests = !autonomy.usesCondition;
  return <div data-loop-autonomy-figures className="grid gap-3 sm:grid-cols-3">
    {tile(t(requests ? 'figures.appliedRequests' : 'figures.applied', { days: autonomy.windowDays }), String(f.applied))}
    {tile(t('figures.corrected'), f.correctedShare === null ? t('figures.none') : percent(f.correctedShare))}
    {tile(t(requests ? 'figures.withdrawn' : 'figures.undoneByEmployee'), String(requests ? f.corrected : f.undoneByEmployee))}
  </div>;
}

/** The level in each company the viewer administers, with the condition chosen and the way to its limits and levels. */
export async function LoopLevelsCard({ autonomy, loop, notice }: { autonomy: LoopAutonomyDetail; loop: LoopId; notice: AutonomyNotice | null }) {
  const [t, f] = await Promise.all([getTranslations('aiCentre.autonomy'), getFormatter()]);
  const day = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
  const capped = touchesCapped(LOOP_AUTONOMY[loop].categories);
  const help = autonomy.promotableTo > 1 ? t('companiesHelp') : capped ? t('capped') : autonomy.maxLevel > 1 ? t('noActor') : t('stayPrepare');
  const good = notice === 'undone' || notice === 'reviewed';
  return (
    <Card className="overflow-hidden">
      <SectionHeader title={t('companiesTitle')} />
      <p data-loop-autonomy-help className="px-4 pb-3 text-sm text-muted-foreground">{help}</p>
      {notice && <p role={good ? 'status' : 'alert'} data-loop-autonomy-notice={notice}
        className={cn('mx-4 mb-3 rounded-lg border p-3 text-sm', good ? 'border-border bg-muted/50' : 'border-destructive/30 bg-destructive/10 text-destructive')}>
        {t(`notices.${notice}`)}</p>}
      {autonomy.companies.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('noCompanies')}</p> : (
        <ul className="divide-y divide-border border-t border-border">
          {autonomy.companies.map(item => (
            <li key={item.companyId} data-loop-level-company={item.companyId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 break-words">{item.companyName}
                {item.changedAt && <span className="block text-xs text-muted-foreground">{item.changedBy === 'automatic'
                  ? t('changedAuto', { date: day(item.changedAt) }) : t('changedBy', { name: item.changedByName ?? t('anAdministrator'), date: day(item.changedAt) })}</span>}
                {autonomy.usesCondition && item.level >= 2 && item.limits?.condition === 'roster_and_site_exit' && !autonomy.siteExitRecorded &&
                  <span data-loop-cannot-act className="block text-xs text-amber-700 dark:text-amber-300">{t('cannotActYet')}</span>}
              </span>
              <span className="flex flex-wrap items-center gap-3">
                <span data-loop-level={item.level} className={cn(BADGE, item.level >= 2 && 'border-primary/40 bg-primary/5')}>{t('levelNumber', { n: item.level, level: t(`levels.${levelKey(item.level)}`) })}</span>
                {autonomy.promotableTo > 1 && <Link href={`/control-tower/loops/${encodeURIComponent(loop)}/promote?${new URLSearchParams({ company: item.companyId })}`}
                  className={cn(btnGhost, TARGET)} aria-label={`${t('limitsLink')} · ${item.companyName}`}>{t('limitsLink')}</Link>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type Translator = (key: string, values?: Record<string, string | number>) => string;
const wrap = (t: (key: never, values?: never) => string): Translator => (key, values) => t(key as never, values as never);
/** What one action did and where it stands, from its own record. */
function describe(t: Translator, requests: boolean, day: (iso: string) => string, when: (date: Date) => string, item: AutonomyActionView) {
  const date = isDate(item.facts.date) ? day(item.facts.date) : '—';
  const time = typeof item.facts.checkOut === 'string' ? item.facts.checkOut : '—';
  const count = typeof item.facts.gaps === 'number' ? item.facts.gaps : 0;
  const what = item.state === 'not_applied'
    ? (requests ? t('actions.notSent', { reason: t(`actions.reasons.${item.reason ?? 'owner_refused'}`) }) : t('actions.notSet', { reason: t(`actions.reasons.${item.reason ?? 'owner_refused'}`), date }))
    : requests ? t('actions.sent', { count }) : t('actions.set', { time, date });
  const status = item.undo ? t(requests ? (item.undo.by === 'employee' ? 'actions.status.withdrawnEmployee' : 'actions.status.withdrawnHr')
      : item.undo.by === 'employee' ? 'actions.status.undoneEmployee' : 'actions.status.undoneHr')
    : item.peopleChanged ? t('actions.status.changed')
    : item.state === 'applied' ? (item.undoUntil.getTime() > Date.now() ? t(requests ? 'actions.status.sentOpen' : 'actions.status.fixed', { date: when(item.undoUntil) })
      : t(requests ? 'actions.status.sentClosed' : 'actions.status.fixedClosed'))
    : item.state === 'applying' ? t('actions.status.applying') : t('actions.status.toPerson');
  return { what, status };
}

function ActionsTable({ t, requests, loop, actions, day, when, label }: { t: Translator; requests: boolean; loop: LoopId; actions: readonly AutonomyActionView[];
  day: (iso: string) => string; when: (date: Date) => string; label: string }) {
  const undo = t(requests ? 'actions.withdraw' : 'actions.undo');
  return (
    <div className="overflow-x-auto">
      <table data-loop-actions className="w-full min-w-[720px] text-left text-sm">
        <caption className="sr-only">{label}</caption>
        <thead className="border-y border-border bg-muted/40"><tr>{(['when', 'person', 'what', 'status', 'action'] as const).map(key =>
          <th key={key} scope="col" className={cn('px-4 py-3 font-medium', key === 'action' && 'text-right')}>
            {key === 'action' ? <span className="sr-only">{t('actions.columns.action')}</span> : t(`actions.columns.${key}`)}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">
          {actions.map(item => {
            const { what, status } = describe(t, requests, day, when, item);
            return (
              <tr key={item.id} data-loop-action={item.undo ? 'undone' : item.state}>
                <td className="px-4 py-3 tabular-nums">{when(item.at)}</td>
                <td className="px-4 py-3">{item.personName ?? '—'}{item.companyName && <span className="block text-xs text-muted-foreground">{item.companyName}</span>}</td>
                <td className="px-4 py-3">{what}</td>
                <td className="px-4 py-3">{status}</td>
                <td className="px-4 py-3 text-right">{item.canUndo && (
                  <form action={undoLoopActionFromDetailAction}>
                    <input type="hidden" name="loop" value={loop} /><input type="hidden" name="action" value={item.id} />
                    <button type="submit" className={cn(btnGhost, TARGET)} aria-label={`${undo} · ${item.personName ?? what}`}>{undo}</button>
                  </form>
                )}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Recent automatic actions, each with Undo while its window is open and the viewer administers the employment. */
export async function LoopActionsCard({ autonomy, loop }: { autonomy: LoopAutonomyDetail; loop: LoopId }) {
  if (!autonomy.hasActor) return null;
  const [t, f] = await Promise.all([getTranslations('aiCentre.autonomy'), getFormatter()]);
  const when = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const day = (iso: string) => f.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  return (
    <Card className="overflow-hidden">
      <SectionHeader title={t('actions.title')} />
      {autonomy.actions.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('actions.none')}</p>
        : <ActionsTable t={wrap(t)} requests={!autonomy.usesCondition} loop={loop} actions={autonomy.actions} day={day} when={when} label={t('actions.title')} />}
    </Card>
  );
}

/** Level 3: each company's weekly sample, which HR reviews instead of every action. */
export async function LoopSamplesCard({ autonomy, loop }: { autonomy: LoopAutonomyDetail; loop: LoopId }) {
  if (!autonomy.samples.length) return null;
  const [t, f] = await Promise.all([getTranslations('aiCentre.autonomy'), getFormatter()]);
  const when = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const day = (iso: string) => f.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  return (
    <Card className="overflow-hidden">
      <SectionHeader title={t('sample.title')} subtitle={t('sample.help')} />
      {autonomy.samples.map(sample => (
        <section key={sample.companyId} data-loop-sample={sample.companyId} className="border-t border-border">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <p className="min-w-0"><span className="font-medium">{sample.companyName}</span>
              <span className="block text-xs text-muted-foreground">{t('sample.summary', { size: sample.actions.length, total: sample.total, week: day(sample.weekStart) })}</span></p>
            {sample.reviewed
              ? <p data-loop-sample-reviewed className="text-xs text-muted-foreground">{t('sample.reviewed', { name: sample.reviewed.byName ?? t('anAdministrator'), date: when(sample.reviewed.at) })}</p>
              : sample.canReview && <form action={reviewLoopSampleAction}>
                <input type="hidden" name="loop" value={loop} /><input type="hidden" name="company" value={sample.companyId} /><input type="hidden" name="week" value={sample.weekStart} />
                <button type="submit" className={cn(btnGhost, TARGET)} aria-label={`${t('sample.markReviewed')} · ${sample.companyName}`}>{t('sample.markReviewed')}</button>
              </form>}
          </div>
          {sample.actions.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('sample.none')}</p>
            : <ActionsTable t={wrap(t)} requests={!autonomy.usesCondition} loop={loop} actions={sample.actions} day={day} when={when} label={`${t('sample.title')} · ${sample.companyName}`} />}
        </section>
      ))}
    </Card>
  );
}

/** "Limits it can never cross" and "Who answers for it". */
export async function LoopGuardsAndOwner({ autonomy, loop, name, sponsorName, on, sponsorLost }: {
  autonomy: LoopAutonomyDetail; loop: LoopId; name: string; sponsorName: string | null; on: boolean; sponsorLost: boolean;
}) {
  const [t, tl, f] = await Promise.all([getTranslations('aiCentre.autonomy'), getTranslations('aiCentre.loops'), getFormatter()]);
  const day = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
  const acting = autonomy.companies.filter(item => item.level >= 2);
  const conditionLine = (item: AutonomyCompany) => item.limits && autonomy.usesCondition
    ? [t('limits.condition', { company: item.companyName, condition: t(`promote.conditions.${item.limits.condition}`) })
      + (item.conditionSetAt ? ` ${t('limits.chosenBy', { name: item.conditionSetByName ?? t('anAdministrator'), date: day(item.conditionSetAt) })}` : '')] : [];
  const limits = !acting.length ? [tl('limits.confirm'), tl('limits.scope'), tl('limits.model'), tl('limits.cap')]
    : autonomy.usesCondition
      ? [t('limits.clockIn'), t('limits.leave'), t('limits.pay'), t('limits.noOvertime'), ...acting.flatMap(conditionLine),
        ...acting.map(item => t('limits.perNight', { company: item.companyName, count: item.limits?.maxActionsPerNight ?? 0, days: item.limits?.undoDays ?? 3 })),
        t('limits.demotion'), tl('limits.model')]
      : [t('limits.requestOnly'), t('limits.requestActive'),
        ...acting.map(item => t('limits.perNightRequests', { company: item.companyName, count: item.limits?.maxActionsPerNight ?? 0, days: item.limits?.undoDays ?? 3 })),
        t('limits.demotion'), tl('limits.model')];
  const capped = touchesCapped(LOOP_AUTONOMY[loop].categories);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('limits.title')}</h2>
        <ul data-loop-limits className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{limits.map((line, index) => <li key={index}>{line}</li>)}</ul>
        {capped && <p className="mt-2 text-xs text-muted-foreground">{t('capped')}</p>}
        {acting.some(item => item.level === 3) && <p className="mt-2 text-xs text-muted-foreground">{t('limits.level3')}</p>}
      </Card>
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{tl('owner.title')}</h2>
        <p className="mt-2 text-sm">{tl('owner.agent', { name })}</p>
        <p className="mt-1 text-sm">{on && sponsorName !== null ? tl('owner.sponsor', { name: sponsorName }) : tl('owner.noSponsor')}</p>
        {sponsorLost && <p data-loop-suspended className="mt-2 text-sm text-amber-700 dark:text-amber-300">{t('owner.suspended')}</p>}
        <p className="mt-2 text-xs text-muted-foreground">{t('owner.note')}</p>
      </Card>
    </div>
  );
}
