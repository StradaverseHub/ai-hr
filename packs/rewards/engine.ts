import { type RewardEntry, type RewardPolicy, type Plan, type RewardFlag, performances, policySchema, factsSchema, recommendationSchema } from './model';

/** BigInt intermediates prevent precision loss while keeping JSON outputs as safe integers. */
export function ratio(n: number, a: number, b: number, round: 'floor' | 'nearest' = 'floor'): number {
  if (![n, a, b].every(Number.isSafeInteger) || n < 0 || a < 0 || b <= 0) throw new Error('Invalid reward arithmetic input.');
  const den = BigInt(b), numerator = BigInt(n) * BigInt(a);
  const value = Number((numerator + (round === 'nearest' ? den / BigInt(2) : BigInt(0))) / den);
  if (!Number.isSafeInteger(value)) throw new Error('Reward calculation exceeds the supported amount.');
  return value;
}
// The reference rounds increases to whole RM and floors bonus awards to whole RM.
export const increase = (cents: number, bp: number) => ratio(cents, bp, 1_000_000, 'nearest') * 100;
export const sum = (values: number[]) => values.reduce((a, b) => { const n = a + b; if (!Number.isSafeInteger(n)) throw new Error('Reward total exceeds the supported amount.'); return n; }, 0);
const dateNumber = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;

export type CalculatedEntry = RewardEntry & {
  plan: Plan; incrementEligible: boolean; bonusEligible: boolean; lumpEligible: boolean;
  incrementReason: string; bonusReason: string; meritBp: number; promotionBp: number; specialBp: number;
  meritCents: number; promotionCents: number; specialCents: number; newBasicCents: number;
  bonusCents: number; standardBonusCents: number; lumpCents: number; bonusMultiplierBp: number;
};
export type PlanBudget = { payrollCents: number; pools: number[]; used: number[]; bonusPayrollCents: number; bonusPoolCents: number; bonusUsedCents: number; standardBonusCents: number; increasesCents: number; reductionsCents: number; lumpCents: number; lumpCount: number; balanceCents: number };
export const blankBudget = (): PlanBudget => ({ payrollCents: 0, pools: [0, 0, 0], used: [0, 0, 0], bonusPayrollCents: 0, bonusPoolCents: 0, bonusUsedCents: 0, standardBonusCents: 0, increasesCents: 0, reductionsCents: 0, lumpCents: 0, lumpCount: 0, balanceCents: 0 });

export function calculateRewards(entries: RewardEntry[], input: RewardPolicy) {
  const policy = policySchema.parse(input);
  const flags: RewardFlag[] = [];
  const add = (severity: RewardFlag['severity'], code: string, message: string, entryId?: string) => flags.push({ severity, code, message, ...(entryId ? { entryId } : {}) });
  const start = `${policy.year}-01-01`, end = `${policy.year}-12-31`, yearDays = dateNumber(end) - dateNumber(start) + 1;
  const rows: CalculatedEntry[] = entries.map(e => {
    const f = factsSchema.parse(e.facts), r = recommendationSchema.parse(e.recommendation), s = e.source;
    if (!Number.isSafeInteger(s.basicCents) || s.basicCents < 0) throw new Error('Invalid salary snapshot.');
    const plan: Plan = f.confidentiality === 'ec' ? 'ec' : s.grade === 'H' ? 'h' : 'standard';
    if (!f.reviewed) add('block', 'DATA-01', 'Validate the reward classification and ratings before submission.', e.id);
    if (!s.compensationId || s.basicCents <= 0 || s.currency !== 'MYR' || !['monthly', 'custom_period'].includes(s.payMode)) add('block', 'DATA-02', 'A positive MYR monthly salary record is required for this reward policy.', e.id);
    let incrementReason = '';
    if (s.notice) incrementReason = 'Serving notice';
    else if (s.hiredOn >= policy.joinedBefore) incrementReason = 'Joined after the increment cutoff';
    else if (!s.confirmedOn || s.confirmedOn > policy.confirmedBy) incrementReason = 'Not confirmed by the cutoff';
    else if (s.confirmationPayChange && s.confirmedOn >= policy.blockedFrom) incrementReason = 'Confirmation included a pay change';
    else if (s.lastPayChange && s.lastPayChange >= policy.blockedFrom && s.lastPayChange <= policy.blockedTo) incrementReason = 'Pay change in the exclusion window';
    else if (!f.talent) incrementReason = 'No talent rating';
    else if (f.erCase && f.erDecision !== 'in') incrementReason = 'ER case held or awaiting decision';
    else if (f.pipCase && f.pipDecision !== 'lift') incrementReason = 'PIP confirmed or awaiting decision';
    else if (f.talent === 'IMPRO' || f.talent === 'PIP') incrementReason = 'Nil increment rating';
    if ((f.erCase && f.erDecision === 'pending') || (f.pipCase && f.pipDecision === 'pending')) add('block', 'ELIG-02', 'Record the BU CEO and PBP case decision.', e.id);
    if ((f.erCase && f.erDecision !== 'pending' || f.pipCase && f.pipDecision !== 'pending') && f.caseReason.length < 10) add('block', 'ELIG-02', 'Record the reason for the case decision.', e.id);
    const incrementEligible = !incrementReason;
    const senior = f.seniorPlan || policy.seniorGrades.includes(s.grade);
    const bonusReason = senior ? 'Senior leadership plan' : s.notice ? 'Serving notice' : f.erCase ? 'ER case' : !s.confirmedOn || s.confirmedOn > policy.confirmedBy ? 'Not confirmed by the cutoff' : !f.performance ? 'No performance rating' : '';
    const bonusEligible = !bonusReason;
    const range = policy.ranges[r.promotionGrade ?? s.grade];
    if (!range && incrementEligible && plan !== 'ec') add('block', 'DATA-03', 'Configure the salary range for this grade.', e.id);
    if (bonusEligible && !policy.bonusMatrix[s.grade] && plan !== 'ec') add('block', 'DATA-04', 'Configure the bonus matrix for this grade.', e.id);
    const pos = range ? s.basicCents < range[0] ? 0 : s.basicCents > range[2] ? 2 : 1 : 1;
    const meritDefault = incrementEligible && f.talent ? policy.meritMatrix[f.talent][pos] : 0;
    const meritBp = plan === 'ec' ? r.meritBp ?? meritDefault : incrementEligible ? r.meritBp ?? meritDefault : 0;
    const promotionBp = (incrementEligible || plan === 'ec') && r.promotionGrade ? r.promotionBp ?? 1000 : 0;
    if (r.promotionGrade) {
      if (!incrementEligible && plan !== 'ec') add('block', 'PRO-03', 'This employee is not eligible for an annual promotion award.', e.id);
      const jump = Number(r.promotionGrade) - Number(s.grade);
      if (!Number.isInteger(jump) || jump < 1 || jump > 3) add('block', 'PRO-01', 'A promotion must advance one to three grades.', e.id);
      if (r.reason.length < 30) add('block', 'PRO-02', 'A promotion needs a business case of at least 30 characters.', e.id);
    }
    if (r.meritBp != null && r.meritBp !== meritDefault && plan !== 'ec') add('exception', 'POOL-05', 'Individual merit differs from the matrix.', e.id);
    if (r.promotionBp != null && r.promotionBp !== 1000 && r.promotionGrade) add('exception', 'POOL-05', 'Promotion differs from the standard 10%.', e.id);
    return { ...e, facts: f, recommendation: r, plan, incrementEligible, bonusEligible, lumpEligible: !bonusEligible && !senior && plan !== 'ec' && !f.erCase, incrementReason, bonusReason, meritBp, promotionBp, specialBp: 0, meritCents: increase(s.basicCents, meritBp), promotionCents: increase(s.basicCents, promotionBp), specialCents: 0, newBasicCents: s.basicCents, bonusCents: 0, standardBonusCents: 0, lumpCents: 0, bonusMultiplierBp: 0 };
  });
  const budgets = { standard: blankBudget(), h: blankBudget(), ec: blankBudget() };
  const inPool = (x: CalculatedEntry) => x.incrementEligible || ['Nil increment rating', 'PIP confirmed or awaiting decision'].includes(x.incrementReason) && !(x.facts.pipCase && x.facts.pipDecision === 'pending');
  for (const plan of ['standard', 'h', 'ec'] as const) {
    const group = rows.filter(x => x.plan === plan), b = budgets[plan];
    b.payrollCents = sum(group.filter(inPool).map(x => x.source.basicCents));
    const percentages = plan === 'h' ? policy.hPools : policy.standardPools;
    b.pools = percentages.map(bp => ratio(b.payrollCents, bp, 10000));
    b.bonusPayrollCents = sum(group.filter(x => x.bonusEligible).map(x => x.source.basicCents));
    b.bonusPoolCents = ratio(ratio(b.bonusPayrollCents, policy.patActual, policy.patTarget), policy.targetMonthsBp, 10000);
    // Special pool funds the same half-percent catch-up cohort as the reference, within each plan.
    const stars = group.filter(x => x.incrementEligible && ['STAR', 'SSTAR'].includes(x.facts.talent ?? '') && policy.ranges[x.recommendation.promotionGrade ?? x.source.grade] && x.source.basicCents * 10 < policy.ranges[x.recommendation.promotionGrade ?? x.source.grade][1] * 9);
    const starPayroll = sum(stars.map(x => x.source.basicCents));
    const maximumNeed = Math.max(0, ...stars.map(x => Math.max(0, ratio(Math.max(0, ratio(policy.ranges[x.recommendation.promotionGrade ?? x.source.grade][1], 9, 10) - x.source.basicCents - x.meritCents - x.promotionCents), 10000, x.source.basicCents))));
    const cohortBp = starPayroll > 0 ? Math.floor(Math.min(ratio(b.pools[2], 10000, starPayroll), maximumNeed) / 50) * 50 : 0;
    for (const x of group) {
      const r = x.recommendation, range = policy.ranges[r.promotionGrade ?? x.source.grade];
      const catchUp = stars.includes(x) ? increase(x.source.basicCents, x.promotionBp ? cohortBp : Math.min(cohortBp, Math.max(0, 1000 - x.meritBp))) : 0;
      const topUp = range && x.incrementEligible ? Math.max(0, Math.ceil((range[0] - x.source.basicCents - x.meritCents - x.promotionCents - catchUp) / 100) * 100) : 0;
      x.specialCents = plan === 'ec' ? increase(x.source.basicCents, r.specialBp ?? 0) : x.incrementEligible ? r.specialBp != null ? increase(x.source.basicCents, r.specialBp) : catchUp + topUp : 0;
      x.specialBp = x.source.basicCents ? ratio(x.specialCents, 10000, x.source.basicCents, 'nearest') : 0;
      x.newBasicCents = sum([x.source.basicCents, x.meritCents, x.promotionCents, x.specialCents]);
      if (r.specialBp != null && x.specialCents !== catchUp + topUp && plan !== 'ec') add('exception', 'POOL-05', 'Special adjustment differs from the calculated amount.', x.id);
      if (plan !== 'ec' && (x.recommendation.promotionGrade ? (x.newBasicCents - x.source.basicCents) * 10 >= x.source.basicCents * 3 : (x.newBasicCents - x.source.basicCents) * 10 > x.source.basicCents)) add('warning', 'INC-01', 'Increase exceeds the individual review threshold.', x.id);
      if (range && x.newBasicCents > range[2]) add('review', 'RANGE-01', 'New salary is above the range maximum.', x.id);
    }
  }
  const bonusBase = (x: CalculatedEntry) => {
    if (!x.bonusEligible || !x.facts.performance) return 0;
    const months = policy.bonusMatrix[x.source.grade]?.[performances.indexOf(x.facts.performance)] ?? 0;
    const days = Math.max(0, Math.min(yearDays, dateNumber(end) - Math.max(dateNumber(start), dateNumber(x.source.hiredOn)) + 1));
    return ratio(ratio(x.source.basicCents, months, 10000), days, yearDays);
  };
  // A single unit multiplier must fit BOTH independently funded plans. EC never consumes either pot.
  const affordable = (['standard', 'h'] as const).flatMap(plan => { const cost = sum(rows.filter(x => x.plan === plan).map(bonusBase)); return cost > 0 ? [ratio(budgets[plan].bonusPoolCents, 10000, cost)] : []; });
  const suggestedMultiplierBp = affordable.length ? Math.floor(Math.min(...affordable) / 100) * 100 : 0;
  for (const x of rows) {
    const r = x.recommendation;
    let multiplier = policy.multiplierBp ?? suggestedMultiplierBp;
    if (policy.bonusStructure === 'branch') {
      const rating = policy.branchRatings[x.facts.branch], factors = policy.branchFactors[x.facts.segment];
      multiplier = rating && factors ? factors[performances.indexOf(rating)] : 0;
      if (x.bonusEligible && (!rating || !factors) && x.plan !== 'ec') add('block', 'PPCH-01', 'Set the branch rating and bonus segment factor.', x.id);
    }
    x.standardBonusCents = Math.floor(ratio(bonusBase(x), multiplier, 10000) / 100) * 100;
    x.bonusMultiplierBp = r.multiplierBp ?? multiplier;
    x.bonusCents = x.plan === 'ec' && r.bonusCents != null ? r.bonusCents : Math.floor(ratio(bonusBase(x), x.bonusMultiplierBp, 10000) / 100) * 100;
    if (r.multiplierBp != null && r.multiplierBp !== multiplier && x.bonusEligible && x.plan !== 'ec') add('exception', 'BUD-02', 'Individual bonus differs from the unit multiplier.', x.id);
  }
  const lumpWorking = (['standard', 'h'] as const).flatMap(plan => {
    const group = rows.filter(x => x.plan === plan), count = group.filter(x => x.lumpEligible).length;
    const balanceCents = Math.max(0, budgets[plan].bonusPoolCents - sum(group.map(x => x.bonusCents)));
    const available = ratio(balanceCents, policy.lumpShareBp, 10000);
    return count ? [{ plan, count, balanceCents, perPersonCents: ratio(available, 1, count * policy.lumpStepCents) * policy.lumpStepCents }] : [];
  });
  const suggestedLumpCents = lumpWorking.length ? Math.min(...lumpWorking.map(x => x.perPersonCents), policy.lumpCapCents ?? Number.MAX_SAFE_INTEGER) : 0;
  const lumpUnitCents = policy.lumpUnitCents ?? suggestedLumpCents;
  if (lumpUnitCents > suggestedLumpCents) add('warning', 'BUD-05', 'The unit lump sum exceeds the amount supported by the remaining budget.');
  if (lumpUnitCents === 0 && rows.some(x => x.lumpEligible)) add('review', 'BUD-05', 'The unit lump-sum provision is withheld (RM 0).');
  for (const x of rows) {
    x.lumpCents = x.plan === 'ec' ? x.recommendation.lumpCents ?? 0 : x.lumpEligible ? x.recommendation.lumpCents ?? lumpUnitCents : 0;
    if (x.lumpEligible && x.recommendation.lumpCents != null && x.lumpCents !== lumpUnitCents) add('exception', 'BUD-05', 'Individual lump sum differs from the unit amount; RM 0 means withheld.', x.id);
  }
  for (const plan of ['standard', 'h', 'ec'] as const) {
    const b = budgets[plan], group = rows.filter(x => x.plan === plan);
    b.used = [sum(group.map(x => x.meritCents)), sum(group.map(x => x.promotionCents)), sum(group.map(x => x.specialCents))];
    b.standardBonusCents = sum(group.map(x => x.standardBonusCents));
    b.increasesCents = sum(group.map(x => Math.max(0, x.bonusCents - x.standardBonusCents)));
    b.reductionsCents = sum(group.map(x => Math.max(0, x.standardBonusCents - x.bonusCents)));
    b.lumpCents = sum(group.map(x => x.lumpCents)); b.lumpCount = group.filter(x => x.lumpCents > 0).length;
    b.bonusUsedCents = sum(group.map(x => x.bonusCents + x.lumpCents));
    b.balanceCents = b.bonusPoolCents - b.bonusUsedCents;
    if (plan === 'ec') continue;
    const severity = policy.exemptReason ? 'review' : 'block', code = policy.exemptReason ? 'CFG-01' : 'POOL-03';
    b.used.forEach((used, index) => { if (used > b.pools[index]) add(severity, code, `${plan === 'h' ? 'JG H' : 'Standard'} ${['merit', 'promotion', 'special adjustment'][index]} exceeds its separate pool.`); });
    // Compare amounts, not a ratio: positive spend against a zero pool MUST block.
    if (b.bonusUsedCents > b.bonusPoolCents) add(severity, policy.exemptReason ? 'CFG-01' : 'BUD-01', `${plan === 'h' ? 'JG H' : 'Standard'} bonus exceeds the 100% budget cap.`);
    if (b.bonusPoolCents > 0 && b.bonusUsedCents * 100 < b.bonusPoolCents * 80) add('warning', 'BUD-07', `${plan === 'h' ? 'JG H' : 'Standard'} bonus budget is less than 80% utilised.`);
  }
  return { rows, budgets, flags, suggestedMultiplierBp, suggestedLumpCents, lumpUnitCents, lumpWorking };
}
