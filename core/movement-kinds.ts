/**
 * The BUILT-IN movement kinds. A leaf module with no imports, extracted from core/movement.ts by 476f23ed.
 *
 * WHY IT IS ITS OWN FILE. 476f23ed makes the movement event-type catalogue configurable per tenant
 * (core/movement-type.ts). That module needs the built-in list to tell an override of a shipped kind from
 * a tenant's own type, and core/movement.ts needs the catalogue to resolve a tenant's own type back to the
 * behaviour that runs. Importing each other would be a cycle whose failure mode is the nastiest kind — a
 * `const` array that is `undefined` at module-init time depending on which file was loaded first. A leaf
 * both can import removes the cycle entirely.
 *
 * Everything here is RE-EXPORTED from core/movement.ts, so no existing importer changed.
 *
 * BEHAVIOUR LIVES WITH THESE NAMES, NOT WITH THE CATALOGUE. A tenant may rename Termination, switch it off,
 * or add an event type of its own; it may never make a type of its own BE a Termination. That separation is
 * the whole design of 476f23ed, and this list is the fixed half of it.
 */

/** The movement kinds HR can CREATE from the New Event form. Rehire is a future enhancement; a "custom
 *  event" is no longer one — since 476f23ed a tenant adds its own through Movement Settings, mapped onto
 *  one of the kinds below. */
export const MOVEMENT_KINDS = [
  'transfer',
  'promotion',
  'demotion',
  'increment',
  'confirmation',
  'probationExtension',
  'secondment',
  'actingPosition',
  'resignation',
  'termination',
  'blacklist',
  'salaryAdjustment',
  'orgAssignmentChange',
  'reportingLineChange',
  'employmentTypeChange',
  // 89ea527b — the two employment-date movements. Both follow the `confirmation` precedent: the movement's
  // EFFECTIVE DATE *is* the new value of the date it sets, so the history row's Effective Date column and the
  // stored column can never disagree. They are the ONLY writers of employment.hired_on / employment.join_date
  // after creation (setEmploymentInfo ignores both fields without the matching tag).
  'joinDateChange',
  'groupJoinDateCorrection',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/**
 * 08913328 — the kinds that record a CHANGE to the employee's employment/pay data, and therefore render as
 * the side-by-side comparison screen. The rest (Probation Extension, Resignation, Termination, Blacklist,
 * Secondment, Acting Position) are lifecycle events with their own dedicated inputs — a Current/After grid
 * would be meaningless for them.
 *
 * 3ced1040 — CONFIRMATION JOINED THIS LIST. Confirming a probationer is routinely the same decision as
 * giving them a rise and a title, and as a lifecycle kind it could record only the date: HR had to key the
 * confirmation here and the salary somewhere else, leaving two marks on the record for one decision. It
 * behaves exactly like Promotion now — the same grid, the same diff-driven writer, the same one history
 * row, and the same future-dating fork. The date it sets is still its EFFECTIVE DATE, so the row's
 * Effective Date column and employment.confirmation_date can never disagree.
 */
export const COMPARISON_KINDS = [
  'transfer',
  'promotion',
  'demotion',
  'increment',
  'salaryAdjustment',
  'orgAssignmentChange',
  'employmentTypeChange',
  'reportingLineChange',
  'confirmation',
] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];
export const isComparisonKind = (k: string): k is ComparisonKind =>
  (COMPARISON_KINDS as readonly string[]).includes(k);

/**
 * 3ced1040 — the comparison kinds that are INTERCHANGEABLE with one another: the set a correction may
 * re-classify a movement inside, and the set a tenant's own event type may be mapped onto.
 *
 * Confirmation is a comparison kind but deliberately NOT in here, and the two lists are separate for that
 * one exclusion. Everything else on the comparison grid moves employment DATA; Confirmation also completes
 * probation (deriveEmploymentStatus reads the date it writes). So correcting a Transfer into a
 * Confirmation would move an employee off probation as a side effect of a re-label, and a custom type
 * named after it would let a tenant invent a confirmation — which is exactly what 476f23ed keeps built-in.
 * Membership of COMPARISON_KINDS is about the FORM AND THE WRITER; membership here is about CONSEQUENCE.
 */
export const INTERCHANGEABLE_COMPARISON_KINDS: readonly ComparisonKind[] = COMPARISON_KINDS.filter(
  (k) => k !== 'confirmation',
);
