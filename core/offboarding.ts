/**
 * Offboarding — employee-initiated resignation (ADR-0042, #29). The employee submits a resignation; HR
 * accepts it, which (atomically, in the same transaction) triggers the termination via
 * terminateEmploymentTx — a 'voluntary' termination, the single source of truth for ending employment.
 * Same request → approve rails as the profile-change / claims / leave flows.
 */
import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { person, resignationRequest } from '../db/schema';
import { assertCanDecide } from './approvals';
import { terminateEmploymentTx } from './org';

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
  const today = p.today ?? new Date().toISOString().slice(0, 10);
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
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: resignationRequest.id,
        employmentId: resignationRequest.employmentId,
        personId: resignationRequest.personId,
        employee: person.fullName,
        lastWorkingDay: resignationRequest.lastWorkingDay,
        reason: resignationRequest.reason,
        status: resignationRequest.status,
        createdAt: resignationRequest.createdAt,
      })
      .from(resignationRequest)
      .innerJoin(person, eq(person.id, resignationRequest.personId))
      .where(opts.status ? eq(resignationRequest.status, opts.status) : undefined)
      .orderBy(desc(resignationRequest.createdAt))
      .limit(100),
  );
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
