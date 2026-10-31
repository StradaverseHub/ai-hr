/**
 * D-P1-32 PT-X2: which slice of the review workspace each employee/leader tab route renders.
 *
 * A tab route is a thin page over the EXISTING workspace (app/(app)/performance/workspace): it fixes the view and
 * module, and narrows the worklist to the same items its tab gate reads (tab-model.ts), so a tab that shows
 * always has something to open and a route never shows an item its tab would not count. The paths are the
 * registry's hrefs; test/p1-performance-tab-routes.test.ts pins both equalities against the registry.
 *
 * Pure and client-safe: type-only imports, no database, no server code.
 */
import type { PerformanceAreaItem, PerformanceTabId } from './tab-model';
import type { WorkspaceModule, WorkspaceView } from './workspace-model';

export type WorkspaceTabScope = {
  tabId: PerformanceTabId;
  /** The tab's route: the registry href. Links inside the workspace stay on it. */
  path: string;
  view: WorkspaceView;
  module: WorkspaceModule;
  /** Only items in one of these stages; every stage when absent. */
  stages?: readonly string[];
  /** Only items of this kind; every kind when absent. */
  kind?: PerformanceAreaItem['kind'];
};

export const WORKSPACE_TAB_SCOPES = {
  'pm.setting': { tabId: 'pm.setting', path: '/performance/my/kpis', view: 'mine', module: 'pm', stages: ['setting'] },
  'pm.my': { tabId: 'pm.my', path: '/performance/my', view: 'mine', module: 'pm', stages: ['results', 'checkin'] },
  'pm.approve': { tabId: 'pm.approve', path: '/performance/team/kpis', view: 'team', module: 'pm', stages: ['setting'] },
  'pm.team': { tabId: 'pm.team', path: '/performance/team', view: 'team', module: 'pm', stages: ['results', 'moderation', 'checkin'] },
  'feedback.assessments': { tabId: 'feedback.assessments', path: '/performance/assessments', view: 'mine', module: 'tm', kind: 'feedback' },
  'competency.my': { tabId: 'competency.my', path: '/performance/competency', view: 'mine', module: 'tm', stages: ['competency'] },
  'competency.team': { tabId: 'competency.team', path: '/performance/competency/team', view: 'team', module: 'tm', stages: ['competency'] },
  'plan.my': { tabId: 'plan.my', path: '/performance/plan', view: 'mine', module: 'idp' },
  'plan.profile': { tabId: 'plan.profile', path: '/performance/plan/profile', view: 'mine', module: 'idp' },
  'plan.team': { tabId: 'plan.team', path: '/performance/plan/team', view: 'team', module: 'idp' },
} as const satisfies Record<string, WorkspaceTabScope>;
export type WorkspaceTabScopeId = keyof typeof WORKSPACE_TAB_SCOPES;

/** Every workspace tab route. Save actions may return to these (lib/performance-navigation.ts). */
export const WORKSPACE_TAB_PATHS: readonly string[] = Object.values(WORKSPACE_TAB_SCOPES).map(scope => scope.path);

/** Team PM's per-review route, `/performance/team/<reviewId>` (the Team PM tab stays lit on it). */
export const TEAM_REVIEW_PATH = /^\/performance\/team\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ScopedItem = Pick<PerformanceAreaItem, 'kind' | 'view' | 'module' | 'stage'>;
/** Does this worklist item belong to the tab route? The tab gate's own predicate, minus the plan lock. */
export function inWorkspaceTab(item: ScopedItem, scope: WorkspaceTabScope): boolean {
  return item.view === scope.view && item.module === scope.module
    && (!scope.stages || scope.stages.includes(item.stage))
    && (!scope.kind || item.kind === scope.kind);
}
/** The worklist narrowed to one tab route. The workspace resolver then selects inside it. */
export function workspaceTabItems<T extends ScopedItem>(items: readonly T[], scope: WorkspaceTabScope): T[] {
  return items.filter(item => inWorkspaceTab(item, scope));
}
