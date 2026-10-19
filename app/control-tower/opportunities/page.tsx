import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { ASSESSMENT_WINDOWS, MIN_COMPLETED, AGED_OPEN_DAYS, assessProcesses, estimateLoad, parseBoundedInt, parseWindow,
  type AgentRole, type ProcessAssessment } from '@/core/process-assessment';
import { Card, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';

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

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ days?: string; minutes?: string; fteHours?: string }> }) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const t = await getTranslations('processAssessment');
  const f = await getFormatter();
  const window = parseWindow(sp.days);
  const minutes = parseBoundedInt(sp.minutes, 1, 480);
  const fteHours = parseBoundedInt(sp.fteHours, 1, 400);
  const view = await assessProcesses(s, window);
  const n = (v: number) => f.number(v, { maximumFractionDigits: 1 });
  const duration = (hours: number | null) => hours == null ? '—'
    : hours * 60 < 1 ? t('underMinute')
    : hours < 1 ? t('minutesShort', { n: Math.round(hours * 60) })
    : hours < 48 ? t('hours', { n: n(hours) }) : t('days', { n: n(hours / 24) });

  const metric = (label: string, value: string, hint?: string) => <div className="min-w-0">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
  </div>;

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
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {metric(t('started'), n(m.started), m.closedUndecided ? t('completedClosed', { n: n(m.completed), w: n(m.closedUndecided) }) : t('completedOf', { n: n(m.completed) }))}
          {metric(t('open'), n(m.open), m.agedOpen ? t('agedOpen', { n: n(m.agedOpen), days: AGED_OPEN_DAYS }) : undefined)}
          {metric(t('median'), duration(m.medianHours), t('p90', { value: duration(m.p90Hours) }))}
          {metric(t('rework'), m.started ? f.number(m.rework / m.started, { style: 'percent' }) : '—', t('reworkHint'))}
          {p.profile.actionsLinked
            ? metric(t('staffActions'), n(p.staffActionsPer30 ?? 0), acts ? t('automatedShare', { share: f.number(m.automatedActions / acts, { style: 'percent' }) }) : undefined)
            : metric(t('staffActions'), '—', t('notLinked'))}
        </dl>
        {load && <p className="mt-3 text-sm">{load.fte == null ? t('estimateHours', { hours: n(load.hours) }) : t('estimateFte', { hours: n(load.hours), fte: f.number(load.fte, { maximumFractionDigits: 2 }) })} <span className="text-xs text-muted-foreground">{t('estimateLabel')}</span></p>}
        {p.role === 'measure_first' && <p className="mt-3 text-sm text-muted-foreground">{t('needMore', { min: MIN_COMPLETED })}</p>}
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
    <Card className="p-5">
      <SectionHeader title={t('limitsTitle')} />
      <ul className="mt-2 max-w-4xl list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t('limitEffort')}</li><li>{t('limitOutside')}</li><li>{t('limitStaff')}</li><li>{t('limitNoChange')}</li>
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">{t('version', { version: view.version })}</p>
    </Card>
  </div>;
}
