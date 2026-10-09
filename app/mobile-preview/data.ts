import 'server-only';
import type { SessionContext } from '@/db/client';
import { myEmployment, myPersonName, listEligibleLeaveTypesFor, listLeaveRequestsPage, myPayslips } from '@/core/read';
import { myLeaveDashboard } from '@/core/my-leave';
import { attendanceForEmploymentRange, ownClockToday } from '@/packs/attendance/service';
import { myTeamLeaveProjection } from '@/packs/leave/service';
import { listClaimsForEmployment } from '@/packs/claims/service';
import { resolveMyTeamScope } from '@/core/my-team-scope';
import { listPendingTasks } from '@/core/approvals-inbox';
import { listNotifications } from '@/core/notifications';
import { isModuleEnabled } from '@/core/entitlements';
import { hasTeamAccess, isAdmin } from '@/lib/authz';
import { ENTITLEMENT_STATUS_LABEL_KEY, entitlementStatusNeedsNotice } from '@/lib/entitlement-status';
import { todayInKualaLumpur } from '@/lib/hr-date';
import type { MobilePreviewData, PreviewRead } from '@/components/mobile-preview/types';

// The preview accepts no employee/user/tenant selector. Own employment comes from the web session;
// team membership and company narrowing come from the same authority as My Team. No session is sent
// to the browser, and no mobile bearer endpoint is weakened to admit web/demo cookies.
export async function loadMobilePreview(s: SessionContext, scopeIds: string[], locale: string): Promise<MobilePreviewData> {
  const today = todayInKualaLumpur();
  const me = await myEmployment(s);
  const name = me?.name ?? await myPersonName(s);
  const moduleState = (code: string): 'ready' | 'disabled' | 'unavailable' => {
    try { return isModuleEnabled(s, code) ? 'ready' : 'disabled'; }
    catch { return 'unavailable'; }
  };
  async function read<T>(name: string, enabled: 'ready' | 'disabled' | 'unavailable', fn: () => Promise<T>): Promise<PreviewRead<T>> {
    if (enabled !== 'ready') return { status: enabled };
    try { return { status: 'ready', data: await fn() }; }
    catch { console.error(`[mobile-preview] ${name} unavailable`); return { status: 'unavailable' }; }
  }
  const own = (code: string) => me ? moduleState(code) : 'disabled';
  const [clock, leave, requests, claims, team, tasks, inbox, payslips] = await Promise.all([
    read('clock', own('attendance'), async () => {
      const c = await ownClockToday(s);
      const [day] = await attendanceForEmploymentRange(s, me!.employmentId, c.date, c.date);
      // The adjudicated day pair includes corrections; raw capture receipts can predate a correction.
      const events = [
        ...(day?.checkInAt ? [{ direction: 'in', time: day.checkInAt.slice(0, 5) }] : []),
        ...(day?.checkOutAt ? [{ direction: 'out', time: day.checkOutAt.slice(0, 5) }] : []),
      ];
      return { date: c.date, clockedIn: c.clockedIn, shiftStart: c.shift.start, shiftEnd: c.shift.end, events };
    }),
    read('leave', own('leave'), async () => {
      const [dashboard, eligible] = await Promise.all([
        myLeaveDashboard(s, me!.employmentId, { today, locale }),
        listEligibleLeaveTypesFor(s, me!.employmentId, locale),
      ]);
      const applyIds = new Set(eligible.map(t => t.id));
      // These figures already include ESS visibility and eligibility. Never re-derive or sum pools.
      return dashboard.cards.map(c => ({ id: c.leaveTypeId, name: c.leaveType,
        available: c.canApplyFor, balance: c.balance, taken: c.taken, pending: c.pending, takenOnly: c.takenOnly,
        sharedWith: c.sharedBalance?.contributingLeaveTypes.filter(n => n !== c.leaveType) ?? [],
        canRequest: !isAdmin(s) && applyIds.has(c.leaveTypeId),
        notice: entitlementStatusNeedsNotice(c.entitlementStatus) ? ENTITLEMENT_STATUS_LABEL_KEY[c.entitlementStatus] : null,
        cycleStart: c.cycleStart, cycleEnd: c.cycleEnd }));
    }),
    read('requests', own('leave'), async () => {
      const page = await listLeaveRequestsPage(s, { employmentIds: [me!.employmentId], limit: 20, offset: 0 });
      return { total: page.total, items: page.rows.map(r => ({ id: r.id, type: r.leaveType,
        from: r.startDate, to: r.endDate, status: r.status, partial: !!r.hasRejectedDates })) };
    }),
    read('claims', own('claims'), async () => (await listClaimsForEmployment(s, me!.employmentId))
      .slice(0, 20).map(c => ({ id: c.id, type: c.typeName, date: c.incurredOn, status: c.status, amount: String(c.amount) }))),
    read('team', hasTeamAccess(s) ? moduleState('leave') : 'disabled', async () => {
      const scope = await resolveMyTeamScope(s, { view: 'week', scope: 'all', companyIds: scopeIds });
      const end = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
      const rows = await myTeamLeaveProjection({ ...s, personId: scope.principal.personId }, {
        employmentIds: scope.employees.map(e => e.employmentId), from: today, to: end, today,
      });
      return scope.employees.map(e => ({ employmentId: e.employmentId, name: e.name,
        dates: rows.filter(r => r.employmentId === e.employmentId).flatMap(r => r.dates
          .filter(d => d.date >= today && d.date <= end).map(d => ({ date: d.date, status: d.status, session: r.session }))) }));
    }),
    read('tasks', moduleState('leave'), async () => (await listPendingTasks(s, scopeIds, {
      attendance: moduleState('attendance') === 'ready', claims: moduleState('claims') === 'ready',
    })).map(t => ({ id: t.id, kind: t.kind, subject: t.subjectName, href: t.linkPath }))),
    read('inbox', own('notifications'), async () => (await listNotifications(s, me!.employmentId, { limit: 30 }))
      .map(n => ({ id: n.id, title: n.title, body: n.body, href: n.linkPath,
        read: n.readAt != null, createdAt: n.createdAt.toISOString() }))),
    read('payslips', own('payroll'), async () => (await myPayslips(s, [me!.employmentId]))
      .filter(p => p.status === 'closed' && p.released)
      .map(p => ({ id: p.id, company: p.company, period: p.payPeriod }))),
  ]);
  return { today, leaveHistoryHref: isAdmin(s) && me ? `/leave/employee-records?emp=${me.employmentId}` : '/leave/history', loadedAt: new Date().toISOString(), person: { name, employeeCode: me?.employeeCode ?? null },
    employment: me ? { id: me.employmentId, company: me.company, department: me.department, position: me.position } : null,
    clock, leave, requests, claims, team, tasks, inbox, payslips };
}
