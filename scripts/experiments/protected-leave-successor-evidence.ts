import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { leaveEvaluationCaseSetDigest, verifyPairedLeaveEvaluations } from '../../lib/ai/assistant-leave-evaluation-receipt';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { readFrozenHoldoutJson } from './protected-work-summary-holdout';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const count = z.number().int().min(0).max(32);
const caseDigests = z.array(digest).min(4).max(32);
const evaluator = z.object({
  id: z.uuid(), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  holdoutDigest: digest, caseDigests, minimumAdditionalAnswers: count.min(1),
}).strict();
const successorPlan = z.object({
  version: z.literal(3), trialId: z.uuid(), tenantId: z.uuid(), authorId: z.uuid(), approverId: z.uuid(),
  candidateSha: sha, candidateDigest: digest, sourceDigest: digest, parentArchiveDigest: digest,
  committedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), evaluators: z.tuple([evaluator, evaluator]),
}).strict();
const parentArchive = z.object({
  plan: z.string().regex(/^[A-Za-z0-9_-]+$/), planDigest: digest,
  receipts: z.tuple([z.unknown(), z.unknown()]), verifiedAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime(), promotionId: z.uuid(), acceptedBuild: z.string().min(1).max(100),
}).strict();
const parentCases = z.object({ evaluators: z.tuple([
  z.object({ caseDigests }), z.object({ caseDigests }),
]) });
const reportSchema = z.object({
  evidence: z.literal('offline_leave_successor_comparison'), candidateSha: sha, holdoutDigest: digest,
  caseSetDigest: digest, cases: count.min(4), minimumAdditionalAnswers: count.min(1), expectedDirect: count.min(2),
  parentCorrectDirect: count.min(1), parentCorrectDeferrals: count, successorCorrectDirect: count,
  successorCorrectDeferrals: count, additionalCorrectAnswers: count.min(1),
  regressions: z.literal(0), wrongDirect: z.literal(0), unexpectedDirect: z.literal(0),
  modelCalls: z.literal(0), releaseAuthorized: z.literal(false), meetsThreshold: z.literal(true),
}).strict();
const receiptSchema = z.object({ evaluatorId: z.uuid(), planDigest: digest, report: reportSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
const refused = (): never => { throw Error('The frozen successor evidence could not be confirmed.'); };

function inspect(planBytes: Buffer, planDigest: string, archiveBytes: Buffer, now: Date) {
  const plan = successorPlan.parse(readFrozenHoldoutJson(planBytes, planDigest));
  const archive = parentArchive.parse(readFrozenHoldoutJson(archiveBytes, plan.parentArchiveDigest));
  const raw = Buffer.from(archive.plan, 'base64url');
  if (raw.toString('base64url') !== archive.plan) return refused();
  const parent = verifyPairedLeaveEvaluations(raw, archive.planDigest, archive.receipts, new Date(archive.verifiedAt));
  const previous = parentCases.parse(JSON.parse(raw.toString('utf8'))).evaluators.flatMap(row => row.caseDigests);
  const [first, second] = plan.evaluators;
  const combined = [...previous, ...first.caseDigests, ...second.caseDigests];
  const start = Date.parse(plan.committedAt), end = Date.parse(plan.expiresAt);
  const accepted = Date.parse(archive.acceptedAt);
  if (!(Date.parse(archive.verifiedAt) <= accepted && accepted < start && start <= now.getTime() && now.getTime() < end) ||
      end - start > 72 * 3600_000 || plan.tenantId !== parent.tenantId || plan.trialId === parent.trialId ||
      plan.candidateSha === parent.candidateSha || plan.candidateDigest === parent.candidateDigest ||
      new Set(combined).size !== combined.length ||
      new Set([plan.authorId, plan.approverId, first.id, second.id]).size !== 4 ||
      first.publicKey === second.publicKey || first.holdoutDigest === second.holdoutDigest) return refused();
  return { plan, parent, archive };
}

function reportFor(plan: z.infer<typeof successorPlan>, evaluatorId: string, supplied: unknown) {
  const member = plan.evaluators.find(row => row.id === evaluatorId);
  const report = reportSchema.parse(supplied);
  if (!member || report.candidateSha !== plan.candidateSha || report.holdoutDigest !== member.holdoutDigest ||
      report.caseSetDigest !== leaveEvaluationCaseSetDigest(member.caseDigests) || report.cases !== member.caseDigests.length ||
      report.minimumAdditionalAnswers !== member.minimumAdditionalAnswers || report.cases - report.expectedDirect < 2 ||
      report.parentCorrectDeferrals !== report.cases - report.expectedDirect ||
      report.successorCorrectDeferrals !== report.parentCorrectDeferrals ||
      report.successorCorrectDirect !== report.expectedDirect ||
      report.additionalCorrectAnswers !== report.successorCorrectDirect - report.parentCorrectDirect ||
      report.additionalCorrectAnswers < member.minimumAdditionalAnswers) return refused();
  if (Buffer.from(member.publicKey, 'base64url').toString('base64url') !== member.publicKey) return refused();
  return { report, publicKey: member.publicKey };
}

const material = (receipt: Omit<Receipt, 'signature'>) => Buffer.from(JSON.stringify([
  'aihr.assistant.paired-leave-successor-evidence.v3', receipt.planDigest, receipt.evaluatorId, receipt.report,
]));

export function signLeaveSuccessorEvidence(planBytes: Buffer, planDigest: string, archiveBytes: Buffer,
  evaluatorId: string, aggregate: unknown, key: KeyObject, now = new Date()): Receipt {
  const { plan } = inspect(planBytes, planDigest, archiveBytes, now);
  const { report, publicKey } = reportFor(plan, evaluatorId, aggregate);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519' ||
      createPublicKey(key).export({ format: 'jwk' }).x !== publicKey) return refused();
  const receipt = { evaluatorId, planDigest, report };
  return { ...receipt, signature: sign(null, material(receipt), key).toString('base64url') };
}

/** Archive acceptance metadata is an operator attestation pinned in the plan, not a native deployment receipt. */
export function verifyLeaveSuccessorEvidence(planBytes: Buffer, planDigest: string, archiveBytes: Buffer,
  supplied: readonly unknown[], now = new Date()) {
  const { plan, parent, archive } = inspect(planBytes, planDigest, archiveBytes, now);
  if (supplied.length !== 2) return refused();
  const verified = supplied.map(value => {
    const receipt = receiptSchema.parse(value);
    if (receipt.planDigest !== planDigest) return refused();
    const { publicKey } = reportFor(plan, receipt.evaluatorId, receipt.report);
    const signature = Buffer.from(receipt.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== receipt.signature ||
        !verify(null, material(receipt), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }), signature))
      return refused();
    return receipt;
  });
  if (new Set(verified.map(row => row.evaluatorId)).size !== 2) return refused();
  return {
    evidence: 'verified_offline_leave_successor_evaluations', planDigest, trialId: plan.trialId, tenantId: plan.tenantId,
    candidateSha: plan.candidateSha, candidateDigest: plan.candidateDigest, sourceDigest: plan.sourceDigest,
    parentCandidateSha: parent.candidateSha, parentCandidateDigest: parent.candidateDigest,
    parentReceiptSetDigest: parent.receiptSetDigest, parentPromotionId: archive.promotionId,
    evaluatorCount: verified.length,
    receiptSetDigest: routingDigest(verified.sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId))),
    additionalCorrectAnswers: verified.reduce((total, row) => total + row.report.additionalCorrectAnswers, 0),
    releaseAuthorized: false,
  };
}
