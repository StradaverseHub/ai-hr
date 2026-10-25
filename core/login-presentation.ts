import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { loginPresentation } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { isGroupAdmin } from '../lib/authz-model';
import { DEFAULT_LOGIN_PRESENTATION, validateLoginPresentation } from '../lib/login-presentation';

export function assertLoginPresentationAdmin(ctx: SessionContext) {
  if (!ctx.userId || !isGroupAdmin(ctx)) throw new Error('forbidden');
}
export async function readLoginPresentationEditor(ctx: SessionContext) {
  assertLoginPresentationAdmin(ctx);
  return withTenant(ctx, async tx => {
    const [proof] = await tx.execute(sql`select app.principal_snapshot_current() as allowed`) as unknown as { allowed: boolean }[];
    if (!proof?.allowed) throw new Error('forbidden');
    const [row] = await tx.select().from(loginPresentation).where(eq(loginPresentation.tenantId, ctx.tenantId));
    return { revision: row?.revision ?? 0, presentation: row ? validateLoginPresentation(row.presentation) : DEFAULT_LOGIN_PRESENTATION };
  });
}
export async function saveLoginPresentation(ctx: SessionContext, value: unknown, expectedRevision: number) {
  assertLoginPresentationAdmin(ctx);
  const presentation = validateLoginPresentation(value);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid');
  return withTenant(ctx, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`login-presentation:${ctx.tenantId}`},0))`);
    const [proof] = await tx.execute(sql`select app.principal_snapshot_current() as allowed`) as unknown as { allowed: boolean }[];
    if (!proof?.allowed) throw new Error('forbidden');
    const [previous] = await tx.select().from(loginPresentation).where(eq(loginPresentation.tenantId, ctx.tenantId));
    if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('conflict');
    const revision = expectedRevision + 1;
    await tx.insert(loginPresentation).values({ tenantId: ctx.tenantId, presentation, revision })
      .onConflictDoUpdate({ target: loginPresentation.tenantId, set: { presentation, revision, updatedAt: new Date() } });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'login-presentation', aggregateId: ctx.tenantId,
      eventType: 'login-presentation.updated', actor: actorOf(ctx), payload: { revision, mediaType: presentation.mediaType } });
    return { revision };
  });
}
