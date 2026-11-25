/**
 * Board d8dc0a8c / ADR 0183 — the two HR-chosen custom PCB methods, at the engine and explanation level.
 *
 * custom_fixed: the month's PCB is the HR-entered amount, with no formula, table, relief, rebate or RM10 floor,
 *   and the same figure whatever the month's additional remuneration is (so the kernel's additional-run delta
 *   charges it once a month).
 * custom_rate: the Non-Resident working (taxable remuneration × rate, truncation, 5-sen round-up, RM10 floor)
 *   with the HR-entered percentage in place of 30%.
 * Every other scheme is untouched by the option.
 */
import {describe, expect, it} from 'vitest';
import {statutory} from '../localization/my/payroll';
import {customPcbValueOf, draftTaxResidencyGap, isCustomPcbScheme, TAX_SELECTION_SCHEMES} from '../localization/my/tax-selection-codes';
import {explainPcb, pcbWorksheet} from '../core/pcb-explain';
import {pcbFormulaBlocks} from '../app/payroll/pcb-detail/formulas';

const profile = {category: 2 as const, children: 2};
const month = {month: 6};
const fixed = (amount: number | null) => ({calculationScheme: 'custom_fixed', customPcb: {amount, rate: null}});
const rated = (rate: number | null) => ({calculationScheme: 'custom_rate', customPcb: {amount: null, rate}});

describe('custom PCB engine (board d8dc0a8c)', () => {
  it('custom rate: the reporter example, RM3,000 at 30% is RM900, the same as the Non-Resident working', () => {
    const custom = statutory(3000, profile, 0, 0, month, rated(30));
    expect(custom.pcb).toBe(900);
    expect(custom.pcbBonus).toBe(0);
    expect(custom.pcb).toBe(statutory(3000, profile, 0, 0, month, {calculationScheme: 'non_resident'}).pcb);
    // Contributions are not touched by the tax method.
    const resident = statutory(3000, profile, 0, 0, month, {calculationScheme: 'resident'});
    for (const k of ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'eisEmployee', 'eisEmployer'] as const) {
      expect(custom[k], k).toBe(resident[k]);
    }
  });

  it('custom rate: applies to all taxable pay including bonus, with the Non-Resident rounding and RM10 floor', () => {
    // (3,000 + 1,000) × 25% = 1,000; the bonus leg alone is 250.
    const withBonus = statutory(3000, profile, 1000, 0, month, rated(25));
    expect(withBonus.pcb).toBe(1000);
    expect(withBonus.pcbBonus).toBe(250);
    // 2,999.99 × 12.5% = 374.99875 → truncated 374.99 → rounded up to the next 5 sen 375.00.
    expect(statutory(2999.99, profile, 0, 0, month, rated(12.5)).pcb).toBe(375);
    // 500 × 1% = 5.00, below RM10, so nothing is deducted — exactly as Non-Resident.
    expect(statutory(500, profile, 0, 0, month, rated(1)).pcb).toBe(0);
    expect(statutory(100000, profile, 0, 0, month, rated(100)).pcb).toBe(100000);
  });

  it('custom fixed: the amount HR entered, whatever the pay, bonus or category', () => {
    const plain = statutory(3000, profile, 0, 0, month, fixed(450));
    expect(plain.pcb).toBe(450);
    expect(plain.pcbBonus).toBe(0);
    expect(plain.pcbNormalPreZakat).toBe(0);
    // The month's figure does not move with additional remuneration, so a bonus run's delta is RM0.
    expect(statutory(3000, profile, 5000, 0, month, fixed(450)).pcb).toBe(450);
    expect(statutory(9000, {category: 1}, 0, 0, {month: 12}, fixed(450)).pcb).toBe(450);
    // No RM10 floor and no rounding: the amount is deducted as entered.
    expect(statutory(3000, profile, 0, 0, month, fixed(7.55)).pcb).toBe(7.55);
    // Even when it exceeds the month's pay: the payroll flags that for review, the engine never adjusts it.
    expect(statutory(300, profile, 0, 0, month, fixed(450)).pcb).toBe(450);
  });

  it('records the method and the number it used, for the explanation and replay', () => {
    expect(statutory(3000, profile, 1000, 0, month, fixed(450)).pcbMeta).toMatchObject({
      calculationScheme: 'custom_fixed', customPcb: {amount: 450}, trace: {remuneration: 3000, additional: 1000, amount: 450},
    });
    expect(statutory(3000, profile, 0, 0, month, rated(30)).pcbMeta).toMatchObject({
      calculationScheme: 'custom_rate', customPcb: {rate: 30}, trace: {remuneration: 3000, additional: 0, rate: 0.3},
    });
  });

  it('never falls back to the standard formula when the number is missing or invalid', () => {
    for (const opts of [fixed(null), fixed(0), fixed(-1), fixed(10.005), rated(null), rated(0), rated(100.01), rated(Number.NaN),
      {calculationScheme: 'custom_fixed'}, {calculationScheme: 'custom_rate'}]) {
      expect(() => statutory(3000, profile, 0, 0, month, opts), JSON.stringify(opts)).toThrow('custom PCB method needs');
    }
  });

  it('leaves every existing scheme byte-identical when a custom number is passed alongside it', () => {
    for (const calculationScheme of ['resident', 'non_resident'] as const) {
      const plain = statutory(4200, profile, 800, 120, month, {calculationScheme});
      expect(statutory(4200, profile, 800, 120, month, {calculationScheme, customPcb: {amount: 450, rate: null}})).toEqual(plain);
      expect(statutory(4200, profile, 800, 120, month, {calculationScheme, customPcb: {amount: null, rate: 30}})).toEqual(plain);
    }
  });
});

describe('custom PCB vocabulary', () => {
  it('reads the HR-entered number strictly', () => {
    expect(customPcbValueOf('custom_fixed', '450')).toEqual({amount: 450, rate: null});
    expect(customPcbValueOf('custom_fixed', ' 1234567.89 ')).toEqual({amount: 1234567.89, rate: null});
    expect(customPcbValueOf('custom_rate', '30')).toEqual({amount: null, rate: 30});
    expect(customPcbValueOf('custom_rate', '100.00')).toEqual({amount: null, rate: 100});
    for (const [scheme, raw] of [['custom_fixed', ''], ['custom_fixed', '0'], ['custom_fixed', '0.00'], ['custom_fixed', '-5'], ['custom_fixed', '1,000'],
      ['custom_fixed', '1e3'], ['custom_fixed', '10.005'], ['custom_fixed', 'abc'], ['custom_fixed', '12345678901'], ['custom_rate', '100.01'],
      ['custom_rate', '0'], ['custom_rate', '30%'], ['custom_rate', null]] as const) {
      expect(customPcbValueOf(scheme, raw), `${scheme} ${raw}`).toBeNull();
    }
    // Other schemes carry no number, and refuse one.
    expect(customPcbValueOf('resident', undefined)).toEqual({amount: null, rate: null});
    expect(customPcbValueOf('resident', '450')).toBeNull();
  });

  it('is an Income Tax Resident choice, but never a Create New Employee or import choice', () => {
    expect(TAX_SELECTION_SCHEMES).toEqual(['resident', 'non_resident', 'rep', 'knowledge_worker', 'c_suite', 'custom_fixed', 'custom_rate']);
    expect(isCustomPcbScheme('custom_fixed')).toBe(true);
    expect(isCustomPcbScheme('non_resident')).toBe(false);
    expect(draftTaxResidencyGap('custom_fixed', 'citizen')).toBe('taxResidency');
    expect(draftTaxResidencyGap('custom_rate', 'pr')).toBe('taxResidency');
    expect(draftTaxResidencyGap('non_resident', 'citizen')).toBeNull();
  });
});

describe('custom PCB explanation', () => {
  const f = {b2: (v: number) => v.toFixed(2), pct: (r: number) => `${(r * 100).toFixed(2)}%`, int: (v: number) => `${v}`};
  it('explains a custom rate from the payslip stamp, with its worksheet and formula', () => {
    const x = explainPcb(statutory(3000, profile, 0, 0, month, rated(30)), null);
    expect(x).toMatchObject({kind: 'custom', method: 'rate', ratePercent: 30, rate: 0.3, amount: null, trace: {remuneration: 3000, additional: 0}, pcb: 900, pcbSystem: 900, basis: null});
    expect(pcbWorksheet(x, null)).toMatchObject({shape: 'flat', note: 'worksheetCustomRateNote'});
    expect(pcbFormulaBlocks(x, f)).toEqual([expect.objectContaining({key: 'custom', formula: 'customRateFormula', substituted: '( 3000.00 + 0.00 ) × 30.00%', result: 900})]);
  });

  it('explains a fixed amount as the amount HR entered, with nothing calculated', () => {
    const x = explainPcb(statutory(3000, profile, 0, 0, month, fixed(450)), null);
    expect(x).toMatchObject({kind: 'custom', method: 'fixed', amount: 450, ratePercent: null, rate: null, pcb: 450});
    expect(pcbWorksheet(x, null).sections[0].rows).toEqual([{symbol: '', caption: 'worksheetCustomAmount', value: {kind: 'money', amount: 450}}]);
    expect(pcbFormulaBlocks(x, f)).toEqual([expect.objectContaining({key: 'custom', formula: 'customFixedFormula', substituted: '450.00', result: 450})]);
  });

  it('refuses to explain a custom payslip whose number was not recorded', () => {
    const st = statutory(3000, profile, 0, 0, month, fixed(450)) as unknown as {pcbMeta: Record<string, unknown>};
    const {customPcb: _dropped, ...meta} = st.pcbMeta;
    expect(explainPcb({...st, pcbMeta: meta}, null).kind).toBe('unavailable');
    expect(explainPcb({...st, pcbMeta: {...meta, customPcb: {rate: 30}}}, null).kind).toBe('unavailable');
  });
});
