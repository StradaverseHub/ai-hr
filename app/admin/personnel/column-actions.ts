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
 * The same fresh Workforce page gate applies to grant-based readers too. These commands only write
 * the caller's own bounded preferences; they cannot create a field permission or modify an employee.
 */
import { revalidatePath } from 'next/cache';
import {requireWorkforceAccess} from '@/lib/workforce-authz';
import { resetEmployeeListColumns, setEmployeeListColumns } from '@/core/employee-list-prefs';

/** Save the caller's chosen employee-listing columns and their order. */
export async function saveEmployeeColumnsAction(prefs: {
  selected: string[];
  order: string[];
}): Promise<void> {
  await setEmployeeListColumns((await requireWorkforceAccess()).s, prefs);
  revalidatePath('/admin/personnel');
}

/** Clear the caller's saved columns → the listing reverts to the default six-column view. */
export async function resetEmployeeColumnsAction(): Promise<void> {
  await resetEmployeeListColumns((await requireWorkforceAccess()).s);
  revalidatePath('/admin/personnel');
}
