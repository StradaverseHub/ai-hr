/**
 * 6d091cc0 (r301) — WHERE the consolidated Schedule setup lives, and how its in-page panels are addressed.
 *
 * A PLAIN, NON-'use client', NON-'use server' MODULE ON PURPOSE. Three kinds of file read it: the Schedule
 * pages (Server Components), the rule and device writers ('use server' — a module that may only export async
 * functions, so the constants cannot live there), and the redirect stubs the retired routes became. One
 * spelling of each address, so a writer and the screen it returns to cannot disagree about where the card is.
 *
 * ══ 665de026 (r331) — THE SCHEDULE GROUP IS A PAGE NOW, NOT A PANEL ════════════════════════════════════════
 * The reporter contested r301's shape: Attendance › Schedule carried every Schedule Group's settings at once
 * and Add / Edit opened over the top of them, so one screen held the whole library. It is now list + detail,
 * the shape app/admin/attendance/schedule-assignment reached the same way (r263 panel → contested → r265
 * pages):
 *
 *   /admin/attendance/schedule              the LIST of Schedule Groups (+ the tenant- and company-wide
 *                                           cards that are NOT group-shaped; see the page header)
 *   /admin/attendance/schedule/new          Add Schedule
 *   /admin/attendance/schedule/<id>         View Schedule
 *   /admin/attendance/schedule/<id>/edit    Edit Schedule
 *
 * `editGroup`, `NEW_GROUP`, `groupEditorPath` and `groupEditorHref` are GONE with the panel they addressed.
 * The `group` kind of `SchedulePanel` went with them. What remains below is the COMPANY policy panel, which
 * is not group-shaped and stays on the list page: its record is a company (`attendance_policy`), so it has no
 * per-group page to move to. See docs/audits/665de026-schedule-save-classification.md §3 (a′).
 *
 * ── EVERY PARAMETER IS READ AS A VALUE ─────────────────────────────────────────────────────────────────────
 * Against the companies that exist for this viewer. An unknown id opens nothing rather than an editor for a
 * record the viewer cannot see. The same rule governs `[ruleId]`, which is checked for UUID SHAPE before it
 * reaches a query (an untrusted URL segment against a uuid column: the r263 verifier's 500).
 */

/** The Schedule screen — the LIST of Schedule Groups since 665de026. */
export const SCHEDULE = '/admin/attendance/schedule';

/** Element ids of the cards the retired routes land on. Each is rendered exactly once. */
export const SCHEDULE_GROUPS_ANCHOR = 'schedule-groups';
export const COMPANY_POLICY_ANCHOR = 'company-policy-settings';
export const WORK_SCHEDULE_OVERTIME_ANCHOR = 'work-schedule-overtime';
/** The open COMPANY policy panel (at most one at a time). */
export const SCHEDULE_PANEL_ANCHOR = 'schedule-panel';

/**
 * 665de026 — the three per-Schedule-Group pages.
 *
 * `encodeURIComponent` on a path SEGMENT, not a query value: a rule id is a uuid, so this never changes the
 * string in practice, but a helper that builds a URL out of a database value and does not encode it is the
 * one that breaks the day the value stops being a uuid.
 */
export const scheduleGroupNewPath = () => `${SCHEDULE}/new`;
export const scheduleGroupViewPath = (ruleId: string) => `${SCHEDULE}/${encodeURIComponent(ruleId)}`;
export const scheduleGroupEditPath = (ruleId: string) => `${scheduleGroupViewPath(ruleId)}/edit`;

export const policyEditPath = (companyId: string) => `${SCHEDULE}?policy=${encodeURIComponent(companyId)}`;
export const policyViewPath = (companyId: string) => `${SCHEDULE}?viewPolicy=${encodeURIComponent(companyId)}`;

/** Links (not redirects) carry the panel's fragment, so a click lands on the panel rather than the page top. */
export const policyEditHref = (companyId: string) => `${policyEditPath(companyId)}#${SCHEDULE_PANEL_ANCHOR}`;
export const policyViewHref = (companyId: string) => `${policyViewPath(companyId)}#${SCHEDULE_PANEL_ANCHOR}`;

export type SchedulePanel = { kind: 'policy-edit'; companyId: string } | { kind: 'policy-view'; companyId: string } | null;

/**
 * Which COMPANY policy panel the URL asks for, if any — resolved against what EXISTS for this viewer.
 *
 * One panel at a time, in a fixed precedence (editor, then view), so a hand-edited URL carrying both still
 * renders one coherent screen instead of two editors side by side.
 */
export function resolveSchedulePanel(
  sp: { policy?: string; viewPolicy?: string },
  companyIds: readonly string[],
): SchedulePanel {
  if (sp.policy && companyIds.includes(sp.policy)) return { kind: 'policy-edit', companyId: sp.policy };
  if (sp.viewPolicy && companyIds.includes(sp.viewPolicy)) return { kind: 'policy-view', companyId: sp.viewPolicy };
  return null;
}
