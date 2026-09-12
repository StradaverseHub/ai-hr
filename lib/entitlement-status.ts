/**
 * 31e39d74 — WHY A LEAVE TYPE READS 0.00, AS A VALUE INSTEAD OF AS A SILENCE.
 *
 * The reporter configured entitlement tables for Medical and Hospitalization Leave, saw 0.00 on My Leave,
 * and had no way to tell WHICH situation they were in. Their own words, verbatim:
 * "the system should clearly indicate that the entitlement is configured but not yet generated, rather
 * than silently showing 0.00".
 *
 * r193 fixed the ENGINE (a9d0a94a: tables read from the date they apply, mid-year joiners included, a sole
 * table applied without a rule). This is the other half — the screen saying which state it is in, so the
 * next 0.00 is answerable without reading the ledger.
 *
 * ── WHY IT CANNOT BE INFERRED FROM THE LEDGER ALONE ─────────────────────────────────────────────────
 * `openLeaveYear` skips a pair with `days <= 0` (outcome `no_entitlement`) and writes NO ledger row at all,
 * so "no rows" cannot distinguish "never generated" from "generated and worth nothing". And the
 * `accrual_unconfigured` path DOES write a row — a 0.00 accrual, deliberately, because that row is the
 * idempotency open-marker and the expiry sweep's "year was opened" marker (core/leave.ts).
 *
 * ── THE CORRECTION THAT MADE THIS FILE'S SHAPE WHAT IT IS ───────────────────────────────────────────
 * ⚠️ THE FIRST CUT OF THIS DERIVATION TOOK THREE FACTS AND WAS WRONG ON THE COMMONEST LEAVE TYPE IN THE
 * PRODUCT. "A table is in force AND there is no accrual row" is NOT the same statement as "generation has
 * not run" — `openLeaveYear` has FIVE branches that write no row, and only one of them is answered by
 * pressing Generate Entitlement:
 *
 *   core/leave.ts branch          writes a row?   is "Run Generate Entitlement" the remedy?
 *   ── earned_method  (6302)      no              NO — earned types are accrueEarnedLeave's business; a
 *                                                 year-open logs `earned_method` and moves on, FOREVER.
 *   ── no_entitlement (6306)      no              NO — the band resolves 0 days; a run repeats the skip.
 *   ── frozen         (6271)      no              NO — ADR-0069 encashment freeze; a run skips it again.
 *   ── pack_blocked   (6252)      no              NO — the country pack is inactive.
 *   ── (fell through) (6377)      YES             — this is the only one, and it is `not_generated`.
 *
 * The earned branch is not an edge case: ANNUAL with an entitlement table — the ordinary shape of the
 * commonest leave type there is — takes it on EVERY year-open. Captioning that "Not yet generated" told
 * every employee with an earned Annual Leave, from cycle rollover until the first monthly accrual landed,
 * to press a button that would skip their type and change nothing. A remedy that cannot fire is worse than
 * the silent 0.00 it replaced: the silence at least did not send anyone anywhere.
 *
 * So the derivation now asks the SAME QUESTIONS THE ENGINE ASKS, IN THE ENGINE'S OWN ORDER, off the same
 * resolved policy the breakdown already computed (`isEarnedMethod(policy.method)`, `policy.days`) — not
 * off the absence of a row. `resolveEntitlementStatus` below is a mirror of core/leave.ts's loop, and the
 * order of its branches is the order of that loop's, deliberately.
 *
 * ── AND WHY NOT JUST READ THE OUTCOME THE ENGINE ALREADY LOGS ───────────────────────────────────────
 * It is written down: `leave_generation_run_item` stores the very `LeaveYearGrantOutcome` this file is
 * reconstructing. It is still the wrong source for THIS screen, for three separate reasons, and each one
 * alone would be enough:
 *   1. It exists only for runs launched from the Generate Entitlement screen (core/leave-generation.ts is
 *      the only writer, verified). A year opened any other way logs nothing, so the caption would be blank
 *      on exactly the tenants who have not used that screen — i.e. the ones with the problem.
 *   2. It is a record of an OPERATOR ACTION at a run date. This breakdown answers for an arbitrary `asOf`
 *      (a past leave year's panel is a first-class use), and a run log cannot say what the configuration
 *      resolved to in June 2025.
 *   3. It would cost a query on a read that already runs once PER LEAVE TYPE per screen.
 * The engine's INPUTS are already in hand here and its ORDER is copied exactly, which gives the same
 * answer with no new query, no new writer dependency, and no staleness.
 *
 * ── THE TWO THIS FILE CANNOT SEE, AND WHAT IT DOES ABOUT THEM ───────────────────────────────────────
 * `frozen` and `pack_blocked` are the remaining no-row branches, and neither is derivable from anything
 * `leaveEntitlementBreakdown` reads (an encashment snapshot and the company's country pack — two more
 * queries on a read that already runs once PER LEAVE TYPE per screen). They are therefore NOT invented as
 * statuses. They are DISCLOSED in `not_generated`'s own copy instead: the caption offers the run and then
 * names, in one clause, the two reasons it might not move the figure. Naming what we cannot distinguish is
 * honest; a fifth status that guessed between them would not be.
 *
 * ── ORDER MATTERS, AND THE ORDER IS DELIBERATE ──────────────────────────────────────────────────────
 * `earning_method_missing` OUTRANKS EVERYTHING BELOW IT, including `granted`. Telling HR "not generated
 * yet" while the type has no earning method sends them to press Generate Entitlement, which writes a 0.00
 * row and lands them straight back on a silent zero — the exact loop this item exists to break. The
 * earning method is the thing they can go and fix, so it is the thing they are told. It sits above
 * `earned_accrual` for the same reason the engine's `accrueEarnedLeave` gates on it first (core/leave.ts
 * 6910): an unconfigured type earns nothing however its method column reads.
 *
 * Per the plan, this SURFACES the reporter's data state; it never corrects it. Nothing here writes.
 *
 * DB-free and framework-free on purpose: `core/read.ts` computes the status server-side and the
 * server-safe presentation modules (`components/leave/leave-balance-row.ts`) and client islands both
 * consume the same union, so no screen can invent another meaning for 0.00.
 * Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */

/** Why a leave type's entitlement figure is what it is, for one (employment, leave type, as-at date). */
// r212 — the eight Organisation-Assignment axes carry their own i18n key in the ONE descriptor that
// defines them, so `ELIGIBILITY_AXIS_LABEL_KEY` below derives them instead of listing them again.
// Type-only dependencies all the way down (core/leave-org-criteria.ts is deliberately DB-free), so
// this module stays importable by a client island.
import { ORG_ASSIGNMENT_CRITERIA } from '../core/leave-org-criteria';

export type EntitlementStatus =
  /** An accrual row exists inside this leave year — the figure on screen is the generated entitlement. */
  | 'granted'
  /** A table applies, days resolve, the method is a lump grant, and no row exists yet. THE ONLY STATE FOR
   *  WHICH "Run Generate Entitlement" IS THE REMEDY — see the header's branch table. */
  | 'not_generated'
  /** A table applies and the method is `earned_monthly` / `earned_quarterly` / `earned_daily`: a year-open
   *  logs `earned_method` and grants nothing, now and always. The days arrive through the accrual sweep,
   *  so the figure is "none accrued yet", NOT "waiting for someone to press Generate Entitlement". */
  | 'earned_accrual'
  /** A table applies but resolves 0 days for this employee's length of service (no band covers them, or the
   *  band that does is configured at zero). `openLeaveYear` skips it as `no_entitlement` and will do so on
   *  every future run — the fix is in the table's service bands, not in a sweep. */
  | 'zero_entitlement'
  /** A table applies, but the leave type has no earning method, so generation grants 0.00 until HR sets one
   *  (`leave_type.accrual_unconfigured`, bc36c768). HR's own setting — named, never changed here. */
  | 'earning_method_missing'
  /** r209 — THE LEAVE TYPE HAS NO ENTITLEMENT TABLE IN FORCE AT ALL, for anybody, at this date. Nobody was
   *  ever going to get days on it: 0.00 is arithmetically true and the missing piece is the day table. */
  | 'no_entitlement_table'
  /** r209 — THE TABLES EXIST AND NONE OF THEM REACHES THIS EMPLOYEE. Every eligibility rule that could have
   *  pointed them at one is expired, or narrows to a population they are not in. This is the state a single
   *  rule expiring on 13 August 2026 put an entire tenant into: six correct Medical tables, unreachable,
   *  every employee reading 0.00 with nothing on any screen to say why. It is NOT the same fact as
   *  `no_entitlement_table` and flattening the two is what made it invisible for six days. */
  | 'no_eligibility_match'
  /** r209 — A TABLE APPLIES AND GRANTS DAYS, AND THE MAXIMUM BALANCE CAP IS ZERO, so `applyMaxBalance`
   *  clamps every one of them away at the moment they are granted. The grant still writes a 0.00 accrual
   *  row, so without this the screen reads `granted` and shows a silent 0.00 — the exact shape of the six
   *  Special Leave types (3 days each, maxBalanceDays 0) on the reporter's account.
   *
   *  ⚠️ THIS ANNOUNCES THE CAP; IT DOES NOT REINTERPRET IT. `bandMaxBalance` treats any finite number >= 0
   *  as a real cap and that is deliberate (core/leave-compute.ts) — a cap of 0 means a cap of 0. What was
   *  missing is anybody being TOLD. */
  | 'capped_by_max_balance'
  /** No breakdown resolved for this (employment, type) at all — the row has no entitlement story to tell.
   *  ⚠️ r209: this is NO LONGER the answer to "no table resolved for this employee". That question now
   *  splits into `no_entitlement_table` and `no_eligibility_match` above, and `resolveEntitlementStatus`
   *  never returns this value. It survives as `deriveBalanceRow`'s value when there is no breakdown object
   *  — a leave type the employee holds with nothing computed for it — and stays silent for that reason. */
  | 'not_configured';

export function resolveEntitlementStatus(p: {
  /** An entitlement template resolved for this (employment, leave type) as at the breakdown's date. */
  hasTemplateInForce: boolean;
  /** r209 — the leave TYPE has at least one entitlement table in force at this date, for ANYBODY. Read off
   *  the same resolver `hasTemplateInForce` comes from (`TemplateEntitlementResolver.hasTemplatesFor`), so
   *  it costs no query. This is the ONLY fact that separates "no table exists" from "the tables exist and
   *  no rule points you at one", and the second of those is a defect while the first is not. */
  leaveTypeHasTemplates: boolean;
  /** r209 — the Maximum Balance cap the winning band (or the leave type's own rule) resolves to, exactly as
   *  `applyMaxBalance` will read it. null ⇒ no cap. ZERO IS A REAL CAP OF ZERO and clamps the whole grant
   *  away; that is the semantics this file reports and never changes. */
  maxBalanceDays: number | null;
  /** `leave_type.accrual_unconfigured` is set — no earning method has been chosen for the type. */
  accrualUnconfigured: boolean;
  /** `isEarnedMethod(policy.method)` — the resolved earning method is one of the `earned_*` family, so the
   *  days come from `accrueEarnedLeave` and NEVER from a year-open. Read from the SAME resolved policy the
   *  breakdown's own `monthlyAccruedToDate` uses, so the caption and the figure cannot disagree. */
  earnedMethod: boolean;
  /** The whole-year days the winning band resolves to for this employee (`policy.days`) — the same number
   *  the breakdown prints as Eligible, and the same one `openLeaveYear`'s `days <= 0` guard tests. */
  entitlementDays: number;
  /** At least one `accrual` / `in_lieu_accrual` ledger row inside [cycleStart, asOf]. */
  hasAccrualRowInCycle: boolean;
}): EntitlementStatus {
  // Nothing RESOLVED ⇒ nothing to generate, so this is said FIRST — a tenant is never told their
  // entitlement is "not generated yet" when no table reaches them. r209 splits the one answer into two,
  // because they call for opposite actions: WRITE A TABLE, or FIX THE RULE THAT WAS SUPPOSED TO HAND OUT
  // the tables you already wrote. Both used to read `not_configured`, and `not_configured` is silent.
  if (!p.hasTemplateInForce) {
    return p.leaveTypeHasTemplates ? 'no_eligibility_match' : 'no_entitlement_table';
  }
  // Ranked above everything below, including `granted`; see the header for why the order is the point.
  if (p.accrualUnconfigured) return 'earning_method_missing';
  // r209 — ABOVE `granted`, and that placement is the whole of this branch. A cap of zero does not stop the
  // grant happening; `openLeaveYear` posts the accrual row and `applyMaxBalance` clamps it to 0.00. So the
  // ledger HAS a row, `hasAccrualRowInCycle` is true, and the honest-looking answer below would be
  // "generated" over a figure of 0.00 — the silence this item exists to end. Gated on the table actually
  // granting something (`entitlementDays > 0`): a table of 0 days under a cap of 0 is `zero_entitlement`,
  // which is a statement about the day table and the more useful of the two.
  if (p.maxBalanceDays === 0 && p.entitlementDays > 0) return 'capped_by_max_balance';
  // Days have landed for this cycle: the figure on screen IS the answer, whatever produced it.
  if (p.hasAccrualRowInCycle) return 'granted';
  // ── from here on: a table applies, a method is chosen, and the ledger is empty for this cycle. WHICH of
  // the engine's no-row branches is it? Asked in core/leave.ts's own order (earned before days<=0).
  if (p.earnedMethod) return 'earned_accrual';
  if (!(p.entitlementDays > 0)) return 'zero_entitlement';
  return 'not_generated';
}

/**
 * True for the states a screen must SAY OUT LOUD beside the figure.
 *
 * ⚠️ r209 REVERSED HALF OF THE ORIGINAL RULE HERE, DELIBERATELY. 31e39d74 kept `not_configured` silent on
 * the argument that announcing "no entitlement table" on every unconfigured type "would bury the ones that
 * matter under noise on a tenant with a dozen types". That argument assumed the silent state was always the
 * boring one. It is not: the tenant this item comes from had SIX correct Medical tables and one eligibility
 * rule that expired on 13 August 2026, after which every employee resolved to nothing — and the screen said
 * nothing at all, for six days, because that state rendered as `not_configured` and `not_configured` was
 * silent. The noise argument survives only for the state it was really about, which is now
 * `no_entitlement_table`… and even that is announced, because "this leave type has no day table" is a
 * one-line answer to "why is my balance 0.00" and the reporter asked for exactly that answer.
 *
 * `granted` still needs no caption. `not_configured` stays silent because it no longer means "nothing is
 * configured" — it is the value for a row with no breakdown at all, which has nothing to explain.
 */
export function entitlementStatusNeedsNotice(s: EntitlementStatus): boolean {
  return s !== 'granted' && s !== 'not_configured';
}

/** The i18n leaf under `me.leaveBalanceTable` (label) — one map so the table, the admin grid, the export and
 *  the breakdown panel can never label the same status two ways. */
export const ENTITLEMENT_STATUS_LABEL_KEY: Record<EntitlementStatus, string> = {
  granted: 'statusGenerated',
  not_generated: 'statusNotGenerated',
  earned_accrual: 'statusEarnedAccrual',
  zero_entitlement: 'statusZeroEntitlement',
  earning_method_missing: 'statusEarningMethodMissing',
  no_entitlement_table: 'statusNoEntitlementTable',
  no_eligibility_match: 'statusNoEligibilityMatch',
  capped_by_max_balance: 'statusCappedByMaxBalance',
  not_configured: 'statusNotConfigured',
};

/** The i18n leaf under `me.leaveBalanceTable` carrying the plain-English explanation shown on hover. Only
 *  the announced states have one — `granted` and `not_configured` are self-explanatory and show no icon. */
export const ENTITLEMENT_STATUS_TIP_KEY: Partial<Record<EntitlementStatus, string>> = {
  not_generated: 'statusNotGeneratedTip',
  earned_accrual: 'statusEarnedAccrualTip',
  zero_entitlement: 'statusZeroEntitlementTip',
  earning_method_missing: 'statusEarningMethodMissingTip',
  no_entitlement_table: 'statusNoEntitlementTableTip',
  no_eligibility_match: 'statusNoEligibilityMatchTip',
  capped_by_max_balance: 'statusCappedByMaxBalanceTip',
};

/**
 * r212 — "NO ELIGIBILITY RULE REACHES YOU", WITH THE RULES NAMED.
 *
 * `no_eligibility_match` above is the state a single expired rule put a whole tenant into. Its copy could
 * say WHAT had happened and never WHICH rule, because the status is one word and the reasons are a list.
 * This is that list, in the shape a screen can render without asking the database anything: the rules that
 * exist for the leave type, whether each is in force, and — for one in force — the first thing about this
 * employee that does not match it.
 *
 * ⚠️ EVERY FIELD IS ALREADY-RESOLVED DATA **EXCEPT THE TWO THAT NAME A CRITERIA AXIS**, and the exception
 * is deliberate. `failingAxis` and `failingAxisValue` are the criteria FIELD NAME and the employee's own
 * STORED value — the engine's own vocabulary, not display strings — because the two screens that render
 * them resolve labels from different places and neither can do the other's job:
 *   · the admin explain panel sits beside the rule editor and holds the real `CriteriaSection[]`, so it
 *     labels BOTH through `criteriaAxisLabeller` / `criteriaValueLabeller` — the same call the inherited-
 *     conditions block on that screen makes, which is what stops one screen printing "Employment Type" and
 *     "Contract" where the other prints `employmentTypes` and `contract`;
 *   · the employee's own breakdown panel is reached from `core/read.ts`, which has no translator and no
 *     catalogue, so it labels the AXIS from `ELIGIBILITY_AXIS_LABEL_KEY` below and does not quote the value
 *     at all.
 * Resolving them server-side would have meant one of those two screens getting a raw field name; carrying
 * the raw pair means each screen names it with the vocabulary it actually has.
 *
 * It is declared HERE, beside the status it explains, rather than in the entitlement module, for the same
 * reason `EntitlementStatus` is: the server read, the admin screen and the employee's own panel must all
 * name one shape, and the panel is a client island that cannot import anything touching `db/client`.
 */
export type EligibilityRuleNotice = {
  /** The rule LINEAGE id — the only stable identity a rule has. Names are free text and nothing makes two
   *  of them differ, so a list keyed on the name collapses two rules into one React row. */
  id: string;
  name: string;
  /** What this rule IS, before any question about this employee:
   *   - `matched`       — it reaches this employee (and, where several do, most-specific-wins picked one);
   *   - `in_force`      — live over a live table;
   *   - `expired`       — its end date has passed, so it matches nobody at all;
   *   - `not_yet`       — its start date is in the future;
   *   - `table_stopped` — live, but the entitlement table it points at is not, so it can hand out nothing.
   * The last three are configuration faults with different remedies, and flattening them is what made the
   * production expiry invisible for six days. */
  state: 'matched' | 'in_force' | 'expired' | 'not_yet' | 'table_stopped';
  /** WAS THIS EMPLOYEE ACTUALLY COMPARED AGAINST THIS RULE? False for a rule that reaches nobody (expired,
   *  not yet, stopped table) AND — the case that read as a blank cell before — for EVERY rule when the
   *  employee was not employed on the date at all. `state` cannot carry that second one: such a rule is
   *  genuinely `in_force`; it is the EMPLOYEE who is out of scope, and a screen that shows "In force" beside
   *  an empty reason invites an administrator to go hunting for a criterion that was never consulted. */
  tested: boolean;
  validFrom: string;
  validTo: string | null;
  /** The entitlement table this rule points at, by name. Null only where the lineage has no version at all. */
  tableName: string | null;
  /** The first criterion this employee fails, as the criteria FIELD NAME (`employmentTypes`, `orgDivision`,
   *  …) — a screen labels it, never prints it. Null when the rule matched, was never tested, or fails only
   *  on a COMBINATION; see `failsOnCombination`. */
  failingAxis: string | null;
  /** This employee's own STORED value on that axis, where it is one that can be named honestly (a stored
   *  string, not a UUID). Null ⇒ render the axis alone; NEVER render a guess. */
  failingAxisValue: string | null;
  /** Every axis passes on its own and the rule still does not match, because the axes that share one dated
   *  assignment row do not all hold on the SAME one. Stated rather than blamed on an innocent axis. */
  failsOnCombination: boolean;
  /** Where an administrator opens this rule. Null on the employee's own panel, which links nowhere — and
   *  null on the admin panel too for a lineage with no editable version, because a link that lands on a
   *  screen with nothing to show is worse than no link. */
  href: string | null;
};

/**
 * WHAT THE WHOLE ANSWER IS, IN ONE WORD — decided HERE and nowhere else.
 *
 * ⚠️ THIS FIELD EXISTS BECAUSE THE TWO SCREENS ONCE DISAGREED. Both were handed the identical notice and
 * both re-derived the top-level verdict with their own `if` order: the admin panel tested `!activeAtDate`
 * first and printed "this employee was not employed on that date, so no rule can reach them", while the
 * employee's panel tested `soleTableApplies` first and printed "that table applies to everyone" — about the
 * same object, for a leaver read at a date before their hire. `eligibilityNoticeFrom` makes the mapping
 * once precisely so that cannot happen; leaving the precedence out of it left the important half behind.
 */
export type EligibilityVerdict =
  /** A rule reached this employee and a table resolved. */
  | 'resolved'
  /** r193 fault 3 — one table in force, no rule in force, so the table applied and NO RULE IS NEEDED. */
  | 'sole_table'
  /** 76ffdcf2 — no benefit scheme reached this employee, so the leave type's DEFAULT entitlement table
   *  applied. A table resolved and days were granted; naming a scheme here would be false. */
  | 'default_table'
  /** Nothing resolved AND this employment did not exist on the date (hired later / already terminated). */
  | 'not_active'
  /** Nothing resolved and the leave type has no eligibility rules at all. */
  | 'no_rules'
  /** Nothing resolved and every rule that could be tested excluded this employee. */
  | 'no_match';

/** The whole answer for one (employee, leave type, date). */
export type EligibilityNotice = {
  /** The one verdict both screens read. See `EligibilityVerdict`. */
  verdict: EligibilityVerdict;
  /** This employment is hired by the date asked about and not already terminated. Kept ALONGSIDE the
   *  verdict rather than folded into it: when a sole table resolves for somebody outside their employment
   *  window BOTH facts are true, the verdict names what resolved, and this is the caveat beside it. */
  activeAtDate: boolean;
  /** r193 fault 3, as the engine's own `viaSoleTemplate`. Kept for a screen that words the sole-table
   *  verdict differently from an ordinary win; `verdict === 'sole_table'` is the same fact. */
  soleTableApplies: boolean;
  /** 76ffdcf2, as the engine's own `viaDefaultTemplate`: no scheme matched and the leave type's DEFAULT
   *  table answered. Kept alongside the verdict for the same reason `soleTableApplies` is. */
  defaultTableApplies: boolean;
  /** The rule that decided, when one did — so a matching employee reads WHY they get what they get. */
  winningRuleName: string | null;
  /** The entitlement table that decided, by name. Non-null WITHOUT `winningRuleName` in exactly two cases:
   *  `sole_table`, where the table applied and no rule was consulted because none exists to consult, and
   *  `default_table`, where no scheme reached this employee and the leave type's default answered. */
  winningTableName: string | null;
  rules: EligibilityRuleNotice[];
  /** Some rule narrows by grade, gender, nationality, religion or race — none of which is effective-dated
   *  in this schema, so it is read at TODAY'S value however far back the date reaches
   *  (`UNDATED_ELIGIBILITY_AXES`). Captioned rather than implied away. */
  usesUndatedAxis: boolean;
};

/**
 * A CRITERIA AXIS → THE MESSAGE KEY THE RULE EDITOR'S OWN PICKER IS LABELLED FROM.
 *
 * ⚠️ THIS IS NOT A SECOND VOCABULARY, AND A TEST STOPS IT BECOMING ONE. `buildOrgCriteriaSections`
 * (core/org-criteria-form.ts) is the one picker, but it is unreachable from a client component — it imports
 * `CONFIRMATION_STATUSES` from `core/org-criteria.ts`, which imports `db/client`. So the employee's panel,
 * which is a client island and gets its notice from `core/read.ts` (no translator, no catalogue), cannot
 * call it. This map carries the same key each field is labelled from, and
 * `test/r212-leave-type-inherited-conditions.test.ts` builds the real sections with key-returning
 * translators and asserts, field by field, that the two agree — so an axis renamed, added or relabelled in
 * the builder fails there instead of painting `MISSING_MESSAGE` on a live screen.
 *
 * The eight Organisation-Assignment axes are DERIVED from `ORG_ASSIGNMENT_CRITERIA` rather than listed,
 * because that descriptor already carries the label key the builder uses for them.
 */
export type EligibilityAxisLabelKey = {
  /** `criteria` ⇒ `admin.leave.adjustmentsCriteria`; `orgCategory` ⇒ `admin.profileOptions.category`. The
   *  two namespaces `buildOrgCriteriaSections` labels its FIELDS from (its third translator labels option
   *  VALUES, which nothing here quotes). */
  ns: 'criteria' | 'orgCategory';
  key: string;
};

export const ELIGIBILITY_AXIS_LABEL_KEY: Record<string, EligibilityAxisLabelKey> = {
  companyIds: { ns: 'criteria', key: 'company' },
  businessUnitIds: { ns: 'criteria', key: 'businessUnit' },
  departmentIds: { ns: 'criteria', key: 'department' },
  locationIds: { ns: 'criteria', key: 'location' },
  employmentTypes: { ns: 'criteria', key: 'employmentType' },
  employmentStatuses: { ns: 'criteria', key: 'employeeStatus' },
  gradeIds: { ns: 'criteria', key: 'jobGrade' },
  positionIds: { ns: 'criteria', key: 'position' },
  costCenterIds: { ns: 'criteria', key: 'costCentre' },
  genders: { ns: 'criteria', key: 'gender' },
  nationalities: { ns: 'criteria', key: 'nationality' },
  religions: { ns: 'criteria', key: 'religion' },
  races: { ns: 'criteria', key: 'race' },
  hiredFrom: { ns: 'criteria', key: 'hiredFrom' },
  hiredTo: { ns: 'criteria', key: 'hiredTo' },
  minYearsOfService: { ns: 'criteria', key: 'minYears' },
  maxYearsOfService: { ns: 'criteria', key: 'maxYears' },
  confirmationStatuses: { ns: 'criteria', key: 'confirmationStatus' },
  ...Object.fromEntries(
    ORG_ASSIGNMENT_CRITERIA.map((c) => [c.key, { ns: 'orgCategory', key: c.labelKey } as EligibilityAxisLabelKey]),
  ),
};
