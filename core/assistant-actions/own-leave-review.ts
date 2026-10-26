/** Pure preflight for one prepared own-leave action; deliberately has no DB, model or executor.
 * The eventual command owner must lock the action and revalidate live authority and the canonical
 * leave effect in its transaction. A `revalidate` result below NEVER authorizes execution. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  OWN_LEAVE_ACTION, OWN_LEAVE_CONTRACT_VERSION, OwnLeaveConfirmation, OwnLeaveDigest,
  OwnLeaveHumanText, OwnLeaveNomination, OwnLeaveState,
  type OwnLeaveRefusalCode, type OwnLeaveState as State,
} from '../../lib/assistant-actions/own-leave-contract';

/** Must come from fresh authenticated source reads, never from a posted/model object. */
export const OwnLeaveBinding = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  personId: z.string().uuid(),
  companyId: z.string().uuid(),
  employmentId: z.string().uuid(),
}).strict();
export type OwnLeaveBinding = z.infer<typeof OwnLeaveBinding>;

/** References and digests only: this object must not store the reason, preview or tool output. */
export const OwnLeavePreparedMetadata = z.object({
  actionId: z.string().uuid(),
  action: z.literal(OWN_LEAVE_ACTION),
  contractVersion: z.literal(OWN_LEAVE_CONTRACT_VERSION),
  binding: OwnLeaveBinding,
  intentDigest: OwnLeaveDigest,
  reviewedDigest: OwnLeaveDigest,
  state: OwnLeaveState,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt));

/** Storage retires text-derived integrity hashes together with its encrypted body/key. A null
 * terminal digest is explicitly absent proof, never a fabricated original integrity digest. */
export const OwnLeaveCustodyMetadata = z.union([
  OwnLeavePreparedMetadata.refine(value => value.state === 'awaiting_confirmation'),
  z.object({ actionId: z.string().uuid(), action: z.literal(OWN_LEAVE_ACTION),
    contractVersion: z.literal(OWN_LEAVE_CONTRACT_VERSION), binding: OwnLeaveBinding,
    intentDigest: z.null(), reviewedDigest: z.null(),
    state: OwnLeaveState.exclude(['awaiting_confirmation']),
    createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  }).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt)),
]);

/** Fixed ordering and domain separation make field ordering irrelevant and identity part of intent.
 * This is an integrity digest, NOT encryption or a protected-storage/retention implementation. */
export function ownLeaveIntentDigest(bindingValue: unknown, nominationValue: unknown, humanTextValue: unknown): string {
  const binding = OwnLeaveBinding.parse(bindingValue);
  const intent = OwnLeaveNomination.parse(nominationValue);
  const text = OwnLeaveHumanText.parse(humanTextValue);
  if (binding.employmentId !== intent.employmentId) throw new Error('Own-leave subject mismatch');
  return createHash('sha256').update(JSON.stringify([
    'assistant:leave.apply:intent:1',
    binding.tenantId, binding.userId, binding.personId, binding.companyId, binding.employmentId,
    intent.leaveTypeId, intent.date, intent.durationType,
    text.reason ?? null, text.employeeRemark ?? null,
  ])).digest('hex');
}

type ConfirmationPreflight =
  | { kind: 'refused'; code: OwnLeaveRefusalCode }
  | { kind: 'reconcile'; state: Exclude<State, 'awaiting_confirmation'> }
  | { kind: 'revalidate' };

/** Call only after fresh authorization and inside the locked command transaction when wired.
 * Unavailable deliberately conflates missing, malformed and foreign actions without echoing input. */
export function checkOwnLeaveConfirmation(
  metadataValue: unknown, confirmationValue: unknown, currentBindingValue: unknown, now: Date,
): ConfirmationPreflight {
  const metadata = OwnLeaveCustodyMetadata.safeParse(metadataValue);
  const confirmation = OwnLeaveConfirmation.safeParse(confirmationValue);
  const binding = OwnLeaveBinding.safeParse(currentBindingValue);
  if (!metadata.success || !confirmation.success || !binding.success || !Number.isFinite(now.getTime())) {
    return { kind: 'refused', code: 'unavailable' };
  }
  const record = metadata.data;
  const sameOwner = (Object.keys(record.binding) as (keyof OwnLeaveBinding)[])
    .every(key => record.binding[key] === binding.data[key]);
  if (!sameOwner || record.actionId !== confirmation.data.actionId) {
    return { kind: 'refused', code: 'unavailable' };
  }
  // Terminal custody cannot authorize an effect and contains no text-derived integrity hash.
  if (record.state !== 'awaiting_confirmation') return { kind: 'reconcile', state: record.state };
  if (record.reviewedDigest !== confirmation.data.reviewedDigest) {
    return { kind: 'refused', code: 'review_changed' };
  }
  if (now.getTime() < Date.parse(record.createdAt)) return { kind: 'refused', code: 'unavailable' };
  if (now.getTime() >= Date.parse(record.expiresAt)) return { kind: 'refused', code: 'expired' };
  return { kind: 'revalidate' };
}
