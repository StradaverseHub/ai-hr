import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { routingDigest } from '../../lib/ai/module-agent-routing';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(32);
const tokens = z.number().int().min(0).max(1_000_000_000);
const evaluator = z.object({
  id: z.uuid(), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  holdoutDigest: digest, minimumSavedCalls: count.min(1),
}).strict();
const planSchema = z.object({
  version: z.literal(1), trialId: z.uuid(), tenantId: z.uuid(), authorId: z.uuid(), approverId: z.uuid(),
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/), candidateDigest: digest, baselineDigest: digest,
  modelDigest: digest, answerFormatDigest: digest, generationOptionsDigest: digest,
  committedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), evaluators: z.tuple([evaluator, evaluator]),
}).strict();
const reportSchema = z.object({
  evidence: z.literal('offline_paired_leave_routing_holdout'), candidateSha: planSchema.shape.candidateSha,
  scope: z.literal('single_active_own_employment'),
  holdoutDigest: digest, modelDigest: digest, minimumSavedCalls: count.min(1),
  cases: count.min(4), expectedDirect: count.min(2), correctDirect: count, correctDeferrals: count, wrongDirect: z.literal(0),
  unexpectedDirect: z.literal(0), missedDirect: z.literal(0), meetsThreshold: z.literal(true), releaseAuthorized: z.literal(false),
  baselineCalls: count, baselineCorrect: count, baselineRejected: count, candidateFallbackCalls: z.literal(0),
  candidateCorrect: count, gains: count, regressions: z.literal(0), savedCalls: count,
  baselineInputTokens: tokens, baselineOutputTokens: tokens, answerFormatDigest: digest,
  model: z.string().regex(/^[a-z0-9_.\/-]+:[a-z0-9_.-]+$/).max(100),
  generationOptions: z.object({temperature: z.number().min(0).max(2), seed: z.number().int().nonnegative(), num_predict: z.number().int().min(1).max(2048)}).strict(),
}).strict();
const receiptSchema = z.object({ evaluatorId: z.uuid(), planDigest: digest, report: reportSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
type Plan = z.infer<typeof planSchema>;
type Receipt = z.infer<typeof receiptSchema>;

const refused = (): never => { throw Error('Frozen paired leave evidence could not be confirmed.'); };
export const LEAVE_RECEIPT_INPUT_LIMIT = 64 * 1024;
function readPlan(bytes: Buffer, planDigest: string, now: Date) {
  if (!bytes.length || bytes.length > LEAVE_RECEIPT_INPUT_LIMIT || createHash('sha256').update(bytes).digest('hex') !== planDigest)
    return refused();
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { return refused(); }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return refused();
  const plan = parsed.data;
  const [first, second] = plan.evaluators;
  const start = Date.parse(plan.committedAt), end = Date.parse(plan.expiresAt);
  if (new Set([plan.authorId, plan.approverId, first.id, second.id]).size !== 4 ||
      first.publicKey === second.publicKey || first.holdoutDigest === second.holdoutDigest ||
      !Number.isFinite(now.getTime()) || !(start <= now.getTime() && now.getTime() < end) || end - start > 72 * 3600_000)
    return refused();
  return plan;
}

function checkReport(plan: Plan, id: string, supplied: unknown) {
  const signer = plan.evaluators.find(row => row.id === id);
  const parsed = reportSchema.safeParse(supplied);
  if (!signer || !parsed.success) return refused();
  const report = parsed.data;
  const { expectedDirect: direct, cases, baselineCorrect } = report;
  if (report.candidateSha !== plan.candidateSha || report.modelDigest !== plan.modelDigest ||
      report.answerFormatDigest !== plan.answerFormatDigest || routingDigest(report.generationOptions) !== plan.generationOptionsDigest ||
      report.holdoutDigest !== signer.holdoutDigest || report.minimumSavedCalls !== signer.minimumSavedCalls ||
      cases - direct < 2 || report.correctDirect !== direct || report.correctDeferrals !== cases - direct ||
      report.baselineCalls !== direct || baselineCorrect > direct || report.baselineRejected > direct - baselineCorrect ||
      report.candidateCorrect !== direct || report.gains !== direct - baselineCorrect ||
      report.savedCalls !== direct || report.savedCalls < signer.minimumSavedCalls) return refused();
  const publicBytes = Buffer.from(signer.publicKey, 'base64url');
  if (publicBytes.length !== 32 || publicBytes.toString('base64url') !== signer.publicKey) return refused();
  return { report, publicKey: signer.publicKey };
}

const material = (receipt: Omit<Receipt, 'signature'>) => Buffer.from(JSON.stringify([
  'aihr.assistant.paired-leave-evidence.v1', receipt.planDigest, receipt.evaluatorId, receipt.report,
]));

export function signPairedLeaveEvaluation(planBytes: Buffer, planDigest: string, evaluatorId: string,
  aggregate: unknown, privateKey: KeyObject, now = new Date()): Receipt {
  const plan = readPlan(planBytes, planDigest, now);
  const { report, publicKey } = checkReport(plan, evaluatorId, aggregate);
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519' ||
      createPublicKey(privateKey).export({ format: 'jwk' }).x !== publicKey) return refused();
  const receipt = { evaluatorId, planDigest, report };
  return { ...receipt, signature: sign(null, material(receipt), privateKey).toString('base64url') };
}

/** The coordinator supplies the pinned digest from its own records. This verifies evaluator attestations
 * about an offline experiment, and conveys no deployment or provider approval. */
export function verifyPairedLeaveEvaluations(planBytes: Buffer, planDigest: string, supplied: readonly unknown[], now = new Date()) {
  const plan = readPlan(planBytes, planDigest, now);
  if (supplied.length !== 2) return refused();
  const verified = supplied.map(value => {
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success || parsed.data.planDigest !== planDigest) return refused();
    const receipt = parsed.data;
    const { publicKey } = checkReport(plan, receipt.evaluatorId, receipt.report);
    const signature = Buffer.from(receipt.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== receipt.signature ||
        !verify(null, material(receipt), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }), signature))
      return refused();
    return receipt;
  });
  if (new Set(verified.map(row => row.evaluatorId)).size !== 2) return refused();
  return { evidence: 'verified_offline_paired_leave_evaluations', planDigest, trialId: plan.trialId, tenantId: plan.tenantId,
    candidateSha: plan.candidateSha, candidateDigest: plan.candidateDigest, baselineDigest: plan.baselineDigest,
    modelDigest: plan.modelDigest, evaluatorCount: verified.length,
    savedCalls: verified.reduce((total, row) => total + row.report.savedCalls, 0), releaseAuthorized: false };
}
