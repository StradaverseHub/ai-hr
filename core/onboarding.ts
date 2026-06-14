/**
 * System-user onboarding state (ADR-0018). Whether the current user has finished/dismissed the
 * first-login product tour, persisted on app_user.onboarded_at through the SECURITY DEFINER
 * app.onboarding_* seam (column-safe: a user can only touch their own flag).
 *
 * onboarded_at is per-user UI preference — intentionally NOT a domain event (substrate carve-out).
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';

/** Has the caller completed (or dismissed) the onboarding tour? */
export function getOnboardingStatus(ctx: SessionContext): Promise<boolean> {
  if (!ctx.userId) return Promise.resolve(true); // no user → nothing to onboard
  return withTenant(ctx, async (tx) => {
    const rows = (await tx.execute(
      sql`select app.onboarding_status() as onboarded`,
    )) as unknown as { onboarded: boolean }[];
    return Boolean(rows[0]?.onboarded);
  });
}

/** Mark the tour finished/dismissed for the caller (idempotent). */
export function completeOnboarding(ctx: SessionContext): Promise<void> {
  return withTenant(ctx, async (tx) => {
    await tx.execute(sql`select app.onboarding_complete()`);
  });
}

/** Dev/QA: clear the flag so the tour replays from scratch. */
export function resetOnboarding(ctx: SessionContext): Promise<void> {
  return withTenant(ctx, async (tx) => {
    await tx.execute(sql`select app.onboarding_reset()`);
  });
}
