import { z } from 'zod';
import { LEAVE_RECEIPT_INPUT_LIMIT, verifyPairedLeaveEvaluations } from '../lib/ai/assistant-leave-evaluation-receipt';

const bundle = z.object({ plan: z.string().regex(/^[A-Za-z0-9_-]+$/), receipts: z.tuple([z.unknown(), z.unknown()]) }).strict();

/** One installation-approved bundle. The request, uploaded reports and evaluator keys alone confer no authority. */
export function installedLocalLeaveEvidence(binding: {
  tenantId: string; authorId: string; candidateDigest: string; baselineDigest: string; sourceDigest: string;
}, now = new Date()) {
  const { AIHR_LOCAL_LEAVE_TRIAL_BUNDLE, AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256 } = process.env;
  if (!AIHR_LOCAL_LEAVE_TRIAL_BUNDLE || Buffer.byteLength(AIHR_LOCAL_LEAVE_TRIAL_BUNDLE) > LEAVE_RECEIPT_INPUT_LIMIT ||
      !AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256 || !/^[a-f0-9]{64}$/.test(AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256)) return null;
  try {
    const { plan, receipts } = bundle.parse(JSON.parse(AIHR_LOCAL_LEAVE_TRIAL_BUNDLE));
    const raw = Buffer.from(plan, 'base64url');
    if (raw.toString('base64url') !== plan) return null;
    const checked = verifyPairedLeaveEvaluations(raw, AIHR_LOCAL_LEAVE_TRIAL_PLAN_SHA256, receipts, now);
    if (checked.tenantId !== binding.tenantId || checked.authorId !== binding.authorId ||
        checked.candidateDigest !== binding.candidateDigest || checked.baselineDigest !== binding.baselineDigest ||
        checked.sourceDigest !== binding.sourceDigest) return null;
    return Object.freeze({ kind: 'paired_leave_offline_v2' as const, planDigest: checked.planDigest,
      receiptSetDigest: checked.receiptSetDigest, approverId: checked.approverId, expiresAt: checked.expiresAt });
  } catch { return null; }
}
