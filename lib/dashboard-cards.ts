/**
 * Role-based dashboard summary cards (R17 e6f0384c).
 *
 * The dashboard's top card row is role-aware: an employee sees self-service cards, a direct manager
 * sees team cards, and an HR admin keeps the high-level company overview. This module holds ONLY the
 * pure, testable pieces — the role resolver, the declarative per-role card config, the card metadata
 * (label key + href), and the `teamAwayToday` counter. Rendering stays in `app/page.tsx`; the data
 * reads it selects are all existing, scope-fenced reads — this config never widens access, it only
 * chooses WHICH already-permission-fenced numbers to show.
 */

export type DashboardRole = 'hr_admin' | 'manager' | 'employee';

export type DashboardCardId =
  // employee
  | 'leaveBalance'
  | 'nextHoliday'
  | 'pendingTasks'
  // manager
  | 'teamAwayToday'
  | 'onboardingWeek'
  | 'approvalRequests'
  | 'upcomingReminders'
  // hr_admin
  | 'headcount'
  | 'pendingLeave'
  | 'companies'
  | 'latestPayroll';

/**
 * Ordered card set per resolved role — matches the reporter's three sets exactly.
 * - Employee: Leave Balance · Upcoming Holidays · Pending Tasks (self-service action items).
 * - Manager: Team Away Today · Onboarding This Week · Approval Requests · Upcoming Reminders.
 * - HR admin: the unchanged high-level company overview.
 * `nextHoliday` is the employee's "Upcoming Holidays" card; the manager surfaces holidays inside
 * `upcomingReminders` instead (the reporter's 4th manager card = reminders, not a bare next-holiday).
 */
export const ROLE_CARDS: Record<DashboardRole, DashboardCardId[]> = {
  employee: ['leaveBalance', 'nextHoliday', 'pendingTasks'],
  manager: ['teamAwayToday', 'onboardingWeek', 'approvalRequests', 'upcomingReminders'],
  hr_admin: ['headcount', 'pendingLeave', 'companies', 'latestPayroll'],
};

/**
 * Static metadata for every card: the `dashboard` i18n label key and the click-through href. Kept
 * beside `ROLE_CARDS` so a test can assert every id in every role's set resolves here (guards a card
 * added to one map but not the other / not the renderer). `#`-prefixed hrefs scroll to an in-page
 * anchor on the same dashboard (planned-absences strip / upcoming-events card).
 */
export const CARD_META: Record<DashboardCardId, { labelKey: string; href: string }> = {
  leaveBalance: { labelKey: 'leaveBalance', href: '/leave' },
  nextHoliday: { labelKey: 'nextHoliday', href: '#upcoming-events' },
  // Pending Tasks → /me, where the employee actions its tasks (e.g. give 360 feedback; upload/complete
  // items land here as those task types ship). NOT the inverse "requests awaiting a decision" surface.
  pendingTasks: { labelKey: 'pendingTasks', href: '/me' },
  teamAwayToday: { labelKey: 'teamAwayToday', href: '#planned-absences' },
  onboardingWeek: { labelKey: 'onboardingThisWeek', href: '/personnel' },
  approvalRequests: { labelKey: 'approvalRequests', href: '/approvals' },
  // Upcoming Reminders scrolls to the on-page holidays digest; review deadlines it also counts are
  // actioned from the Approval Requests card (same /approvals inbox).
  upcomingReminders: { labelKey: 'upcomingReminders', href: '#upcoming-events' },
  headcount: { labelKey: 'headcount', href: '/personnel' },
  pendingLeave: { labelKey: 'pendingLeave', href: '/leave' },
  companies: { labelKey: 'companies', href: '/admin/organization' },
  latestPayroll: { labelKey: 'latestPayroll', href: '/payroll' },
};

/**
 * Resolve the viewer's dashboard role.
 * - `admin` (real hr_admin / super_admin, via `isAdmin`) → `hr_admin`, winning over everything.
 * - `managerRole` = the `manager` platform role (same rule the topbar bell / nav use).
 * - `hasDirectReports` MUST be ORed in: a Direct Manager via a `reporting_line` edge may NOT hold the
 *   `manager` platform role (mirrors the 0110 fix in core/approvals-inbox.ts) — either signal → `manager`.
 *
 * NOTE on partners: a payroll / perf-comp partner gets the admin *nav*, but aggregate payroll on
 * `dashboardStats` is gated on real admin roles INSIDE the read. A partner who is neither admin nor
 * manager here resolves to `employee` (their partner pages are one nav click away) — correct, because
 * the admin card set would show them `—` for payroll they can't aggregate.
 */
export function resolveDashboardRole(input: {
  admin: boolean;
  managerRole: boolean;
  hasDirectReports: boolean;
}): DashboardRole {
  if (input.admin) return 'hr_admin';
  if (input.managerRole || input.hasDirectReports) return 'manager';
  return 'employee';
}

export type TeamAwayLeave = { status: string; startDate: string; endDate: string };
export type TeamAwayRow = { id: string; leaves: TeamAwayLeave[] };

/**
 * Count of DISTINCT direct reports (≠ the viewer) who have an APPROVED leave covering `todayIso`.
 * Operates over the rows already fetched for the PlannedAbsences strip (`id` is the personId, one
 * row per person with their leave segments). ISO `YYYY-MM-DD` strings compare lexically, so a plain
 * string range check is a correct date-cover test. Pending leave is excluded (not yet an absence);
 * the viewer's own row is excluded ("team away", not self); a person with two overlapping approved
 * leaves is counted once (per-row, not per-leave).
 */
export function teamAwayToday(
  rows: TeamAwayRow[],
  todayIso: string,
  viewerPersonId: string | null,
): number {
  let count = 0;
  for (const row of rows) {
    if (viewerPersonId != null && row.id === viewerPersonId) continue;
    const away = row.leaves.some(
      (l) => l.status === 'approved' && l.startDate <= todayIso && l.endDate >= todayIso,
    );
    if (away) count += 1;
  }
  return count;
}

/**
 * Count of self-service action items requiring the EMPLOYEE's own attention — the reporter's "Pending
 * Tasks" ("X tasks require your attention", e.g. uploading documents). Deliberately DISTINCT from the
 * inverse "my requests awaiting a decision" (leave/claims in someone else's queue): these are things the
 * employee must DO. Today the only tracked employee-owned task type is pending 360 peer-feedback requests
 * (from `myFeedbackRequests`); the helper sums an array of counts so new task types (document-upload
 * obligations, acknowledgements) plug in without touching the renderer. Negative inputs are clamped.
 */
export function pendingTasksCount(counts: number[]): number {
  return counts.reduce((sum, n) => sum + Math.max(0, n), 0);
}

export type ReminderHoliday = { date: string };

/**
 * Count of a manager's "Upcoming Reminders" (the reporter's 4th manager card): performance/probation
 * review deadlines assigned to them + upcoming company holidays within the reminder window
 * `[todayIso, cutoffIso]` (inclusive). `reviewDeadlineCount` is the manager's pending-review queue
 * (`pendingManagerReviewsFor(...).length`); `holidays` is the already-fetched upcoming-holidays list.
 * Mandatory-training reminders contribute 0 until a training module exists — this helper's signature
 * absorbs them (add a `trainingCount` arg) without a card/renderer change. Pure — the page supplies the
 * ISO window bounds so no Date/TZ math leaks into the tested helper.
 */
export function upcomingRemindersCount(
  holidays: ReminderHoliday[],
  reviewDeadlineCount: number,
  todayIso: string,
  cutoffIso: string,
): number {
  const holidaysSoon = holidays.filter((h) => h.date >= todayIso && h.date <= cutoffIso).length;
  return holidaysSoon + Math.max(0, reviewDeadlineCount);
}
