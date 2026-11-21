import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Button, Card, PageHeader, inputCls } from '@/components/ui';
import { analyticsBreakdowns, analyticsSlice, parseAnalyticsDrill, type AnalyticsSlice } from '@/packs/rewards/analytics-model';
import { BreakdownFigures, BonusFigures, SalaryFigures } from './figures';
import { AnalyticsRefresh } from './refresh-button';
import { analyticsQuery, loadRewardsAnalytics, type RewardsAnalyticsFilters } from './report';

const route = '/rewards/analytics';
const drillPageSize = 50;

export default async function RewardsAnalytics({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) if (typeof value === 'string') params.set(key, value);
  const [report, locale, t, nav] = await Promise.all([
    loadRewardsAnalytics(params), getLocale(), getTranslations('rewardsAnalytics'), getTranslations('nav'),
  ]);
  const { filters } = report;
  const currency = new Intl.NumberFormat(locale, { style: 'currency', currency: 'MYR' });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const precise = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (cents: number | null, annualize = false) => cents === null ? '—' : currency.format(cents / 100 * (annualize && filters.basis === 'annual' ? 12 : 1));
  const pct = (value: number | null) => value === null ? '—' : percent.format(value);
  const decimal = (value: number | null) => value === null ? '—' : precise.format(value);
  const url = (changes: Partial<RewardsAnalyticsFilters>) => `${route}?${analyticsQuery({ ...filters, ...changes })}`;
  const drillHref = (clauses: readonly AnalyticsSlice[], page = 1) => {
    const query = analyticsQuery(filters);
    query.set('drill', JSON.stringify(clauses));
    if (page > 1) query.set('drillPage', String(page));
    return `${route}?${query}#analytics-drill`;
  };
  const exportHref = (format: 'pdf' | 'xlsx') => {
    const query = analyticsQuery(filters);
    query.set('format', format);
    query.set('digest', report.digest);
    return `${route}/export?${query}`;
  };
  const groups = new Map<string, { name: string; units: typeof report.units }>();
  for (const unit of report.units) {
    const id = unit.groupId ?? 'unassigned';
    const group = groups.get(id) ?? { name: unit.uploaded ? t('uploaded') : unit.groupName ?? t('unassigned'), units: [] };
    group.units.push(unit);
    groups.set(id, group);
  }
  const scopeGroups = [...groups].filter(([id]) => !filters.groupId || filters.groupId === id);
  const authorized = new Map(report.selected.map(unit => [unit.id, unit]));
  const rawDrill = params.get('drill');
  const clauses = parseAnalyticsDrill(rawDrill);
  const showDrill = rawDrill === '[]' || clauses.length > 0;
  const drillRows = showDrill ? clauses.reduce((rows, [dimension, value]) => analyticsSlice(rows, dimension, value), report.rows) : [];
  const requestedPage = Math.max(1, Number(params.get('drillPage')) || 1);
  const pageCount = Math.max(1, Math.ceil(drillRows.length / drillPageSize));
  const page = Math.min(pageCount, Math.floor(requestedPage));
  const downloadReady = report.reconciled && report.selected.length > 0 && report.rows.length > 0;
  const figures = { report, t, money, pct, decimal, drill: drillHref };
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <PageHeader title={nav('rewardsAnalytics')} description={t('subtitle')} />
      <nav className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1" aria-label={t('view')}>
        {(['salary', 'bonus'] as const).map(view => <Button asChild key={view} size="sm" variant={filters.view === view ? 'default' : 'ghost'}>
          <Link href={url({ view })} aria-current={filters.view === view ? 'page' : undefined}>{t(view)}</Link>
        </Button>)}
      </nav>
    </div>

    <Card className="space-y-3 rounded-xl p-3 sm:p-4">
      <nav aria-label={t('businessGroup')} className="flex flex-wrap items-center gap-1.5">
        <Button asChild size="sm" variant={filters.groupId === null ? 'default' : 'ghost'}>
          <Link href={url({ groupId: null, unitId: null, businessUnitId: null, companyId: null })} aria-current={filters.groupId === null ? 'true' : undefined}>
            {t('allGroups')} <span className="ml-1 tabular-nums opacity-80">{groups.size}</span>
          </Link>
        </Button>
        {[...groups].map(([id, group]) => <Button asChild key={id} size="sm" variant={filters.groupId === id ? 'default' : 'ghost'}>
          <Link href={url({ groupId: id, unitId: null, businessUnitId: null, companyId: null })} aria-current={filters.groupId === id ? 'true' : undefined}>
            {group.name}<span className="ml-1 tabular-nums opacity-80">{new Set(group.units.map(unit => unit.businessUnitId)).size}</span>
          </Link>
        </Button>)}
      </nav>
      <nav aria-label={t('unit')} className="flex flex-wrap items-center gap-2 border-t pt-2">
        <Button asChild size="sm" variant={!filters.unitId && !filters.businessUnitId && !filters.companyId ? 'default' : 'ghost'}>
          <Link href={url({ unitId: null, businessUnitId: null, companyId: null })} aria-current={!filters.unitId && !filters.businessUnitId && !filters.companyId ? 'true' : undefined}>
            {t('allUnits')} <span className="ml-1 tabular-nums opacity-80">{scopeGroups.reduce((count, [, group]) => count + group.units.length, 0)}</span>
          </Link>
        </Button>
        {scopeGroups.map(([id, group]) => <div key={id} className="flex flex-wrap items-center gap-1">
          <span className="mx-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group.name}</span>
          {group.units.map(unit => <Button asChild key={unit.id} size="sm" variant={filters.unitId === unit.id ? 'default' : 'ghost'}>
            <Link href={url({ unitId: unit.id, businessUnitId: null, companyId: null })} prefetch={false}
              title={`${unit.company} · ${unit.unit} · ${t('peopleScope', { count: unit.people })}`}
              aria-current={filters.unitId === unit.id ? 'true' : undefined}>
              {unit.company} · {unit.unit}<span className="ml-1 tabular-nums opacity-80">{unit.people}</span>
              {unit.blockers > 0 && <><span className="ml-1 size-1.5 rounded-full bg-red-600" aria-hidden="true" /><span className="sr-only">{t('blockerCount', { count: unit.blockers })}</span></>}
            </Link>
          </Button>)}
        </div>)}
        <p className="text-xs text-muted-foreground">{t('showingUnits', { count: report.selected.length })}</p>
      </nav>
    </Card>

    <div className="flex flex-wrap items-end justify-between gap-3">
      <form action={route} className="flex flex-wrap items-end gap-2">
        {Array.from(analyticsQuery(filters)).filter(([name]) => name !== 'cycle' && name !== 'uploaded')
          .map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <label className="grid gap-1 text-xs font-medium">{t('cycle')}
          <select name="cycle" defaultValue={filters.cycleId ?? ''} className={inputCls}>
            <option value="">{report.latestYear ? t('latestYear', { year: String(report.latestYear) }) : t('latestCycle')}</option>
            <option value="all">{t('allCycles')}</option>
            {report.cycles.map(cycle => <option key={cycle.id} value={cycle.id}>{cycle.name} · {cycle.year}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium">{t('uploaded')}
          <select name="uploaded" defaultValue={filters.uploaded} className={inputCls}>
            {(['include', 'exclude', 'only'] as const).map(key => <option key={key} value={key}>{t(`uploadedFilter.${key}`)}</option>)}
          </select>
        </label>
        <Button variant="outline" type="submit">{t('apply')}</Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex gap-1 rounded-lg bg-muted/60 p-1" aria-label={t('basis')}>
          {(['monthly', 'annual'] as const).map(basis => <Button asChild key={basis} size="sm" variant={filters.basis === basis ? 'default' : 'ghost'}>
            <Link href={url({ basis })} aria-current={filters.basis === basis ? 'true' : undefined}>{t(basis)}</Link>
          </Button>)}
        </nav>
        <AnalyticsRefresh label={t('refresh')} refreshing={t('refreshing')} />
        {downloadReady && <>
          <Button asChild variant="outline"><a href={exportHref('pdf')}>{t('pdf')}</a></Button>
          <Button asChild variant="outline"><a href={exportHref('xlsx')}>{t('excel')}</a></Button>
        </>}
      </div>
    </div>

    {!report.reconciled && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t('figuresRefreshing')}</p>}
    {report.protectedIncluded && <p className="text-xs text-muted-foreground">{t('protectedIncluded')}</p>}
    {report.protectedWithheld && <p className="text-xs text-muted-foreground">{t('protectedWithheld')}</p>}
    <p className="text-xs text-muted-foreground">{t('basisNote', { basis: t(filters.basis) })}</p>

    {showDrill && <Card id="analytics-drill" className="scroll-mt-4 space-y-3 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('drillTitle')}</h2>
        <Button asChild variant="outline" size="sm"><Link href={url({})}>{t('closeDrill')}</Link></Button>
      </div>
      {drillRows.length ? <>
        <p className="text-sm text-muted-foreground">{t('peopleScope', { count: drillRows.length })}</p>
        <ul className="divide-y">
          {drillRows.slice((page - 1) * drillPageSize, page * drillPageSize).map(row => {
            const unit = authorized.get(row.unitId);
            return <li key={row.id} className="py-2 text-sm">
              {unit?.canOpenReview ? <Link href={`/rewards/${row.unitId}?person=${encodeURIComponent(row.id)}`} prefetch={false} className="font-medium text-primary hover:underline">{row.name}</Link> : <span className="font-medium">{row.name}</span>}
              <span className="ml-2 text-muted-foreground">{row.employeeCode} · {unit?.company} · {unit?.unit}</span>
              {row.excludedByPayWindow && <span className="ml-2 rounded-full bg-muted px-2 py-1 text-xs">{t('excludedByPayWindow')}</span>}
            </li>;
          })}
        </ul>
        {pageCount > 1 && <nav className="flex items-center gap-2" aria-label={t('drillPages')}>
          {page > 1 && <Button asChild size="sm" variant="outline"><Link href={drillHref(clauses, page - 1)}>{t('previous')}</Link></Button>}
          <span className="text-sm tabular-nums">{page} / {pageCount}</span>
          {page < pageCount && <Button asChild size="sm" variant="outline"><Link href={drillHref(clauses, page + 1)}>{t('next')}</Link></Button>}
        </nav>}
      </> : <p className="text-sm text-muted-foreground">{t('noDrillRows')}</p>}
    </Card>}

    {report.totals.people ? <>
      {filters.view === 'salary' ? <SalaryFigures {...figures} /> : <BonusFigures {...figures} />}
      <BreakdownFigures {...figures} breakdownLinks={<nav className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-1" aria-label={t('breakdown')}>
        {analyticsBreakdowns.map(breakdown => <Button key={breakdown} asChild size="sm" variant={filters.breakdown === breakdown ? 'default' : 'ghost'}>
          <Link href={url({ breakdown })} aria-current={filters.breakdown === breakdown ? 'true' : undefined}>{t(breakdown)}</Link>
        </Button>)}
      </nav>} />
    </> : <Card className="p-5 text-sm text-muted-foreground">{t('empty')}</Card>}
  </div>;
}
