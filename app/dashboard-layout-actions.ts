'use server';

/**
 * Server actions for the per-user employee dashboard layout (feedback 7d9d145d; add/remove/shortcut in
 * 578a2fcf). Both run under the caller's own session; the underlying app.dashboard_layout_* seam is
 * own-row-only, so a user can only ever write their OWN layout. The layout is normalised against the
 * tenant's live card config (core/dashboard-prefs) before it lands, so a client can't persist a card the
 * HR config disabled or removed, nor drop a mandatory card.
 */
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { setDashboardLayout, resetDashboardLayout } from '@/core/dashboard-prefs';
import { listEmployeeDashboardCards } from '@/core/dashboard-card-config';

/** Save the caller's chosen dashboard cards + order ({ selected, order } of cardKeys). */
export async function saveDashboardLayoutAction(layout: { selected: string[]; order: string[] }): Promise<void> {
  const s = await getSession();
  const cards = await listEmployeeDashboardCards(s); // validate the saved set against the live HR config
  await setDashboardLayout(s, layout, cards);
  revalidatePath('/');
}

/** Clear the caller's saved layout → dashboard reverts to the HR default (mandatory + default cards). */
export async function resetDashboardLayoutAction(): Promise<void> {
  const s = await getSession();
  await resetDashboardLayout(s);
  revalidatePath('/');
}
