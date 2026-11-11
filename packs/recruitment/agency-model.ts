/**
 * Recruitment slice 10 rules — agencies and headhunters. Pure, deterministic and client-safe: no database, no clock, no
 * model. Dates are Kuala Lumpur calendar days (yyyy-mm-dd) handed in by the caller from lib/hr-date.
 *
 * db/migrations/4410_recruitment_agencies.sql enforces the same rules independently (usability on the Kuala Lumpur date,
 * the submission date, the outcome of the duplicate and protection check). Nothing here calculates a fee (D-037): the fee
 * rate is a percentage people type and read.
 */
import { CANDIDATE_FILE_MAX_BYTES, ID_TYPES, moneyAmount, normEmail, normIdNumber, normMobile, normName, type IdType } from './privacy-model';

export const CONTRACT_TYPES = ['headhunter', 'rpo'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const CONTRACT_STATUSES = ['enabled', 'disabled'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const CONTRACT_ACCESS = ['public', 'restricted'] as const;
export type ContractAccess = (typeof CONTRACT_ACCESS)[number];
export const CONSULTANT_STATUSES = ['active', 'disabled'] as const;
export type ConsultantStatus = (typeof CONSULTANT_STATUSES)[number];
/** accepted (a candidate and application exist), refused (protected by an earlier application), waiting (for an
 *  administrator), rejected (by an administrator). */
export const SUBMISSION_OUTCOMES = ['accepted', 'refused', 'waiting', 'rejected'] as const;
export type SubmissionOutcome = (typeof SUBMISSION_OUTCOMES)[number];
export const MATCH_KINDS = ['new', 'duplicate', 'suspected'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];
/** What app.recruitment_agency_submission_check answers. */
export const CHECK_OUTCOMES = ['repeat', 'protected', 'duplicate', 'suspected', 'new', 'limit'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const AGENCY_NAME_MAX = 120;
export const AGENCY_TAG_MAX = 60;
export const CONTRACT_NAME_MAX = 120;
export const CONSULTANT_NAME_MAX = 120;
export const REQUIREMENTS_MAX = 2000;
export const COMMENTS_MAX = 2000;
export const REVIEW_REASON_MAX = 1000;
/** An application accepted from an agency protects the agency's credit this long unless its contract overrides it. */
export const AGENCY_PROTECTION_DEFAULT_DAYS = 365;
export const PROTECTION_OVERRIDE_MAX_DAYS = 730;
/** The HR contact's to-do runs from this many days before the end date until the end date. */
export const CONTRACT_EXPIRY_NOTICE_DAYS = 30;
export const CONTRACT_FILE_MAX_BYTES = CANDIDATE_FILE_MAX_BYTES;
export const CONTRACT_FILE_ACCEPT = '.pdf,application/pdf';
/** At most this many agency submission ATTEMPTS (stored, refused, repeated or over the limit) per recorder per Kuala Lumpur
 *  date; the database counts them (4410), so refusals cannot be used to probe without bound. */
export const AGENCY_DAILY_LIMIT = 50;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day as yyyy-mm-dd. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
/** A calendar day `n` days from `day` (plain calendar arithmetic, no time zone). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type ContractDates = { status: ContractStatus; startsOn: string; endsOn: string };
/** Usable on `day` (a Kuala Lumpur date): Enabled and `day` within the contract period, both ends included. */
export function contractUsableOn(c: ContractDates, day: string): boolean {
  return c.status === 'enabled' && c.startsOn <= day && day <= c.endsOn;
}
/** The HR contact's expiry to-do shows from 30 days before the end date until the end date, while Enabled. */
export function contractExpiryDue(c: ContractDates, day: string): boolean {
  return c.status === 'enabled' && addDays(c.endsOn, -CONTRACT_EXPIRY_NOTICE_DAYS) <= day && day <= c.endsOn;
}
/** Days left until the end date (0 on the end date). */
export function daysUntil(day: string, endsOn: string): number {
  return Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
}

/**
 * Inside protection on `today`: the protecting application's Kuala Lumpur date is on or after today - days + 1, i.e. an
 * application on day D protects D … D + days - 1. Zero days protects nothing.
 */
export function insideProtection(appliedOn: string, days: number, today: string): boolean {
  return days > 0 && appliedOn >= addDays(today, -days + 1);
}
export type ProtectingChannel = { kind: 'agency'; protectionDays: number | null } | { kind: 'referral' } | { kind: 'other' };
/** The protection period of an earlier application's channel: agency or RPO 365 days unless its contract overrides it;
 *  employee referral the company's slice 7 setting; anything else 0. */
export function protectionDays(channel: ProtectingChannel, referralDays: number): number {
  if (channel.kind === 'agency') return channel.protectionDays ?? AGENCY_PROTECTION_DEFAULT_DAYS;
  if (channel.kind === 'referral') return referralDays;
  return 0;
}

export type Identity = { fullName?: string | null; email?: string | null; mobile?: string | null; idNumber?: string | null };
/**
 * How a typed identity matches an existing candidate (EV-050 "simple checking"): Duplicate — the same ID number, or the
 * same normalised name plus the same e-mail or mobile; Suspected — any two of name, e-mail and mobile but not as above
 * (that is, the same e-mail and mobile under another name); otherwise none.
 */
export function matchKind(incoming: Identity, existing: Identity): 'duplicate' | 'suspected' | null {
  const same = (a: string | null, b: string | null) => a !== null && a === b;
  if (same(normIdNumber(incoming.idNumber), normIdNumber(existing.idNumber))) return 'duplicate';
  const name = same(normName(incoming.fullName), normName(existing.fullName));
  const email = same(normEmail(incoming.email), normEmail(existing.email));
  const mobile = same(normMobile(incoming.mobile), normMobile(existing.mobile));
  if (name && (email || mobile)) return 'duplicate';
  return Number(name) + Number(email) + Number(mobile) >= 2 ? 'suspected' : null;
}

/** The stored submission for a check outcome (D-038). A repeat, or an attempt over the daily limit, stores nothing. */
export function submissionFor(outcome: CheckOutcome): { outcome: SubmissionOutcome; matchKind: MatchKind; refusalReason: 'protected' | null } | null {
  switch (outcome) {
    case 'new': return { outcome: 'accepted', matchKind: 'new', refusalReason: null };
    case 'protected': return { outcome: 'refused', matchKind: 'duplicate', refusalReason: 'protected' };
    case 'duplicate': return { outcome: 'waiting', matchKind: 'duplicate', refusalReason: null };
    case 'suspected': return { outcome: 'waiting', matchKind: 'suspected', refusalReason: null };
    case 'repeat':
    case 'limit': return null;
  }
}

// ── Input validation (everything arrives as untrusted form text) ─────────────────────────────────────────────
type Fail = { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] };
const text = (value: unknown, max: number): string | null | undefined => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v === '' ? null : [...v].length <= max ? v : undefined;
};
const choice = <T extends string>(set: readonly T[], value: unknown): T | null | undefined =>
  value == null || value === '' ? null : typeof value === 'string' && (set as readonly string[]).includes(value) ? (value as T) : undefined;
const ticked = (value: unknown) => value === true || value === 'on' || value === 'true' || value === '1';
const lowerAscii = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAgencyName(value: unknown): { ok: true; value: string } | Fail {
  const name = text(value, AGENCY_NAME_MAX);
  if (name === null) return { ok: false, code: 'missing_fields', fields: ['name'] };
  if (name === undefined) return { ok: false, code: 'invalid_input', fields: ['name'] };
  return { ok: true, value: name };
}
export function validateTagName(value: unknown): { ok: true; value: string } | Fail {
  const name = text(value, AGENCY_TAG_MAX);
  if (name === null) return { ok: false, code: 'missing_fields', fields: ['name'] };
  if (name === undefined) return { ok: false, code: 'invalid_input', fields: ['name'] };
  return { ok: true, value: name };
}

/** A fee rate in percent as people type it: 0–100 with at most two decimals ("12.5" → "12.50"). Never calculated. */
export function feeRate(value: unknown): string | null | undefined {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const v = String(value).replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return undefined;
  const [whole, fraction = ''] = v.split('.');
  const out = `${Number(whole)}.${fraction.padEnd(2, '0')}`;
  return Number(out) <= 100 ? out : undefined;
}

export type ValidContract = {
  name: string; contractType: ContractType; status: ContractStatus; feeRate: string; startsOn: string; endsOn: string;
  hrContactUserId: string; access: ContractAccess; protectionDays: number | null;
};
export function validateContractInput(input: Record<string, unknown>): { ok: true; value: ValidContract } | Fail {
  const name = text(input.name, CONTRACT_NAME_MAX);
  const contractType = choice(CONTRACT_TYPES, input.contractType);
  const status = choice(CONTRACT_STATUSES, input.status) ?? 'enabled';
  const access = choice(CONTRACT_ACCESS, input.access) ?? 'public';
  const rate = feeRate(input.feeRate);
  const startsOn = input.startsOn == null || input.startsOn === '' ? null : isDay(input.startsOn) ? input.startsOn : undefined;
  const endsOn = input.endsOn == null || input.endsOn === '' ? null : isDay(input.endsOn) ? input.endsOn : undefined;
  const contact = input.hrContactUserId == null || input.hrContactUserId === '' ? null : typeof input.hrContactUserId === 'string' && UUID.test(input.hrContactUserId) ? input.hrContactUserId : undefined;
  const protectionText = input.protectionDays == null || input.protectionDays === '' ? null : String(input.protectionDays).trim();
  const protection = protectionText === null ? null : /^\d{1,3}$/.test(protectionText) && Number(protectionText) <= PROTECTION_OVERRIDE_MAX_DAYS ? Number(protectionText) : undefined;
  const missing = [
    ...(name === null ? ['name'] : []), ...(contractType === null ? ['contractType'] : []), ...(rate === null ? ['feeRate'] : []),
    ...(startsOn === null ? ['startsOn'] : []), ...(endsOn === null ? ['endsOn'] : []), ...(contact === null ? ['hrContactUserId'] : []),
  ];
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const invalid = Object.entries({ name, contractType, status, access, feeRate: rate, startsOn, endsOn, hrContactUserId: contact, protectionDays: protection })
    .filter(([, v]) => v === undefined).map(([k]) => k);
  if (!invalid.length && endsOn! < startsOn!) invalid.push('endsOn');
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return {
    ok: true,
    value: {
      name: name!, contractType: contractType!, status: status!, feeRate: rate!, startsOn: startsOn!, endsOn: endsOn!, hrContactUserId: contact!,
      access: access!, protectionDays: protection ?? null,
    },
  };
}

export type ValidConsultant = { name: string; email: string | null; mobile: string | null; status: ConsultantStatus };
export function validateConsultantInput(input: Record<string, unknown>): { ok: true; value: ValidConsultant } | Fail {
  const name = text(input.name, CONSULTANT_NAME_MAX);
  if (name === null) return { ok: false, code: 'missing_fields', fields: ['name'] };
  const emailText = text(input.email, 254);
  const email = emailText ? lowerAscii(emailText) : emailText;
  const mobile = text(input.mobile, 40);
  const status = choice(CONSULTANT_STATUSES, input.status) ?? 'active';
  const invalid = Object.entries({ name, email, mobile, status }).filter(([, v]) => v === undefined).map(([k]) => k);
  if (email && !EMAIL.test(email)) invalid.push('email');
  if (mobile && normMobile(mobile) === null) invalid.push('mobile');
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { name: name!, email: email ?? null, mobile: mobile ?? null, status: status! } };
}

export function validateRequirements(value: unknown): { ok: true; value: string | null } | Fail {
  const v = text(value, REQUIREMENTS_MAX);
  return v === undefined ? { ok: false, code: 'invalid_input', fields: ['requirements'] } : { ok: true, value: v };
}

export type ValidSubmission = {
  fullName: string; email: string | null; mobile: string | null; idType: IdType | null; idNumber: string | null;
  currentSalaryAmount: string | null; currentSalaryCurrency: string | null; expectedSalaryAmount: string | null; expectedSalaryCurrency: string | null;
  comments: string | null; submittedOn: string;
};
/**
 * A submission as HR typed it for the agency: full name (required); e-mail and mobile, at least one; ID number with its type
 * (optional, slice 5 restricted value); current and expected salary with currency (optional, typed, never computed);
 * agency comments (at most 2,000); the submission date (default today; not in the future; not before `contractStartsOn`).
 */
export function validateSubmissionInput(input: Record<string, unknown>, todayKl: string, contractStartsOn: string | null): { ok: true; value: ValidSubmission } | Fail {
  const fullName = text(input.fullName, 200);
  const emailText = text(input.email, 254);
  const mobile = text(input.mobile, 40);
  const missing = [...(!fullName ? ['fullName'] : []), ...(!emailText && !mobile ? ['emailOrMobile'] : [])];
  if (fullName !== undefined && emailText !== undefined && mobile !== undefined && missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const invalid: string[] = [];
  if (fullName === undefined) invalid.push('fullName');
  const email = emailText ? lowerAscii(emailText) : emailText;
  if (email === undefined || (email && !EMAIL.test(email))) invalid.push('email');
  if (mobile === undefined || (mobile && normMobile(mobile) === null)) invalid.push('mobile');
  const idNumber = text(input.idNumber, 40);
  const idType = choice(ID_TYPES, input.idType);
  if (idNumber === undefined) invalid.push('idNumber');
  if (idType === undefined || (idNumber && !idType)) invalid.push('idType');
  const money = (amountKey: string, currencyKey: string) => {
    const amount = moneyAmount(input[amountKey]);
    const currencyText = text(input[currencyKey], 3);
    const currency = currencyText ? currencyText.toUpperCase() : currencyText;
    if (amount === undefined) invalid.push(amountKey);
    if (currency === undefined || (currency && !/^[A-Z]{3}$/.test(currency)) || (amount && !currency)) invalid.push(currencyKey);
    return { amount: amount ?? null, currency: amount ? currency ?? null : null };
  };
  const current = money('currentSalaryAmount', 'currentSalaryCurrency');
  const expected = money('expectedSalaryAmount', 'expectedSalaryCurrency');
  const comments = text(input.comments, COMMENTS_MAX);
  if (comments === undefined) invalid.push('comments');
  const submittedOn = input.submittedOn == null || input.submittedOn === '' ? todayKl : isDay(input.submittedOn) ? input.submittedOn : null;
  if (submittedOn === null || submittedOn > todayKl || (contractStartsOn !== null && submittedOn < contractStartsOn)) invalid.push('submittedOn');
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: [...new Set(invalid)] };
  return {
    ok: true,
    value: {
      fullName: fullName!, email: email ?? null, mobile: mobile ?? null, idType: idNumber ? idType! : null, idNumber: idNumber ?? null,
      currentSalaryAmount: current.amount, currentSalaryCurrency: current.currency, expectedSalaryAmount: expected.amount,
      expectedSalaryCurrency: expected.currency, comments: comments ?? null, submittedOn: submittedOn!,
    },
  };
}

export function validateReviewReason(value: unknown): { ok: true; value: string } | Fail {
  const reason = text(value, REVIEW_REASON_MAX);
  if (reason === null) return { ok: false, code: 'missing_fields', fields: ['reason'] };
  if (reason === undefined) return { ok: false, code: 'invalid_input', fields: ['reason'] };
  return { ok: true, value: reason };
}
export const isTicked = ticked;

/** Contract page "Positions": per job, counts derived live (slice 6 rules: interviewed = a held interview, offered = an
 *  offer created, hired = the application is hired). */
export type ContractPositionCounts = { submitted: number; accepted: number; interviewed: number; offered: number; hired: number };
