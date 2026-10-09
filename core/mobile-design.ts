/** One tenant-wide design owner. All writes lock the draft and compare its revision. Published snapshots are append-only. */
import { and, desc, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { mobileDesignDraft, mobileDesignRelease, tenant } from '../db/schema';
import { isGroupAdmin } from '../lib/authz';
import { DEFAULT_MOBILE_DESIGN, parseMobileDesign, resolveMobileDesign, type MobileBuilderState, type MobileDesign, type MobileDesignRelease } from '../lib/mobile-design';

export class MobileDesignError extends Error {
  constructor(public readonly reason: 'forbidden' | 'conflict' | 'invalid_design' | 'missing_release') { super(reason); }
}
function admin(ctx: SessionContext): asserts ctx is SessionContext & { userId: string } { if (!ctx.userId || !isGroupAdmin(ctx)) throw new MobileDesignError('forbidden'); }
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new MobileDesignError('invalid_design');
  return Number(value);
}
export async function publishedMobileDesign(ctx: SessionContext): Promise<MobileDesignRelease & { tenantId: string }> {
  return withTenant(ctx, async tx => {
    const [r] = await tx.select().from(mobileDesignRelease).where(eq(mobileDesignRelease.tenantId, ctx.tenantId)).orderBy(desc(mobileDesignRelease.revision)).limit(1);
    return { tenantId: ctx.tenantId, revision: r?.revision ?? 0, publishedAt: r?.publishedAt.toISOString() ?? '', config: resolveMobileDesign(r?.config ?? DEFAULT_MOBILE_DESIGN) };
  });
}
export async function mobileBuilderState(ctx: SessionContext): Promise<MobileBuilderState> {
  admin(ctx);
  return withTenant(ctx, async tx => {
    const [tenantRow] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, ctx.tenantId));
    const [d] = await tx.select().from(mobileDesignDraft).where(eq(mobileDesignDraft.tenantId, ctx.tenantId)).for('share');
    const releases = await tx.select().from(mobileDesignRelease).where(eq(mobileDesignRelease.tenantId, ctx.tenantId)).orderBy(desc(mobileDesignRelease.revision)).limit(20);
    return { tenantName: tenantRow?.name ?? ctx.tenantId, draft: resolveMobileDesign(d?.config ?? DEFAULT_MOBILE_DESIGN), draftRevision: d?.revision ?? 0,
      releases: releases.map(r => ({ revision: r.revision, publishedAt: r.publishedAt.toISOString(), config: resolveMobileDesign(r.config) })) };
  });
}
export async function changeMobileDesign(ctx: SessionContext, command: 'save' | 'publish' | 'rollback', expected: unknown, value?: unknown): Promise<void> {
  admin(ctx);
  const expectedRevision = revision(expected);
  if (!['save', 'publish', 'rollback'].includes(command)) throw new MobileDesignError('invalid_design');
  let config: MobileDesign | undefined;
  if (command === 'save') {
    try { config = parseMobileDesign(value); } catch { throw new MobileDesignError('invalid_design'); }
  }
  const rollbackRevision = command === 'rollback' ? revision(value) : 0;
  await withTenant(ctx, async tx => {
    await tx.insert(mobileDesignDraft).values({ tenantId: ctx.tenantId, config: DEFAULT_MOBILE_DESIGN, revision: 0 }).onConflictDoNothing();
    const [draft] = await tx.select().from(mobileDesignDraft).where(eq(mobileDesignDraft.tenantId, ctx.tenantId)).for('update');
    if (!draft || draft.revision !== expectedRevision) throw new MobileDesignError('conflict');
    let next = config ?? resolveMobileDesign(draft.config);
    if (command === 'rollback') {
      const [old] = await tx.select().from(mobileDesignRelease).where(and(eq(mobileDesignRelease.tenantId, ctx.tenantId), eq(mobileDesignRelease.revision, rollbackRevision)));
      if (!old) throw new MobileDesignError('missing_release');
      next = parseMobileDesign(old.config);
    }
    let releaseRevision: number | null = null;
    if (command !== 'save') {
      const [last] = await tx.select({ revision: mobileDesignRelease.revision }).from(mobileDesignRelease).where(eq(mobileDesignRelease.tenantId, ctx.tenantId)).orderBy(desc(mobileDesignRelease.revision)).limit(1);
      releaseRevision = (last?.revision ?? 0) + 1;
      await tx.insert(mobileDesignRelease).values({ tenantId: ctx.tenantId, revision: releaseRevision, config: next, publishedBy: ctx.userId });
    }
    await tx.update(mobileDesignDraft).set({ config: next, revision: draft.revision + 1, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(mobileDesignDraft.tenantId, ctx.tenantId));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'mobile-design', aggregateId: ctx.tenantId,
      eventType: `mobile-design.${command}`, actor: actorOf(ctx), payload: { draftRevision: draft.revision + 1, releaseRevision, ...(command === 'rollback' ? { restoredRevision: rollbackRevision } : {}) } });
  });
}
