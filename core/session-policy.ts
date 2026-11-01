import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { sessionPolicy } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { isGroupAdmin } from '../lib/authz-model';
import { DEFAULT_IDLE_TIMEOUT_MINUTES, validateIdleTimeoutMinutes } from '../lib/session-policy';

/** ADR-0171: the organization's group administrator owns its idle sign-out limit. */
export function assertSessionPolicyAdmin(ctx: SessionContext) {
  if (!ctx.userId || !isGroupAdmin(ctx)) throw new Error('forbidden');
}
export async function readSessionPolicyEditor(ctx: SessionContext) {
  assertSessionPolicyAdmin(ctx);
  return withTenant(ctx, async tx => {
    const [proof] = await tx.execute(sql`select app.principal_snapshot_current() as allowed`) as unknown as { allowed: boolean }[];
    if (!proof?.allowed) throw new Error('forbidden');
    const [row] = await tx.select().from(sessionPolicy).where(eq(sessionPolicy.tenantId, ctx.tenantId));
    return { revision: row?.revision ?? 0, idleTimeoutMinutes: row?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES };
  });
}
export async function saveSessionPolicy(ctx: SessionContext, value: unknown, expectedRevision: number) {
  assertSessionPolicyAdmin(ctx);
  const idleTimeoutMinutes = validateIdleTimeoutMinutes(value);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid');
  return withTenant(ctx, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`session-policy:${ctx.tenantId}`},0))`);
    const [proof] = await tx.execute(sql`select app.principal_snapshot_current() as allowed`) as unknown as { allowed: boolean }[];
    if (!proof?.allowed) throw new Error('forbidden');
    const [previous] = await tx.select().from(sessionPolicy).where(eq(sessionPolicy.tenantId, ctx.tenantId));
    if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('conflict');
    const revision = expectedRevision + 1;
    await tx.insert(sessionPolicy).values({ tenantId: ctx.tenantId, idleTimeoutMinutes, revision })
      .onConflictDoUpdate({ target: sessionPolicy.tenantId, set: { idleTimeoutMinutes, revision, updatedAt: new Date() } });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'session-policy', aggregateId: ctx.tenantId,
      eventType: 'session-policy.updated', actor: actorOf(ctx),
      payload: { revision, idleTimeoutMinutes, previousIdleTimeoutMinutes: previous?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES } });
    return { revision, idleTimeoutMinutes };
  });
}
