/** Human-review integrity only. This pure module owns the candidate shape shared by source reads
 * and the digest. Neither schema validation nor a digest proves authority, freshness or consent. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OwnLeaveDigest, OwnLeaveHumanText, OwnLeaveNomination } from '../../lib/assistant-actions/own-leave-contract';
import { OwnLeaveBinding, ownLeaveIntentDigest } from './own-leave-review';

/** Evidence shape, not the gazette threshold rule (which remains owned by core/holidays). */
const ReviewHolidayWarning = z.object({
  country: z.string().min(1), state: z.string().min(1).nullable(),
  year: z.number().int().min(0).max(9999), loaded: z.number().int().nonnegative(),
  required: z.number().int().positive(),
}).strict().refine(value => value.loaded < value.required);

/** Server-only candidate content, not lifecycle metadata, model context or a client-posted command.
 * Hidden estimates stay null together. Labels and human text remain exact, without normalization. */
export const OwnLeaveReviewCandidate = z.object({
  binding: OwnLeaveBinding,
  nomination: OwnLeaveNomination,
  humanText: OwnLeaveHumanText,
  intentDigest: OwnLeaveDigest,
  companyName: z.string().min(1),
  employeeCode: z.string().nullable(),
  leaveTypeName: z.string().min(1),
  deductionDays: z.number().finite().positive(),
  availableBalance: z.number().finite().nullable(),
  estimatedAvailableAfter: z.number().finite().nullable(),
  // One full-day date in one proven company/calendar. Unexpected fan-out uses the full form.
  holidayWarnings: z.array(ReviewHolidayWarning).max(1),
  approvalRouting: z.literal('unknown'),
}).strict()
  .refine(value => (value.availableBalance === null) === (value.estimatedAvailableAfter === null))
  .refine(value => {
    // Keep malformed nested inputs as validation failures. The digest helper uses throwing parsers,
    // so validate its inputs independently before invoking it from a refinement.
    const binding = OwnLeaveBinding.safeParse(value.binding);
    const nomination = OwnLeaveNomination.safeParse(value.nomination);
    const text = OwnLeaveHumanText.safeParse(value.humanText);
    return binding.success && nomination.success && text.success
      && binding.data.employmentId === nomination.data.employmentId
      && value.intentDigest === ownLeaveIntentDigest(binding.data, nomination.data, text.data);
  });
export type OwnLeaveReviewCandidate = z.infer<typeof OwnLeaveReviewCandidate>;

/** Binds the exact displayed review to the immutable input, separately from the intent digest.
 * The command must still bind the action ID and compare fresh canonical effects/dependencies at the
 * authoritative write point. In particular, hidden balances are not a freshness witness here.
 * Hashes are integrity references, not encryption or a protected-content retention implementation. */
export function ownLeaveReviewedDigest(value: unknown): string {
  const parsed = OwnLeaveReviewCandidate.safeParse(value);
  if (!parsed.success) throw new Error('Own-leave review unavailable');
  const review = parsed.data;
  return createHash('sha256').update(JSON.stringify([
    'assistant:leave.apply:review:1', review.intentDigest,
    review.companyName, review.employeeCode, review.leaveTypeName, review.deductionDays,
    review.availableBalance, review.estimatedAvailableAfter, review.approvalRouting,
    review.holidayWarnings.map(warning =>
      [warning.country, warning.state, warning.year, warning.loaded, warning.required]),
  ])).digest('hex');
}
