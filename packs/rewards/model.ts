import { z } from 'zod';

export const rewardRoles = ['bu', 'bg', 'gr', 'ctro', 'ec', 'pbp', 'payroll'] as const;
export type RewardRole = typeof rewardRoles[number];
export const rewardStages = ['draft', 'bg', 'gr', 'ctro', 'ec', 'approved', 'posted', 'rejected', 'withdrawn'] as const;
export type RewardStage = typeof rewardStages[number];
export const talents = ['SSTAR', 'STAR', 'SCORE', 'IMPRO', 'PIP'] as const;
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
    bonusMatrix, ranges: {}, seniorGrades: ['21', '22', '23'], patActual: 0, patTarget: 100,
    targetMonthsBp: 20000, multiplierBp: null, bonusStructure: 'standard', branchFactors: {}, branchRatings: {},
    lumpStepCents: 5000, lumpShareBp: 10000, lumpCapCents: null, lumpUnitCents: null, exemptReason: '',
  };
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
