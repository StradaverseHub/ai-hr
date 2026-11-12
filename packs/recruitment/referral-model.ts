/**
 * Recruitment slice 7 rules — employee referrals. Pure, deterministic and client-safe: no database, no clock, no model.
 *
 * db/migrations/5207_recruitment_referrals.sql enforces the same limits independently (the reason length, the agreement,
 * e-mail or mobile, the daily limit and the protection period); this file turns form text into a referral and an
 * application's state into the coarse status a referrer may see. Nothing here calculates a reward (D-021).
 */
import { normEmail, normMobile } from './privacy-model';

export const REFERRAL_REASON_MAX = 1000;
/** D-024: at most this many referral ATTEMPTS (accepted or refused) per referrer per Kuala Lumpur date; the database
 *  counts them, so a refusal cannot be used to probe without bound (D-023). */
export const REFERRAL_DAILY_LIMIT = 20;
export const REFERRAL_PROTECTION_DEFAULT_DAYS = 180;
export const REFERRAL_PROTECTION_MAX_DAYS = 730;

/** What a referrer sees about their referral. Never a stage name, a reason, a score or an offer term. */
export const REFERRAL_STATUSES = ['in_review', 'interviewing', 'offer', 'hired', 'not_progressing', 'removed'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** Why the database refused a referral. Recorded in the audit event for HR only; the referrer sees one message (D-023). */
export const REFERRAL_REFUSALS = ['not_eligible', 'job_unavailable', 'daily_limit', 'similar_application', 'already_referred'] as const;
export type ReferralRefusal = (typeof REFERRAL_REFUSALS)[number];

export type ReferralFormInput = { fullName?: unknown; email?: unknown; mobile?: unknown; reason?: unknown; confirmed?: unknown };
export type ValidReferral = { fullName: string; email: string | null; mobile: string | null; reason: string };
type Fail = { ok: false; code: 'missing_fields' | 'invalid_input' | 'confirm_required'; fields: string[] };

const text = (value: unknown): string | null | undefined => {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v === '' ? null : v;
};
const ticked = (value: unknown) => value === true || value === 'on' || value === 'true';

/**
 * A referral as the referrer typed it: the candidate's full name; an e-mail or a mobile (at least one); the reason (at
 * most 1,000 characters); and the referrer's confirmation that the candidate agreed to be referred and contacted by HR.
 */
export function validateReferralInput(input: ReferralFormInput): { ok: true; value: ValidReferral } | Fail {
  const fullName = text(input.fullName);
  const emailText = text(input.email);
  const mobileText = text(input.mobile);
  const reason = text(input.reason);
  const missing = [
    ...(!fullName ? ['fullName'] : []),
    ...(!emailText && !mobileText ? ['emailOrMobile'] : []),
    ...(!reason ? ['reason'] : []),
  ];
  if (fullName === undefined || emailText === undefined || mobileText === undefined || reason === undefined) {
    return { ok: false, code: 'invalid_input', fields: ['form'] };
  }
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const invalid: string[] = [];
  if (fullName!.length > 200) invalid.push('fullName');
  const email = emailText ? emailText.replace(/[A-Z]/g, (c) => c.toLowerCase()) : null;
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))) invalid.push('email');
  if (mobileText && (mobileText.length > 40 || normMobile(mobileText) === null)) invalid.push('mobile');
  if ([...reason!].length > REFERRAL_REASON_MAX) invalid.push('reason');
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  if (!ticked(input.confirmed)) return { ok: false, code: 'confirm_required', fields: ['confirmed'] };
  return { ok: true, value: { fullName: fullName!, email, mobile: mobileText ?? null, reason: reason! } };
}

/** The normalised identities a referral is locked and matched on (slice 5 normalisers). */
export function referralIdentity(v: Pick<ValidReferral, 'email' | 'mobile'>): { email: string | null; mobile: string | null } {
  return { email: normEmail(v.email), mobile: normMobile(v.mobile) };
}

/** The company's referral protection period in days: a whole number from 0 (off) to 730. */
export function validateProtectionDays(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= REFERRAL_PROTECTION_MAX_DAYS ? n : null;
}

export type ReferralProgress = {
  state: 'active' | 'hired' | 'archived';
  removed: boolean;
  /** The current stage's type and its position in the job's process; the first interview and offer positions, if any. */
  stageType: string | null;
  stagePosition: number | null;
  interviewPosition: number | null;
  offerPosition: number | null;
};

/**
 * The coarse status a referrer sees. Removed (the candidate's data was removed) wins; then Hired and Not progressing
 * (archived) from the application's state. An active application is at Offer from the job's first offer stage onwards,
 * Interviewing from its first interview stage onwards, and In review before that (screening and other early stages), so
 * the status only moves forward as the application does. It is computed from types and positions, never stage names.
 */
export function referralStatus(p: ReferralProgress): ReferralStatus {
  if (p.removed) return 'removed';
  if (p.state === 'hired') return 'hired';
  if (p.state === 'archived') return 'not_progressing';
  const reached = (at: number | null) => at !== null && p.stagePosition !== null && p.stagePosition >= at;
  if (p.stageType === 'offer' || reached(p.offerPosition)) return 'offer';
  if (p.stageType === 'interview' || reached(p.interviewPosition)) return 'interviewing';
  return 'in_review';
}
