/**
 * Recruitment slice 5 pure rules (packs/recruitment/privacy-model.ts): duplicate matching, the retention due day and the
 * repeated-application window. No database and no clock: every "today" is a fixed Kuala Lumpur day, and month
 * arithmetic goes through the HR date owner (lib/hr-date addCalendarMonths). Independent expected values are written out
 * by hand. All data is fictional.
 */
import { describe, expect, it } from 'vitest';
import {
  currentConsent, duplicateMatch, moneyAmount, normEmail, normIdNumber, normMobile, normName, repeatApplicationBlocked, retentionDueOn, retentionEnded,
  validateConsentInput, validateDestruction, validateEntryInput, validatePrivacySettings, validateProfileInput, validateRestrictedInput,
} from '../packs/recruitment/privacy-model';

describe('normalisers (ASCII case folding, mirrored by app.recruitment_norm_* in 5205)', () => {
  it('folds spacing and case, keeps digits only, and upper-cases ID numbers without separators', () => {
    expect(normName('  Fictional   Aisyah\tBINTI  Rahman ')).toBe('fictional aisyah binti rahman');
    expect(normEmail(' Fictional.One@Example.TEST ')).toBe('fictional.one@example.test');
    expect(normMobile('+60 12-345 6789')).toBe('60123456789');
    expect(normIdNumber('900101-14-5678')).toBe('900101145678');
    expect(normIdNumber('a1234567')).toBe('A1234567');
    expect([normName('  '), normEmail(''), normMobile('no digits'), normIdNumber(null)]).toEqual([null, null, null, null]);
  });
});

describe('duplicateMatch — the same ID number, or two of email, name and mobile', () => {
  const existing = { fullName: 'Fictional Candidate One', email: 'one@example.test', mobile: '012-345 6789', idNumber: '900101-14-5678' };
  it('matches on the ID number alone', () => {
    expect(duplicateMatch({ fullName: 'Someone Else', idNumber: '900101145678' }, existing)).toBe(true);
  });
  it('matches on any two of the three contact items', () => {
    expect(duplicateMatch({ fullName: 'FICTIONAL  candidate one', email: 'ONE@example.test' }, existing)).toBe(true);
    expect(duplicateMatch({ fullName: 'Fictional Candidate One', mobile: '0123456789' }, existing)).toBe(true);
    expect(duplicateMatch({ fullName: 'Different Name', email: 'one@example.test', mobile: '(012) 345-6789' }, existing)).toBe(true);
    expect(duplicateMatch({ fullName: 'Different Name', email: 'one@example.test', mobile: '012 345 6780' }, existing)).toBe(false);
  });
  it('one matching item is not a duplicate; empty values never match', () => {
    expect(duplicateMatch({ fullName: 'Fictional Candidate One' }, existing)).toBe(false);
    expect(duplicateMatch({ fullName: 'Other', email: 'one@example.test' }, existing)).toBe(false);
    expect(duplicateMatch({ fullName: 'Other', mobile: '0123456789' }, existing)).toBe(false);
    expect(duplicateMatch({ fullName: 'Other', email: '', mobile: '' }, { fullName: 'Another', email: '', mobile: '' })).toBe(false);
    expect(duplicateMatch({ fullName: 'Other', idNumber: '' }, { fullName: 'Another', idNumber: '' })).toBe(false);
  });
});

describe('repeatApplicationBlocked — the same job while active or closed within the window (Kuala Lumpur months)', () => {
  const job = 'job-a';
  it('refuses while an earlier application to the same job is active, whatever the window', () => {
    expect(repeatApplicationBlocked([{ jobId: job, state: 'active', closedOn: null }], job, 0, '2026-11-10')).toBe(true);
    expect(repeatApplicationBlocked([{ jobId: job, state: 'active', closedOn: null }], job, 3, '2026-11-10')).toBe(true);
  });
  it('refuses within the window and allows from its end day (month-end clamped)', () => {
    const archived = [{ jobId: job, state: 'archived' as const, closedOn: '2026-08-31' }];
    // 31 Aug + 3 months = 30 Nov (clamped): blocked through 29 Nov, allowed on 30 Nov.
    expect(repeatApplicationBlocked(archived, job, 3, '2026-11-29')).toBe(true);
    expect(repeatApplicationBlocked(archived, job, 3, '2026-11-30')).toBe(false);
    expect(repeatApplicationBlocked(archived, job, 1, '2026-09-30')).toBe(false); // 31 Aug + 1 month = 30 Sep
    expect(repeatApplicationBlocked(archived, job, 12, '2027-08-30')).toBe(true);
    expect(repeatApplicationBlocked(archived, job, 12, '2027-08-31')).toBe(false);
  });
  it('allows with the setting off, and always for another job', () => {
    expect(repeatApplicationBlocked([{ jobId: job, state: 'archived', closedOn: '2026-11-10' }], job, 0, '2026-11-10')).toBe(false);
    expect(repeatApplicationBlocked([{ jobId: job, state: 'archived', closedOn: '2026-11-10' }], 'job-b', 3, '2026-11-10')).toBe(false);
    expect(repeatApplicationBlocked([{ jobId: job, state: 'active', closedOn: null }], 'job-b', 3, '2026-11-10')).toBe(false);
  });
  it('treats a hired application like a closed one', () => {
    expect(repeatApplicationBlocked([{ jobId: job, state: 'hired', closedOn: '2026-10-01' }], job, 3, '2026-11-10')).toBe(true);
  });
});

describe('retentionDueOn — from the latest archival, or the later consent; withdrawal restarts without consent', () => {
  const base = { hasActive: false, hasHired: false, latestArchivedOn: '2026-01-31', consent: null, monthsWithoutConsent: 6, monthsWithConsent: 24 };
  it('without consent: archival + 6 months (month-end clamped)', () => {
    expect(retentionDueOn(base)).toBe('2026-07-31');
    expect(retentionDueOn({ ...base, latestArchivedOn: '2026-08-31' })).toBe('2027-02-28');
  });
  it('with consent: from the later of archival and consent, + 24 months', () => {
    expect(retentionDueOn({ ...base, consent: { status: 'consented', on: '2025-12-01' } })).toBe('2028-01-31');
    expect(retentionDueOn({ ...base, consent: { status: 'consented', on: '2026-03-15' } })).toBe('2028-03-15');
  });
  it('withdrawn: restarts without consent from the withdrawal date when later', () => {
    expect(retentionDueOn({ ...base, consent: { status: 'withdrawn', on: '2026-05-20' } })).toBe('2026-11-20');
    expect(retentionDueOn({ ...base, consent: { status: 'withdrawn', on: '2025-05-20' } })).toBe('2026-07-31');
  });
  it('never due with an active application, when hired, or with nothing archived', () => {
    expect(retentionDueOn({ ...base, hasActive: true })).toBeNull();
    expect(retentionDueOn({ ...base, hasHired: true })).toBeNull();
    expect(retentionDueOn({ ...base, latestArchivedOn: null })).toBeNull();
  });
  it('ends on the due day itself', () => {
    expect(retentionEnded('2026-07-31', '2026-07-30')).toBe(false);
    expect(retentionEnded('2026-07-31', '2026-07-31')).toBe(true);
    expect(retentionEnded(null, '2099-01-01')).toBe(false);
  });
  it('the current consent is the latest by date, then by recording time', () => {
    expect(currentConsent([])).toBeNull();
    expect(currentConsent([
      { status: 'consented', effectiveOn: '2026-01-01', recordedAt: '2026-01-02T00:00:00.000Z' },
      { status: 'withdrawn', effectiveOn: '2026-02-01', recordedAt: '2026-02-01T00:00:00.000Z' },
      { status: 'consented', effectiveOn: '2026-02-01', recordedAt: '2026-02-03T00:00:00.000Z' },
    ])).toEqual({ status: 'consented', on: '2026-02-01' });
  });
});

describe('input validation', () => {
  it('profile: a name is required; choices and lengths are checked', () => {
    expect(validateProfileInput({ fullName: '' })).toEqual({ ok: false, code: 'missing_fields', fields: ['fullName'] });
    expect(validateProfileInput({ fullName: 'Fictional One', highestEducation: 'phd', source: 'billboard' })).toEqual({ ok: false, code: 'invalid_input', fields: ['highestEducation', 'source'] });
    const ok = validateProfileInput({ fullName: ' Fictional One ', email: 'One@Example.test', highestEducation: 'bachelor', source: 'referral', noticePeriod: '1 month' });
    expect(ok).toMatchObject({ ok: true, value: { fullName: 'Fictional One', email: 'one@example.test', highestEducation: 'bachelor', source: 'referral', location: null } });
  });
  it('restricted: money is typed by people (two decimals, currency required); an ID number needs its type', () => {
    expect(moneyAmount('4,500')).toBe('4500.00');
    expect(moneyAmount('0012.5')).toBe('12.50');
    expect(moneyAmount('12.345')).toBeUndefined();
    expect(validateRestrictedInput({ currentSalaryAmount: '5000', currentSalaryCurrency: 'myr', idType: 'nric', idNumber: '900101-14-5678' }))
      .toEqual({ ok: true, value: { currentSalaryAmount: '5000.00', currentSalaryCurrency: 'MYR', expectedSalaryAmount: null, expectedSalaryCurrency: null, idType: 'nric', idNumber: '900101-14-5678' } });
    expect(validateRestrictedInput({ expectedSalaryAmount: '6000' })).toEqual({ ok: false, code: 'invalid_input', fields: ['expectedSalaryCurrency'] });
    expect(validateRestrictedInput({ idNumber: 'A1234567' })).toEqual({ ok: false, code: 'invalid_input', fields: ['idType'] });
  });
  it('entries: months as YYYY-MM, a current job has no end', () => {
    expect(validateEntryInput({ kind: 'work', organisation: 'Fictional Sdn Bhd', fromMonth: '2024-03', isCurrent: 'on', toMonth: '2025-01' }))
      .toEqual({ ok: true, value: { kind: 'work', organisation: 'Fictional Sdn Bhd', title: null, fromMonth: '2024-03-01', toMonth: null, isCurrent: true } });
    expect(validateEntryInput({ kind: 'education', organisation: 'Fictional University', fromMonth: '2020-09', toMonth: '2019-06' }))
      .toEqual({ ok: false, code: 'invalid_input', fields: ['toMonth'] });
    expect(validateEntryInput({ kind: 'hobby', organisation: 'x' })).toEqual({ ok: false, code: 'missing_fields', fields: ['kind'] });
  });
  it('consent: status, method and a date not after today (Kuala Lumpur)', () => {
    expect(validateConsentInput({ status: 'consented', method: 'email', effectiveOn: '2026-11-11' }, '2026-11-10')).toEqual({ ok: false, code: 'invalid_input', fields: ['effectiveOn'] });
    expect(validateConsentInput({ status: 'consented', effectiveOn: '2026-11-10' }, '2026-11-10')).toEqual({ ok: false, code: 'missing_fields', fields: ['method'] });
    expect(validateConsentInput({ status: 'withdrawn', method: 'verbal', effectiveOn: '2026-11-10', noticeReference: 'PN-2026-01' }, '2026-11-10'))
      .toEqual({ ok: true, value: { status: 'withdrawn', method: 'verbal', effectiveOn: '2026-11-10', noticeReference: 'PN-2026-01' } });
  });
  it('privacy settings: 1–120 months; the repeat window is one of off, 1, 3, 6, 12', () => {
    expect(validatePrivacySettings({ monthsWithoutConsent: '6', monthsWithConsent: '24', repeatWindowMonths: '0' }))
      .toEqual({ ok: true, value: { monthsWithoutConsent: 6, monthsWithConsent: 24, repeatWindowMonths: 0 } });
    expect(validatePrivacySettings({ monthsWithoutConsent: '0', monthsWithConsent: '121', repeatWindowMonths: '2' }))
      .toEqual({ ok: false, code: 'invalid_input', fields: ['monthsWithoutConsent', 'monthsWithConsent', 'repeatWindowMonths'] });
  });
  it('destruction needs an explicit confirmation and real ids', () => {
    const id = '0b6a3a8e-5c0f-4d3e-9a51-2f1b8e3c7d10';
    expect(validateDestruction([id], undefined)).toEqual({ ok: false, code: 'confirm_required' });
    expect(validateDestruction(['not-an-id'], 'on')).toEqual({ ok: false, code: 'invalid_input' });
    expect(validateDestruction([id, id], 'on')).toEqual({ ok: true, ids: [id] });
  });
});
