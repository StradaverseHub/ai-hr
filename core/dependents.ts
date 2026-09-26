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
import { company, employeeDependent, employeeStatutoryMy, employment, payrollBatch, profileOption } from '../db/schema';
import { packFor, requirePackFor } from '../localization/registry';
// Type-only (ADR-0080 D7): the child-relief COUNT/AMOUNT contract shapes, so the weighted derivation
// below can take the pack's own functions as parameters without this module naming a MY figure.
import type { ChildReliefFigure, ChildReliefInput, ChildReliefPrice } from '../localization/country-pack';
// item 759dfc7d — the closed value sets, shared with the browser (see the re-export block below).
import {
  CHILD_RELIEF_CATEGORIES,
  CHILD_RELIEF_PERCENTAGES,
  DEPENDENT_GENDERS,
  DEPENDENT_MARRIAGE_STATUSES,
  DEPENDENT_RELATIONSHIPS,
  childAgeYears,
  type DependentRelationship,
} from '../lib/dependent-vocabulary';

/**
 * THE CLOSED VALUE SETS NOW LIVE IN `lib/dependent-vocabulary.ts` and are re-exported here unchanged
 * (item 759dfc7d). They had to move because a CLIENT component — the draft's Family form — cannot import
 * this module (it pulls the pg driver via db/client), and a second copy of the lists in the browser is
 * how the draft screen and the Personnel screen would come to accept different values. Re-exported rather
 * than relocated at the call sites so every existing `from '../core/dependents'` import keeps working and
 * this stays the one place a server caller needs to know about.
 */
export {
  DEPENDENT_RELATIONSHIPS,
  DEPENDENT_GENDERS,
  DEPENDENT_MARRIAGE_STATUSES,
  CHILD_RELIEF_CATEGORIES,
  CHILD_RELIEF_PERCENTAGES,
  dependentPanelOf,
} from '../lib/dependent-vocabulary';
export type {
  DependentRelationship,
  DependentGender,
  DependentMarriageStatus,
  ChildReliefCategory,
} from '../lib/dependent-vocabulary';

/**
 * ea36b7fa — the profile_option category backing the Family tab's Relationship dropdown (System Settings >
 * System Labels > Profile Options). DELIBERATELY DISTINCT from the existing 'relationship' category, which
 * governs person.emergencyContactRelationship — do NOT conflate the two. Defined here (not in
 * core/profile-options.ts) because profile-options already imports from this module, keeping the dependency
 * one-directional.
 */
export const DEPENDENT_RELATIONSHIP_CATEGORY = 'dependentRelationship' as const;

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

/** Is this one of the five built-in relationship values (the ones system logic keys off)? */
export function isBuiltinDependentRelationship(v: string): v is DependentRelationship {
  return (DEPENDENT_RELATIONSHIPS as readonly string[]).includes(v);
}

/**
 * ea36b7fa — relationship validation, catalog-aware. The five built-ins are ALWAYS accepted (spouse fields
 * and child tax relief key off them, so they can never be configured away server-side); anything else must
 * be an ACTIVE custom option in the dependentRelationship catalog. Runs inside the caller's tx so it
 * participates in the same RLS session. A deactivated custom value is rejected as a NEW pick — the caller
 * (updateDependent) skips this check when the relationship is unchanged, so existing rows keep saving
 * (legacy-value tolerance, mirroring assertProfileValueAllowed).
 */
async function assertRelationshipAllowed(tx: Tx, v: string): Promise<void> {
  if (isBuiltinDependentRelationship(v)) return;
  const [row] = await tx
    .select({ id: profileOption.id })
    .from(profileOption)
    .where(
      and(
        eq(profileOption.category, DEPENDENT_RELATIONSHIP_CATEGORY),
        eq(profileOption.value, v),
        eq(profileOption.isActive, true),
      ),
    )
    .limit(1);
  if (!row) throw new DependentValidationError('Dependent relationship is invalid.');
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
 * Item 5988053a — whole-year age from a DOB string as of `asOf`. THE ONE age rule in the codebase: the
 * detail page's Age column/field and the eligibility predicate below both use it (formerly a private
 * dobAgeYears copy on page.tsx).
 *
 * ITS BODY MOVED to `lib/dependent-vocabulary.ts` (item 759dfc7d) so the draft's Family form — a client
 * component, which cannot import this module — shows the same Age from the same function rather than a
 * third copy of the arithmetic. Re-exported here so every existing caller is untouched.
 */
export { childAgeYears } from '../lib/dependent-vocabulary';

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

/**
 * THE HEAD COUNT. One eligible child is ONE, whatever s.48 category is recorded against it.
 *
 * ⚠️ r343 (04b88724) — THIS STAYS A HEAD COUNT ON PURPOSE, AND THE REASON IS THE COLUMN IT IS WRITTEN TO.
 * `syncChildReliefFromFamily` writes this value into `employee_statutory_my.num_children`, and that column
 * is read as a HEAD COUNT by three statutory documents. Each reader, checked in this tree (the r343 fix pass
 * corrected this citation: it used to point at db/schema.ts, which says nothing about a head count on that
 * column — the note there is about how the column is MAINTAINED, not how it is read):
 *   · Form E / CP8D — localization/my/reports.ts, the `children: employeeStatutoryMy.numChildren` select
 *     under the `── Annual (Form E / CP8D) ──` heading, printed by the `{ key: 'children', label: 'Children' }`
 *     column of `CP8D_COLS`;
 *   · the EA statement — the same select inside `eaStatement`, printed into EA item 8 by lib/ea-pdf.ts
 *     (`String(d.employee.children)`);
 *   · and localization/my/statutory.ts states it in words: "Payroll always reads num_children as the head
 *     count regardless of mode."
 * Making this function return the s.48 WEIGHTED count would make those statutory documents print a weighted
 * figure as a head count — an employee with one disabled child in higher education would be declared as
 * having eight children. The approved plan named that as the decision the item turns on and recommended
 * leaving `num_children` alone.
 *
 * The weighted figure the PCB calculation actually wants is `eligibleChildReliefUnits` below. It is derived,
 * never stored here, and what still has to happen for it to reach a payslip is recorded on that function.
 */
export function eligibleChildReliefCount(
  rows: ChildReliefEligibilityRow[],
  asOf: Date = new Date(),
): number {
  return rows.filter((r) => isChildReliefEligible(r, asOf)).length;
}

/** A Family-register row carrying the two PCB child-relief facts on top of the eligibility fields: the
 *  s.48 category (item 6c635212) and the claim share (100 | 50). */
export type ChildReliefCategorisedRow = ChildReliefEligibilityRow & {
  childReliefCategory: string | null;
  childReliefPercentage: number | null;
};

/** The keyed relief grid: per s.48 category, the count claimed at 100% and the count claimed at 50%. The
 *  same shape `employee_statutory_my.child_relief_table` stores and `childReliefAmountFor` prices. */
export type ChildReliefGrid = Record<string, { full: number; half: number }>;

/**
 * The Family register → a keyed relief grid, by the SAME eligibility rule the head count uses
 * (`isChildReliefEligible`: relationship 'child', not deceased, not archived, explicit per-child decision
 * wins, else student-or-under-18).
 *
 * ⚠️ A SHARE OF `null` IS COUNTED AS THE FULL 100% CLAIM. That is the LHDN default (the whole child is
 * claimed by one parent unless the parents split it) and it matches how the head count already treats a
 * 50%-shared child — as one whole child. Every screen that prints a figure from this says so in its own
 * words rather than letting a derived number look more certain than it is.
 *
 * A child with NO recorded category contributes nothing and is counted in `eligible` but not in
 * `categorised`, so the caller can say "this covers 4 of 6 children" instead of quietly understating
 * somebody's relief.
 *
 * ITS HOME MOVED HERE IN r343 (from core/child-relief-review.ts, which re-exports it unchanged so every
 * existing caller and test is untouched). It had to move because `eligibleChildReliefUnits` and
 * `qualifyingChildReliefFor` — both in this module — need it, and core/child-relief-review.ts already
 * imports from here; leaving it there and importing it back would be a cycle, and copying it would be a
 * second walk of the Family register, which is the exact duplication r340 shipped and had to undo.
 */
export function childReliefGridFromFamily(
  rows: ChildReliefCategorisedRow[],
  asOf: Date,
): { grid: ChildReliefGrid; eligible: number; categorised: number } {
  const grid: ChildReliefGrid = {};
  let eligible = 0;
  let categorised = 0;
  for (const r of rows) {
    if (!isChildReliefEligible(r, asOf)) continue;
    eligible += 1;
    const cat = r.childReliefCategory;
    if (!cat || !(CHILD_RELIEF_CATEGORIES as readonly string[]).includes(cat)) continue;
    categorised += 1;
    const cell = (grid[cat] ??= { full: 0, half: 0 });
    // 50 is the only share that is not the whole claim; null/absent ⇒ the full claim (see the note above).
    if (r.childReliefPercentage === 50) cell.half += 1;
    else cell.full += 1;
  }
  return { grid, eligible, categorised };
}

/**
 * ═══ r343, item 04b88724 — WHAT THE s.48 RULES ACTUALLY CALL FOR, FROM THE FAMILY REGISTER ═══
 *
 * THE DEFECT THIS EXISTS TO MEASURE. `eligibleChildReliefCount` above is a plain head count, the 'auto'
 * sync writes it to `num_children`, and for every mode but 'auto_table' the kernel's child leg is
 * `num_children × perChild` (core/payroll.ts ~5881 and core/payroll-view.ts ~1487 both gate the worked
 * amount on `childReliefMode === 'auto_table'`). So an 'auto' employee is relieved HEADS × RM2,000 and the
 * s.48 weighting never reaches them:
 *
 *     under 18 / pre-university      1 unit    'auto' gives 1   ✓ right by accident
 *     18+ diploma or degree          4 units   'auto' gives 1   ✗ RM8,000 relieved as RM2,000
 *     disabled child                 4 units   'auto' gives 1   ✗
 *     disabled + higher education     8 units   'auto' gives 1   ✗ RM16,000 relieved as RM2,000
 *
 * Under-relieving OVER-deducts PCB every month for those employees.
 *
 * NO UNITS ARE TRANSCRIBED HERE, AND THAT IS DELIBERATE. r339 corrected two of the five figures against
 * the specification's printed p.27 and a second copy in this file would drift from them. The weighting
 * comes from the PACK — `prices` (`pack.payroll.childReliefPrices`, the one place `units = amountRM ÷
 * perChild` is written) priced by `childReliefFor` (`pack.payroll.childReliefFor`, whose `.amountRM` is
 * literally what the payroll kernel's `childReliefAmountFor` returns). Both are passed IN rather than
 * imported, exactly as `childReliefReviewFigures` takes `amountFor`, so this module never names a
 * Malaysian relief amount and a test can drive it with the real pack function.
 *
 * A 50%-shared child is HALF A UNIT, because `childReliefFor` halves it for the grid and this is the same
 * call. No rounding: the count would then disagree with the money beside it.
 *
 * ⚠️⚠️ THIS FIGURE DOES NOT REACH A PAYSLIP YET, AND NOTHING HERE PRETENDS IT DOES. Making it do so needs
 * the worked amount to be supplied for 'auto' as well as 'auto_table' — and a place to keep the weighted
 * figure that is NOT `num_children` (see the warning on `eligibleChildReliefCount`). Neither was available
 * to the round that added this. So for now this is REPORTED, on the Identification & Tax card, as the gap
 * between what the rules call for and what the calculation gives — a disclosure, never a silent tax move.
 *
 * ⚠️⚠️ AND THERE ARE **THREE** `childReliefMode === 'auto_table'` GATES, NOT TWO. The r343 fix pass found the
 * third; a follow-up that widened only the first two would ship a worksheet that disagrees with the payslip
 * it exists to mirror. All three, as they stand today:
 *   1. core/payroll.ts ~5881 — the PAYSLIP. `childReliefAmount` is supplied only for 'auto_table'.
 *   2. core/payroll-view.ts ~1487 — the PCB DRILL-DOWN read model, the same choice again.
 *   3. localization/my/multicycle-worksheet.ts ~601, inside `taxProfileOf` — the MULTICYCLE SIGN-OFF
 *      WORKSHEET, whose own header says it "Mirrors core/payroll.ts's derivation of the per-employee
 *      statutory options, term for term". It replays a period and prints the difference against the filed
 *      payslips, so leaving it on the narrow gate would print a fabricated ringgit difference for every
 *      'auto' employee with a weighted child — the exact class of row that header calls `unexplained`.
 * Whoever widens them widens all three in one change, and the worksheet's mirror claim is the test that
 * they did.
 */
export function eligibleChildReliefUnits(
  rows: ChildReliefCategorisedRow[],
  p: {
    /** `pack.payroll.childReliefPrices(reliefs)` — the ringgit AND the units for each s.48 category. */
    prices: readonly ChildReliefPrice[];
    /** `pack.payroll.childReliefFor` — the ONE derivation; `.amountRM` is what the kernel deducts. */
    childReliefFor: (i: ChildReliefInput) => ChildReliefFigure;
    asOf?: Date;
  },
): { units: number; amountRM: number; eligible: number; categorised: number } {
  const { grid, eligible, categorised } = childReliefGridFromFamily(rows, p.asOf ?? new Date());
  const figure = p.childReliefFor({ from: 'table', table: grid, prices: p.prices });
  return { units: figure.units, amountRM: figure.amountRM, eligible, categorised };
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
          // ⚠️ CARRY-FORWARD LIST — item d64d0df4 regression fix. setTaxProfileMY OVERWRITES the whole
          // tax column set and defaults every omitted field to its "nothing claimed" value, so ANY tax
          // column missing from this select is silently RESET on every automatic family-driven sync.
          // Between migration 0341 and this fix, adding or editing a family record on an employee in
          // 'auto' mode quietly cleared disabled_individual and RAISED their PCB, with nothing on
          // screen saying so. Any tax column added to employee_statutory_my in future MUST be added
          // here and to the setTax call below in the same change.
          disabledIndividual: employeeStatutoryMy.disabledIndividual,
          disabledSpouse: employeeStatutoryMy.disabledSpouse,
          childReliefTable: employeeStatutoryMy.childReliefTable,
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
          // a5f21891 — the two columns the WEIGHTED grid needs. The head count below ignores them, which
          // is why they were not read before; `childReliefGridFromFamily` cannot work without them.
          childReliefCategory: employeeDependent.childReliefCategory,
          childReliefPercentage: employeeDependent.childReliefPercentage,
        })
        .from(employeeDependent)
        .where(eq(employeeDependent.personId, personId));
      // ONE READ, TWO ANSWERS, AND THEY ANSWER DIFFERENT QUESTIONS (a5f21891). `derived` is the HEAD
      // COUNT and stays `num_children`, because Form E, CP8D and EA all read that column as a head count.
      // `grid` is the s.48 WEIGHTING — 1 / 4 / 8 per category, halved for a 50% share — and it is what
      // the PCB calculation prices. Deriving both from the same rows is what stops them disagreeing.
      // ⚠️ THE GRID IS ONLY USABLE WHEN EVERY ELIGIBLE CHILD CARRIES A CATEGORY, AND THIS GATE IS THE
      // WHOLE SAFETY OF THE ITEM. `childReliefGridFromFamily` SKIPS a child with no
      // `child_relief_category` — it cannot price what it cannot classify — but that same child DOES
      // count towards the head count. Pricing an incomplete grid would therefore relieve FEWER children
      // than the employee has: production has one 'auto' employee with 2 eligible children and only 1
      // categorised, who would have gone from RM4,000 of relief to RM2,000 the moment this shipped.
      //
      // So: complete ⇒ the derived grid, and the weighting reaches the payslip. Incomplete ⇒ NULL, which
      // clears any stale grid and drops the kernel back to `num_children × perChild` — exactly today's
      // behaviour, so nobody loses relief while a category is missing. Never carry a stale grid forward:
      // a grid that no longer describes the family is the one thing worse than no grid.
      const built = childReliefGridFromFamily(rows, new Date());
      const grid = built.categorised === built.eligible && built.eligible > 0 ? built.grid : null;
      return { statutory, derived: eligibleChildReliefCount(rows), grid, gridComplete: grid != null };
    });

    if (!state) return NO_SYNC('no_statutory_row');
    // Rail (a) — opt-in. A person on 'manual' keeps full human control of their tax figure.
    if (state.statutory.childReliefMode !== 'auto') return NO_SYNC('manual_mode');
    // Rail (b) — no-op when nothing moved. Prevents a spurious tax event on every unrelated family edit.
    //
    // ⚠️ THE GRID IS PART OF "MOVED" SINCE a5f21891, AND LEAVING IT OUT WOULD HAVE BEEN A SILENT BUG.
    // Changing a child from `under_18` to `disabled_study` moves the s.48 weighting from 1 unit to 8 —
    // RM2,000 of relief to RM16,000 — WITHOUT moving the head count. Comparing only the count would have
    // short-circuited here and left the stored grid, and therefore the payslip, on the old category for
    // as long as nobody added or removed a child.
    // ⚠️ COMPARED CANONICALLY, NOT BY JSON.stringify. The stored grid comes back from JSONB with no key
    // order guarantee, so a plain stringify compares unequal to a freshly-derived grid that is identical
    // in every value — and the sync then fires on EVERY family edit, reporting `changed` where nothing
    // moved. Three existing guards caught that: a spouse add, a custom-relationship add, and an
    // unchanged re-sync all began reporting a move. Sort the keys and normalise the two counts.
    const canonicalGrid = (g: ChildReliefGrid | null | undefined): string =>
      JSON.stringify(
        Object.keys(g ?? {})
          .filter((k) => (g![k]?.full ?? 0) !== 0 || (g![k]?.half ?? 0) !== 0)
          .sort()
          .map((k) => [k, Number(g![k]?.full ?? 0), Number(g![k]?.half ?? 0)]),
      );
    const gridMoved =
      canonicalGrid(state.statutory.childReliefTable as ChildReliefGrid | null) !== canonicalGrid(state.grid);
    if (state.statutory.numChildren === state.derived && !gridMoved) return NO_SYNC('unchanged');

    // Rail (d) — is a payroll run for the current period still open? Detect BEFORE writing so the alert
    // describes the same moment as the write. We alert rather than block (approved): blocking would leave
    // HR unable to correct a family record for as long as payroll stays open.
    // Rung 5a (ADR-0080 D1/D6): the same employment read also resolves the person's jurisdiction
    // (employment → company.country) so the tax write below goes through the person's country pack.
    const { payrollAlert, country } = await withTenant(ctx, async (tx) => {
      const employments = await tx
        .select({ companyId: employment.companyId, country: company.country })
        .from(employment)
        .innerJoin(company, eq(company.id, employment.companyId))
        .where(and(eq(employment.tenantId, ctx.tenantId), eq(employment.personId, personId)));
      const companyIds = Array.from(new Set(employments.map((e) => e.companyId)));
      const country = employments[0]?.country ?? null;
      if (companyIds.length === 0) return { payrollAlert: null, country };
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
      return { payrollAlert: open.length > 0 ? { period, batches: open.length } : null, country };
    });

    // Rail (c) — reuse the single audited tax writer (via the person's country pack — ADR-0080 D1;
    // requirePackFor FAILS LOUDLY for an unknown country / a person with no employment, which the outer
    // catch degrades to NO_SYNC('error'), the rail-safe outcome), stamped with provenance so the resulting
    // `employee.tax.updated` event is identifiable as machine-driven. Every other tax column is carried
    // forward unchanged: the setter overwrites the whole tax column set, so omitting them would
    // silently reset residency / category / employer-bears-tax — and, until item d64d0df4 fixed it here,
    // the disability relief claims below. Only num_children may differ from what was read.
    await requirePackFor(country).statutory.setTax(ctx, {
      personId,
      taxNumber: state.statutory.taxNumber,
      taxCategory: state.statutory.taxCategory ?? undefined,
      taxResidency: state.statutory.taxResidency,
      childReliefMode: 'auto',
      employerBearsTax: state.statutory.employerBearsTax ?? false,
      numChildren: state.derived,
      // d64d0df4 — see the CARRY-FORWARD LIST comment on the select above. These are relief CLAIMS about
      // the employee and their family; a family-record edit must never silently withdraw one.
      disabledIndividual: state.statutory.disabledIndividual ?? false,
      disabledSpouse: state.statutory.disabledSpouse ?? false,
      // a5f21891 — DERIVED, not carried forward. On 'auto' the Family register is the source of truth,
      // so the grid it implies is what gets stored and priced. Before this the sync wrote the head count
      // and left the grid untouched, so `childReliefAmountFor` never saw the weighting and an 'auto'
      // employee was relieved heads x perChild — RM2,000 for a disabled child in higher education that
      // the rules price at RM16,000.
      childReliefTable: state.grid,  // null when a category is missing — see the gate above
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
 * One family member's fields, WITHOUT the person it belongs to. Named because there are now two writers
 * that take exactly this — `addDependent` (one record, its own transaction) and `materialiseDependents`
 * (a whole set, one transaction) — and a shape they shared by accident would be a shape that could drift.
 */
export type DependentInput = {
  fullName: string;
  relationship: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  icOrPassport?: string | null;
  isBeneficiary?: boolean;
  phone?: string | null;
  remarks?: string | null;
} & DependentExtraInput;

/**
 * THE INSERT ITSELF, inside a caller-owned transaction — the one place a family record is created.
 *
 * Extracted from `addDependent` (item 759dfc7d) so that activating a draft can write a whole family in a
 * SINGLE transaction without a second copy of the column mapping, the validation and the event. A second
 * copy is the r73 Decision 3 failure mode exactly: one writer falls behind a column the other gained, and
 * a field entered on the draft is silently dropped at Activate.
 */
async function insertDependentInTx(
  tx: Tx,
  ctx: SessionContext,
  personId: string,
  p: DependentInput,
): Promise<{ id: string }> {
  const fullName = (p.fullName ?? '').trim();
  if (fullName === '') throw new DependentValidationError('Dependent name is required.');
  // ea36b7fa — built-ins always valid; custom types must be ACTIVE dependentRelationship catalog options.
  await assertRelationshipAllowed(tx, p.relationship);
  const gender = normGender(p.gender);
  const [row] = await tx
    .insert(employeeDependent)
    .values({
      tenantId: ctx.tenantId,
      personId,
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
    subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
    // ADR-0030 Layer 0: no name/IC/DOB — relationship + the beneficiary flag only.
    payload: { relationship: p.relationship, isBeneficiary: p.isBeneficiary ?? false },
  });
  return { id: row.id };
}

/**
 * Add a family/dependent record (admin-only via RLS WITH CHECK is_admin()). Validates the mandatory
 * full_name + relationship (∈ allowed set) and optional gender, then appends `dependent.added` — PII
 * (name/IC/DOB) stays OUT of the payload, which carries the relationship + a flag only.
 */
export async function addDependent(
  ctx: SessionContext,
  p: { personId: string } & DependentInput,
): Promise<{ id: string; childReliefSync: ChildReliefSyncResult }> {
  const res = await withTenant(ctx, (tx) => insertDependentInTx(tx, ctx, p.personId, p));
  // R46 47146ea3 — refresh the PCB child count from the register. Runs after commit, never throws.
  const childReliefSync = await syncChildReliefFromFamily(ctx, p.personId);
  return { ...res, childReliefSync };
}

/**
 * WILL THIS SET OF FAMILY MEMBERS BE ACCEPTED? Asked BEFORE anything is created (item 759dfc7d).
 *
 * Activating a draft creates the person, the employment, the statutory row and the compensation through
 * four writers that each own their transaction, and only then materialises the family. So a family member
 * carrying a value the writer refuses — a gender outside the set, a relationship that is not a built-in
 * and not an ACTIVE catalog option, a relief share that is neither 100 nor 50 — would fail AFTER an
 * employee already existed. That is the "half-activated employee" this item exists to prevent, so the
 * whole set is judged here first, against the same normalisers the insert uses, and a refusal costs
 * nothing because nothing has been written.
 *
 * It runs in ONE read-only transaction (the catalog lookup needs the caller's RLS session) and reports
 * the member's POSITION rather than its name: an error message is not a place to put a child's name.
 */
export async function assertDependentsValid(ctx: SessionContext, members: DependentInput[]): Promise<void> {
  if (members.length === 0) return;
  await withTenant(ctx, async (tx) => {
    for (const [i, m] of members.entries()) {
      const at = (msg: string) => new DependentValidationError(`Family member ${i + 1}: ${msg}`);
      if ((m.fullName ?? '').trim() === '') throw at('Dependent name is required.');
      try {
        await assertRelationshipAllowed(tx, m.relationship);
        normGender(m.gender);
        // Relationship-gated exactly as `extraColumnsForAdd` gates the columns: a spouse-only or
        // child-only value on the wrong relationship is IGNORED by the writer, so judging it here would
        // refuse an activation the writer would have accepted.
        if (m.relationship === 'spouse') normMarriageStatus(m.marriageStatus);
        if (m.relationship === 'child') {
          normChildReliefCategory(m.childReliefCategory);
          normChildReliefPercentage(m.childReliefPercentage);
        }
      } catch (e) {
        throw at(e instanceof Error ? e.message : String(e));
      }
    }
  });
}

/**
 * TURN A DRAFT'S CAPTURED FAMILY INTO REAL RECORDS — the materialisation step of Activate (item 759dfc7d).
 *
 * A draft is one jsonb blob and creates no person, so `employee_dependent` — which is keyed to a PERSON —
 * has nowhere to live until Activate. This is the moment it gets one.
 *
 * ALL-OR-NOTHING. Every member is inserted in ONE transaction, so a failure on the fourth cannot leave
 * three behind. A family half-carried across is worse than an activation that refused, because nothing on
 * screen afterwards says which members made it.
 *
 * IDEMPOTENT. A member whose (name, relationship, date of birth) already exists on this person is SKIPPED
 * rather than inserted again, so running this twice cannot duplicate a family. The comparison deliberately
 * includes ARCHIVED rows: a record somebody removed after activation must stay removed, not reappear.
 * There is no id to match on — `employee_dependent` has no draft-provenance column and this item adds no
 * migration — so the natural key is the honest one, and its one cost is stated plainly: two members with
 * the same name, relationship and date of birth (identically-named twins with no DOB) collapse to one on a
 * REPEAT run. On the first run — the only one a normal activation performs — nothing is skipped at all.
 *
 * The child-relief sync runs once at the end rather than per member (it is derived from the whole
 * register, so N-1 of N syncs would be wasted work), and only when something was actually created.
 */
export async function materialiseDependents(
  ctx: SessionContext,
  p: { personId: string; members: DependentInput[] },
): Promise<{ created: string[]; skipped: number; childReliefSync: ChildReliefSyncResult }> {
  if (p.members.length === 0) return { created: [], skipped: 0, childReliefSync: NO_SYNC('unchanged') };
  const res = await withTenant(ctx, async (tx) => {
    const existing = await tx
      .select({
        fullName: employeeDependent.fullName,
        relationship: employeeDependent.relationship,
        dateOfBirth: employeeDependent.dateOfBirth,
      })
      .from(employeeDependent)
      .where(eq(employeeDependent.personId, p.personId));
    // A MULTISET, not a set: two identical rows already on the person absorb two identical members.
    const seen = new Map<string, number>();
    for (const r of existing) seen.set(dependentNaturalKey(r), (seen.get(dependentNaturalKey(r)) ?? 0) + 1);

    const created: string[] = [];
    let skipped = 0;
    for (const m of p.members) {
      const k = dependentNaturalKey(m);
      const n = seen.get(k) ?? 0;
      if (n > 0) {
        seen.set(k, n - 1);
        skipped += 1;
        continue;
      }
      created.push((await insertDependentInTx(tx, ctx, p.personId, m)).id);
    }
    return { created, skipped };
  });
  const childReliefSync =
    res.created.length > 0 ? await syncChildReliefFromFamily(ctx, p.personId) : NO_SYNC('unchanged');
  return { ...res, childReliefSync };
}

/** The idempotency key described on `materialiseDependents`. Name is compared case- and space-insensitively
 *  because "Aisyah  Binti Ali" and "aisyah binti ali" are the same child typed twice, not two children. */
function dependentNaturalKey(r: { fullName: string; relationship: string; dateOfBirth?: string | null }): string {
  const name = (r.fullName ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${name}\u0000${(r.relationship ?? '').trim()}\u0000${(r.dateOfBirth ?? '').trim()}`;
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
      // ea36b7fa — an UNCHANGED relationship is always accepted (legacy tolerance: re-saving a row whose
      // custom type was later deactivated must not fail); a CHANGED one must be a built-in or an active
      // custom catalog option.
      if (p.relationship !== existing.relationship) {
        await assertRelationshipAllowed(tx, p.relationship);
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

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * QUALIFYING CHILDREN (PCB) — item 04b88724, r340
 *
 * THE DISTINCTION THIS SECTION EXISTS TO MAKE VISIBLE. `employee_statutory_my.num_children` is a HEAD
 * COUNT: Form E, CP8D and the EA statement all read it, and it keeps that meaning in all three
 * child-relief modes. It is NOT the figure the PCB calculation counts in. LHDN's own 2026 computerised
 * calculation slip prints those as two separate lines — the per-child rate and QC, the qualifying-children
 * COUNT — and in the specification's own worked example two children give QC = 9, because a disabled child
 * in higher education is counted as eight. The screen used to show one number under one caption and the
 * reporter was right to contest it.
 *
 * DERIVED, NEVER STORED, AND DERIVED IN ONE PLACE. There is no new column and there is no second
 * arithmetic. Both figures come back from the PACK, as two fields of one value:
 *
 *     const figure = pack.payroll.childReliefFor(…)   // { units, amountRM, rows }
 *
 * `units` is QC, `amountRM` is the ringgit — and `amountRM` is literally what
 * `pack.payroll.childReliefAmountFor` returns, because that function is now this one's `.amountRM` (see
 * localization/my/child-relief.ts). The kernel calls it for an 'auto_table' employee (core/payroll.ts
 * ~5625, core/payroll-view.ts ~1487) and uses `num_children × perChild` for every other mode, which is the
 * `from: 'headCount'` input here. So the count on the screen cannot drift from the money on the payslip:
 * they are not two derivations that agree, they are two fields of one return value.
 *
 * THIS IS THE r340 FIX AND IT IS WORTH SAYING WHY. The first build of this item left the amount in the pack
 * and worked the COUNT out twice more — once here and once in components/identity-tax-card.tsx — arguing
 * that dividing the pack's ringgit by `perChild` gave the same single-source property. It did not: the card
 * read its own copy, and in 'auto' mode it printed a child-relief figure in ringgit that this repo's own PCB
 * kernel contradicted. The approved plan had named that failure in advance ("two call sites that each work
 * out C is exactly the duplicate-source-of-truth problem CLAUDE.md section 1 forbids. Put it where both
 * payroll and the screen read it"), so the count now lives beside the amount in the pack and both readers
 * call it.
 *
 * NO PCB ARITHMETIC CHANGES HERE. Nothing in this section writes, and nothing it returns is fed back into
 * a calculation. It surfaces a figure the kernel already produced.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** One line of "how the qualifying count was reached". */
export type QualifyingChildRow = {
  /** 'child' = one row of the Family register; 'category' = one cell of the stored relief grid. */
  kind: 'child' | 'category';
  /** The child's name for a 'child' row; null for a 'category' row (which stands for a count, not a person). */
  name: string | null;
  /** s.48 category key (CHILD_RELIEF_CATEGORIES), or null when the child carries none. */
  category: string | null;
  /** The LHDN claim share: 100 (whole relief) or 50 (split between parents). */
  sharePercent: number;
  /** How many children this line stands for — always 1 for a 'child' row. */
  children: number;
  /** Qualifying units this line contributes, AS THIS MODE COUNTS THEM (already halved for a 50% share). */
  units: number;
  /** Ringgit this line contributes, as this mode prices it. */
  amountRM: number;
};

export type QualifyingChildRelief = {
  /** As stored on employee_statutory_my.child_relief_mode. */
  mode: 'manual' | 'auto' | 'auto_table';
  /** true for 'auto' and 'auto_table' — the figure was WORKED OUT. false for 'manual' — it was TYPED.
   *  The screen shows this as provenance, and read-only applies only where it is true. */
  derived: boolean;
  /** num_children — the head count Form E / CP8D / EA read. Unchanged by this item. */
  physicalChildren: number;
  /** Live 'child' rows on the Family register (archived and deceased excluded), whether or not any of
   *  them is eligible. This is the "physical children" the reporter means, and it can legitimately differ
   *  from `physicalChildren` on a manual-mode record — which is itself worth seeing. */
  familyChildren: number;
  /** C — the qualifying-children count the projection of P counts in. Fractional when a 50%-shared child
   *  is priced by category; see the note on rounding below. */
  qualifyingChildren: number;
  /** The child deduction in ringgit, from the same expression the kernel uses for this employee. */
  reliefRM: number;
  /** The flat per-child figure from the resolved ruleset (RM2,000 in 2026) — the divisor above. */
  perChild: number;
  /** What the resolved ruleset prices each s.48 category at, in canonical order: the ringgit AND the
   *  qualifying units (`amountRM / perChild`). This is what a SCREEN needs, because a screen has to price
   *  a grid the admin is still typing into and cannot wait for a save; handing it the pack's prices keeps
   *  the statutory rule in the pack and leaves the view doing arithmetic on data. */
  categories: { key: string; amountRM: number; units: number }[];
  /** Eligible children on the Family register AS OF `asOf` — the count 'auto' mode's server-side sync
   *  would write into `num_children` if it ran right now.
   *
   *  IT IS NOT NECESSARILY `physicalChildren`, and the gap is the r340 blocking defect's whole cause:
   *  `syncChildReliefFromFamily` fires only on a dependent add / edit / archive, so a child simply ageing
   *  past 18 moves this and leaves the stored head count — the figure the payslip uses — where it was. The
   *  screen shows BOTH and says which one the tax calculation counts in.
   *
   *  ONE INSTANT. This is `breakdown.length` in 'auto' mode by construction (both come from the same
   *  `eligible` list, filtered once at `asOf`), which is why the card's total and its own rows can no
   *  longer differ by a row on a child's 18th birthday — they used to be taken at two different instants,
   *  this one at KL midnight and the card's at real UTC now. */
  eligibleChildren: number;
  /** The ruleset version that priced it, so the reader knows which schedule they are looking at. */
  statutoryVersion: string | null;
  /** How the count was reached. Empty in 'manual' mode: a typed number has no breakdown, and inventing
   *  one would dress it up as a calculation. */
  breakdown: QualifyingChildRow[];
  /** Eligible children on the Family register carrying NO relief category. They would contribute nothing
   *  to a category-priced figure, so a total computed without them would be understated. */
  uncategorisedChildren: number;
  /**
   * r343 04b88724 — WHAT THE s.48 CATEGORIES ON FILE ACTUALLY CALL FOR, weighted 1 / 4 / 8 (half for a
   * 50%-shared child), from `eligibleChildReliefUnits`. NOT what the calculation gives: in 'auto' mode the
   * kernel's child leg is `num_children × perChild`, so a disabled child in higher education is relieved as
   * one child. `ruleUnits` is therefore the size of that defect, per employee, and the Identification & Tax
   * card prints it BESIDE the figure the payslip uses and never in place of it — the reporter is owed the
   * gap, and §8 forbids printing a figure this repo's own kernel contradicts as if it were the amount.
   *
   * It is a property of the FAMILY REGISTER, so it is computed in every mode; only 'auto' currently has
   * anything to compare it against, because 'auto_table' already prices the weighting and a typed 'manual'
   * figure has no per-child record behind it.
   */
  ruleUnits: number;
  /** The ringgit `ruleUnits` prices at, from the same one pack call. */
  ruleReliefRM: number;
};

/**
 * Item 04b88724 — the two figures and the working behind the second, for ONE person's PCB record.
 *
 * Returns null when the country has no pack or the pack publishes no PCB reliefs: this reports no figure
 * rather than naming a relief amount the kernel would not use (the same posture core/child-relief-review.ts
 * takes). The caller then keeps showing what it showed before.
 *
 * ── WHAT THE BREAKDOWN SAYS IN EACH MODE, AND WHY IT IS NOT THE SAME SHAPE IN ALL THREE ────────────────
 *   auto_table — one line per grid cell that holds anything, priced by `childByCategory`. There are no
 *                individual child records behind the grid, so these are CATEGORY lines; fabricating child
 *                rows to fill a table would be inventing people.
 *   auto       — one line per ELIGIBLE child on the Family register, each contributing ONE unit. That is
 *                not an oversight: in 'auto' mode the kernel's child leg is `num_children × perChild`, so
 *                one eligible child is worth exactly one unit whatever category is recorded against it.
 *                The category and share are still shown on the line, as information, and the screen says
 *                out loud that they price the relief only in 'auto (from table)' mode. Printing "4 units"
 *                against a tertiary-study child in a mode where the payslip gives it 1 would be printing a
 *                figure this repo's own kernel contradicts (CLAUDE.md §8).
 *   manual     — empty. Nothing was worked out.
 *
 * ── ROUNDING, AND WHAT IS NOT KNOWN ───────────────────────────────────────────────────────────────────
 * A 50%-shared child is worth half its category's ringgit (`childReliefAmountFor`: `half * (amount / 2)`,
 * with no rounding — the projection of P is truncated ONCE, downstream). Dividing by `perChild` therefore
 * yields a HALF unit: one 50%-shared child under 18 is QC 0.5, RM1,000. This function does not round,
 * because rounding here would make the count disagree with the money.
 * UNKNOWN: whether LHDN's specification intends QC to be an integer in a shared-claim case. The spec
 * expresses QC as a count of children and prices the split in ringgit; nothing in the PDF pages cited in
 * localization/my/statutory-tables.ts settles what QC reads as when a claim is halved. The repo's existing
 * choice — carry the ringgit, do not round — is preserved and surfaced, not decided here.
 */
export async function qualifyingChildReliefFor(
  ctx: SessionContext,
  p: {
    personId: string;
    /** The acting country pack. The Personnel detail page resolves 'MY' explicitly; this mirrors that
     *  rather than silently widening the screen to the company's own country (a separate change). */
    country?: string;
    /** Kuala Lumpur "today" the ruleset is resolved as of, and the date child ages are taken against. */
    asOf: string;
  },
): Promise<QualifyingChildRelief | null> {
  const pack = packFor(p.country ?? 'MY');
  // Captured OUT of the optional properties: both are optional on the pack surface (a jurisdiction with no
  // per-category child relief omits them), and a narrowing on `pack.payroll.childReliefFor` does not
  // survive into the async closure below. `childReliefFor` is the ONE derivation — the count, the money and
  // the working — and `childReliefPrices` the only conversion between ringgit and qualifying children.
  const childReliefFor = pack?.payroll?.childReliefFor;
  const childReliefPrices = pack?.payroll?.childReliefPrices;
  if (!pack || !childReliefFor || !childReliefPrices) return null;
  return withTenant(ctx, async (tx) => {
    const rules = await pack.payroll.loadRuleset(tx, { asOf: p.asOf });
    const reliefs = rules.pcb?.reliefs;
    if (!reliefs) return null;
    const perChild = reliefs.perChild;
    // A zero or missing per-child figure prices no qualifying-children COUNT at all (`childReliefPrices`
    // returns units 0 rather than Infinity), so report nothing rather than a screen full of zeroes that
    // look like a figure.
    if (typeof perChild !== 'number' || !Number.isFinite(perChild) || perChild <= 0) return null;

    const [statutory] = await tx
      .select({
        numChildren: employeeStatutoryMy.numChildren,
        childReliefMode: employeeStatutoryMy.childReliefMode,
        childReliefTable: employeeStatutoryMy.childReliefTable,
      })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, p.personId))
      .limit(1);
    if (!statutory) return null;

    const rawMode = statutory.childReliefMode ?? 'manual';
    const mode: QualifyingChildRelief['mode'] =
      rawMode === 'auto' || rawMode === 'auto_table' ? rawMode : 'manual';
    const physicalChildren = statutory.numChildren ?? 0;

    // ORDER BY so the breakdown reads the same on every load (CLAUDE.md §8: an asserted array needs one).
    const family = await tx
      .select({
        fullName: employeeDependent.fullName,
        relationship: employeeDependent.relationship,
        dateOfBirth: employeeDependent.dateOfBirth,
        isStudent: employeeDependent.isStudent,
        isDeceased: employeeDependent.isDeceased,
        archivedAt: employeeDependent.archivedAt,
        childTaxRelief: employeeDependent.childTaxRelief,
        childReliefCategory: employeeDependent.childReliefCategory,
        childReliefPercentage: employeeDependent.childReliefPercentage,
      })
      .from(employeeDependent)
      .where(and(eq(employeeDependent.personId, p.personId), isNull(employeeDependent.archivedAt)))
      .orderBy(asc(employeeDependent.dateOfBirth), asc(employeeDependent.fullName));

    // `childAgeYears` parses a DOB as `${dob}T00:00:00Z`, so the other endpoint is built the same way —
    // the same reasoning core/child-relief-review.ts records: an eight-hour offset could otherwise flip a
    // child's whole-year age on their birthday, the one day the eligibility rule turns on.
    const asOfDate = new Date(`${p.asOf}T00:00:00Z`);
    const children = family.filter((d) => d.relationship === 'child' && !d.isDeceased);
    const eligible = children.filter((d) => isChildReliefEligible(d, asOfDate));
    const uncategorisedChildren = eligible.filter((d) => !d.childReliefCategory).length;

    // The pack's own prices, and the ONLY place ringgit and qualifying children are converted into each
    // other. The screen receives this list verbatim: it has to price a grid the admin is still typing into,
    // and handing it the prices keeps the statutory rule in the pack while it does.
    const categories = childReliefPrices(reliefs);

    // r343 04b88724 — the s.48 WEIGHTED figure from the children on file, through the pack's own prices and
    // the pack's own walk. One call; no units are named here. See `eligibleChildReliefUnits` for why this is
    // reported rather than applied.
    const rule = eligibleChildReliefUnits(family, {
      prices: categories,
      childReliefFor,
      asOf: asOfDate,
    });

    // ── THE FIGURE. ONE CALL, TWO FIELDS, AND IT IS THE KERNEL'S OWN ─────────────────────────────────
    // 'auto_table' prices the stored grid; every other mode is `num_children × perChild`, which is what
    // core/payroll.ts and core/payroll-view.ts do for the same employee. An empty / unkeyed grid claims
    // NOTHING — the count follows the money to zero rather than optimistically reporting the head count.
    const figure =
      mode === 'auto_table'
        ? childReliefFor({ from: 'table', table: statutory.childReliefTable, prices: categories })
        : childReliefFor({ from: 'headCount', children: physicalChildren, perChild });

    const breakdown: QualifyingChildRow[] =
      mode === 'auto_table'
        ? // One line PER SHARE, so "claimed in full or shared" is visible rather than averaged away. The
          // lines are the PACK's own rows; this only names them for a screen.
          figure.rows.map((r) => ({
            kind: 'category' as const,
            name: null,
            category: r.category,
            sharePercent: r.sharePercent,
            children: r.children,
            units: r.units,
            amountRM: r.amountRM,
          }))
        : mode === 'auto'
          ? // One line per ELIGIBLE child, each worth exactly one qualifying child — which is not a
            // simplification but this mode's kernel expression applied to a single child (`from:
            // 'headCount'`, children 1). Printing its category's units instead would print a figure the
            // payslip denies.
            eligible.map((d) => {
              const one = childReliefFor({ from: 'headCount', children: 1, perChild });
              return {
                kind: 'child' as const,
                name: d.fullName,
                category: d.childReliefCategory ?? null,
                // 100 when nothing is recorded: an unshared claim is the whole relief, which is what the
                // kernel's flat count already assumes. `setDependentChildRelief` validates the stored
                // 100|50 on write, so this never has to re-validate it.
                sharePercent: d.childReliefPercentage === 50 ? 50 : 100,
                children: 1,
                units: one.units,
                amountRM: one.amountRM,
              };
            })
          : // manual — nothing was worked out, so there is nothing to break down.
            [];

    return {
      mode,
      derived: mode !== 'manual',
      physicalChildren,
      familyChildren: children.length,
      eligibleChildren: eligible.length,
      categories,
      qualifyingChildren: figure.units,
      reliefRM: figure.amountRM,
      perChild,
      statutoryVersion: rules.version ?? null,
      breakdown,
      uncategorisedChildren,
      ruleUnits: rule.units,
      ruleReliefRM: rule.amountRM,
    };
  });
}
