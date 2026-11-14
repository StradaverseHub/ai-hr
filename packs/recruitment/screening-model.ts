/**
 * Recruitment slice 11 rules — resume screening by hiring managers. Pure, deterministic and client-safe: no database, no
 * clock, no model.
 *
 * packs/recruitment/screening.ts reads requests and answers under the viewer's own row security and hands them to these
 * helpers; nothing here decides who may see or do what (the database does, 5711). One fixed company form (D-040): the
 * result Advance, Reject or Pending, and an optional comment. Reviewers are the job's hiring managers (D-041).
 */
import { RecruitmentError } from './model';

/** The screening form's one required question (EV-054): Advance, Reject, or Pending ("need more information"). */
export const SCREENING_RESULTS = ['advance', 'reject', 'pending'] as const;
export type ScreeningResult = (typeof SCREENING_RESULTS)[number];
/** The derived assignment status of an application (EV-052), in the board filter's order. */
export const ASSIGNMENT_STATUSES = ['not_assigned', 'awaiting', 'positive', 'negative'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
/** How a request closed: its reviewer's Advance or Reject; withdrawn by an operator; or by itself, because the application was
 *  archived or hired, or the reviewer stopped being a hiring manager of the job (5711, D-042). */
export const SCREENING_CLOSE_REASONS = ['answered', 'withdrawn', 'application_closed', 'reviewer_removed'] as const;
export type ScreeningCloseReason = (typeof SCREENING_CLOSE_REASONS)[number];

export const SCREENING_NOTE_MAX = 1000;
export const SCREENING_COMMENT_MAX = 2000;
/** At most this many applications are sent in one go (one board selection). */
export const SCREENING_SEND_MAX = 100;
/** The To screen list shows at most this many open requests; its tab count stops at one more ("200+"). */
export const SCREENING_LIST_LIMIT = 200;
/** The board's screening counts and status filter read at most this many of a stage's most recent applications. */
export const SCREENING_STATUS_WINDOW = 500;

export function isScreeningResult(value: unknown): value is ScreeningResult {
  return typeof value === 'string' && (SCREENING_RESULTS as readonly string[]).includes(value);
}
/** The board's ?screening= filter; anything else is no filter. */
export function parseAssignmentFilter(value: unknown): AssignmentStatus | null {
  return typeof value === 'string' && (ASSIGNMENT_STATUSES as readonly string[]).includes(value) ? (value as AssignmentStatus) : null;
}
/** Advance and Reject close the request; Pending keeps it open for another answer. */
export function closesRequest(result: ScreeningResult): boolean {
  return result !== 'pending';
}

/** Optional free text: trimmed; empty is none; longer than `max` characters is refused. */
function optionalText(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new RecruitmentError('invalid_input');
  const text = value.trim();
  if (!text) return null;
  if ([...text].length > max) throw new RecruitmentError('invalid_input');
  return text;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidList(value: unknown, max: number): string[] {
  const list = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  if (!list.every((v): v is string => typeof v === 'string' && UUID.test(v))) throw new RecruitmentError('invalid_input');
  const unique = [...new Set(list.map((v) => v.toLowerCase()))];
  if (unique.length > max) throw new RecruitmentError('invalid_input');
  return unique;
}

export type SendInput = { applicationIds?: unknown; reviewerUserIds?: unknown; note?: unknown; move?: unknown };
export type ValidSend = { applicationIds: string[]; reviewerUserIds: string[] | null; note: string | null; move: boolean };
/**
 * "Send to hiring manager": one or more applications (at most SCREENING_SEND_MAX), the chosen reviewers (none chosen = every
 * hiring manager of the job, the reference's default), an optional note (≤ 1,000 characters) and whether to move each
 * application to its next enabled stage at the same time.
 */
export function validateSendInput(input: SendInput): ValidSend {
  const applicationIds = uuidList(input.applicationIds, SCREENING_SEND_MAX);
  if (!applicationIds.length) throw new RecruitmentError('missing_fields', ['applicationIds']);
  const reviewers = uuidList(input.reviewerUserIds, 50);
  return { applicationIds, reviewerUserIds: reviewers.length ? reviewers : null, note: optionalText(input.note, SCREENING_NOTE_MAX), move: input.move === true };
}

export type AnswerInput = { result?: unknown; comment?: unknown };
/** The screening form: the result is required; the comment is optional (≤ 2,000 characters). */
export function validateAnswerInput(input: AnswerInput): { result: ScreeningResult; comment: string | null } {
  if (input.result == null || input.result === '') throw new RecruitmentError('missing_fields', ['result']);
  if (!isScreeningResult(input.result)) throw new RecruitmentError('invalid_input');
  return { result: input.result, comment: optionalText(input.comment, SCREENING_COMMENT_MAX) };
}

/** One request and one answer as the status rule reads them (ISO instants compare as text). */
export type StatusRequest = { closedAt: string | null };
export type StatusAnswer = { id: string; result: ScreeningResult; answeredAt: string };

/**
 * The assignment status of an application (EV-052), in the order of precedence of D-042:
 *   Awaiting feedback  at least one request is open (no answer yet, or its latest answer is Pending);
 *   Positive/Negative  otherwise, the most recent FINAL answer (Advance or Reject) from any reviewer;
 *   Not assigned       otherwise: never sent, or every request was withdrawn or closed without a final answer.
 * "Most recent" is the latest answered time, then the larger id, so equal times keep one order. Pending answers never decide
 * a closed application's status. The database computes the same rule for the board (packs/recruitment/data.ts
 * screeningStatusSql); tests compare the two.
 */
export function assignmentStatus(requests: readonly StatusRequest[], answers: readonly StatusAnswer[]): AssignmentStatus {
  if (requests.some((r) => r.closedAt == null)) return 'awaiting';
  const latest = answers.filter((a) => a.result !== 'pending')
    .sort((a, b) => (a.answeredAt < b.answeredAt ? 1 : a.answeredAt > b.answeredAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
  return latest ? (latest.result === 'advance' ? 'positive' : 'negative') : 'not_assigned';
}

/** The per-status counts of a stage, every status present (zero when none). */
export function statusCounts(statuses: readonly AssignmentStatus[]): Record<AssignmentStatus, number> {
  const out = Object.fromEntries(ASSIGNMENT_STATUSES.map((k) => [k, 0])) as Record<AssignmentStatus, number>;
  for (const s of statuses) out[s] += 1;
  return out;
}

/** The state of one request as the pages show it. */
export type RequestState = 'open' | ScreeningCloseReason;
export function requestState(closedReason: ScreeningCloseReason | null): RequestState {
  return closedReason ?? 'open';
}
