/**
 * r219 (7966ee35) — WHY THE REPLACEMENT LEAVE IN LIEU BUTTON IS NOT THERE, IN THE CUSTOMER'S WORDS.
 *
 * `replacementRequestAvailability` (core/replacement-request.ts) has always returned a discriminated
 * REASON alongside its boolean. Every surface that read it read only the boolean and rendered silence, so
 * a customer whose account simply did not carry the Replacement Leave add-on spent a whole round turning
 * Leave Config switches on and off — the one thing that could never have changed the answer, because the
 * module is checked BEFORE the policy is read.
 *
 * ⚠️ THIS IS THE THIRD TIME A SURFACE IN THIS REPO COMPUTED A PRECISE CAUSE AND SHOWED NOTHING.
 * `no_eligibility_match` (8ebf77ae) was the second, and the shape of its fix is the shape of this one: a
 * NAMED notice carrying the specific cause, resolved through ONE map indexed by the reason, so the
 * employee's own screen and HR's view of that same employee can never describe one configuration two ways.
 *
 * WHY THIS LIVES IN `lib/` AND NOT BESIDE THE RENDERER. `core/replacement-request.ts` imports the union
 * from here, so the reason a service can return and the reason a screen can explain are ONE list — a sixth
 * reason added to the service without copy fails to typecheck rather than rendering `MISSING_MESSAGE`.
 * Same arrangement as `lib/entitlement-status.ts`, which is imported by `core/read.ts` and by client
 * components for exactly that reason. Pure data, no imports: it is reached from a client component.
 *
 * Substrate: pure copy mapping → NO DomainEvent. // substrate: read-only, no event
 */

/**
 * Every way the request can be unavailable. Ordered as `replacementRequestAvailability` tests them, which
 * is also the order they must be READ in: the add-on is checked before the company policy, and the company
 * policy before anything about the person — so a `module_off` tenant never reaches `not_enabled`, and an
 * administrator told to check Leave Config for a `module_off` account is being sent to the wrong screen.
 */
export type ReplacementUnavailableReason =
  /** The chargeable add-on is not on this account. Not a setting on any screen — commercial provisioning. */
  | 'module_off'
  /** No employment could be resolved for this person, so there is nothing to bank time against. */
  | 'no_employment'
  /** The company's own Enable / employee-submission switches, or no policy row for the company at all. */
  | 'not_enabled'
  /** This employee is outside the eligibility criteria the company's policy lists. */
  | 'not_eligible'
  /**
   * The statutory overtime floor. At or below the wage ceiling the employee is entitled to overtime PAY
   * rather than banked time, and the company has not switched its own override on. SEPARATE from
   * `not_eligible` since r219: collapsing them sent administrators to edit a criteria list that was never
   * the cause, when the remedy is a different switch and a legal question rather than a configuration one.
   */
  | 'first_schedule_protected';

/**
 * Reason → the copy that says it, as key paths under the `replacementRequest` i18n namespace.
 *
 * `bodyAdmin` is present only where the sentence has a SUBJECT: "you are outside the criteria" is the same
 * fact as "this employee is outside the criteria" and a screen HR is reading about somebody else must not
 * say the first. Where the cause is the account or the company, one sentence serves both audiences and
 * there is deliberately no second key to keep in step.
 *
 * EXHAUSTIVE BY CONSTRUCTION (`Record<ReplacementUnavailableReason, …>`), and
 * test/r219-replacement-availability-reason.test.ts renders every entry in all six locales — a key that
 * exists in the map and not in a catalogue paints `MISSING_MESSAGE` in the browser behind a green tsc,
 * a green suite and a green `next build` (AGENTS rule 6).
 */
export const REPLACEMENT_UNAVAILABLE_COPY: Record<
  ReplacementUnavailableReason,
  { title: string; body: string; bodyAdmin?: string }
> = {
  module_off: { title: 'unavailable.moduleOffTitle', body: 'unavailable.moduleOffBody' },
  no_employment: { title: 'unavailable.noEmploymentTitle', body: 'unavailable.noEmploymentBody' },
  not_enabled: { title: 'unavailable.notEnabledTitle', body: 'unavailable.notEnabledBody' },
  not_eligible: {
    title: 'unavailable.notEligibleTitle',
    body: 'unavailable.notEligibleBody',
    bodyAdmin: 'unavailable.notEligibleBodyAdmin',
  },
  first_schedule_protected: {
    title: 'unavailable.firstScheduleTitle',
    body: 'unavailable.firstScheduleBody',
    bodyAdmin: 'unavailable.firstScheduleBodyAdmin',
  },
};

/**
 * The one state that is NOT a refusal: the button IS offered, and the form will ask this employee to agree
 * to bank the time instead of taking the statutory overtime cash. Said out loud for the same reason the
 * refusals are — HR looking at an employee's leave has no other way to learn that the overtime protection
 * rule is in play for them, and on the employee's own screen it explains the consent box before they open
 * the form rather than after.
 */
export const REPLACEMENT_CONSENT_NOTICE = {
  title: 'consentNotice.title',
  body: 'consentNotice.body',
  bodyAdmin: 'consentNotice.bodyAdmin',
} as const;
