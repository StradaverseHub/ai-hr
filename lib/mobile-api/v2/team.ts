/**
 * M13 (D14) — team availability over a caller-chosen window: date/week navigation over the SAME My Team projection
 * the v1 team card reads (resolveMyTeamScope + myTeamLeaveProjection). v2 only; v1 `team` stays unchanged for
 * installed clients. Imported by route handlers AND by the Expo app, so this file stays dependency-free.
 *
 *   GET /api/mobile/v2/team/availability?from=YYYY-MM-DD&to=YYYY-MM-DD   → TeamAvailabilityV2
 *
 * The window is the caller's (default: today and the next six days), at most TEAM_WINDOW_MAX_DAYS days inclusive; a
 * wider, inverted, malformed or `to`-without-`from` window is a 400. MEMBERSHIP IS NEVER THE CALLER'S: no employee,
 * company, department or scope parameter is read; My Team's own scope (`all`) decides who is listed.
 *
 * WHAT IS DISCLOSED: a name, the dates, the session (full day / morning / afternoon / hourly) and approved vs
 * pending. Never the leave type, the reason, a balance or a document. `memberCount` is the whole authorized team,
 * `truncated` says the list stops at TEAM_MEMBERS_MAX people, and `companies` is how many companies the scope covers.
 * `enabled:false` when the caller has no team access (or Leave is off): an empty team is `enabled:true, items:[]`.
 */
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const TEAM_WINDOW_MAX_DAYS = 31;
export const TEAM_WINDOW_DEFAULT_DAYS = 7;
export const TEAM_MEMBERS_MAX = 200;
/** Two half days per date fit; more is a data fault and is cut, never an error. */
export const TEAM_DATES_PER_MEMBER_MAX = TEAM_WINDOW_MAX_DAYS * 4;
export const TeamSession = z.enum(['full_day', 'AM', 'PM', 'hourly']);
export type TeamSession = z.infer<typeof TeamSession>;
export const TeamMemberV2 = z.object({
  employmentId: z.string().uuid(),
  name: z.string().max(300),
  dates: z.array(z.object({ date: isoDate, status: z.enum(['approved', 'pending']), session: TeamSession }).strict()).max(TEAM_DATES_PER_MEMBER_MAX),
}).strict();
export type TeamMemberV2 = z.infer<typeof TeamMemberV2>;
export const TeamAvailabilityV2 = z.object({
  enabled: z.boolean(),
  today: isoDate,
  from: isoDate,
  to: isoDate,
  scope: z.literal('my_team'),
  companies: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  items: z.array(TeamMemberV2).max(TEAM_MEMBERS_MAX),
}).strict();
export type TeamAvailabilityV2 = z.infer<typeof TeamAvailabilityV2>;

const DAY = 86_400_000;
export function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
/** Calendar arithmetic on a date-only value (no clock, no zone). */
export function addCalendarDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
/** Inclusive length of a window in days. */
export const windowDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
