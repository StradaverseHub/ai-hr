/** Fixed legacy Schedule destinations. Feedback is text, never a navigation authority. */
import {
  SCHEDULE, COMPANY_POLICY, WORK_SCHEDULE_OVERTIME, REGISTERED_DEVICES,
  COMPANY_POLICY_ANCHOR, WORK_SCHEDULE_OVERTIME_ANCHOR,
} from '../app/(app)/admin/attendance-policy/schedule-panel';

export type LegacyScheduleFeedback = Readonly<Record<string, string | readonly string[] | undefined>>;
const targets = new Map([
  ['#' + COMPANY_POLICY_ANCHOR, COMPANY_POLICY],
  ['#' + WORK_SCHEDULE_OVERTIME_ANCHOR, WORK_SCHEDULE_OVERTIME],
  ['#overtime-rates', WORK_SCHEDULE_OVERTIME],
  ['#backup-shift-coverage', WORK_SCHEDULE_OVERTIME],
  ['#registered-devices', REGISTERED_DEVICES],
]);
const MAX_FEEDBACK_LENGTH = 1024;

/** First duplicate wins, matching URLSearchParams.get and the app's feedback consumer.
 * Empty, oversized or control-character values are omitted, rather than truncated into another message.
 * Unknown parameters, including returnTo/target/auth values, never cross the redirect.
 */
function feedbackQuery(input: URLSearchParams | LegacyScheduleFeedback): string {
  const result = new URLSearchParams();
  for (const key of ['error', 'toast'] as const) {
    const raw = input instanceof URLSearchParams
      ? input.get(key)
      : Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim() && value.length <= MAX_FEEDBACK_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)) result.set(key, value);
  }
  return result.toString();
}

export function legacyScheduleAnchorRedirect(anchor: string, input: URLSearchParams | LegacyScheduleFeedback = {}): string | null {
  const target = targets.get(anchor);
  if (!target) return null;
  const query = feedbackQuery(input);
  return target + (query ? '?' + query : '') + anchor;
}

/** Old server address has no request fragment; retain its existing canonical default anchor. */
export function legacyWorkScheduleRedirect(input: LegacyScheduleFeedback = {}): string {
  return legacyScheduleAnchorRedirect('#' + WORK_SCHEDULE_OVERTIME_ANCHOR, input)!;
}

/** Root feedback waits for this exact alias to forward, so navigation does not compete or toast twice. */
export function hasPendingLegacyScheduleRedirect(pathname: string, anchor: string): boolean {
  return pathname === SCHEDULE && targets.has(anchor);
}

/** Preserve only a known card fragment at its fixed destination during feedback cleanup. */
export function legacyScheduleDestinationHash(pathname: string, anchor: string): string {
  return targets.get(anchor) === pathname ? anchor : '';
}
