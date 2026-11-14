/**
 * Recruitment slice 8 rules — the public careers page and online applications. Pure, deterministic and client-safe:
 * no database, no clock, no model.
 *
 * db/migrations/5708_recruitment_careers_page.sql enforces the same limits independently (the address format and
 * uniqueness, the field lengths, publishing only with an address, a display name and a notice, the application fields,
 * the per-client and per-company limits). This file turns HR's settings form and a visitor's application form into
 * values, and names what is missing or wrong per field. A field message depends only on what was typed.
 */
import { isCareersAddress } from '../../lib/careers-route';
import { normEmail, normMobile } from './privacy-model';

export const CAREERS_DISPLAY_NAME_MAX = 120;
export const CAREERS_HEADLINE_MAX = 160;
export const CAREERS_INTRODUCTION_MAX = 4000;
export const CAREERS_NOTICE_MAX = 20000;
export const CAREERS_NAME_MAX = 120;
export const CAREERS_MESSAGE_MAX = 1000;
export const CAREERS_EMAIL_MAX = 254;
export const CAREERS_MOBILE_MIN_DIGITS = 7;
export const CAREERS_MOBILE_MAX_DIGITS = 20;
/** D-027: fixed in this slice. */
export const CAREERS_CLIENT_HOURLY_LIMIT = 5;
export const CAREERS_COMPANY_DAILY_LIMIT = 300;
export const CAREERS_PAGE_SIZE = 30;
/** The whole form body is refused above this before it is read (the résumé itself is at most 10 MB). */
export { CAREERS_BODY_MAX_BYTES } from '../../lib/careers-route';
export const CAREERS_QUERY_MAX = 100;

const chars = (value: string) => [...value].length;
const text = (value: unknown): string | null | undefined => {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v === '' ? null : v;
};
/** Multi-line text keeps its line breaks; only the ends are trimmed. Windows line ends become \n. */
const block = (value: unknown): string | null | undefined => {
  const v = text(value);
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : v;
};
const ticked = (value: unknown) => value === true || value === 'on' || value === 'true';
/** Control characters (C0, DEL, C1) — NUL included. A single-line field allows none; multi-line text allows \n and \r. */
const LINE_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const BLOCK_CONTROL = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** Bidirectional overrides and isolates, which can disguise a file name's real extension. */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
export const hasLineControl = (value: string) => LINE_CONTROL.test(value);
export const hasBlockControl = (value: string) => BLOCK_CONTROL.test(value);
/** A file name a person could have typed: no control characters, no bidirectional overrides, no path separators. */
export const careersFileNameOk = (value: string) => value.trim() !== '' && !LINE_CONTROL.test(value) && !BIDI_CONTROL.test(value) && !/[\\/]/.test(value);

// ── HR: the careers page settings ──────────────────────────────────────────────────────────────────────────────

export type CareersSettingsInput = { address?: unknown; displayName?: unknown; headline?: unknown; introduction?: unknown; notice?: unknown };
export type ValidCareersSettings = { address: string | null; displayName: string | null; headline: string | null; introduction: string | null; notice: string | null };
export type CareersSettingsField = keyof ValidCareersSettings;

/**
 * The settings as HR typed them. Every field may be empty while the page is unpublished; the address must have the
 * public format; the notice text, when it differs from the current version, becomes a new version (the service decides).
 */
export function validateCareersSettings(input: CareersSettingsInput): { ok: true; value: ValidCareersSettings } | { ok: false; fields: CareersSettingsField[] } {
  const address = text(input.address);
  const displayName = text(input.displayName);
  const headline = text(input.headline);
  const introduction = block(input.introduction);
  const notice = block(input.notice);
  const invalid: CareersSettingsField[] = [];
  const controlled = (v: string | null | undefined, multiLine: boolean) => typeof v === 'string' && (multiLine ? hasBlockControl(v) : hasLineControl(v));
  if (address === undefined || (address !== null && !isCareersAddress(address))) invalid.push('address');
  if (displayName === undefined || (displayName !== null && chars(displayName) > CAREERS_DISPLAY_NAME_MAX)) invalid.push('displayName');
  if (headline === undefined || (headline !== null && chars(headline) > CAREERS_HEADLINE_MAX)) invalid.push('headline');
  if (introduction === undefined || (introduction !== null && chars(introduction) > CAREERS_INTRODUCTION_MAX)) invalid.push('introduction');
  if (notice === undefined || (notice !== null && chars(notice) > CAREERS_NOTICE_MAX)) invalid.push('notice');
  for (const [field, value, multiLine] of [['displayName', displayName, false], ['headline', headline, false], ['introduction', introduction, true],
    ['notice', notice, true]] as const) if (controlled(value, multiLine) && !invalid.includes(field)) invalid.push(field);
  if (invalid.length) return { ok: false, fields: invalid };
  return { ok: true, value: { address: address ?? null, displayName: displayName ?? null, headline: headline ?? null, introduction: introduction ?? null, notice: notice ?? null } };
}

export const CAREERS_PUBLISH_REQUIREMENTS = ['address', 'displayName', 'notice'] as const;
export type CareersPublishRequirement = (typeof CAREERS_PUBLISH_REQUIREMENTS)[number];
/** What still stops the page from being published (the database refuses the same). */
export function careersPublishMissing(site: { address: string | null; displayName: string | null; noticeVersion: number | null }): CareersPublishRequirement[] {
  return [
    ...(site.address ? [] : ['address' as const]),
    ...(site.displayName ? [] : ['displayName' as const]),
    ...(site.noticeVersion ? [] : ['notice' as const]),
  ];
}

// ── The visitor: the application form ──────────────────────────────────────────────────────────────────────────

export const CAREERS_FORM_FIELDS = ['fullName', 'email', 'mobile', 'message', 'resume', 'consent'] as const;
export type CareersFormField = (typeof CAREERS_FORM_FIELDS)[number];
export const CAREERS_FIELD_ERRORS = ['required', 'invalid', 'too_long', 'file_type', 'file_too_large', 'file_name', 'consent_required', 'notice_changed'] as const;
export type CareersFieldError = (typeof CAREERS_FIELD_ERRORS)[number];

export type CareersApplicationInput = {
  fullName?: unknown; email?: unknown; mobile?: unknown; message?: unknown; consent?: unknown; noticeVersion?: unknown; website?: unknown;
};
export type ValidCareersApplication = {
  fullName: string; email: string; mobile: string | null; message: string | null; noticeVersion: number;
  /** The invisible honeypot field was filled: the submission is answered as received and nothing is stored. */
  honeypot: boolean;
};

/** 7–20 digits after removing spaces, "+", "-" and brackets; anything else is not a mobile number. */
export function normaliseCareersMobile(value: string): string | null {
  if (chars(value) > 40 || !/^[0-9 +()-]+$/.test(value)) return null;
  const digits = normMobile(value);
  return digits && digits.length >= CAREERS_MOBILE_MIN_DIGITS && digits.length <= CAREERS_MOBILE_MAX_DIGITS ? digits : null;
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * A visitor's application as typed: full name (required, ≤120), e-mail (required, valid), mobile (optional), message
 * (optional, ≤1,000) and the consent tick (required). The notice version is the one the page showed. The résumé is
 * checked separately (its type is read from its bytes).
 */
export function validateCareersApplication(input: CareersApplicationInput):
  { ok: true; value: ValidCareersApplication } | { ok: false; fields: Partial<Record<CareersFormField, CareersFieldError>> } {
  const fields: Partial<Record<CareersFormField, CareersFieldError>> = {};
  const fullName = text(input.fullName);
  const email = text(input.email);
  const mobile = text(input.mobile);
  const message = block(input.message);
  if (fullName === undefined || (fullName !== null && hasLineControl(fullName))) fields.fullName = 'invalid';
  else if (fullName === null) fields.fullName = 'required';
  else if (chars(fullName) > CAREERS_NAME_MAX) fields.fullName = 'too_long';
  if (email === undefined) fields.email = 'invalid';
  else if (email === null) fields.email = 'required';
  else if (email.length > CAREERS_EMAIL_MAX || !EMAIL.test(email) || hasLineControl(email)) fields.email = 'invalid';
  if (mobile === undefined || (mobile !== null && normaliseCareersMobile(mobile) === null)) fields.mobile = 'invalid';
  if (message === undefined || (message !== null && hasBlockControl(message))) fields.message = 'invalid';
  else if (message !== null && chars(message) > CAREERS_MESSAGE_MAX) fields.message = 'too_long';
  if (!ticked(input.consent)) fields.consent = 'consent_required';
  const version = typeof input.noticeVersion === 'string' && /^[1-9][0-9]{0,8}$/.test(input.noticeVersion.trim()) ? Number(input.noticeVersion.trim())
    : typeof input.noticeVersion === 'number' && Number.isInteger(input.noticeVersion) && input.noticeVersion >= 1 ? input.noticeVersion : null;
  // A missing or altered notice version is not something the visitor typed: the page is reloaded with the current notice.
  if (version === null) fields.consent = 'consent_required';
  if (Object.keys(fields).length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      fullName: fullName!, email: normEmail(email!)!, mobile: mobile ?? null, message: message ?? null, noticeVersion: version!,
      honeypot: typeof input.website === 'string' && input.website.trim() !== '',
    },
  };
}

/** What the visitor sees after a well-formed submission. Received covers stored, a repeat and the honeypot alike (D-027). */
export const CAREERS_OUTCOMES = ['received', 'not_found', 'rate_limited', 'company_limit', 'notice_changed'] as const;
export type CareersOutcome = (typeof CAREERS_OUTCOMES)[number];

/** The page number from the query string: a whole number from 1; anything else is page 1. */
export function careersPageNumber(value: unknown): number {
  const n = typeof value === 'string' && /^[1-9][0-9]{0,4}$/.test(value) ? Number(value) : 1;
  return Math.min(n, 10000);
}
export const careersPageCount = (total: number) => Math.max(1, Math.ceil(total / CAREERS_PAGE_SIZE));
