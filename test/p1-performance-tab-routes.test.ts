/**
 * D-P1-32 PT-X2: the employee/leader tab routes (pure contracts).
 *
 * - Each workspace tab route narrows the worklist by EXACTLY its tab's gate (tab-model.ts), checked over every
 *   item shape the workspace emits: a route can never hold an item its tab would not count, and a tab that
 *   shows always has an item its route opens.
 * - Every route path is the registry href; the registry tabs without a workspace route are exactly the ones
 *   other pages own (Dashboard: PT-X3; Feedback; the Calibration lists and Talent box: PT-TB).
 * - Saves may return to every tab route and Team PM's per-review route, and still to nothing else.
 * - The Calibration per-axis lists follow the Performance / Potential gates, BG on both (DQ-8).
 * - SCREENS registers exactly the new route folders, after onehrAssignments, and each has the shared loading shell.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPolicy, type Tier } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { performanceAreaTab, performanceTabState, PERFORMANCE_AREA_TABS, type PerformanceAreaItem } from '../packs/performance/onehr/tab-model';
import { inWorkspaceTab, TEAM_REVIEW_PATH, WORKSPACE_TAB_PATHS, WORKSPACE_TAB_SCOPES, workspaceTabItems } from '../packs/performance/onehr/tab-route-model';
import { calibrationSessionAxes, calibrationSessionsForAxis } from '../packs/performance/onehr/calibration-list-model';
import { assessmentReturnPath } from '../lib/performance-navigation';
import { SCREENS } from '../lib/permissions';

const item = (kind: PerformanceAreaItem['kind'], view: PerformanceAreaItem['view'], module: PerformanceAreaItem['module'], stage: string): PerformanceAreaItem => ({ kind, cycleId: 'c', view, module, stage, locked: false });
/**
 * Every item shape the workspace projection emits (service.ts reviewWorkspaceItemsTx / feedbackWorkspaceItemsTx /
 * calibrationWorkspaceItemsTx over workspace-model's parts), unlocked: reviews are mine or team with the PM, TM
 * and IDP stages; a 360 request is always mine/tm/feedback; a calibration part sits in a leader view.
 */
const ALL_ITEMS: PerformanceAreaItem[] = [
  ...(['mine', 'team'] as const).flatMap(view => [
    ...['setting', 'results', 'moderation', 'checkin'].map(stage => item('review', view, 'pm', stage)),
    item('review', view, 'tm', 'competency'), item('review', view, 'idp', 'career'),
  ]),
  item('feedback', 'mine', 'tm', 'feedback'),
  ...(['dept', 'bu', 'bg', 'group'] as const).flatMap(view => ['department_review', 'department_potential_review', 'calibration', 'potential_calibration', 'talent_box', 'group_calibration'].map(stage => item('calibration', view, 'cal', stage))),
];
const scopes = Object.values(WORKSPACE_TAB_SCOPES);

describe('a workspace tab route holds exactly the items its tab gate counts', () => {
  it.each(scopes)('$tabId → $path', scope => {
    const counted = ALL_ITEMS.filter(entry => performanceTabState({ performanceOn: true, ownFeedbackReport: 'none', items: [entry] }, scope.tabId) !== 'hidden');
    const routed = workspaceTabItems(ALL_ITEMS, scope);
    expect(counted.length).toBeGreaterThan(0);
    expect(routed.length).toBeLessThan(ALL_ITEMS.length);
    expect(routed).toEqual(counted);
  });
  it('a locked plan item stays in its route (the resolver shows it locked) while the tab is disabled', () => {
    const locked: PerformanceAreaItem = { kind: 'review', cycleId: 'c', view: 'mine', module: 'idp', stage: 'career', locked: true };
    expect(inWorkspaceTab(locked, WORKSPACE_TAB_SCOPES['plan.my'])).toBe(true);
    expect(performanceTabState({ performanceOn: true, ownFeedbackReport: 'none', items: [locked] }, 'plan.my')).toBe('disabled');
  });
  it('Set my KPIs and My PM split the own PM items by stage; Approve KPIs and Team PM split the team ones', () => {
    const at = (view: 'mine' | 'team', stage: string): PerformanceAreaItem => ({ kind: 'review', cycleId: 'c', view, module: 'pm', stage, locked: false });
    expect(['setting', 'results', 'checkin'].map(stage => [inWorkspaceTab(at('mine', stage), WORKSPACE_TAB_SCOPES['pm.setting']), inWorkspaceTab(at('mine', stage), WORKSPACE_TAB_SCOPES['pm.my'])]))
      .toEqual([[true, false], [false, true], [false, true]]);
    expect(['setting', 'moderation', 'results'].map(stage => [inWorkspaceTab(at('team', stage), WORKSPACE_TAB_SCOPES['pm.approve']), inWorkspaceTab(at('team', stage), WORKSPACE_TAB_SCOPES['pm.team'])]))
      .toEqual([[true, false], [false, true], [false, true]]);
  });
});

describe('the routes are the registry', () => {
  it.each(scopes)('$tabId path is its tab href', scope => {
    expect(performanceAreaTab(scope.tabId)?.href).toBe(scope.path);
  });
  it('the registry tabs without a workspace route are exactly the ones other pages render', () => {
    const routed = new Set<string>(scopes.map(scope => scope.tabId));
    expect(PERFORMANCE_AREA_TABS.map(tab => tab.id).filter(id => !routed.has(id)))
      .toEqual(['home', 'feedback.feedback', 'calibration.performance', 'calibration.potential', 'calibration.talentBox']);
  });
});

describe('save actions return to the tab the user came from', () => {
  const fallback = '/performance/review/fallback';
  const id = '0f9b4c1e-2d3a-4b5c-8d7e-6f5a4b3c2d1e';
  it.each(WORKSPACE_TAB_PATHS)('%s keeps its route and the scalar selectors', route => {
    expect(assessmentReturnPath(`${route}?cycle=c1&review=r1&unsafe=x`, fallback)).toBe(`${route}?cycle=c1&review=r1`);
  });
  it('Team PM per-review route returns to itself', () => {
    expect(assessmentReturnPath(`/performance/team/${id}?`, fallback)).toBe(`/performance/team/${id}?`);
    expect(TEAM_REVIEW_PATH.test(`/performance/team/${id}`)).toBe(true);
  });
  it('the old workspace contract is unchanged', () => {
    for (const value of ['https://example.com', '//example.com', '/performance/workspace/../outside', '/performance/workspace.evil?review=a', '/performance/workspace']) expect(assessmentReturnPath(value, fallback)).toBe(fallback);
    expect(assessmentReturnPath('/performance/workspace?view=team&module=pm&review=abc&unsafe=yes', fallback)).toBe('/performance/workspace?view=team&module=pm&review=abc');
  });
  it('the standalone Talent Box returns to the same session, keeping only its session selector', () => {
    expect(assessmentReturnPath(`/performance/calibration/talent-box?session=s-1&axis=performance&review=r1&unsafe=x`, fallback)).toBe('/performance/calibration/talent-box?session=s-1');
    for (const value of ['/performance/calibration/talent-box', '/performance/calibration/talent-box/x?session=s-1', '/performance/calibration/talent-boxx?session=s-1']) expect(assessmentReturnPath(value, fallback), value).toBe(fallback);
  });
  it('nothing else is accepted', () => {
    for (const value of [
      '/performance/my', // no query: the same rule as the workspace
      '/performance/myx?review=a', '/performance/my/../workspace?review=a', '/performance/my/kpis/extra?review=a',
      '/performance/team/not-a-review?review=a', `/performance/team/${id}/x?`, '/performance/calibration?axis=performance',
      '/performance/feedback?record=current', '/performance/home?', '/\\example.com/performance/my?', 42, null,
    ]) expect(assessmentReturnPath(value, fallback), String(value)).toBe(fallback);
  });
});

describe('Calibration per-axis lists', () => {
  const policy = defaultPolicy(framework);
  const unlocked = { lockedAt: null, performanceLockedAt: null, potentialLockedAt: null };
  const axesOf = (tier: Tier, p = policy) => calibrationSessionAxes(p, tier, unlocked);
  it('a session calibrates the axes of its workspace parts', () => {
    expect(policy.kind).toBe('year_end');
    expect(axesOf('hod')).toEqual(['performance', 'potential']);
    expect(axesOf('bu')).toEqual(['performance', 'potential', 'both']);
    expect(axesOf('bg')).toEqual(['both']);
    expect(axesOf('group')).toEqual(['performance', 'both']);
    expect(axesOf('hod', { ...policy, kind: 'mid_year' })).toEqual([]);
    expect(axesOf('bu', { ...policy, modules: { ...policy.modules, tm: false } })).toEqual(['performance']);
  });
  const viewOf = (tier: Tier) => (tier === 'hod' ? 'dept' : tier === 'final' ? 'group' : tier) as PerformanceAreaItem['view'];
  it.each(['hod', 'bu', 'bg', 'group', 'final'] as Tier[])('%s session: on an axis list exactly when its items open that tab', tier => {
    const axes = axesOf(tier);
    const session = { tier, axes };
    const items: PerformanceAreaItem[] = axes.map(axis => ({ kind: 'calibration', cycleId: 'c', view: viewOf(tier), module: 'cal', stage: 'x', axis, locked: false }));
    for (const axis of ['performance', 'potential'] as const) {
      const gate = performanceTabState({ performanceOn: true, ownFeedbackReport: 'none', items }, `calibration.${axis}`) === 'open';
      expect(calibrationSessionsForAxis([session], axis).length === 1, `${tier} ${axis}`).toBe(gate);
    }
  });
  it('BG is on both lists (DQ-8); a Group Talent Box alone puts nothing on Potential', () => {
    const sessions = [{ id: 'bg', tier: 'bg' as Tier, axes: axesOf('bg') }, { id: 'group', tier: 'group' as Tier, axes: axesOf('group') }, { id: 'bu', tier: 'bu' as Tier, axes: ['both' as const] }];
    expect(calibrationSessionsForAxis(sessions, 'performance').map(s => s.id)).toEqual(['bg', 'group']);
    expect(calibrationSessionsForAxis(sessions, 'potential').map(s => s.id)).toEqual(['bg']);
  });
});

describe('function access and loading shells', () => {
  const NEW_ROUTES = ['/performance/my', '/performance/my/kpis', '/performance/team', '/performance/team/kpis', '/performance/team/[reviewId]', '/performance/assessments', '/performance/feedback', '/performance/competency', '/performance/competency/team', '/performance/plan', '/performance/plan/profile', '/performance/plan/team'];
  it('one performanceTabs entry, right after onehrAssignments, scopedSession, exactly the new routes', () => {
    const at = SCREENS.findIndex(screen => screen.screenKey === 'onehrAssignments');
    expect(SCREENS[at + 1]).toMatchObject({ screenKey: 'performanceTabs', guard: 'scopedSession' });
    expect([...SCREENS[at + 1].routes].sort()).toEqual([...NEW_ROUTES].sort());
    expect(SCREENS.filter(screen => screen.routes.some(route => NEW_ROUTES.includes(route))).map(screen => screen.screenKey)).toEqual(['performanceTabs']);
  });
  it.each(NEW_ROUTES)('%s has a page with the module and session guards and the shared loading shell', route => {
    const dir = path.join(process.cwd(), 'app', route);
    const page = fs.readFileSync(path.join(dir, 'page.tsx'), 'utf8');
    expect(page).toMatch(/await requireModule\('performance'\)/);
    expect(page).toMatch(/await scopedSession\(\)/);
    expect(page).toMatch(/workspaceTabRoute\(s,|performanceTabAccess\(s,/);
    expect(fs.readFileSync(path.join(dir, 'loading.tsx'), 'utf8').trim()).toBe("export { default } from '@/components/route-loading';");
  });
  it('the home and Talent Box routes are their own packages\' pages, outside performanceTabs', () => {
    // PT-X3 and PT-TB landed them with their own guards and SCREENS entries (performanceHome, onehrAssignments).
    for (const route of ['home', 'calibration/talent-box']) {
      const page = fs.readFileSync(path.join(process.cwd(), 'app/(app)/performance', route, 'page.tsx'), 'utf8');
      expect(page, route).toMatch(/await requireModule\('performance'\)/);
      expect(SCREENS.find(screen => screen.screenKey === 'performanceTabs')!.routes, route).not.toContain(`/performance/${route}`);
    }
  });
});
