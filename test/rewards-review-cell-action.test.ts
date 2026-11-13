import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import { calculateRewards } from '../packs/rewards/engine';
import { defaultPolicy, emptyFacts, emptyRecommendation, type RewardEntry } from '../packs/rewards/model';

/** 37f82412 — one People-table cell saves through saveRewardEntry and answers with the server's figures. */
const ports = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as 'rewards' }) }));
vi.mock('../lib/session', () => ({ getSession: async () => ({ tenantId: 't', userId: 'fictional-user' }) }));
vi.mock('../packs/rewards/service', async importOriginal => ({ ...(await importOriginal<object>()), getRewardUnit: ports.read, saveRewardEntry: ports.save }));
import { saveRewardCell } from '../app/rewards/actions';

const source = (id: string): RewardEntry['source'] => ({ employmentId: `emp-${id}`, personId: `person-${id}`, compensationId: `comp-${id}`, employeeCode: `E-${id}`, name: `Fictional ${id}`, grade: '14', gradeId: null, basicCents: 500000, currency: 'MYR', payMode: 'monthly', hiredOn: '2020-01-01', confirmedOn: '2020-06-01', notice: false, lastPayChange: null, confirmationPayChange: false, performanceReviewId: null, performanceRating: null });
const policy = { ...defaultPolicy(2026), patActual: 100, patTarget: 100, ranges: { '14': [400000, 500000, 650000] as [number, number, number] } };
function view(meritBp: number | null, status = 'draft', revision = 3) {
  const calc = calculateRewards([{ id: 'a', source: source('a'), facts: { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' }, recommendation: { ...emptyRecommendation(), meritBp } }], policy);
  return { unit: { id: 'unit', kind: 'annual', status, revision, policy }, roles: ['bu'], canEdit: true, uploaded: false, approvalStageEdit: false, seniorAmountsVisible: false,
    rows: calc.rows.map(r => ({ ...r, crBeforeBp: null, crAfterBp: null, totalIncreaseBp: r.meritBp + r.promotionBp + r.specialBp })), flags: calc.flags,
    budgets: { standard: calc.budgets.standard, h: calc.budgets.h }, suggestedMultiplierBp: calc.suggestedMultiplierBp, suggestedLumpCents: calc.suggestedLumpCents, lumpUnitCents: calc.lumpUnitCents };
}
afterEach(() => vi.clearAllMocks());

describe('saveRewardCell', () => {
  it('stores the typed percentage as basis points and returns the recalculated row, tiles and Total row', async () => {
    ports.read.mockResolvedValueOnce(view(null)).mockResolvedValueOnce(view(625, 'draft', 4));
    const result = await saveRewardCell('unit', 3, 'a', 'meritBp', '6.25', { plan: 'standard' });
    expect(ports.save).toHaveBeenCalledWith(expect.anything(), 'unit', 3, 'a', expect.objectContaining({ meritBp: 625 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(4);
    expect(result.row?.meritBp).toBe(625);
    expect(result.row?.overrides.meritBp).toBe(true);
    // 5,000.00 at 6.25% is 312.50, rounded by the engine to whole ringgit: 313.00.
    expect(result.row?.newBasicCents).toBe(531300);
    expect(result.totals).toMatchObject({ people: 1, newBasicCents: 531300 });
    expect(result.summary.plans.standard.salaryUsedCents).toBe(31300);
  });
  it('clears a promotion grade together with its percentage, and resets an override with an empty value', async () => {
    ports.read.mockResolvedValue(view(null));
    await saveRewardCell('unit', 3, 'a', 'promotionGrade', '');
    expect(ports.save).toHaveBeenLastCalledWith(expect.anything(), 'unit', 3, 'a', expect.objectContaining({ promotionGrade: null, promotionBp: null }));
    await saveRewardCell('unit', 3, 'a', 'meritBp', '');
    expect(ports.save).toHaveBeenLastCalledWith(expect.anything(), 'unit', 3, 'a', expect.objectContaining({ meritBp: null }));
  });
  it('refuses malformed values and cells the viewer cannot change, without saving', async () => {
    ports.read.mockResolvedValue(view(null));
    expect(await saveRewardCell('unit', 3, 'a', 'meritBp', '6.255')).toEqual({ ok: false, stale: false, error: en.rewards.desk.cell.invalid.percent });
    expect(await saveRewardCell('unit', 3, 'a', 'lumpCents', 'abc')).toEqual({ ok: false, stale: false, error: en.rewards.desk.cell.invalid.amount });
    expect(await saveRewardCell('unit', 3, 'a', 'note', 'x'.repeat(2001))).toEqual({ ok: false, stale: false, error: en.rewards.desk.cell.invalid.note });
    expect(await saveRewardCell('unit', 3, 'a', 'bonusCents' as 'note', '1')).toMatchObject({ ok: false });
    // The person is not lump-sum eligible (they receive a bonus), so the lump cell is closed.
    expect(await saveRewardCell('unit', 3, 'a', 'lumpCents', '100')).toEqual({ ok: false, stale: false, error: en.rewards.desk.cell.notEditable });
    ports.read.mockResolvedValue(view(null, 'bg'));
    expect(await saveRewardCell('unit', 3, 'a', 'meritBp', '5')).toEqual({ ok: false, stale: false, error: en.rewards.desk.cell.notEditable });
    expect(ports.save).not.toHaveBeenCalled();
  });
  it('reports a save refused because the review changed elsewhere as stale', async () => {
    ports.read.mockResolvedValue(view(null));
    ports.save.mockRejectedValueOnce(new Error('This review changed in another session. Reload before saving.'));
    expect(await saveRewardCell('unit', 2, 'a', 'meritBp', '5')).toEqual({ ok: false, stale: true, error: en.rewards.desk.cell.stale });
  });
});
