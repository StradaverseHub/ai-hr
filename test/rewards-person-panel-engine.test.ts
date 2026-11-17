import { describe, expect, it } from 'vitest';
import { calculateRewards } from '../packs/rewards/engine';
import { applyRewardCell, parseRewardCellValue } from '../packs/rewards/review-cell';
import { baselineRewardLimits } from '../packs/rewards/limit-controls-model';
import { defaultPolicy, emptyFacts, emptyRecommendation, recommendationSchema, type RewardEntry } from '../packs/rewards/model';

const policy = { ...defaultPolicy(2026), patActual: 100, patTarget: 100, multiplierBp: 10000, ranges: { '14': [400000,500000,650000] as [number,number,number], '15': [450000,550000,700000] as [number,number,number], '16': [500000,600000,750000] as [number,number,number], '17': [550000,650000,800000] as [number,number,number] } };
const entry = (over: Partial<RewardEntry> = {}): RewardEntry => ({ id: 'fictional-entry', source: { employmentId: 'employee', personId: 'person', compensationId: 'comp', employeeCode: 'E1', name: 'Fictional reviewer subject', grade: '14', gradeId: null, basicCents: 500000, currency: 'MYR', payMode: 'monthly', hiredOn: '2020-01-01', confirmedOn: '2020-06-01', notice: false, lastPayChange: null, confirmationPayChange: false, performanceReviewId: null, performanceRating: null }, facts: { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' }, recommendation: emptyRecommendation(), ...over });

describe('Rewards panel engine owner', () => {
  it('exposes suggestions without changing automatic calculated amounts', () => {
    const result = calculateRewards([entry()], policy), row = result.rows[0];
    expect(row.suggestedMeritBp).toBe(450);
    expect(row.meritBp).toBe(row.suggestedMeritBp);
    expect(row.suggestedSpecialCents).toBe(row.specialCents);
    expect(row.suggestedSpecialBp).toBe(row.specialBp);
    expect(row.suggestedMultiplierBp).toBe(10000);
    expect(row.bonusMultiplierBp).toBe(row.suggestedMultiplierBp);
    expect(row.suggestedLumpCents).toBe(result.lumpUnitCents);
    expect(row.rangePosition).toBe('in');
    // Full-year ME at JG14 is 1.50 months of 5,000 = MYR7,500.
    expect(row.bonusCents).toBe(750000);
    expect(row.paidBonusMonthsBp).toBe(15000);
  });
  it('retains suggested values independently of each typed override', () => {
    const row = calculateRewards([entry({ recommendation: { ...emptyRecommendation(), meritBp: 600, specialBp: 100, multiplierBp: 12500 } })], policy).rows[0];
    expect(row.suggestedMeritBp).toBe(450); expect(row.meritBp).toBe(600);
    expect(row.suggestedSpecialBp).toBe(0); expect(row.specialBp).toBe(100);
    expect(row.suggestedMultiplierBp).toBe(10000); expect(row.bonusMultiplierBp).toBe(12500);
  });
  it.each(['increase','bonus','lump'] as const)('withholds only the selected %s award and retains its reason', award => {
    const person = entry();
    if (award === 'lump') { person.facts.performance = 'UA'; }
    const configured = { ...policy, lumpUnitCents: 10000 };
    const before = calculateRewards([person], configured).rows[0];
    const result = calculateRewards([{ ...person, recommendation: { ...person.recommendation, withhold: { [award]: 'Approved fictional reason' } } }], configured), row = result.rows[0];
    if (award === 'increase') { expect(row.newBasicCents).toBe(500000); expect(row.meritCents + row.promotionCents + row.specialCents).toBe(0); expect(row.bonusCents).toBe(before.bonusCents); }
    if (award === 'bonus') { expect(row.bonusCents).toBe(0); expect(row.paidBonusMonthsBp).toBe(0); expect(row.newBasicCents).toBe(before.newBasicCents); }
    if (award === 'lump') { expect(before.lumpCents).toBe(10000); expect(row.lumpCents).toBe(0); expect(row.newBasicCents).toBe(before.newBasicCents); }
    expect(result.flags).toContainEqual(expect.objectContaining({ entryId: person.id, severity: 'exception', message: 'Withheld: Approved fictional reason' }));
  });
  it('patches the locked recommendation without erasing unrelated overrides and clears the promotion percentage with its grade', () => {
    const stored = entry({ recommendation: { ...emptyRecommendation(), meritBp: 400, promotionGrade: '15', promotionBp: 800, note: 'A fictional saved note' } });
    expect(applyRewardCell(stored,'promotionGrade',parseRewardCellValue('promotionGrade','')).recommendation).toMatchObject({ meritBp:400,promotionGrade:null,promotionBp:null,note:'A fictional saved note' });
    expect(applyRewardCell(stored,'specialBp',parseRewardCellValue('specialBp','2.5')).recommendation).toMatchObject({ meritBp:400,specialBp:250,promotionGrade:'15',promotionBp:800,note:'A fictional saved note' });
  });
  it('requires a real reason and parses older recommendations unchanged', () => {
    expect(recommendationSchema.parse(emptyRecommendation())).toEqual(emptyRecommendation());
    expect(() => recommendationSchema.parse({ ...emptyRecommendation(), withhold: { increase: 'short' } })).toThrow();
  });
  it('offers exactly the grade range enforced by the confirmed Limit Controls', () => {
    const baseline = baselineRewardLimits(policy);
    const limits = { ...baseline, source: 'version' as const, values: { ...baseline.values, 'promotion.maxGrades': { ...baseline.values['promotion.maxGrades'], value: 1 }, 'promotion.maxGrade': { ...baseline.values['promotion.maxGrade'], value: 15 } } };
    const row = calculateRewards([entry()], policy, { limits }).rows[0];
    expect(row.allowedPromotionGrades).toEqual(['15']);
    expect(calculateRewards([entry({ recommendation: { ...emptyRecommendation(), promotionGrade: '16', reason: 'A sufficiently detailed fictional business case.' } })], policy, { limits }).flags.some(flag => flag.code === 'PRO-01')).toBe(true);
  });
});
