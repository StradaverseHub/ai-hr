import { REWARD_NOTE_MAX, type Recommendation, type RewardFacts } from './model';

/** A cell patch is applied to the locked entry, never to a client snapshot of the recommendation. */
export const rewardCellFields = ['meritBp','promotionBp','specialBp','promotionGrade','multiplierBp','lumpCents','note','reason','erDecision','pipDecision','caseReason','withhold'] as const;
export type RewardCellField = typeof rewardCellFields[number];
export type RewardCellValue = number | string | null | { award: 'increase' | 'bonus' | 'lump'; reason: string };
export class RewardCellInputError extends Error { constructor(readonly kind: 'note' | 'grade' | 'amount' | 'multiplier' | 'percent' | 'withhold' | 'decision') { super(kind); } }
export function parseRewardCellValue(field: RewardCellField, value: string): RewardCellValue {
  if (!(rewardCellFields as readonly string[]).includes(field) || typeof value !== 'string') throw new RewardCellInputError('percent');
  if (field === 'withhold') {
    try { const input = JSON.parse(value); if (!['increase','bonus','lump'].includes(input.award) || typeof input.reason !== 'string' || input.reason.length > 1000 || (input.reason.trim() && input.reason.trim().length < 10)) throw new Error(); return { award: input.award, reason: input.reason.trim() }; } catch { throw new RewardCellInputError('withhold'); }
  }
  if (field === 'reason' || field === 'caseReason') { if (value.length > (field === 'reason' ? 4000 : 3000)) throw new RewardCellInputError('note'); return value.trim(); }
  if (field === 'erDecision' || field === 'pipDecision') { if (!(field === 'erDecision' ? ['pending','in','out'] : ['pending','lift','confirm']).includes(value)) throw new RewardCellInputError('decision'); return value; }
  if (field === 'note') { if (value.length > REWARD_NOTE_MAX) throw new RewardCellInputError('note'); return value.trim(); }
  if (value.trim() === '') return null;
  if (field === 'promotionGrade') { if (!/^[A-Za-z0-9]{1,30}$/.test(value.trim())) throw new RewardCellInputError('grade'); return value.trim(); }
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value.trim())) throw new RewardCellInputError(field === 'lumpCents' ? 'amount' : field === 'multiplierBp' ? 'multiplier' : 'percent');
  return Math.round(Number(value) * (field === 'multiplierBp' ? 10000 : 100));
}
export function applyRewardCell(entry: { recommendation: Recommendation; facts: RewardFacts }, field: RewardCellField, value: RewardCellValue): { recommendation: Recommendation; facts?: RewardFacts } {
  if (field === 'erDecision' || field === 'pipDecision' || field === 'caseReason') return { recommendation: entry.recommendation, facts: { ...entry.facts, [field]: value } };
  if (field === 'withhold' && typeof value === 'object' && value !== null) {
    const withhold = { ...entry.recommendation.withhold };
    if (value.reason) withhold[value.award] = value.reason; else delete withhold[value.award];
    return { recommendation: { ...entry.recommendation, withhold } };
  }
  if (field === 'promotionGrade') return { recommendation: { ...entry.recommendation, promotionGrade: value as string | null, promotionBp: null } };
  return { recommendation: { ...entry.recommendation, [field]: value } };
}
