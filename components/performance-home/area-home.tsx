import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/card';
// Button is a client component: rendered with a server Link child (asChild), never called as a function here.
import { Button } from '@/components/ui/button';
import { Status, type StatusTone } from '@/components/monolith';
import { MONO_LABEL } from '@/components/monolith/classes';
import { cn } from '@/lib/utils';
import { PerformanceTabStrip } from '@/components/performance-tabs';
import { RecordInsight } from '@/app/(app)/performance/onehr/record-insight';
import { PERFORMANCE_STRIP_LABEL_KEYS } from '@/packs/performance/onehr/tab-model';
import { performanceHomeLayout, type HomeRow, type PerformanceHomeCardId, type PerformanceHomeView } from '@/packs/performance/onehr/performance-home-model';
import type { HomeStepState } from '@/packs/performance/onehr/home-cards';
import { LeaderCard } from './leader-card';

/**
 * D-P1-32 PT-X3: the Performance & Talent home (/performance/home). RENDERING ONLY: every fact comes from
 * getPerformanceHome (packs/performance/onehr/performance-home-service.ts), and every placement from
 * performanceHomeLayout. The area's Dashboard tab strip sits on top. Labels and state words are the approved
 * label table (performanceArea.home.*); help sentences are our own (performanceArea.homeHelp.*).
 *
 * The page has at most ONE solid button: the first item of Your next step while a cycle runs, the Career Plan
 * between cycles. Every other action is an outline button or a link. Theme-aware by tokens alone, so Classic,
 * Monolith and Atelier (and the area theme) draw the same content in the same order. Columns stack below `lg`.
 */
const RAIL_WORD: Record<HomeStepState, string | null> = {
  done: 'done', released: 'done', yourTurn: 'turn', waiting: 'waiting', locked: 'locked', inProgress: 'progress', notRequired: null,
};
const TONE: Record<HomeStepState, StatusTone> = {
  done: 'ink', released: 'ink', yourTurn: 'signal', waiting: 'signal', inProgress: 'mid', locked: 'mid', notRequired: 'mid',
};
// Token colours only (the area theme supplies their values): done in ink, your turn in the accent, the rest hollow.
const DOT: Record<StatusTone, string> = {
  ink: 'bg-foreground monolith:bg-ink',
  signal: 'bg-primary monolith:bg-signal',
  mid: 'border border-muted-foreground/60 bg-transparent monolith:border-mid',
};
const LEAD_LABEL: Record<Extract<HomeRow, { kind: 'lead' }>['tab'], string> = {
  'calibration.performance': 'tabs.cal.performance', 'calibration.potential': 'tabs.cal.potential', 'calibration.talentBox': 'tabs.cal.talentBox',
};
const CARD = 'min-w-0 p-4 sm:p-5';
const LINK = 'inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline';

export async function PerformanceAreaHome({ view, unit }: { view: PerformanceHomeView; unit?: string }) {
  const t = await getTranslations('performanceArea');
  const tHome = await getTranslations('performanceHome');
  const tTask = await getTranslations('employeeHome.taskNames');
  const tRecord = await getTranslations('onehr');
  const format = await getFormatter();
  const day = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00Z`), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const layout = performanceHomeLayout(view);
  // An async server component, awaited here so the page tree holds only synchronous elements.
  const leader = view.slot?.kind === 'leader' ? await LeaderCard({ status: view.slot.status, unit }) : null;

  const railWord = (state: HomeStepState, count?: number) => {
    const key = RAIL_WORD[state];
    if (!key) return tHome('states.notRequired');
    const word = t(`home.rail.states.${key}`);
    return state === 'waiting' && count ? `${word} · ${count}` : word;
  };

  function railCard() {
    const rail = view.rail!;
    return (
      <Card key="rail" data-home-card="rail" className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="min-w-0 font-semibold">
            {rail.cycleName}
            {rail.closesOn && <span className="ml-2 text-sm font-normal text-muted-foreground">{tHome('closes', { date: day(rail.closesOn) })}</span>}
          </h2>
          <p className={cn('text-sm text-muted-foreground tabular-nums', MONO_LABEL)}>{rail.total ? t('home.rail.progress', { done: rail.done, total: rail.total }) : t('home.rail.nothing')}</p>
        </div>
        {rail.steps.length > 0 && (
          <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <ol aria-label={tHome('stripLabel')} className="flex min-w-max gap-0">
              {rail.steps.map((step) => (
                <li key={step.key} data-step={step.key} data-state={step.state} aria-current={step.state === 'yourTurn' ? 'step' : undefined} className="relative flex w-36 shrink-0 flex-col gap-1 pr-3">
                  <span className="flex items-center gap-2">
                    <i aria-hidden="true" className={cn('inline-block size-2.5 shrink-0 rounded-full', DOT[TONE[step.state]])} />
                    <i aria-hidden="true" className="h-px flex-1 bg-border monolith:bg-hairline" />
                  </span>
                  <span className={cn('text-sm font-medium', step.state === 'locked' || step.state === 'notRequired' ? 'text-muted-foreground' : '')}>{tHome(`steps.${step.key}`)}</span>
                  <Status word={railWord(step.state, step.count)} tone={TONE[step.state]} className="w-fit normal-case" />
                </li>
              ))}
            </ol>
          </div>
        )}
      </Card>
    );
  }

  function pastCard() {
    const past = view.past!;
    const done = past.steps.filter((s) => s.done).length;
    return (
      <Card key="past" data-home-card="past" className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="min-w-0 font-semibold">{t('home.rail.past', { cycle: past.cycleName })}</h2>
          <p className={cn('text-sm text-muted-foreground tabular-nums', MONO_LABEL)}>
            {t(done === past.steps.length ? 'home.rail.pastState.complete' : 'home.rail.pastState.closed', { done, total: past.steps.length })}
          </p>
        </div>
        <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <ol aria-label={tHome('stripLabel')} className="flex min-w-max gap-0">
            {past.steps.map((step) => (
              <li key={step.key} data-step={step.key} data-state={step.done ? 'done' : 'closed'} className="relative flex w-36 shrink-0 flex-col gap-1 pr-3">
                <span className="flex items-center gap-2">
                  <i aria-hidden="true" className={cn('inline-block size-2.5 shrink-0 rounded-full', DOT[step.done ? 'ink' : 'mid'])} />
                  <i aria-hidden="true" className="h-px flex-1 bg-border monolith:bg-hairline" />
                </span>
                <span className="text-sm font-medium">{tHome(`steps.${step.key}`)}</span>
                <Status word={t(step.done ? 'home.rail.states.done' : 'home.rail.states.closed')} tone={step.done ? 'ink' : 'mid'} className="w-fit normal-case" />
              </li>
            ))}
          </ol>
        </div>
      </Card>
    );
  }

  const rowText = (row: HomeRow) => {
    if (row.kind === 'team') return { title: tHome('team.title'), sub: tHome('team.waiting', { count: row.total }), open: tHome('team.open') };
    if (row.kind === 'lead') return { title: row.title, sub: t(LEAD_LABEL[row.tab]), open: tHome('next.open') };
    return { title: tHome('next.feedback360Title', { count: row.count }), sub: tHome('next.feedback360Line'), open: tHome('next.open') };
  };
  const chips = (row: HomeRow) => (row.kind === 'team' && row.chips.length > 0 ? (
    <ul className="flex flex-wrap gap-2">
      {row.chips.map((chip) => <li key={chip.kind} data-chip={chip.kind}><Status word={`${tTask(chip.kind)} ${chip.count}`} tone="mid" className="normal-case" /></li>)}
    </ul>
  ) : null);

  function nextCard() {
    const next = view.next!;
    const primary = next.primary;
    let title: string, line: string | null = null, href: string | null = null, open = tHome('next.open'), extra: ReactNode = null;
    if (primary?.kind === 'own') {
      const n = primary.next;
      title = n.kind === 'feedback360' ? tHome('next.feedback360Title', { count: n.colleagues }) : tHome(`next.${n.kind}Title`);
      const sub = n.kind === 'feedback360' ? tHome('next.feedback360Line') : n.total > 0 ? tHome(`next.${n.kind}Line`, { done: n.done, total: n.total }) : null;
      line = [sub, n.dueOn ? tHome('next.due', { date: day(n.dueOn) }) : null].filter(Boolean).join(' · ') || null;
      href = n.href;
    } else if (primary?.kind === 'row') {
      const text = rowText(primary.row);
      title = text.title; line = text.sub; href = primary.row.href; open = text.open; extra = chips(primary.row);
    } else {
      title = t('home.next.none');
      line = next.nextDate ? tHome(next.nextDate.kind === 'opens' ? 'next.opens' : 'next.closesOn', { date: day(next.nextDate.on) }) : t('homeHelp.next.nothingLine');
    }
    return (
      <Card key="next" data-home-card="next" className={cn(CARD, 'space-y-4')}>
        <div className="space-y-1">
          <p className={cn('text-xs text-muted-foreground', MONO_LABEL)}>{primary ? t('home.next.title') : t('home.next.here')}</p>
          <h2 className="text-lg font-semibold">{title}</h2>
          {line && <p className="text-sm text-muted-foreground">{line}</p>}
          {extra}
        </div>
        {href && <Button asChild className="min-h-11" data-solid><Link href={href}>{open}</Link></Button>}
        {next.rows.length > 0 && (
          <ul className="divide-y divide-border border-t border-border monolith:divide-hairline monolith:border-hairline">
            {next.rows.map((row) => {
              const text = rowText(row);
              return (
                <li key={row.kind === 'lead' ? row.key : row.kind} data-row={row.kind} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-semibold">{text.title}</p>
                    <p className="text-sm text-muted-foreground">{text.sub}</p>
                    {chips(row)}
                  </div>
                  <Button asChild variant="outline" className="min-h-11"><Link href={row.href}>{text.open}</Link></Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    );
  }

  function notInCard() {
    const slot = view.slot;
    if (slot?.kind !== 'notIn') return null;
    return (
      <Card key="notIn" data-home-card="notIn" className={cn(CARD, 'space-y-3')}>
        <h2 className="text-lg font-semibold">{t('home.notIn.title')}</h2>
        <p className="text-sm">
          {t('homeHelp.notIn.why', { cycle: slot.cycleName, reason: t(`homeHelp.notIn.reasons.${slot.reason}`) })}{' '}
          {slot.leads ? t('homeHelp.notIn.leads') : t('homeHelp.notIn.nothingOwn')}
        </p>
        {slot.team && (
          <div className="space-y-2">
            <p className={cn('text-xs text-muted-foreground', MONO_LABEL)}>{t('home.notIn.team')} · {t('homeHelp.people', { count: slot.team.people })}</p>
            <dl className="grid grid-cols-3 gap-2">
              {([['turn', 'waitingOnYou'], ['wait', 'stillWriting'], ['done', 'done']] as const).map(([key, word]) => (
                <div key={key} data-count={key} className="flex flex-col-reverse rounded-md border border-border p-3 monolith:border-hairline">
                  <dt className="text-xs text-muted-foreground">{t(`home.notIn.counts.${word}`)}</dt>
                  <dd className="text-xl font-semibold tabular-nums">{slot.team![key]}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('homeHelp.notIn.foot')}</p>
      </Card>
    );
  }

  function standCard() {
    const slot = view.slot;
    if (slot?.kind !== 'stand') return null;
    const s = slot.standing;
    const rows: { key: string; label: string; value: string; strong: boolean; note?: string }[] = [];
    const perf = s.performance;
    if (perf) {
      rows.push('band' in perf
        ? { key: 'performance', label: t('home.stand.rows.performance'), value: perf.band, strong: perf.state === 'released', note: perf.state === 'lineManagerApproved' ? t('homeHelp.stand.lineManagerApproved') : undefined }
        : { key: 'performance', label: t('home.stand.rows.performance'), value: t(`home.stand.values.${perf.state}`), strong: false });
    }
    if (s.competency) {
      const value = s.competency === 'reviewed'
        ? (s.competencyDemonstrated ? t('home.stand.values.demonstrated', { done: s.competencyDemonstrated.done, total: s.competencyDemonstrated.total }) : tHome('standing.reviewed'))
        : t(`home.stand.values.${s.competency}`);
      rows.push({ key: 'competency', label: t('home.stand.rows.competency'), value, strong: s.competency === 'reviewed' });
    }
    rows.push({ key: 'feedback360', label: t('home.stand.rows.f360'), value: t(s.feedback360 === 'released' ? 'home.stand.values.reportReleased' : 'home.stand.values.notReleased'), strong: s.feedback360 === 'released' });
    rows.push({ key: 'careerTarget', label: t('home.stand.rows.careerTarget'), value: s.careerTarget.state === 'set' ? s.careerTarget.title : t('home.stand.values.notSet'), strong: s.careerTarget.state === 'set' });
    return (
      <Card key="stand" data-home-card="stand" className={CARD}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">{t('home.stand.title')}</h2>
          <Link href={slot.detailsHref} className={LINK}>{t('home.stand.details')}</Link>
        </div>
        <dl className="mt-2 divide-y divide-border monolith:divide-hairline">
          {rows.map((row) => (
            <div key={row.key} data-standing={row.key} title={row.note} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className={cn('text-right', row.strong ? 'font-semibold' : 'text-muted-foreground')}>
                {row.value}
                {row.note && <span className="block text-xs font-normal text-muted-foreground">{row.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    );
  }

  function resultsCard() {
    const r = view.results;
    if (!r) {
      return (
        <Card key="results" data-home-card="results" className={cn(CARD, 'space-y-2')}>
          <h2 className="text-lg font-semibold">{t('home.results.empty')}</h2>
          <p className="text-sm text-muted-foreground">{t('homeHelp.results.emptyLine')}</p>
        </Card>
      );
    }
    const tiles = [['performance', r.performance], ['potential', r.potential], ['talent', r.talent]] as const;
    return (
      <Card key="results" data-home-card="results" className={cn(CARD, 'space-y-4')}>
        <h2 className="text-lg font-semibold">{t('home.results.title', { cycle: r.name })}</h2>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {tiles.map(([key, value]) => (
            <div key={key} data-result={key} className="rounded-md border border-border p-3 monolith:border-hairline">
              <dt className="text-xs text-muted-foreground">{t(`home.results.tiles.${key}`)}</dt>
              <dd className={cn('text-lg', value ? 'font-semibold' : 'text-muted-foreground')}>{value ?? t('home.stand.values.notReleased')}</dd>
            </div>
          ))}
        </dl>
        <section data-home-ai-read aria-label={t('home.results.aiRead')} className="space-y-2">
          <p className={cn('text-xs text-muted-foreground', MONO_LABEL)}>{t('home.results.aiRead')}</p>
          <RecordInsight reviewId={r.id} kind="cycle" />
        </section>
        <div className="flex flex-wrap gap-x-6">
          <Link href={r.recordHref} className={LINK}>{t('home.results.record')}</Link>
          {r.reportHref && <Link href={r.reportHref} className={LINK}>{t('home.results.report')}</Link>}
        </div>
      </Card>
    );
  }

  function ledCard() {
    const led = view.led;
    if (!led) return null;
    const tallies = 'performance' in led
      ? ([['performance', led.performance], ['potential', led.potential], ['talent', led.talent]] as const).filter(([, tally]) => tally.released + tally.waiting > 0)
      : [];
    return (
      <Card key="led" data-home-card="led" className={cn(CARD, 'space-y-3')}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">{t('home.led.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('homeHelp.led.people', { count: led.people })}</p>
        </div>
        {tallies.length > 0 && (
          <dl className="divide-y divide-border monolith:divide-hairline">
            {tallies.map(([key, tally]) => (
              <div key={key} data-tally={key} className="space-y-1 py-2.5 text-sm">
                <dt className="flex flex-wrap justify-between gap-2"><span className="font-medium">{t(`home.results.tiles.${key}`)}</span><span className="text-muted-foreground">{t('homeHelp.led.line', { released: tally.released, waiting: tally.waiting })}</span></dt>
                {tally.bands && tally.bands.length > 0 && (
                  <dd><ul className="flex flex-wrap gap-2">{tally.bands.map((b) => <li key={b.band}><Status word={`${b.band} ${b.n}`} tone="mid" className="normal-case" /></li>)}</ul></dd>
                )}
              </div>
            ))}
          </dl>
        )}
        <Link href={`/performance/led?${new URLSearchParams({ cycle: led.cycleId })}`} className={LINK}>{t('home.led.people')}</Link>
      </Card>
    );
  }

  function planCard() {
    const p = view.plan;
    if (!p) return null;
    return (
      <Card key="plan" data-home-card="plan" className={cn(CARD, 'space-y-3')}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">{t('home.plan.title', { year: p.year })}</h2>
          <p className="text-sm text-muted-foreground">{tRecord(`personalRecord.status.${p.status}`)} · {t('homeHelp.plan.goals', { count: p.goals.length })}</p>
        </div>
        {p.goals.length > 0 && (
          <ul className="divide-y divide-border monolith:divide-hairline">
            {p.goals.map((g) => (
              <li key={g.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate font-medium" title={g.area}>{g.area}</span>
                <span className="shrink-0 text-muted-foreground">{tRecord(`progress.${g.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
        <Button asChild className="min-h-11" data-solid><Link href={p.href}>{t('home.plan.open')}</Link></Button>
      </Card>
    );
  }

  function historyCard() {
    const h = view.history;
    return (
      <Card key="history" data-home-card="history" className={CARD}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">{t('home.history.titleMine')}</h2>
          {h.fullHref && <Link href={h.fullHref} className={LINK}>{t('home.history.full')}</Link>}
        </div>
        {h.rows.length ? (
          <ul className="mt-2 divide-y divide-border monolith:divide-hairline">
            {h.rows.map((r) => (
              <li key={r.id} data-history={r.id} className="flex flex-wrap items-baseline justify-between gap-3 py-2.5 text-sm">
                <span className="font-medium">{r.name}</span>
                <span className={r.performance ? 'font-semibold' : 'text-muted-foreground'}>
                  {[r.performance ?? t('home.stand.values.notReleased'), r.talent].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-muted-foreground">{t('homeHelp.history.emptyLine')}</p>}
      </Card>
    );
  }

  function toolsCard() {
    return (
      <Card key="tools" data-home-card="tools" className={cn(CARD, 'space-y-3')}>
        <h2 className="font-semibold">{t('home.tools.title')}</h2>
        {view.tools.length || view.checkIns ? <>{view.tools.map((group) => (
          <div key={group.strip} data-tools={group.strip} className="space-y-1">
            <p className={cn('text-xs text-muted-foreground', MONO_LABEL)}>{t(PERFORMANCE_STRIP_LABEL_KEYS[group.strip])}</p>
            <ul className="divide-y divide-border monolith:divide-hairline">
              {group.tabs.map((tab) => (
                <li key={tab.id}>
                  <Link href={tab.href} data-door={tab.id} className="flex min-h-11 items-center justify-between gap-3 text-sm hover:text-primary">
                    <span>{t(tab.labelKey)}</span><span aria-hidden="true">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {view.checkIns && (
          // DQ-11: manager check-ins and "awaiting you" stay on /performance.
          <ul data-tools="checkIns" className="divide-y divide-border monolith:divide-hairline">
            <li>
              <Link href={view.checkIns} data-door="checkIns" className="flex min-h-11 items-center justify-between gap-3 text-sm hover:text-primary">
                <span>{t('home.tools.checkIns')}</span><span aria-hidden="true">›</span>
              </Link>
            </li>
          </ul>
        )}</> : <p className="text-sm text-muted-foreground">{t('homeHelp.tools.emptyLine')}</p>}
      </Card>
    );
  }

  const draw = (id: PerformanceHomeCardId): ReactNode => {
    switch (id) {
      case 'rail': return view.rail ? railCard() : null;
      case 'past': return view.past ? pastCard() : null;
      case 'next': return view.next ? nextCard() : null;
      case 'leader': return leader ? <Fragment key={id}>{leader}</Fragment> : null;
      case 'notIn': return notInCard();
      case 'stand': return standCard();
      case 'results': return resultsCard();
      case 'led': return ledCard();
      case 'plan': return planCard();
      case 'history': return historyCard();
      case 'tools': return toolsCard();
    }
  };

  return (
    <div data-performance-area-home data-mode={view.mode} className="min-w-0 space-y-4">
      <h1 className="sr-only">{t('home.title')}</h1>
      <PerformanceTabStrip strip="home" facts={view.facts} />
      {layout.top.map(draw)}
      <div data-home-columns className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div data-home-column="main" className="min-w-0 space-y-4">{layout.main.map(draw)}</div>
        <div data-home-column="side" className="min-w-0 space-y-4">{layout.side.map(draw)}</div>
      </div>
      {layout.bottom.map(draw)}
    </div>
  );
}
