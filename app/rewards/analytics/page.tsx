import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { rewardReviewCompanyGroups } from '@/packs/rewards/group-roles';
import { rewardVisibleCompanies } from '@/packs/rewards/access-policy';
import { rewardAnalytics } from '@/packs/rewards/analytics';
import { scopedSession, getScopeIds } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { Button, Card, PageHeader, inputCls } from '@/components/ui';

type Filters = {
  cycle?: string; company?: string; unit?: string; businessGroup?: string;
  uploaded?: 'include' | 'exclude' | 'only'; view?: string;
};

export default async function RewardsAnalytics({ searchParams }: { searchParams: Promise<Filters> }) {
  await requireModule('rewards');
  const { s } = await scopedSession();
  const [companies, sp, locale, t, u, r, nav, dashboard] = await Promise.all([
    rewardVisibleCompanies(s), searchParams, getLocale(), getTranslations('rewardAdvisor'),
    getTranslations('rewardUploaded'), getTranslations('rewards'), getTranslations('nav'),
    getTranslations('rewardDashboard'),
  ]);
  const allowedIds = companies.map(company => company.id);
  const scopeIds = companies.some(company => company.wholeGroup) ? allowedIds : await getScopeIds(allowedIds);
  const companyGroups = await rewardReviewCompanyGroups(s, scopeIds);
  const view = sp.view === 'bonus' ? 'bonus' : 'salary';
  const analytics = await rewardAnalytics(s, scopeIds, {
    cycleId: sp.cycle, companyId: sp.company, businessUnitId: sp.unit, uploaded: sp.uploaded,
    groupCompanyIds: sp.businessGroup ? scopeIds.filter(id => companyGroups[id]?.groupId === sp.businessGroup) : undefined,
  });
  const cycles = [...new Map(analytics.units.map(unit => [unit.cycleId, unit.cycle])).entries()];
  const analyticsCompanyIds = new Set(analytics.units.map(unit => unit.companyId));
  const filters = [
    ['company', [...new Map(analytics.units.map(unit => [unit.companyId, unit.company])).entries()]],
    ['unit', [...new Map(analytics.units.map(unit => [unit.businessUnitId, unit.unit])).entries()]],
    ['businessGroup', [...new Map(Object.entries(companyGroups)
      .filter(([companyId]) => analyticsCompanyIds.has(companyId))
      .map(([, group]) => [group.groupId, group.groupName])).entries()]],
  ] as const;
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'MYR' });
  const displayMoney = (cents: number) => money.format(cents / 100);
  const viewHref = (next: 'salary' | 'bonus') => {
    const query = new URLSearchParams(Object.entries(sp).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ));
    query.set('view', next);
    return '/rewards/analytics?' + query.toString();
  };
  const salaryView = view === 'salary';
  const summary = analytics.groups.reduce((total, group) => ({
    before: total.before + group.payrollCents,
    increase: total.increase + group.incrementCents,
    bonus: total.bonus + group.bonusCents,
    people: total.people + group.people,
  }), { before: 0, increase: 0, bonus: 0, people: 0 });
  const summaryCards = salaryView
    ? [[r('currentPay'), displayMoney(summary.before)], [r('newPay'), displayMoney(summary.before + summary.increase)],
      [r('increment'), displayMoney(summary.increase)], [r('people'), summary.people]]
    : [[t('bonusPayout'), displayMoney(summary.bonus)], [r('people'), summary.people]];

  return <div className="space-y-5">
    <PageHeader title={nav('rewardsAnalytics')} description={t('analyticsHelp')} />
    <nav className="flex flex-wrap gap-2" aria-label={nav('rewardsAnalytics')}>
      <Button asChild variant={salaryView ? 'default' : 'outline'}><Link href={viewHref('salary')} aria-current={salaryView ? 'page' : undefined}>{t('salaryBeforeAfter')}</Link></Button>
      <Button asChild variant={salaryView ? 'outline' : 'default'}><Link href={viewHref('bonus')} aria-current={!salaryView ? 'page' : undefined}>{t('bonusPayout')}</Link></Button>
    </nav>
    <form className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="view" value={view} />
      <label className="text-sm">{r('cycle')}<select name="cycle" defaultValue={sp.cycle ?? ''} className={inputCls}>
        <option value="">{r('reviewList.all')}</option>
        {cycles.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label className="text-sm">{u('title')}<select name="uploaded" defaultValue={sp.uploaded ?? 'include'} className={inputCls}>
        {(['include', 'exclude', 'only'] as const).map(key => <option key={key} value={key}>{t(`uploadedFilter.${key}`)}</option>)}
      </select></label>
      {filters.map(([key, values]) => <label key={key} className="text-sm">
        {key === 'businessGroup' ? r('reviewList.businessGroup') : r(key)}
        <select name={key} defaultValue={sp[key] ?? ''} className={inputCls}>
          <option value="">{r('reviewList.all')}</option>
          {values.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>)}
      <Button>{r('reviewList.apply')}</Button>
    </form>
    {!analytics.groups.length ? <p>{t('empty')}</p> : <>
      <p className="text-sm text-muted-foreground">{salaryView ? dashboard('monthly') : r('cycle')}</p>
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {summaryCards.map(([label, value]) => <Card key={label} className="space-y-1 p-4">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{value}</dd>
        </Card>)}
      </dl>
      <div className="grid gap-4 md:grid-cols-2">
        {analytics.groups.map(group => <Card key={group.group} className="space-y-3 p-5">
          <h2 className="font-semibold">{group.group === 'uploaded' ? u('label') : group.group === 'ec' ? r('desk.ec') : t(group.group)}</h2>
          <p>{t('people')}{' · '}{group.people}</p>
          <p className="tabular-nums">{salaryView ? r('increment') : t('bonusPayout')}{' · '}{displayMoney(salaryView ? group.incrementCents : group.bonusCents)}</p>
          {salaryView && ([
            ['below', group.belowBefore, group.belowAfter],
            ['within', group.withinBefore, group.withinAfter],
            ['above', group.aboveBefore, group.aboveAfter],
          ] as const).map(([position, before, after]) => <p key={position} className="text-sm tabular-nums">{r(position)}{' · '}{before} → {after}</p>)}
        </Card>)}
      </div>
    </>}
  </div>;
}
