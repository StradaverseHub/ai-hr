/**
 * Personnel (Admin) — Qualification tab (feedback a949184a). A per-EMPLOYMENT register of an employee's
 * academic / professional qualification history: level (catalog-backed dropdown), description, study period
 * (From/To as YYYY-MM), institute, major, graduation date, result/grade, and a single Highest Qualification
 * flag.
 *
 * KEYING — employmentId (per the approved plan): the record is maintained on (and follows) the Personnel
 * (Admin) employee profile, which is employment-keyed. RLS (migration 0306) mirrors the employee_cp38
 * employment-keyed precedent: USING app.can_see_employment (self + admin read) / WITH CHECK app.is_admin()
 * (admin-only writes).
 *
 * SINGLE-HIGHEST RULE: at most ONE live (non-archived) record per employment carries isHighest. Setting the
 * flag on a record transfers it — the previous holder is cleared IN THE SAME TRANSACTION — and the partial
 * unique index employee_qualification_one_highest_uq is the DB-level backstop that makes a concurrent
 * double-highest structurally impossible.
 *
 * QUALIFICATION VALUE — catalog-backed with legacy tolerance, mirroring assertProfileValueAllowed: a NEW
 * pick must be an ACTIVE 'qualificationLevel' profile_option; an UNCHANGED stored value always re-saves
 * (deactivating an option only hides it from new picks); an EMPTY catalog imposes no constraint (a tenant
 * that never seeded the category keeps free-text behaviour, exactly like the person-profile categories).
 *
 * Substrate discipline (ADR-0006 / ADR-0030): every write appends a DomainEvent. Payloads carry the
 * qualification value + flags/field NAMES only — free-text details (institute, result, description) stay on
 * the RLS-protected row. subjectEmploymentId is the employment itself (the event is about this employee).
 */
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employeeQualification, profileOption } from '../db/schema';

/**
 * The profile_option category backing the Qualification dropdown (System Settings > System Labels >
 * Profile Options). Defined here (not in core/profile-options.ts) so the dependency stays one-directional
 * (profile-options imports from this module), mirroring DEPENDENT_RELATIONSHIP_CATEGORY.
 */
export const QUALIFICATION_LEVEL_CATEGORY = 'qualificationLevel' as const;

/**
 * Default catalog values for the qualificationLevel category (the approved seed list). Kept BYTE-IDENTICAL
 * with the 0306_employee_qualification.sql top-up seed (this category post-dates the 0180 seed, so its seed
 * site is 0306). `value` doubles as the default label; the org can add / edit / deactivate afterwards.
 */
export const QUALIFICATION_LEVEL_DEFAULTS = [
  'SPM',
  'STPM',
  'Certificate',
  'Diploma',
  'Advanced Diploma',
  'Bachelor',
  'Master',
  'Doctorate',
  'Professional Certification',
] as const;

export class QualificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QualificationValidationError';
  }
}

export type QualificationRow = {
  id: string;
  employmentId: string;
  qualification: string;
  description: string | null;
  fromYm: string | null;
  toYm: string | null;
  institute: string | null;
  major: string | null;
  graduationDate: string | null;
  result: string | null;
  isHighest: boolean;
  archivedAt: Date | null;
};

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

/** Normalise a YYYY-MM study-period value: blank ⇒ null; anything else must be a real year-month. */
function normYm(v: string | null | undefined, label: string): string | null {
  const s = trimOrNull(v);
  if (s === null) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) {
    throw new QualificationValidationError(`${label} must be a year and month (YYYY-MM).`);
  }
  return s;
}

/**
 * Cross-field date rules (feedback §6), applied to the EFFECTIVE values (post-patch on edit):
 *   - From cannot be later than To ('YYYY-MM' compares lexicographically);
 *   - Graduation Date cannot be earlier than the From period (compared at month precision, so graduating
 *     within the starting month is valid); it MAY be blank while the qualification is incomplete.
 */
function assertDateRules(p: { fromYm: string | null; toYm: string | null; graduationDate: string | null }): void {
  if (p.fromYm && p.toYm && p.fromYm > p.toYm) {
    throw new QualificationValidationError('The From period cannot be later than the To period.');
  }
  if (p.fromYm && p.graduationDate && p.graduationDate.slice(0, 7) < p.fromYm) {
    throw new QualificationValidationError('The graduation date cannot be earlier than the From period.');
  }
}

/**
 * Catalog validation for a NEW qualification pick, mirroring assertProfileValueAllowed semantics: an ACTIVE
 * qualificationLevel option is required — but an EMPTY catalog imposes no constraint (never-seeded tenants
 * keep free-text behaviour), and callers skip this check entirely when the value is unchanged (legacy
 * tolerance: a stored value whose option was later deactivated must keep re-saving).
 */
async function assertQualificationAllowed(tx: Tx, v: string): Promise<void> {
  const options = await tx
    .select({ value: profileOption.value, isActive: profileOption.isActive })
    .from(profileOption)
    .where(eq(profileOption.category, QUALIFICATION_LEVEL_CATEGORY));
  if (options.length === 0) return; // never-seeded catalog ⇒ no constraint (backward-compat)
  if (options.some((o) => o.value === v && o.isActive)) return;
  throw new QualificationValidationError('Qualification is not an active option.');
}

/**
 * Active (non-archived) qualification records for an employment, most recent graduation first (blank
 * graduation dates — still-in-progress qualifications — sort last, newest-created first among themselves).
 * Read-only; RLS scopes it (can_see_employment), so a viewer who can't see the employment gets an empty
 * list, not a leak.
 */
export function listQualifications(
  ctx: SessionContext,
  p: { employmentId: string },
): Promise<QualificationRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employeeQualification.id,
        employmentId: employeeQualification.employmentId,
        qualification: employeeQualification.qualification,
        description: employeeQualification.description,
        fromYm: employeeQualification.fromYm,
        toYm: employeeQualification.toYm,
        institute: employeeQualification.institute,
        major: employeeQualification.major,
        graduationDate: employeeQualification.graduationDate,
        result: employeeQualification.result,
        isHighest: employeeQualification.isHighest,
        archivedAt: employeeQualification.archivedAt,
      })
      .from(employeeQualification)
      .where(
        and(
          eq(employeeQualification.employmentId, p.employmentId),
          isNull(employeeQualification.archivedAt),
        ),
      )
      .orderBy(
        sql`${employeeQualification.graduationDate} desc nulls last`,
        desc(employeeQualification.createdAt),
        desc(employeeQualification.id),
      ),
  );
}

/**
 * Clear the current live highest-qualification holder for an employment (all rows except `exceptId`), part
 * of the transactional flag transfer. Returns the cleared row id (null when there was none) so the caller's
 * event can record the transfer.
 */
async function clearCurrentHighest(
  tx: Tx,
  employmentId: string,
  exceptId: string | null,
): Promise<string | null> {
  const cleared = await tx
    .update(employeeQualification)
    .set({ isHighest: false, updatedAt: new Date() })
    .where(
      and(
        eq(employeeQualification.employmentId, employmentId),
        eq(employeeQualification.isHighest, true),
        isNull(employeeQualification.archivedAt),
        ...(exceptId ? [ne(employeeQualification.id, exceptId)] : []),
      ),
    )
    .returning({ id: employeeQualification.id });
  return cleared[0]?.id ?? null;
}

/**
 * Add a qualification record (admin-only via RLS WITH CHECK is_admin()). Validates the mandatory
 * qualification value (active-catalog rule), the YYYY-MM periods and the cross-field date rules; ticking
 * Highest transfers the flag from the previous holder in the same transaction. Appends `qualification.added`.
 */
export async function addQualification(
  ctx: SessionContext,
  p: {
    employmentId: string;
    qualification: string;
    description?: string | null;
    fromYm?: string | null;
    toYm?: string | null;
    institute?: string | null;
    major?: string | null;
    graduationDate?: string | null;
    result?: string | null;
    isHighest?: boolean;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const qualification = (p.qualification ?? '').trim();
    if (qualification === '') throw new QualificationValidationError('Qualification is required.');
    await assertQualificationAllowed(tx, qualification);
    const fromYm = normYm(p.fromYm, 'From');
    const toYm = normYm(p.toYm, 'To');
    const graduationDate = trimOrNull(p.graduationDate);
    assertDateRules({ fromYm, toYm, graduationDate });
    const isHighest = p.isHighest ?? false;
    // Single-highest transfer: clear the previous holder INSIDE this tx, before the insert, so the partial
    // unique index (the concurrency backstop) never trips on the happy path.
    const clearedHighestId = isHighest ? await clearCurrentHighest(tx, p.employmentId, null) : null;
    const [row] = await tx
      .insert(employeeQualification)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        qualification,
        description: trimOrNull(p.description),
        fromYm,
        toYm,
        institute: trimOrNull(p.institute),
        major: trimOrNull(p.major),
        graduationDate,
        result: trimOrNull(p.result),
        isHighest,
      })
      .returning({ id: employeeQualification.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-qualification',
      aggregateId: row.id,
      eventType: 'qualification.added',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // Catalog value + flag (+ the transfer source) only — free-text details stay on the row.
      payload: { qualification, isHighest, ...(clearedHighestId ? { clearedHighestId } : {}) },
    });
    return { id: row.id };
  });
}

async function loadQualification(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: employeeQualification.id,
      employmentId: employeeQualification.employmentId,
      qualification: employeeQualification.qualification,
      fromYm: employeeQualification.fromYm,
      toYm: employeeQualification.toYm,
      graduationDate: employeeQualification.graduationDate,
      isHighest: employeeQualification.isHighest,
      archivedAt: employeeQualification.archivedAt,
    })
    .from(employeeQualification)
    .where(eq(employeeQualification.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Edit a qualification record (admin-only). Only provided fields change (patch semantics). The date rules
 * are re-validated against the EFFECTIVE values (patch merged over the stored row), so an edit can never
 * leave an invalid period behind. A CHANGED qualification value must pass the active-catalog rule; an
 * unchanged one always re-saves (legacy tolerance). Ticking Highest transfers the flag in the same tx.
 * Appends `qualification.updated` with `{ diff }` (field NAMES only).
 */
export async function updateQualification(
  ctx: SessionContext,
  p: {
    id: string;
    qualification?: string;
    description?: string | null;
    fromYm?: string | null;
    toYm?: string | null;
    institute?: string | null;
    major?: string | null;
    graduationDate?: string | null;
    result?: string | null;
    isHighest?: boolean;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadQualification(tx, p.id);
    if (!existing || existing.archivedAt != null) {
      throw new QualificationValidationError('Qualification record not found.');
    }
    const patch: Record<string, unknown> = {};
    if (p.qualification !== undefined) {
      const qualification = p.qualification.trim();
      if (qualification === '') throw new QualificationValidationError('Qualification is required.');
      // Unchanged value always accepted (legacy tolerance); a changed one must be an active option.
      if (qualification !== existing.qualification) await assertQualificationAllowed(tx, qualification);
      patch.qualification = qualification;
    }
    if (p.description !== undefined) patch.description = trimOrNull(p.description);
    if (p.fromYm !== undefined) patch.fromYm = normYm(p.fromYm, 'From');
    if (p.toYm !== undefined) patch.toYm = normYm(p.toYm, 'To');
    if (p.institute !== undefined) patch.institute = trimOrNull(p.institute);
    if (p.major !== undefined) patch.major = trimOrNull(p.major);
    if (p.graduationDate !== undefined) patch.graduationDate = trimOrNull(p.graduationDate);
    if (p.result !== undefined) patch.result = trimOrNull(p.result);
    if (p.isHighest !== undefined) patch.isHighest = p.isHighest;

    // Cross-field rules against the EFFECTIVE record (patched fields win, stored values fill the rest).
    assertDateRules({
      fromYm: (patch.fromYm as string | null | undefined) ?? existing.fromYm,
      toYm: (patch.toYm as string | null | undefined) ?? existing.toYm,
      graduationDate: (patch.graduationDate as string | null | undefined) ?? existing.graduationDate,
    });

    // Single-highest transfer: newly ticking Highest clears the previous holder in the same tx.
    let clearedHighestId: string | null = null;
    if (p.isHighest === true && !existing.isHighest) {
      clearedHighestId = await clearCurrentHighest(tx, existing.employmentId, p.id);
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await tx.update(employeeQualification).set(patch).where(eq(employeeQualification.id, p.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-qualification',
      aggregateId: p.id,
      eventType: 'qualification.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      // Field NAMES only — the free-text values stay on the row.
      payload: {
        diff: Object.keys(patch).filter((k) => k !== 'updatedAt'),
        ...(clearedHighestId ? { clearedHighestId } : {}),
      },
    });
    return { id: p.id };
  });
}

/**
 * Soft-delete a qualification record (admin-only) — sets archived_at so the audit stays reconcilable. An
 * archived highest simply stops being the highest (the partial unique index ignores archived rows); no
 * automatic re-election. Appends `qualification.archived`.
 */
export async function archiveQualification(
  ctx: SessionContext,
  p: { id: string },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadQualification(tx, p.id);
    if (!existing || existing.archivedAt != null) {
      throw new QualificationValidationError('Qualification record not found.');
    }
    await tx
      .update(employeeQualification)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(employeeQualification.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-qualification',
      aggregateId: p.id,
      eventType: 'qualification.archived',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      payload: { qualification: existing.qualification, wasHighest: existing.isHighest },
    });
    return { id: p.id };
  });
}
