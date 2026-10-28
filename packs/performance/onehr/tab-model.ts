/**
 * D-P1-32 PT-X1: the Performance & Talent area's tab strips. ONE registry.
 *
 * Every strip in the area (Dashboard, PM, Feedback, Competency, Career Plan, Calibration) is listed here once,
 * with its route, its label key (under the `performanceArea` messages namespace) and its gate. The source keeps
 * a single list for the same reason: a second copy of a tab list drifts.
 *
 * A gate is a predicate over ONE set of facts, built once per request by getPerformanceAreaFacts
 * (tab-service.ts) from the workspace projection (performanceWorkspaceTx) the tab routes themselves resolve,
 * so a visible tab and its route cannot disagree. The route pages refuse a crafted URL for a hidden tab
 * through performanceTabAccess, which reads the same gate.
 *
 * Pure and client-safe: type-only imports, no database, no server code. The strip component reads it for the
 * hrefs, labels and active-tab matching.
 */
import type { WorkspaceAxis, WorkspaceModule, WorkspaceView } from './workspace-model';

/** The workspace item fields a gate reads (a projection of PerformanceWorkspaceItem). */
export type PerformanceAreaItem = {
  kind: 'review' | 'feedback' | 'calibration';
  cycleId: string;
  view: WorkspaceView;
  module: WorkspaceModule;
  stage: string;
  axis?: WorkspaceAxis;
  locked: boolean;
};
/** Everything a gate may read. Built by getPerformanceAreaFacts; tests build it directly. */
export type PerformanceAreaFacts = {
  /** The Performance module is on for the viewer. Every tab is hidden without it. */
  performanceOn: boolean;
  /** The viewer's open-cycle worklist (performanceWorkspaceTx), optionally narrowed to one cycle. */
  items: readonly PerformanceAreaItem[];
  /** The viewer holds a released 360 report of their own (any cycle). */
  ownFeedbackReport: boolean;
};
/** 'disabled' is drawn but not a link: the wave 2 Career Plan lock. */
export type PerformanceTabState = 'open' | 'disabled' | 'hidden';

export const performanceAreaStrips = ['home', 'pm', 'feedback', 'competency', 'plan', 'calibration'] as const;
export type PerformanceAreaStrip = (typeof performanceAreaStrips)[number];

/**
 * One way a tab is lit. `prefix` also lights every path below (`/performance/team/<id>` lights Team PM).
 * `query` must match exactly. Among the matching rules of a strip the most specific wins: the longer path,
 * then a query match, then an exact path.
 */
export type PerformanceTabMatch = { path: string; prefix?: boolean; query?: Readonly<Record<string, string>> };
export type PerformanceAreaTab = {
  id: string;
  strip: PerformanceAreaStrip;
  /** Relative to the `performanceArea` namespace. */
  labelKey: string;
  href: string;
  match: readonly PerformanceTabMatch[];
  gate: (facts: PerformanceAreaFacts) => PerformanceTabState;
};

type Item = PerformanceAreaItem;
const holds = (facts: PerformanceAreaFacts, wanted: (item: Item) => boolean): PerformanceTabState =>
  facts.items.some(wanted) ? 'open' : 'hidden';
/** The wave 2 rule (workspaceNavigationOffer): a plan tab is disabled only when every plan item held is locked. */
const plan = (facts: PerformanceAreaFacts, view: WorkspaceView): PerformanceTabState => {
  const held = facts.items.filter(item => item.module === 'idp' && item.view === view);
  return !held.length ? 'hidden' : held.some(item => !item.locked) ? 'open' : 'disabled';
};
const pm = (view: WorkspaceView, stages: readonly string[]) => (facts: PerformanceAreaFacts) =>
  holds(facts, item => item.view === view && item.module === 'pm' && stages.includes(item.stage));
const competency = (view: WorkspaceView) => (facts: PerformanceAreaFacts) =>
  holds(facts, item => item.view === view && item.module === 'tm' && item.stage === 'competency');
const axis = (wanted: 'performance' | 'potential') => (facts: PerformanceAreaFacts) =>
  holds(facts, item => item.module === 'cal' && item.axis === wanted);

function tab<const Id extends string>(
  id: Id,
  strip: PerformanceAreaStrip,
  labelKey: string,
  href: string,
  match: readonly PerformanceTabMatch[],
  gate: PerformanceAreaTab['gate'],
): PerformanceAreaTab & { id: Id } {
  return { id, strip, labelKey, href, match, gate: facts => (facts.performanceOn ? gate(facts) : 'hidden') };
}

/**
 * The registry, in drawing order. Gates follow the D-P1-32 tab inventory:
 * - Talent box: a talent_box calibration item, which leaderWorkspaceParts raises only for the BU, BG and Group
 *   tiers; an HOD's department view (`dept`) is excluded again here so an HOD can never be offered it.
 * - Feedback: the viewer's own released report only. A manager or HOD without one gets no Feedback tab (DQ-5).
 * - Calibration: a Group Chief holds group_calibration and talent_box items, so sees the strip (DQ-7, a recorded
 *   deviation from the source, which drew no strip for that tier).
 * - Career Plan: disabled while every plan item held is locked (wave 2).
 */
export const PERFORMANCE_AREA_TABS = [
  tab('home', 'home', 'tabs.home', '/performance/home', [{ path: '/performance/home' }], () => 'open'),

  tab('pm.setting', 'pm', 'tabs.pm.setting', '/performance/my/kpis', [{ path: '/performance/my/kpis' }], pm('mine', ['setting'])),
  tab('pm.my', 'pm', 'tabs.pm.my', '/performance/my', [{ path: '/performance/my' }], pm('mine', ['results', 'checkin'])),
  tab('pm.approve', 'pm', 'tabs.pm.approve', '/performance/team/kpis', [{ path: '/performance/team/kpis', prefix: true }], pm('team', ['setting'])),
  tab('pm.team', 'pm', 'tabs.pm.team', '/performance/team', [{ path: '/performance/team', prefix: true }], pm('team', ['results', 'moderation', 'checkin'])),

  tab('feedback.assessments', 'feedback', 'tabs.f360.assessments', '/performance/assessments', [{ path: '/performance/assessments' }],
    facts => holds(facts, item => item.kind === 'feedback')),
  tab('feedback.feedback', 'feedback', 'tabs.f360.feedback', '/performance/feedback', [{ path: '/performance/feedback', prefix: true }],
    facts => (facts.ownFeedbackReport ? 'open' : 'hidden')),

  tab('competency.my', 'competency', 'tabs.competency.my', '/performance/competency', [{ path: '/performance/competency' }], competency('mine')),
  tab('competency.team', 'competency', 'tabs.competency.team', '/performance/competency/team', [{ path: '/performance/competency/team', prefix: true }], competency('team')),

  tab('plan.my', 'plan', 'tabs.idp.my', '/performance/plan', [{ path: '/performance/plan' }], facts => plan(facts, 'mine')),
  tab('plan.profile', 'plan', 'tabs.idp.career', '/performance/plan/profile', [{ path: '/performance/plan/profile' }], facts => plan(facts, 'mine')),
  tab('plan.team', 'plan', 'tabs.idp.team', '/performance/plan/team', [{ path: '/performance/plan/team', prefix: true }], facts => plan(facts, 'team')),

  tab('calibration.performance', 'calibration', 'tabs.cal.performance', '/performance/calibration?axis=performance',
    [{ path: '/performance/calibration', query: { axis: 'performance' } }, { path: '/performance/calibration' }], axis('performance')),
  tab('calibration.potential', 'calibration', 'tabs.cal.potential', '/performance/calibration?axis=potential',
    [{ path: '/performance/calibration', query: { axis: 'potential' } }], axis('potential')),
  tab('calibration.talentBox', 'calibration', 'tabs.cal.talentBox', '/performance/calibration/talent-box',
    [{ path: '/performance/calibration/talent-box', prefix: true }],
    facts => holds(facts, item => item.module === 'cal' && item.stage === 'talent_box' && item.view !== 'dept')),
] as const;

export type PerformanceTabId = (typeof PERFORMANCE_AREA_TABS)[number]['id'];
/** A tab as the strip draws it: only tabs whose gate is not 'hidden'. */
export type PerformanceTabView = { id: PerformanceTabId; state: Exclude<PerformanceTabState, 'hidden'> };

/** The accessible name of each strip's nav, reusing the area's own section labels (no new wording). */
export const PERFORMANCE_STRIP_LABEL_KEYS: Readonly<Record<PerformanceAreaStrip, string>> = {
  home: 'tabs.home',
  pm: 'admin.sections.pm',
  feedback: 'admin.sections.f360',
  competency: 'admin.sections.competency',
  plan: 'admin.sections.idp',
  calibration: 'admin.sections.calibration',
};

const byId: ReadonlyMap<string, PerformanceAreaTab> = new Map<string, PerformanceAreaTab>(PERFORMANCE_AREA_TABS.map(entry => [entry.id, entry]));

export function performanceAreaTab(id: string): PerformanceAreaTab | undefined {
  return byId.get(id);
}
/** One tab's gate. An unknown id is hidden. */
export function performanceTabState(facts: PerformanceAreaFacts, id: string): PerformanceTabState {
  return byId.get(id)?.gate(facts) ?? 'hidden';
}
/** The tabs of one strip that the viewer may see, in registry order. */
export function performanceAreaStrip(facts: PerformanceAreaFacts, strip: PerformanceAreaStrip): PerformanceTabView[] {
  const out: PerformanceTabView[] = [];
  for (const entry of PERFORMANCE_AREA_TABS) {
    if (entry.strip !== strip) continue;
    const state = entry.gate(facts);
    if (state !== 'hidden') out.push({ id: entry.id, state });
  }
  return out;
}

function normalisePath(pathname: string) {
  const path = pathname.split(/[?#]/)[0] || '/';
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}
function matchScore(rule: PerformanceTabMatch, path: string, query: URLSearchParams) {
  const exact = path === rule.path;
  if (!exact && !(rule.prefix && path.startsWith(`${rule.path}/`))) return -1;
  if (rule.query && !Object.entries(rule.query).every(([key, value]) => query.get(key) === value)) return -1;
  return rule.path.length * 4 + (rule.query ? 2 : 0) + (exact ? 1 : 0);
}
/**
 * Which tab of a strip is lit for a location. Matched across the WHOLE strip, not only the tabs drawn, so a
 * hidden tab's path never lights a neighbour (/performance/team/kpis never lights Team PM). Null when none.
 */
export function activePerformanceTab(
  strip: PerformanceAreaStrip,
  pathname: string,
  search?: URLSearchParams | string | null,
): PerformanceTabId | null {
  const path = normalisePath(pathname);
  const query = new URLSearchParams(typeof search === 'string' ? search : search?.toString() ?? '');
  let best: PerformanceTabId | null = null;
  let score = -1;
  for (const entry of PERFORMANCE_AREA_TABS) {
    if (entry.strip !== strip) continue;
    for (const rule of entry.match) {
      const s = matchScore(rule, path, query);
      if (s > score) { score = s; best = entry.id; }
    }
  }
  return best;
}
