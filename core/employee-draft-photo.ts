/**
 * The Draft Employee page's profile photo — board 2c1b2fba (approved plan item 3, migration 7610).
 *
 * A draft creates no person, and `person_photo` is keyed to one, so the photo waits in its own 1:1 side table
 * (`employee_draft_photo`) — never inside the draft JSON — until Activate moves it onto the new person through the
 * canonical owner (`setPersonPhotoTx`, core/person-photo.ts) inside the activation transaction. Deleting the draft row
 * (Activate or Discard) removes this row by ON DELETE CASCADE.
 *
 * SAME RULES AS THE RECORD'S PHOTO: PNG or JPEG only, the type sniffed from the bytes, at most 2 MB
 * (`assertValidPhoto`, the one validator both tables use). SAME AUTHORITY AS THE RECORD'S UPLOAD: an HR administrator
 * with Workforce maintain for the draft's company. Row security (7610) additionally keeps the row exactly as visible
 * as its draft. Audit payloads carry only the type and size, never the bytes or the file name (PDPA posture).
 */
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, withTenantWriteWork, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employeeDraft, employeeDraftPhoto } from '../db/schema';
import { isAdmin } from '../lib/authz-model';
import { lockAccessConfigurationTx } from './access-configuration-lock';
import { assertWorkforceCompanyTx } from './workforce-access';
import { assertValidPhoto } from './person-photo';

export type DraftPhotoRefusal = 'permission' | 'unavailable' | 'invalid' | 'too_large' | 'type';
export class DraftPhotoError extends Error {
  constructor(readonly reason: DraftPhotoRefusal) {
    super(`Draft photo refused: ${reason}`);
    this.name = 'DraftPhotoError';
  }
}

/** The draft row, locked, and its company's Workforce maintain authority — the writers' common entry. */
async function writableDraftTx(tx: Tx, ctx: SessionContext, draftId: string): Promise<{ companyId: string }> {
  if (!isAdmin(ctx)) throw new DraftPhotoError('permission');
  await lockAccessConfigurationTx(tx, ctx.tenantId);
  const [draft] = await tx
    .select({ companyId: employeeDraft.companyId })
    .from(employeeDraft)
    .where(and(eq(employeeDraft.id, draftId), eq(employeeDraft.tenantId, ctx.tenantId)))
    .for('update');
  if (!draft?.companyId) throw new DraftPhotoError('unavailable');
  await assertWorkforceCompanyTx(tx, ctx, draft.companyId, 'maintain');
  return { companyId: draft.companyId };
}

function validated(p: { content: Buffer; mimeType: string; sizeBytes: number }) {
  if (p.content.byteLength === 0 || p.sizeBytes !== p.content.byteLength) throw new DraftPhotoError('invalid');
  try {
    assertValidPhoto(p.mimeType, p.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    throw new DraftPhotoError(message.includes('2 MB') ? 'too_large' : message.includes('Empty') ? 'invalid' : 'type');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Upload or replace the draft's photo. One row per draft (upsert on draft_id). */
export async function setEmployeeDraftPhoto(
  ctx: SessionContext,
  p: { draftId: string; content: Buffer; fileName: string; mimeType: string; sizeBytes: number },
): Promise<void> {
  if (!isAdmin(ctx)) throw new DraftPhotoError('permission');
  if (!UUID_RE.test(p.draftId)) throw new DraftPhotoError('unavailable');
  validated(p);
  const fileName = (p.fileName || 'photo').slice(0, 255);
  await withTenantWriteWork(ctx.tenantId, () =>
    withTenant(ctx, async (tx) => {
      const { companyId } = await writableDraftTx(tx, ctx, p.draftId);
      await tx
        .insert(employeeDraftPhoto)
        .values({
          tenantId: ctx.tenantId,
          draftId: p.draftId,
          content: p.content,
          fileName,
          mimeType: p.mimeType,
          sizeBytes: p.sizeBytes,
          uploadedByUserId: ctx.userId ?? null,
        })
        .onConflictDoUpdate({
          target: employeeDraftPhoto.draftId,
          set: { content: p.content, fileName, mimeType: p.mimeType, sizeBytes: p.sizeBytes, uploadedByUserId: ctx.userId ?? null, updatedAt: sql`now()` },
        });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employee-draft',
        aggregateId: p.draftId,
        eventType: 'employee-draft.photo.set',
        actor: actorOf(ctx),
        payload: { companyId, mimeType: p.mimeType, sizeBytes: p.sizeBytes },
      });
    }),
  );
}

/** Remove the draft's photo. Removing a photo that is not there is a no-op (no event). */
export async function removeEmployeeDraftPhoto(ctx: SessionContext, draftId: string): Promise<void> {
  if (!isAdmin(ctx)) throw new DraftPhotoError('permission');
  if (!UUID_RE.test(draftId)) throw new DraftPhotoError('unavailable');
  await withTenantWriteWork(ctx.tenantId, () =>
    withTenant(ctx, async (tx) => {
      const { companyId } = await writableDraftTx(tx, ctx, draftId);
      const removed = await tx.delete(employeeDraftPhoto).where(eq(employeeDraftPhoto.draftId, draftId)).returning({ id: employeeDraftPhoto.id });
      if (removed.length === 0) return;
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employee-draft',
        aggregateId: draftId,
        eventType: 'employee-draft.photo.removed',
        actor: actorOf(ctx),
        payload: { companyId },
      });
    }),
  );
}

/** The photo bytes for the draft page's <img>. Admin only; row security keeps it to drafts the caller can see. */
export async function getEmployeeDraftPhoto(
  ctx: SessionContext,
  draftId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  if (!isAdmin(ctx) || !UUID_RE.test(draftId)) return null;
  return withTenant(ctx, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [row] = await tx
      .select({ content: employeeDraftPhoto.content, fileName: employeeDraftPhoto.fileName, mimeType: employeeDraftPhoto.mimeType })
      .from(employeeDraftPhoto)
      .where(and(eq(employeeDraftPhoto.draftId, draftId), eq(employeeDraftPhoto.tenantId, ctx.tenantId)))
      .limit(1);
    return row ?? null;
  });
}

/** Existence only (never the bytes), for rendering the header card. */
export async function hasEmployeeDraftPhoto(ctx: SessionContext, draftId: string): Promise<boolean> {
  if (!isAdmin(ctx) || !UUID_RE.test(draftId)) return false;
  return withTenant(ctx, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [row] = await tx
      .select({ id: employeeDraftPhoto.id })
      .from(employeeDraftPhoto)
      .where(and(eq(employeeDraftPhoto.draftId, draftId), eq(employeeDraftPhoto.tenantId, ctx.tenantId)))
      .limit(1);
    return row != null;
  });
}

/** Activation's read of the locked draft's photo, inside the activation transaction. */
export async function draftPhotoForActivationTx(tx: Tx, ctx: SessionContext, draftId: string) {
  const [row] = await tx
    .select({ content: employeeDraftPhoto.content, fileName: employeeDraftPhoto.fileName, mimeType: employeeDraftPhoto.mimeType, sizeBytes: employeeDraftPhoto.sizeBytes })
    .from(employeeDraftPhoto)
    .where(and(eq(employeeDraftPhoto.draftId, draftId), eq(employeeDraftPhoto.tenantId, ctx.tenantId)))
    .for('update');
  return row ?? null;
}
