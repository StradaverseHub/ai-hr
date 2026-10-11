import { blankBudget, increase, sum, type CalculatedEntry } from './engine';
import { type RewardEntry, type RewardFlag, type RewardPolicy, type RewardRole, type RewardStage, factsSchema, recommendationSchema } from './model';

export type RewardKind = 'annual' | 'adhoc' | 'midyear';
export type Funding = { standard: number; h: number };
export type OffcycleDetails = { exceptionReason: string; bgOrigin: boolean };
export const emptyFunding = (): Funding => ({ standard: 0, h: 0 });

/** Off-cycle awards are explicit monthly salary deltas, funded by annual increment remainders. */
export function calculateOffcycle(entries: RewardEntry[], policy: RewardPolicy, kind: 'adhoc' | 'midyear', details: OffcycleDetails, available: Funding) {
  const flags: RewardFlag[] = [];
  const add = (severity: RewardFlag['severity'], code: string, message: string, entryId?: string) => flags.push({ severity, code, message, ...(entryId ? { entryId } : {}) });
  if (kind === 'adhoc' && entries.length !== 1) add('block', 'OC-01', 'An ad-hoc request must contain exactly one employee.');
  if (!entries.length) add('block', 'OC-01', 'Add at least one employee.');
  if (details.exceptionReason && (kind !== 'adhoc' || details.exceptionReason.trim().length < 30)) add('block', 'OC-02', 'Only an ad-hoc request may use a budget exception, with a reason of at least 30 characters.');
  const budgets = { standard: blankBudget(), h: blankBudget(), ec: blankBudget() };
  const rows: CalculatedEntry[] = entries.map(e => {
    const s = e.source, r = recommendationSchema.parse(e.recommendation), f = factsSchema.parse(e.facts);
    const plan = f.confidentiality === 'ec' ? 'ec' : s.grade === 'H' ? 'h' : 'standard';
    if (!f.reviewed || !s.compensationId || !Number.isSafeInteger(s.basicCents) || s.basicCents <= 0 || s.currency !== 'MYR' || !['monthly', 'custom_period'].includes(s.payMode)) add('block', 'OC-03', 'Verify the employee and their current MYR monthly salary.', e.id);
    if (s.notice || f.erCase && f.erDecision !== 'in' || f.pipCase && f.pipDecision !== 'lift') add('block', 'OC-04', 'Resolve employee eligibility before submitting this request.', e.id);
    if (r.reason.length < (r.promotionGrade ? 30 : 10)) add('block', 'OC-05', r.promotionGrade ? 'Record a promotion business case of at least 30 characters.' : 'Record an increment reason of at least 10 characters.', e.id);
    const meritBp = r.meritBp ?? 0, promotionBp = r.promotionGrade ? r.promotionBp ?? 1000 : 0, specialBp = r.specialBp ?? 0;
    if (r.promotionGrade) {
      const jump = Number(r.promotionGrade) - Number(s.grade);
      if (!Number.isInteger(jump) || jump < 1 || jump > 3) add('block', 'OC-06', 'A promotion must advance one to three grades.', e.id);
      if (r.currentRoleSummary.length < 30 || r.proposedRoleSummary.length < 30 || r.currentRoleSummary.trim().toLowerCase() === r.proposedRoleSummary.trim().toLowerCase()) add('block', 'OC-07', 'Provide distinct current and proposed job-description summaries (at least 30 characters each).', e.id);
    }
    const meritCents = increase(s.basicCents, meritBp), promotionCents = increase(s.basicCents, promotionBp), specialCents = increase(s.basicCents, specialBp);
    const delta = sum([meritCents, promotionCents, specialCents]);
    if (!delta) add('block', 'OC-08', 'Enter a positive salary increase.', e.id);
    if (plan !== 'ec' && (r.promotionGrade ? delta * 10 >= s.basicCents * 3 : delta * 10 > s.basicCents)) add('warning', 'INC-01', 'Increase exceeds the individual review threshold.', e.id);
    if (r.bonusCents || r.lumpCents || r.multiplierBp != null) add('block', 'OC-09', 'Off-cycle reviews support salary changes only.');
    if (plan === 'ec' && !details.exceptionReason) add('block', 'OC-10', 'An EC-plan off-cycle award requires an ad-hoc budget exception.');
    budgets[plan].payrollCents = sum([budgets[plan].payrollCents, s.basicCents]);
    budgets[plan].used[0] = sum([budgets[plan].used[0], delta]);
    return { ...e, facts: f, recommendation: r, plan, incrementEligible: true, bonusEligible: false, lumpEligible: false, incrementReason: '', bonusReason: 'Off-cycle salary review', meritBp, promotionBp, specialBp, meritCents, promotionCents, specialCents, newBasicCents: sum([s.basicCents, delta]), bonusCents: 0, standardBonusCents: 0, lumpCents: 0, bonusMultiplierBp: 0 };
  });
  for (const plan of ['standard', 'h'] as const) {
    budgets[plan].pools[0] = available[plan];
    if (budgets[plan].used[0] > available[plan]) add(details.exceptionReason ? 'exception' : 'block', 'OC-11', `${plan === 'h' ? 'JG H' : 'Standard'} request exceeds its unreserved annual increment balance.`);
  }
  return { rows, budgets, flags, suggestedMultiplierBp: 0, suggestedLumpCents: 0, lumpUnitCents: 0, lumpWorking: [] as { plan: 'standard' | 'h'; count: number; balanceCents: number; perPersonCents: number }[] };
}

export function offcycleRoute(kind: 'adhoc' | 'midyear', details: OffcycleDetails, entries: RewardEntry[]): RewardRole[] {
  const needsEC = !!details.exceptionReason || entries.some(e => Number(e.source.grade) >= 22 || Number(e.recommendation.promotionGrade) >= 22 || e.facts.confidentiality === 'ec');
  return kind === 'midyear' ? ['bu', 'bg', 'gr'] : [...(details.bgOrigin ? ['bg' as const] : ['bu' as const, 'bg' as const]), 'gr', 'ctro', ...(needsEC ? ['ec' as const] : [])];
}
export function offcycleTransition(stage: RewardStage, roles: RewardRole[], action: 'submit' | 'approve' | 'return' | 'reject' | 'withdraw', route: RewardRole[]): RewardStage {
  if (action === 'withdraw' && stage === 'draft' && (roles.includes(route[0]) || roles.includes('gr'))) return 'withdrawn';
  if (action === 'return' && stage === 'approved' && roles.some(r => ['gr', 'ctro', 'ec'].includes(r))) return 'draft';
  if (stage === 'draft' && action === 'submit' && roles.includes(route[0])) return route[1] as RewardStage;
  const position = route.indexOf(stage as RewardRole);
  if (position >= 1 && roles.includes(stage as RewardRole)) {
    if (action === 'return') return 'draft';
    if (action === 'reject') return 'rejected';
    if (action === 'approve') return (route[position + 1] ?? 'approved') as RewardStage;
  }
  throw new Error('You cannot perform this action at the current approval stage.');
}
