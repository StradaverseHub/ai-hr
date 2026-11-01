/** One tenant-wide design owner. All writes lock the draft and compare its revision. Published snapshots are append-only. */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { mobileDesignAsset, mobileDesignDraft, mobileDesignRelease, tenant } from '../db/schema';
import { isGroupAdmin } from '../lib/authz-model';
import { DEFAULT_MOBILE_DESIGN, parseMobileDesign, resolveMobileDesign, type MobileBuilderState, type MobileDesign, type MobileDesignRelease, type MobileBackgrounds } from '../lib/mobile-design';

export class MobileDesignError extends Error {
  constructor(public readonly reason: 'forbidden' | 'conflict' | 'invalid_design' | 'missing_release') { super(reason); }
}
function admin(ctx: SessionContext): asserts ctx is SessionContext & { userId: string } { if (!ctx.userId || !isGroupAdmin(ctx)) throw new MobileDesignError('forbidden'); }
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new MobileDesignError('invalid_design');
  return Number(value);
}
export async function publishedMobileDesign(ctx: SessionContext, includeArtwork = false): Promise<MobileDesignRelease & { tenantId: string; artwork?: MobileBackgrounds }> {
  return withTenant(ctx, async tx => {
    const [r] = await tx.select().from(mobileDesignRelease).where(eq(mobileDesignRelease.tenantId, ctx.tenantId)).orderBy(desc(mobileDesignRelease.revision)).limit(1);
    const config = resolveMobileDesign(r?.config ?? DEFAULT_MOBILE_DESIGN);
    let artwork: MobileBackgrounds | undefined;
    if (includeArtwork && config.schemaVersion === 2 && config.backgrounds) {
      const ids = Object.values(config.backgrounds).filter((id): id is string => id !== null);
      const assets = ids.length ? await tx.select({ id: mobileDesignAsset.id, content: mobileDesignAsset.content }).from(mobileDesignAsset).where(and(eq(mobileDesignAsset.tenantId, ctx.tenantId), inArray(mobileDesignAsset.id, ids))) : [];
      const image = (id: string | null) => { const asset = assets.find(a => a.id === id); return asset ? 'data:image/jpeg;base64,' + asset.content.toString('base64') : null; };
      artwork = { light: image(config.backgrounds.light), dark: image(config.backgrounds.dark) };
    }
    return { tenantId: ctx.tenantId, revision: r?.revision ?? 0, publishedAt: r?.publishedAt.toISOString() ?? '', config, ...(artwork ? { artwork } : {}) };
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
    if (next.schemaVersion === 2 && next.backgrounds) {
      const ids = [...new Set(Object.values(next.backgrounds).filter((id): id is string => id !== null))];
      const owned = ids.length ? await tx.select({ id: mobileDesignAsset.id }).from(mobileDesignAsset).where(and(eq(mobileDesignAsset.tenantId, ctx.tenantId), inArray(mobileDesignAsset.id, ids))) : [];
      if (owned.length !== ids.length) throw new MobileDesignError('invalid_design');
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
