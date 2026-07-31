/**
 * 61bf109d rev2 — Input Type and Formula were not missing, they were UNDISCOVERABLE.
 *
 * Verified deployed (r83): the editable Input Type selector and the row-based Formula builder live in
 * app/admin/pay-components/pay-rule-editor.tsx, rendered inside the Pay Settings section of
 * component-form.tsx on /new and /[code]. The Pay Items LIST showed a derived, read-only Input Type value
 * with nothing pointing at the screen that changes it, and said nothing at all about a formula. So this
 * item is presentation only, and this file covers the three things it changed:
 *
 *   1. app/admin/pay-components/pay-rule-words.ts — the formula, in plain words. THE ONLY REAL LOGIC HERE, so it gets
 *      behavioural tests rather than source assertions, driven through the REAL en.json catalog so what is
 *      asserted is the sentence an administrator actually reads.
 *   2. The list's Input Type cell is a link into the pay item, and prints those words underneath.
 *   3. The Pay Settings section names what it configures.
 *
 * AND THE SCOPE GUARD, which is the part that matters beyond this round: the words module goes VALUE →
 * WORDS, one way. There is still no parser, no eval and no expression string anywhere in the pay rule, and
 * core/pay-rule.ts's evaluator is untouched. A "renderer" that grew a reader would be the regression.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FORMULA_OPERAND_REFS,
  FORMULA_OPS,
  type FormulaOp,
  type FormulaOperand,
  type PayRule,
} from '../core/pay-rule';
import { formulaOperandInWords, payRuleInWords, type PayRuleWordsOptions } from '../app/admin/pay-components/pay-rule-words';

const ROOT = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalog = (loc: string) =>
  JSON.parse(read('messages', `${loc}.json`)) as {
    payRule: Record<string, string>;
    payComponents: Record<string, string>;
  };

const OP_KEY: Record<FormulaOp, string> = { '+': 'op_add', '-': 'op_sub', '*': 'op_mul', '/': 'op_div' };

/** The SAME wiring app/admin/pay-components/page.tsx uses, against the real catalog. */
const optionsFor = (loc: string, names: Record<string, string> = {}): PayRuleWordsOptions => {
  const pr = catalog(loc).payRule;
  return {
    operandLabel: (ref) => pr[`operand_${ref}`],
    opLabel: (op) => pr[OP_KEY[op]],
    startLabel: pr.formulaStart,
    payItemLabel: (code) => names[code],
  };
};

const en = optionsFor('en', { TRANSPORT: 'Transport allowance' });

/** A representative operand for each ref in the union — used to prove none of them goes wordless. */
const sampleOperand = (ref: (typeof FORMULA_OPERAND_REFS)[number]): FormulaOperand =>
  ref === 'number' ? { ref: 'number', value: 12.5 } : ref === 'component' ? { ref: 'component', code: 'TRANSPORT' } : ({ ref } as FormulaOperand);

describe('61bf109d rev2 — the formula reads as plain words', () => {
  it('describes a real multi-step formula end to end', () => {
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '*', operand: { ref: 'number', value: 0.05 } },
        { op: '+', operand: { ref: 'component', code: 'TRANSPORT' } },
        { op: '-', operand: { ref: 'days' } },
      ],
    };
    expect(payRuleInWords(rule, en)).toBe(
      'Start with Basic salary, multiply by 0.05, add TRANSPORT (Transport allowance), subtract Days worked',
    );
  });

  it('keeps the stored step order — the evaluator folds left-to-right with no precedence', () => {
    // core/pay-rule.ts resolvePayRule applies terms in array order. Printing them in any other order, or as
    // an infix expression that implies × binds tighter than +, would describe a calculation the engine does
    // not perform. THAT is the drift this whole module exists to prevent, so it is pinned first.
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'number', value: 100 },
      terms: [
        { op: '+', operand: { ref: 'number', value: 5 } },
        { op: '*', operand: { ref: 'number', value: 2 } },
      ],
    };
    expect(payRuleInWords(rule, en)).toBe('Start with 100, add 5, multiply by 2');
  });

  it('names a referenced pay item by CODE, adding its name only when the catalog knows it', () => {
    const withName: PayRule = { kind: 'formula', start: { ref: 'component', code: 'TRANSPORT' }, terms: [] };
    expect(payRuleInWords(withName, en)).toBe('Start with TRANSPORT (Transport allowance)');
    // A deleted / unresolvable code still reads as the code — the admin can search for that.
    const unknown: PayRule = { kind: 'formula', start: { ref: 'component', code: 'gone' }, terms: [] };
    expect(payRuleInWords(unknown, en)).toBe('Start with GONE');
  });

  it('DERIVED FROM THE UNION: every operand ref and every operator produces a distinct, non-empty word', () => {
    // Iterating the exported constants rather than a hand-copied list is what makes this a real guard:
    // a ref or an operator added to core/pay-rule.ts without a word here fails, and the compile-time
    // exhaustiveness guard in formulaOperandInWords catches it even earlier.
    for (const ref of FORMULA_OPERAND_REFS) {
      expect(formulaOperandInWords(sampleOperand(ref), en), `operand ${ref}`).not.toBe('');
    }
    const opWords = FORMULA_OPS.map((op) => en.opLabel(op));
    expect(opWords.every((w) => typeof w === 'string' && w !== '')).toBe(true);
    expect(new Set(opWords).size, 'each operator reads differently').toBe(FORMULA_OPS.length);
  });

  it('returns null for every NON-formula kind and for no rule at all', () => {
    // The other kinds are fully described by their own Input Type label, so the list prints nothing extra.
    const others: (PayRule | null)[] = [
      null,
      { kind: 'fixed' },
      { kind: 'percent_of', base: 'basic', pct: 10 },
      { kind: 'per_day', rate: 50 },
      { kind: 'per_hour', rate: 12 },
      { kind: 'flat_capped', value: 300, cap: 200 },
      { kind: 'qty_rate', qty: 3, rate: 25 },
    ];
    for (const rule of others) expect(payRuleInWords(rule, en), String(rule?.kind)).toBeNull();
  });

  it('survives a corrupted stored value rather than printing raw JSON', () => {
    // The save-time validator refuses these, so only a hand-edited row can reach here — but a list page
    // must not throw or leak internals because one row is bad.
    const corrupt = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '^', operand: { ref: 'basic' } }, null] } as unknown as PayRule;
    expect(payRuleInWords(corrupt, en)).toBe('Start with Basic salary');
    const noTerms = { kind: 'formula', start: { ref: 'hours' } } as unknown as PayRule;
    expect(payRuleInWords(noTerms, en)).toBe('Start with Hours worked');
  });

  it('is localised by the builder’s OWN strings, in all six catalogs', () => {
    const rule: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '+', operand: { ref: 'hours' } }] };
    for (const loc of LOCALES) {
      const pr = catalog(loc).payRule;
      for (const key of [...FORMULA_OPERAND_REFS.map((r) => `operand_${r}`), ...Object.values(OP_KEY), 'formulaStart']) {
        expect(typeof pr[key], `${loc}: payRule.${key}`).toBe('string');
        expect(pr[key], `${loc}: payRule.${key} is blank`).not.toBe('');
      }
      const words = payRuleInWords(rule, optionsFor(loc))!;
      expect(words, `${loc}`).toContain(pr.operand_basic);
      expect(words, `${loc}`).toContain(pr.op_add);
      expect(words, `${loc}`).toContain(pr.operand_hours);
    }
  });
});

describe('61bf109d rev2 — the list points at the screen that changes the value', () => {
  const listSrc = read('app', 'admin', 'pay-components', 'page.tsx');
  const formSrc = read('app', 'admin', 'pay-components', 'component-form.tsx');

  it('makes the Input Type cell a link to the pay item, same target as the row Edit action', () => {
    const cell = listSrc.slice(listSrc.indexOf('inputType_${inputTypeOf(c.rule)}') - 800);
    expect(cell, 'Input Type is rendered inside a Link').toContain('href={`${PAGE}/${encodeURIComponent(c.code)}`}');
    expect(listSrc, 'the link is titled so its purpose is obvious').toContain('inputTypeLinkTitle');
  });

  it('prints the plain-words formula on the list rows and in the CSV export', () => {
    expect(listSrc, 'uses the shared formatter, not a second description').toContain('payRuleInWords');
    expect(listSrc).toContain('wordsOf(c.rule)');
    expect(listSrc, 'the export carries the same sentence').toContain(`formula: wordsOf(c.rule) ?? ''`);
  });

  it('labels the Pay Settings section with what it configures', () => {
    expect(formSrc).toContain('sectionPaySettingsHint');
    // …and the section still renders the editor that holds Input Type + the Formula builder.
    expect(formSrc).toContain('PayRuleEditor');
  });

  it('has the three new keys in ALL SIX catalogs (tsc cannot see a missing translation)', () => {
    for (const loc of LOCALES) {
      const pc = catalog(loc).payComponents;
      for (const key of ['colFormula', 'inputTypeLinkTitle', 'sectionPaySettingsHint']) {
        expect(typeof pc[key], `${loc}: payComponents.${key}`).toBe('string');
        expect(pc[key], `${loc}: payComponents.${key} is blank`).not.toBe('');
      }
      // The link title interpolates the pay code — a catalog that dropped the placeholder renders a title
      // that names no item, which next-intl does not consider an error.
      expect(pc.inputTypeLinkTitle, `${loc}: inputTypeLinkTitle keeps {code}`).toContain('{code}');
    }
  });
});

describe('61bf109d rev2 — THE SCOPE GUARD: still no parser, no eval, no expression string', () => {
  const wordsSrc = read('app', 'admin', 'pay-components', 'pay-rule-words.ts');

  it('the words module evaluates nothing and reads no expression text', () => {
    // Scoped to THIS module on purpose: it is the one file the item added, and the one place a
    // "description" could quietly become a round-trip (words → value) and reintroduce parsing.
    //
    // Scoped to DECLARATIONS, not to the file text. An earlier draft asserted the source did not CONTAIN
    // "resolvePayRule" and failed on the file header, which cites the evaluator to explain why this module
    // does not call it — the guard matched the comment that documents the invariant it protects.
    const declarations = wordsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(declarations).not.toMatch(/\beval\s*\(|new Function\s*\(/);
    expect(declarations, 'no words → rule direction exists').not.toMatch(/function\s+\w*(parse|fromWords|toRule)\w*\s*\(/i);
    expect(declarations, 'the evaluator is never called').not.toMatch(/\bresolvePayRule\s*\(/);
    // Imports are the real seam: the module may take TYPES from core/pay-rule and nothing else at all.
    const imports = [...declarations.matchAll(/^import\s+([\s\S]*?)from\s+'([^']+)';$/gm)];
    expect(imports.map((m) => m[2]), 'imports exactly one module').toEqual(['@/core/pay-rule']);
    expect(imports[0][1].trim().startsWith('type'), 'type-only import — no runtime dependency').toBe(true);
  });

  it('leaves the evaluator, the statutory exclusion and the operand set exactly as they were', () => {
    const ruleSrc = read('core', 'pay-rule.ts');
    // Behavioural, not textual: the closed operand set and the statutory exclusion are what this item was
    // told not to widen, and both are observable from the module's own exports.
    expect([...FORMULA_OPERAND_REFS]).toEqual(['number', 'basic', 'days', 'hours', 'component']);
    expect([...FORMULA_OPS]).toEqual(['+', '-', '*', '/']);
    expect(ruleSrc, 'the evaluator is still here and still string-free').toContain('export function resolvePayRule');
    expect(ruleSrc).not.toMatch(/\beval\s*\(|new Function\s*\(/);
  });

  it('statutory pay codes are still excluded from formula operands on the form', () => {
    const formSrc = read('app', 'admin', 'pay-components', 'component-form.tsx');
    expect(formSrc, 'the operand picker still filters statutory items').toContain('isStatutoryComponent(c.code, c.kind)');
  });
});
