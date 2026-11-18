/**
 * ── r219 · WHICH WRITE AN EDIT IS ────────────────────────────────────────────────────────────────────
 *
 * The one decision `updateEntitlementTemplate` and `updateEligibilityRule` share, kept as a pure function
 * so the two cannot drift and so it can be exercised without a database.
 *
 *   · the running version HAS NOT STARTED YET          ⇒ 'in-place'
 *   · the start date is not moving at all              ⇒ 'in-place' (it is the same version, re-saved)
 *   · it HAS been in force and the new date is later   ⇒ 'supersede'
 *   · anything else                                    ⇒ 'refuse'
 *
 * ⚠️ r224 MOVED IT OUT OF core/entitlement-template.ts, AND THE MOVE IS THE POINT — not tidying.
 * The two editor forms must now label their own Save button with the write it is ABOUT to make, which is a
 * question only the browser can answer: it depends on what is in the date box at this instant, not on what
 * was on screen when the server rendered. So the same function that DECIDES the write has to run in the
 * client bundle, and `core/entitlement-template.ts` cannot be imported there — it pulls `db/client`,
 * drizzle and the whole schema in with it. This module imports NOTHING, which is the only property that
 * matters about it. `core/entitlement-template.ts` re-exports both names, so every existing import path
 * (and the r219 test's) still resolves.
 *
 * ⚠️ THIS IS A DATE TEST, NOT A USAGE TEST, and the difference is the reason this note exists. "Has
 * anything been calculated from this version" HAS NO ANSWER in this schema: `leave_ledger` records
 * employment, leave type, entry type, days and effective date and carries NO reference to the entitlement
 * table or the eligibility rule that produced a row (the r210 paragraph in core/entitlement-template.ts's
 * header sets that out in full). All that can be asked here is whether the version has STARTED —
 * `validFrom > today` — and nothing here should be read as, or widened into, a claim that nothing was ever
 * computed from a version this test calls not-yet-started.
 *
 * WHAT THE 'supersede' ARM PROTECTS, stated once: three readers resolve entitlement at a PAST date (the
 * Carry Forward report at each employee's own cycle open, the year sweep in expireCarriedLeave, and the
 * /me + admin balance breakdown). Changing the start date of a version that has been in force would
 * quietly change what a closed leave year says an employee was entitled to. A version that has not
 * started has no such year behind it, so editing it in place takes nothing away.
 *
 * ⚠️ AND THE SAME THREE READERS ARE WHY AN IN-PLACE SAVE OF A STARTED VERSION IS WARNED ABOUT RATHER THAN
 * REFUSED (r224). `entitlementInPlaceChangesThePast` below is that condition, named once: the mode is
 * in-place AND the version has already been in force, so the figures a closed leave year reports change
 * with the save. It is a legitimate thing to do — correcting a table that was keyed wrongly is the whole
 * of r219 — and it is the operator's decision, so the screen says it out loud before they take it.
 *
 * THE RETIRED HALF: this used to be `open.validFrom >= p.validFrom` in both writers, which compared the
 * running version against ITSELF — saving the version you were editing with its own date was refused,
 * and the message sent the operator to "edit that version instead" when these two functions are the only
 * edit entry points there are.
 *
 * Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */
export type EntitlementEditMode = 'in-place' | 'supersede' | 'refuse';

export function entitlementEditMode(p: {
  openValidFrom: string;
  newValidFrom: string;
  today: string;
}): EntitlementEditMode {
  if (p.openValidFrom > p.today || p.newValidFrom === p.openValidFrom) return 'in-place';
  return p.newValidFrom > p.openValidFrom ? 'supersede' : 'refuse';
}

/**
 * "This save overwrites a version that has already been in force", which is the ONE outcome on either
 * editor that reaches backwards. Derived from the same two dates the mode is, so the warning and the write
 * cannot disagree about which saves it applies to.
 */
export function entitlementInPlaceChangesThePast(p: {
  openValidFrom: string;
  newValidFrom: string;
  today: string;
}): boolean {
  return entitlementEditMode(p) === 'in-place' && p.openValidFrom <= p.today;
}
