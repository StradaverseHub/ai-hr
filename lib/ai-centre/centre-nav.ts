/** The AI centre's information architecture (docs/design/ai-centre/PLAN.md), as data.
 *
 * NO NEW ROUTE AND NO NEW GUARD. Every tab is an existing, already-guarded page:
 *  - Ask, Inbox, Delegated jobs and How it works are views of /assistant (its layout requires a signed-in
 *    login; the conversation keeps its own grant check). Inbox and Delegated jobs read native owners as the
 *    caller and show nothing the person could not already open.
 *  - Workers, Setup and Spend and providers are the existing AI management pages under
 *    /control-tower/agents (requireAdmin in app/control-tower/layout.tsx and on every page; provider also
 *    needs a group administrator). They are only regrouped here.
 * lib/permissions.ts therefore lists every route unchanged, and `adminOnly` below only hides a tab the
 * page would refuse anyway; it is never the gate. */

export const CENTRE_VIEWS = ['inbox', 'jobs', 'how'] as const;
export type CentreView = (typeof CENTRE_VIEWS)[number];
export const isCentreView = (value: unknown): value is CentreView =>
  typeof value === 'string' && (CENTRE_VIEWS as readonly string[]).includes(value);

export type CentreTabKey = 'ask' | 'inbox' | 'jobs' | 'workers' | 'setup' | 'spend' | 'how';

export type CentreTab = Readonly<{ key: CentreTabKey; href: string; adminOnly: boolean }>;

export const CENTRE_TABS: readonly CentreTab[] = [
  { key: 'ask', href: '/assistant', adminOnly: false },
  { key: 'inbox', href: '/assistant?view=inbox', adminOnly: false },
  { key: 'jobs', href: '/assistant?view=jobs', adminOnly: false },
  { key: 'workers', href: '/control-tower/agents/features', adminOnly: true },
  { key: 'setup', href: '/control-tower/agents', adminOnly: true },
  { key: 'spend', href: '/control-tower/agents/allowances', adminOnly: true },
  { key: 'how', href: '/assistant?view=how', adminOnly: false },
];

export function centreTabsFor(viewer: { isAdmin: boolean }): readonly CentreTab[] {
  return CENTRE_TABS.filter(tab => !tab.adminOnly || viewer.isAdmin);
}

/** The AI management sections grouped under the three administrator tabs. Orchestrator is not listed: its
 * work queue is the Control Tower overview's, and that page forwards there. */
export type AdminSection = 'features' | 'inventory' | 'overview' | 'assistant' | 'allowances' | 'spending' | 'provider' | 'runs';
export type AdminSubnavItem = Readonly<{ section: AdminSection; label: 'workers' | 'inventory' | 'overview' | 'assistant' | 'allowances' | 'spending' | 'provider' | 'runs' }>;

export const ADMIN_GROUPS: Readonly<Record<'workers' | 'setup' | 'spend', readonly AdminSubnavItem[]>> = {
  workers: [{ section: 'features', label: 'workers' }, { section: 'inventory', label: 'inventory' }],
  setup: [{ section: 'overview', label: 'overview' }, { section: 'assistant', label: 'assistant' }],
  spend: [{ section: 'allowances', label: 'allowances' }, { section: 'spending', label: 'spending' }, { section: 'provider', label: 'provider' }, { section: 'runs', label: 'runs' }],
};

export function adminGroupOf(section: string): 'workers' | 'setup' | 'spend' | null {
  for (const [group, items] of Object.entries(ADMIN_GROUPS) as ['workers' | 'setup' | 'spend', readonly AdminSubnavItem[]][])
    if (items.some(item => item.section === section)) return group;
  return null;
}
