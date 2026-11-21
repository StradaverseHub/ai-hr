import { describe, expect, it } from 'vitest';
import { calculateOffcycle, offcycleBlackout, offcycleMidyearOpen, offcyclePayPosition, offcycleReturnSeat, offcycleRoute, offcycleTransition, offcycleYearEndExclusion } from '../packs/rewards/offcycle';
import { baselineRewardLimitValues, versionRewardLimits, rewardConfigurableLimitKeys } from '../packs/rewards/limit-controls-model';
import { compareRoleDescriptions } from '../packs/rewards/role-summary';
import { decodeRewardDashboardPreference, storedRewardDashboardPreference } from '../packs/rewards/dashboard-model';
import { defaultPolicy, emptyFacts, emptyRecommendation, type RewardEntry } from '../packs/rewards/model';
const e = (): RewardEntry => ({ id: 'one', source: { employmentId: 'one', personId: 'one', compensationId: 'salary', gradeId: 'grade', name: 'Employee', employeeCode: 'one', grade: '21', basicCents: 500000, currency: 'MYR', payMode: 'monthly', hiredOn: '2020-01-01', confirmedOn: '2020-04-01', notice: false, lastPayChange: null, confirmationPayChange: false, performanceReviewId: null, performanceRating: null }, facts: { ...emptyFacts(), reviewed: true }, recommendation: { ...emptyRecommendation(), meritBp: 100, reason: 'Expanded responsibilities in the team' } });
const details = { exceptionReason: '', bgOrigin: false };
describe('off-cycle policy and role comparisons', () => {
  const balance = (availableCents: number) => ({ frozenCents: availableCents, committedCents: 0, availableCents });
  it('uses monthly deltas against one company balance (b945f0cc): Standard and JG H draw on the same amount', () => {
    const result = calculateOffcycle([e()], defaultPolicy(2026), 'adhoc', details, balance(5000));
    expect(result.rows[0].newBasicCents).toBe(505000);
    expect(result.offcycleBalance).toEqual({ frozenCents: 5000, committedCents: 0, availableCents: 5000, requestCents: 5000, remainingCents: 0 });
    expect(result.flags.map(f => f.code)).not.toContain('OC-11');
    const h = e(); h.source.grade = 'H';
    expect(calculateOffcycle([h], defaultPolicy(2026), 'adhoc', details, balance(5000)).flags.map(f => f.code)).not.toContain('OC-11');
    const over = calculateOffcycle([e()], defaultPolicy(2026), 'adhoc', details, balance(4999));
    expect(over.flags).toContainEqual(expect.objectContaining({ code: 'OC-11', severity: 'block' }));
    expect(over.offcycleBalance.remainingCents).toBe(-1);
  });
  it('a mid-year set adds every person against the same company balance; EC-plan awards never draw on it', () => {
    const a = e(), b = { ...e(), id: 'two', source: { ...e().source, employmentId: 'two', personId: 'two', grade: 'H', basicCents: 300000 } };
    const result = calculateOffcycle([a, b], defaultPolicy(2026), 'midyear', details, balance(7999));
    expect(result.offcycleBalance.requestCents).toBe(8000);
    expect(result.flags).toContainEqual(expect.objectContaining({ code: 'OC-11', severity: 'block' }));
    const ec = e(); ec.facts.confidentiality = 'ec';
    const exception = { ...details, exceptionReason: 'Retention case that cannot wait for the next cycle' };
    expect(calculateOffcycle([ec], defaultPolicy(2026), 'adhoc', exception, balance(0)).offcycleBalance.requestCents).toBe(0);
  });
  it('keeps budget exceptions isolated to an individual and still checks eligibility', () => {
    const entry = e(); entry.source.notice = true;
    const d = { ...details, exceptionReason: 'A separately authorized budget exception' };
    const r = calculateOffcycle([entry], defaultPolicy(2026), 'adhoc', d, balance(0));
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'OC-11', severity: 'exception' }));
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'OC-04', severity: 'block' }));
    expect(calculateOffcycle([e()], defaultPolicy(2026), 'midyear', d, balance(0)).flags).toContainEqual(expect.objectContaining({ code: 'OC-02', severity: 'block' }));
  });
  it('routes JG 22 and above (current or new grade) to EC, budget exceptions on their own through BG, GR, CTRO and EC; mid-year ends with GR', () => {
    const entry = e(); entry.recommendation.promotionGrade = '22';
    expect(offcycleRoute('adhoc', details, [entry])).toEqual(['bu', 'bg', 'gr', 'ctro', 'ec']);
    expect(offcycleRoute('adhoc', details, [e()])).toEqual(['bu', 'bg', 'gr', 'ctro']);
    const current22 = e(); current22.source.grade = '22';
    expect(offcycleRoute('adhoc', details, [current22])).toEqual(['bu', 'bg', 'gr', 'ctro', 'ec']);
    const jg = e(); jg.source.grade = 'JG 23';
    expect(offcycleRoute('adhoc', details, [jg])).toEqual(['bu', 'bg', 'gr', 'ctro', 'ec']);
    const h = e(); h.source.grade = 'H';
    expect(offcycleRoute('adhoc', details, [h])).toEqual(['bu', 'bg', 'gr', 'ctro']);
    const exception = { ...details, exceptionReason: 'Retention case that cannot wait for the next cycle' };
    expect(offcycleRoute('adhoc', exception, [e()])).toEqual(['bg', 'gr', 'ctro', 'ec']);
    expect(offcycleRoute('adhoc', { ...details, bgOrigin: true }, [e()])).toEqual(['bg', 'gr', 'ctro']);
    expect([offcycleReturnSeat(exception), offcycleReturnSeat(details), offcycleReturnSeat({ ...details, bgOrigin: true })]).toEqual(['bg', 'bu', 'bg']);
    expect(offcycleTransition('draft', ['bg'], 'submit', ['bg', 'gr', 'ctro', 'ec'])).toBe('gr');
    expect(() => offcycleTransition('draft', ['bu'], 'submit', ['bg', 'gr', 'ctro', 'ec'])).toThrow();
    expect(offcycleTransition('ec', ['ec'], 'approve', ['bg', 'gr', 'ctro', 'ec'])).toBe('approved');
    expect(offcycleRoute('midyear', details, [e()])).toEqual(['bu', 'bg', 'gr']);
    expect(offcycleTransition('gr', ['gr'], 'approve', ['bu', 'bg', 'gr'])).toBe('approved');
    expect(offcycleTransition('gr', ['gr'], 'reject', ['bu', 'bg', 'gr'])).toBe('rejected');
    expect(() => offcycleTransition('bg', ['bu'], 'approve', ['bu', 'bg', 'gr'])).toThrow();
  });
  it('requires distinct promotion role summaries and a valid grade advance', () => {
    const entry = e(); entry.recommendation.promotionGrade = '25';
    const result = calculateOffcycle([entry], defaultPolicy(2026), 'adhoc', details, balance(100000));
    expect(result.flags.map(f => f.code)).toContain('OC-06'); expect(result.flags.map(f => f.code)).toContain('OC-07');
  });
  it('compares source statements without inventing a promotion verdict', () => {
    const current = 'Analyst\nPrepare monthly operations reports for one department.\nReview quality records.';
    const proposed = 'Senior analyst\nLead reporting across three departments.\nReview quality records.';
    const r = compareRoleDescriptions(current, proposed);
    expect(r.added).toContain('Lead reporting across three departments.');
    expect(r.removed).toContain('Prepare monthly operations reports for one department.');
    expect(r.unchanged).toEqual(['Review quality records.']); expect(r).not.toHaveProperty('verdict');
    expect(compareRoleDescriptions(current, current.toUpperCase()).identical).toBe(true);
    expect(() => compareRoleDescriptions('x'.repeat(30001), proposed)).toThrow();
  });
  it('applies the blackout from 1 October to 31 January, the October-December year-end exclusion and the mid-year window', () => {
    expect(['2027-09-30', '2027-10-01', '2027-12-31', '2028-01-01', '2028-01-31', '2028-02-01'].map(offcycleBlackout)).toEqual([false, true, true, true, true, false]);
    expect(['2027-09-30', '2027-10-01', '2027-12-31', '2028-01-01'].map(offcycleYearEndExclusion)).toEqual([null, 2027, 2027, null]);
    const window = { from: '2027-06-01', to: '2027-06-30' };
    expect(['2027-05-31', '2027-06-01', '2027-06-30', '2027-07-01'].map(day => offcycleMidyearOpen(window, day))).toEqual([false, true, true, false]);
    expect(offcycleMidyearOpen({ from: null, to: null }, '2027-06-15')).toBe(false);
  });
  it('reports compa-ratio and position in range before and after, on the new grade for a promotion', () => {
    const policy = { ranges: { '21': [400000, 500000, 600000] as [number, number, number], '22': [550000, 700000, 850000] as [number, number, number] } };
    expect(offcyclePayPosition(policy, { source: { basicCents: 500000, grade: '21' }, newBasicCents: 650000, recommendation: { promotionGrade: null } }))
      .toEqual({ before: { crBp: 10000, position: 'within', range: [400000, 500000, 600000] }, after: { crBp: 13000, position: 'above', range: [400000, 500000, 600000] } });
    expect(offcyclePayPosition(policy, { source: { basicCents: 500000, grade: '21' }, newBasicCents: 540000, recommendation: { promotionGrade: '22' } }).after).toEqual({ crBp: 7714, position: 'below', range: [550000, 700000, 850000] });
    expect(offcyclePayPosition(policy, { source: { basicCents: 500000, grade: '9' }, newBasicCents: 500000, recommendation: {} }).before).toEqual({ crBp: null, position: 'unknown', range: null });
  });
  it('uses the reward year\'s Limit Controls version; with none the checks are the previous ones', () => {
    const entry = e(); entry.recommendation.meritBp = 1100;
    const baseline = calculateOffcycle([entry], defaultPolicy(2026), 'adhoc', details, balance(1_000_000));
    expect(baseline.flags).toContainEqual(expect.objectContaining({ code: 'INC-01', severity: 'warning' }));
    const values = baselineRewardLimitValues(); values['increase.withoutPromotion'] = { value: 1200, type: 'block' }; values['promotion.maxGrade'] = { value: 21, type: 'block' };
    const limits = versionRewardLimits({ id: '00000000-0000-4000-8000-000000000001', revision: 3, year: 2026, values: Object.fromEntries(rewardConfigurableLimitKeys.map(key => [key, values[key]])) });
    const versioned = calculateOffcycle([entry], defaultPolicy(2026), 'adhoc', details, balance(1_000_000), limits);
    expect(versioned.flags.map(f => f.code)).not.toContain('INC-01'); expect(versioned.limitVersion).toBe(3);
    entry.recommendation.meritBp = 1300;
    expect(calculateOffcycle([entry], defaultPolicy(2026), 'adhoc', details, balance(1_000_000), limits).flags).toContainEqual(expect.objectContaining({ code: 'INC-01', severity: 'block' }));
    const promoted = e(); promoted.source.grade = '20'; promoted.recommendation.promotionGrade = '22';
    expect(calculateOffcycle([promoted], defaultPolicy(2026), 'adhoc', details, balance(1_000_000), limits).flags).toContainEqual(expect.objectContaining({ code: 'OC-06', severity: 'block' }));
    expect(calculateOffcycle([promoted], defaultPolicy(2026), 'adhoc', details, balance(1_000_000)).flags.map(f => f.code)).not.toContain('OC-06');
  });
  it('keeps the Year-end cycle / Off-cycle switch in the saved dashboard preference', () => {
    expect(decodeRewardDashboardPreference({ version: 2, kind: 'offcycle', period: 'annual', businessUnit: 'all', companies: [] }).kind).toBe('offcycle');
    expect(decodeRewardDashboardPreference({ version: 2, kind: 'mid-year', period: 'annual' }).kind).toBe('annual');
    expect(decodeRewardDashboardPreference(null).kind).toBe('annual');
    expect(storedRewardDashboardPreference({ version: 2, kind: 'offcycle', period: 'monthly', businessUnit: '', companies: [] })).toEqual({ version: 2, kind: 'offcycle', period: 'monthly', businessUnit: '', companies: [] });
  });
});
