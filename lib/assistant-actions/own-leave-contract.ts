/** ADR-0131's first action only. Parsing is not permission, eligibility or human consent. */
import { z } from 'zod';

export const OWN_LEAVE_ACTION = 'leave.apply' as const;
export const OWN_LEAVE_CONTRACT_VERSION = 1 as const;

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number(value.slice(0, 4)) > 0 && Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
});
export const OwnLeaveDigest = z.string().regex(/^[a-f0-9]{64}$/);

/** A model may nominate IDs/date, never authority, override consent, private text or execution. */
export const OwnLeaveNomination = z.object({
  action: z.literal(OWN_LEAVE_ACTION),
  contractVersion: z.literal(OWN_LEAVE_CONTRACT_VERSION),
  employmentId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
  date: calendarDate,
  durationType: z.literal('full_day'),
}).strict();
export type OwnLeaveNomination = z.infer<typeof OwnLeaveNomination>;

/** Copied only from explicit user input, separately from model nomination. Parsing cannot prove
 * authorship. Kept apart from lifecycle metadata for the privacy owner's protected-content handling. */
export const OwnLeaveHumanText = z.object({
  reason: z.string().max(2000).optional(),
  employeeRemark: z.string().max(2000).optional(),
}).strict();
export type OwnLeaveHumanText = z.infer<typeof OwnLeaveHumanText>;

/** The person's explicit selection, captured outside model nomination. As with human text, parsing
 * cannot establish provenance: the authenticated UI/command owner must supply this separately. */
export const OwnLeaveHumanSelection = z.object({
  employmentId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
}).strict();

/** The human POST cannot replace any business argument in the immutable prepared intent. */
export const OwnLeaveConfirmation = z.object({
  actionId: z.string().uuid(),
  contractVersion: z.literal(OWN_LEAVE_CONTRACT_VERSION),
  reviewedDigest: OwnLeaveDigest,
}).strict();
export type OwnLeaveConfirmation = z.infer<typeof OwnLeaveConfirmation>;

/** Bounded codes only. Domain errors, model text and employee reasons never become history codes. */
export const OwnLeaveRefusalCode = z.enum([
  'unavailable', 'review_changed', 'expired', 'unsupported_request', 'source_refused',
]);
export type OwnLeaveRefusalCode = z.infer<typeof OwnLeaveRefusalCode>;

export const OwnLeaveState = z.enum([
  'awaiting_confirmation', 'completed', 'refused', 'discarded', 'expired',
]);
export type OwnLeaveState = z.infer<typeof OwnLeaveState>;

/** A terminal action receipt records submission, never approval or an HR outcome. These references
 * must be obtained from the canonical write in the same transaction as the completed lifecycle. */
const receiptIdentity = {
  actionId: z.string().uuid(),
  contractVersion: z.literal(OWN_LEAVE_CONTRACT_VERSION),
};
export const OwnLeaveFinalReceipt = z.discriminatedUnion('state', [
  z.object({ ...receiptIdentity, state: z.literal('completed'),
    leaveRequestId: z.string().uuid(), submissionEventId: z.string().uuid() }).strict(),
  z.object({ ...receiptIdentity, state: z.literal('refused'), code: OwnLeaveRefusalCode }).strict(),
  z.object({ ...receiptIdentity, state: z.literal('discarded') }).strict(),
  z.object({ ...receiptIdentity, state: z.literal('expired') }).strict(),
]);
export type OwnLeaveFinalReceipt = z.infer<typeof OwnLeaveFinalReceipt>;

/** Transport uncertainty belongs to the client, never to the durable lifecycle. */
export type OwnLeaveClientOutcome =
  | { status: 'checking_submission'; actionId: string }
  | { status: 'submission_recorded'; actionId: string; leaveRequestId: string }
  | { status: 'discarded'; actionId: string }
  | { status: 'refused'; actionId: string; code: OwnLeaveRefusalCode };

/** Evidence shape only: completeness thresholds stay with the canonical holiday owner. */
export const OwnLeaveReviewWarning = z.object({
  country: z.string().min(1), state: z.string().min(1).nullable(),
  year: z.number().int().min(0).max(9999), loaded: z.number().int().nonnegative(),
  required: z.number().int().positive(),
}).strict().refine(value => value.loaded < value.required);

/** The sole public card shape. It deliberately excludes private balances, key custody, model output
 * and login/person/tenant bindings. Confirmation still posts only ID/version/reviewed digest. */
export const OwnLeavePreparedReview = z.object({
  actionId: z.string().uuid(), contractVersion: z.literal(OWN_LEAVE_CONTRACT_VERSION),
  reviewedDigest: OwnLeaveDigest, createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  companyName: z.string().min(1), employeeCode: z.string().nullable(), leaveTypeName: z.string().min(1),
  date: calendarDate, durationType: z.literal('full_day'), deductionDays: z.number().finite().positive(),
  availableBalance: z.number().finite().nullable(), estimatedAvailableAfter: z.number().finite().nullable(),
  holidayWarnings: z.array(OwnLeaveReviewWarning).max(1), approvalRouting: z.literal('unknown'),
  humanText: OwnLeaveHumanText,
}).strict().refine(value => (value.availableBalance === null) === (value.estimatedAvailableAfter === null))
  .refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt));
export type OwnLeavePreparedReview = z.infer<typeof OwnLeavePreparedReview>;
