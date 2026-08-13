/**
 * Pure pay-rule resolver + validator (Payroll Setup — configurable pay-rule engine). No DB, no network, no
 * string parsing: a `switch` over a closed discriminated union, mirroring core/payroll.ts's ShiftDifferential
 * resolver. The kernel, the service write-guard, the AI validator, and the admin UI all call the SAME pure
 * functions here, so "valid in the UI" === "accepted by the kernel".
 *
 * Sign/clamp contract: none of the ORIGINAL kinds can structurally go negative (there is no `a - b` kind, and
 * flat_capped is a min of two non-negatives), so a resolved earning is always >= 0 — it can never corrupt the
 * EPF/SOCSO/PCB base. 61bf109d's `formula` kind DOES carry a `-` operator, so its fold clamps the FINAL
 * result at 0 (and only that kind clamps — every pre-existing kind's arithmetic is untouched, which is what
 * keeps the compat golden byte-identical). The finite-guard below is defensive only (a corrupted JSONB
 * value), fail-closed by contract.
 *
 * ── 2da9937a: dividing by a LIVE value ─────────────────────────────────────────────────────────────
 * This header used to state that `/` was legal only with a non-zero literal, so a zero-days / zero-hours
 * employee could never abort a batch. THE GUARANTEE STILL HOLDS; the mechanism changed. The reporter's
 * worked example — (Basic + All Fixed Allowance) / Working Days / Working Hours × Rate × Input Hours —
 * cannot be written without dividing by a live value, so the save-time refusal was replaced by a runtime
 * contract rather than simply lifted: a literal zero divisor is still refused at save time, and a LIVE
 * divisor that resolves to 0 (or non-finite) for an employee makes THAT COMPONENT pay 0 for THAT employee
 * and reports a PayRuleComponentNotice. No Infinity, no NaN, no aborted batch, and no silence — the run
 * completes and the affected employment is surfaced for review.
 *
 * The second half of that example is the `fixed_allowances` operand: the SUM of the employee's fixed
 * allowances, defined as items ranking strictly BELOW the one reading it (isFixedAllowanceComponent +
 * resolvePayComponentSet), which is what keeps it unable to reintroduce the cycle the planner refuses.
 *
 * ── 61bf109d: Input Type redesign + Formula Setting ────────────────────────────────────────────────
 * NO EXPRESSION STRINGS. A formula is an AST-shaped VALUE (a seed operand folded left-to-right through a
 * term list), so there is no `eval`, no `new Function`, no dynamic import of expression text, and no parser
 * that could accept something the validator has not seen. The FIXED, NAMED input set is the contract:
 * a literal number, `basic`, `days`, `hours`, and `component:<CODE>`. Anything outside it is unrepresentable
 * in the type and rejected at SAVE time — never a run-time surprise on a payslip.
 *
 * Because a rule may now name ANOTHER pay item, the catalog is a dependency GRAPH. planResolutionOrder()
 * topologically sorts it and REFUSES cycles at save time; the resulting rank is persisted on
 * pay_component.resolution_order (migration 0330) and resolvePayComponentSet() replays that recorded order,
 * so the order that was validated is the order that pays and two runs of the same payroll cannot disagree.
 */
import type { FormulaOp, FormulaOperand, FormulaTerm, PayRule } from '../db/schema';

export { type PayRule, type FormulaOperand, type FormulaOp, type FormulaTerm } from '../db/schema';

/** Stable validation error codes — the UI maps these to localised payRule.errors.* messages (never raw
 *  English from this library reaches a localised screen). */
export type PayRuleErrorCode =
  | 'BAD_KIND'
  | 'OUT_OF_RANGE'
  | 'PRORATION_CONFLICT'
  // ── 61bf109d ──
  | 'SELF_REFERENCE' //     the rule names its own pay code
  | 'CYCLE' //              two or more pay items reference each other, directly or transitively
  | 'UNKNOWN_COMPONENT' //  the rule names a pay code that is not an active item in this tenant's catalog
  | 'STATUTORY_FORBIDDEN' // a formula was placed on, or points at, a legislated statutory component
  | 'UNSAFE_DIVISION'; //   `/` by anything other than a non-zero fixed number

export type PayRuleValidation = { ok: true } | { ok: false; code: PayRuleErrorCode };

/** Thrown by resolvePayRule when a corrupted JSONB value yields a non-finite result (defensive; unreachable
 *  with a validated rule). Fail-closed: the kernel surfaces it rather than writing a wrong payslip. */
export class PayRuleEvalError extends Error {
  constructor(message = 'pay-rule resolved to a non-finite value') {
    super(message);
    this.name = 'PayRuleEvalError';
  }
}

// Order matters: this array drives the Input Type dropdown, so it reads as the ticket words it — a fixed
// amount · a quantity multiplied by a rate · a percentage of another pay item · a number of days or hours ·
// a value calculated by a formula.
export const PAY_RULE_KINDS = ['fixed', 'qty_rate', 'percent_of', 'per_day', 'per_hour', 'flat_capped', 'formula'] as const;
export type PayRuleKind = (typeof PAY_RULE_KINDS)[number];

/** The FIXED, NAMED input set a formula may read. Exported so the UI builds its operand picker from the
 *  same list the validator enforces — there is exactly one definition of "what a formula may reference".
 *  2da9937a adds `fixed_allowances` (the SUM of the employee's fixed allowances) — see the file header.
 *  e318eaec adds `calendar_days` and `prorated_basic`, both figures the kernel already computes (PayRuleScope).
 *  ORDER IS THE DROPDOWN ORDER: each new ref sits beside the one it is most likely to be confused with, so
 *  "Days worked" and "Calendar days in the month" are adjacent rather than a screen apart. */
export const FORMULA_OPERAND_REFS = [
  'number',
  'basic',
  'prorated_basic',
  'days',
  'calendar_days',
  'hours',
  'fixed_allowances',
  'component',
] as const;
export type FormulaOperandRef = (typeof FORMULA_OPERAND_REFS)[number];
export const FORMULA_OPS = ['+', '-', '*', '/'] as const;

/** A formula is a fold, not a tree, so its size is trivially bounded. Eight steps is far past any real pay
 *  rule and keeps the stored JSONB small enough to stay readable in an audit. */
export const FORMULA_MAX_TERMS = 8;

/** e318eaec — a named number's label is a caption on a formula line, not a description. Bounded so the
 *  readable formula stays readable and a corrupted JSONB value cannot carry an essay onto a screen. */
export const FORMULA_LABEL_MAX_LENGTH = 40;

/**
 * Pay codes that are LEGISLATED, not configured. `localization/my` owns these rates and
 * scripts/statutory-pack-build-my.ts builds the pack; letting a tenant formula compute one would put the
 * tenant, rather than the legislation, in charge of a legal deduction. A rule on one of these codes — or a
 * formula that READS one, which would smuggle a statutory figure into pay through the back door — is refused
 * at save time with STATUTORY_FORBIDDEN. Matching is case-insensitive on the pay code.
 */
export const STATUTORY_COMPONENT_CODES: readonly string[] = [
  'EPF', 'EPF_EMPLOYEE', 'EPF_EMPLOYER', 'KWSP',
  'SOCSO', 'SOCSO_EMPLOYEE', 'SOCSO_EMPLOYER', 'PERKESO',
  'EIS', 'EIS_EMPLOYEE', 'EIS_EMPLOYER', 'SIP',
  'PCB', 'MTD', 'CP38',
  'HRDF', 'HRDF_LEVY', 'HRDC',
  'ZAKAT',
];
const statutorySet = new Set(STATUTORY_COMPONENT_CODES);

/** The reserved pay code for basic salary. Already a magic string in the kernel (core/payroll.ts skips it
 *  in the component loop and pins the authoritative Personnel figure under it); named here because
 *  2da9937a's aggregate is the second thing that has to know the BASIC component is not a normal pay item. */
export const BASIC_PAY_CODE = 'BASIC';

/**
 * Is this pay code a statutory component? TRUE for a reserved statutory CODE, and for any component whose
 * catalog kind is `contribution` — that kind exists precisely to model a statutory contribution line, so it
 * is out of bounds for a tenant formula regardless of what the code is called.
 */
export function isStatutoryComponent(code: string, kind?: string | null): boolean {
  if (kind === 'contribution') return true;
  return statutorySet.has(code.trim().toUpperCase());
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
// Generous-but-sane bounds: a per-day/per-hour rate or a flat value/cap; a percentage 0..1000 (>100% is a
// legitimate uplift, e.g. 150% of basic). All non-negative — see the sign/clamp contract above.
const inMoney = (n: unknown): n is number => finite(n) && n >= 0 && n <= 100_000_000;
const inPct = (n: unknown): n is number => finite(n) && n >= 0 && n <= 1000;
// A quantity: units, days, pieces, kilometres. Non-negative like everything else in the union.
const inQty = (n: unknown): n is number => finite(n) && n >= 0 && n <= 1_000_000;

const normCode = (c: unknown): string => (typeof c === 'string' ? c.trim().toUpperCase() : '');

/** Structural check of ONE formula operand. Catalog-awareness (does the code exist? is it statutory?) is
 *  deliberately NOT here — that needs the catalog and lives in validatePayRuleAgainstCatalog. */
function validateOperand(op: FormulaOperand | undefined): PayRuleValidation {
  if (!op || typeof op !== 'object' || !FORMULA_OPERAND_REFS.includes((op as FormulaOperand).ref as FormulaOperandRef)) {
    return { ok: false, code: 'BAD_KIND' };
  }
  switch (op.ref) {
    case 'number':
      if (!inMoney(op.value)) return { ok: false, code: 'OUT_OF_RANGE' };
      // e318eaec — the optional display name. Checked here so a corrupted or oversized value is refused at
      // SAVE time like everything else in this union, rather than reaching a screen. It never reaches
      // readOperand, so this can only ever be a legibility check, never an arithmetic one.
      if (op.label !== undefined && (typeof op.label !== 'string' || op.label.length > FORMULA_LABEL_MAX_LENGTH)) {
        return { ok: false, code: 'OUT_OF_RANGE' };
      }
      return { ok: true };
    case 'basic':
    case 'days':
    case 'hours':
    // 2da9937a — the aggregate names no code, so there is nothing structural to check here. Its SAFETY is
    // not a validation at all: it is defined as the sum of items ranking strictly BELOW the one reading it
    // (resolvePayComponentSet), which is what makes it unable to reintroduce the cycle the planner refuses.
    case 'fixed_allowances':
    // e318eaec — both name no code and carry no data: the kernel supplies them on the scope, exactly as it
    // supplies `basic` and `days`, so there is nothing structural to check.
    case 'calendar_days':
    case 'prorated_basic':
      return { ok: true };
    case 'component':
      return normCode(op.code) === '' ? { ok: false, code: 'UNKNOWN_COMPONENT' } : { ok: true };
    default: {
      const _never: never = op;
      void _never;
      return { ok: false, code: 'BAD_KIND' };
    }
  }
}

/**
 * Structurally validate a rule against a component's proration flag. Returns a stable error CODE (mapped to
 * i18n in the UI), never a free-text string. `componentProrates` is needed because a per_day / per_hour rule
 * encodes its OWN period scaling, so it must NOT also ride the kernel's `prorates` multiplier (that would
 * double-prorate a mid-period joiner) — the two are mutually exclusive by construction.
 *
 * This function is PURE and catalog-free, so the browser can run it on every keystroke. The checks that need
 * the catalog (unknown code, statutory target, cycle) run server-side in validatePayRuleAgainstCatalog —
 * both are called on the save path, so the server is authoritative for all of them.
 */
export function validatePayRule(rule: PayRule | null, componentProrates: boolean): PayRuleValidation {
  if (rule == null) return { ok: true };
  if (!rule || typeof rule !== 'object' || !PAY_RULE_KINDS.includes((rule as PayRule).kind as PayRuleKind)) {
    return { ok: false, code: 'BAD_KIND' };
  }
  switch (rule.kind) {
    case 'fixed':
      return { ok: true };
    case 'percent_of':
      // 61bf109d — `component` joins `basic` as a percentage base. A legacy stored row is `{base:'basic'}`
      // and takes the same path it always did.
      if (rule.base !== 'basic' && rule.base !== 'component') return { ok: false, code: 'BAD_KIND' };
      if (rule.base === 'component' && normCode(rule.componentCode) === '') return { ok: false, code: 'UNKNOWN_COMPONENT' };
      return inPct(rule.pct) ? { ok: true } : { ok: false, code: 'OUT_OF_RANGE' };
    case 'per_day':
      if (!inMoney(rule.rate)) return { ok: false, code: 'OUT_OF_RANGE' };
      // A per-period rule already reflects the partial period via days_worked / hours — the component must
      // NOT also prorate, or a mid-period joiner is scaled twice.
      if (componentProrates) return { ok: false, code: 'PRORATION_CONFLICT' };
      return { ok: true };
    case 'per_hour':
      if (!inMoney(rule.rate)) return { ok: false, code: 'OUT_OF_RANGE' };
      if (componentProrates) return { ok: false, code: 'PRORATION_CONFLICT' };
      // 2.1.3 (Hourly) — the shift-clamp toggle is per_hour-only and, when present, must be a boolean. A
      // non-boolean value is a corrupted rule (BAD_KIND). validatePayRule never sees the flag on another kind
      // because the discriminated union forbids it at compile time; resolveRule guards the runtime shape too.
      if (
        'onlyPullHoursWithinShiftSchedule' in rule &&
        rule.onlyPullHoursWithinShiftSchedule !== undefined &&
        typeof rule.onlyPullHoursWithinShiftSchedule !== 'boolean'
      ) {
        return { ok: false, code: 'BAD_KIND' };
      }
      return { ok: true };
    case 'flat_capped':
      if (!inMoney(rule.value) || !inMoney(rule.cap)) return { ok: false, code: 'OUT_OF_RANGE' };
      return { ok: true };
    case 'qty_rate':
      // 61bf109d — "a quantity multiplied by a rate". Both operands are stored on the rule, so this kind
      // carries NO period scaling of its own and (unlike per_day/per_hour) is compatible with `prorates`.
      if (!inQty(rule.qty) || !inMoney(rule.rate)) return { ok: false, code: 'OUT_OF_RANGE' };
      return { ok: true };
    case 'formula': {
      // 61bf109d — the restricted formula. Every operand must be in the FIXED, NAMED set.
      //
      // ── 2da9937a: DIVIDING BY A LIVE VALUE ──────────────────────────────────────────────────────────
      // 61bf109d refused `/` by anything but a non-zero literal, and its REASONING WAS RIGHT: a zero-hours
      // employee would produce Infinity and abort the whole batch. The reporter's worked example needs
      // `… / Working Days / Working Hours`, so the restriction had to go — but the reasoning it protected
      // did NOT. The refusal is replaced by a stronger runtime contract, not deleted:
      //
      //   • a LITERAL divisor is still checked here, and a literal zero is still UNSAFE_DIVISION — a
      //     formula that divides by zero for EVERYONE is a typo, and a typo belongs on the save button.
      //   • a LIVE divisor (basic / days / hours / the aggregate / another item) is now structurally legal,
      //     and resolvePayRule guards it per employee: if it resolves to 0 or non-finite, THAT COMPONENT
      //     pays 0 for THAT employee and the fact is reported through the notices channel. The batch always
      //     completes, and the employee is surfaced rather than quietly paid a wrong figure.
      //
      // So the invariant the old check existed to defend — "a zero-hours employee can never abort a payroll
      // batch, and can never be silently paid a wrong number" — is stronger now, not weaker.
      const seed = validateOperand(rule.start);
      if (!seed.ok) return seed;
      if (!Array.isArray(rule.terms)) return { ok: false, code: 'BAD_KIND' };
      if (rule.terms.length > FORMULA_MAX_TERMS) return { ok: false, code: 'OUT_OF_RANGE' };
      for (const t of rule.terms as FormulaTerm[]) {
        if (!t || typeof t !== 'object' || !FORMULA_OPS.includes(t.op)) return { ok: false, code: 'BAD_KIND' };
        const v = validateOperand(t.operand);
        if (!v.ok) return v;
        if (t.op === '/' && t.operand.ref === 'number' && !(inMoney(t.operand.value) && t.operand.value !== 0)) {
          return { ok: false, code: 'UNSAFE_DIVISION' };
        }
      }
      return { ok: true };
    }
    default: {
      // Exhaustiveness guard — a new kind without a branch is a compile error.
      const _never: never = rule;
      void _never;
      return { ok: false, code: 'BAD_KIND' };
    }
  }
}

/** Every pay code a rule reads, normalised and de-duplicated. This is the single definition of a dependency
 *  EDGE — the cycle check, the unknown-code check and the statutory-reference check all derive from it, so
 *  a future rule kind that references another item cannot silently escape any of them. */
export function payRuleDependencies(rule: PayRule | null): string[] {
  if (rule == null) return [];
  const out = new Set<string>();
  const add = (c: unknown) => {
    const n = normCode(c);
    if (n) out.add(n);
  };
  if (rule.kind === 'percent_of' && rule.base === 'component') add(rule.componentCode);
  if (rule.kind === 'formula') {
    const operands: FormulaOperand[] = [rule.start, ...(Array.isArray(rule.terms) ? rule.terms.map((t) => t?.operand) : [])].filter(
      Boolean,
    ) as FormulaOperand[];
    for (const o of operands) if (o && o.ref === 'component') add(o.code);
  }
  return [...out];
}

/**
 * 2da9937a — does this rule read the `fixed_allowances` aggregate? Unlike every other dependency, the
 * aggregate names no pay code, so payRuleDependencies (which is a set of CODES) cannot express it. This
 * predicate is the second kind of edge, and planResolutionOrder / resolvePayComponentSet are its only two
 * consumers — the same "one definition of an edge" discipline payRuleDependencies has.
 */
export function payRuleReadsFixedAllowanceTotal(rule: PayRule | null): boolean {
  return payRuleReadsOperand(rule, 'fixed_allowances');
}

/** Does this rule's formula read a particular named input? Only a `formula` has operands at all, so every
 *  other kind answers false. Shared by payRuleReadsFixedAllowanceTotal (the resolution-order edge) and by
 *  payRuleInputUnit below (which input a one-off transaction must key), so "reads `hours`" has one
 *  definition rather than one per consumer. */
export function payRuleReadsOperand(rule: PayRule | null | undefined, ref: FormulaOperandRef): boolean {
  if (rule == null || rule.kind !== 'formula') return false;
  const operands: (FormulaOperand | undefined)[] = [rule.start, ...(Array.isArray(rule.terms) ? rule.terms.map((t) => t?.operand) : [])];
  return operands.some((o) => o != null && o.ref === ref);
}

/**
 * 2da9937a — the rule kinds whose amount is WORKED OUT rather than typed.
 *
 * This is the list the approved plan names, and the omissions are deliberate rather than accidental:
 * `percent_of` and `flat_capped` also compute a figure, but neither reads anything the operator keys on a
 * one-off transaction, and taking the Amount box away from them would change what an existing screen asks
 * for without giving the operator any input to supply instead. `fixed` (and a null rule) is the legacy
 * stored-amount case and stays byte-identical. Widening this list changes what a one-off pays, so it is a
 * decision, not a default.
 */
/**
 * 2da9937a — the rule kinds whose one-off amount is COMPUTED from what the operator keys.
 *
 * ⚠️ `qty_rate` IS DELIBERATELY ABSENT, and it was in this list until verification caught what that does.
 *
 * Deriving an amount is only safe when the operator has a box whose value feeds the derivation. For
 * per_hour, per_day and an hours/days formula, `payRuleInputUnit` names that box and the keyed quantity
 * REPLACES the scope input. `qty_rate` has no such box — payRuleInputUnit returns null for it, because the
 * rule carries its own qty — so resolvePayComponentSet computes rule.qty * rule.rate from the CATALOG and
 * nothing the operator does can change it.
 *
 * Put together, listing it here locked the Amount box and then overwrote the typed figure with a catalog
 * constant. A COMMISSION item configured qty_rate {qty: 1, rate: 50} — and the board item names Commission
 * explicitly — would take a keyed 600 for twelve units and pay 50. Silently, on a payslip.
 *
 * A one-off transaction is a statement about THIS month's quantity. Until qty_rate has a quantity box of
 * its own, the operator's typed amount is the only figure that can be right, so it stays authoritative and
 * this kind behaves exactly as it does today.
 */
export const DERIVED_AMOUNT_RULE_KINDS: readonly PayRuleKind[] = ['per_hour', 'per_day', 'formula'];

/** Does a one-off transaction on this pay item COMPUTE its amount from the item's rule (rather than take
 *  the amount the operator typed)? One predicate, read by the entry screen to lock the Amount box and by
 *  the write path to overwrite whatever amount arrived — so the box the operator cannot fill and the value
 *  the server refuses to trust are the same set of items by construction. */
export function payRuleDerivesAmount(rule: PayRule | null | undefined): boolean {
  return rule != null && DERIVED_AMOUNT_RULE_KINDS.includes(rule.kind);
}

/**
 * 2da9937a — WHICH quantity the operator must key for a one-off transaction on this pay item, and the ONE
 * definition of it.
 *
 * The answer names the scope input the keyed quantity REPLACES: 10 hours entered against a `per_hour`
 * overtime item resolves the rule with `hours = 10`, not with the employee's attendance total for the
 * month, because a one-off transaction is a statement about those ten hours and nothing else.
 *
 * `null` means the rule needs nothing from the operator — a formula that reads only `basic` /
 * `fixed_allowances` / another pay item is fully determined by the employee's own figures, and still
 * derives its amount with no box to fill. `qty_rate` also returns null, and that is precisely why it is
 * NOT in DERIVED_AMOUNT_RULE_KINDS — see the note there.
 *
 * The screen locks its Input Type to this answer and the write path REFUSES a save without it. Two
 * consumers, one function: an item whose Amount box is taken away always has the input that replaces it.
 */
export function payRuleInputUnit(rule: PayRule | null | undefined): 'hours' | 'days' | null {
  if (rule == null) return null;
  if (rule.kind === 'per_hour') return 'hours';
  if (rule.kind === 'per_day') return 'days';
  // A formula may read both. `hours` wins because the reporter's own worked example
  // (… / Working Days / Working Hours × Rate × Input Hours) divides by the establishment's day and hour
  // figures and multiplies by the hours BEING CLAIMED — the keyed quantity is the hours, every time.
  if (payRuleReadsOperand(rule, 'hours')) return 'hours';
  if (payRuleReadsOperand(rule, 'days')) return 'days';
  return null;
}

/**
 * c11e81aa — may a one-off transaction on this pay item be recorded DAY BY DAY?
 *
 * The day grid keeps one dated line per day, and the question it asks of each line is "what is THIS day
 * worth". That question only has an answer when the item's own configuration lets one day differ from
 * another, and the pay item — not the entry screen — is the thing that knows:
 *
 *   · `per_hour` / `per_day`, and a `formula` that reads `hours` or `days` (payRuleInputUnit names the
 *     box) — the keyed quantity IS the day's own fact, so the grid is exactly the right shape.
 *   · NO RULE AT ALL — nothing has declared this item a monthly constant, and the amount is the
 *     operator's to key per line. ABSENT and UNPAID LEAVE are this tenant's two today; both are
 *     inherently per-day, and the grid already explains itself there (`dayGridNoRuleHint`).
 *   · `fixed`, `qty_rate`, `percent_of`, `flat_capped`, and a formula reading NEITHER hours nor days —
 *     ONE FIGURE FOR THE MONTH. Five lines of a fixed RM100 allowance are not five days of anything, and
 *     on the derived kinds it is worse than meaningless: a formula reading only `basic` yields the whole
 *     month's figure for every line it is asked about, so five days would pay it five times.
 *
 * Resolved on the SERVER and handed to the screen as a boolean, for the same reason `payRuleDerivesAmount`
 * is: the rule value never crosses to the client, and a UI guess at "this looks like a fixed item" would
 * be a second definition of a fact the catalog already holds.
 *
 * IT GATES THE OFFER, NOT THE WRITE. `createIndividualTxnsBulk` still accepts many dated lines for any
 * item — the Excel import writes exactly that shape for fixed-amount items and must keep working — so
 * this is what the screen offers, deliberately not a new refusal in the service.
 */
export function payRuleAllowsDayByDay(rule: PayRule | null | undefined): boolean {
  if (rule == null) return true;
  if (rule.kind === 'per_hour' || rule.kind === 'per_day') return true;
  if (rule.kind === 'formula') return payRuleInputUnit(rule) != null;
  return false;
}

/**
 * 2da9937a — is this pay item one of the "fixed allowances" the aggregate operand totals?
 *
 * THE DEFINITION IS DELIBERATELY NARROW, and each clause pays for itself:
 *   • kind === 'allowance' — the reporter asked for "All Fixed ALLOWANCE". Summing deductions or
 *     contributions into a figure labelled "allowances" would be a wrong payslip with a plausible name.
 *   • NOT statutory — reading a legislated line into pay through an aggregate is the same violation
 *     validatePayRuleAgainstCatalog already refuses for a named `component` operand, wearing a hat.
 *   • rule is null or `fixed` — "FIXED allowance" means one paid as a stored amount. This clause is also
 *     what makes the aggregate structurally acyclic: an item with no rule has no dependencies at all, so
 *     nothing in the sum can depend, directly or transitively, on the item that reads the sum.
 */
export function isFixedAllowanceComponent(code: string, kind: string | null | undefined, rule: PayRule | null): boolean {
  if (kind !== 'allowance') return false;
  // BASIC IS NOT AN ALLOWANCE, whatever the catalog row says. It is seeded with kind 'allowance' and no
  // rule (localization/my/pay-components.ts), so it satisfies every other clause here — and counting it
  // would have silently added basic salary to the total in the reporter's OWN formula,
  // `Basic + All Fixed Allowance`, paying basic twice. The kernel already treats the BASIC component as
  // inert for exactly this class of reason (feedback 64fb5e48: Personnel is the only source of basic pay).
  if (normCode(code) === BASIC_PAY_CODE) return false;
  if (isStatutoryComponent(code, kind)) return false;
  return rule == null || rule.kind === 'fixed';
}

/** A catalog row as the graph planner needs to see it. */
export type PayRuleCatalogNode = {
  code: string;
  rule: PayRule | null;
  /** pay_component.kind — `contribution` marks a statutory line (see isStatutoryComponent). */
  kind?: string | null;
  /** Archived items may not be referenced: a formula pointing at a retired code would silently read 0. */
  archived?: boolean;
};

export type ResolutionPlan =
  | { ok: true; order: Map<string, number> }
  | { ok: false; code: PayRuleErrorCode; at?: string };

/**
 * Topologically sort the catalog and REFUSE cycles. Returns a rank per pay code: a code always ranks
 * strictly ABOVE every code it depends on, so resolving in ascending rank means every dependency already
 * has a value. A code with no dependencies ranks 0 — which is every legacy row, and why migration 0330's
 * `DEFAULT 0` backfill reproduces today's behaviour exactly.
 *
 * DETERMINISM: the walk visits codes in sorted order and rank is `1 + max(rank of dependencies)`, so the
 * same catalog always yields the same map regardless of the order rows came back from the database. That is
 * the property that stops two runs of the same payroll from disagreeing.
 *
 * Cycles are detected with an explicit on-stack set rather than a visit counter, so the error names the code
 * the cycle was found at (`at`) and the admin is told WHICH item to fix.
 */
export function planResolutionOrder(nodes: readonly PayRuleCatalogNode[]): ResolutionPlan {
  const byCode = new Map<string, PayRuleCatalogNode>();
  for (const n of nodes) byCode.set(normCode(n.code), n);
  const rank = new Map<string, number>();
  const onStack = new Set<string>();

  const visit = (code: string): { ok: true; rank: number } | { ok: false; code: PayRuleErrorCode; at?: string } => {
    const cached = rank.get(code);
    if (cached !== undefined) return { ok: true, rank: cached };
    if (onStack.has(code)) return { ok: false, code: 'CYCLE', at: code };
    const node = byCode.get(code);
    // An unresolvable reference is caught by validatePayRuleAgainstCatalog with a precise message; here it
    // simply contributes no edge (rank 0) so the planner cannot crash on a partially-loaded catalog.
    if (!node) return { ok: true, rank: 0 };
    onStack.add(code);
    let r = 0;
    // 2da9937a — the aggregate contributes an edge to EVERY fixed allowance, so an item reading it always
    // ranks strictly above all of them and therefore sees their final figures. Computed here rather than
    // written into payRuleDependencies because these are not references BY CODE: the formula names no item,
    // and the set it sums is whatever the catalog holds at the time, which is the point of the feature.
    const aggregated = payRuleReadsFixedAllowanceTotal(node.rule)
      ? [...byCode.entries()]
          .filter(([c, n]) => c !== code && !n.archived && isFixedAllowanceComponent(c, n.kind, n.rule))
          .map(([c]) => c)
      : [];
    for (const dep of [...payRuleDependencies(node.rule), ...aggregated].sort()) {
      if (dep === code) {
        onStack.delete(code);
        return { ok: false, code: 'SELF_REFERENCE', at: code };
      }
      const sub = visit(dep);
      if (!sub.ok) {
        onStack.delete(code);
        return sub;
      }
      r = Math.max(r, sub.rank + 1);
    }
    onStack.delete(code);
    rank.set(code, r);
    return { ok: true, rank: r };
  };

  for (const code of [...byCode.keys()].sort()) {
    const res = visit(code);
    if (!res.ok) return res;
  }
  return { ok: true, order: rank };
}

/**
 * The CATALOG-AWARE half of save-time validation: a rule may only name a pay code that actually exists as an
 * active, non-statutory item in this tenant's catalog, may not name itself, and may not create a cycle.
 * `catalog` is the tenant's items INCLUDING the pending change (the caller substitutes the row being saved),
 * so the cycle check sees the graph as it WILL be, not as it was — the point of refusing at save time is
 * that the bad shape never reaches a run.
 */
export function validatePayRuleAgainstCatalog(
  target: { code: string; rule: PayRule | null; kind?: string | null },
  catalog: readonly PayRuleCatalogNode[],
): PayRuleValidation {
  const self = normCode(target.code);
  const deps = payRuleDependencies(target.rule);
  const configurable = target.rule != null && target.rule.kind !== 'fixed';

  // Statutory items stay OUT — EPF / SOCSO / EIS / PCB are legislated. A tenant rule on one of them would
  // put the tenant, not the legislation, in charge of a legal deduction.
  if (configurable && isStatutoryComponent(self, target.kind)) return { ok: false, code: 'STATUTORY_FORBIDDEN' };

  const byCode = new Map<string, PayRuleCatalogNode>();
  for (const n of catalog) byCode.set(normCode(n.code), n);

  for (const dep of deps) {
    if (dep === self) return { ok: false, code: 'SELF_REFERENCE' };
    const node = byCode.get(dep);
    if (!node || node.archived) return { ok: false, code: 'UNKNOWN_COMPONENT' };
    // Reading a statutory line into pay is the same violation wearing a different hat.
    if (isStatutoryComponent(dep, node.kind)) return { ok: false, code: 'STATUTORY_FORBIDDEN' };
  }

  // Cycles: plan the graph WITH the pending change substituted in.
  const merged: PayRuleCatalogNode[] = catalog.map((n) =>
    normCode(n.code) === self ? { ...n, code: self, rule: target.rule } : n,
  );
  if (!byCode.has(self)) merged.push({ code: self, rule: target.rule, kind: target.kind });
  const plan = planResolutionOrder(merged);
  if (!plan.ok) return { ok: false, code: plan.code };
  return { ok: true };
}

/** The runtime values a rule may reference. `basic` = the employee's resolved BASIC component amount;
 *  `daysWorked` = factor × days-in-month (already reflects proration); `hours` = attendance worked hours.
 *  `components` (61bf109d) = the already-resolved amount of every pay item that ranks BELOW the one being
 *  resolved, keyed by upper-case pay code. It is OPTIONAL so every pre-existing caller compiles and behaves
 *  identically; resolvePayComponentSet is what populates it, in recorded resolution order. A code that is
 *  absent reads as 0 — the employee simply does not have that pay item this period, which is a figure, not
 *  an error, and must never abort a batch. */
export type PayRuleScope = {
  basic: number;
  daysWorked: number;
  hours: number;
  components?: Readonly<Record<string, number>>;
  /** 2da9937a — the total of this employee's fixed allowances (the `fixed_allowances` operand). DERIVED,
   *  never supplied: resolvePayComponentSet computes it per resolution rank from the set it is resolving and
   *  OVERWRITES whatever the caller passed, because the sum is a property of the set, not of the caller.
   *  (This is the opposite of `components`, where a caller-pinned BASIC deliberately wins.) It is a plain
   *  field only so resolvePayRule can be called on ONE rule in isolation — which is what a unit test and the
   *  AI validator do. Absent ⇒ 0, like an absent component code. */
  fixedAllowances?: number;
  /**
   * e318eaec — CALENDAR days in the payroll month: 31 in August, 30 in September, 28 in February. The kernel
   * already has this as `dim = daysInMonth(year, month1)` and passes it here.
   *
   * IT IS NOT `daysWorked`, AND CONFLATING THE TWO IS THE MISTAKE THIS FIELD EXISTS TO PREVENT.
   * `daysWorked` is `factor × dim` — the TENURE-PRORATED count, smaller than the month for a mid-month
   * joiner. `calendarDays` is the month's own length, the same for everybody. A formula that means
   * "monthly amount ÷ the length of this month × days actually worked" needs BOTH, and before this it could
   * only reach the prorated one. Absent ⇒ 0, like every other optional scope input.
   */
  calendarDays?: number;
  /**
   * e318eaec — basic salary AFTER the EA-1955 joiner/leaver tenure factor the kernel already applies
   * (`basicGross = round2(basic × factor)`). Exposed so a formula can USE the system's proration instead of
   * rebuilding it out of days and divisors, which is the only way the formula and the payroll run can be
   * guaranteed to agree. Absent ⇒ 0.
   */
  proratedBasic?: number;
};

/** Read one formula operand against the scope. The ONLY place a named input becomes a number. */
function readOperand(op: FormulaOperand, scope: PayRuleScope): number {
  switch (op.ref) {
    case 'number':
      return op.value;
    case 'basic':
      return scope.basic;
    case 'days':
      return scope.daysWorked;
    case 'hours':
      return scope.hours;
    case 'fixed_allowances':
      // Absent reads as 0 for the same reason an absent component code does: the employee simply has no
      // fixed allowances this period. A figure, not an error — it must never abort a batch.
      return scope.fixedAllowances ?? 0;
    // e318eaec — supplied by every caller that has them (the kernel, the admin preview, the one-off
    // transaction path, the back-pay recompute). Absent ⇒ 0, and 0 as a DIVISOR is caught by the
    // zero-divisor guard below, so a caller that forgets one pays 0 and says so rather than paying a wrong
    // figure quietly.
    case 'calendar_days':
      return scope.calendarDays ?? 0;
    case 'prorated_basic':
      return scope.proratedBasic ?? 0;
    case 'component':
      return scope.components?.[normCode(op.code)] ?? 0;
    default: {
      const _never: never = op;
      void _never;
      return NaN;
    }
  }
}

/**
 * 2da9937a — ONE step of ONE formula divided by a live input that turned out to be zero (or non-finite) for
 * THIS employee, so the whole component paid 0 instead. Reported, never thrown: the contract is that the run
 * completes and the employee is surfaced for review, which is only true if this is data rather than an
 * exception. `step` is the 1-based position of the dividing step (the seed operand cannot divide, so 0 is
 * never used); `divisor` is which named input was zero, so the admin is told WHY rather than just "0".
 */
export type PayRuleZeroDivisorNotice = { divisor: FormulaOperandRef; step: number };
/** The same notice tagged with the pay code, as resolvePayComponentSet reports it. */
export type PayRuleComponentNotice = PayRuleZeroDivisorNotice & { code: string };

/**
 * e318eaec — ONE step of a formula fold, as it happened, so a screen can SHOW THE WORKING:
 * "5,000.00 + 400.00 = 5,400.00", then "÷ 26 = 207.6923", and so on.
 *
 * IT IS EMITTED BY THE FOLD ITSELF, not reconstructed afterwards, and that is the entire design decision
 * here. A second walk over the terms to "explain" what the first walk computed is a parallel implementation
 * of the evaluator: it would agree on the day it was written and drift silently, and the drift would be a
 * screen telling an administrator their payslip was reached a way it was not. The trace is therefore an
 * optional out-channel on resolvePayRule, exactly like `notices` — the same fold, reported.
 */
export type PayRuleTraceStep = {
  /** `null` for the seed operand (there is no operator before the first value). */
  op: FormulaOp | null;
  operand: FormulaOperand;
  /** What the operand resolved to for this employee. */
  value: number;
  /** The running total AFTER this step. The last one is the fold's result, before the final clamp. */
  running: number;
};

/**
 * Resolve a rule to a single ringgit number. `fixed` (or null) returns the caller-supplied `amount` — the
 * kernel passes the stored component amount in, so a fixed rule is byte-identical to the legacy path.
 * Guards Number.isFinite on the result (PayRuleEvalError on a corrupted value).
 *
 * 2da9937a — `notices` is the OPTIONAL out-channel for a live divisor that resolved to zero. Optional
 * because every pre-existing caller must keep compiling and behaving identically; a caller that does not
 * pass it still gets the safe figure (0), it simply does not learn why. Passing an array is how a caller
 * opts into telling the admin.
 */
export function resolvePayRule(
  rule: PayRule | null,
  scope: PayRuleScope,
  amount: number,
  notices?: PayRuleZeroDivisorNotice[],
  /** e318eaec — OPTIONAL out-channel for the step-by-step working (see PayRuleTraceStep). Same shape and
   *  same reason as `notices`: passing an array is how a caller opts into being told HOW, and every
   *  pre-existing caller keeps compiling and behaving identically. Only `formula` has steps to report. */
  trace?: PayRuleTraceStep[],
): number {
  let out: number;
  if (rule == null) {
    out = amount;
  } else {
    switch (rule.kind) {
      case 'fixed':
        out = amount;
        break;
      case 'percent_of': {
        // 61bf109d — `base:'component'` reads the referenced item's already-resolved amount (guaranteed
        // present by the recorded resolution order); `base:'basic'` is unchanged.
        const base = rule.base === 'component' ? (scope.components?.[normCode(rule.componentCode)] ?? 0) : scope.basic;
        out = base * (rule.pct / 100);
        break;
      }
      case 'per_day':
        out = rule.rate * scope.daysWorked;
        break;
      case 'per_hour':
        out = rule.rate * scope.hours;
        break;
      case 'flat_capped':
        out = Math.min(rule.value, rule.cap);
        break;
      case 'qty_rate':
        out = rule.qty * rule.rate;
        break;
      case 'formula': {
        // Left-to-right fold — no operator precedence, because the admin builds the steps in the order they
        // are applied and a hidden precedence rule is exactly the kind of surprise that shows up on a
        // payslip.
        //
        // 2da9937a — THE ZERO-DIVISOR GUARD. readOperand above is the single place a named input becomes a
        // number, so this is the single place one of those numbers can be a divisor, and the guard sits
        // here rather than at each `/` call site. A literal zero cannot reach it (validatePayRule refuses
        // that at save time), so a zero here is always a LIVE value that is zero for THIS employee — a
        // zero-hours month, an employee with no fixed allowances. The contract is then: stop, pay 0 for
        // this component, and report which input it was. Never Infinity, never NaN, never a thrown batch.
        let acc = readOperand(rule.start, scope);
        // e318eaec — the trace is written FROM the fold, one push per step actually taken. A step that the
        // zero-divisor guard stops is not pushed, so the working ends exactly where the arithmetic did and
        // the panel's last line is the last thing that really happened.
        trace?.push({ op: null, operand: rule.start, value: acc, running: acc });
        let blocked: PayRuleZeroDivisorNotice | null = null;
        for (const [i, t] of rule.terms.entries()) {
          const v = readOperand(t.operand, scope);
          if (t.op === '/') {
            if (!Number.isFinite(v) || v === 0) {
              blocked = { divisor: t.operand.ref, step: i + 1 };
              break;
            }
            acc = acc / v;
          } else if (t.op === '+') acc += v;
          else if (t.op === '-') acc -= v;
          else if (t.op === '*') acc *= v;
          else acc = NaN;
          trace?.push({ op: t.op, operand: t.operand, value: v, running: acc });
        }
        if (blocked) {
          notices?.push(blocked);
          out = 0;
          break;
        }
        // The ONLY kind that can go negative (it has a `-`). Clamp so a resolved component amount can never
        // corrupt the EPF/SOCSO/PCB base — see the sign/clamp contract in the file header.
        out = Number.isFinite(acc) ? Math.max(0, acc) : acc;
        break;
      }
      default: {
        const _never: never = rule;
        void _never;
        out = NaN;
      }
    }
  }
  if (!Number.isFinite(out)) throw new PayRuleEvalError();
  return out;
}

/** One pay-item instance to resolve: the catalog rule + rank, plus the stored amount a `fixed` rule returns.
 *  The same CODE may appear more than once (a recurring value and a one-off batch value), which is why the
 *  result is positional. */
export type ResolvablePayComponent = {
  code: string;
  rule: PayRule | null;
  amount: number;
  /** pay_component.resolution_order — the rank recorded at save time (migration 0330). */
  resolutionOrder?: number | null;
  /** 2da9937a — pay_component.kind, needed to decide whether this item counts towards the
   *  `fixed_allowances` aggregate (isFixedAllowanceComponent). OPTIONAL so every pre-existing caller
   *  compiles unchanged; absent ⇒ the item is not an allowance ⇒ it contributes nothing to the sum. */
  kind?: string | null;
  /** 2da9937a, r168 verification — BOTH of these exclude a row from the `fixed_allowances` aggregate, and
   *  the aggregate was WRONG without them (measured: a RM2,000 one-off multiplied a RM500 base to RM2,500).
   *   • nonPayable — a BIK allowance. The kernel records it and `continue`s WITHOUT PAYING it, so totalling
   *     it into a figure the payroll then pays is money that does not exist.
   *   • oneOff — a BATCH row (an individual transaction, or a synthetic TXN_EARNING). These arrive with
   *     `rule: null` by construction, which is precisely the clause the aggregate's acyclicity leans on, so
   *     they satisfied every other test. They are also invisible to previewPayRule, which builds its set
   *     from employment_pay_component alone — so counting them made the preview and the run disagree.
   *  Both OPTIONAL: absent ⇒ false ⇒ every pre-existing caller behaves exactly as before. */
  nonPayable?: boolean;
  oneOff?: boolean;
};

/**
 * THE one evaluator. Resolve a whole set of pay items in RECORDED resolution order, so a rule that reads
 * another pay item sees that item's final figure rather than whatever the query happened to return first.
 * Returns a number per input, positionally — callers keep their own association with the row.
 *
 * Both the payroll run and the admin preview call this function; there is no parallel implementation, which
 * is what makes the preview trustworthy. It touches no data and performs no I/O, so the preview's dry-run
 * path is the same code as the run by construction, not by careful maintenance.
 *
 * Ordering: items are grouped by pay code and the groups processed in ascending recorded rank, tie-broken by
 * code then by input position — fully deterministic. Every instance of a code is resolved BEFORE that code's
 * total is published to the scope, so a second instance of the same code can never observe a partial sum.
 *
 * AUTHORITATIVE PRE-SEEDS: any code the CALLER already put in `scope.components` keeps that value — resolving
 * the rows never overwrites it. This exists for BASIC. The kernel treats the BASIC *component* as inert
 * (feedback 64fb5e48: the Personnel compensation record is the only source of basic pay, and a stale BASIC
 * component must never drive money), so the kernel seeds the authoritative figure here and a rule that reads
 * `component:'BASIC'` gets the same number the `basic` operand would, not the stale row.
 */
export function resolvePayComponentSet(
  comps: readonly ResolvablePayComponent[],
  scope: PayRuleScope,
  notices?: PayRuleComponentNotice[],
  /**
   * e318eaec — capture the step-by-step working for ONE input position, into `steps`.
   *
   * Scoped to a single index on purpose. The admin preview asks "how was THIS item's figure reached?" about
   * the item under edit; tracing the whole set would allocate a walk per pay item on every payroll run for
   * a screen that shows one. `index` is a position in `comps`, the same coordinate the returned array uses.
   */
  traceFor?: { index: number; steps: PayRuleTraceStep[] },
): number[] {
  const out = new Array<number>(comps.length).fill(0);
  const components: Record<string, number> = { ...(scope.components ?? {}) };
  const pinned = new Set(Object.keys(components));
  // `fixedAllowances` is DERIVED here and overwrites any caller value — see the PayRuleScope comment.
  const scoped: PayRuleScope = { ...scope, components, fixedAllowances: 0 };

  // Group input positions by pay code, remembering each group's rank and first appearance.
  type Group = { rank: number; first: number; idx: number[]; fixedAllowance: boolean; readsAggregate: boolean };
  const groups = new Map<string, Group>();
  comps.forEach((c, i) => {
    const code = normCode(c.code);
    const g = groups.get(code);
    const rank = Number.isFinite(c.resolutionOrder) ? Number(c.resolutionOrder) : 0;
    // Every instance of a code shares the catalog's kind and rule, so these are properties of the GROUP.
    // Folded conservatively anyway (all instances must agree to count as fixed; any instance reading the
    // aggregate makes the group read it) so a caller assembling a set by hand cannot half-satisfy either.
    // A caller-PINNED code is authoritative from elsewhere and inert as a component (BASIC — see
    // AUTHORITATIVE PRE-SEEDS). Its row's amount is not money this engine pays, so it is not money the
    // aggregate may total. Belt and braces with isFixedAllowanceComponent's own BASIC clause: this one
    // holds for any future pinned code, that one holds when there is no caller to pin anything.
    // r168 verification — nonPayable/oneOff rows are NOT money this run pays out of the catalog, so
    // they are not money the aggregate may total. See ResolvablePayComponent for the measurement.
    const fa =
      !pinned.has(code) && !c.nonPayable && !c.oneOff && isFixedAllowanceComponent(code, c.kind, c.rule);
    const ra = payRuleReadsFixedAllowanceTotal(c.rule);
    if (g) {
      g.idx.push(i);
      g.rank = Math.max(g.rank, rank);
      g.fixedAllowance = g.fixedAllowance && fa;
      g.readsAggregate = g.readsAggregate || ra;
    } else {
      groups.set(code, { rank, first: i, idx: [i], fixedAllowance: fa, readsAggregate: ra });
    }
  });

  // 2da9937a — THE AGGREGATE'S ORDERING GUARANTEE LIVES HERE, NOT IN THE STORED RANK.
  //
  // planResolutionOrder already ranks an aggregate-reading item above every fixed allowance, and that rank
  // is persisted. But the persisted number can legitimately be stale — a row saved before this change, a
  // one-off BATCH component (which carries no catalog rank at all and arrives as 0), a catalog edited by a
  // path that did not re-rank. If the aggregate trusted the stored rank, a stale 0 would not throw or warn:
  // it would quietly sum nothing and pay a wrong figure. So the evaluator recomputes the one guarantee the
  // aggregate actually depends on — read strictly BELOW me — from the set in hand. Every other item keeps
  // its recorded rank exactly as before, which is what keeps a legacy catalog byte-identical.
  const topFixedAllowanceRank = Math.max(-1, ...[...groups.values()].filter((g) => g.fixedAllowance).map((g) => g.rank));
  const effectiveRank = (g: Group): number =>
    g.readsAggregate && !g.fixedAllowance ? Math.max(g.rank, topFixedAllowanceRank + 1) : g.rank;

  const ordered = [...groups.entries()]
    .map(([code, g]) => ({ code, g, rank: effectiveRank(g) }))
    .sort((a, b) => a.rank - b.rank || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || a.g.first - b.g.first);

  // STRICTLY BELOW, enforced by rank TIER rather than by arrival order: `below` only takes in a tier's
  // fixed allowances once the walk has left that tier. Two items at the same rank therefore cannot see each
  // other, so the sum an item reads never depends on tie-breaking — which is the property that stops two
  // runs of the same payroll from disagreeing.
  let below = 0;
  let atCurrentRank = 0;
  let currentRank: number | null = null;
  const local: PayRuleZeroDivisorNotice[] | undefined = notices ? [] : undefined;

  for (const { code, g, rank } of ordered) {
    if (currentRank === null || rank !== currentRank) {
      below += atCurrentRank;
      atCurrentRank = 0;
      currentRank = rank;
    }
    scoped.fixedAllowances = below;
    let total = 0;
    for (const i of g.idx) {
      const c = comps[i];
      // A null / `fixed` rule short-circuits to the stored amount — the exact expression the kernel used
      // before 61bf109d, so an all-fixed catalog is untouched by the ordering machinery.
      const stepsOut = traceFor && traceFor.index === i ? traceFor.steps : undefined;
      const v = c.rule && c.rule.kind !== 'fixed' ? resolvePayRule(c.rule, scoped, c.amount, local, stepsOut) : c.amount;
      if (local?.length) {
        for (const n of local) notices!.push({ code, ...n });
        local.length = 0;
      }
      out[i] = v;
      total += v;
    }
    if (g.fixedAllowance) atCurrentRank += total;
    // A caller-pinned code (BASIC) keeps the authoritative figure — see AUTHORITATIVE PRE-SEEDS above.
    if (!pinned.has(code)) components[code] = total;
  }
  return out;
}

// ── e318eaec — THE READABLE FORMULA LINE ────────────────────────────────────────────────────────────
//
// ⚠️ READ THIS BEFORE CHANGING ANYTHING BELOW. THIS IS A RENDERER, NOT A PARSER, AND THAT IS THE WHOLE
// POINT OF IT.
//
// The board item asks for two things that look like one: a formula shown "in a readable mathematical
// format" with brackets, AND "normal mathematical operator precedence". The first is a legibility problem.
// The second would silently re-price live pay, and it is refused.
//
// The reporter's own OT1_5 is stored as a fold:
//     basic  +fixed_allowances  /26  /8  *1.5  *hours
// Folded left-to-right — which is what resolvePayRule does, and has always done — that IS
//     (basic + fixed_allowances) / 26 / 8 × 1.5 × hours
// and it is the figure on their payslips (RM584.13 for 15 hours on a RM5,000 basic with RM400 of fixed
// allowances). Read with school precedence, the SAME stored rule would mean
//     basic + (fixed_allowances / 26 / 8 × 1.5 × hours)
// i.e. "basic salary plus a fraction of the allowances" — a different number, on overtime that has already
// been paid. So the evaluation order does not change. Instead this function emits the brackets that
// DESCRIBE the order the fold already runs in, which is exactly the string the reporter asked to see.
//
// The bracketing is minimal and mechanical: the running expression carries the precedence of the loosest
// operator currently at its top level, and it is parenthesised the moment a tighter operator would
// otherwise steal its right-hand end. That is precisely the condition under which "read normally" and
// "folded left-to-right" would disagree, so the emitted string is guaranteed to evaluate — under ordinary
// precedence, by any reader or any reference parser — to the number resolvePayRule computes.
// test/pay-rule-format.test.ts asserts that round trip, including on the live OT1_5, and it is the guard
// that makes this claim checkable rather than merely stated.

/** Conventional (school) precedence — used ONLY to decide where a bracket has to be drawn. Nothing in the
 *  evaluator reads it, and nothing may start to. */
const FORMULA_OP_PRECEDENCE: Record<FormulaOp, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
/** The symbols the line is drawn with. Mathematical notation, not words, so it needs no translation. */
const FORMULA_OP_SYMBOL: Record<FormulaOp, string> = { '+': '+', '-': '-', '*': '×', '/': '/' };

/** Everything the renderer needs from OUTSIDE the rule value, injected so this stays pure and
 *  locale-agnostic: the client builder passes next-intl's `t`, the server preview passes getTranslations',
 *  and a test passes stubs. One function, two call sites, so the live line in the builder and the line in
 *  the preview panel cannot describe the same formula two different ways. */
export type PayRuleFormatLabels = {
  /** `payRule.operand_<ref>` — the exact strings the builder's operand dropdown shows. */
  operand: (ref: FormulaOperandRef) => string;
  /** Display name for a referenced pay code; null/undefined ⇒ the CODE is printed instead. */
  payItem?: (code: string) => string | null | undefined;
  /** Locale number formatting for a literal. Defaults to `String(n)` so a test need not stub it. */
  number?: (value: number) => string;
};

/**
 * One operand as it appears on the formula line. Exported because the preview panel labels each step of the
 * working with the same string the line uses.
 *
 * A NAMED NUMBER reads one of two ways, and the rule is not cosmetic:
 *   • the label already contains the number ("Rate 1.5" on a value of 1.5) ⇒ `[Rate 1.5]`, the shape the
 *     ticket asks for. Printing "1.5 (Rate 1.5)" would say the same thing twice.
 *   • otherwise ⇒ `26 (Working days)`. THE VALUE IS ALWAYS SHOWN IN THIS CASE, deliberately: a label is
 *     free text, so someone can name a number "Rate 1.5" and later change its value to 2. Suppressing the
 *     figure whenever a label merely looks rate-ish would print a confident lie on a payroll screen; keying
 *     it off "does the label actually contain this value" makes the display self-correcting instead.
 */
export function formatPayRuleOperand(operand: FormulaOperand, labels: PayRuleFormatLabels): string {
  const base = labels.operand(operand.ref);
  switch (operand.ref) {
    case 'number': {
      // A half-typed number field is NaN. Fall back to the operand's own name rather than printing "NaN"
      // at the admin — the live validator is already telling them the box is empty.
      if (!Number.isFinite(operand.value)) return base;
      const value = (labels.number ?? ((n: number) => String(n)))(operand.value);
      const label = typeof operand.label === 'string' ? operand.label.trim() : '';
      if (!label) return value;
      return label.includes(value) || label.includes(String(operand.value)) ? `[${label}]` : `${value} (${label})`;
    }
    case 'component': {
      const code = normCode(operand.code);
      if (!code) return base;
      // The NAME reads better in a maths line and the builder row directly below shows "CODE — Name" in its
      // dropdown, so the code is never more than a glance away. Unknown/archived ⇒ the code itself.
      return labels.payItem?.(code) || code;
    }
    case 'basic':
    case 'prorated_basic':
    case 'days':
    case 'calendar_days':
    case 'hours':
    case 'fixed_allowances':
      return base;
    default: {
      // Exhaustiveness guard — a new ref without a branch is a compile error here, which is how a widened
      // union is stopped from silently rendering as an empty gap in the middle of a formula.
      const _never: never = operand;
      void _never;
      return '';
    }
  }
}

/**
 * The stored fold as an explicitly bracketed infix line, e.g.
 * `(Basic salary + All fixed allowances) / 26 (Working days) / 8 (Working hours) × [Rate 1.5] × Hours worked`.
 *
 * `null` for any rule that is not a `formula` — the other six kinds are fully described by their own Input
 * Type label and have nothing to draw.
 */
export function formatPayRule(rule: PayRule | null | undefined, labels: PayRuleFormatLabels): string | null {
  if (!rule || rule.kind !== 'formula') return null;
  let expr = formatPayRuleOperand(rule.start, labels);
  // How loosely the current expression binds at its top level. An atom binds tighter than any operator.
  let bound = Number.POSITIVE_INFINITY;
  for (const term of Array.isArray(rule.terms) ? rule.terms : []) {
    // Defensive on a corrupted JSONB value: an unknown operator is skipped rather than printed raw (the
    // validator refuses such a rule at save time, so this is only reachable via a hand-edited row).
    if (!term || !(term.op in FORMULA_OP_PRECEDENCE)) continue;
    const prec = FORMULA_OP_PRECEDENCE[term.op];
    if (prec > bound) {
      // A tighter operator is about to bind to the tail of a looser expression — the one case where reading
      // the line normally would NOT reproduce the fold. Bracket, and the result is an atom again.
      expr = `(${expr})`;
      bound = Number.POSITIVE_INFINITY;
    }
    expr = `${expr} ${FORMULA_OP_SYMBOL[term.op]} ${formatPayRuleOperand(term.operand, labels)}`;
    bound = Math.min(bound, prec);
  }
  return expr;
}
