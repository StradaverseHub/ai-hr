import 'server-only';
import { requireModule } from '@/lib/authz';
import { scopedSession, getScopeIds } from '@/lib/scope';
import { rewardVisibleCompanies } from '@/packs/rewards/access-policy';
import { rewardReviewCompanyGroups } from '@/packs/rewards/group-roles';
import { rewardAnalytics } from '@/packs/rewards/analytics';
import { analyticsBreakdowns, type AnalyticsBasis, type AnalyticsBreakdown, type AnalyticsView } from '@/packs/rewards/analytics-model';

export type RewardsAnalyticsFilters = {
  view: AnalyticsView; basis: AnalyticsBasis; breakdown: AnalyticsBreakdown;
  groupId: string | null; unitId: string | null; cycleId: string | null;
  companyId: string | null; businessUnitId: string | null;
  uploaded: 'include' | 'exclude' | 'only';
};

function readFilters(params: URLSearchParams): RewardsAnalyticsFilters {
  const selected = (key: string) => {
    const value = params.get(key);
    return value && value.length <= 80 ? value : null;
  };
  const breakdown = params.get('breakdown') as AnalyticsBreakdown | null;
  const uploaded = params.get('uploaded');
  return {
    view: params.get('view') === 'bonus' ? 'bonus' : 'salary',
    basis: params.get('basis') === 'annual' ? 'annual' : 'monthly',
    breakdown: breakdown && analyticsBreakdowns.includes(breakdown) ? breakdown : 'unit',
    groupId: selected('group') ?? selected('businessGroup'),
    unitId: selected('review'), cycleId: selected('cycle'),
    companyId: selected('company'), businessUnitId: selected('unit'),
    uploaded: uploaded === 'only' || uploaded === 'exclude' ? uploaded : 'include',
  };
}

export function analyticsQuery(filters: RewardsAnalyticsFilters): URLSearchParams {
  const result = new URLSearchParams({ view: filters.view, basis: filters.basis, breakdown: filters.breakdown, uploaded: filters.uploaded });
  for (const [key, value] of [
    ['group', filters.groupId], ['review', filters.unitId], ['cycle', filters.cycleId],
    ['company', filters.companyId], ['unit', filters.businessUnitId],
  ] as const) if (value) result.set(key, value);
  return result;
}

export async function loadRewardsAnalytics(params: URLSearchParams) {
  await requireModule('rewards');
  const { s } = await scopedSession();
  const companies = await rewardVisibleCompanies(s);
  const allowed = companies.map(company => company.id);
  const scope = companies.some(company => company.wholeGroup) ? allowed : await getScopeIds(allowed);
  const groups = await rewardReviewCompanyGroups(s, scope);
  const filters = readFilters(params);
  const report = await rewardAnalytics(s, scope, groups, filters);
  return { ...report, filters };
}

export type RewardsAnalyticsReport = Awaited<ReturnType<typeof loadRewardsAnalytics>>;
