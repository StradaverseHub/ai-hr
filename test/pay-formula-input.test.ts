/** The one owner of a Pay Item's own {#Input} (lib/pay-formula-input.ts). Pure; no database. */
import { describe, expect, it } from 'vitest';
import { isPayFormulaQuantityUnit, payFormulaInputIsKeyedQuantity, payFormulaKeyedInput, payFormulaRowInputs } from '../lib/pay-formula-input';

describe('payFormulaKeyedInput', () => {
  it('NORMAL OT: a row priced by its Pay Item rule from 9.00 hours reads 9.00 hours, never the 120.40 it was priced at', () => {
    const row = { amount: '120.40', quantity: '9.00', unit: 'hours', calculationMethod: null, pricingSource: 'pay_item_rule' };
    expect(payFormulaKeyedInput(row)).toEqual({ basis: 'quantity', value: '9.00' });
    // {#PayItemInput} keeps the documented saved monetary amount; only the row's own {#Input} moves.
    expect(payFormulaRowInputs(row)).toEqual({ formulaInput: '120.40', currentInput: '9.00' });
  });
  it.each(['qty', 'hours', 'days', 'units'])('entry method formula reads the keyed %s', (unit) => {
    expect(payFormulaKeyedInput({ amount: 999, quantity: 2, unit, calculationMethod: 'formula' })).toEqual({ basis: 'quantity', value: '2' });
  });
  it('an Amount-entered row, a recurring or batch figure and an unmarked historical raw input keep the saved amount', () => {
    expect(payFormulaKeyedInput({ amount: '125.25', quantity: null, unit: 'amount', calculationMethod: 'amount' })).toEqual({ basis: 'amount', value: '125.25' });
    expect(payFormulaKeyedInput({ amount: '350.00' })).toEqual({ basis: 'amount', value: '350.00' });
    expect(payFormulaKeyedInput({ amount: '2.00', quantity: null, unit: 'amount', calculationMethod: null, pricingSource: null })).toEqual({ basis: 'amount', value: '2.00' });
    // Descriptive hours on an unmarked method-NULL row are not inferred: the amount is the raw input.
    expect(payFormulaKeyedInput({ amount: '4.00', quantity: '9.00', unit: 'hours', calculationMethod: null, pricingSource: null })).toEqual({ basis: 'amount', value: '4.00' });
    // An Amount row never becomes a quantity row, whatever marker it carries.
    expect(payFormulaInputIsKeyedQuantity({ calculationMethod: 'amount', pricingSource: 'pay_item_rule' })).toBe(false);
  });
  it('a quantity-input row without a positive quantity in a quantity unit has no input (refused, never the amount)', () => {
    for (const row of [
      { amount: '100.00', quantity: null, unit: 'amount', pricingSource: 'pay_item_rule' },
      { amount: '100.00', quantity: '0.00', unit: 'hours', pricingSource: 'pay_item_rule' },
      { amount: '100.00', quantity: '-1', unit: 'hours', calculationMethod: 'formula' },
      { amount: '100.00', quantity: '3.00', unit: 'amount', pricingSource: 'pay_item_rule' },
      { amount: '100.00', quantity: '', unit: 'days', pricingSource: 'pay_item_rule' },
    ]) expect(payFormulaKeyedInput(row)).toEqual({ basis: 'quantity', value: null });
  });
  it('recognises exactly the four entry quantity units', () => {
    expect(['qty', 'hours', 'days', 'units', 'amount', '', null, 'HOURS'].map(isPayFormulaQuantityUnit)).toEqual([true, true, true, true, false, false, false, false]);
  });
});
