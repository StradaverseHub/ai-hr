/**
 * 61bf109d — a formula, in plain words.
 *
 * WHY THIS FILE EXISTS. Input Type and the Formula builder were built and deployed (r83) but the Pay Items
 * LIST gives no hint that either is configurable: it shows a derived, read-only Input Type value and says
 * nothing at all about a formula, so "Formula" in that column tells an administrator that an item is
 * calculated but never HOW. This module turns the stored formula VALUE into a sentence the list can print.
 *
 * DERIVED, NOT RE-DESCRIBED. Every branch below is driven by the exported `FormulaOperand` / `FormulaOp` /
 * `FormulaTerm` union from core/pay-rule.ts, with an exhaustiveness guard on the operand switch — adding a
 * ref to the union is a COMPILE error here, not a silently-missing word. The wording itself is not invented
 * either: it reads through the SAME `payRule.operand_*` / `payRule.op_*` catalog entries the builder's own
 * dropdowns render, so the list and the editor cannot describe one formula two different ways in any locale.
 *
 * PRESENTATION ONLY. Nothing here evaluates, validates or orders anything: no arithmetic, no scope, no
 * catalog lookup. The evaluator (resolvePayRule / resolvePayComponentSet), the validator and the resolution
 * planner stay untouched in core/pay-rule.ts. And there is still NO expression string anywhere — this
 * function goes value → words, one way only. It is not a printer for a parser, because there is no parser.
 */
import type { FormulaOperand, FormulaOp, PayRule } from '@/core/pay-rule';

/**
 * Everything the formatter needs from OUTSIDE the rule value. All of it is injected so this stays pure and
 * locale-agnostic: callers pass next-intl's `t`, and a test passes stubs and reads the structure.
 */
export type PayRuleWordsOptions = {
  /** `payRule.operand_<ref>` — the exact strings the builder's operand dropdown shows. */
  operandLabel: (ref: FormulaOperand['ref']) => string;
  /** `payRule.op_<+|-|*|/>` — "add" / "subtract" / "multiply by" / "divide by", as in the builder. */
  opLabel: (op: FormulaOp) => string;
  /** `payRule.formulaStart` — "Start with". Opens the sentence, so it reads as steps rather than a list. */
  startLabel: string;
  /**
   * Display name for a referenced pay code, or null/undefined if the caller cannot resolve it (an archived
   * or deleted item). The CODE is always shown; the name, when known, is appended in brackets — the code is
   * what the admin must search for, the name is what makes the sentence readable.
   */
  payItemLabel?: (code: string) => string | null | undefined;
  /** Locale number formatting for a literal operand. Defaults to `String(n)` so tests need not stub it. */
  formatNumber?: (value: number) => string;
};

const OP_ORDER: Record<FormulaOp, true> = { '+': true, '-': true, '*': true, '/': true };

/** One operand as words. Exported for the tests; the sentence builder below is the caller UIs use. */
export function formulaOperandInWords(operand: FormulaOperand, o: PayRuleWordsOptions): string {
  const base = o.operandLabel(operand.ref);
  switch (operand.ref) {
    case 'number': {
      const fmt = o.formatNumber ?? ((n: number) => String(n));
      // A literal reads as the number itself — "A fixed amount (250)" would be noise on a list row.
      return Number.isFinite(operand.value) ? fmt(operand.value) : base;
    }
    case 'component': {
      const code = (operand.code ?? '').trim().toUpperCase();
      if (!code) return base;
      const name = o.payItemLabel?.(code);
      return name ? `${code} (${name})` : code;
    }
    case 'basic':
    case 'days':
    case 'hours':
      return base;
    default: {
      // Exhaustiveness guard — a new FormulaOperand ref without a branch is a compile error, which is the
      // whole point of deriving this from the union instead of hand-writing a second description.
      const _never: never = operand;
      void _never;
      return '';
    }
  }
}

/**
 * The whole rule as one sentence, or `null` when the rule is not a formula.
 *
 * Returning null rather than describing every kind is deliberate: the other six kinds already have a
 * self-explanatory Input Type label ("A percentage of another amount", "A quantity multiplied by a rate"),
 * and only `formula` carries detail the list cannot otherwise show. Widening this later means adding
 * branches here, not changing callers.
 *
 * The steps are joined with ", " in stored order because the evaluator folds them left-to-right with NO
 * operator precedence (core/pay-rule.ts resolvePayRule) — printing them as an infix expression would imply
 * a precedence the engine does not apply, and that mismatch is exactly what a payslip surprise is made of.
 */
export function payRuleInWords(rule: PayRule | null | undefined, o: PayRuleWordsOptions): string | null {
  if (!rule || rule.kind !== 'formula') return null;
  const parts = [`${o.startLabel} ${formulaOperandInWords(rule.start, o)}`.trim()];
  for (const term of Array.isArray(rule.terms) ? rule.terms : []) {
    // Defensive on a corrupted JSONB value: an unknown operator is skipped rather than printed raw. The
    // validator refuses such a rule at save time, so this can only be reached by a hand-edited row.
    if (!term || !OP_ORDER[term.op]) continue;
    parts.push(`${o.opLabel(term.op)} ${formulaOperandInWords(term.operand, o)}`.trim());
  }
  return parts.join(', ');
}
