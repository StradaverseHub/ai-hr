import { describe, expect, it } from 'vitest';
import { accumulateEaRouting } from '../localization/my/ea-routing';
import type { StoredComponentLine } from '../core/payslip-earning-lines';
import { EA_LINE_TO_FIELD } from '../localization/my/reports';
const line = (code: string, bucket: string, amount: number): StoredComponentLine => ({ code, buckets: [{ bucket, amount }] });
const route = (lines: StoredComponentLine[], mapping: [string, string | null][] = [], active = true) => accumulateEaRouting(lines, new Map(mapping), EA_LINE_TO_FIELD, active);
describe('approved annual EA routing preserves processed money', () => {
  it('blank income defaults to salary while reimbursements and deductions remain excluded', () => {
    expect(route([line('INCOME', 'wage', 400), line('REFUND', 'reimburse', 300), line('DEDUCT', 'deduct', 200)]).deltas).toEqual({ allowances: -400, grossSalary: 400 });
  });
  it('explicit exempt classification is never silently converted to salary', () => {
    expect(route([line('EXEMPT', 'wage', 400)], [['EXEMPT', 'allowance_exempt']]).deltas).toEqual({});
  });
  it('combined B1(b) receives bonus and commission once across repeated processed lines', () => {
    const r = route([line('BONUS', 'bonus', 100), line('COMMISSION', 'wage', 200), line('COMMISSION', 'wage', 300)], [['BONUS', 'EA_B1B'], ['COMMISSION', 'EA_B1B']]);
    expect(r.deltas).toEqual({ bonus: -100, allowances: -500, directorFee: 600 });
    expect(Object.values(r.deltas).reduce((a, b) => a + (b ?? 0), 0)).toBe(0);
  });
  it('Part C transfers reduce Part B and do not add remuneration twice', () => {
    const r = route([line('PENSION', 'wage', 200), line('ANNUITY', 'bonus', 300)], [['PENSION', 'EA_C1'], ['ANNUITY', 'EA_C2']]);
    expect(r.deltas).toEqual({ allowances: -200, pension: 200, bonus: -300, annuity: 300 });
    expect(Object.values(r.deltas).reduce((a, b) => a + (b ?? 0), 0)).toBe(0);
  });
  it('pre-coverage years keep original amounts even with explicit or default assignments', () => {
    expect(route([line('PENSION', 'wage', 200), line('DEFAULT', 'bonus', 300)], [['PENSION', 'EA_C1']], false).deltas).toEqual({});
  });
  it('recognized legacy B2 and fee assignments keep their intent', () => {
    expect(route([line('ARREARS', 'wage', 250), line('FEE', 'bonus', 150)], [['ARREARS', 'arrears'], ['FEE', 'director_fee']]).deltas).toEqual({ allowances: -250, arrears: 250, bonus: -150, directorFee: 150 });
  });
  it('unknown classifications retain original amounts and are flagged, never defaulted', () => {
    const r = route([line('UNKNOWN', 'wage', 400)], [['UNKNOWN', 'invalid']]);
    expect(r.deltas).toEqual({}); expect([...r.unmapped]).toEqual(['UNKNOWN']);
  });
});
