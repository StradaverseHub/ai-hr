import { describe, it, expect } from 'vitest';
import { hasCompleteHistoricalEaProvenance, accumulateEaRouting } from '../localization/my/ea-routing';

const mapping = new Map<string, string | null>([['DIRECTOR', 'EA_B1B']]);
const slip = () => ({ allowance: '30000.00', bonus: '0.00', statutory: {
  componentLines: [{ code: 'DIRECTOR', amount: 30000, buckets: [{ bucket: 'wage', amount: 30000 }] }],
} });

describe('r379 complete historical EA provenance', () => {
  it('routes a complete saved director fee once, and uses subsequent current mapping changes', () => {
    const slips = [slip()];
    expect(hasCompleteHistoricalEaProvenance(slips, mapping)).toBe(true);
    const targets = { EA_B1B: 'directorFee', EA_B1C: 'allowances' } as const;
    const first = accumulateEaRouting(slips[0].statutory.componentLines, mapping, targets, true);
    expect(first.deltas).toEqual({ allowances: -30000, directorFee: 30000 });
    expect(Object.values(first.deltas).reduce((sum, amount) => sum + amount, 0)).toBe(0);
    const edited = accumulateEaRouting(slips[0].statutory.componentLines, new Map([['DIRECTOR', 'EA_B1C']]), targets, true);
    expect(edited.deltas).toEqual({});
  });
  it('refuses the entire year when any owned slip lacks item provenance', () => {
    expect(hasCompleteHistoricalEaProvenance([slip(), { allowance: '30000', bonus: '0', statutory: {} }], mapping)).toBe(false);
    expect(hasCompleteHistoricalEaProvenance([{ allowance: '0', bonus: '0', statutory: { componentLines: [] } }], mapping)).toBe(false);
    expect(hasCompleteHistoricalEaProvenance([], mapping)).toBe(false);
  });
  it('refuses nonreconciling source totals and missing catalogue identity', () => {
    expect(hasCompleteHistoricalEaProvenance([{ ...slip(), allowance: '30001.00' }], mapping)).toBe(false);
    expect(hasCompleteHistoricalEaProvenance([{ ...slip(), bonus: '1.00' }], mapping)).toBe(false);
    expect(hasCompleteHistoricalEaProvenance([slip()], new Map())).toBe(false);
  });
  it('refuses pre-cap item OT even when its amount is below saved total OT', () => {
    const s = slip(); s.statutory.componentLines[0].buckets.push({ bucket: 'ot', amount: 10 });
    expect(hasCompleteHistoricalEaProvenance([{ ...s, overtime: '100' }], mapping)).toBe(false);
  });
  it.each([null, [], { amount: '1' }, { amount: null }])('refuses unproven converted OT %j', otConvert => {
    expect(hasCompleteHistoricalEaProvenance([{ ...slip(), statutory: { ...slip().statutory, otConvert } }], mapping)).toBe(false);
  });
  it.each([null, '', 'NaN', Infinity, -1, 0.004, '0.004', {}, []])('refuses malformed or negative contribution %j', amount => {
    expect(hasCompleteHistoricalEaProvenance([{ allowance: '30000', bonus: '0', statutory: { componentLines: [{ code: 'DIRECTOR', buckets: [{ bucket: 'wage', amount }] }] } }], mapping)).toBe(false);
  });
  it('accepts valid decimal cents without accepting rounded sub-cent item OT', () => {
    const s = { allowance: '0.29', bonus: '0.00', statutory: { componentLines: [{ code: 'DIRECTOR', buckets: [{ bucket: 'wage', amount: 0.29 }] }] } };
    expect(hasCompleteHistoricalEaProvenance([s], mapping)).toBe(true);
    s.statutory.componentLines[0].buckets.push({ bucket: 'ot', amount: 0.001 });
    expect(hasCompleteHistoricalEaProvenance([s], mapping)).toBe(false);
  });
  it('refuses unreconciled repeated contributions and unrecorded exemption provenance', () => {
    const s = slip();
    expect(hasCompleteHistoricalEaProvenance([{ ...s, statutory: { componentLines: [...s.statutory.componentLines, ...s.statutory.componentLines] } }], mapping)).toBe(false);
    expect(hasCompleteHistoricalEaProvenance([{ ...s, statutory: { componentLines: [{ code: 'DIRECTOR', buckets: [{ bucket: 'wage', amount: 15000 }, { bucket: 'wage', amount: 15001 }] }] } }], mapping)).toBe(false);
    expect(hasCompleteHistoricalEaProvenance([{ ...s, statutory: { ...s.statutory, exemptionUsed: { PCB_TRAVEL: 1 } } }], mapping)).toBe(false);
  });
  it('accepts recurring and additional contributions for the same stable pay-item code when totals reconcile', () => {
    const lines = [{ code: 'DIRECTOR', buckets: [{ bucket: 'wage', amount: 10000 }, { bucket: 'wage', amount: 5000 }] }, { code: 'DIRECTOR', buckets: [{ bucket: 'wage', amount: 15000 }] }];
    const s = { allowance: '30000', bonus: '0', statutory: { componentLines: lines } };
    expect(hasCompleteHistoricalEaProvenance([s], mapping)).toBe(true);
    expect(accumulateEaRouting(lines, mapping, { EA_B1B: 'directorFee' }, true).deltas).toEqual({ allowances: -30000, directorFee: 30000 });
  });
  it('accepts recorded exempt/reimbursement splits without rerouting exempt amounts', () => {
    const s = { allowance: '30000', bonus: '500', statutory: { componentLines: [{ code: 'DIRECTOR', amount: 30500, buckets: [{ bucket: 'wage', amount: 29000 }, { bucket: 'reimburse', amount: 1000 }, { bucket: 'bonus', amount: 500 }] }], exemptionUsed: { PCB_TRAVEL: 1000 } } };
    expect(hasCompleteHistoricalEaProvenance([s], mapping)).toBe(true);
    expect(accumulateEaRouting(s.statutory.componentLines, mapping, { EA_B1B: 'directorFee' }, true).deltas).toEqual({ allowances: -29000, bonus: -500, directorFee: 29500 });
  });
});
