import { z } from 'zod';

export const rewardRoles = ['bu', 'bg', 'gr', 'ctro', 'ec', 'pbp', 'payroll'] as const;
export type RewardRole = typeof rewardRoles[number];
export const rewardStages = ['draft', 'bg', 'gr', 'ctro', 'ec', 'approved', 'posted', 'rejected', 'withdrawn'] as const;
export type RewardStage = typeof rewardStages[number];
export const talents = ['SSTAR', 'STAR', 'SCORE', 'IMPRO', 'PIP'] as const;
/** 179539d1 — merit matrix rows in talent order. A stored policy is jsonb, which keeps object keys
 *  sorted by length (PIP, STAR, IMPRO, SCORE, SSTAR), so its own key order is never a display order. */
export const meritMatrixRows = <T,>(matrix: Record<(typeof talents)[number], T>) => talents.map(talent => [talent, matrix[talent]] as const);
export const performances = ['UA', 'BE', 'ME', 'AE', 'OU'] as const;
export const centsSchema = z.number().int().min(0).max(100_000_000_000);
export const bpSchema = z.number().int().min(0).max(100_000);
export const isoDateSchema = z.iso.date();
const triplet = z.tuple([bpSchema, bpSchema, bpSchema]);
const five = z.tuple([bpSchema, bpSchema, bpSchema, bpSchema, bpSchema]);
type Three = [number, number, number];
type Five = [number, number, number, number, number];
export type RewardPolicy = {
  year: number; effectiveFrom: string; joinedBefore: string; confirmedBy: string; blockedFrom: string; blockedTo: string;
  standardPools: Three; hPools: Three; meritMatrix: Record<typeof talents[number], Three>;
  bonusMatrix: Record<string, Five>; ranges: Record<string, Three>; seniorGrades: string[];
  // Absence means the persisted legacy grade rule. Never default old snapshots on parse.
  seniorMembershipMode?: 'legacy-grades' | 'named-members';
  patActual: number; patTarget: number; targetMonthsBp: number; multiplierBp: number | null;
  bonusStructure: 'standard' | 'branch'; branchFactors: Record<string, Five>; branchRatings: Record<string, typeof performances[number]>;
  lumpStepCents: number; lumpShareBp: number; lumpCapCents: number | null; lumpUnitCents: number | null; exemptReason: string;
};
export type RewardFacts = {
  talent: typeof talents[number] | null; performance: typeof performances[number] | null;
  confidentiality: 'standard' | 'bg' | 'ec'; seniorPlan: boolean; erCase: boolean; pipCase: boolean;
  erDecision: 'pending' | 'in' | 'out'; pipDecision: 'pending' | 'lift' | 'confirm';
  caseReason: string; segment: string; branch: string; reviewed: boolean;
};
export type Recommendation = {
  meritBp: number | null; promotionGrade: string | null; promotionBp: number | null; specialBp: number | null;
  multiplierBp: number | null; bonusCents: number | null; lumpCents: number | null; reason: string;
  currentRoleSummary: string; proposedRoleSummary: string;
};
export const policySchema: z.ZodType<RewardPolicy> = z.object({
  year: z.number().int().min(2000).max(2200),
  effectiveFrom: isoDateSchema,
  joinedBefore: isoDateSchema,
  confirmedBy: isoDateSchema,
  blockedFrom: isoDateSchema,
  blockedTo: isoDateSchema,
  standardPools: triplet,
  hPools: triplet,
  meritMatrix: z.object({ SSTAR: triplet, STAR: triplet, SCORE: triplet, IMPRO: triplet, PIP: triplet }),
  bonusMatrix: z.record(z.string().min(1).max(30), five),
  ranges: z.record(z.string().min(1).max(30), z.tuple([centsSchema, centsSchema, centsSchema]).refine(v => v[0] > 0 && v[0] <= v[1] && v[1] <= v[2], 'Salary ranges must have 0 < minimum <= midpoint <= maximum')),
  seniorGrades: z.array(z.string()).max(50),
  seniorMembershipMode: z.enum(['legacy-grades', 'named-members']).optional(),
  patActual: centsSchema,
  patTarget: centsSchema.refine(v => v > 0, 'PAT target must be positive'),
  targetMonthsBp: bpSchema,
  multiplierBp: bpSchema.nullable(),
  bonusStructure: z.enum(['standard', 'branch']),
  branchFactors: z.record(z.string().min(1).max(80), five),
  branchRatings: z.record(z.string().min(1).max(100), z.enum(performances)),
  lumpStepCents: centsSchema.refine(v => v >= 1000 && v % 1000 === 0, 'Rounding must be at least RM 10, in RM 10 steps'),
  lumpShareBp: z.number().int().min(0).max(10000),
  lumpCapCents: centsSchema.nullable(),
  lumpUnitCents: centsSchema.nullable(),
  exemptReason: z.string().trim().max(2000).refine(v => !v || v.length >= 10, 'Explain the exemption in at least 10 characters'),
}).strict().refine(p => p.blockedFrom <= p.blockedTo, 'Invalid off-cycle exclusion window');

/** All monetary inputs are integer cents. Rates are integer basis points. */
export const factsSchema: z.ZodType<RewardFacts> = z.object({
  talent: z.enum(talents).nullable(), performance: z.enum(performances).nullable(),
  confidentiality: z.enum(['standard', 'bg', 'ec']), seniorPlan: z.boolean(),
  erCase: z.boolean(), pipCase: z.boolean(),
  erDecision: z.enum(['pending', 'in', 'out']), pipDecision: z.enum(['pending', 'lift', 'confirm']),
  caseReason: z.string().trim().max(3000),
  segment: z.string().trim().max(80), branch: z.string().trim().max(100),
  reviewed: z.boolean(),
}).strict();
export const recommendationSchema: z.ZodType<Recommendation> = z.object({
  meritBp: bpSchema.nullable(), promotionGrade: z.string().trim().max(30).nullable(),
  promotionBp: bpSchema.nullable(), specialBp: bpSchema.nullable(),
  multiplierBp: bpSchema.nullable(), bonusCents: centsSchema.nullable(), lumpCents: centsSchema.nullable(),
  reason: z.string().trim().max(4000),
  currentRoleSummary: z.string().trim().max(8000).default(''), proposedRoleSummary: z.string().trim().max(8000).default(''),
}).strict();
export const emptyFacts = (): RewardFacts => ({ talent: null, performance: null, confidentiality: 'standard', seniorPlan: false, erCase: false, pipCase: false, erDecision: 'pending', pipDecision: 'pending', caseReason: '', segment: '', branch: '', reviewed: false });
export const emptyRecommendation = (): Recommendation => ({ meritBp: null, promotionGrade: null, promotionBp: null, specialBp: null, multiplierBp: null, bonusCents: null, lumpCents: null, reason: '', currentRoleSummary: '', proposedRoleSummary: '' });

export type RewardSource = {
  employmentId: string; personId: string; compensationId: string | null;
  employeeCode: string; name: string; grade: string; gradeId: string | null;
  basicCents: number; currency: string; payMode: string;
  hiredOn: string; confirmedOn: string | null; notice: boolean;
  lastPayChange: string | null; confirmationPayChange: boolean;
  performanceReviewId: string | null; performanceRating: number | null;
  /** 40bf44f7 — set by a confirmed source refresh when the person left the company or moved out of the unit.
   *  The entry and its recommendation are retained for the record; the engine awards nothing. */
  leftOn?: string; leftReason?: 'terminated' | 'moved';
  /** 6fd08f37 — derived from an administrative reporting line to the BG CEO or EC seat holder (see confidentiality.ts). */
  confidentialityFloor?: 'bg' | 'ec'; confidentialityReason?: { seat: 'bg' | 'ec'; managerEmploymentId: string };
  onehrFactImport?: { resultId: string; digest: string; importedAt: string };
  onehr?: { id: string; reviewId: string; cycleId: string; digest: string; frozenAt: string;
    performance: typeof performances[number] | null; potential: 'Low'|'Mid'|'High'|null;
    talent: 'PIP/Improvement'|'Solid Core'|'Star'|'Super Star'|null;
    pip: boolean; promotion: boolean; specialReward: boolean; policyDigest: string; confirmedGrade?:string; confirmedTitle?:string; pipReason?:string; promotionReason?:string; specialRewardReason?:string } | null;
};
export type RewardEntry = { id: string; source: RewardSource; facts: RewardFacts; recommendation: Recommendation };
export type Plan = 'standard' | 'h' | 'ec';
export type RewardFlag = { severity: 'block' | 'exception' | 'warning' | 'review'; code: string; message: string; entryId?: string };

export function defaultPolicy(year: number): RewardPolicy {
  const bonusMatrix: RewardPolicy['bonusMatrix'] = { H: [0, 5000, 10000, 15000, 20000] };
  for (let g = 12; g <= 22; g++) bonusMatrix[String(g)] = g <= 15 ? [0, 5000, 15000, 22500, 30000] : g <= 19 ? [0, 5000, 25000, 35000, 45000] : g <= 21 ? [0, 5000, 30000, 40000, 50000] : [0, 5000, 40000, 50000, 60000];
  return {
    year, effectiveFrom: `${year + 1}-01-01`, joinedBefore: `${year}-10-01`, confirmedBy: `${year}-12-31`,
    blockedFrom: `${year}-10-01`, blockedTo: `${year + 1}-01-31`,
    standardPools: [500, 100, 100], hPools: [500, 100, 100],
    meritMatrix: { SSTAR: [1000, 800, 800], STAR: [800, 600, 600], SCORE: [600, 450, 300], IMPRO: [0, 0, 0], PIP: [0, 0, 0] },
    bonusMatrix, ranges: {}, seniorGrades: [], seniorMembershipMode: 'named-members', patActual: 0, patTarget: 100,
    targetMonthsBp: 20000, multiplierBp: null, bonusStructure: 'standard', branchFactors: {}, branchRatings: {},
    lumpStepCents: 5000, lumpShareBp: 10000, lumpCapCents: null, lumpUnitCents: null, exemptReason: '',
  };
}

/** Existing policy snapshots retain their historical grade rule until explicitly converted. */
export function isSeniorPlanMember(policy: RewardPolicy, facts: RewardFacts, grade: string): boolean {
  return facts.seniorPlan || policy.seniorMembershipMode !== 'named-members' && policy.seniorGrades.includes(grade);
}

/** 6fd08f37 — confidentiality markings ordered from least to most restricted. */
export const confidentialityRank: Record<RewardFacts['confidentiality'], number> = { standard: 0, bg: 1, ec: 2 };
export const belowConfidentialityFloor = (facts: Pick<RewardFacts, 'confidentiality'>, source: Pick<RewardSource, 'confidentialityFloor'>) =>
  confidentialityRank[facts.confidentiality] < confidentialityRank[source.confidentialityFloor ?? 'standard'];
/** The effective marking when the floor moves: a manual marking stricter than the old floor is kept; one equal to
 *  it is taken to be the derived marking, so it follows the new floor (up or down). Never below the new floor. */
export function applyConfidentialityFloor(current: RewardFacts['confidentiality'], oldFloor: RewardSource['confidentialityFloor'], newFloor: RewardSource['confidentialityFloor']): RewardFacts['confidentiality'] {
  const manual = confidentialityRank[current] > confidentialityRank[oldFloor ?? 'standard'] ? current : 'standard', floor = newFloor ?? 'standard';
  return confidentialityRank[manual] >= confidentialityRank[floor] ? manual : floor;
}
export function withConfidentialityFloor(source: RewardSource, floor: { level: 'bg' | 'ec'; reason: NonNullable<RewardSource['confidentialityReason']> } | null): RewardSource {
  const { confidentialityFloor: _floor, confidentialityReason: _reason, ...rest } = source;
  return floor ? { ...rest, confidentialityFloor: floor.level, confidentialityReason: floor.reason } : rest;
}

export function visibleEntry(entry: RewardEntry, roles: readonly RewardRole[], personId?: string | null): boolean {
  if (entry.source.personId === personId) return false;
  if (!entry.facts.reviewed && !roles.includes('gr')) return false;
  if (entry.facts.confidentiality === 'ec') return roles.some(r => ['gr', 'ctro', 'ec'].includes(r));
  if (entry.facts.confidentiality === 'bg' && roles.every(r => r === 'bu' || r === 'pbp')) return false;
  return true;
}
export function canEditStage(stage: RewardStage, roles: readonly RewardRole[]): boolean {
  return stage === 'draft' ? roles.some(r => r === 'bu' || r === 'gr') : ['bg', 'gr', 'ctro', 'ec'].includes(stage) && roles.includes(stage as RewardRole);
}
export function transition(stage: RewardStage, roles: readonly RewardRole[], action: 'submit' | 'approve' | 'return'): RewardStage {
  if (action === 'submit' && stage === 'draft' && roles.includes('bu')) return 'bg';
  if (action === 'return' && stage === 'approved' && roles.some(r => ['gr', 'ctro', 'ec'].includes(r))) return 'draft';
  if (action === 'return' && ['bg', 'gr', 'ctro', 'ec'].includes(stage) && roles.includes(stage as RewardRole)) return 'draft';
  if (action === 'approve' && ['bg', 'gr', 'ctro', 'ec'].includes(stage) && roles.includes(stage as RewardRole)) return rewardStages[rewardStages.indexOf(stage) + 1];
  throw new Error('You cannot perform this action at the current approval stage.');
}

/** Assessment classification is evidence for a human review, never a pay or disciplinary decision. */
export function factsFromOnehr(source: NonNullable<RewardSource['onehr']>, existing: RewardFacts): RewardFacts {
  const talent: RewardFacts['talent'] = source.pip ? 'PIP' : source.talent === 'Super Star' ? 'SSTAR' : source.talent === 'Star' ? 'STAR' : source.talent === 'Solid Core' ? 'SCORE' : source.talent === 'PIP/Improvement' ? 'IMPRO' : existing.talent;
  return { ...existing, performance: source.performance ?? existing.performance, talent, pipCase: source.pip || existing.pipCase, reviewed: false };
}

/** The seat a returned review waits on: the BU CEO, or the BG CEO for a BG-originated off-cycle request. */
export type RewardReturnSeat = 'bu' | 'bg';
export type RewardDecisionFact = { action: string; fromStage: string; toStage: string; reason: string; actorId: string; createdAt: Date | string };
export type RewardReturnedState = { reason: string; actorId: string; at: string; fromStage: string; toSeat: RewardReturnSeat };
/**
 * "Returned" is DERIVED, never a stored stage (RW-131): a draft whose LATEST decision is a return.
 * `latest` must be the newest decision by (created_at DESC, id DESC). A resubmission moves the unit out
 * of draft, so the state clears itself; a later non-return decision on a draft also clears it.
 */
export function returnedState(status: RewardStage, latest: RewardDecisionFact | null | undefined, bgOrigin: boolean): RewardReturnedState | null {
  if (status !== 'draft' || !latest || latest.action !== 'return' || latest.toStage !== 'draft') return null;
  return { reason: latest.reason, actorId: latest.actorId, at: new Date(latest.createdAt).toISOString(), fromStage: latest.fromStage, toSeat: bgOrigin ? 'bg' : 'bu' };
}
/** Which of the actor's unit roles signed a decision; used only when the viewer cannot read the actor's name. */
export function decisionActorRole(fromStage: string, actorRoles: readonly RewardRole[]): RewardRole | null {
  if (actorRoles.includes(fromStage as RewardRole)) return fromStage as RewardRole;
  const order: RewardRole[] = fromStage === 'approved' ? ['gr', 'ctro', 'ec'] : fromStage === 'draft' ? ['bu', 'bg', 'gr'] : [];
  return order.find(r => actorRoles.includes(r)) ?? null;
}
