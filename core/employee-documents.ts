import {assertWorkforceEmploymentTx} from './workforce-access';
import {lockAccessConfigurationTx} from './access-configuration-lock';
/**
 * General employee document store (f018ce8d — Personnel → Documents tab redesign).
 *
 * The Documents tab used to render a read-only copy of statutory identifiers. It is now a real document
 * repository: HR uploads categorized supporting documents against an employee (PDF / Word / Excel /
 * PowerPoint / images / text), can edit their metadata, replace the attachment, download and delete them.
 * Backing table `employee_document` (0183) mirrors claim_attachment / review_document — bytea content in a
 * side table, employment_id denormalized so RLS resolves via app.can_see_employment directly.
 *
 * Authorization: reads are RLS-scoped (subject + administrative-line manager + admin); every WRITE is
 * admin-only, enforced BOTH here (role gate) and by the RLS WITH CHECK (app.is_admin()) — defence in depth.
 *
 * Substrate discipline: every write appends a DomainEvent (upload / meta-update / content-replace / delete)
 * with the file bytes kept OUT of the payload. Downloads append a lightweight `.downloaded` event too — a
 * deliberate, PDPA-justified exception to the "reads emit nothing" rule, because expected_function §6
 * requires an audit trail for document downloads.
 */
import {randomUUID} from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext,type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { appUser, employeeDocument, person,employment,letterArtifact,letterRecord } from '../db/schema';

export class EmployeeDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeDocumentError';
  }
}

/** Purpose-bound filing of a sealed approved Letter. This grants no generic Personnel
 * upload/read authority and stores only a protected artifact pointer, never a byte copy. */
export async function fileLetterArtifactTx(tx:Tx,ctx:SessionContext,input:{letterId:string;artifactId:string}){
 if(!ctx.userId)throw new EmployeeDocumentError('Letter filing permission unavailable.');
 const [target]=await tx.execute<{employment_id:string;title:string;category:string;description:string;file_name:string;size_bytes:number;document_id:string|null}>(sql`select * from app.letter_document_filing_target(${input.letterId}::uuid,${input.artifactId}::uuid)`);
 if(!target)throw new EmployeeDocumentError('Letter filing permission unavailable.');if(target.document_id)return target.document_id;const documentId=randomUUID();
 await tx.insert(employeeDocument).values({id:documentId,tenantId:ctx.tenantId,employmentId:target.employment_id,letterArtifactId:input.artifactId,title:target.title,category:target.category,description:target.description,content:Buffer.alloc(0),fileName:target.file_name,mimeType:'application/pdf',sizeBytes:target.size_bytes,uploadedByUserId:ctx.userId,updatedByUserId:ctx.userId});
 return documentId;
}

/** Configurable max upload size (bytes). Reuses the 10 MB ceiling shared by claim_attachment /
 *  review_document; a per-tenant override is a follow-up. */
export const EMPLOYEE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Supported document formats keyed by lower-case file extension → { mime, magic }. `magic` names the
 * magic-byte family the file's leading bytes MUST match (cross-checked against the extension in
 * `resolveDocumentUpload`, fail-closed): 'pdf' (%PDF), 'zip' (Office Open XML docx/xlsx/pptx — all ZIP
 * containers, so the extension disambiguates the mime), 'ole' (legacy OLE compound doc/xls/ppt), 'jpeg',
 * 'png', or 'text' (plain text has no reliable signature → accepted on extension + a printable-bytes check).
 */
const DOC_TYPES: Record<string, { mime: string; magic: 'pdf' | 'zip' | 'ole' | 'jpeg' | 'png' | 'text' }> = {
  pdf: { mime: 'application/pdf', magic: 'pdf' },
  doc: { mime: 'application/msword', magic: 'ole' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: 'zip' },
  xls: { mime: 'application/vnd.ms-excel', magic: 'ole' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: 'zip' },
  ppt: { mime: 'application/vnd.ms-powerpoint', magic: 'ole' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: 'zip' },
  jpg: { mime: 'image/jpeg', magic: 'jpeg' },
  jpeg: { mime: 'image/jpeg', magic: 'jpeg' },
  png: { mime: 'image/png', magic: 'png' },
  txt: { mime: 'text/plain', magic: 'text' },
};

/** The full set of mime types this store will ever persist — the service-side allowlist (second gate
 *  after `resolveDocumentUpload`; the sniff already guarantees membership, this stays fail-closed). */
export const ALLOWED_EMPLOYEE_DOCUMENT_MIME = [...new Set(Object.values(DOC_TYPES).map((d) => d.mime))] as const;

/** Human-readable accept attribute for the file input (extensions + mimes). */
export const EMPLOYEE_DOCUMENT_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.txt,application/pdf,image/jpeg,image/png,text/plain';

/** Classify a file's leading bytes into a magic family (null = unrecognized binary signature). */
function sniffMagic(bytes: Buffer): 'pdf' | 'zip' | 'ole' | 'jpeg' | 'png' | null {
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === '%PDF') return 'pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  // ZIP container (Office Open XML docx/xlsx/pptx): PK\x03\x04, plus empty (PK\x05\x06) / spanned (PK\x07\x08).
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) return 'zip';
  // OLE2 compound file (legacy doc/xls/ppt): D0 CF 11 E0 A1 B1 1A E1.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1
  ) return 'ole';
  return null;
}

/** True when the buffer looks like text (no NUL bytes in the sampled prefix). Plain text has no magic
 *  signature, so a .txt upload is accepted only if it is plausibly textual — blocking a binary renamed .txt. */
function looksLikeText(bytes: Buffer): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

/**
 * Resolve an upload's trustworthy mime from its extension cross-checked against its magic bytes
 * (fail-closed). Throws EmployeeDocumentError on an unsupported extension or a content/extension mismatch.
 * Pure + exported so the server action and unit tests share exactly one validation path.
 */
export function resolveDocumentUpload(fileName: string, bytes: Buffer): { mimeType: string } {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const spec = DOC_TYPES[ext];
  if (!spec) {
    throw new EmployeeDocumentError('Unsupported file type. Allowed: PDF, Word, Excel, PowerPoint, JPG, PNG, TXT.');
  }
  if (spec.magic === 'text') {
    if (!looksLikeText(bytes)) throw new EmployeeDocumentError('This .txt file does not contain valid text.');
    return { mimeType: spec.mime };
  }
  const magic = sniffMagic(bytes);
  if (magic !== spec.magic) {
    throw new EmployeeDocumentError('The file contents do not match its extension.');
  }
  return { mimeType: spec.mime };
}

function assertAdmin(ctx: SessionContext): void {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new EmployeeDocumentError('Only an admin can manage employee documents.');
  }
}

function assertValidEmployeeDocument(mimeType: string, content: Buffer): void {
  if (content.byteLength === 0) throw new EmployeeDocumentError('Empty file');
  if (content.byteLength > EMPLOYEE_DOCUMENT_MAX_BYTES) throw new EmployeeDocumentError('File exceeds 10 MB');
  if (!(ALLOWED_EMPLOYEE_DOCUMENT_MIME as readonly string[]).includes(mimeType)) {
    throw new EmployeeDocumentError('Unsupported file type.');
  }
}

function cleanTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new EmployeeDocumentError('Document name / title is required.');
  return title.slice(0, 200);
}

// ─── Writes ───────────────────────────────────────────────────────────────────────────────────────────

/** Upload one document against an employee (admin-only). Title is mandatory; category/description optional. */
export async function addEmployeeDocument(
  ctx: SessionContext,
  p: {
    employmentId: string;
    title: string;
    category?: string | null;
    description?: string | null;
    fileName: string;
    mimeType: string;
    content: Buffer;
  },
): Promise<{ id: string }> {
  assertAdmin(ctx);
  const title = cleanTitle(p.title);
  assertValidEmployeeDocument(p.mimeType, p.content);
  return withTenant(ctx, async (tx) => {
    await assertWorkforceEmploymentTx(tx, ctx, p.employmentId, 'maintain');
    const [row] = await tx
      .insert(employeeDocument)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        title,
        category: p.category?.trim() || null,
        description: p.description?.trim() || null,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
        updatedByUserId: ctx.userId ?? null,
      })
      .returning({ id: employeeDocument.id });
    // SUBSTRATE: new state-changing write — file bytes stay out of the payload.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-document',
      aggregateId: row.id,
      eventType: 'employee-document.uploaded',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { title, category: p.category?.trim() || null, fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

export type EmployeeDocumentMetadataInput={title:string;category?:string|null;description?:string|null};
/** One native normalization owner for the form, reviewed preparation and actual mutation. */
export function normalizeEmployeeDocumentMetadata(p:EmployeeDocumentMetadataInput){return{title:cleanTitle(p.title),category:p.category?.trim()||null,description:p.description?.trim()||null};}
/** Nomination only, then the actual stored-employment authority, before private metadata is read.
 * This is not an Assistant permission or self rule; ordinary native HR callers retain their course. */
export async function employeeDocumentMetadataSubjectTx(tx:Tx,ctx:SessionContext,documentId:string){
 assertAdmin(ctx);await lockAccessConfigurationTx(tx,ctx.tenantId);
 const [row]=await tx.select({id:employeeDocument.id,employmentId:employeeDocument.employmentId,letterArtifactId:employeeDocument.letterArtifactId}).from(employeeDocument).where(eq(employeeDocument.id,documentId)).limit(1);
 if(!row)throw new EmployeeDocumentError('Document not found (or not visible).');
 await assertWorkforceEmploymentTx(tx,ctx,row.employmentId,'maintain');
 if(row.letterArtifactId)throw new EmployeeDocumentError('Issued letters must be maintained in the letter register.');
 const [binding]=await tx.select({personId:employment.personId,companyId:employment.companyId}).from(employment).where(eq(employment.id,row.employmentId)).limit(1);
 if(!binding)throw new EmployeeDocumentError('Document subject unavailable.');return{...row,...binding};
}
/** Closed ordinary-document review snapshot. SELECT deliberately excludes content and any byte hash.
 * xmin is an opaque revision of the same attachment row, so replacing bytes invalidates the review. */
export async function prepareEmployeeDocumentMetadataTx(tx:Tx,ctx:SessionContext,p:{documentId:string}&EmployeeDocumentMetadataInput){
 const subject=await employeeDocumentMetadataSubjectTx(tx,ctx,p.documentId);
 const [row]=await tx.select({title:employeeDocument.title,category:employeeDocument.category,description:employeeDocument.description,fileName:employeeDocument.fileName,mimeType:employeeDocument.mimeType,sizeBytes:employeeDocument.sizeBytes,revision:sql<string>`xmin::text`}).from(employeeDocument).where(and(eq(employeeDocument.id,p.documentId),sql`${employeeDocument.letterArtifactId} is null`)).for('update');
 if(!row)throw new EmployeeDocumentError('Document not found (or not visible).');
 const {title,category,description,...attachment}=row;return{subject,before:{title,category,description},after:normalizeEmployeeDocumentMetadata(p),attachment};
}
/** Edit only metadata. Default native transaction/normalization remains; an enclosing review may own
 * the transaction and receive this exact native event. Raw description stays out of the audit. */
export async function updateEmployeeDocumentMeta(
 ctx:SessionContext,p:{documentId:string}&EmployeeDocumentMetadataInput,outerTx?:Tx,
):Promise<{id:string;eventId:string}>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};p=structuredClone(p);
 assertAdmin(ctx);const values=normalizeEmployeeDocumentMetadata(p);
 const run=async(tx:Tx)=>{
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  const [existing]=await tx.select({id:employeeDocument.id,employmentId:employeeDocument.employmentId}).from(employeeDocument).where(eq(employeeDocument.id,p.documentId)).limit(1);
  if(!existing)throw new EmployeeDocumentError('Document not found (or not visible).');
  await assertWorkforceEmploymentTx(tx,ctx,existing.employmentId,'maintain');
  const [written]=await tx.update(employeeDocument).set({...values,updatedByUserId:ctx.userId??null,updatedAt:sql`now()`}).where(eq(employeeDocument.id,p.documentId)).returning({metadataAfterHash:sql<string>`encode(sha256(convert_to(jsonb_build_object('title',${employeeDocument.title},'category',${employeeDocument.category},'description',${employeeDocument.description})::text,'UTF8')),'hex')`});
  if(!written)throw new EmployeeDocumentError('Document not found (or not visible).');
  const eventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employee-document',aggregateId:p.documentId,eventType:'employee-document.updated',actor:actorOf(ctx),subjectEmploymentId:existing.employmentId,payload:{title:values.title,category:values.category,metadataAfterHash:written.metadataAfterHash}},{returnId:true});
  return{id:p.documentId,eventId};
 };return outerTx?run(outerTx):withTenant(ctx,run);
}

/** Replace a document's attachment (new file bytes) while keeping its metadata + id. Admin-only. */
export async function replaceEmployeeDocumentContent(
  ctx: SessionContext,
  p: { documentId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  assertAdmin(ctx);
  assertValidEmployeeDocument(p.mimeType, p.content);
  return withTenant(ctx, async (tx) => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    const [existing] = await tx
      .select({ id: employeeDocument.id, employmentId: employeeDocument.employmentId })
      .from(employeeDocument)
      .where(eq(employeeDocument.id, p.documentId))
      .limit(1);
    if (!existing) throw new EmployeeDocumentError('Document not found (or not visible).');
    await assertWorkforceEmploymentTx(tx, ctx, existing.employmentId, 'maintain');
    await tx
      .update(employeeDocument)
      .set({
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        updatedByUserId: ctx.userId ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(employeeDocument.id, p.documentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-document',
      aggregateId: p.documentId,
      eventType: 'employee-document.content-replaced',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      payload: { fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.content.byteLength },
    });
    return { id: p.documentId };
  });
}

/** Hard-delete a document. The `.deleted` event is the audit record satisfying expected_function §6. Admin-only. */
export async function deleteEmployeeDocument(ctx: SessionContext, p: { documentId: string }): Promise<{ id: string }> {
  assertAdmin(ctx);
  return withTenant(ctx, async (tx) => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    const [existing] = await tx
      .select({ id: employeeDocument.id, employmentId: employeeDocument.employmentId, title: employeeDocument.title, fileName: employeeDocument.fileName })
      .from(employeeDocument)
      .where(eq(employeeDocument.id, p.documentId))
      .limit(1);
    if (!existing) throw new EmployeeDocumentError('Document not found (or not visible).');
    await assertWorkforceEmploymentTx(tx, ctx, existing.employmentId, 'maintain');
    await tx.delete(employeeDocument).where(eq(employeeDocument.id, p.documentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-document',
      aggregateId: p.documentId,
      eventType: 'employee-document.deleted',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      payload: { title: existing.title, fileName: existing.fileName },
    });
    return { id: p.documentId };
  });
}

// ─── Reads ────────────────────────────────────────────────────────────────────────────────────────────

export type EmployeeDocumentMeta = {
  id: string;
  employmentId: string;
  title: string;
  category: string | null;
  description: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
};

/** All documents for one employee (metadata only — no bytes), most-recent first. RLS-scoped.
 *  Uploaded/updated actor names resolve via app_user → person (null for system/unknown actors). */
export function listEmployeeDocuments(ctx: SessionContext, employmentId: string): Promise<EmployeeDocumentMeta[]> {
  const uploader = alias(person, 'uploader');
  const uploaderUser = alias(appUser, 'uploader_user');
  const updater = alias(person, 'updater');
  const updaterUser = alias(appUser, 'updater_user');
  return withTenant(ctx, async (tx) => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    return tx
      .select({
        id: employeeDocument.id,
        employmentId: employeeDocument.employmentId,
        title: employeeDocument.title,
        category: employeeDocument.category,
        description: employeeDocument.description,
        fileName: employeeDocument.fileName,
        mimeType: employeeDocument.mimeType,
        sizeBytes: employeeDocument.sizeBytes,
        uploadedBy: uploader.fullName,
        uploadedAt: employeeDocument.createdAt,
        updatedBy: updater.fullName,
        updatedAt: employeeDocument.updatedAt,
      })
      .from(employeeDocument)
      .leftJoin(uploaderUser, eq(uploaderUser.id, employeeDocument.uploadedByUserId))
      .leftJoin(uploader, eq(uploader.id, uploaderUser.personId))
      .leftJoin(updaterUser, eq(updaterUser.id, employeeDocument.updatedByUserId))
      .leftJoin(updater, eq(updater.id, updaterUser.personId))
      .where(eq(employeeDocument.employmentId, employmentId))
      .orderBy(desc(employeeDocument.createdAt));
  }) as Promise<EmployeeDocumentMeta[]>;
}

/**
 * One document's bytes for the download / view route. RLS-gated: a foreign or invisible id → null → 404.
 * Appends an `employee-document.downloaded` audit event (expected_function §6) — a deliberate, documented
 * exception to "reads emit nothing", justified by PDPA download-tracking. Any tenant member permitted by
 * RLS to read the row may append (domain_event append checks tenant only).
 */
export function getEmployeeDocument(
  ctx: SessionContext,
  documentId: string,
  expectedEmploymentId?: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string; employmentId: string } | null> {
  return withTenant(ctx, async (tx) => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    const [row] = await tx
      .select({
        content: employeeDocument.content,
        letterArtifactId:employeeDocument.letterArtifactId,
        fileName: employeeDocument.fileName,
        mimeType: employeeDocument.mimeType,
        employmentId: employeeDocument.employmentId,
      })
      .from(employeeDocument)
      .where(and(eq(employeeDocument.id, documentId), expectedEmploymentId ? eq(employeeDocument.employmentId, expectedEmploymentId) : undefined))
      .limit(1);
    if (!row) return null;
    if(row.letterArtifactId){
      const [sealed]=await tx.select({content:letterArtifact.content,letterId:letterRecord.id,contentHash:letterArtifact.contentHash}).from(letterArtifact).innerJoin(letterRecord,and(eq(letterRecord.id,letterArtifact.letterId),eq(letterRecord.currentRevisionId,letterArtifact.revisionId),eq(letterRecord.state,'issued'))).where(eq(letterArtifact.id,row.letterArtifactId));
      if(!sealed)return null;
      row.content=sealed.content;
      await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'letter',aggregateId:sealed.letterId,eventType:'letter.downloaded',actor:actorOf(ctx),payload:{artifactId:row.letterArtifactId,artifactHash:sealed.contentHash,documentId}});
    }
    // SUBSTRATE (documented exception): audit the download per expected_function §6.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-document',
      aggregateId: documentId,
      eventType: 'employee-document.downloaded',
      actor: actorOf(ctx),
      subjectEmploymentId: row.letterArtifactId?null:row.employmentId,
      payload: { fileName: row.fileName },
    });
    return { content: row.content as Buffer, fileName: row.fileName, mimeType: row.mimeType, employmentId: row.employmentId };
  });
}
