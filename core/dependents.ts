/**
 * Personnel Information — Family / Dependents (phase 1). A per-PERSON register of a person's family
 * members / dependents (spouse, child, parent, sibling, other) for BENEFITS / INSURANCE records only.
 *
 * KEYING — personId, NOT employmentId. Dependents are a PERSON fact (concurrent-employment-safe, like
 * tp1_relief / employee_statutory_my): keying on one employment would orphan the record on termination,
 * hide it from the other company's admin, and break for a not-yet-employed person. The detail page is
 * keyed by employmentId, so it resolves person_id from the already-loaded employment and passes it here.
 *
 * ⚠ FIREWALL AMENDED — R46 47146ea3. This register originally did NOT feed PCB: it was deliberately
 * SEPARATE from employee_statutory_my.num_children (the figure that drives tax), and a human had to confirm
 * the derived count into the tax field via a "Use {count}" button. That approval step is GONE. When
 * employee_statutory_my.child_relief_mode === 'auto', writes here now propagate the derived eligible-child
 * head count straight into num_children — see syncChildReliefFromFamily below.
 *
 * The approval gate is replaced by FOUR rails, not removed outright:
 *   (a) opt-in — nothing happens unless child_relief_mode === 'auto'; every 'manual' person is untouched;
 *   (b) no-op — nothing is written when the derived count already equals the stored one;
 *   (c) provenance — the resulting `employee.tax.updated` event carries `auto: true`, so an auditor can
 *       always tell a machine-driven tax movement from a human one;
 *   (d) payroll alert — an open (non-closed) batch for the current period is flagged, NOT blocked, so HR
 *       is never stuck but payroll is never ambushed.
 * Closed payroll remains untouchable regardless: closed-batch immutability is enforced at the DB level.
 *
 * The is_beneficiary boolean is still a plain insurance-beneficiary flag — NOT a fractional 100%-split
 * allocation and NOT a tax-dependent flag. This also stays distinct from the flat person.emergency_contact_*
 * columns (which answer "who to call in an emergency"); we do NOT migrate or backfill those into this table.
 *
 * Substrate discipline (ADR-0006 / ADR-0030 Layer 0): every write appends a DomainEvent whose payload
 * carries field NAMES + relationship only — never the cleartext IC, DOB or full name (PII lives on the
 * aggregate row). subjectEmploymentId is resolved via subjectEmploymentForPerson (null when the person has
 * no employment → the event is admin-only-readable, which is acceptable).
 */
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { employeeDependent, employeeStatutoryMy, employment, payrollBatch } from '../db/schema';
import { setTaxProfileMY } from '../localization/my/statutory';

/** Allowed relationship values (validated server-side; the UI renders each as a static i18n label). */
export const DEPENDENT_RELATIONSHIPS = ['spouse', 'child', 'parent', 'sibling', 'other'] as const;
export type DependentRelationship = (typeof DEPENDENT_RELATIONSHIPS)[number];

/** Allowed gender values (optional). */
export const DEPENDENT_GENDERS = ['male', 'female', 'undisclosed'] as const;
export type DependentGender = (typeof DEPENDENT_GENDERS)[number];

/** Allowed spouse marriage-status values (optional; only meaningful for a spouse record). */
export const DEPENDENT_MARRIAGE_STATUSES = ['married', 'divorced', 'widowed', 'separated'] as const;
export type DependentMarriageStatus = (typeof DEPENDENT_MARRIAGE_STATUSES)[number];

/**
 * Item 6c635212 — Malaysia Income Tax (PCB / TP1) child-relief categories, the five LHDN s.48 cases:
 *   under_18         — child under 18
 *   study_preu       — 18+, unmarried, in full-time pre-university study (A-Levels, matriculation, etc.)
 *   study_tertiary   — 18+, unmarried, in full-time diploma / degree (and above) study
 *   disabled         — disabled child (OKU)
 *   disabled_study   — disabled child in full-time (diploma / degree and above) study
 * Only meaningful for a `child` record; validate-or-ignore otherwise. Nullable = not yet configured.
 */
export const CHILD_RELIEF_CATEGORIES = [
  'under_18',
  'study_preu',
  'study_tertiary',
  'disabled',
  'disabled_study',
] as const;
export type ChildReliefCategory = (typeof CHILD_RELIEF_CATEGORIES)[number];

/** Allowed relief shares when parents split the claim (LHDN: 100% one parent, or 50% each). */
export const CHILD_RELIEF_PERCENTAGES = [100, 50] as const;

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
  // 4535b733 — Family Information enhancement fields.
  passportNumber: string | null;
  residentialAddress: string | null;
  isDeceased: boolean;
  deceasedOn: string | null;
  marriageDate: string | null;
  marriageStatus: string | null;
  spouseWorking: boolean | null;
  occupation: string | null;
  companyName: string | null;
  employerAddress: string | null;
  isStudent: boolean | null;
  schoolName: string | null;
  // Item 5988053a — child education detail (free text, child-gated like schoolName).
  studyLevel: string | null;
  studyCountry: string | null;
  // Item 6c635212 — Malaysia Income Tax child-relief config (child records only).
  childReliefCategory: string | null;
  childTaxRelief: boolean | null;
  childReliefPercentage: number | null;
  archivedAt: Date | null;
};

/**
 * The additional family fields shared by add + update. Every field is optional; the caller passes only the
 * ones it wants to set. All are validate-or-normalise → the DB stays permissive (legacy rows unaffected).
 */
export type DependentExtraInput = {
  passportNumber?: string | null;
  residentialAddress?: string | null;
  isDeceased?: boolean;
  deceasedOn?: string | null;
  marriageDate?: string | null;
  marriageStatus?: string | null;
  spouseWorking?: boolean | null;
  occupation?: string | null;
  companyName?: string | null;
  employerAddress?: string | null;
  isStudent?: boolean | null;
  schoolName?: string | null;
  // Item 5988053a — child education detail. Free text via trimOrNull, exactly like schoolName; studyCountry
  // is catalog-backed in the UI (profile_option country) but legacy-tolerant at this layer.
  studyLevel?: string | null;
  studyCountry?: string | null;
  // Item 6c635212 — Malaysia Income Tax child-relief config (child records only; validate-or-ignore otherwise).
  childReliefCategory?: string | null;
  childTaxRelief?: boolean | null;
  childReliefPercentage?: number | null;
};

function isRelationship(v: string): v is DependentRelationship {
  return (DEPENDENT_RELATIONSHIPS as readonly string[]).includes(v);
}

/**
 * Item 8b5334db — derive the number of children ELIGIBLE for PCB child relief from the Family register, so the
 * Identification & Tax card's "Auto" mode can SURFACE a suggested count for HR to confirm. This is a pure,
 * read-only helper (no 'use client', no DB, no side-effects): it does NOT write num_children and it does NOT
 * feed payroll — it only produces a suggestion the admin explicitly confirms into num_children, preserving the
 * benefits-vs-tax firewall (this module never silently drives tax; see the file header).
 *
 * LHDN child-relief eligibility (simplified, per the Income Tax Act s.48): an unmarried child is eligible if
 * they are (a) under 18, OR (b) 18+ and in full-time education (isStudent). Deceased children are excluded.
 * Only `relationship === 'child'` rows are considered. `asOf` defaults to today (age is computed against it).
 *
 * Item 6c635212 — when a child carries an EXPLICIT per-child relief decision (childTaxRelief non-null), it
 * takes precedence over the DOB/student inference: `true` counts, `false` is an explicit opt-out. A child with
 * childTaxRelief === null (legacy / not yet configured) falls back to the inference below, so existing rows and
 * the suggestion behaviour are unchanged. The 100|50 relief SHARE affects the relief AMOUNT, not the head
 * count, so a 50%-shared eligible child is still one eligible child here (num_children is a whole count).
 */
/** The row shape the eligibility rule needs (a subset of DependentRow, so page rows qualify too). */
export type ChildReliefEligibilityRow = Pick<
  DependentRow,
  'relationship' | 'dateOfBirth' | 'isStudent' | 'isDeceased' | 'archivedAt'
> & {
  // Optional so legacy callers (that don't carry the R45 per-child flag) still type-check; an absent flag
  // (undefined) falls through to the DOB/student inference exactly like a null.
  childTaxRelief?: boolean | null;
};

/**
 * Item 5988053a — whole-year age from a DOB string as of `asOf`. Pure (no DB, no 'use client'); this is the
 * ONE age rule in the codebase: the detail page's Age column/field and the eligibility predicate below both
 * use it (formerly a private dobAgeYears copy on page.tsx). Null when no/invalid DOB. The 365.25-day divisor
 * is preserved as-is from the original implementations; changing it is a separate behavioural change.
 */
export function childAgeYears(dob: string | null | undefined, asOf: Date = new Date()): number | null {
  if (!dob) return null;
  const ms = Date.parse(`${dob}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.floor((asOf.getTime() - ms) / (365.25 * 24 * 60 * 60 * 1000));
}

/**
 * Item 5988053a — the per-row eligibility predicate, extracted from eligibleChildReliefCount so there is
 * exactly ONE eligibility rule shared by the payroll-facing count and the Family tab's "Counts toward tax
 * relief" column (they can never diverge). Behaviour is identical to the original inline filter:
 *   - relationship must be 'child'; deceased and archived rows are excluded;
 *   - an EXPLICIT per-child decision (childTaxRelief non-null) wins over inference, both directions;
 *   - a full-time student is eligible regardless of exact age (the 18+ in-education case);
 *   - otherwise eligible only when under 18; no/invalid DOB ⇒ cannot confirm age ⇒ not auto-counted.
 * (childAgeYears floors to whole years; for the under-18 test `floor(age) < 18 ⇔ age < 18`, so the floor
 * changes nothing against the original fractional comparison.)
 */
export function isChildReliefEligible(r: ChildReliefEligibilityRow, asOf: Date = new Date()): boolean {
  if (r.relationship !== 'child') return false;
  if (r.isDeceased) return false;
  if (r.archivedAt) return false;
  // Explicit per-child decision wins over inference (both directions).
  if (r.childTaxRelief != null) return r.childTaxRelief;
  // Full-time student ⇒ eligible regardless of exact age (covers the 18+ in-education case).
  if (r.isStudent) return true;
  // Otherwise eligible only when under 18. No DOB ⇒ cannot confirm age ⇒ not auto-counted (HR keys it).
  const age = childAgeYears(r.dateOfBirth, asOf);
  return age != null && age < 18;
}

export function eligibleChildReliefCount(
  rows: ChildReliefEligibilityRow[],
  asOf: Date = new Date(),
): number {
  return rows.filter((r) => isChildReliefEligible(r, asOf)).length;
}

/**
 * R46 47146ea3 — outcome of an automatic child-relief sync. `changed` says whether num_children actually
 * moved; `payrollAlert` is set when the move landed while a non-closed payroll batch exists for the current
 * period (rail (d): we ALERT, we do not block). `skipped` explains a no-write so callers and tests can
 * distinguish "nothing to do" from "something failed".
 */
export type ChildReliefSyncResult = {
  changed: boolean;
  before: number | null;
  after: number | null;
  payrollAlert: { period: string; batches: number } | null;
  skipped: 'manual_mode' | 'unchanged' | 'no_statutory_row' | 'error' | null;
};

const NO_SYNC = (skipped: ChildReliefSyncResult['skipped']): ChildReliefSyncResult => ({
  changed: false,
  before: null,
  after: null,
  payrollAlert: null,
  skipped,
});

/**
 * R46 47146ea3 — propagate the derived eligible-child head count from the Family register into the PCB tax
 * field (employee_statutory_my.num_children), replacing the manual "Use {count}" confirmation button.
 *
 * WHY THIS LIVES IN THE CORE SERVICE and not in dependent-actions.ts: hooking the server action would only
 * cover the admin form. Hooking here covers CSV import and every other current or future caller of
 * addDependent / updateDependent / archiveDependent, so the tax figure cannot drift just because a record
 * was created through a different door.
 *
 * WHY IT RUNS AFTER THE DEPENDENT TRANSACTION COMMITS, not inside it: setTaxProfileMY opens its own
 * withTenant transaction, and nesting withTenant takes a SECOND pooled connection — a self-deadlock. Running
 * afterwards is also the behaviour we want for rail-safety: this function NEVER throws. A failure to sync
 * must not roll back or fail the family-record save the user actually asked for. The cost is that the two
 * writes are not atomic; that is acceptable because the sync is derived data that any later dependent write
 * (or a manual save) re-derives and self-heals.
 *
 * Rails (a) and (b) are enforced here; (c) is enforced by passing provenance to setTaxProfileMY; (d) is the
 * payrollAlert this returns.
 */
export async function syncChildReliefFromFamily(
  ctx: SessionContext,
  personId: string,
): Promise<ChildReliefSyncResult> {
  try {
    const state = await withTenant(ctx, async (tx) => {
      const [statutory] = await tx
        .select({
          numChildren: employeeStatutoryMy.numChildren,
          childReliefMode: employeeStatutoryMy.childReliefMode,
          taxNumber: employeeStatutoryMy.taxNumber,
          taxCategory: employeeStatutoryMy.taxCategory,
          taxResidency: employeeStatutoryMy.taxResidency,
          employerBearsTax: employeeStatutoryMy.employerBearsTax,
        })
        .from(employeeStatutoryMy)
        .where(eq(employeeStatutoryMy.personId, personId))
        .limit(1);
      // No statutory row yet (the IC on the Profile tab seeds it). setTaxProfileMY would throw NoIcYetError
      // here — an entirely normal state for a person whose IC has not been keyed. Treat it as "nothing to
      // sync", never as an error that could surface on a family-record save.
      if (!statutory) return null;
      const rows = await tx
        .select({
          relationship: employeeDependent.relationship,
          dateOfBirth: employeeDependent.dateOfBirth,
          isStudent: employeeDependent.isStudent,
          isDeceased: employeeDependent.isDeceased,
          archivedAt: employeeDependent.archivedAt,
          childTaxRelief: employeeDependent.childTaxRelief,
        })
        .from(employeeDependent)
        .where(eq(employeeDependent.personId, personId));
      return { statutory, derived: eligibleChildReliefCount(rows) };
    });

    if (!state) return NO_SYNC('no_statutory_row');
    // Rail (a) — opt-in. A person on 'manual' keeps full human control of their tax figure.
    if (state.statutory.childReliefMode !== 'auto') return NO_SYNC('manual_mode');
    // Rail (b) — no-op when nothing moved. Prevents a spurious tax event on every unrelated family edit.
    if (state.statutory.numChildren === state.derived) return NO_SYNC('unchanged');

    // Rail (d) — is a payroll run for the current period still open? Detect BEFORE writing so the alert
    // describes the same moment as the write. We alert rather than block (approved): blocking would leave
    // HR unable to correct a family record for as long as payroll stays open.
    const payrollAlert = await withTenant(ctx, async (tx) => {
      const employments = await tx
        .select({ companyId: employment.companyId })
        .from(employment)
        .where(and(eq(employment.tenantId, ctx.tenantId), eq(employment.personId, personId)));
      const companyIds = Array.from(new Set(employments.map((e) => e.companyId)));
      if (companyIds.length === 0) return null;
      const period = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
      const open = await tx
        .select({ id: payrollBatch.id })
        .from(payrollBatch)
        .where(
          and(
            eq(payrollBatch.tenantId, ctx.tenantId),
            inArray(payrollBatch.companyId, companyIds),
            eq(payrollBatch.payPeriod, period),
            // draft + processed are the exposed window. 'closed' is immutable at the DB level (mig 0011
            // triggers) and its payslips are frozen snapshots, so a closed batch cannot be disturbed.
            ne(payrollBatch.status, 'closed'),
          ),
        );
      return open.length > 0 ? { period, batches: open.length } : null;
    });

    // Rail (c) — reuse the single audited tax writer, stamped with provenance so the resulting
    // `employee.tax.updated` event is identifiable as machine-driven. Every other tax column is carried
    // forward unchanged: setTaxProfileMY overwrites the whole tax column set, so omitting them would
    // silently reset residency / category / employer-bears-tax.
    await setTaxProfileMY(ctx, {
      personId,
      taxNumber: state.statutory.taxNumber,
      taxCategory: state.statutory.taxCategory ?? undefined,
      taxResidency: state.statutory.taxResidency,
      childReliefMode: 'auto',
      employerBearsTax: state.statutory.employerBearsTax ?? false,
      numChildren: state.derived,
      provenance: 'auto_child_relief',
    });

    return {
      changed: true,
      before: state.statutory.numChildren,
      after: state.derived,
      payrollAlert,
      skipped: null,
    };
  } catch {
    // Deliberate swallow. The family-record write has ALREADY committed and is what the user asked for;
    // failing it now because a derived tax figure could not be refreshed would be strictly worse. The next
    // dependent write (or a manual Identity & Tax save) re-derives and self-heals.
    return NO_SYNC('error');
  }
}

function normGender(v: string | null | undefined): string | null {
  if (v == null || v.trim() === '') return null;
  if (!(DEPENDENT_GENDERS as readonly string[]).includes(v)) {
    throw new DependentValidationError('Dependent gender is invalid.');
  }
  return v;
}

function normMarriageStatus(v: string | null | undefined): string | null {
  if (v == null || v.trim() === '') return null;
  if (!(DEPENDENT_MARRIAGE_STATUSES as readonly string[]).includes(v)) {
    throw new DependentValidationError('Marriage status is invalid.');
  }
  return v;
}

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

/** Item 6c635212 — normalise the PCB child-relief category (∈ allowed set, else throw). Blank ⇒ null. */
function normChildReliefCategory(v: string | null | undefined): string | null {
  if (v == null || v.trim() === '') return null;
  if (!(CHILD_RELIEF_CATEGORIES as readonly string[]).includes(v)) {
    throw new DependentValidationError('Child relief category is invalid.');
  }
  return v;
}

/** Item 6c635212 — normalise the child-relief share (100 | 50, else throw). Null/blank ⇒ null. */
function normChildReliefPercentage(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (!(CHILD_RELIEF_PERCENTAGES as readonly number[]).includes(v)) {
    throw new DependentValidationError('Child relief percentage must be 100 or 50.');
  }
  return v;
}

/**
 * Column values for the enhancement fields on an ADD, relationship-gated: spouse-only fields (marriage,
 * spouse employment) persist only for a spouse; student/school only for a child; anything else is stored
 * NULL regardless of the input (validate-or-ignore). General fields apply to every relationship.
 */
function extraColumnsForAdd(relationship: string, x: DependentExtraInput) {
  const isSpouse = relationship === 'spouse';
  const isChild = relationship === 'child';
  return {
    passportNumber: trimOrNull(x.passportNumber),
    residentialAddress: trimOrNull(x.residentialAddress),
    isDeceased: x.isDeceased ?? false,
    deceasedOn: trimOrNull(x.deceasedOn),
    occupation: trimOrNull(x.occupation),
    marriageDate: isSpouse ? trimOrNull(x.marriageDate) : null,
    marriageStatus: isSpouse ? normMarriageStatus(x.marriageStatus) : null,
    spouseWorking: isSpouse ? (x.spouseWorking ?? null) : null,
    companyName: isSpouse ? trimOrNull(x.companyName) : null,
    employerAddress: isSpouse ? trimOrNull(x.employerAddress) : null,
    isStudent: isChild ? (x.isStudent ?? null) : null,
    schoolName: isChild ? trimOrNull(x.schoolName) : null,
    // Item 5988053a — education detail, child-gated exactly like schoolName.
    studyLevel: isChild ? trimOrNull(x.studyLevel) : null,
    studyCountry: isChild ? trimOrNull(x.studyCountry) : null,
    // Item 6c635212 — PCB child-relief config, child-gated (validate-or-ignore for non-children).
    childReliefCategory: isChild ? normChildReliefCategory(x.childReliefCategory) : null,
    childTaxRelief: isChild ? (x.childTaxRelief ?? null) : null,
    childReliefPercentage: isChild ? normChildReliefPercentage(x.childReliefPercentage) : null,
  };
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
        passportNumber: employeeDependent.passportNumber,
        residentialAddress: employeeDependent.residentialAddress,
        isDeceased: employeeDependent.isDeceased,
        deceasedOn: employeeDependent.deceasedOn,
        marriageDate: employeeDependent.marriageDate,
        marriageStatus: employeeDependent.marriageStatus,
        spouseWorking: employeeDependent.spouseWorking,
        occupation: employeeDependent.occupation,
        companyName: employeeDependent.companyName,
        employerAddress: employeeDependent.employerAddress,
        isStudent: employeeDependent.isStudent,
        schoolName: employeeDependent.schoolName,
        studyLevel: employeeDependent.studyLevel,
        studyCountry: employeeDependent.studyCountry,
        childReliefCategory: employeeDependent.childReliefCategory,
        childTaxRelief: employeeDependent.childTaxRelief,
        childReliefPercentage: employeeDependent.childReliefPercentage,
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
export async function addDependent(
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
  } & DependentExtraInput,
): Promise<{ id: string; childReliefSync: ChildReliefSyncResult }> {
  const res = await withTenant(ctx, async (tx) => {
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
        ...extraColumnsForAdd(p.relationship, p),
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
  // R46 47146ea3 — refresh the PCB child count from the register. Runs after commit, never throws.
  const childReliefSync = await syncChildReliefFromFamily(ctx, p.personId);
  return { ...res, childReliefSync };
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
export async function updateDependent(
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
  } & DependentExtraInput,
): Promise<{ id: string; childReliefSync: ChildReliefSyncResult }> {
  const res = await withTenant(ctx, async (tx) => {
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

    // 4535b733 — enhancement fields. General fields apply to any relationship. Spouse-only + child-only
    // fields are relationship-gated against the EFFECTIVE relationship (post-patch): a provided spouse
    // field is ignored (validate-or-ignore) when the member is not a spouse, and when the relationship is
    // CHANGED away from spouse/child we NULL the now-irrelevant fields so no stale cross-section data
    // lingers.
    const effRel = (patch.relationship as string | undefined) ?? existing.relationship;
    const isSpouse = effRel === 'spouse';
    const isChild = effRel === 'child';
    const relChanged = patch.relationship !== undefined && patch.relationship !== existing.relationship;

    if (p.passportNumber !== undefined) patch.passportNumber = trimOrNull(p.passportNumber);
    if (p.residentialAddress !== undefined) patch.residentialAddress = trimOrNull(p.residentialAddress);
    if (p.isDeceased !== undefined) patch.isDeceased = p.isDeceased;
    if (p.deceasedOn !== undefined) patch.deceasedOn = trimOrNull(p.deceasedOn);
    if (p.occupation !== undefined) patch.occupation = trimOrNull(p.occupation);

    if (isSpouse) {
      if (p.marriageDate !== undefined) patch.marriageDate = trimOrNull(p.marriageDate);
      if (p.marriageStatus !== undefined) patch.marriageStatus = normMarriageStatus(p.marriageStatus);
      if (p.spouseWorking !== undefined) patch.spouseWorking = p.spouseWorking;
      if (p.companyName !== undefined) patch.companyName = trimOrNull(p.companyName);
      if (p.employerAddress !== undefined) patch.employerAddress = trimOrNull(p.employerAddress);
    } else if (relChanged) {
      patch.marriageDate = null;
      patch.marriageStatus = null;
      patch.spouseWorking = null;
      patch.companyName = null;
      patch.employerAddress = null;
    }

    if (isChild) {
      if (p.isStudent !== undefined) patch.isStudent = p.isStudent;
      if (p.schoolName !== undefined) patch.schoolName = trimOrNull(p.schoolName);
      // Item 5988053a — education detail.
      if (p.studyLevel !== undefined) patch.studyLevel = trimOrNull(p.studyLevel);
      if (p.studyCountry !== undefined) patch.studyCountry = trimOrNull(p.studyCountry);
      // Item 6c635212 — PCB child-relief config.
      if (p.childReliefCategory !== undefined) patch.childReliefCategory = normChildReliefCategory(p.childReliefCategory);
      if (p.childTaxRelief !== undefined) patch.childTaxRelief = p.childTaxRelief;
      if (p.childReliefPercentage !== undefined) patch.childReliefPercentage = normChildReliefPercentage(p.childReliefPercentage);
    } else if (relChanged) {
      patch.isStudent = null;
      patch.schoolName = null;
      patch.studyLevel = null;
      patch.studyCountry = null;
      patch.childReliefCategory = null;
      patch.childTaxRelief = null;
      patch.childReliefPercentage = null;
    }

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
    return { id: p.id, personId: existing.personId };
  });
  // R46 47146ea3 — a DOB correction, a student-flag change or an explicit childTaxRelief decision can all
  // move the eligible count, so an edit must re-sync exactly like an add.
  const childReliefSync = await syncChildReliefFromFamily(ctx, res.personId);
  return { id: res.id, childReliefSync };
}

/**
 * Soft-delete a family/dependent record (admin-only) — sets archived_at so the audit stays reconcilable.
 * Appends `dependent.archived`.
 */
export async function archiveDependent(
  ctx: SessionContext,
  p: { id: string },
): Promise<{ id: string; childReliefSync: ChildReliefSyncResult }> {
  const res = await withTenant(ctx, async (tx) => {
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
    return { id: p.id, personId: existing.personId };
  });
  // R46 47146ea3 — archiving a child removes it from the eligible count (eligibleChildReliefCount excludes
  // archivedAt rows), so the tax figure must come down with it.
  const childReliefSync = await syncChildReliefFromFamily(ctx, res.personId);
  return { id: res.id, childReliefSync };
}
