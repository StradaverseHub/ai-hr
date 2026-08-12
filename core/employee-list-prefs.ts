/**
 * Per-user Personnel listing columns (feedback 579255c3, points 2, 3 and 10).
 *
 * The caller's chosen employee-listing columns and their order, persisted on app_user.list_preferences
 * through the SECURITY DEFINER app.list_preferences_* seam (migration 0433). Own-row-only: a user can
 * read and write only their OWN preference, so RLS stays intact and one person's arrangement never
 * changes what anybody else sees — which is exactly what the plan promised the reporter.
 *
 * Modelled directly on core/dashboard-prefs.ts, including its two load-bearing habits:
 *   • the stored value is NORMALISED on both read and write (lib/employee-columns.ts), so a legacy value,
 *     a column removed from the catalogue, or a tampered client payload can never leave the table with no
 *     columns in it;
 *   • the column is a NAMESPACED envelope, so the next screen that wants remembered columns adds a key
 *     rather than a migration.
 *
 * SUBSTRATE CARVE-OUT (deliberate DomainEvent skip): which columns a person likes on one screen is a
 * personal, cosmetic UI preference — the same class as app_user.onboarded_at and dashboard_layout. It
 * changes no HR data, no access and no calculation, has no audit or replay value, and would be high-churn
 * noise in the event log. Per the CLAUDE.md "When NOT to append" rule for per-user UI/pref writes,
 * setEmployeeListColumns intentionally does NOT append a DomainEvent. Do not add one.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  normalizeEmployeeColumns,
  type EmployeeColumnPrefs,
} from '../lib/employee-columns';

/** The key this screen owns inside the shared list_preferences envelope. */
const EMPLOYEE_LIST_KEY = 'employeeList';

/** Read the caller's whole raw list_preferences jsonb through the own-row seam. */
async function readRawPrefs(tx: Tx): Promise<Record<string, unknown>> {
  const rows = (await tx.execute(
    sql`select app.list_preferences_get() as prefs`,
  )) as unknown as { prefs: unknown }[];
  const raw = rows[0]?.prefs;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * The caller's saved, normalised employee-listing columns. Always returns a usable value: with nothing
 * saved (or no login identity at all — a background/system context) it yields the default view.
 */
export function getEmployeeListColumns(ctx: SessionContext): Promise<EmployeeColumnPrefs> {
  if (!ctx.userId) return Promise.resolve(normalizeEmployeeColumns(null));
  return withTenant(ctx, async (tx) => normalizeEmployeeColumns((await readRawPrefs(tx))[EMPLOYEE_LIST_KEY]));
}

/**
 * Persist the caller's chosen columns + order, normalised before it lands. Only THIS screen's key is
 * replaced — any other screen's saved list preference in the same envelope is preserved.
 */
export function setEmployeeListColumns(ctx: SessionContext, prefs: unknown): Promise<void> {
  if (!ctx.userId) return Promise.resolve(); // no login identity → nothing to remember against
  const normalized = normalizeEmployeeColumns(prefs);
  return withTenant(ctx, async (tx) => {
    // Deliberate DomainEvent skip — personal cosmetic UI pref (see file header).
    const merged = { ...(await readRawPrefs(tx)), [EMPLOYEE_LIST_KEY]: normalized };
    await tx.execute(sql`select app.list_preferences_set(${JSON.stringify(merged)}::jsonb)`);
  });
}

/**
 * Clear the caller's saved columns so the listing reverts to the default view. When nothing else is left
 * in the envelope the column goes back to NULL rather than to an empty object, so "never customised" and
 * "customised then reset" are the same stored state.
 */
export function resetEmployeeListColumns(ctx: SessionContext): Promise<void> {
  if (!ctx.userId) return Promise.resolve();
  return withTenant(ctx, async (tx) => {
    const { [EMPLOYEE_LIST_KEY]: _dropped, ...rest } = await readRawPrefs(tx);
    if (Object.keys(rest).length === 0) {
      await tx.execute(sql`select app.list_preferences_reset()`);
    } else {
      await tx.execute(sql`select app.list_preferences_set(${JSON.stringify(rest)}::jsonb)`);
    }
  });
}
