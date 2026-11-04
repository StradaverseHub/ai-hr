import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import type { SessionContext } from '@/db/client';
import { Card, SectionHeader, btnGhost, inputCls } from '@/components/ui';
import { ASSESSMENT_WINDOWS, MIN_COMPLETED, AGED_OPEN_DAYS, assessProcesses, estimateLoad, parseWindow, type AgentRole, type ProcessAssessment } from '@/core/process-assessment';
import { MIN_AFTER_DAYS, assistantOutcomes, type ProcessComparison } from '@/core/assistant-outcomes';
import { agentBacklogByTier, agentCapabilityCoverage } from '@/lib/ai/agent-capability-inventory';
import type { CurrentBaseline } from '@/core/capacity/baseline';
import { cn } from '@/lib/utils';

/** AI Centre restructure (owner decision 29, 4 November 2026) — Insights › HR capacity's "Where the work is": the measured
 * part of the former Opportunities page (ADR-0131 Phase 1), so time saved has one place.
 *
 * Every number is computed from records the engine already holds: each process's cases, durations, rework and staff
 * actions per 30 days (core/process-assessment.ts), the Assistant's before-and-after and outcomes (core/assistant-outcomes.ts)
 * and the automatic reminders, all scoped by the administrator's own scope. Nothing here calls a model or changes anything.
 *
 * THE STORED BASELINE IS THE ONLY MINUTES INPUT. Opportunities let an administrator type minutes per staff action (and
 * full-time hours) into the address bar, unsaved; HR capacity already keeps one baseline per company, versioned. A
 * process's monthly hours are estimated from that baseline's minutes per staff action, and only when the figures and the
 * baseline describe the same company (the viewer administers one company, and its baseline sets the minutes). No
 * headcount or full-time equivalent is shown (owner rule: no HR-staff ratio anywhere). The ranked build list and its
 * export moved to Administration › Build list (group administrators only).
 *
 * Rendered by the HR capacity section, which only an administrator's Insights view renders; each reader checks the
 * administrator again under the viewer's row-level security. */
export type ProcessQuery = { pdays?: string };

const ROLE_TONE: Record<AgentRole, string> = {
  automate_parts: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-200',
  assist: 'border-sky-600/40 bg-sky-600/10 text-sky-800 dark:text-sky-200',
  measure_first: 'border-amber-600/40 bg-amber-600/10 text-amber-900 dark:text-amber-200',
  off: 'border-border bg-muted text-muted-foreground',
};
const target = 'pointer-coarse:min-h-11';

type Reads = Readonly<{ view: Awaited<ReturnType<typeof assessProcesses>>; outcomes: Awaited<ReturnType<typeof assistantOutcomes>> }>;

/** The two readers, started by the HR capacity section beside its own read. */
export function readCapacityProcesses(session: SessionContext, query: ProcessQuery): Promise<Reads | null> {
  const window = parseWindow(query.pdays);
  return Promise.all([assessProcesses(session, window), assistantOutcomes(session, window)])
    .then(([view, outcomes]) => ({ view, outcomes })).catch(() => null);
}

export async function CapacityProcesses({ reads, query, companies, baselines, keep }: {
  reads: Reads | null; query: ProcessQuery; companies: readonly Readonly<{ id: string; name: string }>[]; baselines: readonly CurrentBaseline[];
  /** The ledger's own filter, kept when the window changes. */
  keep: Readonly<Record<string, string | null | undefined>>;
}) {
  const [t, tc, o, kinds, f] = await Promise.all([getTranslations('processAssessment'), getTranslations('aiCentre.capacity.processes'),
    getTranslations('processAssessment.outcomes'), getTranslations('assistant.workspace.nativeOutcomes'), getFormatter()]);
  if (!reads) return <section id="capacity-processes" aria-labelledby="capacity-processes-title" className="scroll-mt-4 space-y-2" data-capacity-processes="unavailable">
    <h3 id="capacity-processes-title" className="font-semibold">{tc('title')}</h3>
    <p role="status" className="text-sm text-muted-foreground">{tc('unavailable')}</p>
  </section>;
  const { view, outcomes } = reads;
  const window = parseWindow(query.pdays);
  // The one minutes input: the stored baseline of the one company the figures describe.
  const only = companies.length === 1 ? companies[0] : null;
  const minutes = only ? baselines.find(row => row.companyId === only.id)?.minutesPerStaffAction ?? null : null;
  const comparison = new Map(outcomes.processes.map(c => [c.id, c]));
  const coverage = agentCapabilityCoverage(), backlog = agentBacklogByTier();
  const day = (d: Date) => f.dateTime(d, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
  const kindLabel = (action: string) => { const key = `action_${action.replace(/[.-]/g, '_')}`; return kinds.has(key) ? kinds(key) : action; };
  const n = (v: number) => f.number(v, { maximumFractionDigits: 1 });
  const duration = (hours: number | null) => hours == null ? '—'
    : hours * 60 < 1 ? t('underMinute')
    : hours < 1 ? t('minutesShort', { n: Math.round(hours * 60) })
    : hours < 48 ? t('hours', { n: n(hours) }) : t('days', { n: n(hours / 24) });
  const metric = (label: string, value: string, hint?: string) => <div className="min-w-0 lg:border-l lg:border-border lg:pl-4 lg:first:border-l-0 lg:first:pl-0">
    <dt className="min-h-[2.5em] text-xs leading-tight text-muted-foreground">{label}</dt>
    <dd className="mt-1 text-2xl font-semibold leading-none tracking-tight tabular-nums">{value}</dd>
    {hint && <dd className="mt-1.5 text-xs leading-snug text-muted-foreground">{hint}</dd>}
  </div>;

  // Staff actions per 30 days in equal periods before and after the first Assistant use for this process.
  const beforeAfter = (c: ProcessComparison | undefined) => {
    if (!c) return null;
    if (!c.firstUse) return <p className="mt-3 text-sm text-muted-foreground">{o('noUse')}</p>;
    if (!c.before || !c.after) return <p className="mt-3 text-sm text-muted-foreground">{o('firstUse', { date: day(c.firstUse) })} {o('notLinked')}</p>;
    // No case started before first use means there is no baseline, not a baseline of zero.
    const baseline = c.before.started > 0;
    const delta = c.after.per30 - c.before.per30;
    return <div className="mt-3 rounded-lg border border-border p-4">
      <p className="text-xs font-medium text-muted-foreground">{o('beforeAfterTitle', { date: day(c.firstUse) })}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">{o('before')}</dt>
          <dd className="text-xl font-semibold tabular-nums">{baseline ? n(c.before.per30) : '—'}</dd>
          <dd className="text-xs text-muted-foreground">{baseline ? o('periodCases', { from: day(c.before.from), n: n(c.before.started) }) : o('noBaseline', { from: day(c.before.from) })}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{o('after')}</dt>
          <dd className="text-xl font-semibold tabular-nums">{n(c.after.per30)}</dd>
          <dd className="text-xs text-muted-foreground">{o('periodCases', { from: day(c.after.from), n: n(c.after.started) })}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{o('change')}</dt>
          <dd className="text-xl font-semibold tabular-nums">{baseline ? `${delta > 0 ? '+' : ''}${n(delta)}` : '—'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{o('assistantConfirmed')}</dt>
          <dd className="text-xl font-semibold tabular-nums">{n(c.assistantCompleted)}</dd></div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">{c.early ? o('early', { days: MIN_AFTER_DAYS }) + ' ' : ''}{o('notCausal')}</p>
    </div>;
  };

  const card = (p: ProcessAssessment, rank: number) => {
    const m = p.measures;
    const acts = m ? m.staffActions + m.employeeActions + m.automatedActions : 0;
    // Hours only, from the stored baseline's minutes; never a full-time equivalent.
    const load = !p.staffActionsPer30 ? null : estimateLoad(p.staffActionsPer30, minutes, null);
    return <Card key={p.id} className="p-5" data-capacity-process={p.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-base font-semibold"><span className="mr-2 text-muted-foreground tabular-nums">{rank}.</span>{t(`processes.${p.id}`)}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t(`decision.${p.profile.decision}`)}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${ROLE_TONE[p.role]}`}>{t(`roles.${p.role}`)}</span>
      </div>
      {!p.enabled ? <p className="mt-4 text-sm text-muted-foreground">{t('moduleOff')}</p> : m && <>
        {p.role === 'measure_first' && <p className="mt-3 flex items-start gap-2 rounded-md bg-amber-600/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />{t('needMore', { min: MIN_COMPLETED })}</p>}
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 rounded-lg bg-muted/40 p-4 sm:grid-cols-3 lg:grid-cols-5 lg:gap-x-0">
          {metric(t('started'), n(m.started), m.closedUndecided ? t('completedClosed', { n: n(m.completed), w: n(m.closedUndecided) }) : t('completedOf', { n: n(m.completed) }))}
          {metric(t('open'), n(m.open), m.agedOpen ? t('agedOpen', { n: n(m.agedOpen), days: AGED_OPEN_DAYS }) : undefined)}
          {metric(t('median'), duration(m.medianHours), m.p90Hours == null ? undefined : t('p90', { value: duration(m.p90Hours) }))}
          {metric(t('rework'), m.started ? f.number(m.rework / m.started, { style: 'percent' }) : '—', t('reworkHint'))}
          {p.profile.actionsLinked
            ? metric(t('staffActions'), n(p.staffActionsPer30 ?? 0), acts ? t('automatedShare', { share: f.number(m.automatedActions / acts, { style: 'percent' }) }) : undefined)
            : metric(t('staffActions'), '—', t('notLinked'))}
        </dl>
        {beforeAfter(comparison.get(p.id))}
        {load && <p className="mt-3 text-sm" data-capacity-estimate>{tc('estimate', { hours: n(load.hours) })} <span className="text-xs text-muted-foreground">{tc('estimateLabel', { minutes: n(minutes ?? 0) })}</span></p>}
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground">{t('candidates')}</p>
          <ul className="mt-2 flex flex-wrap gap-2">{p.profile.actions.map(a => <li key={a.id} className="rounded-md border border-border px-2 py-1 text-xs">
            {t(`actions.${a.id}`)} <span className="text-muted-foreground">· {t(`tiers.${a.tier}`)}</span></li>)}</ul>
        </div>
      </>}
    </Card>;
  };

  return (
    <section id="capacity-processes" aria-labelledby="capacity-processes-title" className="scroll-mt-4 space-y-4" data-capacity-processes>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 id="capacity-processes-title" className="font-semibold">{tc('title')}</h3>
          <p className="mt-0.5 max-w-4xl text-sm text-muted-foreground">{tc('description')}</p>
        </div>
        <form method="get" action="/assistant" className="flex flex-wrap items-end gap-2" data-capacity-window>
          <input type="hidden" name="view" value="insights" />
          {Object.entries(keep).map(([key, value]) => value ? <input key={key} type="hidden" name={key} value={value} /> : null)}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('window')}</span>
            <select name="pdays" defaultValue={String(window)} className={cn(inputCls, 'min-w-40', target)}>
              {ASSESSMENT_WINDOWS.map(d => <option key={d} value={d}>{t('windowDays', { days: d })}</option>)}
            </select>
          </label>
          <button type="submit" className={cn(btnGhost, target)}>{t('apply')}</button>
        </form>
      </div>
      <p className="max-w-4xl text-xs text-muted-foreground" data-capacity-minutes={minutes === null ? 'none' : 'baseline'}>
        {minutes !== null && only ? tc('minutesFromBaseline', { company: only.name, minutes: n(minutes) })
          : only ? tc('minutesNoBaseline', { company: only.name }) : tc('minutesSeveral')}
      </p>
      <p className="max-w-4xl text-sm text-muted-foreground">{t('rankHelp', { from: day(view.from) })}</p>
      {view.processes.map((p, i) => card(p, i + 1))}

      <Card className="overflow-hidden">
        <SectionHeader title={o('title')} subtitle={o('subtitle', { from: day(outcomes.from) })} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <caption className="sr-only">{o('title')}</caption>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">{o('colAction')}</th>
                {(['colOffered', 'colPrepared', 'colEdited', 'colConfirmed', 'colDiscarded', 'colExpired', 'colRefused', 'colFailed', 'colReversed', 'colWaiting'] as const)
                  .map(k => <th key={k} scope="col" className="px-3 py-2 text-right font-medium">{o(k)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {outcomes.actions.filter(a => a.prepared > 0).map(a => <tr key={a.action}>
                <td className="px-4 py-2.5"><span className="block">{kindLabel(a.action)}</span><span className="font-mono text-xs text-muted-foreground">{a.action}</span></td>
                <td className="px-3 py-2.5 text-right text-muted-foreground" title={o('notRecorded')}>—</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.prepared)}</td>
                <td className="px-3 py-2.5 text-right text-muted-foreground" title={o('notRecorded')}>—</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.completed)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.discarded)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.expired)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.refused)}</td>
                <td className="px-3 py-2.5 text-right text-muted-foreground" title={o('notRecorded')}>—</td>
                <td className="px-3 py-2.5 text-right tabular-nums" title={a.reversed == null ? o('reversalNotProvable') : undefined}>{a.reversed == null ? '—' : n(a.reversed)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.awaiting)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {outcomes.actions.every(a => a.prepared === 0) && <p className="px-4 py-3 text-sm text-muted-foreground">{o('none')}</p>}
        {outcomes.actions.some(a => a.prepared === 0) && <p className="px-4 py-3 text-xs text-muted-foreground">
          {o('unused', { list: outcomes.actions.filter(a => a.prepared === 0).map(a => kindLabel(a.action)).join(' · ') })}</p>}
        <ul className="max-w-4xl list-disc space-y-1 border-t border-border px-4 py-3 pl-9 text-xs text-muted-foreground">
          <li>{o('limitUnrecorded')}</li><li>{o('limitReversed')}</li><li>{o('limitScope')}</li>
        </ul>
      </Card>

      {/* WP13 (R18) — the Automatic-tier reminders the scheduled agent sent, beside the Assistant's actions. */}
      <Card className="overflow-hidden">
        <SectionHeader title={o('automaticTitle')} subtitle={o('automaticSubtitle', { from: day(outcomes.from) })} />
        {outcomes.automatic.some(a => a.chased > 0) ? <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">{o('automaticTitle')}</caption>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">{o('colAction')}</th>
                {(['colReminders', 'colItems', 'colActed', 'colStillWaiting'] as const).map(k => <th key={k} scope="col" className="px-3 py-2 text-right font-medium">{o(k)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {outcomes.automatic.filter(a => a.chased > 0).map(a => <tr key={a.action}>
                <td className="px-4 py-2.5"><span className="block">{kindLabel(a.action)}</span><span className="font-mono text-xs text-muted-foreground">{a.action}</span></td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.chased)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.items)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.acted)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{n(a.waiting)}</td>
              </tr>)}
            </tbody>
          </table>
        </div> : <p className="px-4 py-3 text-sm text-muted-foreground">{o('automaticNone')}</p>}
        <p className="max-w-4xl border-t border-border px-4 py-3 text-xs text-muted-foreground">{o('automaticLimit')} {o('limitScope')}</p>
      </Card>

      <Card className="p-5">
        <SectionHeader title={o('coverageTitle')} subtitle={o('coverageSubtitle')} />
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 rounded-lg bg-muted/40 p-4 sm:grid-cols-3 lg:grid-cols-6 lg:gap-x-0">
          {metric(o('coverageRegistered'), n(coverage.registered ?? 0))}
          {metric(o('coverageBacklogAutomatic'), n(backlog.automatic))}
          {metric(o('coverageBacklogConfirm'), n(backlog.confirm))}
          {metric(o('coverageBacklogApprove'), n(backlog.approve))}
          {metric(o('coverageHandoff'), n(coverage.handoff ?? 0))}
          {metric(o('coverageInternal'), n(coverage.internal ?? 0))}
        </dl>
        <p className="mt-3 max-w-4xl text-xs text-muted-foreground">{o('coverageHelp')}</p>
      </Card>

      <Card className="p-5">
        <SectionHeader title={t('limitsTitle')} />
        <ul className="mt-2 max-w-4xl list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t('limitEffort')}</li><li>{t('limitOutside')}</li><li>{tc('limitHours')}</li><li>{t('limitNoChange')}</li>
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">{t('version', { version: view.version })} · {o('version', { version: outcomes.version })}</p>
      </Card>
      {only && minutes === null && <Link href={`/assistant?${new URLSearchParams({ view: 'insights', setup: only.id })}#capacity-setup`} className={cn(btnGhost, target)}>{tc('setBaseline', { company: only.name })}</Link>}
    </section>
  );
}
