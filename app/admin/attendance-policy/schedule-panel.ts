/**
 * 6d091cc0 (r301) — WHERE the consolidated Schedule setup lives, and how its in-page panels are addressed.
 *
 * A PLAIN, NON-'use client', NON-'use server' MODULE ON PURPOSE. Three kinds of file read it: the Schedule
 * page (a Server Component), the rule and device writers ('use server' — a module that may only export async
 * functions, so the constants cannot live there), and the redirect stubs the two retired routes became. One
 * spelling of each address, so a writer and the screen it returns to cannot disagree about where the card is.
 *
 * ── WHY `editGroup`, NOT `group` ───────────────────────────────────────────────────────────────────────────
 * `?group=` is ALREADY TAKEN on this page: the Attendance and Overtime tabs use it to pick which Schedule Group
 * they show (r277), and the tab shell preserves every other parameter when it reflects a tab switch into the
 * URL. The page renders every tab panel at once, so an editor keyed on `?group=` would have opened on the
 * hidden General tab for every Attendance/Overtime deep link. A distinct name keeps the two meanings apart.
 *
 * ── EVERY PARAMETER IS READ AS A VALUE ─────────────────────────────────────────────────────────────────────
 * Against the Schedule Groups and the companies that exist for this viewer, exactly as `?tab=` and `?group=`
 * are. An unknown id opens nothing rather than an editor for a record the viewer cannot see.
 */

/** The Schedule screen. Its General tab is the default tab, so the plain path IS the General tab. */
export const SCHEDULE = '/admin/attendance/schedule';

/** Element ids of the cards the retired routes land on. Each is rendered exactly once. */
export const SCHEDULE_GROUPS_ANCHOR = 'schedule-groups';
export const COMPANY_POLICY_ANCHOR = 'company-policy-settings';
export const WORK_SCHEDULE_OVERTIME_ANCHOR = 'work-schedule-overtime';
/** The open panel (at most one at a time). */
export const SCHEDULE_PANEL_ANCHOR = 'schedule-panel';

/** The value `editGroup` carries for the Add New editor. Not a uuid, so it can never collide with a group. */
export const NEW_GROUP = 'new';

export const groupEditorPath = (ruleId: string) => `${SCHEDULE}?editGroup=${encodeURIComponent(ruleId)}`;
export const policyEditPath = (companyId: string) => `${SCHEDULE}?policy=${encodeURIComponent(companyId)}`;
export const policyViewPath = (companyId: string) => `${SCHEDULE}?viewPolicy=${encodeURIComponent(companyId)}`;

/** Links (not redirects) carry the panel's fragment, so a click lands on the panel rather than the page top. */
export const groupEditorHref = (ruleId: string) => `${groupEditorPath(ruleId)}#${SCHEDULE_PANEL_ANCHOR}`;
export const policyEditHref = (companyId: string) => `${policyEditPath(companyId)}#${SCHEDULE_PANEL_ANCHOR}`;
export const policyViewHref = (companyId: string) => `${policyViewPath(companyId)}#${SCHEDULE_PANEL_ANCHOR}`;

export type SchedulePanel =
  | { kind: 'group'; ruleId: string | null }
  | { kind: 'policy-edit'; companyId: string }
  | { kind: 'policy-view'; companyId: string }
  | null;

/**
 * Which panel the URL asks for, if any — resolved against what EXISTS for this viewer.
 *
 * One panel at a time, in a fixed precedence (group editor, then policy editor, then policy view), so a hand-
 * edited URL carrying two of them still renders one coherent screen instead of two editors side by side.
 */
export function resolveSchedulePanel(
  sp: { editGroup?: string; policy?: string; viewPolicy?: string },
  ruleIds: readonly string[],
  companyIds: readonly string[],
): SchedulePanel {
  if (sp.editGroup === NEW_GROUP) return { kind: 'group', ruleId: null };
  if (sp.editGroup && ruleIds.includes(sp.editGroup)) return { kind: 'group', ruleId: sp.editGroup };
  if (sp.policy && companyIds.includes(sp.policy)) return { kind: 'policy-edit', companyId: sp.policy };
  if (sp.viewPolicy && companyIds.includes(sp.viewPolicy)) return { kind: 'policy-view', companyId: sp.viewPolicy };
  return null;
}

/** A stable string per panel — the tab shell's React key, so opening a panel re-mounts it on General. */
export function schedulePanelKey(panel: SchedulePanel): string {
  if (!panel) return 'none';
  if (panel.kind === 'group') return `group:${panel.ruleId ?? NEW_GROUP}`;
  return `${panel.kind}:${panel.companyId}`;
}
