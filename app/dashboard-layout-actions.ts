'use server';

/**
 * Server actions for the per-user dashboard layout (feedback 7d9d145d; add/remove/shortcut in 578a2fcf;
 * per-ROLE for manager/HR admin in 9606c59f). Both run under the caller's own session; the underlying
 * app.dashboard_layout_* seam is own-row-only, so a user can only ever write their OWN layout. The layout
 * is normalised against the tenant's live ROLE-FILTERED card config (core/dashboard-prefs) before it
 * lands, so a client can't persist a card the HR config disabled, removed, or scoped to another role, nor
 * drop a mandatory card. The role is DERIVED server-side (resolveDashboardRole over the caller's own
 * roles/reporting edges — the same resolution the dashboard page renders with); a client-sent role is
 * never trusted.
 */
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { resolveDashboardRole, type DashboardRole } from '@/lib/dashboard-cards';
import { setDashboardLayout, resetDashboardLayout } from '@/core/dashboard-prefs';
import { listDashboardCards } from '@/core/dashboard-card-config';
import { BUILTIN_ROLE_DASHBOARD_CARDS, type DashboardCardChoice } from '@/lib/dashboard-layout';
import type { SessionContext } from '@/db/client';

/** Resolve the caller's dashboard role exactly like app/page.tsx does — never from client input. */
async function callerDashboardRole(s: SessionContext): Promise<DashboardRole> {
  const me = await myEmployment(s);
  const reportingLines = me ? await reportingLinesFor(s, me.employmentId) : null;
  return resolveDashboardRole({
    admin: isAdmin(s),
    managerRole: (s.roles ?? []).includes('manager'),
    hasDirectReports: (reportingLines?.reports.length ?? 0) > 0,
  });
}

/** The role's active card catalog, with the same builtin fallback the dashboard page renders from. */
async function cardsForRole(s: SessionContext, role: DashboardRole): Promise<readonly DashboardCardChoice[]> {
  const configured = await listDashboardCards(s, role);
  return configured.length ? configured : BUILTIN_ROLE_DASHBOARD_CARDS[role];
}

/** Save the caller's chosen dashboard cards + order ({ selected, order } of cardKeys) for their role. */
export async function saveDashboardLayoutAction(layout: { selected: string[]; order: string[] }): Promise<void> {
  const s = await getSession();
  const role = await callerDashboardRole(s);
  const cards = await cardsForRole(s, role); // validate the saved set against the live HR config
  await setDashboardLayout(s, layout, cards, role);
  revalidatePath('/');
}

/** Clear the caller's saved layout for their role → dashboard reverts to the HR default. */
export async function resetDashboardLayoutAction(): Promise<void> {
  const s = await getSession();
  const role = await callerDashboardRole(s);
  await resetDashboardLayout(s, role);
  revalidatePath('/');
}
