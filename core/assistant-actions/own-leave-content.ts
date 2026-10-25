/** Server-only private intent codec. State/key custody belongs to the review store, not this codec.
 * Reuses the existing envelope primitives; it never grants authority, logs input or calls a model. */
import { z } from 'zod';
import { masterKeyAvailable, newDek, newKid, sealUnderDek, unsealUnderDek, unwrapDek, wrapDek } from '../../lib/pii/vault';
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

/** Generate one random action DEK. Its wrapped form lives only with the short-lived private row.
 * The SQL erasure/discard/expiry owners must remove both body and wrapped key; a hash is not erasure. */
export function sealOwnLeaveReview(metadataValue: unknown, contentValue: unknown): OwnLeaveSealedReview {
  let dek: Buffer | undefined;
  try {
    if (!masterKeyAvailable()) throw new OwnLeaveContentUnavailable();
    const binding = contentBinding(metadataValue);
    const content = checkedContent(contentValue, binding.m);
    const plaintext = JSON.stringify(content);
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_CONTENT_BYTES) throw new OwnLeaveContentUnavailable();
    dek = newDek();
    const kid = newKid();
    return OwnLeaveSealedReview.parse({ formatVersion: 1, kid,
      wrappedDek: wrapDek(dek, binding.wrapAad),
      ciphertext: sealUnderDek(dek, kid, plaintext, binding.bodyAad) });
  } catch { throw new OwnLeaveContentUnavailable(); }
  finally { dek?.fill(0); }
}

/** Call only after a fresh authorized store read. Parsing/decrypting is not permission to execute.
 * All malformed, transplanted, retired or corrupt content has one bounded, non-content error. */
export function unsealOwnLeaveReview(metadataValue: unknown, sealedValue: unknown): OwnLeaveProtectedReview {
  let dek: Buffer | undefined;
  try {
    if (!masterKeyAvailable()) throw new OwnLeaveContentUnavailable();
    const binding = contentBinding(metadataValue);
    const sealed = OwnLeaveSealedReview.parse(sealedValue);
    dek = unwrapDek(sealed.wrappedDek, binding.wrapAad);
    if (dek.length !== 32) throw new OwnLeaveContentUnavailable();
    const plaintext = unsealUnderDek(dek, sealed.ciphertext, binding.bodyAad);
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_CONTENT_BYTES) throw new OwnLeaveContentUnavailable();
    return checkedContent(JSON.parse(plaintext), binding.m);
  } catch { throw new OwnLeaveContentUnavailable(); }
  finally { dek?.fill(0); }
}
