/**
 * Employee profile photograph (b4682879). A 1:1 photo stored in the person_photo bytea SIDE TABLE
 * (schema.ts), mirroring core/admin.ts company-logo exactly. PNG/JPEG only; the mime is sniffed from magic
 * bytes at the action boundary before it reaches here (SVG is excluded — scriptable).
 *
 * RLS (0164): READ = app.can_see_person(person_id) — the photo is visible EXACTLY where the employee's name
 * already is (self / admin / administrative-manager subtree), narrower than the tenant-wide logo read
 * because a face photo is personal data. WRITE = admin only (reporter §1.5: admins upload/replace/remove).
 *
 * Substrate: every write appends a DomainEvent (aggregateType 'person') with ONLY derived, non-PII payload
 * fields — never the bytes and never the raw user-supplied fileName (PDPA / ADR-0030 posture).
 */
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { personPhoto } from '../db/schema';

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB, same cap the company logo uses
export const ALLOWED_PHOTO_MIME = ['image/png', 'image/jpeg'] as const;

/** Fail-closed photo validation (empty / oversized / disallowed MIME). */
function assertValidPhoto(mimeType: string, content: Buffer): void {
  if (content.byteLength === 0) throw new Error('Empty file');
  if (content.byteLength > PHOTO_MAX_BYTES) throw new Error('Photo exceeds 2 MB');
  if (!(ALLOWED_PHOTO_MIME as readonly string[]).includes(mimeType)) {
    throw new Error('Only PNG or JPG images are allowed');
  }
}

/** Upsert a person's profile photo (insert-or-update on the unique person_id). Admin-write (RLS). */
export async function setPersonPhoto(
  ctx: SessionContext,
  p: { personId: string; content: Buffer; fileName: string; mimeType: string; sizeBytes: number },
) {
  assertValidPhoto(p.mimeType, p.content);
  return withTenant(ctx, async (tx) => {
    await tx
      .insert(personPhoto)
      .values({
        tenantId: ctx.tenantId,
        personId: p.personId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.sizeBytes,
        uploadedByUserId: ctx.userId ?? null,
      })
      .onConflictDoUpdate({
        target: personPhoto.personId,
        set: {
          content: p.content,
          fileName: p.fileName,
          mimeType: p.mimeType,
          sizeBytes: p.sizeBytes,
          uploadedByUserId: ctx.userId ?? null,
          updatedAt: sql`now()`,
        },
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: p.personId,
      eventType: 'person.photo.set',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      payload: { mimeType: p.mimeType, sizeBytes: p.sizeBytes },
    });
    return { personId: p.personId };
  });
}

/** Remove a person's profile photo. No-op-safe if none exists. */
export async function removePersonPhoto(ctx: SessionContext, p: { personId: string }) {
  return withTenant(ctx, async (tx) => {
    await tx.delete(personPhoto).where(eq(personPhoto.personId, p.personId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: p.personId,
      eventType: 'person.photo.removed',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      payload: { removed: true },
    });
    return { personId: p.personId };
  });
}

/** Read a person's photo bytes for the serve route (RLS scopes visibility to can_see_person). */
export async function getPersonPhoto(
  ctx: SessionContext,
  personId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ content: personPhoto.content, fileName: personPhoto.fileName, mimeType: personPhoto.mimeType })
      .from(personPhoto)
      .where(eq(personPhoto.personId, personId))
      .limit(1);
    return row ? { content: row.content, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

/** Lightweight existence check for rendering (never pulls the blob). Returns true if the person has a
 *  photo the caller may see (RLS-scoped). */
export async function hasPersonPhoto(ctx: SessionContext, personId: string): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: personPhoto.id })
      .from(personPhoto)
      .where(eq(personPhoto.personId, personId))
      .limit(1);
    return row != null;
  });
}
