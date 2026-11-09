import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { Card } from '@/components/ui';
import {
  analyticsBreakdownGroups, analyticsGradeBands, analyticsMonthBands, analyticsPerformance, analyticsPositions,
  analyticsRatio, analyticsSlice, analyticsTalent, averageIncreaseAndCr, bonusMetrics, payPositionMetrics,
  salaryMetrics, type AnalyticsBreakdown, type AnalyticsPosition, type AnalyticsRow, type AnalyticsSlice,
} from '@/packs/rewards/analytics-model';
import type { RewardsAnalyticsReport } from './report';

export type Labels = (key: string, values?: Record<string, string | number>) => string;
type FigureProps = {
  report: RewardsAnalyticsReport; t: Labels;
  money: (cents: number | null, annualize?: boolean) => string;
  pct: (value: number | null) => string;
  decimal: (value: number | null) => string;
  drill: (slices: readonly AnalyticsSlice[]) => string;
};

const tableCls = 'w-full min-w-[48rem] text-left text-sm [&_th]:px-3 [&_th]:py-2 [&_td]:px-3 [&_td]:py-2';
const headerCls = 'border-b bg-muted/50 text-xs font-semibold text-muted-foreground';
const outcomeCls = 'border-t bg-muted/30 font-semibold';
const linkCls = 'rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2';
const dots: Record<AnalyticsPosition, string> = {
  below: 'bg-orange-500', within: 'bg-blue-600', above: 'bg-emerald-600', noRange: 'bg-muted-foreground/30',
};

function FigureCard({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return <Card className="space-y-3 rounded-xl p-4 sm:p-5">
    <h2 className="text-base font-semibold tracking-tight">{title}</h2>
    {caption && <p className="text-sm text-muted-foreground">{caption}</p>}
    {children}
  </Card>;
}

function FigureLink({ href, title, children, className = '' }: { href: string; title: string; children: ReactNode; className?: string }) {
  return <Link href={href} title={title} scroll prefetch={false} className={`${linkCls} ${className}`}>{children}</Link>;
}

function SummaryCards({ cards }: { cards: { label: string; value: ReactNode; detail: string }[] }) {
  return <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
    {cards.map(card => <Card key={card.label} className="space-y-1 rounded-xl p-3 sm:p-4">
      <dt className="text-xs font-medium text-muted-foreground sm:text-sm">{card.label}</dt>
      <dd className="text-base font-bold tabular-nums sm:text-xl">{card.value}</dd>
      <dd className="text-xs leading-relaxed text-muted-foreground">{card.detail}</dd>
    </Card>)}
  </dl>;
}

function PositionLegend({ t }: { t: Labels }) {
  return <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    {([...analyticsPositions, 'noRange'] as const).map(position => <li key={position} className="flex items-center gap-1.5">
      <span className={`size-2.5 rounded-sm ${dots[position]}`} aria-hidden="true" />{t(position)}
    </li>)}
  </ul>;
}

function PositionBar({ counts, stage, clauses, t, pct, drill, small = false }: Pick<FigureProps, 't' | 'pct' | 'drill'> & {
  counts: Record<AnalyticsPosition, number>; stage: 'before' | 'after'; clauses: AnalyticsSlice[]; small?: boolean;
}) {
  const count = analyticsPositions.reduce((sum, position) => sum + counts[position], 0);
  const range = [...analyticsPositions, 'noRange'] as const;
  return <div className="space-y-1.5">
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
      <span className="font-medium">{t(stage)}</span>
      {!small && <span className="tabular-nums text-muted-foreground">{range.map(position => `${t(position)} ${counts[position]}`).join(' · ')}</span>}
    </div>
    {count > 0 ? <div className={`flex overflow-hidden rounded-md bg-muted ${small ? 'h-4' : 'h-7'}`}>
      {analyticsPositions.filter(position => counts[position] > 0).map(position => {
        const share = counts[position] / count;
        const label = `${t(stage)} · ${t(position)} · ${counts[position]} · ${pct(share)}`;
        return <Link key={position} href={drill([...clauses, [stage, position]])} prefetch={false} title={label}
          aria-label={label} style={{ width: `${share * 100}%` }}
          className={`flex min-w-0 items-center justify-center overflow-hidden text-[10px] font-semibold text-white focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-white ${dots[position]}`}>
          {share >= (small ? .12 : .04) && (small ? counts[position] : pct(share))}
        </Link>;
      })}
    </div> : <p className="text-xs text-muted-foreground">{t('noRange')}</p>}
    {counts.noRange > 0 && <FigureLink href={drill([...clauses, [stage, 'noRange']])} title={t('noRange')} className="text-xs">
      {t('noRange')}{' · '}{counts.noRange}
    </FigureLink>}
  </div>;
}

function gradeRows(rows: readonly AnalyticsRow[]) {
  const grades = [...new Set(rows.map(row => row.grade))];
  return grades.sort((left, right) => (Number(right) || -1) - (Number(left) || -1) || left.localeCompare(right));
}

function SalaryPositionTable(props: FigureProps & { dimension: 'grade' | 'talent' }) {
  const { report, dimension, t, pct, decimal, drill } = props;
  const rows = report.rows.filter(row => row.incrementRun);
  const keys: readonly (string | null)[] = [...(dimension === 'grade' ? gradeRows(rows) : analyticsTalent), null];
  const changes = payPositionMetrics(rows);
  return <FigureCard title={t(dimension === 'grade' ? 'positionByGrade' : 'positionByTalent')} caption={t('salaryHeatHelp')}>
    <PositionLegend t={t} />
    <p className="text-xs text-muted-foreground">{t('increaseLegend')}</p>
    <p className="text-xs font-medium">{t('rangeMovement', { up: changes.upIntoRange, below: changes.stillBelow, above: changes.pushedAbove })}</p>
    <div className="overflow-x-auto"><table className={tableCls}>
      <thead className={headerCls}><tr>
        <th scope="col">{t(dimension)}</th><th scope="col">{t('inRun')}</th><th scope="col" className="min-w-36">{t('rangePosition')}</th>
        {analyticsPositions.map(position => <th key={position} scope="col">{t(position)}</th>)}
        <th scope="col">{t('promotion')}</th><th scope="col">{t('nonPromotion')}</th><th scope="col">{t('averageIncrease')}</th>
      </tr></thead>
      <tbody>{keys.map(key => {
        const group = analyticsSlice(rows, dimension, key);
        const clauses: AnalyticsSlice[] = [['run', 'salary'], ...(key === null ? [] : [[dimension, key] as const])];
        const positions = payPositionMetrics(group);
        const promoted = averageIncreaseAndCr(group.filter(row => row.promoted));
        const nonPromoted = averageIncreaseAndCr(group.filter(row => !row.promoted));
        const combined = averageIncreaseAndCr(group);
        const label = key === null ? t('overall') : dimension === 'grade' && key ? `JG ${key}` : key || t('unavailable');
        return <tr key={key ?? 'overall'} className={key === null ? outcomeCls : 'border-b'}>
          <th scope="row"><FigureLink href={drill(clauses)} title={label}>{label}</FigureLink></th>
          <td className="tabular-nums">{group.length}</td>
          <td className="space-y-1">
            <PositionBar counts={positions.before} stage="before" clauses={clauses} t={t} pct={pct} drill={drill} small />
            <PositionBar counts={positions.after} stage="after" clauses={clauses} t={t} pct={pct} drill={drill} small />
          </td>
          {analyticsPositions.map(position => {
            const metric = averageIncreaseAndCr(analyticsSlice(group, 'before', position));
            if (metric.increase === null) return <td key={position}>—</td>;
            const marked = metric.increase >= .2;
            const text = `${pct(metric.increase)} · CR ${decimal(metric.afterCr)} · ${metric.count}`;
            return <td key={position}><FigureLink href={drill([...clauses, ['before', position]])} title={text}
              className={`block rounded-md px-2 py-1 text-center font-semibold tabular-nums ${marked ? 'ring-1 ring-inset ring-amber-600' : ''}`}>
              <span className="block rounded" style={heat(metric.increase, .3)}>{marked && '▲ '}{pct(metric.increase)}</span>
              <span className="whitespace-nowrap text-[10px] font-normal text-muted-foreground">CR {decimal(metric.afterCr)} · {metric.count}</span>
            </FigureLink></td>;
          })}
          <td className="whitespace-nowrap tabular-nums">{pct(promoted.increase)}{promoted.count > 0 && ` (${promoted.count})`}</td>
          <td className="tabular-nums">{pct(nonPromoted.increase)}</td>
          <td className="min-w-24 tabular-nums"><FigureLink href={drill(clauses)} title={pct(combined.increase)}>{pct(combined.increase)}</FigureLink>
            <div className="h-1.5 rounded bg-muted" aria-hidden="true"><div className="h-full rounded bg-blue-600" style={{ width: `${Math.min(100, Math.max(0, (combined.increase ?? 0) / .3 * 100))}%` }} /></div>
          </td>
        </tr>;
      })}</tbody>
    </table></div>
  </FigureCard>;
}

function heat(value: number, max: number): CSSProperties {
  const strength = Math.min(.55, .08 + Math.max(value, 0) / max * .47);
  return { backgroundColor: `rgb(59 130 246 / ${strength})` };
}

export function SalaryFigures(props: FigureProps) {
  const { report, t, money, pct, decimal, drill } = props;
  const visible = salaryMetrics(report.rows);
  const total = report.totals;
  const increase = total.afterCents - total.beforeCents;
  const position = payPositionMetrics(report.rows);
  return <>
    <SummaryCards cards={[
      { label: t(report.filters.basis === 'annual' ? 'annualBefore' : 'monthlyBefore'), value: money(total.beforeCents, true), detail: t('peopleScope', { count: total.people }) },
      { label: t(report.filters.basis === 'annual' ? 'annualAfter' : 'monthlyAfter'), value: money(total.afterCents, true), detail: t('afterHelp') },
      { label: t('increase'), value: money(increase, true), detail: t('increaseShare', { rate: pct(analyticsRatio(increase, total.beforeCents)) }) },
      { label: t('peopleIncreased'), value: `${total.increased} / ${total.people}`, detail: t('increaseDistribution', { median: pct(visible.medianIncrease), average: pct(visible.averageIncrease) }) },
    ]} />
    <FigureCard title={t('rangeOverview')} caption={t('rangeHelp')}>
      <PositionLegend t={t} />
      <PositionBar counts={position.before} stage="before" clauses={[]} t={t} pct={pct} drill={drill} />
      <PositionBar counts={position.after} stage="after" clauses={[]} t={t} pct={pct} drill={drill} />
      <p className="text-xs text-muted-foreground">{t('rangeChange', { beforeBelow: position.before.below, afterBelow: position.after.below, beforeAbove: position.before.above, afterAbove: position.after.above })}</p>
    </FigureCard>
    <SalaryPositionTable {...props} decimal={decimal} dimension="grade" />
    <SalaryPositionTable {...props} decimal={decimal} dimension="talent" />
  </>;
}

function BonusGradeTable({ report, t, pct, decimal, drill }: FigureProps) {
  const rows = report.rows;
  const keys = [...gradeRows(rows), null];
  return <FigureCard title={t('bonusGradeHeat')} caption={t('bonusGradeHelp')}>
    <p className="text-xs text-muted-foreground">{t('bonusLegend')}</p>
    <div className="overflow-x-auto"><table className={tableCls}>
      <thead className={headerCls}><tr>
        <th scope="col">{t('grade')}</th><th scope="col">{t('inRun')}</th>
        {analyticsPerformance.map(key => <th key={key} scope="col">{key}</th>)}
        <th scope="col">{t('averageMonths')}</th><th scope="col">{t('exceptions')}</th>
        <th scope="col">{t('blockers')}</th><th scope="col">{t('payMix')}</th>
      </tr></thead>
      <tbody>{keys.map(key => {
        const group = analyticsSlice(rows, 'grade', key);
        const metrics = bonusMetrics(group);
        const clauses: AnalyticsSlice[] = [['run', 'bonus'], ...(key === null ? [] : [['grade', key] as const])];
        const label = key === null ? t('overall') : key ? `JG ${key}` : t('unavailable');
        return <tr key={key ?? 'overall'} className={key === null ? outcomeCls : 'border-b'}>
          <th scope="row"><FigureLink href={drill(clauses)} title={label}>{label}</FigureLink></th>
          <td className="tabular-nums">{metrics.eligible}</td>
          {analyticsPerformance.map(rating => {
            const value = bonusMetrics(analyticsSlice(group, 'performance', rating));
            if (value.averageMonths === null) return <td key={rating}>—</td>;
            const label = t('monthsPeople', { months: decimal(value.averageMonths), count: value.eligible });
            return <td key={rating}><FigureLink href={drill([...clauses, ['performance', rating]])} title={label}
              className="block rounded-md px-2 py-1 text-center font-semibold tabular-nums">
              <span className="block rounded" style={heat(value.averageMonths, 5)}>{decimal(value.averageMonths)}</span>
              <span className="whitespace-nowrap text-[10px] font-normal text-muted-foreground">{t('staff', { count: value.eligible })}</span>
            </FigureLink></td>;
          })}
          <td className="tabular-nums">{decimal(metrics.averageMonths)}</td><td className="tabular-nums">{metrics.exceptions}</td>
          <td className="tabular-nums">{metrics.blockers > 0 ? <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-semibold text-red-700 dark:text-red-300">{metrics.blockers}</span> : 0}</td>
          <td className="min-w-24 whitespace-nowrap tabular-nums">
            {metrics.payMix === null ? '—' : <>
              {pct(1 - metrics.payMix)} / {pct(metrics.payMix)}
              <div className="flex h-1.5 overflow-hidden rounded bg-muted" aria-hidden="true">
                <div className="bg-blue-600" style={{ width: `${(1 - metrics.payMix) * 100}%` }} />
                <div className="bg-emerald-600" style={{ width: `${metrics.payMix * 100}%` }} />
              </div>
            </>}
          </td>
        </tr>;
      })}</tbody>
    </table></div>
  </FigureCard>;
}

type Bar = { label: string; display: string; value: number | null; clauses: AnalyticsSlice[]; over?: boolean };

function HorizontalBars({ title, caption, bars, drill }: {
  title: string; caption?: string; bars: Bar[]; drill: FigureProps['drill'];
}) {
  const max = Math.max(0, ...bars.map(bar => bar.value ?? 0));
  return <FigureCard title={title} caption={caption}><ul className="space-y-2">
    {bars.map(bar => <li key={bar.label}>
      <FigureLink href={drill(bar.clauses)} title={`${bar.label} · ${bar.display}`} className="grid grid-cols-[minmax(4rem,1fr)_minmax(4rem,2fr)_auto] items-center gap-2 text-xs">
        <span className="font-medium">{bar.label}</span>
        <span className="h-2.5 overflow-hidden rounded bg-muted" aria-hidden="true">
          <span className={`block h-full rounded ${bar.over ? 'bg-red-600' : 'bg-blue-600'}`}
            style={{ width: `${max ? (bar.value ?? 0) / max * 100 : 0}%` }} />
        </span>
        <span className="whitespace-nowrap tabular-nums text-muted-foreground">{bar.display}</span>
      </FigureLink>
    </li>)}
  </ul></FigureCard>;
}

export function BonusFigures(props: FigureProps) {
  const { report, t, money, pct, decimal, drill } = props;
  const total = report.totals;
  const visible = bonusMetrics(report.rows);
  const visiblePooledPayout = bonusMetrics(report.rows.filter(row => row.pooled)).payout;
  const pool = report.selected.every(unit => unit.poolCents !== null)
    ? report.selected.reduce((sum, unit) => sum + (unit.poolCents ?? 0), 0) : null;
  const payout = total.bonusCents + total.lumpCents;
  const monthBars = analyticsMonthBands.map(band => ({
    band, count: analyticsSlice(report.rows, 'bonusMonths', band).length,
  }));
  const tallest = Math.max(1, ...monthBars.map(bar => bar.count));
  const averages = (dimension: 'performance' | 'gradeBand', keys: readonly string[]): Bar[] => keys.map(key => {
    const metrics = bonusMetrics(analyticsSlice(report.rows, dimension, key));
    return { label: key, display: t('monthsPeople', { months: decimal(metrics.averageMonths), count: metrics.eligible }),
      value: metrics.averageMonths, clauses: [['run', 'bonus'], [dimension, key]] };
  });
  const poolBars = report.selected.map((unit): Bar => {
    const unitPayout = bonusMetrics(analyticsSlice(report.rows, 'unit', unit.id).filter(row => row.pooled)).payout;
    const utilisation = unit.poolCents === null ? null : analyticsRatio(unitPayout, unit.poolCents);
    return { label: `${unit.company} · ${unit.unit}`, display: `${pct(utilisation)} · ${money(unit.poolCents)}`,
      value: utilisation, clauses: [['unit', unit.id]], over: utilisation !== null && utilisation > 1 };
  });
  return <>
    <SummaryCards cards={[
      { label: t('bonusPayout'), value: money(payout), detail: t('payoutShare', { share: pct(pool === null ? null : analyticsRatio(visiblePooledPayout, pool)), pool: money(pool) }) },
      { label: t('peoplePaid'), value: `${total.paid} / ${total.eligible}`, detail: t('notEligible', { count: total.people - total.eligible }) },
      { label: t('bonusMonths'), value: t('medianMonthsValue', { value: decimal(visible.medianMonths) }), detail: t('monthDistribution', { average: decimal(visible.averageMonths), highest: decimal(visible.highestMonths) }) },
      { label: t('bonusAnnualShare'), value: pct(analyticsRatio(total.eligibleBonusCents, total.eligibleAnnualBasicCents)), detail: t('bonusAnnualHelp') },
    ]} />
    <BonusGradeTable {...props} />
    <div className="grid gap-3 xl:grid-cols-2">
      <HorizontalBars title={t('bonusByPerformance')} bars={averages('performance', analyticsPerformance)} drill={drill} />
      <FigureCard title={t('bonusSpread')} caption={t('bonusSpreadHelp')}>
        <ul className="flex min-h-32 items-end justify-between gap-1.5 sm:gap-3">
          {monthBars.map(bar => <li key={bar.band} className="flex min-w-0 flex-1 flex-col items-center">
            <FigureLink href={drill([['bonusMonths', bar.band]])} title={`${bar.band} · ${t('staff', { count: bar.count })}`} className="flex w-full flex-col items-center justify-end gap-1 text-xs tabular-nums">
              {bar.count}<span className="block w-full max-w-12 rounded-t bg-blue-600" style={{ height: `${bar.count / tallest * 100}px` }} aria-hidden="true" />
              <span className="whitespace-nowrap text-muted-foreground">{bar.band}</span>
            </FigureLink>
          </li>)}
        </ul>
      </FigureCard>
      <HorizontalBars title={t('poolByUnit')} caption={t('poolHelp')} bars={poolBars} drill={drill} />
      <HorizontalBars title={t('bonusByGradeBand')} bars={averages('gradeBand', analyticsGradeBands.filter(key => key !== '23'))} drill={drill} />
    </div>
  </>;
}

export function BreakdownFigures(props: FigureProps & { breakdownLinks: ReactNode }) {
  const { report, t, money, pct, decimal, drill, breakdownLinks } = props;
  const dimension: AnalyticsBreakdown = report.filters.breakdown;
  const groups = analyticsBreakdownGroups(report.rows, report.selected, dimension);
  const bonusView = report.filters.view === 'bonus';
  const showPat = report.selected.some(unit => unit.canSeePat);
  const heading = bonusView
    ? ['eligible', 'paid', 'bonusPayout', ...(showPat ? ['patAchievement'] : []), 'pool', 'utilised', 'averageMonths', 'medianMonths', 'highest']
    : ['people', 'payrollBefore', 'payrollAfter', 'increase', 'increasePercent', 'merit', 'promotion', 'special', 'medianCr'];
  const summedPool = report.selected.every(unit => unit.poolCents !== null)
    ? report.selected.reduce((sum, unit) => sum + (unit.poolCents ?? 0), 0) : null;
  const all = [...groups, { key: null, label: t('total'), rows: report.rows, unit: undefined }];
  return <FigureCard title={t('breakdown')} caption={bonusView ? t('bonusFootnote') : t('salaryFootnote', { basis: t(report.filters.basis) })}>
    {breakdownLinks}
    <div className="overflow-x-auto"><table className={tableCls}>
      <thead className={headerCls}><tr>
        <th scope="col">{t(dimension)}</th>
        {heading.map(key => <th scope="col" key={key} className="text-right">{t(key)}</th>)}
      </tr></thead>
      <tbody>{all.map(group => {
        const clauses: AnalyticsSlice[] = group.key === null ? [] : [[dimension, group.key]];
        const label = group.label || t('unavailable');
        const total = group.key === null;
        const salary = bonusView ? null : salaryMetrics(group.rows);
        const bonus = bonusView ? bonusMetrics(group.rows) : null;
        const pool = total ? summedPool : group.unit?.poolCents ?? null;
        const pooledBonus = bonus ? bonusMetrics(group.rows.filter(row => row.pooled)) : null;
        const utilised = pooledBonus && pool !== null ? analyticsRatio(pooledBonus.payout, pool) : null;
        const status = utilised === null ? '' : utilised > 1 ? 'bg-red-500/15 text-red-700 dark:text-red-300'
          : utilised < .8 ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300' : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300';
        return <tr key={group.key ?? 'total'} className={total ? outcomeCls : 'border-b'}>
          <th scope="row"><FigureLink href={drill(clauses)} title={label}>{label}</FigureLink>
            {group.unit?.branchFactors && <span className="ml-2 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t('branchFactors')}</span>}
          </th>
          {salary && [
            salary.people, money(salary.beforeCents, true), money(salary.afterCents, true), money(salary.increaseCents, true),
            pct(salary.increaseRate), money(salary.meritCents, true), money(salary.promotionCents, true),
            money(salary.specialCents, true), `${decimal(salary.medianBeforeCr)} → ${decimal(salary.medianAfterCr)}`,
          ].map((value, index) => <td key={heading[index]} className="whitespace-nowrap text-right tabular-nums">{value}</td>)}
          {bonus && [
            bonus.eligible, bonus.paid, money(bonus.payout),
            ...(showPat ? [pct(group.unit?.canSeePat ? group.unit.patAchievement : null)] : []),
            money(pool), <span className={`rounded-full px-2 py-0.5 font-semibold ${status}`}>{pct(utilised)}</span>,
            decimal(bonus.averageMonths), decimal(bonus.medianMonths), decimal(bonus.highestMonths),
          ].map((value, index) => <td key={heading[index]} className="whitespace-nowrap text-right tabular-nums">{value}</td>)}
        </tr>;
      })}</tbody>
    </table></div>
  </FigureCard>;
}
