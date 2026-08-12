/**
 * e318eaec — the READABLE FORMULA LINE, and the guard on the thing it must never become.
 *
 * ⚠️ THE POINT OF THIS FILE, IN ONE PARAGRAPH. The board item asks for a bracketed, readable formula AND
 * for "normal mathematical operator precedence". The first was built; the second is REFUSED, on purpose.
 * The reporter's live Overtime 1.5 is stored as a left-to-right fold, and left-to-right is the only reason
 * it produces the intended answer: their August payslip carries RM584.13 for 15 hours. Under school
 * precedence the SAME stored rule would mean "basic salary plus a fraction of the allowances" and would
 * re-price overtime that has already been paid. So core/pay-rule.ts ships a RENDERER, not a parser, and
 * this file is what stops that decision from being quietly undone:
 *
 *   • group 1 pins the EVALUATION ORDER with the reporter's real rule and their real figure, and asserts
 *     the precedence reading is a DIFFERENT number — so a future precedence-aware evaluator fails here
 *     rather than on a payslip;
 *   • group 2 proves the emitted string is honest, by evaluating it with a reference parser written in
 *     this file that reads ordinary precedence, over the live rule and all 64 three-step operator
 *     combinations;
 *   • group 3 pins that a NAMED number is display-only and an UNNAMED one is byte-identical to a rule
 *     stored before this change — which is why there is no migration and no backfill;
 *   • group 4 pins that `calendar_days` is not an alias of `days`.
 */
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import {
  FORMULA_OPERAND_REFS,
  FORMULA_OPS,
  formatPayRule,
  formatPayRuleOperand,
  resolvePayRule,
  validatePayRule,
  type FormulaOperand,
  type FormulaOperandRef,
  type PayRule,
  type PayRuleFormatLabels,
  type PayRuleScope,
} from '../core/pay-rule';

/**
 * THE REPORTER'S RULE, VERBATIM from production `pay_component.rule` (read-only, 2026-08-12). Copied as a
 * literal rather than constructed, so a change to how rules are built cannot quietly change what is pinned.
 */
const OT1_5: PayRule = {
  kind: 'formula',
  start: { ref: 'basic' },
  terms: [
    { op: '+', operand: { ref: 'fixed_allowances' } },
    { op: '/', operand: { ref: 'number', value: 26 } },
    { op: '/', operand: { ref: 'number', value: 8 } },
    { op: '*', operand: { ref: 'number', value: 1.5 } },
    { op: '*', operand: { ref: 'hours' } },
  ],
};

/** Irwin Law (X000001), the mockup's employee: basic 5,000.00, one live fixed allowance of 400.00
 *  (A0080 TRAVEL ALLOWANCE), and 15 hours keyed on his August one-off. */
const IRWIN: PayRuleScope = { basic: 5000, daysWorked: 31, hours: 15, fixedAllowances: 400, calendarDays: 31, proratedBasic: 5000 };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A REFERENCE evaluator for the emitted line, with ORDINARY school precedence and left associativity.
 *
 * Deliberately hand-written here and NOT imported from anywhere: the whole claim under test is "a normal
 * reader, reading this string normally, gets the number the fold computed". Reusing any of the code that
 * produced the string would test the code against itself.
 */
function evaluateWithNormalPrecedence(src: string): number {
  let i = 0;
  const ws = () => {
    while (i < src.length && src[i] === ' ') i++;
  };
  const primary = (): number => {
    ws();
    if (src[i] === '(') {
      i++;
      const v = expr();
      ws();
      if (src[i] !== ')') throw new Error(`unbalanced parenthesis in: ${src}`);
      i++;
      return v;
    }
    const start = i;
    while (i < src.length && /[0-9.]/.test(src[i])) i++;
    if (i === start) throw new Error(`a number was expected at ${i} in: ${src}`);
    return Number(src.slice(start, i));
  };
  const term = (): number => {
    let v = primary();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== '×' && op !== '/') return v;
      i++;
      const r = primary();
      v = op === '×' ? v * r : v / r;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== '+' && op !== '-') return v;
      i++;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
  };
  const out = expr();
  ws();
  if (i !== src.length) throw new Error(`trailing input at ${i} in: ${src}`);
  return out;
}

/** Render the formula with every operand replaced by ITS NUMBER for this scope, so the emitted string is
 *  arithmetic the reference parser above can read. This is the round trip the plan asks for. */
function numericLabels(scope: PayRuleScope): PayRuleFormatLabels {
  const of: Record<Exclude<FormulaOperandRef, 'number' | 'component'>, number> = {
    basic: scope.basic,
    prorated_basic: scope.proratedBasic ?? 0,
    days: scope.daysWorked,
    calendar_days: scope.calendarDays ?? 0,
    hours: scope.hours,
    fixed_allowances: scope.fixedAllowances ?? 0,
  };
  return {
    operand: (ref) => String(of[ref as keyof typeof of] ?? 0),
    payItem: (code) => String(scope.components?.[code] ?? 0),
    number: (n) => String(n),
  };
}

/** The English wording, as the builder's own dropdowns render it. */
const englishLabels: PayRuleFormatLabels = {
  operand: (ref) => (en.payRule as unknown as Record<string, string>)[`operand_${ref}`],
  payItem: (code) => (code === 'A0080' ? 'Travel allowance' : null),
  number: (n) => String(n),
};

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. THE EVALUATION ORDER IS UNCHANGED — pinned with the reporter's own rule and their own figure
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e318eaec 1 — the stored fold still folds LEFT TO RIGHT, and that is what pays', () => {
  it("the live OT1_5 rule pays RM584.13 for Irwin Law's 15 hours — the figure on his August payslip", () => {
    const paid = resolvePayRule(OT1_5, IRWIN, 0);
    // (5000 + 400) / 26 / 8 × 1.5 × 15, folded in order. Hand-computed, not re-derived from the code.
    expect(paid).toBeCloseTo(584.1346153846154, 8);
    expect(round2(paid)).toBe(584.13);
  });

  it('⚠️ REFUSES to be precedence-aware: the precedence reading is a DIFFERENT number, and must stay wrong', () => {
    // What the SAME stored rule would mean if anyone ever taught the evaluator school precedence:
    //   basic + (fixed_allowances / 26 / 8 × 1.5 × hours)
    const underPrecedence = 5000 + (400 / 26 / 8) * 1.5 * 15;
    expect(round2(underPrecedence)).toBe(5043.27);
    // The two readings differ by more than RM4,000 on ONE employee for ONE month. If this assertion ever
    // fails because the two have converged, the evaluator has been changed and live overtime has been
    // re-priced — do not "fix" the test.
    expect(resolvePayRule(OT1_5, IRWIN, 0)).not.toBeCloseTo(underPrecedence, 2);
    expect(round2(resolvePayRule(OT1_5, IRWIN, 0))).toBe(584.13);
  });

  it('the readable line says, in words, exactly what the fold does', () => {
    expect(formatPayRule(OT1_5, englishLabels)).toBe(
      '(Basic salary + All fixed allowances) / 26 / 8 × 1.5 × Hours worked',
    );
  });

  it('the line is a RENDERER, not a parser: it never changes the stored rule or its value', () => {
    const before = JSON.stringify(OT1_5);
    formatPayRule(OT1_5, englishLabels);
    expect(JSON.stringify(OT1_5)).toBe(before);
    expect(round2(resolvePayRule(OT1_5, IRWIN, 0))).toBe(584.13);
  });

  it('a non-formula rule has no line to draw', () => {
    expect(formatPayRule(null, englishLabels)).toBeNull();
    expect(formatPayRule({ kind: 'per_hour', rate: 12 }, englishLabels)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. THE ROUND TRIP — the emitted string, read NORMALLY, is the number the fold computed
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e318eaec 2 — the emitted line evaluates, under ordinary precedence, to what resolvePayRule pays', () => {
  it("the reporter's own rule round-trips", () => {
    const line = formatPayRule(OT1_5, numericLabels(IRWIN))!;
    expect(line).toBe('(5000 + 400) / 26 / 8 × 1.5 × 15');
    expect(evaluateWithNormalPrecedence(line)).toBeCloseTo(resolvePayRule(OT1_5, IRWIN, 0), 8);
  });

  it('every one of the 64 three-step operator combinations round-trips', () => {
    /**
     * A SYNTHETIC scope, and the values are chosen rather than realistic for two reasons.
     *  • No two operands are equal and none is 1: a formula whose operands were interchangeable would
     *    round-trip under ANY bracketing at all and would prove nothing.
     *  • Every operand is below 1 and the seed is large, so no combination of the 64 can drive the fold
     *    negative. That matters because `formula` is the one rule kind that CLAMPS its final result at 0
     *    (the sign contract in core/pay-rule.ts's header) while a reference parser does not — comparing a
     *    clamped number with an unclamped one would silently turn a bracketing bug into a passing test.
     *    The assertion below proves the clamp never engaged, rather than assuming it.
     */
    const matrix: PayRuleScope = { basic: 5000, daysWorked: 31, hours: 0.15, fixedAllowances: 0.4, calendarDays: 31 };
    const operands: FormulaOperand[] = [
      { ref: 'fixed_allowances' }, //     0.4
      { ref: 'number', value: 0.26 },
      { ref: 'hours' }, //                0.15
    ];
    let checked = 0;
    for (const a of FORMULA_OPS) {
      for (const b of FORMULA_OPS) {
        for (const c of FORMULA_OPS) {
          const rule: PayRule = {
            kind: 'formula',
            start: { ref: 'basic' },
            terms: [
              { op: a, operand: operands[0] },
              { op: b, operand: operands[1] },
              { op: c, operand: operands[2] },
            ],
          };
          const paid = resolvePayRule(rule, matrix, 0);
          expect(paid, `${a} ${b} ${c} went non-positive — the clamp is in play and this matrix is no longer valid`).toBeGreaterThan(0);
          const line = formatPayRule(rule, numericLabels(matrix))!;
          expect(
            evaluateWithNormalPrecedence(line),
            `${a} ${b} ${c} → "${line}" does not read back as the fold`,
          ).toBeCloseTo(paid, 8);
          checked++;
        }
      }
    }
    expect(checked).toBe(64);
  });

  it('brackets appear exactly where a tighter operator would otherwise steal the tail, and nowhere else', () => {
    const line = (terms: PayRule extends never ? never : { op: (typeof FORMULA_OPS)[number]; operand: FormulaOperand }[]) =>
      formatPayRule({ kind: 'formula', start: { ref: 'basic' }, terms }, numericLabels(IRWIN));
    // + then / — the / would bind to the 400 alone, so the sum has to be bracketed.
    expect(line([{ op: '+', operand: { ref: 'fixed_allowances' } }, { op: '/', operand: { ref: 'number', value: 26 } }])).toBe(
      '(5000 + 400) / 26',
    );
    // / then + — nothing to protect; a bracket here would be noise.
    expect(line([{ op: '/', operand: { ref: 'number', value: 26 } }, { op: '+', operand: { ref: 'fixed_allowances' } }])).toBe(
      '5000 / 26 + 400',
    );
    // Same precedence, left-associative in both readings ⇒ still no bracket.
    expect(line([{ op: '/', operand: { ref: 'number', value: 26 } }, { op: '*', operand: { ref: 'number', value: 1.5 } }])).toBe(
      '5000 / 26 × 1.5',
    );
    // And the two the ticket contrasts really do read as different formulas.
    expect(line([{ op: '+', operand: { ref: 'fixed_allowances' } }, { op: '/', operand: { ref: 'number', value: 26 } }])).not.toBe(
      line([{ op: '/', operand: { ref: 'number', value: 26 } }, { op: '+', operand: { ref: 'fixed_allowances' } }]),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. NAMED NUMBERS ARE DISPLAY ONLY — which is why there is no migration
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e318eaec 3 — naming a number changes the words and not one cent', () => {
  const named: PayRule = {
    kind: 'formula',
    start: { ref: 'basic' },
    terms: [
      { op: '+', operand: { ref: 'fixed_allowances' } },
      { op: '/', operand: { ref: 'number', value: 26, label: 'Working days' } },
      { op: '/', operand: { ref: 'number', value: 8, label: 'Working hours' } },
      { op: '*', operand: { ref: 'number', value: 1.5, label: 'Rate 1.5' } },
      { op: '*', operand: { ref: 'hours' } },
    ],
  };

  it('a rule stored WITHOUT labels — every rule on production today — is still valid and still pays the same', () => {
    expect(validatePayRule(OT1_5, false)).toEqual({ ok: true });
    expect(round2(resolvePayRule(OT1_5, IRWIN, 0))).toBe(584.13);
    // No key is added to a rule nobody has renamed: the stored JSON is unchanged, so there is nothing to
    // migrate and nothing to backfill.
    expect(JSON.parse(JSON.stringify(OT1_5))).toEqual(OT1_5);
    expect(Object.keys((OT1_5 as { terms: { operand: FormulaOperand }[] }).terms[1].operand)).toEqual(['ref', 'value']);
  });

  it('the SAME rule with names resolves byte-identically to the one without', () => {
    expect(resolvePayRule(named, IRWIN, 0)).toBe(resolvePayRule(OT1_5, IRWIN, 0));
  });

  it('the names appear on the line — and 26, 8 and 1.5 stop being three unexplained numbers', () => {
    expect(formatPayRule(named, englishLabels)).toBe(
      '(Basic salary + All fixed allowances) / 26 (Working days) / 8 (Working hours) × [Rate 1.5] × Hours worked',
    );
  });

  it('a name that does NOT contain its value never hides the value — a stale name cannot print a lie', () => {
    // Named "Rate 1.5" but since retyped as 2. The ticket's [Rate 1.5] shape is keyed off the label
    // actually containing the figure, so this correctly shows the figure that will be paid.
    expect(formatPayRuleOperand({ ref: 'number', value: 2, label: 'Rate 1.5' }, englishLabels)).toBe('2 (Rate 1.5)');
    expect(formatPayRuleOperand({ ref: 'number', value: 1.5, label: 'Rate 1.5' }, englishLabels)).toBe('[Rate 1.5]');
  });

  it('an over-long name is refused at SAVE time, like everything else in this union', () => {
    const long = 'x'.repeat(41);
    expect(
      validatePayRule({ kind: 'formula', start: { ref: 'number', value: 1, label: long }, terms: [] }, false),
    ).toEqual({ ok: false, code: 'OUT_OF_RANGE' });
    expect(
      validatePayRule({ kind: 'formula', start: { ref: 'number', value: 1, label: 'x'.repeat(40) }, terms: [] }, false),
    ).toEqual({ ok: true });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 4. THE TWO NEW OPERANDS ARE NOT ALIASES OF THE OLD ONES
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e318eaec 4 — calendar_days and prorated_basic are their own figures', () => {
  /** A mid-month joiner in a 31-day month: the kernel's factor is < 1, so daysWorked < calendarDays and
   *  proratedBasic < basic. This is the shape that catches an alias. */
  const joiner: PayRuleScope = { basic: 5000, daysWorked: 16, hours: 0, calendarDays: 31, proratedBasic: 2580.65 };
  const only = (ref: FormulaOperandRef): PayRule => ({ kind: 'formula', start: { ref } as FormulaOperand, terms: [] });

  it('calendar_days is the MONTH, days is the PRORATED count — quietly aliasing one to the other fails here', () => {
    expect(resolvePayRule(only('calendar_days'), joiner, 0)).toBe(31);
    expect(resolvePayRule(only('days'), joiner, 0)).toBe(16);
    expect(resolvePayRule(only('calendar_days'), joiner, 0)).not.toBe(resolvePayRule(only('days'), joiner, 0));
  });

  it('prorated_basic is basic AFTER the tenure factor, basic is before it', () => {
    expect(resolvePayRule(only('prorated_basic'), joiner, 0)).toBe(2580.65);
    expect(resolvePayRule(only('basic'), joiner, 0)).toBe(5000);
  });

  it('a scope that does not supply them reads 0 — a figure, never NaN and never a thrown batch', () => {
    const bare: PayRuleScope = { basic: 5000, daysWorked: 20, hours: 160 };
    expect(resolvePayRule(only('calendar_days'), bare, 0)).toBe(0);
    expect(resolvePayRule(only('prorated_basic'), bare, 0)).toBe(0);
  });

  it('every operand the validator accepts has a word for it in the catalogue', () => {
    // A ref added to the union without a `payRule.operand_*` entry renders as a MISSING_MESSAGE on a live
    // screen and passes tsc, the suite and next build. This is where it is caught instead.
    for (const ref of FORMULA_OPERAND_REFS) {
      expect((en.payRule as unknown as Record<string, string>)[`operand_${ref}`], `operand_${ref} is missing from en.json`).toBeTruthy();
    }
  });
});
