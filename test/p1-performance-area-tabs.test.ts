/**
 * D-P1-32 PT-X1: the Performance & Talent tab registry (pure).
 *
 * The persona table pins the EXACT tab set (and state) each viewer gets from the worklist items the workspace
 * projection emits for them. Every tab is both shown and hidden somewhere in the table, so no gate can be
 * replaced by a constant without a case going red. Active-tab matching covers the "stays lit" rules.
 */
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
import { defaultPolicy, type KPI, type Tier } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { leaderWorkspaceParts, reviewWorkspaceParts } from '../packs/performance/onehr/workspace-model';
import {
  activePerformanceTab,
  performanceAreaStrip,
  performanceAreaStrips,
  performanceAreaTab,
  performanceTabState,
  PERFORMANCE_AREA_TABS,
  PERFORMANCE_STRIP_LABEL_KEYS,
  type PerformanceAreaFacts,
  type PerformanceAreaItem,
  type PerformanceTabId,
  type PerformanceTabState,
} from '../packs/performance/onehr/tab-model';

const item = (kind: PerformanceAreaItem['kind'], view: PerformanceAreaItem['view'], module: PerformanceAreaItem['module'], stage: string, extra: Partial<PerformanceAreaItem> = {}): PerformanceAreaItem =>
  ({ kind, cycleId: 'cycle-1', view, module, stage, locked: false, ...extra });
const review = (view: PerformanceAreaItem['view'], module: PerformanceAreaItem['module'], stage: string, extra: Partial<PerformanceAreaItem> = {}) => item('review', view, module, stage, extra);
const calibration = (view: PerformanceAreaItem['view'], stage: string, axis: 'performance' | 'potential' | 'both') => item('calibration', view, 'cal', stage, { axis });
const rateColleague = item('feedback', 'mine', 'tm', 'feedback');
const facts = (items: PerformanceAreaItem[], extra: Partial<PerformanceAreaFacts> = {}): PerformanceAreaFacts => ({ performanceOn: true, items, ownFeedbackReport: false, ...extra });

/** Every tab the viewer is offered, across every strip, with its state. */
function offered(f: PerformanceAreaFacts): Partial<Record<PerformanceTabId, PerformanceTabState>> {
  return Object.fromEntries(performanceAreaStrips.flatMap(strip => performanceAreaStrip(f, strip).map(view => [view.id, view.state])));
}

type Persona = { name: string; facts: PerformanceAreaFacts; expected: Partial<Record<PerformanceTabId, PerformanceTabState>> };
const ownResults = review('mine', 'pm', 'results');
const PERSONAS: Persona[] = [
  {
    name: 'employee: results stage, competency, locked own plan, asked to rate a colleague, no report yet',
    facts: facts([ownResults, review('mine', 'tm', 'competency'), review('mine', 'idp', 'career', { locked: true }), rateColleague]),
    expected: { home: 'open', 'pm.my': 'open', 'feedback.assessments': 'open', 'competency.my': 'open', 'plan.my': 'disabled', 'plan.profile': 'disabled' },
  },
  {
    name: 'employee: still setting KPIs (Set my KPIs, not My PM)',
    facts: facts([review('mine', 'pm', 'setting')]),
    expected: { home: 'open', 'pm.setting': 'open' },
  },
  {
    name: 'employee: quarterly check-in with a released report from an earlier cycle',
    facts: facts([review('mine', 'pm', 'checkin')], { ownFeedbackReport: true }),
    expected: { home: 'open', 'pm.my': 'open', 'feedback.feedback': 'open' },
  },
  {
    name: 'line manager: own review, open own plan, team approvals, moderation, competency and plans, own report',
    facts: facts([
      ownResults, review('mine', 'tm', 'competency'), review('mine', 'idp', 'career'),
      review('team', 'pm', 'setting'), review('team', 'pm', 'moderation'), review('team', 'tm', 'competency'), review('team', 'idp', 'career'),
    ], { ownFeedbackReport: true }),
    expected: {
      home: 'open', 'pm.my': 'open', 'pm.approve': 'open', 'pm.team': 'open', 'feedback.feedback': 'open',
      'competency.my': 'open', 'competency.team': 'open', 'plan.my': 'open', 'plan.profile': 'open', 'plan.team': 'open',
    },
  },
  {
    name: 'HOD: own review, a team to moderate, department performance and potential reviews, no own report (DQ-5)',
    facts: facts([ownResults, review('team', 'pm', 'results'), calibration('dept', 'department_review', 'performance'), calibration('dept', 'department_potential_review', 'potential')]),
    expected: { home: 'open', 'pm.my': 'open', 'pm.team': 'open', 'calibration.performance': 'open', 'calibration.potential': 'open' },
  },
  {
    name: 'BU CEO: own review, BU calibration on both axes and the Talent Box, own report',
    facts: facts([ownResults, calibration('bu', 'calibration', 'performance'), calibration('bu', 'potential_calibration', 'potential'), calibration('bu', 'talent_box', 'both')], { ownFeedbackReport: true }),
    expected: { home: 'open', 'pm.my': 'open', 'feedback.feedback': 'open', 'calibration.performance': 'open', 'calibration.potential': 'open', 'calibration.talentBox': 'open' },
  },
  {
    name: 'BG CEO: no own review (dropped), owes a colleague feedback, the BG Talent Box only',
    facts: facts([rateColleague, calibration('bg', 'talent_box', 'both')]),
    expected: { home: 'open', 'feedback.assessments': 'open', 'calibration.talentBox': 'open' },
  },
  {
    name: 'Group Chief: group calibration and the Talent Box; the Calibration strip shows (DQ-7)',
    facts: facts([calibration('group', 'group_calibration', 'performance'), calibration('group', 'talent_box', 'both')]),
    expected: { home: 'open', 'calibration.performance': 'open', 'calibration.talentBox': 'open' },
  },
  {
    name: 'admin with no review of their own: the Dashboard only',
    facts: facts([]),
    expected: { home: 'open' },
  },
  {
    name: 'Performance module off: nothing, whatever the worklist holds',
    facts: facts([ownResults, review('team', 'pm', 'setting'), rateColleague, calibration('bu', 'talent_box', 'both')], { performanceOn: false, ownFeedbackReport: true }),
    expected: {},
  },
];

describe('tab gates per persona (exact tab set)', () => {
  it.each(PERSONAS)('$name', ({ facts: f, expected }) => {
    expect(offered(f)).toEqual(expected);
    for (const entry of PERFORMANCE_AREA_TABS) expect(performanceTabState(f, entry.id)).toBe(expected[entry.id] ?? 'hidden');
  });

  it('the table exercises every gate both ways (each tab is offered to someone and refused to someone)', () => {
    for (const entry of PERFORMANCE_AREA_TABS) {
      const states = PERSONAS.map(p => performanceTabState(p.facts, entry.id));
      expect(states, entry.id).toContain('hidden');
      expect(states.some(state => state !== 'hidden'), entry.id).toBe(true);
    }
  });
});

describe('Talent box is never an HOD tab', () => {
  it('the workspace never raises a Talent Box item for the HOD tier, whatever the modules', () => {
    for (const modules of [{ pm: true, tm: true, idp: true, evidence: false }, { pm: true, tm: false, idp: false, evidence: false }, { pm: false, tm: true, idp: false, evidence: false }]) {
      const policy = { ...defaultPolicy(framework), modules };
      const stages = leaderWorkspaceParts(policy, 'hod', { lockedAt: null, performanceLockedAt: null, potentialLockedAt: null }).map(part => part.stage);
      expect(stages).not.toContain('talent_box');
    }
  });
  it('an HOD department view carrying a talent_box item is still refused', () => {
    const hod = facts([calibration('dept', 'department_review', 'performance'), calibration('dept', 'talent_box', 'both')]);
    expect(performanceTabState(hod, 'calibration.talentBox')).toBe('hidden');
    expect(performanceAreaStrip(hod, 'calibration').map(view => view.id)).toEqual(['calibration.performance']);
  });
  it('an HOD who also holds a BU seat gets it through the BU item', () => {
    expect(performanceTabState(facts([calibration('dept', 'department_review', 'performance'), calibration('bu', 'talent_box', 'both')]), 'calibration.talentBox')).toBe('open');
  });
});

describe('Career Plan lock (wave 2 rule)', () => {
  it('disables My plan and Career profile only while every own plan item is locked', () => {
    const locked = facts([review('mine', 'idp', 'career', { locked: true })]);
    expect(performanceAreaStrip(locked, 'plan')).toEqual([{ id: 'plan.my', state: 'disabled' }, { id: 'plan.profile', state: 'disabled' }]);
    const mixed = facts([review('mine', 'idp', 'career', { locked: true }), review('mine', 'idp', 'career', { locked: false, cycleId: 'cycle-2' })]);
    expect(performanceAreaStrip(mixed, 'plan')).toEqual([{ id: 'plan.my', state: 'open' }, { id: 'plan.profile', state: 'open' }]);
  });
  it('a team plan stays open beside a locked own plan', () => {
    const f = facts([review('mine', 'idp', 'career', { locked: true }), review('team', 'idp', 'career')]);
    expect(performanceAreaStrip(f, 'plan')).toEqual([{ id: 'plan.my', state: 'disabled' }, { id: 'plan.profile', state: 'disabled' }, { id: 'plan.team', state: 'open' }]);
  });
  it('an unknown tab id is hidden', () => {
    expect(performanceTabState(facts([ownResults]), 'pm.everything')).toBe('hidden');
  });
});

describe('the gates read the words the workspace actually emits', () => {
  const policy = defaultPolicy(framework);
  const approved = { id: 'k', hrOwned: false, setting: 'approved', moderatorEmploymentId: 'manager', approvalChain: [{ employmentId: 'manager', actual: null, remark: '', at: null }], locked: false } as KPI;
  const base = { kpis: [approved], competenciesAssigned: true, competencyStatus: 'pending', resultsSubmitted: false, managerPerformance: null, planStatus: null };
  const toItems = (view: 'mine' | 'team', parts: ReturnType<typeof reviewWorkspaceParts>) => parts.map(part => review(view, part.module, part.stage, { locked: part.locked }));
  it('an employee and their manager in the results stage get My PM, competency and plan tabs', () => {
    const mine = toItems('mine', reviewWorkspaceParts(policy, base, { self: true, manager: false, employmentIds: ['employee'] }));
    const team = toItems('team', reviewWorkspaceParts(policy, { ...base, resultsSubmitted: true }, { self: false, manager: true, employmentIds: ['manager'] }));
    expect(offered(facts(mine))).toEqual({ home: 'open', 'pm.my': 'open', 'competency.my': 'open', 'plan.my': 'disabled', 'plan.profile': 'disabled' });
    expect(offered(facts(team))).toEqual({ home: 'open', 'pm.team': 'open', 'competency.team': 'open', 'plan.team': 'open' });
  });
  it('KPI setting raises Set my KPIs for the employee and Approve KPIs for the approver', () => {
    const proposed = { ...approved, setting: 'proposed' } as KPI;
    const mine = toItems('mine', reviewWorkspaceParts(policy, { ...base, kpis: [{ ...approved, setting: 'draft' } as KPI] }, { self: true, manager: false, employmentIds: ['employee'] }));
    const team = toItems('team', reviewWorkspaceParts(policy, { ...base, kpis: [proposed] }, { self: false, manager: true, employmentIds: ['manager'] }));
    expect(performanceTabState(facts(mine), 'pm.setting')).toBe('open');
    expect(performanceTabState(facts(mine), 'pm.my')).toBe('hidden');
    expect(performanceTabState(facts(team), 'pm.approve')).toBe('open');
    expect(performanceTabState(facts(team), 'pm.team')).toBe('hidden');
  });
  it.each<[Tier, PerformanceTabId[]]>([
    ['hod', ['calibration.performance', 'calibration.potential']],
    ['bu', ['calibration.performance', 'calibration.potential', 'calibration.talentBox']],
    ['bg', ['calibration.talentBox']],
    ['group', ['calibration.performance', 'calibration.talentBox']],
  ])('the %s tier calibration items give the strip %j', (tier, expected) => {
    const view = (tier === 'hod' ? 'dept' : tier) as PerformanceAreaItem['view'];
    const parts = leaderWorkspaceParts(policy, tier, { lockedAt: null, performanceLockedAt: null, potentialLockedAt: null });
    const f = facts(parts.map(part => calibration(view, part.stage, part.axis)));
    expect(performanceAreaStrip(f, 'calibration').map(v => v.id)).toEqual(expected);
  });
});

describe('active tab ("stays lit")', () => {
  it.each<[Parameters<typeof activePerformanceTab>[0], string, string | null, PerformanceTabId | null]>([
    ['pm', '/performance/team', null, 'pm.team'],
    ['pm', '/performance/team/8b0f8f3e-0d5e-4e57-9d62-5a0f3c1d2b11', null, 'pm.team'],
    ['pm', '/performance/team/kpis', null, 'pm.approve'],
    ['pm', '/performance/my', null, 'pm.my'],
    ['pm', '/performance/my/', null, 'pm.my'],
    ['pm', '/performance/my/kpis', null, 'pm.setting'],
    ['pm', '/performance/teamwork', null, null],
    ['pm', '/performance/workspace', 'module=pm', null],
    ['feedback', '/performance/assessments', null, 'feedback.assessments'],
    ['feedback', '/performance/feedback/report', null, 'feedback.feedback'],
    ['competency', '/performance/competency', null, 'competency.my'],
    ['competency', '/performance/competency/team/x', null, 'competency.team'],
    ['plan', '/performance/plan', null, 'plan.my'],
    ['plan', '/performance/plan/profile', null, 'plan.profile'],
    ['plan', '/performance/plan/team/x', null, 'plan.team'],
    ['calibration', '/performance/calibration', null, 'calibration.performance'],
    ['calibration', '/performance/calibration', 'axis=performance', 'calibration.performance'],
    ['calibration', '/performance/calibration', 'axis=potential', 'calibration.potential'],
    ['calibration', '/performance/calibration', 'axis=other', 'calibration.performance'],
    ['calibration', '/performance/calibration/talent-box', null, 'calibration.talentBox'],
    ['calibration', '/performance/calibration/talent-box/s1', 'axis=potential', 'calibration.talentBox'],
    ['home', '/performance/home', null, 'home'],
    ['home', '/performance', null, null],
  ])('%s strip at %s?%s lights %s', (strip, path, search, expected) => {
    expect(activePerformanceTab(strip, path, search)).toBe(expected);
  });
  it('every tab lights itself at its own href, and only its own strip', () => {
    for (const entry of PERFORMANCE_AREA_TABS) {
      const [path, search] = entry.href.split('?');
      expect(activePerformanceTab(entry.strip, path, search ?? null), entry.id).toBe(entry.id);
      for (const strip of performanceAreaStrips) if (strip !== entry.strip) expect(activePerformanceTab(strip, path, search ?? null), `${entry.id} in ${strip}`).not.toBe(entry.id);
    }
  });
});

describe('labels (APR-023) in all six locales', () => {
  const locales = { en, ms, ta, th, vi: viMessages, zh } as Record<string, Record<string, unknown>>;
  const at = (messages: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages.performanceArea);
  const flat = (node: unknown, prefix = ''): string[] => typeof node === 'object' && node ? Object.entries(node).flatMap(([k, v]) => flat(v, prefix ? `${prefix}.${k}` : k)) : [prefix];
  it('every registry tab and strip has a non-empty label in every locale', () => {
    const keys = [...PERFORMANCE_AREA_TABS.map(entry => entry.labelKey), ...Object.values(PERFORMANCE_STRIP_LABEL_KEYS)];
    expect(keys.length).toBe(PERFORMANCE_AREA_TABS.length + performanceAreaStrips.length);
    for (const [locale, messages] of Object.entries(locales)) for (const key of keys) {
      const value = at(messages, key);
      expect(typeof value === 'string' && value.trim().length > 0, `${locale} performanceArea.${key}`).toBe(true);
    }
  });
  it('the namespace is key-identical across the six locales', () => {
    const enKeys = flat(en.performanceArea).sort();
    expect(enKeys.length).toBeGreaterThan(150);
    for (const [locale, messages] of Object.entries(locales)) expect(flat(messages.performanceArea).sort(), locale).toEqual(enKeys);
  });
  it('the tab labels are the approved words', () => {
    const words = Object.fromEntries(PERFORMANCE_AREA_TABS.map(entry => [entry.id, at(en as Record<string, unknown>, entry.labelKey)]));
    expect(words).toEqual({
      home: 'Dashboard', 'pm.setting': 'Set my KPIs', 'pm.my': 'My PM', 'pm.approve': 'Approve KPIs', 'pm.team': 'Team PM',
      'feedback.assessments': 'My Assessments', 'feedback.feedback': 'Feedback', 'competency.my': 'My assessment', 'competency.team': 'Team view',
      'plan.my': 'My plan', 'plan.profile': 'Career profile', 'plan.team': 'My team',
      'calibration.performance': 'Performance', 'calibration.potential': 'Potential', 'calibration.talentBox': 'Talent box',
    });
  });
  it('registry ids are unique and resolve', () => {
    expect(new Set(PERFORMANCE_AREA_TABS.map(entry => entry.id)).size).toBe(PERFORMANCE_AREA_TABS.length);
    for (const entry of PERFORMANCE_AREA_TABS) expect(performanceAreaTab(entry.id)).toBe(entry);
  });
});
