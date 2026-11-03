import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { LoopViewRefused, loopDetail, type LoopCaseView } from '@/core/loops/views';
import type { LoopId } from '@/core/loops/types';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnGhost, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../../operations-tabs';
import { setLoopPauseAction, setLoopSwitchAction } from '../actions';

/** AI v2 W8 — one loop's page (approved Phase 2 mock-up Main.dc.html "Loop detail", simplified to the Prepare level):
 * what done means, its four steps, its figures for the last 30 days, a pause per company the viewer administers, its
 * recent cards and runs, the limits it never crosses at this level, and who answers for it. Read under the viewer's
 * row-level security (core/loops/views.ts loopDetail); guarded by requireAdmin like every Operations page. */
const ERRORS = ['invalid', 'refused', 'module', 'failed'] as const;
const STEPS = ['detect', 'diagnose', 'prepare', 'verify'] as const;
const LIMITS = ['confirm', 'scope', 'model', 'cap'] as const;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const str = (facts: LoopCaseView['facts'], key: string) => (typeof facts[key] === 'string' ? (facts[key] as string) : null);
const count = (facts: LoopCaseView['facts'], key: string) => (Array.isArray(facts[key]) ? (facts[key] as readonly string[]).length : 0);

export default async function LoopPage({ params, searchParams }: { params: Promise<{ loop: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const s = await requireAdmin();
  const [{ loop }, query, t, f] = await Promise.all([params, searchParams, getTranslations('aiCentre.loops'), getFormatter()]);
  let detail: Awaited<ReturnType<typeof loopDetail>>;
  try { detail = await loopDetail(s, loop); } catch (e) { if (e instanceof LoopViewRefused && e.reason === 'not_found') notFound(); throw e; }
  const { row } = detail, id: LoopId = row.id, name = t(`names.${id}`);
  const error = ERRORS.find(code => code === query.error);
  const when = (date: Date) => f.dateTime(date, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const day = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? f.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) : '—');
  /** What the card was about, from the case's own facts. */
  const what = (item: LoopCaseView) => {
    const facts = item.facts;
    if (id === 'loop_probation_ending') return t('what.probation', { date: day(str(facts, 'endDate')) });
    if (id === 'loop_payroll_inputs') return t('what.payroll', { count: count(facts, 'missing'), date: day(str(facts, 'cutOff')) });
    if (id === 'loop_missing_employee_data') return t('what.record', { count: count(facts, 'gaps') });
    if (id === 'loop_missed_clock_outs') return t('what.clockOut', { time: str(facts, 'proposedCheckOut') ?? '—', date: day(str(facts, 'date')) });
    return t('what.passport', { date: day(str(facts, 'expiresOn')) });
  };
  const status = (item: LoopCaseView) => item.state === 'open' ? t('caseState.open') : item.state === 'waiting' ? t('caseState.waiting')
    : item.closeReason === 'done' ? t(`caseState.${item.resolution ?? 'completed'}`) : t(`caseState.${item.closeReason ?? 'superseded'}`);
  const tile = (label: string, value: string) => (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4">
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="loops" />
      <PageHeader back={{ href: '/control-tower/loops', label: t('back') }} title={name} description={t('doneMeansLine', { done: t(`doneMeans.${id}`) })}
        actions={<div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-border px-2.5 py-1 text-xs font-medium">{t('level.prepare')}</span>
          <span data-loop-switch={row.on ? 'on' : 'off'} className="text-sm">{row.stopped ? t('stopped') : row.on ? t('on') : t('off')}</span>
          {detail.canSwitch && <form action={setLoopSwitchAction}>
            <input type="hidden" name="loop" value={id} /><input type="hidden" name="from" value="detail" /><input type="hidden" name="enabled" value={String(!row.on)} />
            <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t(row.on ? 'turnOff' : 'turnOn')} · ${name}`}>{t(row.on ? 'turnOff' : 'turnOn')}</button>
          </form>}
        </div>} />
      {error && <ErrorBanner message={t(`errors.${error}`)} />}
      {(query.saved === 'switch' || query.saved === 'pause') && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t('saved')}</p>}

      <ol data-loop-steps className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, index) => (
          <li key={step} className="min-w-0 rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">{t('stepLabel', { n: index + 1, step: t(`steps.${step}`) })}</p>
            <p className="mt-1 text-sm">{t(`stepText.${id}.${step}`)}</p>
          </li>
        ))}
      </ol>

      <div data-loop-figures className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile(t('figures.prepared', { days: detail.windowDays }), String(row.prepared))}
        {tile(t('figures.confirmed'), String(row.confirmed))}
        {tile(t('figures.changed'), !row.proposesValue ? t('notApplicable') : row.correctionRate === null ? t('noneYet') : percent(row.correctionRate))}
        {tile(t('figures.open'), t('openWaiting', { open: row.openNow, waiting: row.waitingNow }))}
      </div>
      <p className="text-xs text-muted-foreground">{t('figures.noSpend')}</p>

      <Card className="overflow-hidden">
        <SectionHeader title={t('pause.title')} />
        <p className="px-4 pb-3 text-sm text-muted-foreground">{t('pause.help')}</p>
        {detail.companies.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('pause.none')}</p> : (
          <ul className="divide-y divide-border border-t border-border">
            {detail.companies.map(item => (
              <li key={item.companyId} data-loop-company={item.companyId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 break-words">{item.companyName}</span>
                <span className="flex items-center gap-3">
                  <span className={cn('text-xs', item.paused ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{item.paused ? t('pause.paused') : t('pause.running')}</span>
                  <form action={setLoopPauseAction}>
                    <input type="hidden" name="loop" value={id} /><input type="hidden" name="from" value="detail" />
                    <input type="hidden" name="company" value={item.companyId} /><input type="hidden" name="paused" value={String(!item.paused)} />
                    <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t(item.paused ? 'pause.resume' : 'pause.pause')} · ${item.companyName}`}>{t(item.paused ? 'pause.resume' : 'pause.pause')}</button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('cases.title')} />
        {detail.cases.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('cases.none')}</p> : (
          <div className="overflow-x-auto">
            <table data-loop-cases className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">{t('cases.title')}</caption>
              <thead className="border-y border-border bg-muted/40"><tr>{(['when', 'person', 'what', 'status'] as const).map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(`cases.columns.${key}`)}</th>)}</tr></thead>
              <tbody className="divide-y divide-border">
                {detail.cases.map(item => (
                  <tr key={item.id} data-loop-case={item.state}>
                    <td className="px-4 py-3 tabular-nums">{when(item.closedAt ?? item.openedAt)}</td>
                    <td className="px-4 py-3">{item.personName ?? item.companyName ?? '—'}{item.personName && item.companyName && <span className="block text-xs text-muted-foreground">{item.companyName}</span>}</td>
                    <td className="px-4 py-3">{what(item)}{item.reopenCount > 0 && <span className="block text-xs text-muted-foreground">{t('cases.reopened', { count: item.reopenCount })}</span>}</td>
                    <td className="px-4 py-3">{status(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('limits.title')}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{LIMITS.map(limit => <li key={limit}>{t(`limits.${limit}`)}</li>)}</ul>
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-semibold">{t('owner.title')}</h2>
          <p className="mt-2 text-sm">{t('owner.agent', { name })}</p>
          <p className="mt-1 text-sm">{row.sponsor ? t('owner.sponsor', { name: row.sponsor.name ?? t('sponsorUnnamed') }) : t('owner.noSponsor')}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t('owner.note')}</p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <SectionHeader title={t('runs.title')} />
        {detail.runs.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('runs.none')}</p> : (
          <ul className="divide-y divide-border border-t border-border">
            {detail.runs.map((run, index) => (
              <li key={index} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3 text-sm">
                <span className="tabular-nums">{when(run.at)}{run.companyName && <span className="ml-2 text-muted-foreground">{run.companyName}</span>}</span>
                <span className="text-muted-foreground">{run.status === 'ran'
                  ? t('runs.summary', { opened: run.opened + run.reopened, closed: run.closed, open: run.openNow, waiting: run.waitingNow }) + (run.capped ? ` ${t('runs.capped')}` : '')
                  : t(`runStatus.${run.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
