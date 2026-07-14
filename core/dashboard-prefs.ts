/**
 * Per-user employee dashboard layout (feedback 7d9d145d). The employee's preferred vertical order of
 * dashboard blocks, persisted on app_user.dashboard_layout through the SECURITY DEFINER
 * app.dashboard_layout_* seam (own-row-only: a user can read/write only their own layout, so RLS stays
 * intact and one employee's arrangement never touches another's).
 *
 * SUBSTRATE CARVE-OUT (deliberate DomainEvent skip): dashboard_layout is a personal, cosmetic UI
 * preference — the same class as app_user.onboarded_at / lastSeenAt. It changes only the order sections
 * render in on the owner's own screen, never any HR data or access. It has no audit, replay, agent-context
 * or Self-Improvement value and would be high-churn noise in the event log, so setDashboardLayout /
 * resetDashboardLayout intentionally do NOT append a DomainEvent (per the CLAUDE.md "When NOT to append"
 * rule for per-user UI/pref writes). Do not add one.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { normalizeDashboardOrder, type DashboardBlockId } from '../lib/dashboard-layout';

/**
 * The caller's saved block order, or null if they've never customised (→ the page falls back to the
 * system default). The stored value is normalised on read so a partial/legacy/tampered array can never
 * drop or duplicate a block.
 */
export function getDashboardLayout(ctx: SessionContext): Promise<DashboardBlockId[] | null> {
  if (!ctx.userId) return Promise.resolve(null); // no login identity → nothing saved
  return withTenant(ctx, async (tx) => {
    const rows = (await tx.execute(
      sql`select app.dashboard_layout_get() as layout`,
    )) as unknown as { layout: unknown }[];
    const raw = rows[0]?.layout;
    if (raw == null) return null;
    return normalizeDashboardOrder(raw);
  });
}

/** Persist the caller's preferred block order (normalised before write). */
export function setDashboardLayout(ctx: SessionContext, order: unknown): Promise<void> {
  const normalized = normalizeDashboardOrder(order);
  return withTenant(ctx, async (tx) => {
    // Deliberate DomainEvent skip — personal cosmetic UI pref (see file header).
    await tx.execute(sql`select app.dashboard_layout_set(${JSON.stringify(normalized)}::jsonb)`);
  });
}

/** Clear the caller's saved layout so the dashboard reverts to the system default order. */
export function resetDashboardLayout(ctx: SessionContext): Promise<void> {
  return withTenant(ctx, async (tx) => {
    // Deliberate DomainEvent skip — personal cosmetic UI pref (see file header).
    await tx.execute(sql`select app.dashboard_layout_reset()`);
  });
}
