/**
 * r389 (23bd49d9) — THE SAVED SETTING IS THE ORDER.
 *
 * `payslip_information_setting.fields` became the ordered list of shown fields, with no migration. That is
 * only safe because of one claim: every row stored before r389 was written by a setter that re-sorted into
 * the catalogue order, so for every such row the new selector must produce EXACTLY what the old one did.
 * The second block pins that claim against a verbatim copy of the pre-r389 selector, over every row shape
 * the old setter could have written that matters here (the defaults, the whole catalogue, nothing, each
 * single field, and a seeded spread of catalogue-order subsets), with blank, whitespace and zero values in
 * the data. A selector that changed the output for any of them would change an issued payslip nobody
 * touched.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAYSLIP_INFORMATION_FIELDS,
  PAYSLIP_INFORMATION_FIELDS,
  payslipInformationFields,
  payslipProfileRows,
  selectPayslipInformation,
  type PayslipInformationField,
} from '../core/payslip-information';

const names = Object.fromEntries(PAYSLIP_INFORMATION_FIELDS.map(k => [k, `Label ${k}`])) as Record<PayslipInformationField, string>;

/** The pre-r389 selector, verbatim (core/payslip-information.ts at ecafe9da). */
function legacyFields(raw: unknown): readonly PayslipInformationField[] {
  return Array.isArray(raw) ? PAYSLIP_INFORMATION_FIELDS.filter(k => raw.includes(k)) : DEFAULT_PAYSLIP_INFORMATION_FIELDS;
}
function legacySelect(data: Partial<Record<PayslipInformationField, unknown>>, settings: unknown) {
  return legacyFields(settings).flatMap(key => {
    const value = data[key];
    if (value == null || String(value).trim() === '') return [];
    return [{ key, label: names[key], value: String(value).trim() }];
  });
}

/** Deterministic PRNG so the spread of subsets is the same on every run. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('r389 selector keeps the stored order', () => {
  it('returns a non-catalogue saved order exactly as saved', () => {
    expect(payslipInformationFields(['employeeCode', 'employee', 'currency', 'branch'])).toEqual(['employeeCode', 'employee', 'currency', 'branch']);
    const values = { employee: 'Ada', employeeCode: 'E-1', currency: 'MYR', branch: 'North' };
    expect(selectPayslipInformation(values, ['employeeCode', 'employee', 'currency', 'branch'], names).map(r => r.key))
      .toEqual(['employeeCode', 'employee', 'currency', 'branch']);
  });

  it('drops unknown keys and keeps the FIRST place of a repeated key', () => {
    expect(payslipInformationFields(['branch', 'bankAccount', 'employee', 'branch', 7, null, 'employee', 'daysWorked']))
      .toEqual(['branch', 'employee', 'daysWorked']);
    const rows = selectPayslipInformation({ branch: 'North', employee: 'Ada', daysWorked: 0 }, ['branch', 'employee', 'branch'], names);
    expect(rows.map(r => r.key)).toEqual(['branch', 'employee']);
  });

  it('still gives the defaults when nothing was saved, and nothing for a saved empty list', () => {
    expect(payslipInformationFields(null)).toEqual(DEFAULT_PAYSLIP_INFORMATION_FIELDS);
    expect(payslipInformationFields(undefined)).toEqual(DEFAULT_PAYSLIP_INFORMATION_FIELDS);
    expect(payslipInformationFields({ fields: ['employee'] })).toEqual(DEFAULT_PAYSLIP_INFORMATION_FIELDS);
    expect(payslipInformationFields([])).toEqual([]);
  });
});

describe('r389 a catalogue-order row renders byte-identical rows to the pre-r389 selector', () => {
  // Every value shape the selector treats differently: present, blank, whitespace, padded, zero, absent.
  const shapes: unknown[] = ['Value', '', '   ', '  padded  ', 0, null, undefined];
  const rnd = mulberry32(389);
  const dataSets = Array.from({ length: 12 }, () =>
    Object.fromEntries(PAYSLIP_INFORMATION_FIELDS.map(k => [k, shapes[Math.floor(rnd() * shapes.length)]])));
  dataSets.push(Object.fromEntries(PAYSLIP_INFORMATION_FIELDS.map(k => [k, `value-${k}`])));

  const settings: unknown[] = [
    null, undefined, [], [...DEFAULT_PAYSLIP_INFORMATION_FIELDS], [...PAYSLIP_INFORMATION_FIELDS],
    ...PAYSLIP_INFORMATION_FIELDS.map(k => [k]),
  ];
  for (let i = 0; i < 200; i++) settings.push(PAYSLIP_INFORMATION_FIELDS.filter(() => rnd() < 0.5));

  it(`agrees on ${settings.length} catalogue-order settings × ${dataSets.length} employees, byte for byte`, () => {
    let compared = 0;
    for (const setting of settings) {
      for (const data of dataSets) {
        const before = JSON.stringify(legacySelect(data, setting));
        const after = JSON.stringify(selectPayslipInformation(data, setting, names));
        expect(after).toBe(before);
        // …and the profile rows the screen and both PDFs are built from.
        const extra = { paymentMethod: 'Bank transfer', bankName: 'Bank', bankAccount: '123', cycle: 'Monthly' };
        const extraLabels = { paymentMethod: 'Payment', bankName: 'Bank name', bankAccount: 'Account', cycle: 'Cycle' };
        expect(JSON.stringify(payslipProfileRows(selectPayslipInformation(data, setting, names), extra, extraLabels)))
          .toBe(JSON.stringify(payslipProfileRows(legacySelect(data, setting), extra, extraLabels)));
        compared++;
      }
    }
    expect(compared).toBe(settings.length * dataSets.length);
  });

  it('the comparison can tell the selectors apart (non-vacuity): a non-catalogue row differs', () => {
    const data = Object.fromEntries(PAYSLIP_INFORMATION_FIELDS.map(k => [k, `value-${k}`]));
    const reordered = ['employeeCode', 'employee'];
    expect(JSON.stringify(selectPayslipInformation(data, reordered, names))).not.toBe(JSON.stringify(legacySelect(data, reordered)));
  });
});
