/**
 * r397 — THE MY LEAVE PAGE'S READS AS THEY WERE BEFORE r397, kept verbatim so the equivalence test
 * (test/r397-my-leave-equivalence.test.ts) can compare old against new for the same employee.
 *
 * TEST-ONLY. Nothing under app/, core/, lib/ or packs/ may import this file.
 *
 * `loadMyLeaveBefore` is app/leave/page.tsx lines 239–589 at b6b2abb8 (main@e135f3b4 + docs), the
 * self-service path past the short-page return, with the JSX and the pure presentation derivations
 * removed: every `await` is the page's own, in the page's own order, sequential, with the page's own
 * arguments. It returns every value those awaits produced.
 *
 * Any kernel function r397 rewrote is copied below in its pre-r397 form (the `before*` functions) and
 * called from here instead of the live one, so the comparison is old CODE against new CODE, not the
 * new code against itself.
 */
import type { SessionContext } from '../../db/client';
import {
  listEmployees,
  listLeaveTypes,
  listEligibleLeaveTypesFor,
  replacementLeaveLedger,
  myEmployment,
} from '../../core/read';
import { canApplyLeaveOnBehalf } from '../../core/leave';
// The pre-r397 dashboard, verbatim (its per-type reads were batched by r397).
import { myLeaveDashboardBefore as myLeaveDashboard } from './r397-my-leave-dashboard-before';
import { sharedLeaveGroupBalances } from '../../core/leave-shared-group';
import {
  leaveCreditOfferForEmployment,
  listReplacementLeaveRequests,
  replacementRequestAvailability,
} from '../../packs/leave/service';
import { type HistorySearch } from '../../components/leave/own-leave-history';
import { loadOwnLeaveHistory } from './r397-own-leave-history-before';
import { isReplacementLeaveType } from '../../core/ess-view';

type Me = NonNullable<Awaited<ReturnType<typeof myEmployment>>>;

export async function loadMyLeaveBefore(p: {
  session: SessionContext;
  scopeIds: string[] | undefined;
  me: Me;
  sp: HistorySearch & { leaveYear?: string };
  locale: string;
  today: string;
}) {
  const { session, scopeIds, me, sp, locale, today } = p;
  const ess = true; // past the page's short-page return `admin` is necessarily false
  const [employees, leaveTypes, eligibleLeaveTypes] = await Promise.all([
    listEmployees(session, scopeIds),
    listLeaveTypes(session, { locale, includeArchived: false }),
    listEligibleLeaveTypesFor(session, me.employmentId, locale),
  ]);
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, locale, { sensitivity: 'base' });
  leaveTypes.sort(byName);
  eligibleLeaveTypes.sort(byName);
  const active = employees.filter((e) => !e.terminatedOn);
  const eligibleTypeIds = new Set(eligibleLeaveTypes.map((lt) => lt.id));
  const myCompanyId = active.find((e) => e.employmentId === me.employmentId)?.companyId ?? null;
  const canApplyOnBehalf = await canApplyLeaveOnBehalf(session, myCompanyId);
  const replacementRequest = ess && me ? await replacementRequestAvailability(session, me.employmentId, today) : { allowed: false };
  const leaveCreditOffer =
    ess && me && replacementRequest.allowed ? await leaveCreditOfferForEmployment(session, me.employmentId) : null;
  const dashboard = ess && me ? await myLeaveDashboard(session, me.employmentId, { today, year: sp.leaveYear, locale }) : null;
  const leaveYearAsOf =
    dashboard && dashboard.selectedYear !== dashboard.currentYear ? `${dashboard.selectedYear}-12-31` : today;
  const replacementCard = dashboard?.cards.find((c) => isReplacementLeaveType(c));
  const replacementLedger = replacementCard && me ? await replacementLeaveLedger(session, me.employmentId) : null;
  const replacementRequests = replacementCard && me ? await listReplacementLeaveRequests(session, me.employmentId) : [];
  const sharedGroupBalances =
    ess && me ? await sharedLeaveGroupBalances(session, me.employmentId, { locale, asOf: leaveYearAsOf }) : [];
  const { upcoming, historyFilterParams } = await loadOwnLeaveHistory({ session, me, sp, locale, leaveTypes, eligibleTypeIds });
  return {
    employees,
    leaveTypes,
    eligibleLeaveTypes,
    canApplyOnBehalf,
    replacementRequest,
    leaveCreditOffer,
    dashboard,
    leaveYearAsOf,
    replacementLedger,
    replacementRequests,
    sharedGroupBalances,
    upcoming,
    historyFilterParams,
  };
}
