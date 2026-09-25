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
import { eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { employment, personPhoto } from '../db/schema';

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

/**
 * 597c810a — WHICH of these employments' people have a photo, in ONE query. This is THE bulk photo read;
 * there is deliberately no person-keyed twin (see the note at the end).
 *
 * WHY A BULK READ AND NOT `hasPersonPhoto` PER ROW: production holds 89 persons and 2 photos, so the naive
 * version issues 89 HTTP requests per list load, 87 of which are 404s that each cost a session read and an
 * RLS-scoped query. This is one round trip for the whole page.
 *
 * WHY IT IS KEYED BY EMPLOYMENT. Both Personnel listings render rows from `core/read.ts#listEmployeesPage`,
 * whose projection carries `employmentId` and no `personId`, and the photo route is keyed by person (a photo
 * is a PERSON fact — concurrent employments share one). Rather than widen that projection, this resolves the
 * two together: one query joins employment → person_photo and returns employmentId → personId for the
 * employments whose person has a photo the caller may see. The Map's VALUE is what the row needs anyway (the
 * serve URL is `/personnel/photo/<personId>`), so the caller never has to hold a second lookup.
 *
 * THIS IS NOT A WAY TO PROBE EXISTENCE OUTSIDE `can_see_person`. The predicate is RLS's, not a filter this
 * function applies, and it is the person_photo side of the join that fences it: employment is readable more
 * widely than a face photo is, so an employment whose person is outside app.can_see_person yields no joined
 * photo row and is simply absent from the Map — indistinguishable from "has no photo". An employment id from
 * another tenant, or one the caller cannot see, therefore tells the caller nothing.
 *
 * An empty input list short-circuits (an `inArray` on an empty array is a SQL syntax error in some dialects
 * and a pointless round trip in all).
 *
 * WHAT WENT AND WHY (r340 fix pass): `personsWithPhotos`, the person-keyed twin of this function, shipped
 * in 597c810a with tests and NO caller — nothing in app/, components/ or lib/ ever asked for it, because
 * both listings hold employment ids and the eleven other avatars on the product are out of this item's
 * scope. It was the TESTED path while this one was the live path, which is the wrong way round; its
 * scope cases (cross-tenant, non-admin, duplicate and blank ids) moved onto this function in
 * test/person-photo-bulk-597c810a.test.ts rather than being deleted with it.
 */
export async function employmentPhotoIds(
  ctx: SessionContext,
  employmentIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(employmentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return new Map();
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ employmentId: employment.id, personId: personPhoto.personId })
      .from(employment)
      .innerJoin(personPhoto, eq(personPhoto.personId, employment.personId))
      .where(inArray(employment.id, ids));
    return new Map(rows.map((r) => [r.employmentId, r.personId]));
  });
}
