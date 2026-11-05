/** The AI centre's information architecture (docs/design/ai-centre/PLAN.md), as data.
 *
 * NO NEW GUARD. Every tab is an existing, already-guarded page:
 *  - Ask, Insights and How it works are views of /assistant (its layout requires a signed-in login; the
 *    conversation keeps its own grant check).
 *  - The Inbox tab is retired (AI v2 Phase 1): Today at `/` replaces it, and /assistant?view=inbox redirects
 *    there (app/assistant/page.tsx).
 *  - Operations is the former Control Tower (issue 17, owner: "Merge both entirely"): the /control-tower pages,
 *    each behind requireAdmin in app/control-tower/layout.tsx and on the page itself.
 *  - Administration groups Workers, Setup, Spend and providers and the Build list: the existing AI management pages
 *    under /control-tower/agents (the same requireAdmin; Provider and the Build list also need a group administrator).
 * lib/permissions.ts lists every route, and `adminOnly` below only hides a tab the page would refuse anyway; it is
 * never the gate.
 *
 * AI Centre restructure (owner decisions 26–29, 4 November 2026), so each fact lives in one place:
 *  - Delegated jobs is hidden until it works; /assistant?view=jobs forwards to Ask.
 *  - Insights is for administrators only (decision 27): HR capacity and AI quality. A person's own "My payroll
 *    readiness" is its own page, /me/payroll-readiness, which Today's "See all" opens.
 *  - Operations opens on Loops; the Overview (/control-tower) forwards there and its staffing ratio is gone (decision
 *    26). Proposed actions forwards to Exceptions, Opportunities to Insights › HR capacity and the Inventory page to
 *    Workers, each from a guarded forward stub. */

export const CENTRE_VIEWS = ['jobs', 'how', 'insights'] as const;
export type CentreView = (typeof CENTRE_VIEWS)[number];
export const isCentreView = (value: unknown): value is CentreView =>
  typeof value === 'string' && (CENTRE_VIEWS as readonly string[]).includes(value);

export type CentreTabKey = 'ask' | 'operations' | 'administration' | 'how' | 'insights' | 'policies';

/** `sections`: the tab is a group whose pages show a second tab row (CENTRE_SECTIONS). */
export type CentreTab = Readonly<{ key: CentreTabKey; href: string; adminOnly: boolean; sections: boolean }>;

/** The approved structure's order: Ask · Operations ▾ · Insights · Policies · Administration ▾ · How it works. */
export const CENTRE_TABS: readonly CentreTab[] = [
  { key: 'ask', href: '/assistant', adminOnly: false, sections: false },
  { key: 'operations', href: '/control-tower/loops', adminOnly: true, sections: true },
  // Owner decision 27: Insights is for HR and group administrators only (HR capacity and AI quality); its sections are
  // guarded again inside the view (components/ai-centre/insights.tsx) and by their services. A non-administrator who
  // opens it is forwarded to their own payroll readiness page.
  { key: 'insights', href: '/assistant?view=insights', adminOnly: true, sections: false },
  // AI v2 Phase 2 P2-5: Policies, the Living Handbook, for every signed-in person. Its own linkable page, app/policies
  // (a signed-in session), so Ask can link it. Administrators write and approve policies; everyone else reads the
  // approved text of their own company's policies only (components/ai-centre/policies.tsx, migration 0971).
  { key: 'policies', href: '/policies', adminOnly: false, sections: false },
  { key: 'administration', href: '/control-tower/agents/features', adminOnly: true, sections: true },
  { key: 'how', href: '/assistant?view=how', adminOnly: false, sections: false },
];

export function centreTabsFor(viewer: { isAdmin: boolean }): readonly CentreTab[] {
  return CENTRE_TABS.filter(tab => !tab.adminOnly || viewer.isAdmin);
}

/** The second tab row of a group tab. `payroll`: the page is a payroll queue, offered only while the tenant holds
 * payroll (the former sidebar rows were module-gated the same way, components/sidebar.tsx MODULE_OF_HREF).
 * `groupAdmin`: the page refuses anyone but a group administrator, so only they are offered it. */
export type OperationsSection = 'loops' | 'payrollCycle' | 'exceptions' | 'readiness';
export type AdministrationSection = 'workers' | 'setup' | 'spend' | 'buildList';
export type CentreSection = OperationsSection | AdministrationSection;
export type CentreSectionTab = Readonly<{ key: CentreSection; href: string; payroll: boolean; groupAdmin: boolean }>;
export type CentreGroup = 'operations' | 'administration';

export const CENTRE_SECTIONS: Readonly<Record<CentreGroup, readonly CentreSectionTab[]>> = {
  operations: [
    // AI v2 W8: the loops at the Prepare level; the landing page of Operations, with all seven loops (the six in its
    // table and the three payroll loops listed above it, the Audit loop among them).
    { key: 'loops', href: '/control-tower/loops', payroll: false, groupAdmin: false },
    // The three payroll loops' pages: Pre-salary (the cycle), Salary payroll and its Settings, and Audit.
    { key: 'payrollCycle', href: '/control-tower/loops/payroll-cycle', payroll: true, groupAdmin: false },
    // The one queue of payroll exceptions (decision 28: resolved here only), with the "cause already fixed" group.
    { key: 'exceptions', href: '/control-tower/exceptions', payroll: true, groupAdmin: false },
    // The one list of record gaps, with who acts, Refresh and what the missing-data loop asked.
    { key: 'readiness', href: '/control-tower/readiness', payroll: false, groupAdmin: false },
  ],
  administration: [
    { key: 'workers', href: '/control-tower/agents/features', payroll: false, groupAdmin: false },
    { key: 'setup', href: '/control-tower/agents', payroll: false, groupAdmin: false },
    { key: 'spend', href: '/control-tower/agents/allowances', payroll: false, groupAdmin: false },
    // From the former Opportunities page: the ranked build list and its export, which only a group administrator reads.
    { key: 'buildList', href: '/control-tower/agents/build-list', payroll: false, groupAdmin: true },
  ],
};

export function centreSectionsFor(group: CentreGroup, viewer: { payroll: boolean; groupAdmin?: boolean }): readonly CentreSectionTab[] {
  return CENTRE_SECTIONS[group].filter(section => (!section.payroll || viewer.payroll) && (!section.groupAdmin || viewer.groupAdmin === true));
}

/** The pages of Operations › Payroll cycle, in the payroll loops' order, as its in-section row. */
export type PayrollCyclePage = 'pre' | 'salary' | 'settings' | 'audit';
export const PAYROLL_CYCLE_PAGES: readonly Readonly<{ page: PayrollCyclePage; href: string }>[] = [
  { page: 'pre', href: '/control-tower/loops/payroll-cycle' },
  { page: 'salary', href: '/control-tower/loops/payroll-cycle/salary' },
  { page: 'settings', href: '/control-tower/loops/payroll-cycle/settings' },
  { page: 'audit', href: '/control-tower/loops/loop_payroll_audit' },
];

/** The AI management sections grouped under the Administration sections. Orchestrator is not listed: its work queue
 * is Record readiness's, and that page forwards there. Workers is one list (the former All workers and Inventory and
 * audit), so it has no in-section row; the Inventory page forwards to it. */
export type AdminSection = 'features' | 'overview' | 'assistant' | 'allowances' | 'spending' | 'provider' | 'runs';
export type AdminSubnavItem = Readonly<{ section: AdminSection; label: 'workers' | 'overview' | 'assistant' | 'allowances' | 'spending' | 'provider' | 'runs' }>;

export const ADMIN_GROUPS: Readonly<Record<Exclude<AdministrationSection, 'buildList'>, readonly AdminSubnavItem[]>> = {
  workers: [{ section: 'features', label: 'workers' }],
  setup: [{ section: 'overview', label: 'overview' }, { section: 'assistant', label: 'assistant' }],
  spend: [{ section: 'allowances', label: 'allowances' }, { section: 'spending', label: 'spending' }, { section: 'provider', label: 'provider' }, { section: 'runs', label: 'runs' }],
};

export function adminGroupOf(section: string): Exclude<AdministrationSection, 'buildList'> | null {
  for (const [group, items] of Object.entries(ADMIN_GROUPS) as [Exclude<AdministrationSection, 'buildList'>, readonly AdminSubnavItem[]][])
    if (items.some(item => item.section === section)) return group;
  return null;
}
