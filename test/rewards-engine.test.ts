import { describe, expect, it } from 'vitest';
import { calculateRewards } from '../packs/rewards/engine';
import { defaultPolicy, emptyFacts, emptyRecommendation, transition, visibleEntry, type RewardEntry } from '../packs/rewards/model';

const policy = () => ({ ...defaultPolicy(2026), patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] as [number, number, number], H: [100000, 200000, 300000] as [number, number, number] } });
const entry = (id = 'a'): RewardEntry => ({ id, source: { employmentId: id, personId: `person-${id}`, compensationId: `comp-${id}`, gradeId: null, employeeCode: id, name: id, grade: '12', basicCents: 500000, currency: 'MYR', payMode: 'monthly', hiredOn: '2020-01-01', confirmedOn: '2020-04-01', notice: false, lastPayChange: null, confirmationPayChange: false, performanceReviewId: null, performanceRating: null }, facts: { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' }, recommendation: emptyRecommendation() });

describe('Reward Desk deterministic calculation and confidentiality', () => {
  it('prices matrix merit and bonus within independent pools', () => {
    const r = calculateRewards([entry()], policy());
    expect(r.rows[0].meritCents).toBe(22500);
    expect(r.budgets.standard.pools).toEqual([25000, 5000, 5000]);
    expect(r.rows[0].bonusCents).toBe(997500);
    expect(r.flags.filter(f => f.severity === 'block')).toEqual([]);
  });
  it('positive bonus on a zero budget blocks instead of dividing to zero', () => {
    const p = { ...policy(), patActual: 0, multiplierBp: 10000 };
    const r = calculateRewards([entry()], p);
    expect(r.budgets.standard.bonusPoolCents).toBe(0);
    expect(r.budgets.standard.bonusUsedCents).toBeGreaterThan(0);
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'BUD-01', severity: 'block' }));
  });
  it('budget exemptions lift only budget caps', () => {
    const e = entry(); e.facts.pipCase = true;
    const r = calculateRewards([e], { ...policy(), patActual: 0, multiplierBp: 10000, exemptReason: 'Acquisition integration' });
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'CFG-01', severity: 'review' }));
    expect(r.flags).toContainEqual(expect.objectContaining({ code: 'ELIG-02', severity: 'block' }));
  });
  it('does not use EC salary or bonus in standard or H budgets', () => {
    const ec = entry('ec'); ec.facts.confidentiality = 'ec'; ec.recommendation.bonusCents = 9999999; ec.recommendation.meritBp = 9000;
    const r = calculateRewards([entry(), ec], policy());
    expect(r.budgets.standard.payrollCents).toBe(500000);
    expect(r.budgets.ec.bonusUsedCents).toBe(9999999);
    expect(r.flags.some(f => f.code === 'INC-01' && f.entryId === ec.id)).toBe(false);
  });
  it('separates H increment pools while applying the same merit matrix', () => {
    const h = entry('h'); h.source.grade = 'H'; h.source.basicCents = 200000;
    const r = calculateRewards([entry(), h], policy());
    expect(r.budgets.h.pools).toEqual([10000, 2000, 2000]);
    expect(r.rows[1].meritBp).toBe(r.rows[0].meritBp);
  });
  it('chooses the limiting bonus multiplier across the independent plans', () => {
    const h = entry('h'); h.source.grade = 'H'; h.source.basicCents = 200000; h.facts.performance = 'OU';
    const r = calculateRewards([entry(), h], policy());
    expect(r.suggestedMultiplierBp).toBe(10000);
    expect(r.budgets.h.bonusUsedCents).toBeLessThanOrEqual(r.budgets.h.bonusPoolCents);
  });
  it('distributes a BU-specific balance equally, with zero and individual deviations explicit', () => {
    const a = entry('a'), b = entry('b'); a.source.notice = true; b.source.notice = true;
    const p = { ...policy(), multiplierBp: 10000 };
    const r = calculateRewards([entry(), a, b], p);
    expect(r.suggestedLumpCents).toBe(125000);
    expect(r.rows.slice(1).map(x => x.lumpCents)).toEqual([125000, 125000]);
    a.recommendation.lumpCents = 0;
    const overridden = calculateRewards([entry(), a, b], p);
    expect(overridden.rows[1].lumpCents).toBe(0);
    expect(overridden.flags).toContainEqual(expect.objectContaining({ severity: 'exception', code: 'BUD-05', entryId: 'a' }));
    expect(overridden.budgets.standard.bonusUsedCents).toBe(875000);
  });
  it('lump sum takes the minimum across the two plans, not money from another plan', () => {
    const a = entry('a'); a.source.notice = true;
    const h = entry('h'); h.source.grade = 'H'; h.source.basicCents = 200000;
    const hl = entry('hl'); hl.source.grade = 'H'; hl.source.notice = true;
    const r = calculateRewards([entry(), a, h, hl], { ...policy(), multiplierBp: 10000 });
    expect(r.suggestedLumpCents).toBe(200000);
    expect(r.rows.filter(x => x.lumpEligible).map(x => x.lumpCents)).toEqual([200000, 200000]);
  });
  it('keeps ER, senior leadership and EC out of the ordinary lump sum', () => {
    const er = entry('er'); er.facts.erCase = true;
    const senior = entry('senior'); senior.facts.seniorPlan = true;
    const ec = entry('ec'); ec.facts.confidentiality = 'ec'; ec.source.notice = true;
    expect(calculateRewards([er, senior, ec], policy()).rows.every(x => !x.lumpEligible)).toBe(true);
  });
  it('branch structure requires explicit segment and branch rating', () => {
    const e = entry(); const p = { ...policy(), bonusStructure: 'branch' as const };
    expect(calculateRewards([e], p).flags).toContainEqual(expect.objectContaining({ code: 'PPCH-01', severity: 'block' }));
    e.facts.branch = 'North'; e.facts.segment = 'Sales';
    p.branchRatings = { North: 'ME' }; p.branchFactors = { Sales: [0, 5000, 12000, 15000, 20000] };
    expect(calculateRewards([e], p).rows[0].bonusCents).toBe(900000);
  });
  it('supports leap years and never pays a negative joiner proration', () => {
    const e = entry(); e.source.hiredOn = '2024-12-31';
    expect(calculateRewards([e], { ...policy(), year: 2024, multiplierBp: 10000 }).rows[0].bonusCents).toBe(2000);
    e.source.hiredOn = '2025-01-01';
    expect(calculateRewards([e], { ...policy(), year: 2024, multiplierBp: 10000 }).rows[0].bonusCents).toBe(0);
  });
  it('rejects NaN, negative and fractional-cents inputs', () => {
    for (const n of [NaN, -1, .5, Infinity]) {
      const e = entry(); e.recommendation.lumpCents = n;
      expect(() => calculateRewards([e], policy())).toThrow();
    }
  });
  it('does not let an ineligible annual promotion change the employment grade', () => {
    const e = entry(); e.source.notice = true; e.recommendation.promotionGrade = '13'; e.recommendation.reason = 'Expanded responsibilities for the proposed role';
    expect(calculateRewards([e], policy()).flags).toContainEqual(expect.objectContaining({ code: 'PRO-03', severity: 'block' }));
  });
  it('withholds own-person, confidential and unverified records at the server projection', () => {
    const e = entry(); expect(visibleEntry(e, ['gr'], e.source.personId)).toBe(false);
    e.facts.confidentiality = 'ec';
    for (const role of ['bu', 'bg', 'pbp', 'payroll'] as const) expect(visibleEntry(e, [role])).toBe(false);
    expect(visibleEntry(e, ['gr'])).toBe(true);
    e.facts.confidentiality = 'bg'; expect(visibleEntry(e, ['bu'])).toBe(false); expect(visibleEntry(e, ['bg'])).toBe(true);
    e.facts.reviewed = false; expect(visibleEntry(e, ['bg'])).toBe(false);
  });
  it('requires every approval stage, and never lets read-only roles submit', () => {
    let stage = transition('draft', ['bu'], 'submit');
    for (const r of ['bg', 'gr', 'ctro', 'ec'] as const) stage = transition(stage, [r], 'approve');
    expect(stage).toBe('approved');
    expect(() => transition('draft', ['pbp'], 'submit')).toThrow();
    expect(() => transition('bg', ['ec'], 'approve')).toThrow();
    expect(transition('ctro', ['ctro'], 'return')).toBe('draft');
  });
});
