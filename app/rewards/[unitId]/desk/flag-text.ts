import type { RewardFlag } from '@/packs/rewards/model';

/* 37f82412 — flag wording and destinations, free of server imports so the client Flags drawer can use them. */

/** Where "Go to section" takes a flag that is not about one person. */
export function flagSection(flag: Pick<RewardFlag, 'code' | 'message'>): 'salary-increase' | 'bonus' | 'people' {
  // The engine reuses CFG-01 for both exempted salary-pool and bonus-pool overruns.
  if (flag.code === 'CFG-01') return /\bbonus\b/i.test(flag.message) ? 'bonus' : 'salary-increase';
  return flag.code.startsWith('SAL') || flag.code.startsWith('POOL') ? 'salary-increase' : flag.code.startsWith('BUD') || flag.code.startsWith('PAT') ? 'bonus' : 'people';
}

/**
 * Plain-language wording for the engine's fixed flag messages, as a translation key under rewards.flagText
 * with its values. The engine keeps one English message per rule; null means "show the message as it is".
 */
export type FlagText = { key: string; plan?: 'standard' | 'h'; part?: 'merit' | 'promotion' | 'special' };
export function flagText(flag: Pick<RewardFlag, 'code' | 'message'>): FlagText | null {
  const m = flag.message, plan = (s: string) => s === 'JG H' ? 'h' as const : 'standard' as const;
  const pool = /^(Standard|JG H) (merit|promotion|special adjustment) exceeds its separate pool/.exec(m);
  if (pool) return { key: 'poolOver', plan: plan(pool[1]), part: pool[2] === 'special adjustment' ? 'special' : pool[2] as 'merit' | 'promotion' };
  const over = /^(Standard|JG H) bonus exceeds the 100% budget cap/.exec(m);
  if (over) return { key: 'bonusOver', plan: plan(over[1]) };
  const under = /^(Standard|JG H) bonus budget is less than 80% utilised/.exec(m);
  if (under) return { key: 'bonusUnder', plan: plan(under[1]) };
  const fixed: Record<string, Record<string, string> | string> = {
    'DATA-01': 'dataUnverified', 'DATA-02': 'salaryRecord', 'DATA-03': 'noRange', 'DATA-04': 'noBonusMonths',
    'ELIG-02': { 'Record the BU CEO and PBP case decision.': 'caseDecision', 'Record the reason for the case decision.': 'caseReason' },
    'PRO-01': 'promotionSteps', 'PRO-02': 'promotionCase', 'PRO-03': 'promotionIneligible',
    'POOL-05': { 'Individual merit differs from the matrix.': 'meritChanged', 'Promotion differs from the standard 10%.': 'promotionChanged', 'Special adjustment differs from the calculated amount.': 'specialChanged' },
    'INC-01': 'largeIncrease', 'RANGE-01': 'aboveRange', 'BUD-02': 'bonusChanged', 'PPCH-01': 'branchRating', 'PAT-01': 'patMissing',
    'SAL-01': 'salaryReduction', 'ACCESS-01': 'restricted',
  };
  const entry = fixed[flag.code];
  if (typeof entry === 'string') return { key: entry };
  if (entry?.[m]) return { key: entry[m] };
  if (flag.code === 'BUD-05') {
    if (m.startsWith('The unit lump sum exceeds')) return { key: 'lumpAboveBudget' };
    if (m.startsWith('The unit lump-sum provision is withheld')) return { key: 'lumpWithheld' };
    if (m.startsWith('Individual lump sum differs')) return { key: 'lumpChanged' };
  }
  return null;
}
