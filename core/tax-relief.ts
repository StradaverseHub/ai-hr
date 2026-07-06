/**
 * Self-service Personal Tax Relief — LHDN TP1 (ADR-0050, #1.1.3; per-category breakdown a2f1fa24).
 *
 * An employee declares their annual optional-relief total (TP1) per assessment year on /me. The latest
 * SUBMITTED row for a year feeds monthly PCB/MTD through `prefillTp1FromSelfRelief` (core/payroll).
 *
 * As of a2f1fa24 the declaration is captured as a STRUCTURED per-category breakdown mirroring the paper
 * LHDN TP1 form (individual, spouse, children, parent, medical/insurance, lifestyle, education, other +
 * a remarks note), stored in the optional `categories` JSONB. The authoritative `tp1Amount` REMAINS the
 * server-computed round2 SUM of those categories — the single number the PCB kernel consumes — so the
 * monthly MTD math is unchanged. Legacy scalar-only rows (categories NULL) keep working: callers may
 * still pass a bare `tp1Amount` and no breakdown.
 *
 * Shape: the append-only request-row pattern (profile_change_request / resignation_request). The latest
 * row per (person, year) wins (`orderBy(desc(createdAt))`); the editable draft for a year is UPDATEd in
 * place; a submitted row is immutable, so a correction is a NEW submitted row. Per-year isolation comes
 * from the `assessmentYear` WHERE clause; history comes from never deleting + the DomainEvent log.
 *
 * `personId` is resolved from `ctx.personId` ONLY (never a form field) — RLS (`app.can_see_person`) also
 * confines every read and write to the caller's own row (self) or an admin. PDPA Layer-0 (ADR-0030): the
 * tp1.* event payloads reference the row id + year + changed field NAMES, never the cleartext amounts.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { tp1Relief, TP1_CATEGORY_KEYS, type Tp1CategoryKey, type Tp1Categories } from '../db/schema';
import { MY_RELIEFS } from '../localization/my/statutory-tables';

export class TaxReliefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxReliefError';
  }
}

// A non-negative finite amount under a sane annual ceiling, in a sane year range.
const TP1_MAX = 1_000_000; // generous ceiling on the SUM; per-category caps below where sourced.
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const REMARKS_MAX = 2000;

// Per-category caps we ACTUALLY have a sourced statutory number for (MY_RELIEFS — the LHDN 2026 MTD
// projection reliefs, VERIFIED in statutory-tables.ts). We reuse these ONLY for the categories they
// genuinely correspond to. The other TP1 categories (medical/insurance, lifestyle, parent, education,
// other) have NO sourced cap in the system today; under ADR-0008 (no unsourced statutory number) they
// get the non-negative check only, and a sourced per-category cap is a DEFERRED follow-up.
// TODO(ADR-0008): source + verify 2026 caps for medicalInsurance / lifestyle / parent / education.
const SOURCED_CATEGORY_CAPS: Partial<Record<Tp1CategoryKey, number>> = {
  individual: MY_RELIEFS.individual, // D — individual + dependent relatives (RM 9,000)
  spouse: MY_RELIEFS.spouse, //          S — non-working spouse (RM 4,000)
  // `children` and the EPF/life cap are per-unit in MY_RELIEFS (perChild, epfReliefCap); a single flat
  // cap on the aggregated children figure would be wrong (it scales with the number of children), so we
  // do NOT cap `children` here — non-negative only until a sourced aggregate rule exists.
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function validateYear(assessmentYear: number): number {
  const year = Math.trunc(Number(assessmentYear));
  if (!Number.isFinite(year) || year < YEAR_MIN || year > YEAR_MAX) {
    throw new TaxReliefError(`Assessment year must be between ${YEAR_MIN} and ${YEAR_MAX}.`);
  }
  return year;
}

/** A single non-negative, finite RM amount (2-dp rounded), with an optional sourced per-category cap. */
function validateAmount(raw: unknown, label: string, cap?: number): number {
  const amount = Number(raw ?? 0);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new TaxReliefError(`${label} must be a non-negative number.`);
  }
  const rounded = round2(amount);
  if (cap != null && rounded > cap) {
    throw new TaxReliefError(`${label} must not exceed the statutory cap of RM ${cap}.`);
  }
  return rounded;
}

/**
 * Normalise + validate a per-category breakdown, returning the cleaned `categories` object and the
 * server-computed `tp1Amount` roll-up (round2 sum of the numeric categories). Every category is
 * non-negative; the four we have a sourced cap for are cap-checked; the SUM is held under `TP1_MAX`.
 * The client NEVER supplies the total — it is always recomputed here.
 */
function validateCategories(raw: Partial<Record<string, unknown>>): {
  categories: Tp1Categories;
  amount: number;
} {
  const categories: Tp1Categories = {};
  let sum = 0;
  for (const key of TP1_CATEGORY_KEYS) {
    const value = validateAmount(raw[key], key, SOURCED_CATEGORY_CAPS[key]);
    categories[key] = value;
    sum += value;
  }
  const remarksRaw = raw.remarks;
  if (remarksRaw != null && String(remarksRaw).trim() !== '') {
    const remarks = String(remarksRaw).trim();
    if (remarks.length > REMARKS_MAX) {
      throw new TaxReliefError(`Remarks must be at most ${REMARKS_MAX} characters.`);
    }
    categories.remarks = remarks;
  }
  const amount = round2(sum);
  if (amount > TP1_MAX) {
    throw new TaxReliefError(`Total relief must not exceed ${TP1_MAX}.`);
  }
  return { categories, amount };
}

/**
 * Resolve the write input into a validated year, roll-up amount, and (optional) categories.
 * - When `categories` is supplied, the amount is the server-computed SUM (the client's total is ignored).
 * - When only a scalar `tp1Amount` is supplied (legacy / API callers), it is validated as a single amount
 *   and no `categories` breakdown is stored (row stays scalar-only, categories NULL).
 */
function resolveInput(p: Tp1WriteInput): { year: number; amount: number; categories: Tp1Categories | null } {
  const year = validateYear(p.assessmentYear);
  if (p.categories) {
    const { categories, amount } = validateCategories(p.categories);
    return { year, amount, categories };
  }
  const amount = validateAmount(p.tp1Amount, 'Relief amount');
  if (amount > TP1_MAX) throw new TaxReliefError(`Relief amount must not exceed ${TP1_MAX}.`);
  return { year, amount, categories: null };
}

export type Tp1WriteInput = {
  assessmentYear: number;
  /** Scalar total — accepted for legacy/API callers when no `categories` breakdown is provided. */
  tp1Amount?: number;
  /** Structured per-category breakdown (a2f1fa24); when present, the total is computed from it. */
  categories?: Partial<Record<string, unknown>>;
};

export type Tp1Row = {
  id: string;
  assessmentYear: number;
  status: 'draft' | 'submitted';
  tp1Amount: number;
  categories: Tp1Categories | null;
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
        categories: tp1Relief.categories,
        submittedAt: tp1Relief.submittedAt,
        createdAt: tp1Relief.createdAt,
      })
      .from(tp1Relief)
      .where(and(eq(tp1Relief.personId, personId), eq(tp1Relief.assessmentYear, year)))
      .orderBy(desc(tp1Relief.createdAt))
      .limit(1);
    if (!row) return null;
    return { ...row, tp1Amount: Number(row.tp1Amount), categories: row.categories ?? null };
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
        categories: tp1Relief.categories,
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
    return { ...row, tp1Amount: Number(row.tp1Amount), categories: row.categories ?? null };
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
  p: Tp1WriteInput,
): Promise<{ id: string }> {
  const personId = requirePerson(ctx);
  const { year, amount, categories } = resolveInput(p);
  // PDPA Layer-0: list the changed FIELD names only — never the cleartext amounts.
  const fields = categories ? ['tp1Amount', 'categories'] : ['tp1Amount'];
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
        .set({ tp1Amount: amount.toFixed(2), categories })
        .where(eq(tp1Relief.id, draft.id));
      id = draft.id;
    } else {
      const [row] = await tx
        .insert(tp1Relief)
        .values({ tenantId: ctx.tenantId, personId, assessmentYear: year, status: 'draft', tp1Amount: amount.toFixed(2), categories })
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
      // PDPA Layer-0 (ADR-0030): reference the row + year + field NAMES, NEVER the cleartext amounts — the
      // event is subject-readable, so the amounts must live only on the RLS-protected tp1_relief row.
      payload: { tp1ReliefId: id, assessmentYear: year, fields },
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
  p: Tp1WriteInput,
): Promise<{ id: string }> {
  const personId = requirePerson(ctx);
  const { year, amount, categories } = resolveInput(p);
  const fields = categories ? ['tp1Amount', 'categories'] : ['tp1Amount'];
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(tp1Relief)
      .values({
        tenantId: ctx.tenantId,
        personId,
        assessmentYear: year,
        status: 'submitted',
        tp1Amount: amount.toFixed(2),
        categories,
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
      // PDPA Layer-0: reference the field NAMES only — the amounts live on the RLS-protected row.
      payload: { tp1ReliefId: row.id, assessmentYear: year, fields },
    });
    return { id: row.id };
  });
}
