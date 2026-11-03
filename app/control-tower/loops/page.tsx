import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { loopsOverview, type LoopRow } from '@/core/loops/views';
import { Card, ErrorBanner, PageHeader, btnGhost, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../operations-tabs';
import { setLoopSwitchAction } from './actions';
import { loopLevelSummaries } from '@/core/loops/autonomy-views';
import { levelKey } from '@/core/loops/autonomy-types';

/** AI v2 W8 — AI Centre › Operations › Loops (approved mock-up Operations.dc.html, its loop table, at the Prepare level).
 *
 * One row per loop: what "done" means, its level (Prepare: it prepares a card and a person confirms), its switch, its
 * last run, and over the last 30 days the cards it prepared, how many people completed as prepared, and how many they
 * changed (the correction rate, only where the card proposes a value of its own), and its sponsor. Every figure is read
 * under the viewer's row-level security (core/loops/views.ts): an HR administrator of one company sees that company's
 * cards only. A group administrator switches a loop here; anyone else sees its state. Guarded by requireAdmin, as every
 * Operations page is. Names are the AI Centre's; nothing here says Noveri. */
const ERRORS = ['invalid', 'refused', 'module', 'failed'] as const;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const SWITCH_TONE = 'text-emerald-700 dark:text-emerald-300';

export default async function LoopsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const s = await requireAdmin();
  const [t, f, view, query, levels, ta] = await Promise.all([getTranslations('aiCentre.loops'), getFormatter(), loopsOverview(s), searchParams,
    loopLevelSummaries(s), getTranslations('aiCentre.autonomy')]);
  // AI v2 Phase 2 P2-1: the level of each loop across the companies the viewer administers (one level: just its name).
  const levelText = (row: LoopRow) => {
    const groups = levels[row.id] ?? [];
    if (groups.length <= 1) return ta(`levels.${levelKey(groups[0]?.level ?? 1)}`);
    return groups.map(group => ta('summaryCount', { level: ta(`levels.${levelKey(group.level)}`), count: group.count })).join(' · ');
  };
  const error = ERRORS.find(code => code === query.error);
  const when = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const name = (row: LoopRow) => t(`names.${row.id}`);
  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="loops" />
      <PageHeader title={t('title')} description={t('description')} />
      {error && <ErrorBanner message={t(`errors.${error}`)} />}
      {query.saved === 'switch' && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t('saved')}</p>}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table data-loops-table className="w-full min-w-[960px] text-left text-sm">
            <caption className="sr-only">{t('title')}</caption>
            <thead className="border-b border-border bg-muted/40">
              <tr>{(['loop', 'doneMeans', 'level', 'switch', 'lastRun', 'prepared', 'confirmed', 'changed', 'sponsor'] as const).map(key =>
                <th key={key} scope="col" className="px-4 py-3 font-medium">{key === 'prepared' ? t('columns.prepared', { days: view.windowDays }) : t(`columns.${key}`)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.rows.map(row => (
                <tr key={row.id} id={`loop-${row.id}`} data-loop-row={row.id} className="align-top">
                  <th scope="row" className="px-4 py-3 font-medium">
                    <Link href={`/control-tower/loops/${row.id}`} className="inline-flex min-h-9 items-center text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">{name(row)}</Link>
                    {row.pausedCompanies > 0 && <p className="mt-1 text-xs font-normal text-muted-foreground">{t('pausedIn', { count: row.pausedCompanies })}</p>}
                  </th>
                  <td className="px-4 py-3 text-muted-foreground">{t(`doneMeans.${row.id}`)}</td>
                  <td data-loop-level-summary className="px-4 py-3">{levelText(row)}</td>
                  <td className="px-4 py-3">
                    <p data-loop-switch={row.on ? 'on' : 'off'} className={cn(row.on && !row.stopped && SWITCH_TONE)}>{row.stopped ? t('stopped') : row.on ? t('on') : t('off')}</p>
                    {view.canSwitch && (
                      <form action={setLoopSwitchAction} className="mt-1">
                        <input type="hidden" name="loop" value={row.id} />
                        <input type="hidden" name="enabled" value={String(!row.on)} />
                        <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t(row.on ? 'turnOff' : 'turnOn')} · ${name(row)}`}>{t(row.on ? 'turnOff' : 'turnOn')}</button>
                      </form>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {row.lastRun ? <><p>{when(row.lastRun.at)}</p>{row.lastRun.status !== 'ran' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t(`runStatus.${row.lastRun.status}`)}</p>}</> : <span className="text-muted-foreground">{t('never')}</span>}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{row.prepared}</td>
                  <td className="px-4 py-3 tabular-nums">{row.confirmed}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {!row.proposesValue ? <span className="text-muted-foreground">{t('notApplicable')}</span>
                      : row.correctionRate === null ? <span className="text-muted-foreground">{t('noneYet')}</span>
                        : t('changedRate', { rate: percent(row.correctionRate), count: row.changed })}
                  </td>
                  <td className="px-4 py-3">{row.sponsor ? (row.sponsor.name ?? t('sponsorUnnamed')) : <span className="text-muted-foreground">{t('noSponsor')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="max-w-4xl text-xs text-muted-foreground">{view.canSwitch ? t('switchNote') : t('switchNoteCompany')}</p>
      <p className="max-w-4xl text-xs text-muted-foreground">{t('cap')}</p>
    </div>
  );
}
