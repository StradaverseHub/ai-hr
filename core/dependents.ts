/**
 * Personnel Information — Family / Dependents (phase 1). A per-PERSON register of a person's family
 * members / dependents (spouse, child, parent, sibling, other) for BENEFITS / INSURANCE records only.
 *
 * KEYING — personId, NOT employmentId. Dependents are a PERSON fact (concurrent-employment-safe, like
 * tp1_relief / employee_statutory_my): keying on one employment would orphan the record on termination,
 * hide it from the other company's admin, and break for a not-yet-employed person. The detail page is
 * keyed by employmentId, so it resolves person_id from the already-loaded employment and passes it here.
 *
 * BENEFITS-ONLY — this register DOES NOT feed PCB. It is deliberately SEPARATE from the approval-gated
 * employee_statutory_my.num_children figure that drives tax; the two must not silently diverge. The
 * is_beneficiary boolean is a plain insurance-beneficiary flag — NOT a fractional 100%-split allocation
 * and NOT a tax-dependent flag (both explicitly out of scope). v1 is admin-write only; nothing here is
 * wired to payroll. This also stays distinct from the flat person.emergency_contact_* columns (which
 * answer "who to call in an emergency"); we do NOT migrate or backfill those into this table.
 *
 * Substrate discipline (ADR-0006 / ADR-0030 Layer 0): every write appends a DomainEvent whose payload
 * carries field NAMES + relationship only — never the cleartext IC, DOB or full name (PII lives on the
 * aggregate row). subjectEmploymentId is resolved via subjectEmploymentForPerson (null when the person has
 * no employment → the event is admin-only-readable, which is acceptable).
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { employeeDependent } from '../db/schema';

/** Allowed relationship values (validated server-side; the UI renders each as a static i18n label). */
export const DEPENDENT_RELATIONSHIPS = ['spouse', 'child', 'parent', 'sibling', 'other'] as const;
export type DependentRelationship = (typeof DEPENDENT_RELATIONSHIPS)[number];

/** Allowed gender values (optional). */
export const DEPENDENT_GENDERS = ['male', 'female', 'undisclosed'] as const;
export type DependentGender = (typeof DEPENDENT_GENDERS)[number];

export class DependentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependentValidationError';
  }
}

export type DependentRow = {
  id: string;
  personId: string;
  fullName: string;
  relationship: string;
  dateOfBirth: string | null;
  gender: string | null;
  icOrPassport: string | null;
  isBeneficiary: boolean;
  phone: string | null;
  remarks: string | null;
  archivedAt: Date | null;
};

function isRelationship(v: string): v is DependentRelationship {
  return (DEPENDENT_RELATIONSHIPS as readonly string[]).includes(v);
}

function normGender(v: string | null | undefined): string | null {
  if (v == null || v.trim() === '') return null;
  if (!(DEPENDENT_GENDERS as readonly string[]).includes(v)) {
    throw new DependentValidationError('Dependent gender is invalid.');
  }
  return v;
}

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

/**
 * Active (non-archived) family/dependent records for a person, oldest-first. Read-only; RLS scopes it to
 * self + admin (app.can_see_person), so a viewer who can't see the person gets an empty list, not a leak.
 */
export function listDependents(
  ctx: SessionContext,
  p: { personId: string },
): Promise<DependentRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employeeDependent.id,
        personId: employeeDependent.personId,
        fullName: employeeDependent.fullName,
        relationship: employeeDependent.relationship,
        dateOfBirth: employeeDependent.dateOfBirth,
        gender: employeeDependent.gender,
        icOrPassport: employeeDependent.icOrPassport,
        isBeneficiary: employeeDependent.isBeneficiary,
        phone: employeeDependent.phone,
        remarks: employeeDependent.remarks,
        archivedAt: employeeDependent.archivedAt,
      })
      .from(employeeDependent)
      .where(
        and(
          eq(employeeDependent.personId, p.personId),
          isNull(employeeDependent.archivedAt),
        ),
      )
      .orderBy(asc(employeeDependent.createdAt), asc(employeeDependent.id)),
  );
}

/**
 * Add a family/dependent record (admin-only via RLS WITH CHECK is_admin()). Validates the mandatory
 * full_name + relationship (∈ allowed set) and optional gender, then appends `dependent.added` — PII
 * (name/IC/DOB) stays OUT of the payload, which carries the relationship + a flag only.
 */
export function addDependent(
  ctx: SessionContext,
  p: {
    personId: string;
    fullName: string;
    relationship: string;
    dateOfBirth?: string | null;
    gender?: string | null;
    icOrPassport?: string | null;
    isBeneficiary?: boolean;
    phone?: string | null;
    remarks?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const fullName = (p.fullName ?? '').trim();
    if (fullName === '') throw new DependentValidationError('Dependent name is required.');
    if (!isRelationship(p.relationship)) {
      throw new DependentValidationError('Dependent relationship is invalid.');
    }
    const gender = normGender(p.gender);
    const [row] = await tx
      .insert(employeeDependent)
      .values({
        tenantId: ctx.tenantId,
        personId: p.personId,
        fullName,
        relationship: p.relationship,
        dateOfBirth: trimOrNull(p.dateOfBirth),
        gender,
        icOrPassport: trimOrNull(p.icOrPassport),
        isBeneficiary: p.isBeneficiary ?? false,
        phone: trimOrNull(p.phone),
        remarks: trimOrNull(p.remarks),
      })
      .returning({ id: employeeDependent.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-dependent',
      aggregateId: row.id,
      eventType: 'dependent.added',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // ADR-0030 Layer 0: no name/IC/DOB — relationship + the beneficiary flag only.
      payload: { relationship: p.relationship, isBeneficiary: p.isBeneficiary ?? false },
    });
    return { id: row.id };
  });
}

async function loadDependent(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: employeeDependent.id,
      personId: employeeDependent.personId,
      relationship: employeeDependent.relationship,
      isBeneficiary: employeeDependent.isBeneficiary,
      archivedAt: employeeDependent.archivedAt,
    })
    .from(employeeDependent)
    .where(eq(employeeDependent.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Edit a family/dependent record (admin-only). Only provided fields change. Validates the same rules as
 * add. Appends `dependent.updated` with `{ diff }` (field NAMES only — no PII values, no relationship value
 * unless it changed, in which case only its name is listed in diff).
 */
export function updateDependent(
  ctx: SessionContext,
  p: {
    id: string;
    fullName?: string;
    relationship?: string;
    dateOfBirth?: string | null;
    gender?: string | null;
    icOrPassport?: string | null;
    isBeneficiary?: boolean;
    phone?: string | null;
    remarks?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadDependent(tx, p.id);
    if (!existing || existing.archivedAt != null) {
      throw new DependentValidationError('Dependent record not found.');
    }
    const patch: Record<string, unknown> = {};
    if (p.fullName !== undefined) {
      const fullName = p.fullName.trim();
      if (fullName === '') throw new DependentValidationError('Dependent name is required.');
      patch.fullName = fullName;
    }
    if (p.relationship !== undefined) {
      if (!isRelationship(p.relationship)) {
        throw new DependentValidationError('Dependent relationship is invalid.');
      }
      patch.relationship = p.relationship;
    }
    if (p.gender !== undefined) patch.gender = normGender(p.gender);
    if (p.dateOfBirth !== undefined) patch.dateOfBirth = trimOrNull(p.dateOfBirth);
    if (p.icOrPassport !== undefined) patch.icOrPassport = trimOrNull(p.icOrPassport);
    if (p.isBeneficiary !== undefined) patch.isBeneficiary = p.isBeneficiary;
    if (p.phone !== undefined) patch.phone = trimOrNull(p.phone);
    if (p.remarks !== undefined) patch.remarks = trimOrNull(p.remarks);

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await tx.update(employeeDependent).set(patch).where(eq(employeeDependent.id, p.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-dependent',
      aggregateId: p.id,
      eventType: 'dependent.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, existing.personId),
      // Field NAMES only (ADR-0030 Layer 0) — never the PII values.
      payload: { diff: Object.keys(patch).filter((k) => k !== 'updatedAt') },
    });
    return { id: p.id };
  });
}

/**
 * Soft-delete a family/dependent record (admin-only) — sets archived_at so the audit stays reconcilable.
 * Appends `dependent.archived`.
 */
export function archiveDependent(
  ctx: SessionContext,
  p: { id: string },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadDependent(tx, p.id);
    if (!existing || existing.archivedAt != null) {
      throw new DependentValidationError('Dependent record not found.');
    }
    await tx
      .update(employeeDependent)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(employeeDependent.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-dependent',
      aggregateId: p.id,
      eventType: 'dependent.archived',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, existing.personId),
      payload: { relationship: existing.relationship },
    });
    return { id: p.id };
  });
}
