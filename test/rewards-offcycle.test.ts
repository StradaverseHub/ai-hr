import { describe, expect, it } from 'vitest';
import { calculateOffcycle, offcycleRoute, offcycleTransition } from '../packs/rewards/offcycle';
import { compareRoleDescriptions } from '../packs/rewards/role-summary';
import { defaultPolicy, emptyFacts, emptyRecommendation, type RewardEntry } from '../packs/rewards/model';
const e = (): RewardEntry => ({ id: 'one', source: { employmentId: 'one', personId: 'one', compensationId: 'salary', gradeId: 'grade', name: 'Employee', employeeCode: 'one', grade: '21', basicCents: 500000, currency: 'MYR', payMode: 'monthly', hiredOn: '2020-01-01', confirmedOn: '2020-04-01', notice: false, lastPayChange: null, confirmationPayChange: false, performanceReviewId: null, performanceRating: null }, facts: { ...emptyFacts(), reviewed: true }, recommendation: { ...emptyRecommendation(), meritBp: 100, reason: 'Expanded responsibilities in the team' } });
const details = { exceptionReason: '', bgOrigin: false };
describe('off-cycle policy and role comparisons', () => {
  it('uses monthly deltas and cannot borrow from the other plan', () => {
    const result = calculateOffcycle([e()], defaultPolicy(2026), 'adhoc', details, { standard: 0, h: 100000 });
    expect(result.rows[0].newBasicCents).toBe(505000);
    expect(result.flags).toContainEqual(expect.objectContaining({ code: 'OC-11', severity: 'block' }));
  });
  it('keeps budget exceptions isolated to an individual and still checks eligibility', () => {
    const entry = e(); entry.source.notice = true;
    const d = { ...details, exceptionReason: 'A separately authorized budget exception' };
    const r = calculateOffcycle([entry], defaultPolicy(2026), 'adhoc', d, { standard: 0, h: 0 });
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'OC-11', severity: 'exception' }));
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'OC-04', severity: 'block' }));
    expect(calculateOffcycle([e()], defaultPolicy(2026), 'midyear', d, { standard: 0, h: 0 }).flags).toContainEqual(expect.objectContaining({ code: 'OC-02', severity: 'block' }));
  });
  it('routes grade 22 promotions and budget exceptions to EC; mid-year ends with GR', () => {
    const entry = e(); entry.recommendation.promotionGrade = '22';
    expect(offcycleRoute('adhoc', details, [entry])).toEqual(['bu', 'bg', 'gr', 'ctro', 'ec']);
    expect(offcycleRoute('adhoc', details, [e()])).toEqual(['bu', 'bg', 'gr', 'ctro']);
    expect(offcycleRoute('midyear', details, [e()])).toEqual(['bu', 'bg', 'gr']);
    expect(offcycleTransition('gr', ['gr'], 'approve', ['bu', 'bg', 'gr'])).toBe('approved');
    expect(offcycleTransition('gr', ['gr'], 'reject', ['bu', 'bg', 'gr'])).toBe('rejected');
    expect(() => offcycleTransition('bg', ['bu'], 'approve', ['bu', 'bg', 'gr'])).toThrow();
  });
  it('requires distinct promotion role summaries and a valid grade advance', () => {
    const entry = e(); entry.recommendation.promotionGrade = '25';
    const result = calculateOffcycle([entry], defaultPolicy(2026), 'adhoc', details, { standard: 100000, h: 0 });
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
});
