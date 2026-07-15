/**
 * Per-user employee dashboard layout (feedback 7d9d145d; add/remove/shortcut in 578a2fcf). The employee's
 * chosen dashboard cards + arrangement, persisted on app_user.dashboard_layout through the SECURITY DEFINER
 * app.dashboard_layout_* seam (own-row-only: a user can read/write only their own layout, so RLS stays
 * intact and one employee's arrangement never touches another's).
 *
 * The stored value evolved from a plain block-order array (7d9d145d) to `{ selected, order }` (578a2fcf,
 * driven by the HR-Admin Dashboard Card Master 1586d2f5). It is normalised on BOTH read and write against
 * the tenant's live card config, so a legacy order-only array, a partial/tampered value, or a config that
 * disabled a card can never leave the layout in an invalid state. Reads/writes take the tenant's active
 * cards (see core/dashboard-card-config.listEmployeeDashboardCards) so the pure normaliser stays DB-free.
 *
 * SUBSTRATE CARVE-OUT (deliberate DomainEvent skip): dashboard_layout is a personal, cosmetic UI
 * preference — the same class as app_user.onboarded_at / lastSeenAt. It changes only which cards render on
 * the owner's own screen (within HR's rules), never any HR data or access. It has no audit, replay,
 * agent-context or Self-Improvement value and would be high-churn noise in the event log, so
 * setDashboardLayout / resetDashboardLayout intentionally do NOT append a DomainEvent (per the CLAUDE.md
 * "When NOT to append" rule for per-user UI/pref writes). Do not add one.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { normalizeDashboardLayout, type DashboardCardChoice, type DashboardLayout } from '../lib/dashboard-layout';

/**
 * The caller's saved, normalised layout against the given active card set. Always returns a valid layout
 * (never null): with no saved value it yields the HR default (mandatory + default-display cards shown). A
 * legacy order-only array is read as "everything shown, in that order".
 */
export function getDashboardLayout(
  ctx: SessionContext,
  cards: readonly DashboardCardChoice[],
): Promise<DashboardLayout> {
  if (!ctx.userId) return Promise.resolve(normalizeDashboardLayout(null, cards)); // no login identity → HR default
  return withTenant(ctx, async (tx) => {
    const rows = (await tx.execute(
      sql`select app.dashboard_layout_get() as layout`,
    )) as unknown as { layout: unknown }[];
    const raw = rows[0]?.layout ?? null;
    return normalizeDashboardLayout(raw, cards);
  });
}

/** Persist the caller's chosen cards + order (normalised against the live card config before write). */
export function setDashboardLayout(
  ctx: SessionContext,
  layout: unknown,
  cards: readonly DashboardCardChoice[],
): Promise<void> {
  const normalized = normalizeDashboardLayout(layout, cards);
  return withTenant(ctx, async (tx) => {
    // Deliberate DomainEvent skip — personal cosmetic UI pref (see file header).
    await tx.execute(sql`select app.dashboard_layout_set(${JSON.stringify(normalized)}::jsonb)`);
  });
}

/** Clear the caller's saved layout so the dashboard reverts to the HR default (mandatory + default cards). */
export function resetDashboardLayout(ctx: SessionContext): Promise<void> {
  return withTenant(ctx, async (tx) => {
    // Deliberate DomainEvent skip — personal cosmetic UI pref (see file header).
    await tx.execute(sql`select app.dashboard_layout_reset()`);
  });
}
