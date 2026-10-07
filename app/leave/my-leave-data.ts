import type { SessionContext } from '@/db/client';
import { listEmployees, listLeaveTypes, listEligibleLeaveTypesFor, replacementLeaveLedger, myEmployment } from '@/core/read';
import { canApplyLeaveOnBehalf } from '@/core/leave';
import { myLeaveDashboard } from '@/core/my-leave';
import { sharedLeaveGroupBalances } from '@/core/leave-shared-group';
import { leaveCreditOfferForEmployment, listReplacementLeaveRequests, replacementRequestAvailability } from '@/packs/leave/service';
import { loadOwnLeaveHistory, type HistorySearch } from '@/components/leave/own-leave-history';
import { isReplacementLeaveType } from '@/core/ess-view';

type Me = NonNullable<Awaited<ReturnType<typeof myEmployment>>>;

export async function loadMyLeave(p: {
  session: SessionContext;
  scopeIds: string[] | undefined;
  me: Me;
  sp: HistorySearch & { leaveYear?: string };
  locale: string;
  today: string;
}) {
  const { session, scopeIds, me, sp, locale, today } = p;
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
  const replacementRequest = await replacementRequestAvailability(session, me.employmentId, today);
  const leaveCreditOffer = replacementRequest.allowed ? await leaveCreditOfferForEmployment(session, me.employmentId) : null;
  const dashboard = await myLeaveDashboard(session, me.employmentId, { today, year: sp.leaveYear, locale });
  const leaveYearAsOf = dashboard.selectedYear !== dashboard.currentYear ? `${dashboard.selectedYear}-12-31` : today;
  const replacementCard = dashboard.cards.find((c) => isReplacementLeaveType(c));
  const replacementLedger = replacementCard ? await replacementLeaveLedger(session, me.employmentId) : null;
  const replacementRequests = replacementCard ? await listReplacementLeaveRequests(session, me.employmentId) : [];
  const sharedGroupBalances = await sharedLeaveGroupBalances(session, me.employmentId, { locale, asOf: leaveYearAsOf });
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
