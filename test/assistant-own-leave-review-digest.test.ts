import { describe, expect, it } from 'vitest';
import { OwnLeaveReviewCandidate, ownLeaveReviewedDigest } from '../core/assistant-actions/own-leave-review-digest';
import { ownLeaveIntentDigest } from '../core/assistant-actions/own-leave-review';
import { todayInKualaLumpur } from '../lib/hr-date';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = { tenantId: id(1), userId: id(2), personId: id(3), companyId: id(4), employmentId: id(5) };
const nomination = { action: 'leave.apply', contractVersion: 1, employmentId: id(5), leaveTypeId: id(6),
  date: todayInKualaLumpur(), durationType: 'full_day' };
const humanText = { reason: 'Fictional private reason', employeeRemark: 'Fictional own remark' };
const review = { binding, nomination, humanText, intentDigest: ownLeaveIntentDigest(binding, nomination, humanText),
  companyName: 'Fictional Company A', employeeCode: 'FIC-001', leaveTypeName: 'Annual Leave',
  deductionDays: 0.5, availableBalance: 8, estimatedAvailableAfter: 7.5, approvalRouting: 'unknown', holidayWarnings: [] };

describe('exact own-leave human review digest', () => {
  it('keeps a distinct domain from immutable input and copies no private content', () => {
    const digest = ownLeaveReviewedDigest(review);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(review.intentDigest);
    expect(digest).not.toContain(humanText.reason);
    expect(digest).not.toContain(review.companyName);
  });

  it.each([
    { companyName: 'Fictional Company B' }, { employeeCode: null }, { leaveTypeName: 'Renamed Annual' },
    { deductionDays: 1 }, { availableBalance: 7 }, { estimatedAvailableAfter: 6.5 },
    { availableBalance: null, estimatedAvailableAfter: null },
  ])('changes with the exact review field: %j', change => {
    expect(ownLeaveReviewedDigest({ ...review, ...change })).not.toBe(ownLeaveReviewedDigest(review));
  });

  it('does not depend on object key order', () => {
    const reordered = { approvalRouting: review.approvalRouting, estimatedAvailableAfter: review.estimatedAvailableAfter,
      availableBalance: review.availableBalance, deductionDays: review.deductionDays, leaveTypeName: review.leaveTypeName,
      employeeCode: review.employeeCode, companyName: review.companyName, intentDigest: review.intentDigest,
      humanText, nomination, binding, holidayWarnings: review.holidayWarnings };
    expect(ownLeaveReviewedDigest(reordered)).toBe(ownLeaveReviewedDigest(review));
  });

  it('changes with rebound human text and refuses a stale intent digest', () => {
    const changedText = { ...humanText, reason: humanText.reason + ' ' };
    expect(() => ownLeaveReviewedDigest({ ...review, humanText: changedText })).toThrow('Own-leave review unavailable');
    expect(ownLeaveReviewedDigest({ ...review, humanText: changedText,
      intentDigest: ownLeaveIntentDigest(binding, nomination, changedText) })).not.toBe(ownLeaveReviewedDigest(review));
  });

  it('binds every shown canonical warning field, including its presence, without depending on key order', () => {
    const warning = { country: 'MY', state: null, year: Number(nomination.date.slice(0, 4)), loaded: 4, required: 11 };
    const warned = { ...review, holidayWarnings: [warning] };
    expect(ownLeaveReviewedDigest(warned)).not.toBe(ownLeaveReviewedDigest(review));
    for (const change of [{ country: 'SG' }, { state: 'Selangor' }, { year: warning.year + 1 },
      { loaded: 5 }, { required: 12 }]) {
      expect(ownLeaveReviewedDigest({ ...review, holidayWarnings: [{ ...warning, ...change }] }))
        .not.toBe(ownLeaveReviewedDigest(warned));
    }
    expect(ownLeaveReviewedDigest({ ...review, holidayWarnings: [{ required: 11, loaded: 4,
      year: warning.year, state: null, country: 'MY' }] })).toBe(ownLeaveReviewedDigest(warned));
  });

  it.each([
    { binding: { ...binding, userId: id(9) } }, { nomination: { ...nomination, employmentId: id(9) } },
    { binding: { ...binding, userId: 'private invalid identity' } },
    { nomination: { ...nomination, date: 'not a calendar date' } },
    { humanText: { reason: 'x'.repeat(2001) } },
    { availableBalance: null }, { estimatedAvailableAfter: null }, { deductionDays: 0 },
    { deductionDays: Number.NaN }, { availableBalance: Number.POSITIVE_INFINITY },
    { approvalRouting: 'approved' }, { requestApproved: true }, { receipt: 'private sentinel' },
    { holidayWarnings: undefined },
    { holidayWarnings: [{ country: 'MY', state: null, year: 2026, loaded: 11, required: 11 }] },
    { holidayWarnings: [{ country: 'MY', state: null, year: 2026, loaded: -1, required: 11 }] },
    { holidayWarnings: [{ country: 'MY', state: null, year: 2026, loaded: 1, required: 11, approval: true }] },
  ])('refuses inconsistent, malformed or overstated review content: %j', change => {
    expect(OwnLeaveReviewCandidate.safeParse({ ...review, ...change }).success).toBe(false);
    expect(() => ownLeaveReviewedDigest({ ...review, ...change })).toThrow('Own-leave review unavailable');
  });
});
