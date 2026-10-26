/** Deterministic governed candidate lifecycle, not a model evaluator or permission grant.
 * Server owners supply authenticated identities and independently verified evaluation receipts.
 * This engine has no network, database, deployment credentials, raw feedback or learning corpus.
 */
import { createHash } from 'node:crypto';
import type { AgentModuleCode } from './module-agents';
export type ImprovementScope = Readonly<{ tenantId: string; userId: string; module: AgentModuleCode }>;
export type Candidate = Readonly<{ scope: ImprovementScope; version: number; digest: string; authorId: string;
  baselineDigest: string; state: 'candidate' | 'promoted' | 'rolled_back' }>;
export type IndependentEvaluation = Readonly<{ candidateDigest: string; evaluatorId: string; suiteDigest: string;
  heldOut: true; securityFailures: number; qualityFailures: number; verifiedOutcomes: number; completed: true }>;
export type PromotionReceipt = Readonly<{ candidateDigest: string; baselineDigest: string; approvedBy: string;
  evaluationDigests: readonly string[]; maxJobs: number; expiresAt: string; promotedAt: string }>;
const fail = (): never => { throw new Error('Agent candidate could not be promoted.'); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const boundedText = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 128;
export function createAgentCandidate(scope: ImprovementScope, authorId: string, baselineDigest: string,
  version: number, configuration: Readonly<{ promptDigest: string; routingDigest: string; engineContractDigest: string }>): Candidate {
  if (!boundedText(scope.tenantId) || !boundedText(scope.userId) || !boundedText(authorId) || !boundedText(baselineDigest) ||
    !Number.isSafeInteger(version) || version < 1 || Object.values(configuration).some(value => !boundedText(value))) return fail();
  const capturedScope = Object.freeze({ tenantId: scope.tenantId, userId: scope.userId, module: scope.module });
  return Object.freeze({ scope: capturedScope, version, authorId, baselineDigest,
    digest: digest({ scope: capturedScope, version, baselineDigest, configuration }), state: 'candidate' });
}
/** Authorization is a server-owner prerequisite; a model score can never form this receipt. */
export function promoteAgentCandidate(candidate: Candidate, caller: ImprovementScope & { approverId: string },
  evaluations: readonly IndependentEvaluation[], bounds: { maxJobs: number; expiresAt: string }, now: string): PromotionReceipt {
  if (candidate.state !== 'candidate' || candidate.scope.tenantId !== caller.tenantId || candidate.scope.userId !== caller.userId ||
    candidate.scope.module !== caller.module || !boundedText(caller.approverId) || caller.approverId === candidate.authorId ||
    evaluations.length < 2 || evaluations.length > 8 || new Set(evaluations.map(row => row.evaluatorId)).size !== evaluations.length ||
    !Number.isSafeInteger(bounds.maxJobs) || bounds.maxJobs < 1 || bounds.maxJobs > 100 ||
    !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(bounds.expiresAt)) ||
    Date.parse(bounds.expiresAt) <= Date.parse(now) || Date.parse(bounds.expiresAt) - Date.parse(now) > 86400000) return fail();
  for (const row of evaluations) if (row.candidateDigest !== candidate.digest || row.completed !== true || row.heldOut !== true ||
    !boundedText(row.evaluatorId) || row.evaluatorId === candidate.authorId || !boundedText(row.suiteDigest) ||
    row.securityFailures !== 0 || row.qualityFailures !== 0 || !Number.isSafeInteger(row.verifiedOutcomes) || row.verifiedOutcomes < 1) return fail();
  return Object.freeze({ candidateDigest: candidate.digest, baselineDigest: candidate.baselineDigest,
    approvedBy: caller.approverId, evaluationDigests: Object.freeze(evaluations.map(digest)),
    maxJobs: bounds.maxJobs, expiresAt: bounds.expiresAt, promotedAt: now });
}
/** Expiry, exhausted budget, security/quality regression or explicit rollback always restores baseline. */
export function selectAgentVersion(receipt: PromotionReceipt, monitoring: { jobs: number; securityFailures: number;
  qualityFailures: number; rolledBack: boolean }, now: string): { digest: string; state: 'promoted' | 'rolled_back' } {
  const allowed = Number.isFinite(Date.parse(now)) && Number.isFinite(Date.parse(receipt.expiresAt)) && Date.parse(now) < Date.parse(receipt.expiresAt) &&
    Number.isSafeInteger(monitoring.jobs) && monitoring.jobs >= 0 && monitoring.jobs < receipt.maxJobs &&
    monitoring.securityFailures === 0 && monitoring.qualityFailures === 0 && monitoring.rolledBack === false;
  return { digest: allowed ? receipt.candidateDigest : receipt.baselineDigest, state: allowed ? 'promoted' : 'rolled_back' };
}
