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
 * keeps the compat golden byte-identical). There is NO division by a runtime scope value anywhere in the
 * union — `/` is legal only with a non-zero literal divisor, enforced at save time — so a zero-days /
 * zero-hours employee can never abort a payroll batch. The finite-guard below is defensive only (a corrupted
 * JSONB value), fail-closed by contract.
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
import type { FormulaOperand, FormulaTerm, PayRule } from '../db/schema';

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
 *  same list the validator enforces — there is exactly one definition of "what a formula may reference". */
export const FORMULA_OPERAND_REFS = ['number', 'basic', 'days', 'hours', 'component'] as const;
export type FormulaOperandRef = (typeof FORMULA_OPERAND_REFS)[number];
export const FORMULA_OPS = ['+', '-', '*', '/'] as const;

/** A formula is a fold, not a tree, so its size is trivially bounded. Eight steps is far past any real pay
 *  rule and keeps the stored JSONB small enough to stay readable in an audit. */
export const FORMULA_MAX_TERMS = 8;

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
      return inMoney(op.value) ? { ok: true } : { ok: false, code: 'OUT_OF_RANGE' };
    case 'basic':
    case 'days':
    case 'hours':
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
      // 61bf109d — the restricted formula. Every operand must be in the FIXED, NAMED set, and `/` may only
      // divide by a non-zero LITERAL: dividing by a runtime value (basic / days / hours / another item)
      // would let a zero-hours employee produce Infinity and abort the batch, so it is refused outright.
      const seed = validateOperand(rule.start);
      if (!seed.ok) return seed;
      if (!Array.isArray(rule.terms)) return { ok: false, code: 'BAD_KIND' };
      if (rule.terms.length > FORMULA_MAX_TERMS) return { ok: false, code: 'OUT_OF_RANGE' };
      for (const t of rule.terms as FormulaTerm[]) {
        if (!t || typeof t !== 'object' || !FORMULA_OPS.includes(t.op)) return { ok: false, code: 'BAD_KIND' };
        const v = validateOperand(t.operand);
        if (!v.ok) return v;
        if (t.op === '/' && !(t.operand.ref === 'number' && inMoney(t.operand.value) && t.operand.value !== 0)) {
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
    for (const dep of payRuleDependencies(node.rule).sort()) {
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
 * Resolve a rule to a single ringgit number. `fixed` (or null) returns the caller-supplied `amount` — the
 * kernel passes the stored component amount in, so a fixed rule is byte-identical to the legacy path. The
 * only division is by a validated non-zero literal. Guards Number.isFinite on the result (PayRuleEvalError
 * on a corrupted value).
 */
export function resolvePayRule(rule: PayRule | null, scope: PayRuleScope, amount: number): number {
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
        // payslip. Division is by a validated non-zero literal only, so this loop cannot produce Infinity.
        let acc = readOperand(rule.start, scope);
        for (const t of rule.terms) {
          const v = readOperand(t.operand, scope);
          if (t.op === '+') acc += v;
          else if (t.op === '-') acc -= v;
          else if (t.op === '*') acc *= v;
          else if (t.op === '/') acc = v === 0 ? NaN : acc / v;
          else acc = NaN;
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
): number[] {
  const out = new Array<number>(comps.length).fill(0);
  const components: Record<string, number> = { ...(scope.components ?? {}) };
  const pinned = new Set(Object.keys(components));
  const scoped: PayRuleScope = { ...scope, components };

  // Group input positions by pay code, remembering each group's rank and first appearance.
  const groups = new Map<string, { rank: number; first: number; idx: number[] }>();
  comps.forEach((c, i) => {
    const code = normCode(c.code);
    const g = groups.get(code);
    const rank = Number.isFinite(c.resolutionOrder) ? Number(c.resolutionOrder) : 0;
    if (g) {
      g.idx.push(i);
      g.rank = Math.max(g.rank, rank);
    } else {
      groups.set(code, { rank, first: i, idx: [i] });
    }
  });

  const ordered = [...groups.entries()].sort(
    (a, b) => a[1].rank - b[1].rank || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[1].first - b[1].first,
  );

  for (const [code, g] of ordered) {
    let total = 0;
    for (const i of g.idx) {
      const c = comps[i];
      // A null / `fixed` rule short-circuits to the stored amount — the exact expression the kernel used
      // before 61bf109d, so an all-fixed catalog is untouched by the ordering machinery.
      const v = c.rule && c.rule.kind !== 'fixed' ? resolvePayRule(c.rule, scoped, c.amount) : c.amount;
      out[i] = v;
      total += v;
    }
    // A caller-pinned code (BASIC) keeps the authoritative figure — see AUTHORITATIVE PRE-SEEDS above.
    if (!pinned.has(code)) components[code] = total;
  }
  return out;
}
