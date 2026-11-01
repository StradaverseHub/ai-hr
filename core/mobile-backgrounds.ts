/** Trusted raster normalization for tenant mobile presentation. No network or executable formats. */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { mobileDesignAsset, mobileDesignDraft } from '../db/schema';
import { isGroupAdmin } from '../lib/authz-model';
import { DEFAULT_MOBILE_DESIGN } from '../lib/mobile-design';
export const MOBILE_BACKGROUND_INPUT_BYTES = 4 * 1024 * 1024;
export const MOBILE_BACKGROUND_OUTPUT_BYTES = 240000;
export async function normalizeMobileBackground(input: Uint8Array): Promise<string> {
  if (!input.byteLength || input.byteLength > MOBILE_BACKGROUND_INPUT_BYTES) throw new Error('invalid_background');
  const bytes = Buffer.from(input);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error('invalid_background');
  const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning', animated: false });
  const metadata = await image.metadata();
  if (!['jpeg', 'png'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width > 6000 || metadata.height > 6000) throw new Error('invalid_background');
  // Re-encoding strips uploaded metadata and trailing content; original uploads are never delivered to phones.
  for (const quality of [82, 72, 62]) {
    const output = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' }).rotate().resize(720, 1280, { fit: 'cover' }).jpeg({ quality, progressive: true }).toBuffer();
    if (output.byteLength <= MOBILE_BACKGROUND_OUTPUT_BYTES) return 'data:image/jpeg;base64,' + output.toString('base64');
  }
  throw new Error('invalid_background');
}

export class MobileArtworkError extends Error {
  constructor(public readonly reason: 'forbidden' | 'backgroundInvalid' | 'backgroundLimit') { super(reason); }
}
export async function uploadMobileBackground(ctx: SessionContext, bytes: Uint8Array): Promise<{ id: string }> {
  if (!ctx.userId || !isGroupAdmin(ctx)) throw new MobileArtworkError('forbidden');
  let normalized: string;
  try { normalized = await normalizeMobileBackground(bytes); } catch { throw new MobileArtworkError('backgroundInvalid'); }
  const content = Buffer.from(normalized.slice('data:image/jpeg;base64,'.length), 'base64');
  const sha256 = createHash('sha256').update(content).digest('hex');
  return withTenant(ctx, async tx => {
    // The same tenant draft lock serializes the library quota and its publisher; no caller-supplied tenant key.
    await tx.insert(mobileDesignDraft).values({ tenantId: ctx.tenantId, config: DEFAULT_MOBILE_DESIGN, revision: 0, updatedBy: ctx.userId }).onConflictDoNothing();
    await tx.select({ revision: mobileDesignDraft.revision }).from(mobileDesignDraft).where(eq(mobileDesignDraft.tenantId, ctx.tenantId)).for('update');
    const [existing] = await tx.select({ id: mobileDesignAsset.id }).from(mobileDesignAsset).where(and(eq(mobileDesignAsset.tenantId, ctx.tenantId), eq(mobileDesignAsset.sha256, sha256)));
    if (existing) return existing;
    const [usage] = await tx.select({ bytes: sql<string>`coalesce(sum(${mobileDesignAsset.sizeBytes}),0)` }).from(mobileDesignAsset).where(eq(mobileDesignAsset.tenantId, ctx.tenantId));
    if (Number(usage.bytes) + content.byteLength > 32 * 1024 * 1024) throw new MobileArtworkError('backgroundLimit');
    const [asset] = await tx.insert(mobileDesignAsset).values({ tenantId: ctx.tenantId, content, sha256, sizeBytes: content.byteLength, uploadedBy: ctx.userId! }).returning({ id: mobileDesignAsset.id });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'mobile-design', aggregateId: ctx.tenantId, eventType: 'mobile-design.asset-uploaded', actor: actorOf(ctx), payload: { assetId: asset.id, sha256, sizeBytes: content.byteLength } });
    return asset;
  });
}
/** RLS exposes own unpublished assets to group admins, and published artwork to own employees. */
export async function readMobileBackground(ctx: SessionContext, id: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  return withTenant(ctx, async tx => {
    const [asset] = await tx.select({ content: mobileDesignAsset.content }).from(mobileDesignAsset).where(and(eq(mobileDesignAsset.id, id), eq(mobileDesignAsset.tenantId, ctx.tenantId)));
    return asset?.content ?? null;
  });
}
