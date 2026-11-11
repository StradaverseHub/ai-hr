/**
 * Recruitment slice 7 pure rules (no database): the refer form's validation, the protection-period setting and the coarse
 * status a referrer sees on My referrals (packs/recruitment/referral-model.ts). The database enforces the same limits in
 * db/migrations/4407_recruitment_referrals.sql; test/recruitment-referrals.test.ts proves that half.
 */
import { describe, expect, it } from 'vitest';
import {
  REFERRAL_DAILY_LIMIT, REFERRAL_PROTECTION_DEFAULT_DAYS, REFERRAL_PROTECTION_MAX_DAYS, REFERRAL_REASON_MAX, REFERRAL_STATUSES, referralIdentity, referralStatus,
  validateProtectionDays, validateReferralInput, type ReferralProgress,
} from '../packs/recruitment/referral-model';

const ok = { fullName: ' Fictional Candidate ', email: 'Fictional.Candidate@Example.TEST', mobile: '', reason: ' Strong analyst ', confirmed: 'on' };

describe('the refer form', () => {
  it('accepts a complete referral, trimming text and lower-casing the e-mail', () => {
    expect(validateReferralInput(ok)).toEqual({ ok: true, value: { fullName: 'Fictional Candidate', email: 'fictional.candidate@example.test', mobile: null, reason: 'Strong analyst' } });
    expect(validateReferralInput({ ...ok, email: '', mobile: ' +60 12-345 6789 ', confirmed: true })).toEqual({
      ok: true, value: { fullName: 'Fictional Candidate', email: null, mobile: '+60 12-345 6789', reason: 'Strong analyst' },
    });
  });

  it('names every missing field: the name, an e-mail or mobile, and the reason', () => {
    expect(validateReferralInput({ ...ok, fullName: '  ' })).toEqual({ ok: false, code: 'missing_fields', fields: ['fullName'] });
    expect(validateReferralInput({ ...ok, email: '', mobile: undefined })).toEqual({ ok: false, code: 'missing_fields', fields: ['emailOrMobile'] });
    expect(validateReferralInput({ ...ok, reason: '' })).toEqual({ ok: false, code: 'missing_fields', fields: ['reason'] });
    expect(validateReferralInput({})).toEqual({ ok: false, code: 'missing_fields', fields: ['fullName', 'emailOrMobile', 'reason'] });
  });

  it('refuses a reason over 1,000 characters (counted as characters, not bytes), a bad e-mail or mobile, and a missing agreement', () => {
    expect(REFERRAL_REASON_MAX).toBe(1000);
    expect(validateReferralInput({ ...ok, reason: 'x'.repeat(1000) }).ok).toBe(true);
    expect(validateReferralInput({ ...ok, reason: '推'.repeat(1000) }).ok).toBe(true);
    expect(validateReferralInput({ ...ok, reason: 'x'.repeat(1001) })).toEqual({ ok: false, code: 'invalid_input', fields: ['reason'] });
    expect(validateReferralInput({ ...ok, email: 'no-at-sign' })).toEqual({ ok: false, code: 'invalid_input', fields: ['email'] });
    expect(validateReferralInput({ ...ok, email: '', mobile: 'call me' })).toEqual({ ok: false, code: 'invalid_input', fields: ['mobile'] });
    expect(validateReferralInput({ ...ok, fullName: 'n'.repeat(201) })).toEqual({ ok: false, code: 'invalid_input', fields: ['fullName'] });
    for (const confirmed of [undefined, false, '', 'off']) {
      expect(validateReferralInput({ ...ok, confirmed })).toEqual({ ok: false, code: 'confirm_required', fields: ['confirmed'] });
    }
    expect(validateReferralInput({ ...ok, fullName: 42 })).toEqual({ ok: false, code: 'invalid_input', fields: ['form'] });
  });

  it('locks and matches on the slice 5 normalised identity', () => {
    expect(referralIdentity({ email: ' A.B@Example.test ', mobile: '+60 12-345 6789' })).toEqual({ email: 'a.b@example.test', mobile: '60123456789' });
    expect(referralIdentity({ email: null, mobile: null })).toEqual({ email: null, mobile: null });
  });
});

describe('the protection period setting', () => {
  it('is a whole number of days from 0 (off) to 730, default 180', () => {
    expect(REFERRAL_PROTECTION_DEFAULT_DAYS).toBe(180);
    expect(REFERRAL_PROTECTION_MAX_DAYS).toBe(730);
    expect(REFERRAL_DAILY_LIMIT).toBe(20);
    expect(validateProtectionDays('0')).toBe(0);
    expect(validateProtectionDays(' 180 ')).toBe(180);
    expect(validateProtectionDays(730)).toBe(730);
    for (const bad of ['731', '-1', '1.5', 'abc', '', null, 12.5, 1000]) expect(validateProtectionDays(bad), String(bad)).toBeNull();
  });
});

describe('the coarse status on My referrals', () => {
  // The default process: 1 Application Review, 2 screening, 3 test, 4 screening, 5 interview, 6 offer, 7–8 none, 9 onboarding.
  const at = (stagePosition: number, stageType: string, over: Partial<ReferralProgress> = {}): ReferralProgress => ({
    state: 'active', removed: false, stageType, stagePosition, interviewPosition: 5, offerPosition: 6, ...over,
  });

  it('moves forward only: In review, Interviewing, Offer; then Hired or Not progressing; Removed wins', () => {
    expect(referralStatus(at(1, 'system_default'))).toBe('in_review');
    expect(referralStatus(at(2, 'screening'))).toBe('in_review');
    expect(referralStatus(at(3, 'test'))).toBe('in_review');
    expect(referralStatus(at(5, 'interview'))).toBe('interviewing');
    expect(referralStatus(at(6, 'offer'))).toBe('offer');
    // Stages after the offer (medical check-up, background check, onboarding) stay at Offer, never fall back to In review.
    expect(referralStatus(at(7, 'none'))).toBe('offer');
    expect(referralStatus(at(9, 'system_default'))).toBe('offer');
    expect(referralStatus(at(9, 'system_default', { state: 'hired' }))).toBe('hired');
    expect(referralStatus(at(5, 'interview', { state: 'archived' }))).toBe('not_progressing');
    expect(referralStatus(at(5, 'interview', { state: 'archived', removed: true }))).toBe('removed');
    expect(REFERRAL_STATUSES).toEqual(['in_review', 'interviewing', 'offer', 'hired', 'not_progressing', 'removed']);
  });

  it('works for a process without interview or offer stages, and for a stage moved out of the process', () => {
    expect(referralStatus(at(4, 'none', { interviewPosition: null, offerPosition: null }))).toBe('in_review');
    expect(referralStatus(at(4, 'interview', { interviewPosition: null, offerPosition: null }))).toBe('interviewing');
    expect(referralStatus({ state: 'active', removed: false, stageType: 'screening', stagePosition: null, interviewPosition: 5, offerPosition: 6 })).toBe('in_review');
  });
});
