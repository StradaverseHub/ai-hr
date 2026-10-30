import { isGroupAdmin } from '@/lib/authz-model';
import { agentBuildList } from '@/core/agent-build-list';
import { RankedBuildList } from './build-list';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { ASSESSMENT_WINDOWS, MIN_COMPLETED, AGED_OPEN_DAYS, assessProcesses, estimateLoad, parseBoundedInt, parseWindow,
  type AgentRole, type ProcessAssessment } from '@/core/process-assessment';
import { Info } from 'lucide-react';
import { Card, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { MIN_AFTER_DAYS, assistantOutcomes, type ProcessComparison } from '@/core/assistant-outcomes';
import { agentBacklogByTier, agentCapabilityCoverage } from '@/lib/ai/agent-capability-inventory';

/**
 * ADR-0131 Phase 1 — where agents could take work off HR. Every number is computed from records the engine
 * already holds; nothing here calls a model or changes anything. Staff time appears ONLY from the
 * administrator's own inputs, because minutes of effort are recorded nowhere.
 */
const ROLE_TONE: Record<AgentRole, string> = {
  automate_parts: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-200',
  assist: 'border-sky-600/40 bg-sky-600/10 text-sky-800 dark:text-sky-200',
  measure_first: 'border-amber-600/40 bg-amber-600/10 text-amber-900 dark:text-amber-200',
  off: 'border-border bg-muted text-muted-foreground',
};

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ days?: string; minutes?: string; fteHours?: string; backlogPage?: string }> }) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const t = await getTranslations('processAssessment');
  const o = await getTranslations('processAssessment.outcomes');
  const kinds = await getTranslations('assistant.workspace.nativeOutcomes');
  const f = await getFormatter();
  const window = parseWindow(sp.days);
  const minutes = parseBoundedInt(sp.minutes, 1, 480);
  const fteHours = parseBoundedInt(sp.fteHours, 1, 400);
  const buildList = isGroupAdmin(s) ? await agentBuildList(s, window) : null;
  const view = buildList?.assessment ?? await assessProcesses(s, window);
  // ADR-0151 §4.6c, beside the baseline. Counts only, scoped by the same administrator scope.
  const outcomes = await assistantOutcomes(s, window);
  const comparison = new Map(outcomes.processes.map(c => [c.id, c]));
  const coverage = agentCapabilityCoverage(), backlog = agentBacklogByTier();
  const day = (d: Date) => f.dateTime(d, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
  const kindLabel = (action: string) => { const key = `action_${action.replace(/[.-]/g, '_')}`; return kinds.has(key) ? kinds(key) : action; };
  const n = (v: number) => f.number(v, { maximumFractionDigits: 1 });
  const duration = (hours: number | null) => hours == null ? '—'
    : hours * 60 < 1 ? t('underMinute')
    : hours < 1 ? t('minutesShort', { n: Math.round(hours * 60) })
    : hours < 48 ? t('hours', { n: n(hours) }) : t('days', { n: n(hours / 24) });

  // One figure per cell. Every label is given two lines of height, so the figures line up on one baseline
  // whatever a label's length in any locale; the hint is quieter than the figure and omitted when empty.
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
    const load = !p.staffActionsPer30 ? null : estimateLoad(p.staffActionsPer30, minutes, fteHours);
    return <Card key={p.id} className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold"><span className="mr-2 text-muted-foreground tabular-nums">{rank}.</span>{t(`processes.${p.id}`)}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t(`decision.${p.profile.decision}`)}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${ROLE_TONE[p.role]}`}>{t(`roles.${p.role}`)}</span>
      </div>
      {!p.enabled ? <p className="mt-4 text-sm text-muted-foreground">{t('moduleOff')}</p> : m && <>
        {/* The reason for the badge sits under it, in the badge's own colour, not at the foot of the card. */}
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
        {load && <p className="mt-3 text-sm">{load.fte == null ? t('estimateHours', { hours: n(load.hours) }) : t('estimateFte', { hours: n(load.hours), fte: f.number(load.fte, { maximumFractionDigits: 2 }) })} <span className="text-xs text-muted-foreground">{t('estimateLabel')}</span></p>}
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground">{t('candidates')}</p>
          <ul className="mt-2 flex flex-wrap gap-2">{p.profile.actions.map(a => <li key={a.id} className="rounded-md border border-border px-2 py-1 text-xs">
            {t(`actions.${a.id}`)} <span className="text-muted-foreground">· {t(`tiers.${a.tier}`)}</span></li>)}</ul>
        </div>
      </>}
    </Card>;
  };

  return <div className={pageWideCls}>
    <PageHeader back={{ href: '/control-tower', label: t('back') }} title={t('title')} description={t('description')} />
    <Card className="p-5">
      <form method="get" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,14rem))_auto]">
        <label className="text-xs">{t('window')}
          <select name="days" defaultValue={String(window)} className={`${inputCls} mt-1`}>
            {ASSESSMENT_WINDOWS.map(d => <option key={d} value={d}>{t('windowDays', { days: d })}</option>)}
          </select></label>
        <label className="text-xs">{t('minutes')}
          <input name="minutes" type="number" min="1" max="480" step="1" defaultValue={minutes ?? ''} placeholder={t('notSet')} className={`${inputCls} mt-1`} /></label>
        <label className="text-xs">{t('fteHours')}
          <input name="fteHours" type="number" min="1" max="400" step="1" defaultValue={fteHours ?? ''} placeholder={t('notSet')} className={`${inputCls} mt-1`} /></label>
        <button type="submit" className={btnPrimary}>{t('apply')}</button>
      </form>
      <p className="mt-3 max-w-4xl text-xs text-muted-foreground">{t('estimateHelp')}</p>
    </Card>
    <section className="space-y-4">
      <SectionHeader title={t('ranked')} />
      <p className="max-w-4xl text-sm text-muted-foreground">{t('rankHelp', { from: f.dateTime(view.from, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' }) })}</p>
      {view.processes.map((p, i) => card(p, i + 1))}
    </section>
    <Card className="overflow-hidden">
      <SectionHeader title={o('title')} subtitle={o('subtitle', { from: day(outcomes.from) })} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{o('colAction')}</th>
              {(['colOffered', 'colPrepared', 'colEdited', 'colConfirmed', 'colDiscarded', 'colExpired', 'colRefused', 'colFailed', 'colReversed', 'colWaiting'] as const)
                .map(k => <th key={k} className="px-3 py-2 text-right font-medium">{o(k)}</th>)}
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
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{o('colAction')}</th>
              {(['colReminders', 'colItems', 'colActed', 'colStillWaiting'] as const).map(k => <th key={k} className="px-3 py-2 text-right font-medium">{o(k)}</th>)}
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
    {buildList && await RankedBuildList({view:buildList,page:parseBoundedInt(sp.backlogPage,1,10000)??1})}
    <Card className="p-5">
      <SectionHeader title={t('limitsTitle')} />
      <ul className="mt-2 max-w-4xl list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t('limitEffort')}</li><li>{t('limitOutside')}</li><li>{t('limitStaff')}</li><li>{t('limitNoChange')}</li>
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">{t('version', { version: view.version })} · {o('version', { version: outcomes.version })}</p>
    </Card>
  </div>;
}
