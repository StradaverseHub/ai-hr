/** Server-only private intent codec. State/key custody belongs to the review store, not this codec.
 * Reuses the existing envelope primitives; it never grants authority, logs input or calls a model. */
import { z } from 'zod';
import {createReviewEnvelope} from './review-envelope';
import { OwnLeavePreparedMetadata } from './own-leave-review';
import { OwnLeaveReviewCandidate, ownLeaveReviewedDigest } from './own-leave-review-digest';

const MAX_CONTENT_BYTES = 32_768;
export class OwnLeaveContentUnavailable extends Error {
  constructor() { super('Own-leave private review unavailable'); this.name = 'OwnLeaveContentUnavailable'; }
}

/** This object is private even when the ESS card hides available balances. No consumer may spread it
 * into props, traces, events, action metadata, model context or generic error details. */
export const OwnLeaveProtectedReview = z.object({
  review: OwnLeaveReviewCandidate,
  availableBalance: z.number().finite(),
}).strict().refine(value => value.availableBalance >= value.review.deductionDays
  && (value.review.availableBalance === null || value.review.availableBalance === value.availableBalance));
export type OwnLeaveProtectedReview = z.infer<typeof OwnLeaveProtectedReview>;

export const OwnLeaveSealedReview = z.object({
  formatVersion: z.literal(1),
  kid: z.string().regex(/^[a-f0-9]{16}$/),
  wrappedDek: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),
  ciphertext: z.string().min(1).max(65_536)
    .regex(/^[a-f0-9]{16}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/),
}).strict().refine(value => value.ciphertext.split('.')[0] === value.kid);
export type OwnLeaveSealedReview = z.infer<typeof OwnLeaveSealedReview>;

function contentBinding(metadataValue: unknown) {
  const m = OwnLeavePreparedMetadata.parse(metadataValue);
  if (m.state !== 'awaiting_confirmation') throw new OwnLeaveContentUnavailable();
  // Separate domains for wrapping and content; the complete immutable owner/action/review identity
  // prevents a row or key being transplanted to another login, employment, action or reviewed effect.
  const identity = JSON.stringify([1, m.actionId, m.binding.tenantId, m.binding.userId, m.binding.personId,
    m.binding.companyId, m.binding.employmentId, m.intentDigest, m.reviewedDigest]);
  return { m, wrapAad: `assistant:own-leave:key:${identity}`, bodyAad: `assistant:own-leave:body:${identity}` };
}

function checkedContent(value: unknown, metadataValue: unknown): OwnLeaveProtectedReview {
  const content = OwnLeaveProtectedReview.parse(value);
  const { m } = contentBinding(metadataValue);
  if (content.review.intentDigest !== m.intentDigest || ownLeaveReviewedDigest(content.review) !== m.reviewedDigest
    || Object.keys(m.binding).some(key => m.binding[key as keyof typeof m.binding]
      !== content.review.binding[key as keyof typeof m.binding])) throw new OwnLeaveContentUnavailable();
  return content;
}

/** Same installed own-leave wire and purposes, using the common envelope owner. */
const envelope=createReviewEnvelope<unknown,OwnLeaveProtectedReview,OwnLeaveSealedReview>({
 sealed:OwnLeaveSealedReview,maxBytes:MAX_CONTENT_BYTES,
 identity:metadata=>{const identity=contentBinding(metadata);return{wrapAad:identity.wrapAad,bodyAad:identity.bodyAad};},
 checked:(metadata,value)=>checkedContent(value,metadata),wire:body=>body,
 unavailable:():never=>{throw new OwnLeaveContentUnavailable();},
});
export function sealOwnLeaveReview(metadataValue:unknown,contentValue:unknown):OwnLeaveSealedReview{return envelope.seal(metadataValue,contentValue);}
/** Call only after current native source authority. Decryption grants no permission. */
export function unsealOwnLeaveReview(metadataValue:unknown,sealedValue:unknown):OwnLeaveProtectedReview{return envelope.unseal(metadataValue,sealedValue);}
