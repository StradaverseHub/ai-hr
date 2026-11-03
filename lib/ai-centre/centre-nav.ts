/** The AI centre's information architecture (docs/design/ai-centre/PLAN.md), as data.
 *
 * NO NEW ROUTE AND NO NEW GUARD. Every tab is an existing, already-guarded page:
 *  - Ask, Delegated jobs and How it works are views of /assistant (its layout requires a signed-in login; the
 *    conversation keeps its own grant check). Delegated jobs reads native owners as the caller and shows
 *    nothing the person could not already open.
 *  - The Inbox tab is retired (AI v2 Phase 1): Today at `/` replaces it, and /assistant?view=inbox redirects
 *    there (app/assistant/page.tsx).
 *  - Operations is the former Control Tower (issue 17, owner: "Merge both entirely"): the /control-tower pages,
 *    each behind requireAdmin in app/control-tower/layout.tsx and on the page itself.
 *  - Administration groups Workers, Setup and Spend and providers: the existing AI management pages under
 *    /control-tower/agents (the same requireAdmin; provider also needs a group administrator).
 * lib/permissions.ts therefore lists every route unchanged, and `adminOnly` below only hides a tab the
 * page would refuse anyway; it is never the gate. */

export const CENTRE_VIEWS = ['jobs', 'how'] as const;
export type CentreView = (typeof CENTRE_VIEWS)[number];
export const isCentreView = (value: unknown): value is CentreView =>
  typeof value === 'string' && (CENTRE_VIEWS as readonly string[]).includes(value);

export type CentreTabKey = 'ask' | 'jobs' | 'operations' | 'administration' | 'how';

/** `sections`: the tab is a group whose pages show a second tab row (CENTRE_SECTIONS). */
export type CentreTab = Readonly<{ key: CentreTabKey; href: string; adminOnly: boolean; sections: boolean }>;

export const CENTRE_TABS: readonly CentreTab[] = [
  { key: 'ask', href: '/assistant', adminOnly: false, sections: false },
  { key: 'jobs', href: '/assistant?view=jobs', adminOnly: false, sections: false },
  { key: 'operations', href: '/control-tower', adminOnly: true, sections: true },
  { key: 'administration', href: '/control-tower/agents/features', adminOnly: true, sections: true },
  { key: 'how', href: '/assistant?view=how', adminOnly: false, sections: false },
];

export function centreTabsFor(viewer: { isAdmin: boolean }): readonly CentreTab[] {
  return CENTRE_TABS.filter(tab => !tab.adminOnly || viewer.isAdmin);
}

/** The second tab row of a group tab. `payroll`: the page is a payroll queue, offered only while the tenant
 * holds payroll (the former sidebar rows were module-gated the same way, components/sidebar.tsx MODULE_OF_HREF). */
export type OperationsSection = 'overview' | 'loops' | 'exceptions' | 'readiness' | 'actions' | 'opportunities';
export type AdministrationSection = 'workers' | 'setup' | 'spend';
export type CentreSection = OperationsSection | AdministrationSection;
export type CentreSectionTab = Readonly<{ key: CentreSection; href: string; payroll: boolean }>;
export type CentreGroup = 'operations' | 'administration';

export const CENTRE_SECTIONS: Readonly<Record<CentreGroup, readonly CentreSectionTab[]>> = {
  operations: [
    { key: 'overview', href: '/control-tower', payroll: false },
    // AI v2 W8: the loops at the Prepare level (approved mock-up, Operations.dc.html "Loops"), behind the same guard.
    { key: 'loops', href: '/control-tower/loops', payroll: false },
    { key: 'exceptions', href: '/control-tower/exceptions', payroll: true },
    { key: 'readiness', href: '/control-tower/readiness', payroll: false },
    { key: 'actions', href: '/control-tower/actions', payroll: true },
    { key: 'opportunities', href: '/control-tower/opportunities', payroll: false },
  ],
  administration: [
    { key: 'workers', href: '/control-tower/agents/features', payroll: false },
    { key: 'setup', href: '/control-tower/agents', payroll: false },
    { key: 'spend', href: '/control-tower/agents/allowances', payroll: false },
  ],
};

export function centreSectionsFor(group: CentreGroup, viewer: { payroll: boolean }): readonly CentreSectionTab[] {
  return CENTRE_SECTIONS[group].filter(section => !section.payroll || viewer.payroll);
}

/** The AI management sections grouped under the three Administration sections. Orchestrator is not listed: its
 * work queue is the Operations overview's, and that page forwards there. */
export type AdminSection = 'features' | 'inventory' | 'overview' | 'assistant' | 'allowances' | 'spending' | 'provider' | 'runs';
export type AdminSubnavItem = Readonly<{ section: AdminSection; label: 'workers' | 'inventory' | 'overview' | 'assistant' | 'allowances' | 'spending' | 'provider' | 'runs' }>;

export const ADMIN_GROUPS: Readonly<Record<AdministrationSection, readonly AdminSubnavItem[]>> = {
  workers: [{ section: 'features', label: 'workers' }, { section: 'inventory', label: 'inventory' }],
  setup: [{ section: 'overview', label: 'overview' }, { section: 'assistant', label: 'assistant' }],
  spend: [{ section: 'allowances', label: 'allowances' }, { section: 'spending', label: 'spending' }, { section: 'provider', label: 'provider' }, { section: 'runs', label: 'runs' }],
};

export function adminGroupOf(section: string): AdministrationSection | null {
  for (const [group, items] of Object.entries(ADMIN_GROUPS) as [AdministrationSection, readonly AdminSubnavItem[]][])
    if (items.some(item => item.section === section)) return group;
  return null;
}
