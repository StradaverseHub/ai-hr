/**
 * Per-user dashboard layout (feedback 7d9d145d; add/remove/shortcut in 578a2fcf; per-ROLE in 9606c59f).
 * The caller's chosen dashboard cards + arrangement, persisted on app_user.dashboard_layout through the
 * SECURITY DEFINER app.dashboard_layout_* seam (own-row-only: a user can read/write only their own layout,
 * so RLS stays intact and one person's arrangement never touches another's).
 *
 * The stored value evolved from a plain block-order array (7d9d145d) to `{ selected, order }` (578a2fcf,
 * driven by the HR-Admin Dashboard Card Master 1586d2f5) to a per-ROLE envelope
 * `{ employee?: {…}, manager?: {…}, hr_admin?: {…} }` (9606c59f — managers and HR admins customize too,
 * and someone promoted between roles keeps a sensible dashboard in each hat). A LEGACY flat value reads as
 * the EMPLOYEE slot, so every pre-existing saved employee layout keeps working unchanged. Each role's slot
 * is normalised on BOTH read and write against the tenant's live ROLE-FILTERED card config, so a legacy
 * value, a partial/tampered slot, or a config that disabled a card can never leave the layout in an
 * invalid state. Reads/writes take the role's active cards (core/dashboard-card-config.listDashboardCards)
 * so the pure normaliser stays DB-free.
 *
 * SUBSTRATE CARVE-OUT (deliberate DomainEvent skip): dashboard_layout is a personal, cosmetic UI
 * preference — the same class as app_user.onboarded_at / lastSeenAt. It changes only which cards render on
 * the owner's own screen (within HR's rules), never any HR data or access. It has no audit, replay,
 * agent-context or Self-Improvement value and would be high-churn noise in the event log, so
 * setDashboardLayout / resetDashboardLayout intentionally do NOT append a DomainEvent (per the CLAUDE.md
 * "When NOT to append" rule for per-user UI/pref writes). Do not add one.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  extractRoleLayout,
  mergeRoleLayout,
  normalizeDashboardLayout,
  removeRoleLayout,
  type DashboardCardChoice,
  type DashboardLayout,
  type DashboardLayoutRole,
} from '../lib/dashboard-layout';

/** Read the caller's raw stored dashboard_layout jsonb through the own-row seam. */
async function readRawLayout(tx: Tx): Promise<unknown> {
  const rows = (await tx.execute(
    sql`select app.dashboard_layout_get() as layout`,
  )) as unknown as { layout: unknown }[];
  return rows[0]?.layout ?? null;
}

/**
 * The caller's saved, normalised layout for `role` against the given active card set. Always returns a
 * valid layout (never null): with no saved slot it yields the HR default (mandatory + default-display
 * cards shown). A legacy flat value is the employee slot; a legacy order-only array reads as "everything
 * shown, in that order".
 */
export function getDashboardLayout(
  ctx: SessionContext,
  cards: readonly DashboardCardChoice[],
  role: DashboardLayoutRole = 'employee',
): Promise<DashboardLayout> {
  if (!ctx.userId) return Promise.resolve(normalizeDashboardLayout(null, cards)); // no login identity → HR default
  return withTenant(ctx, async (tx) => {
    const raw = await readRawLayout(tx);
    return normalizeDashboardLayout(extractRoleLayout(raw, role), cards);
  });
}

/**
 * Persist the caller's chosen cards + order for `role` (normalised against the live role-filtered card
 * config before write). Only the role's slot is replaced — the other roles' saved layouts are preserved.
 */
export function setDashboardLayout(
  ctx: SessionContext,
  layout: unknown,
  cards: readonly DashboardCardChoice[],
  role: DashboardLayoutRole = 'employee',
): Promise<void> {
  const normalized = normalizeDashboardLayout(layout, cards);
  return withTenant(ctx, async (tx) => {
    // Deliberate DomainEvent skip — personal cosmetic UI pref (see file header).
    const merged = mergeRoleLayout(await readRawLayout(tx), role, normalized);
    await tx.execute(sql`select app.dashboard_layout_set(${JSON.stringify(merged)}::jsonb)`);
  });
}

/**
 * Clear the caller's saved layout for `role` so that dashboard reverts to the HR default (mandatory +
 * default cards). Other roles' saved slots are preserved; when nothing remains the column goes back to
 * NULL — exactly the pre-9606c59f reset.
 */
export function resetDashboardLayout(
  ctx: SessionContext,
  role: DashboardLayoutRole = 'employee',
): Promise<void> {
  return withTenant(ctx, async (tx) => {
    // Deliberate DomainEvent skip — personal cosmetic UI pref (see file header).
    const remaining = removeRoleLayout(await readRawLayout(tx), role);
    if (remaining == null) {
      await tx.execute(sql`select app.dashboard_layout_reset()`);
    } else {
      await tx.execute(sql`select app.dashboard_layout_set(${JSON.stringify(remaining)}::jsonb)`);
    }
  });
}
