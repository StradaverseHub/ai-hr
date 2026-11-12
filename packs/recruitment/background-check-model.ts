/**
 * Recruitment slice 12 rules — background checks (docs/recruitment-reconstruction/specification.md "Slice 12"). Pure,
 * deterministic and client-safe: no database, no clock, no model.
 *
 * packs/recruitment/background-checks.ts runs every write through these functions, and the 5212 guards refuse the same
 * illegal states again (status machine, authorisation first, an outcome to complete, final states, the stage rule). AI HR
 * records checks run OUTSIDE it (D-043): nothing here contacts a provider, scores a result or decides a hire (D-046).
 */

/** Awaiting authorisation → In progress → Completed, or Cancelled from either open state. Completed and Cancelled are final. */
export const CHECK_STATUSES = ['awaiting_authorisation', 'in_progress', 'completed', 'cancelled'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
/** Structured outcome (D-045): what the hiring managers of the job see, besides the type, status and dates. */
export const CHECK_OUTCOMES = ['clear', 'concerns_found', 'could_not_verify'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];
/** How the candidate gave their written authorisation (D-044). */
export const AUTHORISATION_METHODS = ['signed_form', 'email', 'online_form'] as const;
export type AuthorisationMethod = (typeof AUTHORISATION_METHODS)[number];
export const CHECK_FILE_KINDS = ['authorisation', 'report'] as const;
export type CheckFileKind = (typeof CHECK_FILE_KINDS)[number];

/** The transitions the database also enforces (5212 app.recruitment_guard_background_check). */
export const CHECK_TRANSITIONS: Readonly<Record<CheckStatus, readonly CheckStatus[]>> = {
  awaiting_authorisation: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
export const canMoveCheck = (from: CheckStatus, to: CheckStatus): boolean => CHECK_TRANSITIONS[from].includes(to);
export const isFinalCheck = (status: CheckStatus): boolean => CHECK_TRANSITIONS[status].length === 0;

/** The six types offered to a company that has none yet (editable once added; behaviour never keys off a name). */
export const DEFAULT_CHECK_TYPES: readonly { seedKey: string; name: string }[] = [
  { seedKey: 'employment_history', name: 'Employment history' },
  { seedKey: 'education', name: 'Education' },
  { seedKey: 'professional_licence', name: 'Professional licence' },
  { seedKey: 'identity', name: 'Identity' },
  { seedKey: 'criminal_record', name: 'Criminal record' },
  { seedKey: 'credit', name: 'Credit' },
];

export const CHECK_TYPE_NAME_MAX = 80;
export const CHECK_TYPE_DESCRIPTION_MAX = 500;
export const CHECK_PROVIDER_MAX = 120;
export const CHECK_REFERENCE_MAX = 120;
export const CHECK_SUMMARY_MAX = 2000;
export const CHECK_CANCEL_REASON_MAX = 500;
/** At most this many types on one check (the form offers the company's enabled types). */
export const CHECK_TYPES_PER_CHECK_MAX = 20;
/** The recorder's to-do appears once a check has been In progress for MORE than this many Kuala Lumpur days. */
export const CHECK_OVERDUE_DAYS = 14;
/** Authorisation and report files: slice 5's size ceiling; the type is read from the file's own bytes. */
export const CHECK_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** The authorisation file follows slice 5's rules (PDF, Word or image); the report is PDF or Word. */
export const AUTHORISATION_FILE_MIME = [
  'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png',
] as const;
export const REPORT_FILE_MIME = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;
export const AUTHORISATION_FILE_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
export const REPORT_FILE_ACCEPT = '.pdf,.doc,.docx,application/pdf';
export const fileMimeAllowed = (kind: CheckFileKind, mime: string): boolean =>
  ((kind === 'authorisation' ? AUTHORISATION_FILE_MIME : REPORT_FILE_MIME) as readonly string[]).includes(mime);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string => typeof value === 'string' && ISO_DAY.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** A calendar day shifted by whole days (UTC arithmetic on the ISO day: no host timezone involved). */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
/** Whole Kuala Lumpur days from `from` to `to` (both ISO days). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * In progress for more than CHECK_OVERDUE_DAYS Kuala Lumpur days: started on KL day S, overdue from KL day S + 15. The
 * database reads the same rule as `started_at < start of the KL day (today - 14)`.
 */
export const checkOverdue = (startedOnKl: string, todayKl: string): boolean => daysBetween(startedOnKl, todayKl) > CHECK_OVERDUE_DAYS;
/** The first Kuala Lumpur day on which a check started on `startedOnKl` is overdue. */
export const overdueFrom = (startedOnKl: string): string => addDays(startedOnKl, CHECK_OVERDUE_DAYS + 1);

/** The seed key of the company's seeded "Background check" stage (packs/recruitment/model.ts DEFAULT_STAGES). */
export const BACKGROUND_CHECK_STAGE_SEED = 'background_check';
/** Where the application stands, as the stage rule reads it. */
export type CheckStagePosition = {
  /** The current stage's type and seed key (null for a stage a company added). */
  stageType: string; stageSeedKey: string | null;
  /** The current stage's position in the job's process (null when the stage is not in it), and the first Offer-type stage's. */
  stagePosition: number | null; offerPosition: number | null;
};
/**
 * May a check be added at this stage? (The 5212 guard applies the same rule, app.recruitment_background_check_stage_ok.)
 * Yes when the current stage is an Offer-type stage; or the job's process has an Offer-type stage and the current stage's
 * position is at or after the FIRST one (disabled stages keep their positions; Onboarding counts); or it is the company's
 * seeded Background check stage, by its seed key, whatever it has been renamed to. Behaviour never keys off an editable name.
 */
export function checkStageAllowed(p: CheckStagePosition): boolean {
  if (p.stageType === 'offer') return true;
  if (p.stageSeedKey === BACKGROUND_CHECK_STAGE_SEED) return true;
  return p.stagePosition !== null && p.offerPosition !== null && p.stagePosition >= p.offerPosition;
}

/** A card marker for operators and administrators: Concerns found on any completed check wins over In progress. */
export type CheckMarker = 'concerns_found' | 'in_progress';
export function checkMarker(checks: readonly { status: CheckStatus; outcome: CheckOutcome | null }[]): CheckMarker | null {
  if (checks.some((c) => c.status === 'completed' && c.outcome === 'concerns_found')) return 'concerns_found';
  if (checks.some((c) => c.status === 'in_progress')) return 'in_progress';
  return null;
}

type Fail = { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] };
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optional = (value: unknown, max: number, field: string, invalid: string[]): string | null => {
  const v = text(value);
  if (!v) return null;
  if (v.length > max) invalid.push(field);
  return v;
};
const member = <T extends string>(set: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (set as readonly string[]).includes(value) ? (value as T) : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const on = (value: unknown) => value === true || value === 'on' || value === 'true';

export type CheckTypeInput = { name?: unknown; description?: unknown; enabled?: unknown };
export type ValidCheckType = { name: string; description: string | null; enabled: boolean };
export function validateCheckTypeInput(input: CheckTypeInput): { ok: true; value: ValidCheckType } | Fail {
  const name = text(input.name);
  if (!name) return { ok: false, code: 'missing_fields', fields: ['name'] };
  const invalid: string[] = [];
  if (name.length > CHECK_TYPE_NAME_MAX) invalid.push('name');
  const description = optional(input.description, CHECK_TYPE_DESCRIPTION_MAX, 'description', invalid);
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { name, description, enabled: input.enabled === undefined ? true : on(input.enabled) } };
}

export type AddCheckInput = { applicationId?: unknown; typeIds?: unknown; provider?: unknown; providerReference?: unknown };
export type ValidAddCheck = { applicationId: string; typeIds: string[]; provider: string; providerReference: string | null };
export function validateAddCheckInput(input: AddCheckInput): { ok: true; value: ValidAddCheck } | Fail {
  const missing: string[] = [];
  const applicationId = typeof input.applicationId === 'string' && UUID.test(input.applicationId) ? input.applicationId : null;
  if (!applicationId) missing.push('application');
  const ids = [...new Set(list(input.typeIds).filter((v) => v !== ''))];
  if (!ids.length) missing.push('types');
  const provider = text(input.provider);
  if (!provider) missing.push('provider');
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const invalid: string[] = [];
  if (ids.length > CHECK_TYPES_PER_CHECK_MAX || !ids.every((v) => typeof v === 'string' && UUID.test(v))) invalid.push('types');
  if (provider.length > CHECK_PROVIDER_MAX) invalid.push('provider');
  const providerReference = optional(input.providerReference, CHECK_REFERENCE_MAX, 'providerReference', invalid);
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { applicationId: applicationId!, typeIds: ids as string[], provider, providerReference } };
}

export type AuthorisationInput = { authorisedOn?: unknown; method?: unknown; providerReference?: unknown; start?: unknown };
export type ValidAuthorisation = { authorisedOn: string; method: AuthorisationMethod; providerReference: string | null; start: boolean };
/** The candidate's written authorisation: a Kuala Lumpur date not after today, and how it was given. */
export function validateAuthorisationInput(input: AuthorisationInput, todayKl: string): { ok: true; value: ValidAuthorisation } | Fail {
  const missing: string[] = [];
  const day = text(input.authorisedOn);
  if (!day) missing.push('authorisedOn');
  const method = member(AUTHORISATION_METHODS, input.method);
  if (!method) missing.push('method');
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const invalid: string[] = [];
  if (!isDay(day) || day > todayKl) invalid.push('authorisedOn');
  const providerReference = optional(input.providerReference, CHECK_REFERENCE_MAX, 'providerReference', invalid);
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { authorisedOn: day, method: method!, providerReference, start: on(input.start) } };
}

export type CompleteInput = { outcome?: unknown; summary?: unknown; providerReference?: unknown };
export type ValidComplete = { outcome: CheckOutcome; summary: string | null; providerReference: string | null };
export function validateCompleteInput(input: CompleteInput): { ok: true; value: ValidComplete } | Fail {
  const outcome = member(CHECK_OUTCOMES, input.outcome);
  if (!outcome) return { ok: false, code: 'missing_fields', fields: ['outcome'] };
  const invalid: string[] = [];
  const summary = optional(input.summary, CHECK_SUMMARY_MAX, 'summary', invalid);
  const providerReference = optional(input.providerReference, CHECK_REFERENCE_MAX, 'providerReference', invalid);
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { outcome, summary, providerReference } };
}

export function validateCancelInput(input: { reason?: unknown }): { ok: true; value: { reason: string } } | Fail {
  const reason = text(input.reason);
  if (!reason) return { ok: false, code: 'missing_fields', fields: ['reason'] };
  if (reason.length > CHECK_CANCEL_REASON_MAX) return { ok: false, code: 'invalid_input', fields: ['reason'] };
  return { ok: true, value: { reason } };
}

/** Checks by status, for the reports (counts only; never an outcome for a named candidate). */
export function checkStatusCounts(rows: readonly { status: CheckStatus; n: number }[]): Record<CheckStatus, number> {
  const out = Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0])) as Record<CheckStatus, number>;
  for (const r of rows) if (r.status in out) out[r.status] += r.n;
  return out;
}
