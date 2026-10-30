/** Presentation of existing V9 destinations. These flags never grant service access. */
export type V9NavigationPermissions = { onboarding: boolean; offboarding: boolean; administration: boolean };
export const V9_NAVIGATION = [
  { view: 'joiners', labelKey: 'newJoiners', submenuKey: 'onboardingV31', permission: 'onboarding', href: '/lifecycle/v9', ownedSubpaths: ['/lifecycle/v9/onboarding'] },
  { view: 'onbChecklists', labelKey: 'onboardingChecklists', submenuKey: 'onboardingV31', permission: 'onboarding', href: '/lifecycle/v9?view=onbChecklists' },
  { view: 'leavers', labelKey: 'v9Leavers', submenuKey: 'v9Offboarding', permission: 'offboarding', href: '/lifecycle/v9?view=leavers' },
  { view: 'offChecklists', labelKey: 'v9OffboardingChecklists', submenuKey: 'v9Offboarding', permission: 'offboarding', href: '/lifecycle/v9?view=offChecklists' },
  { view: 'templates', labelKey: 'v9Templates', submenuKey: 'sectionConfiguration', permission: 'administration', href: '/lifecycle/v9?view=templates' },
  { view: 'workflows', labelKey: 'v9Workflows', submenuKey: 'sectionConfiguration', permission: 'administration', href: '/lifecycle/v9?view=workflows' },
  { view: 'settings', labelKey: 'v9Settings', submenuKey: 'sectionConfiguration', permission: 'administration', href: '/lifecycle/v9?view=settings' },
  { view: 'groups', labelKey: 'v9AssignmentGroups', submenuKey: 'sectionConfiguration', permission: 'administration', href: '/lifecycle/v9?view=groups' },
  { view: 'access', labelKey: 'v9ModuleAccess', submenuKey: 'sectionConfiguration', permission: 'administration', href: '/lifecycle/v9?view=access' },
] as const;
export type V9NavigationView = typeof V9_NAVIGATION[number]['view'];
export function v9NavigationView(value: unknown): V9NavigationView | undefined {
  return V9_NAVIGATION.find(item => item.view === value)?.view;
}
