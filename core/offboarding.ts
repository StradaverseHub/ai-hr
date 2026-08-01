/**
 * Offboarding — employee-initiated resignation (ADR-0042, #29). The employee submits a resignation; HR
 * accepts it, which (atomically, in the same transaction) triggers the termination via
 * terminateEmploymentTx — a 'voluntary' termination, the single source of truth for ending employment.
 * Same request → approve rails as the profile-change / claims / leave flows.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employment, person, resignationRequest, resignationRequestAttachment } from '../db/schema';
import { assertCanDecide } from './approvals';
import { freezeOnResignationApprovalTx } from './leave-encashment';
import { validateLeaveDocument } from './leave';
import { terminateEmploymentTx } from './org';

import { todayInKualaLumpur } from '../lib/hr-date';

// #42cff598: the file types the resignation ticket specifies (PDF / JPG / PNG) and a fixed 10 MB ceiling.
// Resignation has no per-type config table like leave, so the allowed set + ceiling are constants here.
// The gate itself (validateLeaveDocument + its LeaveDocumentTypeError/LeaveDocumentSizeError) is reused,
// not re-implemented, so the wording matches leave and stays localized in all 6 locales.
const RESIGNATION_DOC_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const RESIGNATION_DOC_MAX_BYTES = 10 * 1024 * 1024;

export class ResignationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResignationError';
  }
}

/** The employee raises a resignation. One open request at a time; the last day must be today or later. */
export async function submitResignation(
  ctx: SessionContext,
  p: { employmentId: string; lastWorkingDay: string; reason?: string | null; today?: string },
) {
  if (!ctx.personId) throw new ResignationError('This account is not linked to an employee profile.');
  const lastWorkingDay = String(p.lastWorkingDay ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastWorkingDay)) throw new ResignationError('A valid last working day is required.');
  const today = p.today ?? todayInKualaLumpur();
  if (lastWorkingDay < today) throw new ResignationError('The last working day cannot be in the past.');
  const personId = ctx.personId;
  return withTenant(ctx, async (tx) => {
    const [open] = await tx
      .select({ id: resignationRequest.id })
      .from(resignationRequest)
      .where(and(eq(resignationRequest.employmentId, p.employmentId), eq(resignationRequest.status, 'pending')))
      .limit(1);
    if (open) {
      throw new ResignationError('You already have a pending resignation — withdraw it first to change the details.');
    }
    const [row] = await tx
      .insert(resignationRequest)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        personId,
        lastWorkingDay,
        reason: p.reason?.trim() || null,
      })
      .returning({ id: resignationRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'resignation',
      aggregateId: row.id,
      eventType: 'resignation.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, lastWorkingDay },
    });
    return { requestId: row.id };
  });
}

/** The employee withdraws their own pending resignation. */
export async function withdrawResignation(ctx: SessionContext, p: { requestId: string }) {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(resignationRequest).where(eq(resignationRequest.id, p.requestId)).limit(1);
    if (!req) throw new ResignationError('Resignation not found (or not visible).');
    if (req.status !== 'pending') throw new ResignationError(`This resignation is already ${req.status}.`);
    if (!ctx.personId || req.personId !== ctx.personId) {
      throw new ResignationError('Only the employee can withdraw their own resignation.');
    }
    await tx.update(resignationRequest).set({ status: 'withdrawn' }).where(eq(resignationRequest.id, req.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'resignation',
      aggregateId: req.id,
      eventType: 'resignation.withdrawn',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: {},
    });
    return { status: 'withdrawn' as const };
  });
}

/** HR decides a resignation. Admin-only, never self. Accepting terminates the employment (voluntary,
 *  last working day, reason) in the same transaction — so it can't be half-applied. */
export async function decideResignation(
  ctx: SessionContext,
  p: { requestId: string; decision: 'accepted' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(resignationRequest).where(eq(resignationRequest.id, p.requestId)).limit(1);
    if (!req) throw new ResignationError('Resignation not found (or not visible).');
    if (req.status !== 'pending') throw new ResignationError(`This resignation is already ${req.status}.`);
    await assertCanDecide(tx, ctx, req.employmentId, 'resignation'); // bans self-decide
    const roles = ctx.roles ?? [];
    if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
      throw new ResignationError('Only an admin can decide a resignation.');
    }

    if (p.decision === 'accepted') {
      // A resignation is a voluntary termination — reuse the single termination path, same tx.
      await terminateEmploymentTx(tx, ctx, {
        employmentId: req.employmentId,
        terminationDate: req.lastWorkingDay,
        terminationType: 'voluntary',
        terminationReason: req.reason ?? 'Resignation',
      });

      // ADR-0069: freeze + calculate Annual Leave encashment in the SAME tx. "As of resignation approval
      // date" (the request's own wording) — i.e. today, when this decision is being recorded. Silent
      // no-op when the company's policy is off/absent, autoFreeze is off, or the tenant has no ANNUAL
      // leave type — a resignation approval must never fail because of this feature (ADR-0069 §7).
      const [emp] = await tx.select({ companyId: employment.companyId }).from(employment).where(eq(employment.id, req.employmentId)).limit(1);
      if (emp) {
        await freezeOnResignationApprovalTx(tx, ctx, {
          employmentId: req.employmentId,
          companyId: emp.companyId,
          resignationRequestId: req.id,
          asOf: todayInKualaLumpur(),
        });
      }
    }

    await tx
      .update(resignationRequest)
      .set({ status: p.decision, decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
      .where(eq(resignationRequest.id, req.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'resignation',
      aggregateId: req.id,
      eventType: `resignation.${p.decision}`,
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { decision: p.decision, lastWorkingDay: req.lastWorkingDay, deciderEmploymentId: p.deciderEmploymentId ?? null },
    });
    return { status: p.decision };
  });
}

/** Admin inbox — pending resignations, RLS-scoped. Recent first. */
export function listResignationRequests(
  ctx: SessionContext,
  opts: { status?: 'pending' | 'accepted' | 'rejected' | 'withdrawn' } = {},
) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: resignationRequest.id,
        employmentId: resignationRequest.employmentId,
        personId: resignationRequest.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        lastWorkingDay: resignationRequest.lastWorkingDay,
        reason: resignationRequest.reason,
        status: resignationRequest.status,
        createdAt: resignationRequest.createdAt,
      })
      .from(resignationRequest)
      .innerJoin(employment, eq(employment.id, resignationRequest.employmentId))
      .innerJoin(person, eq(person.id, resignationRequest.personId))
      .where(opts.status ? eq(resignationRequest.status, opts.status) : undefined)
      .orderBy(desc(resignationRequest.createdAt))
      .limit(100);
    // #42cff598: batch-fetch each request's attachments (metadata only) in one query so the inbox can
    // render a "View document" link per file. Same RLS transaction, so only visible files come back.
    const ids = rows.map((r) => r.id);
    const atts =
      ids.length === 0
        ? []
        : await tx
            .select({
              id: resignationRequestAttachment.id,
              resignationRequestId: resignationRequestAttachment.resignationRequestId,
              fileName: resignationRequestAttachment.fileName,
              mimeType: resignationRequestAttachment.mimeType,
            })
            .from(resignationRequestAttachment)
            .where(inArray(resignationRequestAttachment.resignationRequestId, ids))
            .orderBy(desc(resignationRequestAttachment.createdAt));
    const byRequest = new Map<string, { id: string; fileName: string; mimeType: string }[]>();
    for (const a of atts) {
      const list = byRequest.get(a.resignationRequestId) ?? [];
      list.push({ id: a.id, fileName: a.fileName, mimeType: a.mimeType });
      byRequest.set(a.resignationRequestId, list);
    }
    return rows.map((r) => ({ ...r, documents: byRequest.get(r.id) ?? [] }));
  });
}

/** The caller's own most-recent resignation (the /me status + withdraw control). */
export function myResignation(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: resignationRequest.id,
        lastWorkingDay: resignationRequest.lastWorkingDay,
        reason: resignationRequest.reason,
        status: resignationRequest.status,
        createdAt: resignationRequest.createdAt,
      })
      .from(resignationRequest)
      .where(eq(resignationRequest.employmentId, employmentId))
      .orderBy(desc(resignationRequest.createdAt))
      .limit(1);
    return row ?? null;
  });
}

// ── Resignation supporting documents (#42cff598, ADR-0042) ──
// Verbatim reuse of the leave-attachment stack retargeted to resignation_request: the same bytea side-table,
// the same validateLeaveDocument gate, and the same can_see_employment RLS (subject + manager + admin).

/** Attach a supporting document to a PENDING resignation. employment_id is denormalized from the request so
 *  the attachment's RLS matches the request (subject + manager + admin). Documents may only be added while
 *  the resignation is pending, mirroring the leave guard. */
export async function addResignationAttachment(
  ctx: SessionContext,
  p: { resignationRequestId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.content.byteLength === 0) throw new ResignationError('Empty file');
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select({ employmentId: resignationRequest.employmentId, status: resignationRequest.status })
      .from(resignationRequest)
      .where(eq(resignationRequest.id, p.resignationRequestId))
      .limit(1);
    if (!req) throw new ResignationError('Resignation not found (or not visible).');
    if (req.status !== 'pending') throw new ResignationError('Documents can only be added while the resignation is pending.');
    // Defence-in-depth: the /me action already validates before submitResignation commits (so a bad file
    // never leaves an orphan pending resignation); this re-checks for any other caller. Reuses the leave
    // gate + its typed errors — no new MIME/size list here.
    validateLeaveDocument(
      { allowedMimeTypes: RESIGNATION_DOC_MIME_TYPES, maxDocBytes: RESIGNATION_DOC_MAX_BYTES },
      { mimeType: p.mimeType, sizeBytes: p.content.byteLength },
    );
    const [row] = await tx
      .insert(resignationRequestAttachment)
      .values({
        tenantId: ctx.tenantId,
        resignationRequestId: p.resignationRequestId,
        employmentId: req.employmentId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: resignationRequestAttachment.id });
    // SUBSTRATE: a new state-changing write — the DomainEvent is mandatory.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'resignation',
      aggregateId: p.resignationRequestId,
      eventType: 'resignation.document.attached',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { fileName: p.fileName, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

/** List a resignation's attachments (metadata only, no content) so the approvals inbox can render one
 *  link per file. Read-only, RLS-scoped (subject + manager + admin) — no event. */
export function listResignationAttachments(
  ctx: SessionContext,
  resignationRequestId: string,
): Promise<{ id: string; fileName: string; mimeType: string; sizeBytes: number }[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: resignationRequestAttachment.id,
        fileName: resignationRequestAttachment.fileName,
        mimeType: resignationRequestAttachment.mimeType,
        sizeBytes: resignationRequestAttachment.sizeBytes,
      })
      .from(resignationRequestAttachment)
      .where(eq(resignationRequestAttachment.resignationRequestId, resignationRequestId))
      .orderBy(desc(resignationRequestAttachment.createdAt)),
  );
}

/** Stream one resignation attachment by its own id. Runs under RLS (subject + manager + admin via
 *  can_see_employment). Read-only — no event. */
export async function getResignationAttachmentById(
  ctx: SessionContext,
  attachmentId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        content: resignationRequestAttachment.content,
        fileName: resignationRequestAttachment.fileName,
        mimeType: resignationRequestAttachment.mimeType,
      })
      .from(resignationRequestAttachment)
      .where(eq(resignationRequestAttachment.id, attachmentId))
      .limit(1);
    return row ? { content: row.content as Buffer, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}
