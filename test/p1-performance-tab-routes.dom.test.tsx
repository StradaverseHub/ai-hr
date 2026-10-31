/**
 * D-P1-32 PT-X2: the employee/leader tab route pages, rendered.
 *
 * Per persona (the worklist facts the PT-X1 gates read, mocked at the service seam; the gates and the strip
 * are real), every tab route either renders its strip with its own tab lit over the existing widget with
 * that tab's fixed filters, or refuses a crafted URL with notFound() BEFORE reading the widget's data.
 * The Calibration page filters by axis (BG on both lists, DQ-8) and keeps the old whole-list URL; a session
 * page lights the tab for its axis hint; the Feedback page opens the viewer's own record on its Feedback
 * section; Team PM's per-review route refuses a review the viewer does not lead.
 *
 * Non-vacuity: removing `if(!mayOpen)notFound()` from tab-route.tsx turns every hidden-tab case red (the
 * workspace stub would render); the same line in feedback/page.tsx and team/[reviewId]/page.tsx, and the axis
 * tab check in calibration/page.tsx, turn their refusal cases red; dropping calibrationSessionsForAxis turns the
 * axis-list rows red; passing no hint from the session page turns the lit-tab cases red; dropping the Talent
 * box tab check from the board links turns the board-link case red.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { PerformanceAreaFacts, PerformanceAreaItem } from '../packs/performance/onehr/tab-model';
import type { CalibrationListSession } from '../packs/performance/onehr/calibration-list-model';

const state = vi.hoisted(() => ({
  path: '/', search: '',
  facts: { performanceOn: false, items: [], ownFeedbackReport: 'none' } as unknown as PerformanceAreaFacts,
  sessions: [] as unknown[],
  /** Workspace items with ids (the page's talentBoxSessionIds reads them); the facts above carry no ids. */
  boards: [] as unknown[],
}));
const mock = vi.hoisted(() => ({
  requireModule: vi.fn(async () => undefined),
  review: vi.fn(), reviews: vi.fn(), assignments: vi.fn(), record: vi.fn(), calibration: vi.fn(), finalBands: vi.fn(), sessions: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: () => { throw Error('NOT_FOUND'); }, redirect: vi.fn(),
  usePathname: () => state.path, useSearchParams: () => new URLSearchParams(state.search), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('next-intl/server', async () => { const { createTranslator } = await import('next-intl'); return { getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages, namespace: namespace as never }) }; });
vi.mock('../lib/authz', () => ({ requireModule: mock.requireModule }));
vi.mock('../lib/scope', () => ({ scopedSession: async () => ({ s: { tenantId: 'tenant', userId: 'viewer', personId: 'person' }, scopeIds: [], allowedCount: 1 }) }));
vi.mock('../packs/performance/service', async () => {
  const tabs = await import('../packs/performance/onehr/tab-model');
  return {
    performanceAreaTab: tabs.performanceAreaTab,
    performanceTabAccess: async (_s: unknown, id: string) => { const tabState = tabs.performanceTabState(state.facts, id); return { state: tabState, mayOpen: tabState === 'open', facts: state.facts }; },
    getPerformanceAreaFacts: async () => state.facts,
    getPerformanceAreaFactsAndItems: async () => ({ facts: state.facts, items: state.boards }),
    performanceTabState: tabs.performanceTabState,
    listMyCalibrationSessions: mock.sessions,
    getOnehrReview: mock.review, myReviews: mock.reviews, onehrAssignments: mock.assignments, getAssessmentPersonalRecord: mock.record,
    getOnehrCalibration: mock.calibration, getAssessmentFinalBands: mock.finalBands,
  };
});
vi.mock('../app/(app)/performance/workspace/workspace-screen', () => ({
  PerformanceWorkspaceScreen: ({ query, scope }: { query: unknown; scope?: { tabId: string; view: string; module: string; stages?: string[]; kind?: string; path: string } }) =>
    <div data-testid="workspace" data-tab={scope?.tabId ?? ''} data-scope={scope ? JSON.stringify({ view: scope.view, module: scope.module, stages: scope.stages ?? null, kind: scope.kind ?? null, path: scope.path }) : ''} data-query={JSON.stringify(query)} />,
}));
vi.mock('../app/(app)/performance/workspace/personal-record', () => ({
  PersonalRecord: ({ tab, baseHref }: { tab?: string; baseHref: string }) => <div data-testid="personal-record" data-tab={tab} data-href={baseHref} />,
}));
vi.mock('../app/(app)/performance/onehr/review-view', () => ({
  OnehrReviewView: ({ returnTo }: { returnTo?: string }) => <div data-testid="review" data-return={returnTo} />,
}));
vi.mock('../app/(app)/performance/onehr/calibration-view', () => ({ AssessmentCalibrationView: () => <div data-testid="calibration-session" /> }));
vi.mock('../app/(app)/performance/onehr/final-bands-view', () => ({ FinalBandsView: () => <div data-testid="final-bands" /> }));

import SetMyKpisPage from '../app/(app)/performance/my/kpis/page';
import MyPmPage from '../app/(app)/performance/my/page';
import ApproveKpisPage from '../app/(app)/performance/team/kpis/page';
import TeamPmPage from '../app/(app)/performance/team/page';
import TeamReviewPage from '../app/(app)/performance/team/[reviewId]/page';
import MyAssessmentsPage from '../app/(app)/performance/assessments/page';
import FeedbackReportPage from '../app/(app)/performance/feedback/page';
import MyCompetencyPage from '../app/(app)/performance/competency/page';
import TeamCompetencyPage from '../app/(app)/performance/competency/team/page';
import MyPlanPage from '../app/(app)/performance/plan/page';
import CareerProfilePage from '../app/(app)/performance/plan/profile/page';
import TeamPlanPage from '../app/(app)/performance/plan/team/page';
import PerformanceCalibrationPage from '../app/(app)/performance/calibration/page';
import AssessmentCalibrationPage from '../app/(app)/performance/assessment/calibration/[sessionId]/page';
import PerformanceWorkspacePage from '../app/(app)/performance/workspace/page';

afterEach(() => { cleanup(); vi.clearAllMocks(); state.path = '/'; state.search = ''; state.boards = []; });

const area = messages.performanceArea;
const draw = (node: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={messages} onError={error => { throw error; }}>{node}</NextIntlClientProvider>);
/** Render a page at a location; resolves to 'NOT_FOUND' when the page refuses it. */
async function open(page: (props: never) => Promise<React.ReactNode>, path: string, props: Record<string, unknown>) {
  state.path = path.split('?')[0]; state.search = path.split('?')[1] ?? '';
  try { draw(await page(props as never)); return 'rendered'; } catch (error) { if ((error as Error).message === 'NOT_FOUND') return 'NOT_FOUND'; throw error; }
}
const query = (search: Record<string, string> = {}) => ({ searchParams: Promise.resolve(search) });
const lit = () => screen.queryAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page').map(link => link.getAttribute('data-tab'));

const item = (kind: PerformanceAreaItem['kind'], view: PerformanceAreaItem['view'], module: PerformanceAreaItem['module'], stage: string, extra: Partial<PerformanceAreaItem> = {}): PerformanceAreaItem =>
  ({ kind, cycleId: 'cycle-1', view, module, stage, locked: false, ...extra });
const review = (view: PerformanceAreaItem['view'], module: PerformanceAreaItem['module'], stage: string, extra: Partial<PerformanceAreaItem> = {}) => item('review', view, module, stage, extra);
const calibration = (view: PerformanceAreaItem['view'], stage: string, axis: 'performance' | 'potential' | 'both') => item('calibration', view, 'cal', stage, { axis });
const rateColleague = item('feedback', 'mine', 'tm', 'feedback');
const facts = (items: PerformanceAreaItem[], ownFeedbackReport: PerformanceAreaFacts['ownFeedbackReport'] = 'none', performanceOn = true): PerformanceAreaFacts => ({ performanceOn, items, ownFeedbackReport });
const ownResults = review('mine', 'pm', 'results');

/** The workspace tab routes: page, URL, tab id, strip, and the widget filters it must pass. */
const ROUTES = [
  { page: SetMyKpisPage, path: '/performance/my/kpis', tab: 'pm.setting', strip: 'pm', scope: { view: 'mine', module: 'pm', stages: ['setting'], kind: null } },
  { page: MyPmPage, path: '/performance/my', tab: 'pm.my', strip: 'pm', scope: { view: 'mine', module: 'pm', stages: ['results', 'checkin'], kind: null } },
  { page: ApproveKpisPage, path: '/performance/team/kpis', tab: 'pm.approve', strip: 'pm', scope: { view: 'team', module: 'pm', stages: ['setting'], kind: null } },
  { page: TeamPmPage, path: '/performance/team', tab: 'pm.team', strip: 'pm', scope: { view: 'team', module: 'pm', stages: ['results', 'moderation', 'checkin'], kind: null } },
  { page: MyAssessmentsPage, path: '/performance/assessments', tab: 'feedback.assessments', strip: 'f360', scope: { view: 'mine', module: 'tm', stages: null, kind: 'feedback' } },
  { page: MyCompetencyPage, path: '/performance/competency', tab: 'competency.my', strip: 'competency', scope: { view: 'mine', module: 'tm', stages: ['competency'], kind: null } },
  { page: TeamCompetencyPage, path: '/performance/competency/team', tab: 'competency.team', strip: 'competency', scope: { view: 'team', module: 'tm', stages: ['competency'], kind: null } },
  { page: MyPlanPage, path: '/performance/plan', tab: 'plan.my', strip: 'idp', scope: { view: 'mine', module: 'idp', stages: null, kind: null } },
  { page: CareerProfilePage, path: '/performance/plan/profile', tab: 'plan.profile', strip: 'idp', scope: { view: 'mine', module: 'idp', stages: null, kind: null } },
  { page: TeamPlanPage, path: '/performance/plan/team', tab: 'plan.team', strip: 'idp', scope: { view: 'team', module: 'idp', stages: null, kind: null } },
] as const;
const stripName = (strip: string) => (area.admin.sections as Record<string, string>)[strip];

/** The routes each persona may open (hard-coded, not derived from the gates). Every other route is a 404. */
const PERSONAS: { name: string; facts: PerformanceAreaFacts; opens: string[] }[] = [
  { name: 'employee (locked own plan, asked to rate a colleague)', facts: facts([ownResults, review('mine', 'tm', 'competency'), review('mine', 'idp', 'career', { locked: true }), rateColleague]),
    opens: ['/performance/my', '/performance/assessments', '/performance/competency'] },
  { name: 'employee still setting KPIs', facts: facts([review('mine', 'pm', 'setting')]), opens: ['/performance/my/kpis'] },
  { name: 'line manager', facts: facts([ownResults, review('mine', 'tm', 'competency'), review('mine', 'idp', 'career'), review('team', 'pm', 'setting'), review('team', 'pm', 'moderation'), review('team', 'tm', 'competency'), review('team', 'idp', 'career')], 'released'),
    opens: ['/performance/my', '/performance/team/kpis', '/performance/team', '/performance/competency', '/performance/competency/team', '/performance/plan', '/performance/plan/profile', '/performance/plan/team'] },
  { name: 'HOD', facts: facts([ownResults, review('team', 'pm', 'results'), calibration('dept', 'department_review', 'performance'), calibration('dept', 'department_potential_review', 'potential')]), opens: ['/performance/my', '/performance/team'] },
  { name: 'BU CEO', facts: facts([ownResults, calibration('bu', 'calibration', 'performance'), calibration('bu', 'potential_calibration', 'potential'), calibration('bu', 'talent_box', 'both')], 'released'), opens: ['/performance/my'] },
  { name: 'BG CEO (owes feedback)', facts: facts([rateColleague, calibration('bg', 'talent_box', 'both')]), opens: ['/performance/assessments'] },
  { name: 'Group Chief', facts: facts([calibration('group', 'group_calibration', 'performance'), calibration('group', 'talent_box', 'both')]), opens: [] },
  { name: 'Performance module off', facts: facts([ownResults, review('team', 'pm', 'setting'), rateColleague], 'released', false), opens: [] },
];

describe('workspace tab routes: render for a shown tab, 404 for a hidden one (crafted URL)', () => {
  it('the persona table opens and refuses every route at least once', () => {
    for (const route of ROUTES) {
      expect(PERSONAS.some(p => p.opens.includes(route.path)), `${route.path} opened by someone`).toBe(true);
      expect(PERSONAS.some(p => !p.opens.includes(route.path)), `${route.path} refused to someone`).toBe(true);
    }
  });
  describe.each(PERSONAS)('$name', persona => {
    beforeEach(() => { state.facts = persona.facts; });
    it.each(ROUTES)('$path', async route => {
      const outcome = await open(route.page as never, route.path, query({ cycle: 'cycle-1', review: 'r-1' }));
      expect(mock.requireModule).toHaveBeenCalledWith('performance');
      if (!persona.opens.includes(route.path)) {
        expect(outcome).toBe('NOT_FOUND');
        return;
      }
      expect(outcome).toBe('rendered');
      const nav = screen.getByRole('navigation', { name: stripName(route.strip) });
      expect(within(nav).getByRole('link', { current: 'page' }).getAttribute('href')).toBe(route.path);
      expect(lit()).toEqual([route.tab]);
      const widget = screen.getByTestId('workspace');
      expect(widget.getAttribute('data-tab')).toBe(route.tab);
      expect(JSON.parse(widget.getAttribute('data-scope')!)).toEqual({ ...route.scope, path: route.path });
      expect(JSON.parse(widget.getAttribute('data-query')!)).toEqual({ cycle: 'cycle-1', review: 'r-1' });
    });
  });
  it('a locked Career Plan tab (drawn disabled) cannot be opened by URL', async () => {
    state.facts = facts([review('mine', 'idp', 'career', { locked: true })]);
    expect(await open(MyPlanPage as never, '/performance/plan', query())).toBe('NOT_FOUND');
    expect(screen.queryByTestId('workspace')).toBeNull();
  });
});

describe('old workspace URLs (D8)', () => {
  it.each<Record<string, string>>([
    { cycle: 'cycle-1', view: 'team', module: 'pm', review: 'r-1' },
    { view: 'mine', module: 'tm', stage: 'feedback', feedback: 'f-1' },
    { view: 'bu', module: 'cal', stage: 'talent_box', calibration: 's-1' },
  ])('/performance/workspace?%o still renders the whole workspace with the query untouched', async search => {
    state.facts = facts([]);
    expect(await open(PerformanceWorkspacePage as never, '/performance/workspace', query(search))).toBe('rendered');
    const widget = screen.getByTestId('workspace');
    expect(widget.getAttribute('data-scope')).toBe('');
    expect(JSON.parse(widget.getAttribute('data-query')!)).toEqual(search);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('Team PM per-review route', () => {
  const id = '0f9b4c1e-2d3a-4b5c-8d7e-6f5a4b3c2d1e';
  const lm = facts([review('team', 'pm', 'moderation')]);
  const props = (reviewId: string) => ({ params: Promise.resolve({ reviewId }), searchParams: Promise.resolve({}) });
  it('renders the existing review under the PM strip with Team PM lit; saves return here', async () => {
    state.facts = lm; mock.review.mockResolvedValue({ self: false, manager: true, moderator: false, reviewer: false });
    expect(await open(TeamReviewPage as never, `/performance/team/${id}`, props(id))).toBe('rendered');
    expect(lit()).toEqual(['pm.team']);
    expect(screen.getByTestId('review').getAttribute('data-return')).toBe(`/performance/team/${id}?`);
  });
  it.each([
    ['the Team PM tab is hidden', facts([ownResults]), { manager: true }, id],
    ['the id is not a review id', lm, { manager: true }, 'kpis-x'],
    ['the review does not exist', lm, null, id],
    ['it is the viewer’s own review', lm, { self: true, manager: false, moderator: false, reviewer: false }, id],
    ['the viewer only administers it', lm, { self: false, manager: false, moderator: false, reviewer: false, admin: true }, id],
  ] as const)('404 when %s', async (_why, f, found, reviewId) => {
    state.facts = f; mock.review.mockResolvedValue(found);
    expect(await open(TeamReviewPage as never, `/performance/team/${reviewId}`, props(reviewId))).toBe('NOT_FOUND');
    expect(screen.queryByTestId('review')).toBeNull();
  });
  it('a non-review id never reaches the review read', async () => {
    state.facts = lm;
    await open(TeamReviewPage as never, '/performance/team/kpis-x', props('kpis-x'));
    expect(mock.review).not.toHaveBeenCalled();
  });
});

describe('Feedback: the own 360 report', () => {
  const own = '7a1abb6e-7e3e-4f5e-bca6-04fb721e6935', team = '654e0910-f9ae-472e-89cb-50b907a78e89';
  beforeEach(() => {
    mock.reviews.mockResolvedValue([{ reviewId: own }]);
    mock.assignments.mockResolvedValue({ reviews: [{ id: team }, { id: own }], sessions: [], feedback: [] });
    mock.record.mockResolvedValue({ current: null, selected: null, history: [], plans: [] });
  });
  it.each(['released', 'confirmed'] as const)('%s report: the personal record on its Feedback section, anchored on the own review', async report => {
    state.facts = facts([ownResults], report);
    expect(await open(FeedbackReportPage as never, '/performance/feedback', query({ record: '../x', planYear: 'abc' }))).toBe('rendered');
    expect(lit()).toEqual(['feedback.feedback']);
    expect(mock.record).toHaveBeenCalledWith(expect.objectContaining({ userId: 'viewer' }), own, undefined, undefined);
    expect(screen.getByTestId('personal-record').getAttribute('data-tab')).toBe('feedback');
    expect(screen.getByTestId('personal-record').getAttribute('data-href')).toBe('/performance/feedback');
  });
  it('keeps the record and section the user chose', async () => {
    state.facts = facts([ownResults], 'released');
    await open(FeedbackReportPage as never, '/performance/feedback', query({ record: 'current', recordTab: 'plans', planYear: '2026' }));
    expect(mock.record).toHaveBeenCalledWith(expect.anything(), own, 'current', 2026);
    expect(screen.getByTestId('personal-record').getAttribute('data-tab')).toBe('plans');
  });
  it('with no own review to anchor on, the explanatory empty state', async () => {
    state.facts = facts([], 'confirmed'); mock.reviews.mockResolvedValue([]);
    expect(await open(FeedbackReportPage as never, '/performance/feedback', query())).toBe('rendered');
    expect(screen.getByText(messages.onehr.personalRecord.unreleasedReport)).toBeTruthy();
    expect(mock.record).not.toHaveBeenCalled();
  });
  it('404 for a manager or HOD with no own report (DQ-5), before any record read', async () => {
    state.facts = facts([ownResults, review('team', 'pm', 'results')], 'none');
    expect(await open(FeedbackReportPage as never, '/performance/feedback', query())).toBe('NOT_FOUND');
    expect(mock.reviews).not.toHaveBeenCalled();
    expect(mock.record).not.toHaveBeenCalled();
  });
});

describe('Calibration: per-axis lists and session pages', () => {
  const row = (id: string, tier: CalibrationListSession['tier'], axes: CalibrationListSession['axes']): CalibrationListSession => ({
    id, name: `${tier} session`, tier, cycleId: 'cycle-1', cycleName: 'Annual 2026', cycleClosed: false, companyName: 'Acme Sdn Bhd',
    window: 'open', opensOn: null, closesOn: null, people: 3, toDo: 1, lock: 'open', axes, href: `/performance/assessment/calibration/${id}`,
  });
  const SESSIONS = [row('hod', 'hod', ['performance', 'potential']), row('bu', 'bu', ['performance', 'potential', 'both']), row('bg', 'bg', ['both']), row('group', 'group', ['performance', 'both'])];
  const bgCeo = facts([calibration('bg', 'talent_box', 'both')]);
  const groupChief = facts([calibration('group', 'group_calibration', 'performance'), calibration('group', 'talent_box', 'both')]);
  /** Sorted: the list groups rows by tier (calibrationListTierOrder), which is not what is under test here. */
  const sessionLinks = () => screen.getAllByRole('link').map(link => link.getAttribute('href') ?? '').filter(href => href.startsWith('/performance/assessment/calibration/')).sort();
  beforeEach(() => { mock.sessions.mockResolvedValue(SESSIONS); });

  it.each([
    ['performance', bgCeo, ['hod', 'bu', 'bg', 'group']],
    ['potential', bgCeo, ['hod', 'bu', 'bg']],
    ['performance', groupChief, ['hod', 'bu', 'bg', 'group']],
  ] as const)('?axis=%s lists only that axis, each opening its session with the axis', async (axis, f, ids) => {
    state.facts = f;
    expect(await open(PerformanceCalibrationPage as never, `/performance/calibration?axis=${axis}`, query({ axis }))).toBe('rendered');
    expect(lit()).toEqual([`calibration.${axis}`]);
    expect(sessionLinks()).toEqual(ids.map(id => `/performance/assessment/calibration/${id}?axis=${axis}`).sort());
  });
  it('a session whose Talent Box the viewer holds also links to its standalone board (PT-TB); others do not', async () => {
    state.facts = bgCeo;
    state.boards = [{ id: 'bg', kind: 'calibration', module: 'cal', stage: 'talent_box', view: 'bg', cycleId: 'cycle-1' }, { id: 'hod', kind: 'calibration', module: 'cal', stage: 'department_review', view: 'dept', cycleId: 'cycle-1' }];
    expect(await open(PerformanceCalibrationPage as never, '/performance/calibration', query())).toBe('rendered');
    const boards = () => [...document.querySelectorAll('[data-talent-box-link]')].map(link => link.getAttribute('href'));
    expect(boards()).toEqual(['/performance/calibration/talent-box?session=bg']);
    cleanup();
    // Without the Talent box tab (no talent_box fact), no board link, even for a held id.
    state.facts = facts([calibration('bu', 'calibration', 'performance')]);
    expect(await open(PerformanceCalibrationPage as never, '/performance/calibration', query())).toBe('rendered');
    expect(boards()).toEqual([]);
  });
  it('a hidden axis tab is refused by URL (Group Chief has no Potential), before the session list is read', async () => {
    state.facts = groupChief;
    expect(await open(PerformanceCalibrationPage as never, '/performance/calibration?axis=potential', query({ axis: 'potential' }))).toBe('NOT_FOUND');
    expect(mock.sessions).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{}, { axis: 'talent_box' }])('the old URL (%o) keeps the whole list and its links', async search => {
    state.facts = facts([]);
    expect(await open(PerformanceCalibrationPage as never, '/performance/calibration', query(search))).toBe('rendered');
    expect(sessionLinks()).toEqual(SESSIONS.map(s => s.href).sort());
  });

  const sessionProps = (search: Record<string, string>) => ({ params: Promise.resolve({ sessionId: 's-1' }), searchParams: Promise.resolve(search) });
  it.each([
    ['a BG session lights Talent box', 'bg', { pm: true, pot: true }, {}, 'calibration.talentBox'],
    ['a BG session opened from the Potential list lights Potential', 'bg', { pm: true, pot: true }, { axis: 'potential' }, 'calibration.potential'],
    ['an HOD session lights Performance', 'hod', { pm: true, pot: true }, {}, 'calibration.performance'],
    ['an HOD session opened from the Potential list lights Potential', 'hod', { pm: true, pot: true }, { axis: 'potential' }, 'calibration.potential'],
    ['a potential-only session lights Potential', 'bu', { pm: false, pot: true }, {}, 'calibration.potential'],
    ['an axis the session does not calibrate is ignored', 'bu', { pm: true, pot: false }, { axis: 'potential' }, 'calibration.performance'],
  ] as const)('%s', async (_why, tier, axes, search, tab) => {
    state.facts = facts([calibration('bg', 'talent_box', 'both'), calibration('bu', 'calibration', 'performance')]);
    mock.calibration.mockResolvedValue({ session: { tier }, axes });
    expect(await open(AssessmentCalibrationPage as never, '/performance/assessment/calibration/s-1', sessionProps(search))).toBe('rendered');
    expect(screen.getByRole('navigation', { name: area.admin.sections.calibration })).toBeTruthy();
    expect(lit()).toEqual([tab]);
    expect(screen.getByTestId('calibration-session')).toBeTruthy();
  });
  it('the final-bands view of a session keeps the strip', async () => {
    state.facts = facts([calibration('group', 'group_calibration', 'performance')]);
    mock.finalBands.mockResolvedValue({});
    expect(await open(AssessmentCalibrationPage as never, '/performance/assessment/calibration/s-1', sessionProps({ view: 'final-bands' }))).toBe('rendered');
    expect(lit()).toEqual(['calibration.performance']);
    expect(screen.getByTestId('final-bands')).toBeTruthy();
  });
});
