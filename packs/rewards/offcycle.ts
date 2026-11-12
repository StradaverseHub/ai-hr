import { blankBudget, increase, ratio, sum, type CalculatedEntry } from './engine';
import { type RewardEntry, type RewardFlag, type RewardPolicy, type RewardRole, type RewardStage, factsSchema, recommendationSchema } from './model';
import { baselineRewardLimits, limitFlagText, limitNumber, limitSeverity, type RewardLimits } from './limit-controls-model';

export type RewardKind = 'annual' | 'adhoc' | 'midyear';
/** Per-plan amounts. Annual posting still freezes them per plan, and each request records its reservation per plan; the
 * off-cycle balance is their sum per company (board b945f0cc, docs/adr/2026-11-12-rewards-offcycle-company-balance.md). */
export type Funding = { standard: number; h: number };
/** `yearEndExclusion` is recorded at final approval when the effective date falls between 1 October and 31 December. */
export type OffcycleDetails = { exceptionReason: string; bgOrigin: boolean; yearEndExclusion?: number | null };
export const emptyFunding = (): Funding => ({ standard: 0, h: 0 });
/** The company balance one request is checked against: frozen annual remainders less every other request's held and
 * consumed amounts. Computed by the database (app.reward_offcycle_company_funding), never by a model. */
export type OffcycleBalance = { frozenCents: number; committedCents: number; availableCents: number };
export const fundingTotal = (f: Funding) => sum([f.standard, f.h]);

/** Off-cycle awards are explicit monthly salary deltas, funded by the company's annual increment remainders. */
export function calculateOffcycle(entries: RewardEntry[], policy: RewardPolicy, kind: 'adhoc' | 'midyear', details: OffcycleDetails, balance: OffcycleBalance, limitsInput?: RewardLimits) {
  const limits = limitsInput ?? baselineRewardLimits(policy);
  const versioned = limits.source === 'version';
  const promotionIncrementBp = limitNumber(limits, 'promotion.increment'), maxGrades = limitNumber(limits, 'promotion.maxGrades'), maxGrade = limitNumber(limits, 'promotion.maxGrade');
  const withoutPromotionBp = limitNumber(limits, 'increase.withoutPromotion'), withPromotionBp = limitNumber(limits, 'increase.withPromotion');
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
    const meritBp = r.meritBp ?? 0, promotionBp = r.promotionGrade ? r.promotionBp ?? promotionIncrementBp : 0, specialBp = r.specialBp ?? 0;
    if (r.promotionGrade) {
      const jump = Number(r.promotionGrade) - Number(s.grade);
      // Board b945f0cc: the year's Limit Controls own the grade-step and highest-grade checks; the baseline keeps 1-3 grades.
      if (!Number.isInteger(jump) || jump < 1 || jump > maxGrades || versioned && Number(r.promotionGrade) > maxGrade) {
        const severity = limitSeverity(limits, !Number.isInteger(jump) || jump < 1 || jump > maxGrades ? 'promotion.maxGrades' : 'promotion.maxGrade');
        add(severity, 'OC-06', limitFlagText('This promotion is outside the allowed grade range', severity, 'change the promoted grade'), e.id);
      }
      if (r.currentRoleSummary.length < 30 || r.proposedRoleSummary.length < 30 || r.currentRoleSummary.trim().toLowerCase() === r.proposedRoleSummary.trim().toLowerCase()) add('block', 'OC-07', 'Provide distinct current and proposed job-description summaries (at least 30 characters each).', e.id);
    }
    const meritCents = increase(s.basicCents, meritBp), promotionCents = increase(s.basicCents, promotionBp), specialCents = increase(s.basicCents, specialBp);
    const delta = sum([meritCents, promotionCents, specialCents]);
    if (!delta) add('block', 'OC-08', 'Enter a positive salary increase.', e.id);
    if (plan !== 'ec' && (r.promotionGrade ? delta * 10000 >= s.basicCents * withPromotionBp : delta * 10000 > s.basicCents * withoutPromotionBp)) {
      const severity = limitSeverity(limits, r.promotionGrade ? 'increase.withPromotion' : 'increase.withoutPromotion');
      add(severity, 'INC-01', limitFlagText('This increase is above the individual review threshold', severity, 'reduce the increase'), e.id);
    }
    // Like the annual engine's version-only checks, this one runs only under a Limit Controls version.
    if (versioned && r.promotionGrade && r.promotionBp != null && r.promotionBp !== promotionIncrementBp) {
      const severity = limitSeverity(limits, 'promotion.increment');
      add(severity, 'POOL-05', limitFlagText('Promotion increment differs from the standard', severity, 'use the standard promotion increment'), e.id);
    }
    if (r.bonusCents || r.lumpCents || r.multiplierBp != null) add('block', 'OC-09', 'Off-cycle reviews support salary changes only.');
    if (plan === 'ec' && !details.exceptionReason) add('block', 'OC-10', 'An EC-plan off-cycle award requires an ad-hoc budget exception.');
    budgets[plan].payrollCents = sum([budgets[plan].payrollCents, s.basicCents]);
    budgets[plan].used[0] = sum([budgets[plan].used[0], delta]);
    return { ...e, facts: f, recommendation: r, activeInReview:!s.leftOn, plan, incrementEligible: true, bonusEligible: false, lumpEligible: false, incrementReason: '', bonusReason: 'Off-cycle salary review', meritBp, promotionBp, specialBp, meritCents, promotionCents, specialCents, newBasicCents: sum([s.basicCents, delta]), bonusCents: 0, standardBonusCents: 0, lumpCents: 0, bonusMultiplierBp: 0, bonusMonthsBp: 0, payChange: null, payWindowKept: false, bonusBasicCents: s.basicCents };
  });
  // One company balance (board b945f0cc): Standard and JG H requests draw on the same balance. EC-plan awards are
  // discretionary budget exceptions and never draw on it (ADR-0099).
  const requestCents = sum([budgets.standard.used[0], budgets.h.used[0]]);
  for (const plan of ['standard', 'h'] as const) budgets[plan].pools[0] = balance.availableCents;
  if (requestCents > balance.availableCents) add(details.exceptionReason ? 'exception' : 'block', 'OC-11', details.exceptionReason
    ? 'This request is more than the company’s available off-cycle balance and goes as a budget exception.'
    : 'This request is more than the company’s available off-cycle balance. Reduce it, or raise it on its own as a budget exception.');
  const offcycleBalance = { ...balance, requestCents, remainingCents: balance.availableCents - requestCents };
  return { rows, budgets, flags, offcycleBalance, limitVersion: limits.revision, suggestedMultiplierBp: 0, suggestedLumpCents: 0, lumpUnitCents: 0, lumpWorking: [] as { plan: 'standard' | 'h'; count: number; balanceCents: number; perPersonCents: number }[] };
}

/** Approval routes (board b945f0cc; business approvals, unchanged by board 60f1fdcd):
 *  - mid-year set: BU CEO -> BG CEO -> Group Rewards (final);
 *  - ad hoc: BU CEO -> BG CEO -> Group Rewards -> CTRO, continuing to the Executive Chairman when the current or new
 *    grade is JG 22 or above (or the person is on the EC plan); a BG-originated request for a BG direct report starts at BG;
 *  - budget exception (ad hoc only, never inside a mid-year set): BG CEO -> Group Rewards -> CTRO -> EC, whatever the grade. */
export function offcycleRoute(kind: 'adhoc' | 'midyear', details: OffcycleDetails, entries: RewardEntry[]): RewardRole[] {
  if (kind === 'midyear') return ['bu', 'bg', 'gr'];
  if (details.exceptionReason) return ['bg', 'gr', 'ctro', 'ec'];
  const needsEC = entries.some(e => offcycleGrade(e.source.grade) >= 22 || offcycleGrade(e.recommendation.promotionGrade) >= 22 || e.facts.confidentiality === 'ec');
  return [...(details.bgOrigin ? ['bg' as const] : ['bu' as const, 'bg' as const]), 'gr', 'ctro', ...(needsEC ? ['ec' as const] : [])];
}
/** Numeric job grade, NaN for non-numeric grades such as H. */
export const offcycleGrade = (grade: string | null | undefined) => grade == null || grade === '' ? Number.NaN : Number(String(grade).replace(/^JG\s*/i, ''));
/** The seat a returned request goes back to: the route's first seat. */
export const offcycleReturnSeat = (details: OffcycleDetails | null | undefined): 'bu' | 'bg' => details?.bgOrigin || details?.exceptionReason ? 'bg' : 'bu';

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

/** Board b945f0cc blackout: no new off-cycle submission or approval from 1 October through 31 January (MYT dates). */
export function offcycleBlackout(today: string): boolean {
  const month = Number(today.slice(5, 7));
  return month >= 10 || month === 1;
}
/** An approved effective date between 1 October and 31 December is a year-end exclusion for that year's review. */
export function offcycleYearEndExclusion(effectiveFrom: string): number | null {
  const month = Number(effectiveFrom.slice(5, 7));
  return month >= 10 && month <= 12 ? Number(effectiveFrom.slice(0, 4)) : null;
}
/** The mid-year window admits submissions on its dates inclusive. */
export const offcycleMidyearOpen = (window: { from: string | null; to: string | null } | null, today: string) => !!window?.from && !!window.to && today >= window.from && today <= window.to;

export type OffcyclePosition = 'below' | 'within' | 'above' | 'unknown';
/** Single-person pay position: compa-ratio (salary / range midpoint, basis points) and position in range, before and
 * after. Deterministic integer arithmetic over the review's own salary ranges. */
export function offcyclePayPosition(policy: Pick<RewardPolicy, 'ranges'>, row: { source: { basicCents: number; grade: string }; newBasicCents: number; recommendation: { promotionGrade?: string | null } }) {
  const at = (grade: string, cents: number) => {
    const range = policy.ranges[grade];
    if (!range) return { crBp: null as number | null, position: 'unknown' as OffcyclePosition, range: null as [number, number, number] | null };
    return { crBp: range[1] > 0 ? ratio(cents, 10000, range[1], 'nearest') : null, position: (cents < range[0] ? 'below' : cents > range[2] ? 'above' : 'within') as OffcyclePosition, range };
  };
  return { before: at(row.source.grade, row.source.basicCents), after: at(row.recommendation.promotionGrade || row.source.grade, row.newBasicCents) };
}
