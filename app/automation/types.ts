/** Shapes shared by the HR Automation server actions and screens. Types only. */
/** What a dry run assumes about the event itself (which part, which outcome…), chosen by the tester as in the prototype. */
export type DryRunEventFacts = { part: string; outcome: string; resultBand: string; suggestionOverridden: string; pendingStep: string };
export type ActionResult<T> = { ok: true; result: T } | { ok: false; code: 'forbidden' | 'invalid' | 'conflict' | 'not_found' | 'review' | 'unavailable'; detail?: string; problems?: string[] };
/** The module filter of the shared builders. */
export type AutomationFilter = 'all' | 'onb' | 'off' | 'contract_staff' | 'probation';
export const AUTOMATION_FILTERS: readonly AutomationFilter[] = ['all', 'onb', 'off', 'contract_staff', 'probation'];
/** What the viewer may configure, resolved on the server by each module owner. */
export type AutomationPageAccess = { legacy: boolean; probation: boolean; contractStaff: boolean; any: boolean };
/** Existing builders of the modules that have not moved to the shared engine yet (ADR decision 2). */
export const LEGACY_BUILDERS = {
  workflows: { onb: '/lifecycle/v9?view=workflows', off: '/lifecycle/v9?view=workflows', contract_staff: '/lifecycle/contracts/workflows' },
  templates: { onb: '/lifecycle/v9?view=templates', off: '/lifecycle/v9?view=templates', contract_staff: '/lifecycle/contracts/templates' },
  groups: '/lifecycle/v9?view=groups',
} as const;
