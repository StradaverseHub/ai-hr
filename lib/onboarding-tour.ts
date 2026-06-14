/**
 * Tour registry (ADR-0018, extended for per-guide walkthroughs).
 *
 * The shell "welcome" tour orients a first-time user. Each module also has its own walkthrough that a
 * Knowledge Base guide can launch (ADR-0017) — these navigate to the module (`route`) and spotlight the
 * real controls there. Steps are data: a `data-tour` anchor (or null for a centered card), i18n keys, a
 * placement, an optional role filter, and an optional `route` to navigate to before the step shows.
 * The server resolves each tour for the caller's roles and hands the set to the client tour component.
 */
export type TourPlacement = 'center' | 'top' | 'bottom' | 'left' | 'right';

export type TourStep = {
  id: string;
  /** CSS selector for the anchor element, or null for a centered card. */
  target: string | null;
  titleKey: string;
  bodyKey: string;
  placement: TourPlacement;
  /** If set, the step shows only when the user holds one of these roles. */
  roles?: string[];
  /** If set, navigate here before showing this step (cross-page walkthroughs). */
  route?: string;
};

export type Tour = { id: string; steps: TourStep[] };

export const WELCOME_TOUR_ID = 'welcome';

const MANAGER_UP = ['manager', 'hr_admin', 'super_admin'];
const ADMIN = ['hr_admin', 'super_admin'];

const WELCOME_STEPS: TourStep[] = [
  { id: 'welcome', target: null, titleKey: 'welcomeTitle', bodyKey: 'welcomeBody', placement: 'center' },
  { id: 'nav', target: '[data-tour="nav"]', titleKey: 'navTitle', bodyKey: 'navBody', placement: 'right' },
  { id: 'workspace', target: '[data-tour="nav-me"]', titleKey: 'workspaceTitle', bodyKey: 'workspaceBody', placement: 'right' },
  { id: 'knowledgeBase', target: '[data-tour="nav-knowledge-base"]', titleKey: 'kbTitle', bodyKey: 'kbBody', placement: 'right' },
  { id: 'approvals', target: '[data-tour="nav-approvals"]', titleKey: 'approvalsTitle', bodyKey: 'approvalsBody', placement: 'right', roles: MANAGER_UP },
  { id: 'admin', target: '[data-tour="nav-admin"]', titleKey: 'adminTitle', bodyKey: 'adminBody', placement: 'right', roles: ADMIN },
  { id: 'language', target: '[data-tour="language"]', titleKey: 'languageTitle', bodyKey: 'languageBody', placement: 'bottom' },
  { id: 'theme', target: '[data-tour="theme"]', titleKey: 'themeTitle', bodyKey: 'themeBody', placement: 'bottom' },
  { id: 'finish', target: null, titleKey: 'finishTitle', bodyKey: 'finishBody', placement: 'center' },
];

// Module walkthroughs are generated from the real pages (anchors + steps) into module-tours.json by
// scripts/merge-guide-tours.mjs; their step text lives under the `onboarding.tour.*` i18n keys.
import moduleTours from './module-tours.json';

export const TOURS: Record<string, Tour> = {
  [WELCOME_TOUR_ID]: { id: WELCOME_TOUR_ID, steps: WELCOME_STEPS },
  ...(moduleTours as Record<string, Tour>),
};

/** Steps for one tour, filtered to the caller's roles. */
export function tourSteps(tourId: string, roles: string[] | undefined): TourStep[] {
  const have = new Set(roles ?? []);
  const tour = TOURS[tourId];
  if (!tour) return [];
  return tour.steps.filter((s) => !s.roles || s.roles.some((r) => have.has(r)));
}

/** All tours, each role-filtered — the bundle handed to the client tour component. */
export function toursForRoles(roles: string[] | undefined): Record<string, TourStep[]> {
  const out: Record<string, TourStep[]> = {};
  for (const id of Object.keys(TOURS)) {
    const steps = tourSteps(id, roles);
    if (steps.length) out[id] = steps;
  }
  return out;
}

/** Which walkthrough a Knowledge Base guide launches (by seeded guide slug). */
const GUIDE_TOUR: Record<string, string> = {
  'getting-started-admin': 'people',
  'admin-people-org': 'people',
  'admin-leave-attendance': 'leave',
  'admin-payroll-statutory': 'payroll',
  'admin-compliance-reporting': 'payroll',
  'admin-performance': 'performance',
  'admin-users-roles-audit': 'admin',
  'manager-overview': 'welcome',
  'manager-approvals': 'approvals',
  'manager-team-org': 'org',
  'manager-performance': 'performance',
  'employee-overview': 'welcome',
  'employee-leave': 'leave',
  'employee-attendance': 'attendance',
  'employee-payslips': 'me',
  'employee-profile-performance': 'me',
};

/** The tour id a guide should offer, or null if there isn't one (e.g. a user-uploaded doc). */
export function guideTourId(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const id = GUIDE_TOUR[slug];
  return id && TOURS[id] ? id : null;
}
