/**
 * The per-user assistant grant (ADR-0082 §8 decision 1) and the composed access answer.
 *
 * ACCESS IS TWO GATES AND BOTH FAIL CLOSED:
 *   1. the TENANT must hold the `assistant` module (ADR-0077), and
 *   2. the USER must hold a live `assistant_grant` row.
 * Neither substitutes for the other. This is a mechanism this codebase did not have:
 * `payroll_permission_grant` is keyed by ROLE, and `lib/permissions.ts` SCREENS is a static matrix
 * with no backing table, so nothing persisted per-USER screen access before 0451.
 *
 * The module gate is checked FIRST and on its own, so a tenant that never bought the assistant gets
 * `module_off` without a grant lookup — the refusal never depends on, and therefore never discloses,
 * grant state.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { appUser, assistantGrant, person } from '../db/schema';
import { assertModuleEnabled, isModuleEnabled } from './entitlements';

export const ASSISTANT_MODULE = 'assistant';

export class AssistantGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantGrantError';
  }
}

/** The user holds the module but not a grant. Distinct from ModuleNotEnabledError on purpose: one is
 *  "your company did not buy this", the other is "your HR admin has not switched it on for you", and
 *  telling an employee the first when the truth is the second sends them to the wrong person. */
export class AssistantNotGrantedError extends AssistantGrantError {
  constructor() {
    super('The AI assistant has not been switched on for this user.');
    this.name = 'AssistantNotGrantedError';
  }
}

const isAdminCtx = (ctx: SessionContext) =>
  (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');

/** Defence in depth. RLS already refuses a non-admin write (0451's assistant_grant_write policy), but a
 *  service-layer check turns a 42501 into a sentence a screen can render. Note `operator` is NOT an
 *  admin here, matching app.is_admin() exactly — the two must not drift. */
function assertAdmin(ctx: SessionContext) {
  if (!isAdminCtx(ctx)) throw new AssistantGrantError('Only an admin can manage assistant access.');
}

// ───────────────────────────── the composed access answer ─────────────────────────────

export type AssistantAccess =
  | { allowed: true }
  | { allowed: false; reason: 'module_off' | 'no_user' | 'no_grant' };

/**
 * May THIS user ask the assistant? Both gates, in order, fail-closed at every step.
 *
 * Deliberately returns a reason rather than a boolean: the screen needs to say WHICH gate is shut, and
 * a bare false would make "not sold to your company" and "not switched on for you" indistinguishable.
 *
 * `isModuleEnabled` is used directly, NOT `isModuleEnabledOrFalse` (the drift test refuses that outside
 * app/), and NOT wrapped in a try. `assistant` is billable, so an EXEMPT context throws
 * EntitlementsExemptForBillableError here — which is the correct outcome and must not be swallowed: a
 * sweep or seeder asking whether a user may use the assistant has no business asking, and that error
 * exists precisely because a previous `return true` silently granted a paid module to every tenant.
 */
export async function mayUseAssistant(ctx: SessionContext): Promise<AssistantAccess> {
  if (!isModuleEnabled(ctx, ASSISTANT_MODULE)) return { allowed: false, reason: 'module_off' };
  // A context with no app_user cannot hold a per-user grant. app.current_user_id() would be NULL in the
  // transaction below and the self branch of the read policy would match nothing anyway — this is the
  // same answer, reached without a query and with a reason attached.
  if (!ctx.userId) return { allowed: false, reason: 'no_user' };
  const userId = ctx.userId;
  const live = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: assistantGrant.id })
      .from(assistantGrant)
      // THE app_user_id PREDICATE IS LOAD-BEARING AND IS NOT REDUNDANT WITH RLS. For an hr_admin the
      // read policy ORs in an admin branch that matches EVERY row in the tenant, so without this
      // comparison an admin would resolve `allowed: true` because SOMEBODY holds a grant.
      .where(and(eq(assistantGrant.appUserId, userId), isNull(assistantGrant.revokedAt)))
      .limit(1);
    return Boolean(row);
  });
  return live ? { allowed: true } : { allowed: false, reason: 'no_grant' };
}

/** The D3 service-boundary guard. Throws the SAME ModuleNotEnabledError every other module gate throws
 *  (so one catch clause on EntitlementError still covers the family) and AssistantNotGrantedError for
 *  the second gate. */
export async function assertMayUseAssistant(ctx: SessionContext): Promise<void> {
  assertModuleEnabled(ctx, ASSISTANT_MODULE); // throws ModuleNotEnabledError('assistant')
  const access = await mayUseAssistant(ctx);
  if (!access.allowed) throw new AssistantNotGrantedError();
}

// ───────────────────────────── admin administration ─────────────────────────────

export type AssistantGrantRow = {
  id: string;
  appUserId: string;
  name: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
};

/** Admin: every grant ever, newest first — revoked rows included, because "who could ask the assistant
 *  last March" is the reason revocation is a stamp. RLS gives a non-admin only their own row, so this
 *  doubles as the employee's own "do I have it?" read. */
export function listAssistantGrants(ctx: SessionContext): Promise<AssistantGrantRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: assistantGrant.id,
        appUserId: assistantGrant.appUserId,
        name: person.fullName,
        grantedAt: assistantGrant.grantedAt,
        revokedAt: assistantGrant.revokedAt,
      })
      .from(assistantGrant)
      .innerJoin(appUser, eq(appUser.id, assistantGrant.appUserId))
      .leftJoin(person, eq(person.id, appUser.personId))
      .orderBy(desc(assistantGrant.grantedAt)),
  );
}

/** Admin: switch the assistant on for one user. IDEMPOTENT — a second call on a live grant returns the
 *  existing row rather than inserting, because `assistant_grant_live_uq` admits only one live row per
 *  user and a blind insert would raise 23505 at the second click. */
export async function grantAssistant(
  ctx: SessionContext,
  p: { appUserId: string },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    assertAdmin(ctx);
    const [existing] = await tx
      .select({ id: assistantGrant.id })
      .from(assistantGrant)
      .where(and(eq(assistantGrant.appUserId, p.appUserId), isNull(assistantGrant.revokedAt)))
      .limit(1);
    if (existing) return { id: existing.id };
    // THE SELECT ABOVE IS NOT ENOUGH TO BE IDEMPOTENT, and this function's contract says it is.
    // Select-then-insert races `assistant_grant_live_uq`: two admins granting the same user at the same
    // moment — or one admin double-clicking — both find no live row, both insert, and the loser gets a
    // raw 23505 rendered to an admin screen. `onConflictDoNothing` makes the database the arbiter, and
    // the empty-returning case below is that loser taking the winner's row instead of failing.
    const [row] = await tx
      .insert(assistantGrant)
      .values({
        tenantId: ctx.tenantId,
        appUserId: p.appUserId,
        grantedByUserId: ctx.userId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: assistantGrant.id });
    if (!row) {
      // Lost the race. The other transaction's grant is live and equivalent, so re-read it rather than
      // reporting a failure for a state that is exactly what the caller asked for. No event is appended:
      // the winner already appended one, and two `granted` events for one grant would misreport history.
      const [won] = await tx
        .select({ id: assistantGrant.id })
        .from(assistantGrant)
        .where(and(eq(assistantGrant.appUserId, p.appUserId), isNull(assistantGrant.revokedAt)))
        .limit(1);
      if (won) return { id: won.id };
      throw new AssistantGrantError('The assistant grant could not be written — please try again.');
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'assistant-grant',
      aggregateId: row.id,
      eventType: 'assistant-grant.granted',
      actor: actorOf(ctx),
      payload: { appUserId: p.appUserId },
    });
    return { id: row.id };
  });
}

/** Admin: switch it off. A STAMP, never a delete — 0451 revokes DELETE from ai_hr_app so the database
 *  enforces that rather than this function. Idempotent: no live row is a no-op, not an error. */
export async function revokeAssistant(ctx: SessionContext, p: { appUserId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    assertAdmin(ctx);
    const [row] = await tx
      .update(assistantGrant)
      .set({ revokedAt: new Date(), revokedByUserId: ctx.userId ?? null })
      .where(and(eq(assistantGrant.appUserId, p.appUserId), isNull(assistantGrant.revokedAt)))
      .returning({ id: assistantGrant.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'assistant-grant',
      aggregateId: row.id,
      eventType: 'assistant-grant.revoked',
      actor: actorOf(ctx),
      payload: { appUserId: p.appUserId },
    });
  });
}
