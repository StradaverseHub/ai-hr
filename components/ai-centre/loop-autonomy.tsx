import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { LoopAutonomyDetail, AutonomyActionView, AutonomyCompany } from '@/core/loops/autonomy-views';
import { LOOP_AUTONOMY, touchesCapped } from '@/core/loops/autonomy';
import { levelKey, type AutonomyLevel } from '@/core/loops/autonomy-types';
import type { LoopId } from '@/core/loops/types';
import { Card, SectionHeader, btnGhost } from '@/components/ui';
import { cn } from '@/lib/utils';
import { undoLoopActionFromDetailAction } from '@/app/control-tower/loops/autonomy-actions';

/** AI v2 Phase 2 P2-1 — a loop's level, its automatic actions and its limits, on the loop's own page (approved mock-up
 * Main.dc.html: the level badges, Recent actions with Undo, "Limits it can never cross" and "Who answers for it").
 * Every value comes from core/loops/autonomy-views.ts, read under the viewer's row-level security. Undo posts to the
 * owner through core/loops/undo.ts, which checks everything again; the page itself decides nothing. */
const TARGET = 'pointer-coarse:min-h-11';
const BADGE = 'rounded-full border border-border px-2.5 py-1 text-xs font-medium';
const percent = (value: number) => `${(Math.round(value * 1000) / 10).toString()}%`;
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

export const AUTONOMY_NOTICES = ['undone', 'expired', 'changed', 'access', 'ask_hr', 'unavailable', 'invalid'] as const;
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
  const f = autonomy.figures;
  return <div data-loop-autonomy-figures className="grid gap-3 sm:grid-cols-3">
    {tile(t('figures.applied', { days: autonomy.windowDays }), String(f.applied))}
    {tile(t('figures.corrected'), f.correctedShare === null ? t('figures.none') : percent(f.correctedShare))}
    {tile(t('figures.undoneByEmployee'), String(f.undoneByEmployee))}
  </div>;
}

/** The level in each company the viewer administers, with the way to its limits and levels. */
export async function LoopLevelsCard({ autonomy, loop, notice }: { autonomy: LoopAutonomyDetail; loop: LoopId; notice: AutonomyNotice | null }) {
  const [t, f] = await Promise.all([getTranslations('aiCentre.autonomy'), getFormatter()]);
  const day = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
  const capped = touchesCapped(LOOP_AUTONOMY[loop].categories);
  const help = autonomy.promotableTo > 1 ? t('companiesHelp') : capped ? t('capped') : autonomy.maxLevel > 1 ? t('noActor') : t('stayPrepare');
  return (
    <Card className="overflow-hidden">
      <SectionHeader title={t('companiesTitle')} />
      <p data-loop-autonomy-help className="px-4 pb-3 text-sm text-muted-foreground">{help}</p>
      {notice && <p role={notice === 'undone' ? 'status' : 'alert'} data-loop-autonomy-notice={notice}
        className={cn('mx-4 mb-3 rounded-lg border p-3 text-sm', notice === 'undone' ? 'border-border bg-muted/50' : 'border-destructive/30 bg-destructive/10 text-destructive')}>
        {t(`notices.${notice}`)}</p>}
      {autonomy.companies.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('noCompanies')}</p> : (
        <ul className="divide-y divide-border border-t border-border">
          {autonomy.companies.map(item => (
            <li key={item.companyId} data-loop-level-company={item.companyId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 break-words">{item.companyName}
                {item.changedAt && <span className="block text-xs text-muted-foreground">{item.changedBy === 'automatic'
                  ? t('changedAuto', { date: day(item.changedAt) }) : t('changedBy', { name: item.changedByName ?? t('anAdministrator'), date: day(item.changedAt) })}</span>}
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

/** Recent automatic actions, each with Undo while its window is open and the viewer administers the employment. */
export async function LoopActionsCard({ autonomy, loop }: { autonomy: LoopAutonomyDetail; loop: LoopId }) {
  if (!autonomy.hasActor) return null;
  const [t, f] = await Promise.all([getTranslations('aiCentre.autonomy'), getFormatter()]);
  const when = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const day = (iso: string) => f.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  /** What one action did and where it stands, from its own record. */
  const describe = (item: AutonomyActionView) => {
    const date = isDate(item.facts.date) ? day(item.facts.date) : '—';
    const time = typeof item.facts.checkOut === 'string' ? item.facts.checkOut : '—';
    const what = item.state === 'not_applied' ? t('actions.notSet', { reason: t(`actions.reasons.${item.reason ?? 'owner_refused'}`), date }) : t('actions.set', { time, date });
    const status = item.undo ? t(item.undo.by === 'employee' ? 'actions.status.undoneEmployee' : 'actions.status.undoneHr')
      : item.peopleChanged ? t('actions.status.changed')
      : item.state === 'applied' ? (item.undoUntil.getTime() > Date.now() ? t('actions.status.fixed', { date: when(item.undoUntil) }) : t('actions.status.fixedClosed'))
      : item.state === 'applying' ? t('actions.status.applying') : t('actions.status.toPerson');
    return { what, status };
  };
  return (
    <Card className="overflow-hidden">
      <SectionHeader title={t('actions.title')} />
      {autonomy.actions.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('actions.none')}</p> : (
        <div className="overflow-x-auto">
          <table data-loop-actions className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">{t('actions.title')}</caption>
            <thead className="border-y border-border bg-muted/40"><tr>{(['when', 'person', 'what', 'status', 'action'] as const).map(key =>
              <th key={key} scope="col" className={cn('px-4 py-3 font-medium', key === 'action' && 'text-right')}>
                {key === 'action' ? <span className="sr-only">{t('actions.columns.action')}</span> : t(`actions.columns.${key}`)}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {autonomy.actions.map(item => {
                const { what, status } = describe(item);
                return (
                  <tr key={item.id} data-loop-action={item.undo ? 'undone' : item.state}>
                    <td className="px-4 py-3 tabular-nums">{when(item.at)}</td>
                    <td className="px-4 py-3">{item.personName ?? '—'}{item.companyName && <span className="block text-xs text-muted-foreground">{item.companyName}</span>}</td>
                    <td className="px-4 py-3">{what}</td>
                    <td className="px-4 py-3">{status}</td>
                    <td className="px-4 py-3 text-right">{item.canUndo && (
                      <form action={undoLoopActionFromDetailAction}>
                        <input type="hidden" name="loop" value={loop} /><input type="hidden" name="action" value={item.id} />
                        <button type="submit" className={cn(btnGhost, TARGET)} aria-label={`${t('actions.undo')} · ${item.personName ?? what}`}>{t('actions.undo')}</button>
                      </form>
                    )}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** "Limits it can never cross" and "Who answers for it". */
export async function LoopGuardsAndOwner({ autonomy, loop, name, sponsorName, on, sponsorLost }: {
  autonomy: LoopAutonomyDetail; loop: LoopId; name: string; sponsorName: string | null; on: boolean; sponsorLost: boolean;
}) {
  const [t, tl] = await Promise.all([getTranslations('aiCentre.autonomy'), getTranslations('aiCentre.loops')]);
  const acting = autonomy.companies.filter(item => item.level >= 2);
  const limits = acting.length
    ? [t('limits.clockIn'), t('limits.leave'), t('limits.pay'),
      ...acting.map(item => t('limits.perNight', { company: item.companyName, count: item.limits?.maxActionsPerNight ?? 0, days: item.limits?.undoDays ?? 3 })),
      t('limits.demotion'), tl('limits.model')]
    : [tl('limits.confirm'), tl('limits.scope'), tl('limits.model'), tl('limits.cap')];
  const capped = touchesCapped(LOOP_AUTONOMY[loop].categories);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('limits.title')}</h2>
        <ul data-loop-limits className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{limits.map((line, index) => <li key={index}>{line}</li>)}</ul>
        {capped && <p className="mt-2 text-xs text-muted-foreground">{t('capped')}</p>}
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
