/**
 * Recruitment slice 5 rules — candidate records and privacy. Pure, deterministic and client-safe: no database, no
 * clock (every "today" is passed in, from lib/hr-date's Kuala Lumpur calendar), no model.
 *
 * The SQL in db/migrations/5205_recruitment_candidate_privacy.sql enforces the same rules independently: the
 * normalisers and the duplicate match mirror app.recruitment_norm_* and app.recruitment_candidate_duplicate_count; the
 * repeated-application window mirrors app.recruitment_guard_repeat_application. Nothing here infers anything about a
 * candidate: no smart tags, no resume parsing, no scoring.
 */
import { addCalendarMonths } from '../../lib/hr-date';
import { isUuid } from './model';

export const EDUCATION_LEVELS = ['secondary', 'certificate', 'diploma', 'bachelor', 'master', 'doctorate', 'professional', 'other'] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];
export const CANDIDATE_SOURCES = ['referral', 'job_board', 'career_page', 'agency', 'walk_in', 'other'] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];
export const ID_TYPES = ['nric', 'passport'] as const;
export type IdType = (typeof ID_TYPES)[number];
export const FILE_KINDS = ['resume', 'attachment'] as const;
export type CandidateFileKind = (typeof FILE_KINDS)[number];
export const ENTRY_KINDS = ['work', 'education'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const CONSENT_STATUSES = ['consented', 'withdrawn'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export const CONSENT_METHODS = ['written_form', 'email', 'online_form', 'verbal'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];
/** Repeated-application window choices in months; 0 switches the closed-application rule off. */
export const REPEAT_WINDOW_CHOICES = [0, 1, 3, 6, 12] as const;
export const DEFAULT_REPEAT_WINDOW_MONTHS = 3;
export const DEFAULT_RETENTION_MONTHS_WITHOUT_CONSENT = 6;
export const DEFAULT_RETENTION_MONTHS_WITH_CONSENT = 24;

/** Files: PDF, Word or image, at most 10 MB (the employee_document ceiling). */
export const CANDIDATE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CANDIDATE_FILE_MIME = [
  'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png',
] as const;
export const CANDIDATE_FILE_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

// ── Normalisers (ASCII case folding: the answer never depends on a database locale) ─────────────────────────
const lowerAscii = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const upperAscii = (value: string) => value.replace(/[a-z]/g, (c) => c.toUpperCase());
const orNull = (value: string) => (value === '' ? null : value);
export const normName = (value: string | null | undefined): string | null => orNull(lowerAscii((value ?? '').trim().replace(/\s+/g, ' ')));
export const normEmail = (value: string | null | undefined): string | null => orNull(lowerAscii((value ?? '').trim()));
export const normMobile = (value: string | null | undefined): string | null => orNull((value ?? '').replace(/[^0-9]/g, ''));
export const normIdNumber = (value: string | null | undefined): string | null => orNull(upperAscii((value ?? '').replace(/[^0-9A-Za-z]/g, '')));

export type DuplicateProbe = { fullName?: string | null; email?: string | null; mobile?: string | null; idNumber?: string | null };
/**
 * Is `existing` a possible duplicate of `incoming`? The same ID number, or any two of email (case-insensitive), name
 * (spacing and case normalised) and mobile (digits only). One matching item alone is not a duplicate.
 */
export function duplicateMatch(incoming: DuplicateProbe, existing: DuplicateProbe): boolean {
  const id = normIdNumber(incoming.idNumber);
  if (id !== null && id === normIdNumber(existing.idNumber)) return true;
  const same = (a: string | null, b: string | null) => a !== null && a === b;
  const hits = Number(same(normEmail(incoming.email), normEmail(existing.email)))
    + Number(same(normName(incoming.fullName), normName(existing.fullName)))
    + Number(same(normMobile(incoming.mobile), normMobile(existing.mobile)));
  return hits >= 2;
}

// ── Repeated applications ────────────────────────────────────────────────────────────────────────────────────
export type EarlierApplication = { jobId: string; state: 'active' | 'hired' | 'archived'; closedOn: string | null };
/**
 * A new application to `jobId` is refused while an earlier application to the same job is active, or was closed
 * (archived or hired) within `windowMonths` of `todayKl` (Kuala Lumpur calendar, month-end clamped). A window of 0
 * switches the closed rule off. Another job is always allowed. A HIRED application counts as closed on purpose: someone
 * hired for the job should not re-apply to that same job within the window.
 */
export function repeatApplicationBlocked(earlier: readonly EarlierApplication[], jobId: string, windowMonths: number, todayKl: string): boolean {
  return earlier.some((a) => a.jobId === jobId && (a.state === 'active'
    || (windowMonths > 0 && a.closedOn !== null && addCalendarMonths(a.closedOn, windowMonths) > todayKl)));
}

// ── Retention ────────────────────────────────────────────────────────────────────────────────────────────────
export type ConsentState = { status: ConsentStatus; on: string } | null;
export type RetentionInput = {
  hasActive: boolean; hasHired: boolean;
  /** The candidate's latest archival date (Kuala Lumpur calendar day), or null without a closed application. */
  latestArchivedOn: string | null;
  consent: ConsentState;
  monthsWithoutConsent: number; monthsWithConsent: number;
};
/**
 * The day a candidate's retention period ends, or null when it never does (an active application; a hired one — the
 * employee record takes over; nothing archived). The clock starts at the latest archival date, or at the consent date
 * when later; a withdrawal restarts it "without consent" from the withdrawal date (when later than the archival).
 */
export function retentionDueOn(input: RetentionInput): string | null {
  if (input.hasActive || input.hasHired || !input.latestArchivedOn) return null;
  const start = input.consent && input.consent.on > input.latestArchivedOn ? input.consent.on : input.latestArchivedOn;
  const months = input.consent?.status === 'consented' ? input.monthsWithConsent : input.monthsWithoutConsent;
  return addCalendarMonths(start, months);
}
export const retentionEnded = (dueOn: string | null, todayKl: string): boolean => dueOn !== null && dueOn <= todayKl;

/** The current consent: the latest entry by its date, then by when it was recorded. */
export function currentConsent(history: readonly { status: ConsentStatus; effectiveOn: string; recordedAt: string }[]): ConsentState {
  const latest = [...history].sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.recordedAt.localeCompare(a.recordedAt))[0];
  return latest ? { status: latest.status, on: latest.effectiveOn } : null;
}

// ── Input validation (everything arrives as untrusted form text) ────────────────────────────────────────────
type Fail = { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] };
const text = (value: unknown, max: number): string | null | undefined => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v === '' ? null : v.length <= max ? v : undefined;
};
const choice = <T extends string>(set: readonly T[], value: unknown): T | null | undefined =>
  value == null || value === '' ? null : typeof value === 'string' && (set as readonly string[]).includes(value) ? (value as T) : undefined;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type ProfileInput = Record<string, unknown>;
export type ValidProfile = {
  fullName: string; email: string | null; phone: string | null; location: string | null; currentCompany: string | null;
  currentTitle: string | null; highestEducation: EducationLevel | null; noticePeriod: string | null; source: CandidateSource | null;
};
export function validateProfileInput(input: ProfileInput): { ok: true; value: ValidProfile } | Fail {
  const fullName = text(input.fullName, 200);
  if (!fullName) return { ok: false, code: 'missing_fields', fields: ['fullName'] };
  const email = text(input.email, 254);
  const value = {
    fullName, email: email ? lowerAscii(email) : email, phone: text(input.phone, 40), location: text(input.location, 200),
    currentCompany: text(input.currentCompany, 200), currentTitle: text(input.currentTitle, 200),
    highestEducation: choice(EDUCATION_LEVELS, input.highestEducation), noticePeriod: text(input.noticePeriod, 60), source: choice(CANDIDATE_SOURCES, input.source),
  };
  const fields = Object.entries(value).filter(([, v]) => v === undefined).map(([k]) => k);
  if (value.email && !/^[^\s@]+@[^\s@]+$/.test(value.email)) fields.push('email');
  return fields.length ? { ok: false, code: 'invalid_input', fields } : { ok: true, value: value as ValidProfile };
}

/** A decimal amount of money, as people type it: digits with at most two decimals. Never computed. */
export function moneyAmount(value: unknown): string | null | undefined {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const v = value.replace(/,/g, '').trim();
  if (v === '') return null;
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(v)) return undefined;
  const [whole, fraction = ''] = v.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}
export type ValidRestricted = {
  currentSalaryAmount: string | null; currentSalaryCurrency: string | null; expectedSalaryAmount: string | null; expectedSalaryCurrency: string | null;
  idType: IdType | null; idNumber: string | null;
};
export function validateRestrictedInput(input: Record<string, unknown>): { ok: true; value: ValidRestricted } | Fail {
  const fields: string[] = [];
  const money = (amountKey: string, currencyKey: string) => {
    const amount = moneyAmount(input[amountKey]);
    const currencyText = text(input[currencyKey], 3);
    const currency = currencyText ? currencyText.toUpperCase() : currencyText;
    if (amount === undefined) fields.push(amountKey);
    if (currency === undefined || (currency && !/^[A-Z]{3}$/.test(currency))) fields.push(currencyKey);
    if (amount && !currency) fields.push(currencyKey);
    return { amount: amount ?? null, currency: amount ? currency ?? null : null };
  };
  const current = money('currentSalaryAmount', 'currentSalaryCurrency');
  const expected = money('expectedSalaryAmount', 'expectedSalaryCurrency');
  const idNumber = text(input.idNumber, 40);
  const idType = choice(ID_TYPES, input.idType);
  if (idNumber === undefined) fields.push('idNumber');
  if (idType === undefined || (idNumber && !idType)) fields.push('idType');
  if (fields.length) return { ok: false, code: 'invalid_input', fields: [...new Set(fields)] };
  return {
    ok: true,
    value: {
      currentSalaryAmount: current.amount, currentSalaryCurrency: current.currency, expectedSalaryAmount: expected.amount,
      expectedSalaryCurrency: expected.currency, idType: idNumber ? idType! : null, idNumber: idNumber ?? null,
    },
  };
}

export type ValidEntry = { kind: EntryKind; organisation: string; title: string | null; fromMonth: string | null; toMonth: string | null; isCurrent: boolean };
/** A work experience or education entry. Months arrive as YYYY-MM and are stored as the first day of the month. */
export function validateEntryInput(input: Record<string, unknown>): { ok: true; value: ValidEntry } | Fail {
  const kind = choice(ENTRY_KINDS, input.kind);
  const organisation = text(input.organisation, 200);
  if (!kind || !organisation) return { ok: false, code: 'missing_fields', fields: [...(!kind ? ['kind'] : []), ...(!organisation ? ['organisation'] : [])] };
  const month = (value: unknown) => (value == null || value === '' ? null : typeof value === 'string' && MONTH.test(value) ? `${value}-01` : undefined);
  const title = text(input.title, 200);
  const fromMonth = month(input.fromMonth);
  const isCurrent = kind === 'work' && (input.isCurrent === true || input.isCurrent === 'on' || input.isCurrent === 'true');
  const toMonth = isCurrent ? null : month(input.toMonth);
  const fields = [...(title === undefined ? ['title'] : []), ...(fromMonth === undefined ? ['fromMonth'] : []), ...(toMonth === undefined ? ['toMonth'] : [])];
  if (!fields.length && fromMonth && toMonth && fromMonth > toMonth) fields.push('toMonth');
  return fields.length ? { ok: false, code: 'invalid_input', fields } : { ok: true, value: { kind, organisation, title: title ?? null, fromMonth: fromMonth ?? null, toMonth: toMonth ?? null, isCurrent } };
}

export type ValidConsent = { status: ConsentStatus; effectiveOn: string; method: ConsentMethod; noticeReference: string | null };
/** A consent entry, recorded by a person. The date may not be after today (Kuala Lumpur). */
export function validateConsentInput(input: Record<string, unknown>, todayKl: string): { ok: true; value: ValidConsent } | Fail {
  const status = choice(CONSENT_STATUSES, input.status);
  const method = choice(CONSENT_METHODS, input.method);
  const effectiveOn = typeof input.effectiveOn === 'string' && DATE.test(input.effectiveOn) ? input.effectiveOn : null;
  const missing = [...(!status ? ['status'] : []), ...(!method ? ['method'] : []), ...(!effectiveOn ? ['effectiveOn'] : [])];
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const noticeReference = text(input.noticeReference, 200);
  const fields = [...(effectiveOn! > todayKl ? ['effectiveOn'] : []), ...(noticeReference === undefined ? ['noticeReference'] : [])];
  return fields.length ? { ok: false, code: 'invalid_input', fields } : { ok: true, value: { status: status!, effectiveOn: effectiveOn!, method: method!, noticeReference: noticeReference ?? null } };
}

export type ValidPrivacySettings = { monthsWithoutConsent: number; monthsWithConsent: number; repeatWindowMonths: number };
export function validatePrivacySettings(input: Record<string, unknown>): { ok: true; value: ValidPrivacySettings } | Fail {
  const months = (value: unknown) => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 120 ? n : null;
  };
  const monthsWithoutConsent = months(input.monthsWithoutConsent);
  const monthsWithConsent = months(input.monthsWithConsent);
  const repeat = Number(input.repeatWindowMonths);
  const repeatWindowMonths = (REPEAT_WINDOW_CHOICES as readonly number[]).includes(repeat) ? repeat : null;
  const fields = [...(monthsWithoutConsent === null ? ['monthsWithoutConsent'] : []), ...(monthsWithConsent === null ? ['monthsWithConsent'] : []),
    ...(repeatWindowMonths === null ? ['repeatWindowMonths'] : [])];
  return fields.length ? { ok: false, code: 'invalid_input', fields } : { ok: true, value: { monthsWithoutConsent: monthsWithoutConsent!, monthsWithConsent: monthsWithConsent!, repeatWindowMonths: repeatWindowMonths! } };
}

/** The selection of a destruction: distinct candidate ids, an explicit confirmation, at most 100 at a time. */
export function validateDestruction(ids: unknown, confirmed: unknown): { ok: true; ids: string[] } | { ok: false; code: 'confirm_required' | 'invalid_input' } {
  if (!(confirmed === true || confirmed === 'on' || confirmed === 'true')) return { ok: false, code: 'confirm_required' };
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter((x) => x != null && x !== ''))];
  if (!list.length || list.length > 100 || !list.every(isUuid)) return { ok: false, code: 'invalid_input' };
  return { ok: true, ids: list as string[] };
}
