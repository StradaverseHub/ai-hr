/**
 * Onboarding tour step registry (ADR-0018). Steps are data: each anchors to a `data-tour` element
 * (or is a centered card when `target` is null), carries i18n keys, a placement, and an optional role
 * filter. The server resolves the list for the caller's roles and hands it to the client tour, so the
 * walkthrough adapts per role (an employee never sees the admin-setup step).
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
};

const MANAGER_UP = ['manager', 'hr_admin', 'super_admin'];
const ADMIN = ['hr_admin', 'super_admin'];

export const TOUR_STEPS: TourStep[] = [
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

/** The tour for a user with the given roles. */
export function tourStepsFor(roles: string[] | undefined): TourStep[] {
  const have = new Set(roles ?? []);
  return TOUR_STEPS.filter((s) => !s.roles || s.roles.some((r) => have.has(r)));
}
