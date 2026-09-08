/**
 * Family / Dependents — the CLOSED VALUE SETS, in a module both the server writer and the browser may
 * import (item 759dfc7d).
 *
 * WHY THEY MOVED. These five lists were defined in `core/dependents.ts`, which pulls the pg driver via
 * `db/client` — so nothing in a client bundle can import them. The draft's Family form IS a client
 * component (the draft is one jsonb blob edited in the browser and saved as a whole, not a server form
 * per row), and copying the lists into it is precisely how two screens drift: the Personnel screen's
 * accepted relationships and the draft's would diverge silently, and a value HR picked on the draft
 * would be refused at Activate — after an employee had already been created.
 *
 * `core/dependents.ts` RE-EXPORTS every name here, so there is still exactly one definition and every
 * existing import (`from '../core/dependents'`) keeps working unchanged.
 *
 * NOT MOVED, deliberately: the normalisers (`normGender`, `normChildReliefCategory`, …) stay in
 * `core/dependents.ts`. They throw `DependentValidationError` and are the server's authority; a copy of
 * the VALUES cannot disagree with the server, but a copy of the RULES could.
 */

/**
 * The BUILT-IN relationship values. A tenant may add custom types through the `dependentRelationship`
 * profile-option catalog; these five are ALWAYS valid server-side because spouse-only fields and child
 * tax relief key off them, so deactivating one in the catalog only hides it from NEW picks.
 */
export const DEPENDENT_RELATIONSHIPS = ['spouse', 'child', 'parent', 'sibling', 'other'] as const;
export type DependentRelationship = (typeof DEPENDENT_RELATIONSHIPS)[number];

/** Allowed gender values (optional on a dependent record). */
export const DEPENDENT_GENDERS = ['male', 'female', 'undisclosed'] as const;
export type DependentGender = (typeof DEPENDENT_GENDERS)[number];

/** Allowed spouse marriage-status values (optional; only meaningful for a spouse record). */
export const DEPENDENT_MARRIAGE_STATUSES = ['married', 'divorced', 'widowed', 'separated'] as const;
export type DependentMarriageStatus = (typeof DEPENDENT_MARRIAGE_STATUSES)[number];

/**
 * Malaysia Income Tax (PCB / TP1) child-relief categories, the five LHDN s.48 cases:
 *   under_18         — child under 18
 *   study_preu       — 18+, unmarried, in full-time pre-university study (A-Levels, matriculation, etc.)
 *   study_tertiary   — 18+, unmarried, in full-time diploma / degree (and above) study
 *   disabled         — disabled child (OKU)
 *   disabled_study   — disabled child in full-time (diploma / degree and above) study
 * Only meaningful for a `child` record; validate-or-ignore otherwise.
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

/**
 * Which FIELD PANEL a relationship gets — the ONE routing rule, shared by the Personnel screen's dialog
 * (`components/family-relationship-fields.tsx` mirrors it), the draft's Family form and the server's own
 * column gating (`extraColumnsForAdd` in core/dependents.ts). Spouse and child have their own panels;
 * EVERYTHING else — parent, sibling, other, and any custom catalog type — gets the standard one, because
 * the server NULLs spouse-only and child-only columns for those relationships anyway.
 */
export function dependentPanelOf(relationship: string): 'spouse' | 'child' | 'other' {
  return relationship === 'spouse' ? 'spouse' : relationship === 'child' ? 'child' : 'other';
}

/**
 * Whole-year age from a date of birth — the ONE age rule, moved here from `core/dependents.ts` (item
 * 759dfc7d) for the same reason the value sets above moved: the draft's Family form runs in the browser
 * and shows the same read-only Age the Personnel dialog does, and `core/dependents.ts` cannot be imported
 * there. `core/dependents.ts` re-exports this name, so the eligibility predicate and the Personnel screen
 * keep calling the identical function.
 *
 * The 365.25-day divisor is preserved exactly as it was; this is a move, not a change. Null when there is
 * no date of birth or it does not parse.
 */
export function childAgeYears(dob: string | null | undefined, asOf: Date = new Date()): number | null {
  if (!dob) return null;
  const ms = Date.parse(`${dob}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.floor((asOf.getTime() - ms) / (365.25 * 24 * 60 * 60 * 1000));
}
