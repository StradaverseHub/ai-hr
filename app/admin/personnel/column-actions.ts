'use server';

/**
 * Server actions for the Personnel listing's Customize Columns panel (feedback 579255c3, points 2 & 3).
 *
 * Both run under the CALLER's own session and write through the own-row app.list_preferences_* seam, so a
 * user can only ever change their own columns — "your arrangement is yours alone" is enforced in the
 * database, not merely in the UI. The payload is normalised against the catalogue in
 * core/employee-list-prefs before it lands, so a client cannot persist a column that does not exist, an
 * empty table, or a duplicate order.
 *
 * Admin-gated to match the screen: /admin/personnel is behind requireAdmin, and an action reachable from
 * it must not be a softer door than the page. `requireAdmin()` redirects a non-admin — and redirect()
 * SIGNALS BY THROWING, so nothing may be placed after it that assumes success.
 */
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { resetEmployeeListColumns, setEmployeeListColumns } from '@/core/employee-list-prefs';

/** Save the caller's chosen employee-listing columns and their order. */
export async function saveEmployeeColumnsAction(prefs: {
  selected: string[];
  order: string[];
}): Promise<void> {
  await setEmployeeListColumns(await requireAdmin(), prefs);
  revalidatePath('/admin/personnel');
}

/** Clear the caller's saved columns → the listing reverts to the default six-column view. */
export async function resetEmployeeColumnsAction(): Promise<void> {
  await resetEmployeeListColumns(await requireAdmin());
  revalidatePath('/admin/personnel');
}
