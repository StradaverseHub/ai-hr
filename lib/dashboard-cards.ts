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
  | 'myPendingRequests'
  // manager
  | 'teamAwayToday'
  | 'onboardingWeek'
  | 'approvalRequests'
  // hr_admin
  | 'headcount'
  | 'pendingLeave'
  | 'companies'
  | 'latestPayroll';

/** Ordered card set per resolved role. `nextHoliday` intentionally appears for both employee + manager. */
export const ROLE_CARDS: Record<DashboardRole, DashboardCardId[]> = {
  employee: ['leaveBalance', 'nextHoliday', 'myPendingRequests'],
  manager: ['teamAwayToday', 'onboardingWeek', 'approvalRequests', 'nextHoliday'],
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
  myPendingRequests: { labelKey: 'myPendingRequests', href: '/leave' },
  teamAwayToday: { labelKey: 'teamAwayToday', href: '#planned-absences' },
  onboardingWeek: { labelKey: 'onboardingThisWeek', href: '/personnel' },
  approvalRequests: { labelKey: 'approvalRequests', href: '/approvals' },
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
