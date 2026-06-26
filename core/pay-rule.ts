/**
 * Pure pay-rule resolver + validator (Payroll Setup — configurable pay-rule engine). No DB, no network, no
 * string parsing: a `switch` over a closed discriminated union, mirroring core/payroll.ts's ShiftDifferential
 * resolver. The kernel, the service write-guard, the AI validator, and the admin UI all call the SAME pure
 * functions here, so "valid in the UI" === "accepted by the kernel".
 *
 * Sign/clamp contract: NONE of the v1 kinds can structurally go negative (there is no `a - b` kind, and
 * flat_capped is a min of two non-negatives), so a resolved earning is always >= 0 — it can never corrupt the
 * EPF/SOCSO/PCB base. There is NO division by a runtime scope value anywhere in the union, so a zero-days /
 * zero-hours employee can never abort a payroll batch. The finite-guard below is defensive only (a corrupted
 * JSONB value), fail-closed by contract.
 */
import type { PayRule } from '../db/schema';

export { type PayRule } from '../db/schema';

/** Stable validation error codes — the UI maps these to localised payRule.errors.* messages (never raw
 *  English from this library reaches a localised screen). */
export type PayRuleErrorCode = 'BAD_KIND' | 'OUT_OF_RANGE' | 'PRORATION_CONFLICT';

export type PayRuleValidation = { ok: true } | { ok: false; code: PayRuleErrorCode };

/** Thrown by resolvePayRule when a corrupted JSONB value yields a non-finite result (defensive; unreachable
 *  with a validated rule). Fail-closed: the kernel surfaces it rather than writing a wrong payslip. */
export class PayRuleEvalError extends Error {
  constructor(message = 'pay-rule resolved to a non-finite value') {
    super(message);
    this.name = 'PayRuleEvalError';
  }
}

export const PAY_RULE_KINDS = ['fixed', 'percent_of', 'per_day', 'per_hour', 'flat_capped'] as const;
export type PayRuleKind = (typeof PAY_RULE_KINDS)[number];

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
// Generous-but-sane bounds: a per-day/per-hour rate or a flat value/cap; a percentage 0..1000 (>100% is a
// legitimate uplift, e.g. 150% of basic). All non-negative — see the sign/clamp contract above.
const inMoney = (n: unknown): n is number => finite(n) && n >= 0 && n <= 100_000_000;
const inPct = (n: unknown): n is number => finite(n) && n >= 0 && n <= 1000;

/**
 * Structurally validate a rule against a component's proration flag. Returns a stable error CODE (mapped to
 * i18n in the UI), never a free-text string. `componentProrates` is needed because a per_day / per_hour rule
 * encodes its OWN period scaling, so it must NOT also ride the kernel's `prorates` multiplier (that would
 * double-prorate a mid-period joiner) — the two are mutually exclusive by construction.
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
      if (rule.base !== 'basic') return { ok: false, code: 'BAD_KIND' };
      return inPct(rule.pct) ? { ok: true } : { ok: false, code: 'OUT_OF_RANGE' };
    case 'per_day':
    case 'per_hour':
      if (!inMoney(rule.rate)) return { ok: false, code: 'OUT_OF_RANGE' };
      // A per-period rule already reflects the partial period via days_worked / hours — the component must
      // NOT also prorate, or a mid-period joiner is scaled twice.
      if (componentProrates) return { ok: false, code: 'PRORATION_CONFLICT' };
      return { ok: true };
    case 'flat_capped':
      if (!inMoney(rule.value) || !inMoney(rule.cap)) return { ok: false, code: 'OUT_OF_RANGE' };
      return { ok: true };
    default: {
      // Exhaustiveness guard — a new kind without a branch is a compile error.
      const _never: never = rule;
      void _never;
      return { ok: false, code: 'BAD_KIND' };
    }
  }
}

/** The runtime values a rule may reference. `basic` = the employee's resolved BASIC component amount;
 *  `daysWorked` = factor × days-in-month (already reflects proration); `hours` = attendance worked hours. */
export type PayRuleScope = { basic: number; daysWorked: number; hours: number };

/**
 * Resolve a rule to a single ringgit number. `fixed` (or null) returns the caller-supplied `amount` — the
 * kernel passes the stored component amount in, so a fixed rule is byte-identical to the legacy path. No
 * division anywhere. Guards Number.isFinite on the result (PayRuleEvalError on a corrupted value).
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
      case 'percent_of':
        out = scope.basic * (rule.pct / 100);
        break;
      case 'per_day':
        out = rule.rate * scope.daysWorked;
        break;
      case 'per_hour':
        out = rule.rate * scope.hours;
        break;
      case 'flat_capped':
        out = Math.min(rule.value, rule.cap);
        break;
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
