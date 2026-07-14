'use server';

/**
 * Server actions for the per-user employee dashboard layout (feedback 7d9d145d). Both run under the
 * caller's own session; the underlying app.dashboard_layout_* seam is own-row-only, so a user can only
 * ever write their OWN layout. The layout array is normalised in core/dashboard-prefs before it lands.
 */
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { setDashboardLayout, resetDashboardLayout } from '@/core/dashboard-prefs';

/** Save the caller's preferred dashboard block order. */
export async function saveDashboardLayoutAction(order: string[]): Promise<void> {
  const s = await getSession();
  await setDashboardLayout(s, order);
  revalidatePath('/');
}

/** Clear the caller's saved layout → dashboard reverts to the system default order. */
export async function resetDashboardLayoutAction(): Promise<void> {
  const s = await getSession();
  await resetDashboardLayout(s);
  revalidatePath('/');
}
