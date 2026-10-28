import { describe, expect, it } from 'vitest';
import { calculateRewards } from '../packs/rewards/engine';
import { defaultPolicy, emptyFacts, emptyRecommendation, type RewardEntry, type RewardPolicy } from '../packs/rewards/model';

// 8ad87ae8 / 4e3e1af7 — fictional fixtures; pure engine, no database.
const policy = (patch: Partial<RewardPolicy> = {}): RewardPolicy => ({ ...defaultPolicy(2026), patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] }, ...patch });
const entry = (id = 'a', basicCents = 500000, payChanges?: RewardEntry['source']['payChanges'], lastPayChange: string | null = null): RewardEntry => ({ id, recommendation: emptyRecommendation(),
  source: { employmentId: id, personId: `person-${id}`, compensationId: `comp-${id}`, gradeId: null, employeeCode: id, name: id, grade: '12', basicCents, currency: 'MYR', payMode: 'monthly',
    hiredOn: '2020-01-01', confirmedOn: '2020-04-01', notice: false, lastPayChange, confirmationPayChange: false, performanceReviewId: null, performanceRating: null, ...(payChanges ? { payChanges } : {}) },
  facts: { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' } });

describe('8ad87ae8 salary adjusted in the exclusion window', () => {
  it('new reviews default the window to 1 October to 31 December of the reward year', () => {
    expect(defaultPolicy(2026).blockedFrom).toBe('2026-10-01');
    expect(defaultPolicy(2026).blockedTo).toBe('2026-12-31');
  });

  it('excludes from the salary increase but keeps the bonus, worked on the adjusted basic', () => {
    const adjusted = entry('a', 500000, [{ on: '2026-11-15', basicCents: 600000, kind: 'promotion' }]);
    const r = calculateRewards([adjusted, entry('b')], policy());
    const row = r.rows.find(x => x.id === 'a')!;
    expect(row.incrementReason).toBe('Pay change in the exclusion window');
    expect([row.meritCents, row.promotionCents, row.specialCents]).toEqual([0, 0, 0]);
    expect(row.newBasicCents).toBe(500000);
    expect(row.bonusEligible).toBe(true);
    expect(row.payChange).toEqual({ on: '2026-11-15', kind: 'promotion' });
    expect(row.bonusBasicCents).toBe(600000);
    // Only 'b' is in the salary-increase base; both are in the bonus base, 'a' at the adjusted basic.
    expect(r.budgets.standard.payrollCents).toBe(500000);
    expect(r.budgets.standard.bonusPayrollCents).toBe(1100000);
    expect(r.budgets.standard.excludedCount).toBe(1);
    expect(r.budgets.standard.excludedPayrollCents).toBe(500000);
    // Same bonus as someone whose snapshot basic already is the adjusted basic, under the same multiplier.
    const control = calculateRewards([entry('a', 600000), entry('b')], policy({ multiplierBp: r.rows[0].bonusMultiplierBp }));
    expect(row.bonusCents).toBeGreaterThan(0);
    expect(row.bonusCents).toBe(control.rows.find(x => x.id === 'a')!.bonusCents);
  });

  it('uses the latest change inside the window and ignores changes outside it', () => {
    const r = calculateRewards([entry('a', 500000, [{ on: '2026-10-10', basicCents: 550000, kind: 'increment' }, { on: '2026-12-01', basicCents: 600000, kind: null }, { on: '2027-01-15', basicCents: 650000, kind: null }])], policy());
    expect(r.rows[0].payChange).toEqual({ on: '2026-12-01', kind: null });
    expect(r.rows[0].bonusBasicCents).toBe(600000);
    const outside = calculateRewards([entry('a', 500000, [{ on: '2027-01-15', basicCents: 650000, kind: null }])], policy());
    expect(outside.rows[0].incrementEligible).toBe(true);
    expect(outside.rows[0].payChange).toBeNull();
    expect(outside.budgets.standard.excludedCount).toBe(0);
  });

  it('follows the window Group Rewards sets on the review', () => {
    const r = calculateRewards([entry('a', 500000, [{ on: '2027-01-15', basicCents: 650000, kind: null }])], policy({ blockedTo: '2027-01-31' }));
    expect(r.rows[0].incrementReason).toBe('Pay change in the exclusion window');
  });

  it('a person Group Rewards keeps eligible gets the increase on the snapshot basic and is not counted as excluded', () => {
    const r = calculateRewards([entry('a', 500000, [{ on: '2026-11-15', basicCents: 600000, kind: null }])], policy({ payWindowKeep: { a: 'Payroll correction entered twice' } }));
    const row = r.rows[0];
    expect(row.incrementEligible).toBe(true);
    expect(row.meritCents).toBeGreaterThan(0);
    expect(row.payWindowKept).toBe(true);
    expect(row.bonusBasicCents).toBe(500000);
    expect(r.budgets.standard.excludedCount).toBe(0);
    expect(r.budgets.standard.payrollCents).toBe(500000);
  });

  it('an empty recorded history means no basic change, whatever the salary record date (lateral transfer)', () => {
    const r = calculateRewards([entry('a', 500000, [], '2026-11-01')], policy());
    expect(r.rows[0].incrementEligible).toBe(true);
  });

  it('a snapshot taken before history was recorded keeps the earlier rule', () => {
    const r = calculateRewards([entry('a', 500000, undefined, '2026-10-05')], policy());
    expect(r.rows[0].incrementReason).toBe('Pay change in the exclusion window');
    expect(r.rows[0].bonusBasicCents).toBe(500000);
  });
});

describe('4e3e1af7 withheld lump sum', () => {
  it('the review note carries the reason given for withholding', () => {
    const outside = entry('a'); outside.facts.performance = null;
    const r = calculateRewards([outside], policy({ lumpUnitCents: 0, lumpReason: 'BU missed the PAT floor' }));
    expect(r.rows[0].lumpEligible).toBe(true);
    expect(r.rows[0].lumpCents).toBe(0);
    expect(r.flags).toContainEqual(expect.objectContaining({ severity: 'review', code: 'BUD-05', message: 'The unit lump-sum provision is withheld (RM 0): BU missed the PAT floor' }));
  });
});
