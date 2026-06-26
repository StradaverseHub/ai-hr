/**
 * Self-service Personal Tax Relief — LHDN TP1 (ADR-0050, #1.1.3).
 *
 * An employee declares their single annual optional-relief total (TP1) per assessment year on /me. The
 * latest SUBMITTED row for a year feeds monthly PCB/MTD through `prefillTp1FromSelfRelief` (core/payroll).
 *
 * Shape: the append-only request-row pattern (profile_change_request / resignation_request). The latest
 * row per (person, year) wins (`orderBy(desc(createdAt))`); the editable draft for a year is UPDATEd in
 * place; a submitted row is immutable, so a correction is a NEW submitted row. Per-year isolation comes
 * from the `assessmentYear` WHERE clause; history comes from never deleting + the DomainEvent log.
 *
 * `personId` is resolved from `ctx.personId` ONLY (never a form field) — RLS (`app.can_see_person`) also
 * confines every read and write to the caller's own row (self) or an admin. PDPA Layer-0 (ADR-0030): the
 * tp1.* event payloads reference the row id + year + field names, never the cleartext amount.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { tp1Relief } from '../db/schema';

export class TaxReliefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxReliefError';
  }
}

// v1 validation (scalar): a non-negative finite amount under a sane annual ceiling, in a sane year range.
// The full per-category LHDN catalogue with sourced 2026 caps is OUT OF SCOPE for v1 (the kernel only
// consumes the sum); validating against caps we have not sourced would be gold-plating (ADR-0050).
const TP1_MAX = 1_000_000; // generous ceiling; the real per-category caps are a later enhancement
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

function validate(assessmentYear: number, tp1Amount: number): { year: number; amount: number } {
  const year = Math.trunc(Number(assessmentYear));
  if (!Number.isFinite(year) || year < YEAR_MIN || year > YEAR_MAX) {
    throw new TaxReliefError(`Assessment year must be between ${YEAR_MIN} and ${YEAR_MAX}.`);
  }
  const amount = Number(tp1Amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new TaxReliefError('Relief amount must be a non-negative number.');
  }
  if (amount > TP1_MAX) {
    throw new TaxReliefError(`Relief amount must not exceed ${TP1_MAX}.`);
  }
  return { year, amount: Math.round(amount * 100) / 100 };
}

export type Tp1Row = {
  id: string;
  assessmentYear: number;
  status: 'draft' | 'submitted';
  tp1Amount: number;
  submittedAt: Date | null;
  createdAt: Date;
};

function requirePerson(ctx: SessionContext): string {
  if (!ctx.personId) throw new TaxReliefError('This account is not linked to an employee profile.');
  return ctx.personId;
}

/** The latest TP1 row for the caller for an assessment year (RLS-scoped). Read-only, no event. */
export function getTp1(
  ctx: SessionContext,
  p: { assessmentYear: number },
): Promise<Tp1Row | null> {
  const personId = requirePerson(ctx);
  const year = Math.trunc(Number(p.assessmentYear));
  return withTenant(ctx, async (tx): Promise<Tp1Row | null> => {
    const [row] = await tx
      .select({
        id: tp1Relief.id,
        assessmentYear: tp1Relief.assessmentYear,
        status: tp1Relief.status,
        tp1Amount: tp1Relief.tp1Amount,
        submittedAt: tp1Relief.submittedAt,
        createdAt: tp1Relief.createdAt,
      })
      .from(tp1Relief)
      .where(and(eq(tp1Relief.personId, personId), eq(tp1Relief.assessmentYear, year)))
      .orderBy(desc(tp1Relief.createdAt))
      .limit(1);
    if (!row) return null;
    return { ...row, tp1Amount: Number(row.tp1Amount) };
  });
}

/** The latest SUBMITTED TP1 for a person + year — the value the PCB prefill feeds. Used by the kernel
 *  (admin/system session) and by historical views. RLS-scoped (self + admin). */
export function getLatestSubmittedTp1(
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number },
): Promise<Tp1Row | null> {
  const year = Math.trunc(Number(p.assessmentYear));
  return withTenant(ctx, async (tx): Promise<Tp1Row | null> => {
    const [row] = await tx
      .select({
        id: tp1Relief.id,
        assessmentYear: tp1Relief.assessmentYear,
        status: tp1Relief.status,
        tp1Amount: tp1Relief.tp1Amount,
        submittedAt: tp1Relief.submittedAt,
        createdAt: tp1Relief.createdAt,
      })
      .from(tp1Relief)
      .where(
        and(
          eq(tp1Relief.personId, p.personId),
          eq(tp1Relief.assessmentYear, year),
          eq(tp1Relief.status, 'submitted'),
        ),
      )
      .orderBy(desc(tp1Relief.createdAt))
      .limit(1);
    if (!row) return null;
    return { ...row, tp1Amount: Number(row.tp1Amount) };
  });
}

/** Distinct assessment years the caller has TP1 rows for (drives the year selector + historical view). */
export function listTp1Years(ctx: SessionContext): Promise<number[]> {
  const personId = requirePerson(ctx);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ year: tp1Relief.assessmentYear })
      .from(tp1Relief)
      .where(eq(tp1Relief.personId, personId))
      .orderBy(desc(tp1Relief.assessmentYear));
    return rows.map((r) => r.year);
  });
}

/**
 * Save the single editable DRAFT for an assessment year: UPDATE the open draft if present, else INSERT.
 * A submitted row is never touched here (a submitted year is corrected via `submitTp1`).
 */
export async function saveTp1Draft(
  ctx: SessionContext,
  p: { assessmentYear: number; tp1Amount: number },
): Promise<{ id: string }> {
  const personId = requirePerson(ctx);
  const { year, amount } = validate(p.assessmentYear, p.tp1Amount);
  return withTenant(ctx, async (tx) => {
    const [draft] = await tx
      .select({ id: tp1Relief.id })
      .from(tp1Relief)
      .where(
        and(
          eq(tp1Relief.personId, personId),
          eq(tp1Relief.assessmentYear, year),
          eq(tp1Relief.status, 'draft'),
        ),
      )
      .orderBy(desc(tp1Relief.createdAt))
      .limit(1);
    let id: string;
    if (draft) {
      await tx
        .update(tp1Relief)
        .set({ tp1Amount: amount.toFixed(2) })
        .where(eq(tp1Relief.id, draft.id));
      id = draft.id;
    } else {
      const [row] = await tx
        .insert(tp1Relief)
        .values({ tenantId: ctx.tenantId, personId, assessmentYear: year, status: 'draft', tp1Amount: amount.toFixed(2) })
        .returning({ id: tp1Relief.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'tp1-relief',
      aggregateId: id,
      eventType: 'tp1.draft.saved',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      // PDPA Layer-0 (ADR-0030): reference the row + year + field, NEVER the cleartext amount — the event
      // is subject-readable, so the amount must live only on the RLS-protected tp1_relief row.
      payload: { tp1ReliefId: id, assessmentYear: year, fields: ['tp1Amount'] },
    });
    return { id };
  });
}

/**
 * Submit a TP1 declaration for an assessment year: INSERT a new SUBMITTED row (a correction is just another
 * append — latest-submitted wins). Never closes/supersedes a prior row.
 */
export async function submitTp1(
  ctx: SessionContext,
  p: { assessmentYear: number; tp1Amount: number },
): Promise<{ id: string }> {
  const personId = requirePerson(ctx);
  const { year, amount } = validate(p.assessmentYear, p.tp1Amount);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(tp1Relief)
      .values({
        tenantId: ctx.tenantId,
        personId,
        assessmentYear: year,
        status: 'submitted',
        tp1Amount: amount.toFixed(2),
        submittedAt: sql`now()`,
      })
      .returning({ id: tp1Relief.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'tp1-relief',
      aggregateId: row.id,
      eventType: 'tp1.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      // PDPA Layer-0: reference only — the amount lives on the RLS-protected row.
      payload: { tp1ReliefId: row.id, assessmentYear: year, fields: ['tp1Amount'] },
    });
    return { id: row.id };
  });
}
