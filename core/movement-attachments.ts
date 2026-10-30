/**
 * 1d58019a Step 2 (ADR-0166) — supporting documents on a movement: storage and validation.
 *
 * FOLLOWS THE EXISTING ATTACHMENT OWNERS. core/profile-attachments.ts (validation by declared type AND by the
 * file's own leading bytes, bounded size, bytes in a tenant-RLS row) and the leave attachment's size/type
 * gate. A movement document is append-only evidence: there is no update or delete grant (migration 0721), and
 * a correction carries the corrected movement's documents forward as COPIES so the rolled-back record keeps
 * its own.
 *
 * KEYED BY THE MOVEMENT'S GROUP ID. Every leg of one movement shares MovementTag.groupId, a scheduled movement
 * carries it from the moment it is keyed and the sweep writes its legs under it, so one key covers a movement
 * applied on save, a pending one and the same one after it applies.
 *
 * THIS MODULE IS A LEAF and makes no visibility decision of its own beyond RLS. The authorized readers live
 * in core/movement.ts (movementAttachments / readMovementAttachment), which apply Employment History's own
 * visibility: an admin with workforce view of the employee, a document of a movement that employee's
 * history shows, and — through the table's read policy — pay access for a document filed against a pay field.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { movementAttachment } from '../db/schema';
import {
  MOVEMENT_DOCUMENT_MAX_BYTES,
  MOVEMENT_DOCUMENT_MAX_FILES,
  MOVEMENT_DOCUMENT_MIME_TYPES,
  MOVEMENT_DOCUMENT_TOTAL_MAX_BYTES,
  isMovementRuleField,
  type MovementRuleField,
} from '../lib/movement-field-rules';

/** One uploaded document, as the server action hands it to the movement writer. */
export type MovementDocumentUpload = { field: string; fileName: string; mimeType: string; content: Buffer };

export class MovementDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementDocumentError';
  }
}

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  'image/jpeg': (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff',
};

/**
 * Refuse anything that is not a small PDF, PNG or JPEG named for one comparison field. The declared type
 * must match the file's own leading bytes, so a renamed executable is not a "PDF". Returns the documents
 * with trimmed names. An empty list is valid (no documents).
 */
export function validateMovementDocuments(raw: readonly MovementDocumentUpload[] | undefined): (MovementDocumentUpload & { field: MovementRuleField })[] {
  const docs = raw ?? [];
  if (!Array.isArray(docs)) throw new MovementDocumentError('The supporting documents could not be read.');
  if (docs.length > MOVEMENT_DOCUMENT_MAX_FILES) {
    throw new MovementDocumentError(`Attach at most ${MOVEMENT_DOCUMENT_MAX_FILES} supporting documents to one movement.`);
  }
  let total = 0;
  return docs.map((d) => {
    if (!d || typeof d.field !== 'string' || !isMovementRuleField(d.field)) {
      throw new MovementDocumentError('A supporting document must belong to one of the fields this movement changes.');
    }
    const fileName = typeof d.fileName === 'string' ? d.fileName.trim() : '';
    if (!fileName || fileName.length > 200 || /[\\/\u0000-\u001f]/.test(fileName)) {
      throw new MovementDocumentError('A supporting document has a file name that cannot be stored.');
    }
    if (!Buffer.isBuffer(d.content) || !d.content.length) throw new MovementDocumentError('A supporting document is empty.');
    if (d.content.length > MOVEMENT_DOCUMENT_MAX_BYTES) {
      throw new MovementDocumentError(`Each supporting document must be ${MOVEMENT_DOCUMENT_MAX_BYTES / (1024 * 1024)} MB or smaller.`);
    }
    total += d.content.length;
    if (total > MOVEMENT_DOCUMENT_TOTAL_MAX_BYTES) {
      throw new MovementDocumentError(`Supporting documents for one movement must total ${MOVEMENT_DOCUMENT_TOTAL_MAX_BYTES / (1024 * 1024)} MB or less.`);
    }
    if (!(MOVEMENT_DOCUMENT_MIME_TYPES as readonly string[]).includes(d.mimeType) || !MAGIC[d.mimeType]?.(d.content)) {
      throw new MovementDocumentError('Supporting documents must be PDF, PNG or JPG files.');
    }
    return { field: d.field, fileName, mimeType: d.mimeType, content: d.content };
  });
}

/** Store validated documents against a movement. RLS: admin, workforce maintain, pay write for a pay field. */
export async function saveMovementAttachmentsTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  movementGroupId: string,
  docs: readonly (MovementDocumentUpload & { field: MovementRuleField })[],
): Promise<void> {
  for (const d of docs) {
    await tx.insert(movementAttachment).values({
      tenantId: ctx.tenantId,
      employmentId,
      movementGroupId,
      field: d.field,
      fileName: d.fileName,
      mimeType: d.mimeType,
      sizeBytes: d.content.length,
      content: d.content,
      uploadedBy: ctx.userId ?? null,
    });
  }
}

/** The fields a movement already has documents for (a correction counts them towards "required"). */
export async function movementAttachmentFieldsTx(
  tx: Tx,
  tenantId: string,
  employmentId: string,
  movementGroupId: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ field: movementAttachment.field })
    .from(movementAttachment)
    .where(
      and(
        eq(movementAttachment.tenantId, tenantId),
        eq(movementAttachment.employmentId, employmentId),
        eq(movementAttachment.movementGroupId, movementGroupId),
      ),
    );
  return rows.map((r) => r.field);
}

/**
 * A correction re-records the movement under a new group id. Its documents for `fields` are COPIED to the new
 * group (the corrected-away movement keeps its own, as evidence of what it was). Copies are made by the
 * database from the rows this caller can read, so a document the caller cannot see is never copied.
 */
export async function carryMovementAttachmentsTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  fromGroupId: string,
  toGroupId: string,
  fields: readonly string[],
): Promise<void> {
  if (!fields.length || fromGroupId === toGroupId) return;
  await tx.execute(sql`
    INSERT INTO movement_attachment (tenant_id, employment_id, movement_group_id, field, file_name, mime_type, size_bytes, content, uploaded_by)
    SELECT tenant_id, employment_id, ${toGroupId}::uuid, field, file_name, mime_type, size_bytes, content, ${ctx.userId ?? null}::uuid
      FROM movement_attachment
     WHERE tenant_id = ${ctx.tenantId}::uuid
       AND employment_id = ${employmentId}::uuid
       AND movement_group_id = ${fromGroupId}::uuid
       AND field IN (${sql.join(fields.map((f) => sql`${f}`), sql`, `)})
     ORDER BY created_at, id`);
}

export type MovementAttachmentSummary = {
  id: string;
  field: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

/** The documents of the given movement groups that RLS lets this caller read. */
export async function listMovementAttachmentsTx(
  tx: Tx,
  tenantId: string,
  employmentId: string,
  movementGroupIds: readonly string[],
): Promise<(MovementAttachmentSummary & { movementGroupId: string })[]> {
  if (!movementGroupIds.length) return [];
  return tx
    .select({
      id: movementAttachment.id,
      movementGroupId: movementAttachment.movementGroupId,
      field: movementAttachment.field,
      fileName: movementAttachment.fileName,
      mimeType: movementAttachment.mimeType,
      sizeBytes: movementAttachment.sizeBytes,
      createdAt: movementAttachment.createdAt,
    })
    .from(movementAttachment)
    .where(
      and(
        eq(movementAttachment.tenantId, tenantId),
        eq(movementAttachment.employmentId, employmentId),
        inArray(movementAttachment.movementGroupId, [...movementGroupIds]),
      ),
    )
    .orderBy(asc(movementAttachment.createdAt), asc(movementAttachment.id));
}

/** One document's bytes, if RLS lets this caller read it; null otherwise (never says why). */
export async function readMovementAttachmentRowTx(tx: Tx, tenantId: string, employmentId: string, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [row] = await tx
    .select({
      movementGroupId: movementAttachment.movementGroupId,
      fileName: movementAttachment.fileName,
      mimeType: movementAttachment.mimeType,
      content: movementAttachment.content,
    })
    .from(movementAttachment)
    .where(
      and(
        eq(movementAttachment.id, id),
        eq(movementAttachment.tenantId, tenantId),
        eq(movementAttachment.employmentId, employmentId),
      ),
    )
    .limit(1);
  return row ?? null;
}
