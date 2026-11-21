/**
 * Recruitment slice 10 pure rules (no database): contract usability and expiry on Kuala Lumpur dates, channel protection,
 * the Duplicate / Suspected rule, the stored outcome per check result, input validation, and the labels every new kind
 * needs in all six locales. test/recruitment-agencies.test.ts proves the same rules against Postgres (cases 66–73).
 */
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { todayInKualaLumpur } from '../lib/hr-date';
import { RECRUITMENT_TASK_KINDS } from '../lib/assigned-work';
import {
  AGENCY_DAILY_LIMIT, AGENCY_PROTECTION_DEFAULT_DAYS, CHECK_OUTCOMES, CONSULTANT_STATUSES, CONTRACT_ACCESS, CONTRACT_STATUSES, CONTRACT_TYPES, SUBMISSION_OUTCOMES, addDays,
  contractExpiryDue, contractUsableOn, daysUntil, feeRate, insideProtection, isDay, matchKind, protectionDays, submissionFor, validateConsultantInput,
  validateContractInput, validateRequirements, validateReviewReason, validateSubmissionInput,
} from '../packs/recruitment/agency-model';
import { RECRUITMENT_ERROR_CODES } from '../packs/recruitment/model';
import { todoHref, todoToPackTask, UPDATE_KINDS } from '../packs/recruitment/tasks-model';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('contract usability and expiry on Kuala Lumpur dates', () => {
  it('is usable from its start to its end date inclusive, only while Enabled', () => {
    const c = { status: 'enabled' as const, startsOn: '2026-11-11', endsOn: '2026-12-31' };
    expect(contractUsableOn(c, '2026-11-10')).toBe(false);
    expect(contractUsableOn(c, '2026-11-11')).toBe(true);
    expect(contractUsableOn(c, '2026-12-31')).toBe(true);
    expect(contractUsableOn(c, '2027-01-01')).toBe(false);
    expect(contractUsableOn({ ...c, status: 'disabled' }, '2026-11-20')).toBe(false);
  });
  it('turns the day over at Kuala Lumpur midnight, not UTC midnight (through the HR date owner)', () => {
    const c = { status: 'enabled' as const, startsOn: '2026-11-11', endsOn: '2026-11-30' };
    // 2026-11-10T15:59:59Z is 23:59:59 on 10 November in Kuala Lumpur; one second later it is 11 November there.
    expect(contractUsableOn(c, todayInKualaLumpur(new Date('2026-11-10T15:59:59Z')))).toBe(false);
    expect(contractUsableOn(c, todayInKualaLumpur(new Date('2026-11-10T16:00:00Z')))).toBe(true);
    expect(contractUsableOn(c, todayInKualaLumpur(new Date('2026-11-30T15:59:59Z')))).toBe(true);
    expect(contractUsableOn(c, todayInKualaLumpur(new Date('2026-11-30T16:00:00Z')))).toBe(false);
  });
  it('gives the HR contact the expiry to-do from 30 days before the end date until the end date, while Enabled', () => {
    const c = { status: 'enabled' as const, startsOn: '2026-01-01', endsOn: '2026-12-31' };
    expect(contractExpiryDue(c, '2026-11-30')).toBe(false);
    expect(contractExpiryDue(c, '2026-12-01')).toBe(true);
    expect(contractExpiryDue(c, '2026-12-31')).toBe(true);
    expect(contractExpiryDue(c, '2027-01-01')).toBe(false);
    expect(contractExpiryDue({ ...c, status: 'disabled' }, '2026-12-15')).toBe(false);
    expect(daysUntil('2026-12-01', '2026-12-31')).toBe(30);
    expect(daysUntil('2026-12-31', '2026-12-31')).toBe(0);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(isDay('2026-02-30')).toBe(false);
  });
});

describe('protection', () => {
  it('counts days from the protecting application\'s Kuala Lumpur date, both ends included, zero protecting nothing', () => {
    const today = '2026-11-11';
    expect(insideProtection('2026-11-11', 365, today)).toBe(true);
    expect(insideProtection(addDays(today, -364), 365, today)).toBe(true);
    expect(insideProtection(addDays(today, -365), 365, today)).toBe(false);
    expect(insideProtection(addDays(today, -29), 30, today)).toBe(true);
    expect(insideProtection(addDays(today, -30), 30, today)).toBe(false);
    expect(insideProtection(today, 0, today)).toBe(false);
  });
  it('agency or RPO 365 days unless the contract overrides; referral the company setting; any other source 0', () => {
    expect(AGENCY_PROTECTION_DEFAULT_DAYS).toBe(365);
    expect(protectionDays({ kind: 'agency', protectionDays: null }, 180)).toBe(365);
    expect(protectionDays({ kind: 'agency', protectionDays: 30 }, 180)).toBe(30);
    expect(protectionDays({ kind: 'agency', protectionDays: 0 }, 180)).toBe(0);
    expect(protectionDays({ kind: 'referral' }, 180)).toBe(180);
    expect(protectionDays({ kind: 'referral' }, 0)).toBe(0);
    expect(protectionDays({ kind: 'other' }, 180)).toBe(0);
  });
});

describe('Duplicate and Suspected', () => {
  const existing = { fullName: 'Fictional  Person', email: 'Person@Example.test', mobile: '012-345 6789', idNumber: 'A1234-567' };
  it('is a Duplicate on the same ID number, or the same name with the same e-mail or mobile (normalised)', () => {
    expect(matchKind({ fullName: 'Other', idNumber: 'a1234567' }, existing)).toBe('duplicate');
    expect(matchKind({ fullName: 'fictional person', email: 'person@example.test' }, existing)).toBe('duplicate');
    expect(matchKind({ fullName: 'FICTIONAL PERSON', mobile: '0123456789' }, existing)).toBe('duplicate');
  });
  it('is Suspected on the same e-mail and mobile under another name, and nothing on one item alone', () => {
    expect(matchKind({ fullName: 'Someone Else', email: 'person@example.test', mobile: '+0123456789' }, existing)).toBe('suspected');
    expect(matchKind({ fullName: 'Fictional Person' }, existing)).toBeNull();
    expect(matchKind({ fullName: 'Someone', email: 'person@example.test' }, existing)).toBeNull();
    expect(matchKind({ fullName: 'Someone', mobile: '0123456789' }, existing)).toBeNull();
  });
  it('stores New as accepted, protected as Refused, Duplicate and Suspected as waiting, and stores nothing for a repeat (D-038)', () => {
    expect(CHECK_OUTCOMES.map((o) => submissionFor(o))).toEqual([
      null,
      { outcome: 'refused', matchKind: 'duplicate', refusalReason: 'protected' },
      { outcome: 'waiting', matchKind: 'duplicate', refusalReason: null },
      { outcome: 'waiting', matchKind: 'suspected', refusalReason: null },
      { outcome: 'accepted', matchKind: 'new', refusalReason: null },
      null,
    ]);
    expect(CHECK_OUTCOMES).toEqual(['repeat', 'protected', 'duplicate', 'suspected', 'new', 'limit']);
    expect(AGENCY_DAILY_LIMIT).toBe(50);
    expect(SUBMISSION_OUTCOMES).toEqual(['accepted', 'refused', 'waiting', 'rejected']);
  });
});

describe('input', () => {
  it('reads a fee rate in percent with at most two decimals, 0–100, never computing an amount (D-037)', () => {
    expect(feeRate('12.5')).toBe('12.50');
    expect(feeRate('0')).toBe('0.00');
    expect(feeRate('100')).toBe('100.00');
    expect(feeRate('20%')).toBe('20.00');
    for (const bad of ['100.01', '-1', '1.234', 'x', '1e2', '1000']) expect(feeRate(bad)).toBeUndefined();
    expect(feeRate('')).toBeNull();
  });
  it('validates a contract: required fields, a period that ends on or after it starts, and an override of 0–730 days', () => {
    const ok = { name: 'Fictional contract', contractType: 'rpo', feeRate: '15', startsOn: '2026-11-11', endsOn: '2026-11-11', hrContactUserId: UUID };
    expect(validateContractInput(ok)).toEqual({ ok: true, value: { ...ok, feeRate: '15.00', status: 'enabled', access: 'public', protectionDays: null } });
    expect(validateContractInput({})).toMatchObject({ ok: false, code: 'missing_fields', fields: ['name', 'contractType', 'feeRate', 'startsOn', 'endsOn', 'hrContactUserId'] });
    expect(validateContractInput({ ...ok, endsOn: '2026-11-10' })).toMatchObject({ ok: false, fields: ['endsOn'] });
    expect(validateContractInput({ ...ok, protectionDays: '731' })).toMatchObject({ ok: false, fields: ['protectionDays'] });
    expect(validateContractInput({ ...ok, protectionDays: '0' })).toMatchObject({ ok: true, value: { protectionDays: 0 } });
    expect(validateContractInput({ ...ok, name: 'x'.repeat(121) })).toMatchObject({ ok: false, fields: ['name'] });
    expect(validateContractInput({ ...ok, contractType: 'temp' })).toMatchObject({ ok: false, fields: ['contractType'] });
    expect([CONTRACT_TYPES, CONTRACT_STATUSES, CONTRACT_ACCESS, CONSULTANT_STATUSES]).toEqual([['headhunter', 'rpo'], ['enabled', 'disabled'], ['public', 'restricted'], ['active', 'disabled']]);
  });
  it('validates a consultant (a contact record) and the requirements text', () => {
    expect(validateConsultantInput({ name: ' Fictional Consultant ', email: 'A@B.test' })).toEqual({ ok: true, value: { name: 'Fictional Consultant', email: 'a@b.test', mobile: null, status: 'active' } });
    expect(validateConsultantInput({ name: '' })).toMatchObject({ ok: false, code: 'missing_fields' });
    expect(validateConsultantInput({ name: 'x', email: 'not-an-email' })).toMatchObject({ ok: false, fields: ['email'] });
    expect(validateRequirements('x'.repeat(2000))).toMatchObject({ ok: true });
    expect(validateRequirements('x'.repeat(2001))).toMatchObject({ ok: false });
    expect(validateReviewReason('')).toMatchObject({ ok: false, code: 'missing_fields' });
  });
  it('validates a submission: name, e-mail or mobile, restricted values, comments and the date (not future, not before the contract start)', () => {
    const today = '2026-11-11';
    expect(validateSubmissionInput({ fullName: 'Fictional', email: 'F@X.test' }, today, '2026-11-01')).toEqual({ ok: true, value: {
      fullName: 'Fictional', email: 'f@x.test', mobile: null, idType: null, idNumber: null, currentSalaryAmount: null, currentSalaryCurrency: null,
      expectedSalaryAmount: null, expectedSalaryCurrency: null, comments: null, submittedOn: today,
    } });
    expect(validateSubmissionInput({ fullName: '' }, today, null)).toMatchObject({ ok: false, code: 'missing_fields', fields: ['fullName', 'emailOrMobile'] });
    expect(validateSubmissionInput({ fullName: 'F', mobile: '012' , idNumber: 'X1' }, today, null)).toMatchObject({ ok: false, fields: ['idType'] });
    expect(validateSubmissionInput({ fullName: 'F', mobile: '012', currentSalaryAmount: '1.234' }, today, null)).toMatchObject({ ok: false, fields: ['currentSalaryAmount'] });
    expect(validateSubmissionInput({ fullName: 'F', mobile: '012', currentSalaryAmount: '100' }, today, null)).toMatchObject({ ok: false, fields: ['currentSalaryCurrency'] });
    expect(validateSubmissionInput({ fullName: 'F', mobile: '012', comments: 'x'.repeat(2001) }, today, null)).toMatchObject({ ok: false, fields: ['comments'] });
    expect(validateSubmissionInput({ fullName: 'F', mobile: '012', submittedOn: '2026-11-12' }, today, null)).toMatchObject({ ok: false, fields: ['submittedOn'] });
    expect(validateSubmissionInput({ fullName: 'F', mobile: '012', submittedOn: '2026-10-31' }, today, '2026-11-01')).toMatchObject({ ok: false, fields: ['submittedOn'] });
    expect(validateSubmissionInput({ fullName: 'F', mobile: '012', submittedOn: '2026-11-01' }, today, '2026-11-01')).toMatchObject({ ok: true });
  });
});

describe('tasks, links and labels', () => {
  it('links the review to-do to the submission and the expiry to-do to the contract; both reach the bell', () => {
    expect(todoHref('agencyReview', { id: UUID })).toBe(`/recruitment/agency-submissions/${UUID}`);
    expect(todoHref('contractExpiry', { id: UUID })).toBe(`/recruitment/settings/agencies/contracts/${UUID}`);
    const item = { id: UUID, companyId: UUID, jobId: null, number: null, candidateName: null, candidateRemoved: false, count: null, step: null, at: '2026-11-11T00:00:00.000Z', href: '/x' };
    expect(todoToPackTask({ ...item, kind: 'contractExpiry', title: 'Fictional Agency · Fictional contract' })).toEqual({
      id: `contractExpiry:${UUID}`, kind: 'recruitmentContractExpiry', subjectName: 'Fictional Agency · Fictional contract', createdAt: item.at, linkPath: '/x',
    });
    expect(todoToPackTask({ ...item, kind: 'agencyReview', title: 'Fictional role', candidateName: 'Fictional Person' })!.kind).toBe('recruitmentAgencyReview');
    expect(RECRUITMENT_TASK_KINDS).toEqual(expect.arrayContaining(['recruitmentAgencyReview', 'recruitmentContractExpiry']));
    expect(UPDATE_KINDS.applications).toContain('agencySubmission');
  });
  type Messages = { notifications: { task: Record<string, string> }; recruitment: Record<string, unknown> };
  const locales = { en, ms, ta, th, vi, zh } as unknown as Record<string, Messages>;
  const get = (m: Messages, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], m);
  const KEYS = [
    'notifications.task.recruitmentAgencyReview', 'notifications.task.recruitmentContractExpiry', 'recruitment.tasks.todo.agencyReview', 'recruitment.tasks.todo.contractExpiry',
    'recruitment.tasks.update.agencySubmission', 'recruitment.tasks.endsOn', 'recruitment.settings.section.agencies', 'recruitment.agency.title', 'recruitment.agency.feeRate',
    'recruitment.agency.outcome.accepted', 'recruitment.agency.outcome.refused', 'recruitment.agency.outcome.waiting', 'recruitment.agency.outcome.rejected',
    'recruitment.agency.refusal.protected', 'recruitment.agency.addSubmission', 'recruitment.agency.reviewTitle',
    'recruitment.agency.removeData', 'recruitment.agency.dueTitle',
    ...['name_taken', 'tag_in_use', 'contract_unavailable', 'contact_invalid', 'repeat_submission', 'submission_decided', 'consultant_unavailable',
      'agency_daily_limit', 'candidate_busy'].map((c) => `recruitment.errors.${c}`),
  ];
  it('has every new label in all six locales, translated', () => {
    for (const [locale, m] of Object.entries(locales)) for (const key of KEYS) expect(get(m, key), `${locale} ${key}`).toBeTruthy();
    for (const [locale, m] of Object.entries(locales)) {
      if (locale === 'en') continue;
      for (const key of KEYS) expect(get(m, key), `${locale} ${key}`).not.toBe(get(locales.en, key));
    }
    for (const c of RECRUITMENT_ERROR_CODES) expect(get(locales.en, `recruitment.errors.${c}`), c).toBeTruthy();
  });
});
