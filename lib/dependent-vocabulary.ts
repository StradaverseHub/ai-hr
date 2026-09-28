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

import { completedYearsAt } from './completed-years';

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
 * ⚠️ b25e421e (r352) — THE 365.25-DAY DIVISOR IS GONE, AND IT WAS WRONG ON THE ONE DAY THAT DECIDES.
 *
 * It used to read `floor((asOf - dob) / (365.25 days))`, which is an APPROXIMATION of a calendar year, and
 * the approximation lands on the wrong side of a birthday. A child born 2008-06-15 is 6,574 days old on
 * 2026-06-15 — their eighteenth birthday — and 18 × 365.25 is 6,574.5, so the old expression floored to
 * SEVENTEEN on the very day they turned eighteen. Whether it erred at all, and by how long, depended on how
 * many 29-Februaries happened to fall inside the span, so the Family tab's Age column could read 17 to one
 * child on their birthday and 18 to another.
 *
 * That is not cosmetic here: `isChildReliefEligible` turns on `age < 18`, so the approximation kept an
 * ineligible child inside the PCB child-relief figure for up to an extra day, and b25e421e exists precisely
 * to make a birthday move that figure by itself. A nightly job that re-derives relief is only as accurate as
 * this comparison.
 *
 * It now delegates to `completedYearsAt`, which lib/completed-years.ts already describes as
 * "calendar-accurate, not /365.25" and whose own header asks future age consumers to reuse it rather than
 * reinvent the arithmetic. This function is the reinvention that header was warning about. Delegating also
 * makes a dependent's Age and an employee's Age one counter rather than two that agree by coincidence: the
 * count increments ON the anniversary itself and never before, and a 29-February birthday increments on
 * 1 March in a common year.
 *
 * BEHAVIOUR THAT DID NOT CHANGE: null for a missing or unparseable date of birth. A date of birth in the
 * FUTURE now clamps to 0 where it used to go negative — both are below 18, so no eligibility answer moves.
 */
export function childAgeYears(dob: string | null | undefined, asOf: Date = new Date()): number | null {
  if (!dob) return null;
  if (Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) return null;
  // `asOf` is an instant; the calendar helper takes a date-only string. Callers build that instant from
  // `todayInKualaLumpur()` (core/dependents.ts:557 records why), so its UTC calendar date IS the tenant's.
  return completedYearsAt(dob, asOf.toISOString().slice(0, 10));
}

/**
 * 77e882f5 (r353) — THE CHILD-RELIEF ELIGIBILITY RULE, MOVED HERE FOR THE SAME REASON `childAgeYears` WAS.
 *
 * It lived in core/dependents.ts, which pulls the pg driver through db/client, so nothing in a browser
 * bundle could import it — and the two disclosures this round adds are rendered by a CLIENT card. The
 * alternative was a second copy of the predicate in the browser, which is precisely what this module
 * exists to prevent (see the header). core/dependents.ts re-exports all three names, so every existing
 * caller and every existing import specifier is untouched.
 *
 * The row is typed STRUCTURALLY rather than as a Pick<DependentRow,…>: DependentRow lives in the
 * server-only module, and naming it here would drag the import back across the wall this move opened.
 */
export type ChildReliefRow = {
  relationship: string;
  dateOfBirth: string | null;
  isStudent: boolean | null;
  isDeceased: boolean | null;
  archivedAt: Date | string | null;
  childTaxRelief?: boolean | null;
  childReliefCategory?: string | null;
};

/**
 * Behaviour is r351's, unchanged:
 *   - relationship must be 'child'; deceased and archived rows are excluded;
 *   - an EXPLICIT per-child decision (childTaxRelief non-null) wins over inference, BOTH directions;
 *   - a full-time student is eligible regardless of age (the 18+ in-education case);
 *   - otherwise eligible only when under 18; no/invalid DOB ⇒ cannot confirm age ⇒ not auto-counted.
 */
/**
 * 77e882f5 (r355) — THE CATEGORIES THAT JUSTIFY A CLAIM PAST 18.
 *
 * Read off this module's own definitions and the catalogue, not inferred from the price:
 *   study_preu      "18+ in full-time pre-university study"        (line ~41 above; messages en :915)
 *   study_tertiary  "18+ in diploma/degree study (and above)"
 *   disabled        a disabled child — claimable at any age
 *   disabled_study  a disabled child in full-time study
 * `under_18` is the only category that asserts the child is NOT over 18, so it is the only one that
 * cannot justify an over-18 claim. That is the whole of the set, and why `study_preu` is in it despite
 * pricing at one unit like `under_18` — the price is not the rule.
 */
const QUALIFIES_OVER_18: ReadonlySet<string> = new Set(['study_preu', 'study_tertiary', 'disabled', 'disabled_study']);

/**
 * ⚠️ 77e882f5 (r355) — THE TICK NO LONGER OVERRIDES THE AGE TEST. THIS IS AN OWNER DECISION AND IT
 * MOVES MONEY.
 *
 * ── WHAT THIS REVERSED, AND WHY THE OLD RULE WAS NOT SILLY ─────────────────────────────────────────
 * This function used to open with `if (r.childTaxRelief != null) return r.childTaxRelief;` — an
 * explicit per-child decision won outright, in BOTH directions. Item 6c635212 put it there, and it was
 * load-bearing: it was the only way to claim a disabled child over 18, or one in full-time study,
 * because nothing else in the row could justify the claim.
 *
 * The owner reversed it in their own words: "The Claim tax relief checkbox should indicate the user's
 * intention to claim the relief, but it must not override the statutory eligibility validation." Their
 * sequence: Claim Tax Relief = Yes → check date of birth → calculate age → check applicable relief
 * conditions → determine qualifying children. So the tick is CONSENT, and the record must then justify
 * it. The over-18 cases the old rule protected are now carried by `childReliefCategory`, which is why
 * that field stops being pricing-only and becomes an eligibility input.
 *
 * ── AN EXPLICIT NO STILL WINS, AND A BLANK IS STILL A BLANK ────────────────────────────────────────
 * `false` is unchanged: HR saying "do not claim this child" is honoured whatever the age.
 *
 * `null` — never ticked either way — KEEPS TODAY'S BEHAVIOUR EXACTLY, and that is a deliberate refusal
 * to widen the change. Most legacy rows are null. Reading null as "not claimed" would drop every child
 * never explicitly ticked out of relief in a single nightly resync — a mass relief loss and a mass tax
 * rise, from a rule change nobody asked for. The owner was told this and it is theirs to reverse.
 * Note the asymmetry this creates and that it is correct: a ticked over-18 disabled child qualifies, an
 * UNticked one does not, because without consent there is no claim to validate.
 */
export function childReliefEligible(r: ChildReliefRow, asOf: Date = new Date()): boolean {
  if (r.relationship !== 'child') return false;
  if (r.isDeceased) return false;
  if (r.archivedAt) return false;
  // An explicit refusal is final, at any age.
  if (r.childTaxRelief === false) return false;
  const age = childAgeYears(r.dateOfBirth, asOf);
  const underEighteen = age != null && age < 18;
  // Never decided: the pre-77e882f5 inference, untouched. See the header.
  if (r.childTaxRelief == null) return r.isStudent === true || underEighteen;
  // Consent given — now the record has to justify it.
  if (r.isStudent) return true;
  if (underEighteen) return true;
  return QUALIFIES_OVER_18.has(r.childReliefCategory ?? '');
}

/**
 * WHICH LIMB OF THAT LADDER COUNTED THE CHILD.
 *
 * The reporter raised one child TWICE as an age-check failure. Production holds them as: born
 * 2004-01-01 (so 22), not a student, **`child_tax_relief` TRUE**, category `under_18`. The count of 1 is
 * CORRECT — the explicit decision is tested before the age, deliberately, because that precedence is the
 * only way a disabled or studying child over 18 is claimable. The screen printed the 1 and never said a
 * manual tick produced it, so the only available reading was "the age check is broken".
 *
 * Derived by RE-WALKING THE SAME LADDER IN THE SAME ORDER, never by re-deciding: a "why" that can
 * disagree with the "whether" is worse than no "why". `null` means not eligible, so no caller can print
 * a reason for a child that does not count.
 */
export type ChildEligibilityReason = 'category' | 'student' | 'under_18';
export function childEligibilityReason(r: ChildReliefRow, asOf: Date = new Date()): ChildEligibilityReason | null {
  if (!childReliefEligible(r, asOf)) return null;
  // 77e882f5 — re-walks the NEW ladder in the new order. 'explicit' no longer means "the tick decided
  // it"; the tick is only consent now, so the reason is whatever actually justified the claim. A ticked
  // child who qualifies on a category gets 'category' — the case the screen most needs to explain.
  if (r.isStudent) return 'student';
  const age = childAgeYears(r.dateOfBirth, asOf);
  if (age != null && age < 18) return 'under_18';
  return 'category';
}

/**
 * A RECORDED CATEGORY THE REGISTER ITSELF DISPROVES — `under_18` on a child who is 18 or over.
 *
 * The third case in this family and the only one that misleads: r351 named `uncategorisedChildren` (a
 * child priced at nothing) and `undatedChildren` (a child counted zero for want of a date of birth), and
 * both of those produce an ABSENT figure, which reads as absent. This one produces a CONFIDENT figure
 * that looks wrong, which is what the reporter saw.
 *
 * DELIBERATELY NARROW. A disabled child is claimable at any age and a studying child past 18, so neither
 * category contradicts a date of birth; a child with no date of birth is `undatedChildren`'s business.
 * Flagging a pair we cannot prove wrong would be inventing a fault. It reports and prices nothing.
 */
export function childCategoryContradictsDob(r: ChildReliefRow, asOf: Date = new Date()): boolean {
  if (r.childReliefCategory !== 'under_18') return false;
  const age = childAgeYears(r.dateOfBirth, asOf);
  return age != null && age >= 18;
}
