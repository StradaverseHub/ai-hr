import type { Talent } from './model';

export type PromotionRule = { years: number; minimum: Talent };
export type TalentHistory = { year: number; category: Talent };
export const defaultPromotionRules: PromotionRule[] = [
  { years: 5, minimum: 'Solid Core' },
  { years: 3, minimum: 'Star' },
];
const ordered: Talent[] = ['PIP/Improvement', 'Solid Core', 'Star', 'Super Star'];

/** Source standing rules: every calendar year must qualify; a missing year breaks the run. */
export function promotionStandingReason(history: TalentHistory[], lastPromotionOn: string | null, year: number, rules: PromotionRule[] = defaultPromotionRules): string | null {
  const byYear = new Map(history.map(h => [h.year, h.category]));
  const promotedYear = lastPromotionOn ? Number(lastPromotionOn.slice(0, 4)) : null;
  for (const rule of rules) {
    if (promotedYear != null && promotedYear > year - rule.years) continue;
    const floor = ordered.indexOf(rule.minimum);
    if (Array.from({ length: rule.years }, (_, offset) => byYear.get(year - offset)).every(category => category != null && ordered.indexOf(category) >= floor)) {
      return `${rule.years} years ${rule.minimum} or above, no promotion`;
    }
  }
  return null;
}

export type PromotionNomination = { userId: string; grade: string; title: string; reason: string; at: string };
export type TalentActions = {
  pip: boolean; pipReason: string;
  promotion: boolean; promotionReason: string; confirmedGrade: string; confirmedTitle: string;
  specialReward: boolean; specialRewardReason: string;
  nominations: PromotionNomination[];
};
export function emptyTalentActions(): TalentActions {
  return { pip: false, pipReason: '', promotion: false, promotionReason: '', confirmedGrade: '', confirmedTitle: '', specialReward: false, specialRewardReason: '', nominations: [] };
}
