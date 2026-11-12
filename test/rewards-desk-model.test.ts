import { describe, expect, it } from 'vitest';
import { calculateRewards } from '../packs/rewards/engine';
import { defaultPolicy, emptyFacts, emptyRecommendation, type RewardEntry } from '../packs/rewards/model';
import { deskCellsEditable, deskRow, deskSummary, deskTotals, filterDeskRows, parseDeskFilters, type RewardView } from '../app/rewards/[unitId]/desk/desk-model';
import { flagSection, flagText } from '../app/rewards/[unitId]/desk/flag-text';

/** 37f82412 — the People table model: who may edit which cell, filters, totals and plain flag wording. */
const entry = (id: string, over: Partial<RewardEntry['source']> = {}, facts: Partial<RewardEntry['facts']> = {}): RewardEntry => ({
  id, recommendation: emptyRecommendation(), facts: { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME', ...facts },
  source: { employmentId: `emp-${id}`, personId: `person-${id}`, compensationId: `comp-${id}`, employeeCode: `E-${id}`, name: `Fictional ${id}`, grade: '14', gradeId: null, basicCents: 500000, currency: 'MYR', payMode: 'monthly', hiredOn: '2020-01-01', confirmedOn: '2020-06-01', notice: false, lastPayChange: null, confirmationPayChange: false, performanceReviewId: null, performanceRating: null, ...over },
});
const policy = { ...defaultPolicy(2026), patActual: 100, patTarget: 100, ranges: { '14': [400000, 500000, 650000] as [number, number, number], '15': [450000, 560000, 700000] as [number, number, number] } };
function viewOf(over: Partial<RewardView> = {}, entries = [entry('a'), entry('b', { grade: 'H' }), entry('c', {}, { talent: 'STAR' })]): RewardView {
  const calc = calculateRewards(entries, policy);
  const rows = calc.rows.map(r => ({ ...r, crBeforeBp: 10000, crAfterBp: 10500, totalIncreaseBp: r.meritBp + r.promotionBp + r.specialBp }));
  return { unit: { id: 'unit', kind: 'annual', status: 'draft', revision: 3, policy }, roles: ['bu'], canEdit: true, uploaded: false, approvalStageEdit: false, seniorAmountsVisible: false,
    rows, flags: calc.flags, budgets: { standard: calc.budgets.standard, h: calc.budgets.h }, suggestedMultiplierBp: calc.suggestedMultiplierBp, suggestedLumpCents: calc.suggestedLumpCents, lumpUnitCents: calc.lumpUnitCents, ...over } as unknown as RewardView;
}

describe('Review tab People model (37f82412)', () => {
  it('reports bonus months as matrix months times the applied multiplier, from the engine', () => {
    const calc = calculateRewards([entry('a')], { ...policy, multiplierBp: 12000 });
    // JG 14 at ME is 1.5 months in the default bonus matrix; 1.5 × 1.2 = 1.8 months.
    expect(calc.rows[0].bonusMonthsBp).toBe(18000);
    expect(calculateRewards([entry('a', {}, { performance: null })], policy).rows[0].bonusMonthsBp).toBe(0);
  });
  it('opens cells to the BU CEO in draft and the BG CEO at their own step only', () => {
    expect(deskCellsEditable(viewOf())).toBe(true);
    expect(deskCellsEditable(viewOf({ unit: { ...viewOf().unit, status: 'bg' } as RewardView['unit'] }))).toBe(false);
    expect(deskCellsEditable(viewOf({ unit: { ...viewOf().unit, status: 'bg' } as RewardView['unit'], roles: ['bg'] }))).toBe(true);
    expect(deskCellsEditable(viewOf({ unit: { ...viewOf().unit, status: 'gr' } as RewardView['unit'], roles: ['gr'] }))).toBe(false);
    expect(deskCellsEditable(viewOf({ unit: { ...viewOf().unit, status: 'gr' } as RewardView['unit'], roles: ['gr'], approvalStageEdit: true }))).toBe(true);
    expect(deskCellsEditable(viewOf({ canEdit: false }))).toBe(false);
    expect(deskCellsEditable(viewOf({ uploaded: true }))).toBe(false);
  });
  it('keeps Senior plan figures hidden and not editable, and offers promotion grades one to three steps up', () => {
    const v = viewOf({}, [entry('a'), entry('s', { grade: '14' }, { seniorPlan: true })]);
    const senior = deskRow(v, v.rows.find(r => r.id === 's')!, v.flags);
    expect(senior.meritBp).toBeNull(); expect(senior.newBasicCents).toBeNull(); expect(senior.bonusCents).toBeNull();
    expect(senior.editable).toEqual({ increase: false, bonus: false, lump: false });
    const plain = deskRow(v, v.rows.find(r => r.id === 'a')!, v.flags);
    expect(plain.editable.increase).toBe(true);
    expect(plain.promotionGrades).toEqual(['15']);
    expect(plain.meritBp).toBe(450);
  });
  it('filters the whole visible set from the address and totals the filtered rows in integer cents', () => {
    const v = viewOf();
    expect(parseDeskFilters({ f: 'flags', plan: 'h', talent: 'STAR', q: ' ', jg: '14', perf: 'x'.repeat(20), extra: 'ignored' })).toEqual({ f: 'flags', plan: 'h', talent: 'STAR', jg: '14' });
    expect(filterDeskRows(v.rows, v.flags, { plan: 'h' }).map(r => r.id)).toEqual(['b']);
    expect(filterDeskRows(v.rows, v.flags, { talent: 'STAR' }).map(r => r.id)).toEqual(['c']);
    expect(filterDeskRows(v.rows, v.flags, { q: 'e-a' }).map(r => r.id)).toEqual(['a']);
    const rows = v.rows.map(r => deskRow(v, r, v.flags));
    const totals = deskTotals(rows);
    expect(totals.people).toBe(3);
    expect(totals.basicCents).toBe(1500000);
    expect(totals.newBasicCents).toBe(v.rows.reduce((n, r) => n + r.newBasicCents, 0));
    const summary = deskSummary(v);
    expect(summary.plans.standard.salaryPoolCents).toBe(v.budgets.standard.pools.reduce((a, b) => a + b, 0));
    expect(summary.multiplierBp).toBe(v.suggestedMultiplierBp);
  });
  it('words engine flags plainly and sends pool flags to their section', () => {
    expect(flagText({ code: 'POOL-03', message: 'JG H special adjustment exceeds its separate pool.' })).toEqual({ key: 'poolOver', plan: 'h', part: 'special' });
    expect(flagText({ code: 'BUD-07', message: 'Standard bonus budget is less than 80% utilised.' })).toEqual({ key: 'bonusUnder', plan: 'standard' });
    expect(flagText({ code: 'POOL-05', message: 'Promotion differs from the standard 10%.' })).toEqual({ key: 'promotionChanged' });
    expect(flagText({ code: 'BUD-05', message: 'The unit lump-sum provision is withheld (RM 0).' })).toEqual({ key: 'lumpWithheld' });
    expect(flagText({ code: 'XYZ-01', message: 'Unknown rule' })).toBeNull();
    expect(flagSection({ code: 'CFG-01', message: 'Standard bonus exceeds the 100% budget cap.' })).toBe('bonus');
    expect(flagSection({ code: 'CFG-01', message: 'Standard merit exceeds its separate pool.' })).toBe('salary-increase');
    expect(flagSection({ code: 'PRO-02', message: '' })).toBe('people');
  });
});
