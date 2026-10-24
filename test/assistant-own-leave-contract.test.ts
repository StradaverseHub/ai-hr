import { describe, expect, it } from 'vitest';
import { OwnLeaveConfirmation, OwnLeaveNomination } from '../lib/assistant-actions/own-leave-contract';
import { checkOwnLeaveConfirmation, ownLeaveIntentDigest } from '../core/assistant-actions/own-leave-review';
import { todayInKualaLumpur } from '../lib/hr-date';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = { tenantId: id(1), userId: id(2), personId: id(3), companyId: id(4), employmentId: id(5) };
const now = new Date();
const later = new Date(now.getTime() + 60_000);
const date = todayInKualaLumpur(later);
const intent = { action: 'leave.apply', contractVersion: 1, employmentId: id(5), leaveTypeId: id(6), date, durationType: 'full_day' };
const digest = 'a'.repeat(64);
const confirmation = { actionId: id(7), contractVersion: 1, reviewedDigest: digest };
const record = { actionId: id(7), action: 'leave.apply', contractVersion: 1, binding, intentDigest: 'b'.repeat(64),
  reviewedDigest: digest, state: 'awaiting_confirmation', createdAt: now.toISOString(), expiresAt: later.toISOString() };

describe('own-leave proposal and human confirmation boundaries', () => {
  it.each([
    { tenantId: id(9) }, { actorId: id(9) }, { approval: true }, { overrideConsent: ['all'] },
    { reason: 'A model-invented reason' }, { execute: true }, { endDate: date }, { document: 'payload' },
  ])('refuses model fields beyond one nomination: %j', extra => {
    expect(OwnLeaveNomination.safeParse({ ...intent, ...extra }).success).toBe(false);
  });
  it.each(['half_day_am', 'half_day_pm', 'hourly'])('hands unsupported duration %s out of this contract', durationType => {
    expect(OwnLeaveNomination.safeParse({ ...intent, durationType }).success).toBe(false);
  });
  it.each(['2024-02-30', '2023-02-29', '0000-01-01', 'next Friday'])('refuses invalid calendar date %s', invalid => {
    expect(OwnLeaveNomination.safeParse({ ...intent, date: invalid }).success).toBe(false);
  });
  it('does not let a confirmation replace reviewed business arguments or impersonate authority', () => {
    for (const extra of [{ date }, { employmentId: id(9) }, { userId: id(9) }, { reason: 'changed' }]) {
      expect(OwnLeaveConfirmation.safeParse({ ...confirmation, ...extra }).success).toBe(false);
    }
    expect(OwnLeaveConfirmation.safeParse({ ...confirmation, contractVersion: 2 }).success).toBe(false);
  });
});

describe('prepared intent integrity', () => {
  it('binds the digest to the login, tenant, person, company, subject and exact human text', () => {
    const text = { reason: 'Private reason', employeeRemark: 'Own remark' };
    const original = ownLeaveIntentDigest(binding, intent, text);
    for (const key of ['tenantId', 'userId', 'personId', 'companyId'] as const) {
      expect(ownLeaveIntentDigest({ ...binding, [key]: id(9) }, intent, text)).not.toBe(original);
    }
    expect(ownLeaveIntentDigest(binding, { ...intent, leaveTypeId: id(9) }, text)).not.toBe(original);
    expect(ownLeaveIntentDigest(binding, intent, { ...text, reason: text.reason + ' ' })).not.toBe(original);
    expect(ownLeaveIntentDigest({ ...binding, employmentId: id(9) }, { ...intent, employmentId: id(9) }, text)).not.toBe(original);
    expect(original).not.toContain(text.reason);
  });
  it('uses semantic field order and refuses a subject mismatch instead of substituting it', () => {
    const reordered = { durationType: intent.durationType, date: intent.date, leaveTypeId: intent.leaveTypeId,
      employmentId: intent.employmentId, contractVersion: intent.contractVersion, action: intent.action };
    expect(ownLeaveIntentDigest(binding, intent, {})).toBe(ownLeaveIntentDigest(binding, reordered, {}));
    expect(() => ownLeaveIntentDigest({ ...binding, employmentId: id(9) }, intent, {})).toThrow('subject mismatch');
  });
});

describe('confirmation preflight does not claim execution', () => {
  it('requires transactional live revalidation even for an intact preparation', () => {
    expect(checkOwnLeaveConfirmation(record, confirmation, binding, now)).toEqual({ kind: 'revalidate' });
  });
  it.each(['tenantId', 'userId', 'personId', 'companyId', 'employmentId'] as const)('refuses changed %s', key => {
    expect(checkOwnLeaveConfirmation(record, confirmation, { ...binding, [key]: id(9) }, now))
      .toEqual({ kind: 'refused', code: 'unavailable' });
  });
  it('refuses changed review, action ID, expiry boundary and future creation time', () => {
    expect(checkOwnLeaveConfirmation(record, { ...confirmation, reviewedDigest: 'c'.repeat(64) }, binding, now))
      .toEqual({ kind: 'refused', code: 'review_changed' });
    expect(checkOwnLeaveConfirmation(record, { ...confirmation, actionId: id(9) }, binding, now))
      .toEqual({ kind: 'refused', code: 'unavailable' });
    expect(checkOwnLeaveConfirmation(record, confirmation, binding, later)).toEqual({ kind: 'refused', code: 'expired' });
    expect(checkOwnLeaveConfirmation(record, confirmation, binding, new Date(now.getTime() - 1)))
      .toEqual({ kind: 'refused', code: 'unavailable' });
  });
  it.each(['completed', 'refused', 'discarded', 'expired'])('reconciles final state %s without another effect', state => {
    expect(checkOwnLeaveConfirmation({ ...record, state }, confirmation, binding, later)).toEqual({ kind: 'reconcile', state });
  });
  it.each([null, {}, { ...record, state: 'executing' }, { ...record, reason: 'private text' },
    { ...record, expiresAt: record.createdAt }])('fails closed on malformed metadata', value => {
    expect(checkOwnLeaveConfirmation(value, confirmation, binding, now)).toEqual({ kind: 'refused', code: 'unavailable' });
  });
});
