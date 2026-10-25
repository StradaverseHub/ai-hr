/** Authored source-only acceptance; not executed while the shared runtime is reserved. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayInKualaLumpur } from '../lib/hr-date';
import { sealOwnLeaveReview, unsealOwnLeaveReview, OwnLeaveContentUnavailable } from '../core/assistant-actions/own-leave-content';
import { ownLeaveIntentDigest } from '../core/assistant-actions/own-leave-review';
import { ownLeaveReviewedDigest } from '../core/assistant-actions/own-leave-review-digest';

beforeEach(() => vi.stubEnv('AI_CONFIG_SECRET', 'fictional-own-review-master-passphrase-12345'));
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const binding = { tenantId: randomUUID(), userId: randomUUID(), personId: randomUUID(),
    companyId: randomUUID(), employmentId: randomUUID() };
  const nomination = { action: 'leave.apply' as const, contractVersion: 1 as const,
    employmentId: binding.employmentId, leaveTypeId: randomUUID(), date: todayInKualaLumpur(), durationType: 'full_day' as const };
  const humanText = { reason: 'Fictional private reason sentinel', employeeRemark: 'Fictional private employee remark sentinel' };
  const review = { binding, nomination, humanText, intentDigest: ownLeaveIntentDigest(binding, nomination, humanText),
    companyName: 'Fictional company', employeeCode: 'FICT-1', leaveTypeName: 'Annual', deductionDays: 1,
    availableBalance: null, estimatedAvailableAfter: null, holidayWarnings: [], approvalRouting: 'unknown' as const };
  const now = new Date();
  const metadata = { actionId: randomUUID(), action: 'leave.apply' as const, contractVersion: 1 as const,
    binding, intentDigest: review.intentDigest, reviewedDigest: ownLeaveReviewedDigest(review),
    state: 'awaiting_confirmation' as const, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() };
  return { metadata, content: { review, availableBalance: 10 } };
}

describe('protected own-leave review content', () => {
  it('round-trips exact private content with distinct per-action keys and no plaintext in the envelope', () => {
    const f = fixture();
    const a = sealOwnLeaveReview(f.metadata, f.content), b = sealOwnLeaveReview(f.metadata, f.content);
    expect(a.kid).not.toBe(b.kid);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(unsealOwnLeaveReview(f.metadata, a)).toEqual(f.content);
    expect(unsealOwnLeaveReview(f.metadata, b)).toEqual(f.content);
    expect(JSON.stringify(a)).not.toContain('Fictional private');
    expect(a).not.toHaveProperty('availableBalance');
  });

  it.each(['tenantId', 'userId', 'personId', 'companyId', 'employmentId'] as const)(
    'refuses a transplanted %s binding', key => {
      const f = fixture(), sealed = sealOwnLeaveReview(f.metadata, f.content);
      expect(() => unsealOwnLeaveReview({ ...f.metadata, binding: { ...f.metadata.binding, [key]: randomUUID() } }, sealed))
        .toThrow(OwnLeaveContentUnavailable);
    },
  );

  it('binds action identity, input digest and exact reviewed content', () => {
    const f = fixture(), sealed = sealOwnLeaveReview(f.metadata, f.content);
    for (const changed of [{ actionId: randomUUID() }, { intentDigest: 'f'.repeat(64) }, { reviewedDigest: 'e'.repeat(64) }])
      expect(() => unsealOwnLeaveReview({ ...f.metadata, ...changed }, sealed)).toThrow(OwnLeaveContentUnavailable);
    expect(() => sealOwnLeaveReview(f.metadata, { ...f.content,
      review: { ...f.content.review, companyName: 'Changed company' } })).toThrow(OwnLeaveContentUnavailable);
  });

  it('refuses mixed keys/bodies, retired records, tamper and extra token segments with one bounded error', () => {
    const f = fixture(), a = sealOwnLeaveReview(f.metadata, f.content), b = sealOwnLeaveReview(f.metadata, f.content);
    const bad = [ { ...a, wrappedDek: b.wrappedDek }, { ...a, ciphertext: a.ciphertext + '.extra' },
      { ...a, wrappedDek: 'malformed' }, { ...a, ciphertext: a.ciphertext.replace(/.$/, '!') } ];
    for (const sealed of bad) expect(() => unsealOwnLeaveReview(f.metadata, sealed)).toThrow('Own-leave private review unavailable');
    for (const state of ['discarded', 'expired', 'refused', 'completed'])
      expect(() => unsealOwnLeaveReview({ ...f.metadata, state }, a)).toThrow(OwnLeaveContentUnavailable);
  });

  it('refuses missing master-key custody even after a prior successful operation', () => {
    const f = fixture(), sealed = sealOwnLeaveReview(f.metadata, f.content);
    vi.stubEnv('AI_CONFIG_SECRET', '');
    expect(() => sealOwnLeaveReview(f.metadata, f.content)).toThrow(OwnLeaveContentUnavailable);
    expect(() => unsealOwnLeaveReview(f.metadata, sealed)).toThrow(OwnLeaveContentUnavailable);
  });

  it('rejects oversized source labels and a private expectation inconsistent with a shown balance', () => {
    const f = fixture();
    const oversized = { ...f.content.review, companyName: 'X'.repeat(40_000) };
    expect(() => sealOwnLeaveReview({ ...f.metadata, reviewedDigest: ownLeaveReviewedDigest(oversized) },
      { ...f.content, review: oversized })).toThrow(OwnLeaveContentUnavailable);
    const shown = { ...f.content.review, availableBalance: 8, estimatedAvailableAfter: 7 };
    expect(() => sealOwnLeaveReview({ ...f.metadata, reviewedDigest: ownLeaveReviewedDigest(shown) },
      { ...f.content, review: shown })).toThrow(OwnLeaveContentUnavailable);
  });
});
