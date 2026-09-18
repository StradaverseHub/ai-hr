'use server';

/**
 * r306 — what the ⌘K palette is allowed to find.
 *
 * WHY TWO ACTIONS AND NOT PROPS. `<CommandBar />` is rendered propless in the header and
 * test/header-command-bar.test.ts pins that shape, so the palette asks for its data when it opens
 * instead of the layout paying for it on every authenticated render. Both answers are cheap and both
 * are resolved HERE, on the server, at the caller's own authorization.
 *
 * THE PALETTE IS A FINDER, NOT A SECOND PERMISSION SYSTEM. Neither action returns anything the viewer
 * could not already reach: the page list is the rail's own visibility answer (components/sidebar.tsx
 * `visibleNavRows`, computed on the client from these gates), and the people search is the People
 * screen's own query under RLS. Nothing here widens access, and a page typed into the address bar is
 * still refused by its own guard — hiding a row was never the control (ADR-0077 D3).
 */
import { getSession } from '@/lib/session';
import { canManagePayroll, canManagePerfComp, isAdmin } from '@/lib/authz';
import { visibleModuleCodes } from '@/lib/nav-entitlements';
import { scopedSession } from '@/lib/scope';
import { listEmployeesPage } from '@/core/read';
import type { NavGates } from '@/components/sidebar';

/**
 * The three facts the rail filters on. Deliberately the SAME expressions app/layout.tsx passes to the
 * Sidebar — including ADR-0049's union rule, where a payroll or perf-comp partner reads as admin for
 * nav purposes so a user who is both is never narrower than a plain admin. If these two ever disagree,
 * ⌘K starts offering pages the menu hides, which is the whole failure this round set out to avoid.
 */
export async function commandBarGatesAction(): Promise<NavGates> {
  const session = await getSession();
  return {
    isAdmin: isAdmin(session) || canManagePayroll(session) || canManagePerfComp(session),
    canApprove: (session.roles ?? []).includes('manager'),
    enabledModules: visibleModuleCodes(session),
  };
}

/** One person the palette can jump to. No salary, no lifecycle dates — a name, a code and a place. */
export type CommandPersonHit = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  department: string | null;
  company: string;
};

/** How many names the palette shows. A finder, not a report: the People screen is one keystroke away. */
const PEOPLE_LIMIT = 6;

/**
 * Search people by name, email or employee code.
 *
 * Scoped twice over, as every read on this product is: the company switcher's active scope narrows the
 * rows, and RLS narrows them again to what this session may see at all. An employee searching here sees
 * what they see on the People screen — which is the point of reusing that screen's query rather than
 * writing a faster one.
 */
export async function searchPeopleAction(query: string): Promise<CommandPersonHit[]> {
  const q = query.trim();
  // Two characters is the floor: one letter matches most of a company and answers nothing.
  if (q.length < 2) return [];
  // scopedSession is the same session + active-company scope every People screen reads through.
  const { s: session, scopeIds } = await scopedSession();
  const { rows } = await listEmployeesPage(session, { companyIds: scopeIds, q, limit: PEOPLE_LIMIT, offset: 0 });
  return rows.map((r) => ({
    employmentId: r.employmentId,
    name: r.name,
    employeeCode: r.employeeCode,
    department: r.department,
    company: r.company,
  }));
}
