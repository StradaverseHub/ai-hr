// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import RewardsAnalytics from '../app/rewards/analytics/page';
import type { RewardsAnalyticsFilters, RewardsAnalyticsReport } from '../app/rewards/analytics/report';
import { analyticsTotals, type AnalyticsRow, type AnalyticsUnit } from '../packs/rewards/analytics-model';
import { aiReviewDomHtml, captureAiReviewScreenshots } from './helpers/ai-review-screenshots';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, scroll: _scroll, ...props }: React.ComponentProps<'a'> & { prefetch?: boolean; scroll?: boolean }) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en-MY',
  getTranslations: async (namespace: 'rewardsAnalytics' | 'nav') => createTranslator({ locale: 'en', messages: en, namespace }),
}));
vi.mock('../app/rewards/analytics/refresh-button', () => ({ AnalyticsRefresh: ({ label }: { label: string }) => <button type="button">{label}</button> }));
vi.mock('../app/rewards/analytics/report', () => ({
  loadRewardsAnalytics: mocks.load,
  analyticsQuery: (filters: RewardsAnalyticsFilters) => new URLSearchParams({ view: filters.view, basis: filters.basis, breakdown: filters.breakdown }),
}));

const row: AnalyticsRow = {
  id: 'visible-entry', unitId: 'authorized-unit', name: 'Fictional visible employee', employeeCode: 'E-2',
  grade: '12', talent: 'STAR', performance: 'AE', department: { id: 'dept-a', name: 'Fictional engineering' },
  beforeCents: 500_000, afterCents: 600_000, meritCents: 100_000, promotionCents: 0, specialCents: 0,
  beforeRange: [600_000, 700_000, 800_000], afterRange: [600_000, 700_000, 800_000],
  promoted: false, incrementRun: true, excludedByPayWindow: false, bonusEligible: true,
  bonusBasicCents: 500_000, bonusCents: 1_000_000, lumpCents: 0, pooled: true, exceptions: 1, blockers: 1,
};
const unit: AnalyticsUnit = {
  id: 'authorized-unit', cycleId: 'cycle-1', cycle: 'Annual compensation review', year: 2026,
  companyId: 'company-a', company: 'Fictional Engineering', businessUnitId: 'bu-a', unit: 'Operations',
  groupId: 'group-a', groupName: 'Fictional group', uploaded: false, branchFactors: true,
  people: 1, blockers: 1, poolCents: 1_200_000, patAchievement: null, canSeePat: false, canOpenReview: true,
};
const report: RewardsAnalyticsReport = {
  units: [unit], selected: [unit], rows: [row], totals: analyticsTotals([row]), cycles: [{ id: 'cycle-1', name: unit.cycle, year: 2026 }],
  latestYear: 2026, reconciled: true, digest: 'a'.repeat(64), protectedIncluded: false, protectedWithheld: false,
  filters: { view: 'salary', basis: 'monthly', breakdown: 'unit', groupId: null, unitId: null, cycleId: null,
    companyId: null, businessUnitId: null, uploaded: 'include' },
};

afterEach(cleanup);
async function show(data: RewardsAnalyticsReport, params: Record<string, string> = {}) {
  mocks.load.mockResolvedValue(data);
  return render(await RewardsAnalytics({ searchParams: Promise.resolve(params) }));
}

describe('Rewards Analytics rendered views', () => {
  it('renders live salary figures, heat cells, scope controls and drill links without employee names in the overview', async () => {
    const view = await show(report);
    expect(screen.getByRole('heading', { name: en.nav.rewardsAnalytics })).toBeTruthy();
    expect(screen.getByRole('heading', { name: en.rewardsAnalytics.positionByGrade })).toBeTruthy();
    expect(screen.getAllByText(/▲ 20%/).length).toBeGreaterThan(0);
    expect(screen.getByRole('navigation', { name: 'Business group' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Review cycle' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download PDF' }).getAttribute('href')).toContain('digest=' + report.digest);
    expect(screen.queryByText(row.name)).toBeNull();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'rewards-analytics-salary');
  }, 60_000);

  it('renders bonus distribution, no unauthorized PAT and no export while totals are refreshing', async () => {
    const view = await show({ ...report, reconciled: false, filters: { ...report.filters, view: 'bonus' } });
    expect(screen.getByRole('heading', { name: 'Spread of bonus months' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Pool utilisation by unit' })).toBeTruthy();
    expect(screen.getByText('Branch factors')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Figures being refreshed');
    expect(screen.queryByRole('link', { name: 'Download Excel' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'PAT achievement' })).toBeNull();
    expect(screen.queryByText(row.name)).toBeNull();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'rewards-analytics-bonus');
  }, 60_000);

  it('shows only projected drill rows and the native person review destination', async () => {
    await show(report, { drill: JSON.stringify([['grade', '12'], ['before', 'below']]) });
    expect(screen.getByRole('link', { name: row.name }).getAttribute('href')).toBe('/rewards/authorized-unit?person=visible-entry');
    expect(screen.queryByText('Fictional private own line')).toBeNull();
  });
});
