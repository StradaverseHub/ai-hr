/** Home is a projection. Never invents a payday, effort estimate, work location or absence. */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { ownLiveEmployment, ownLiveEmploymentTx } from './own-employment-selection';
import { leaveBalances, holidayDatesForEmployment, myPayslips } from './read';
import { myTeamLeaveProjection } from '../packs/leave/service';
import { ownClockToday } from '../packs/attendance/service';
import { listPendingTasks } from './approvals-inbox';
import { myFeedbackRequests } from '../packs/performance/service';
import { pendingManagerReviewsFor } from './employment-review';
import { noticesForEmployment } from './notice';
import { homeOwnPreferences, homeWorkingRequests, homeAvailability, homeMoments, homeTeamCalendar, homeReceivedGreetings } from './home-policy';
import { isModuleEnabled } from './entitlements';
import { homeDates, HomeError, type HomeCalendarEntry } from '../lib/home-model';
import { provenCompanyDatesTx } from './employment-company';
import { todayInKualaLumpur } from '../lib/hr-date';
export type HomeReadContext = {
    ctx: SessionContext;
    scopeIds: string[];
    employmentId: string;
    locale: string;
};
export async function homeReadSubject(p: HomeReadContext) { const subject = await ownLiveEmployment(p.ctx, p.employmentId); if (!p.scopeIds.includes(subject.companyProof.companyId!))
    throw new HomeError('unavailable'); return subject; }
export async function homeCalendar(p: HomeReadContext, from: string, to: string) {
    homeDates(from, to);
    await homeReadSubject(p);
    const today = todayInKualaLumpur();
    const [requests, holidays, wfh, preferences, team] = await Promise.all([myTeamLeaveProjection(p.ctx, { employmentIds: [p.employmentId], from, to, today, homeWindow: true }), holidayDatesForEmployment(p.ctx, { employmentId: p.employmentId, from, to }), homeWorkingRequests(p.ctx, { employmentId: p.employmentId, from, to }), homeOwnPreferences(p.ctx, p.employmentId), homeTeamCalendar(p.ctx, p.employmentId, from, to)]);
    const proofs = await withTenant(p.ctx, tx => provenCompanyDatesTx(tx, homeDates(from, to).map(date => ({ employmentId: p.employmentId, date }))));
    const permittedDates = new Set(homeDates(from, to).filter(date => { const co = proofs.get(p.employmentId + '|' + date)?.companyId; return co != null && p.scopeIds.includes(co); }));
    const entries: HomeCalendarEntry[] = [];
    for (const request of requests.slice(0, 1000))
        for (const day of request.dates)
            if (day.date >= from && day.date <= to)
                entries.push({ id: request.requestId + ':' + day.date, date: day.date, kind: 'leave', status: day.status, label: request.name, employmentId: p.employmentId, partial: request.session !== 'full_day' });
    for (const date of holidays)
        entries.push({ id: 'holiday:' + date, date, kind: 'holiday', status: 'approved', label: null, employmentId: p.employmentId });
    for (const request of wfh.items)
        if (['pending', 'approved'].includes(request.status))
            for (const date of homeDates(request.from, request.to, 31))
                if (date >= from && date <= to)
                    entries.push({ id: request.id + ':' + date, date, kind: 'wfh', status: proofs.get(p.employmentId + '|' + date)?.companyId === request.companyId ? request.status as 'pending' | 'approved' : 'unknown', label: null, employmentId: p.employmentId });
    for (const entry of team.items)
        entries.push({ id: entry.source_id + ':' + entry.entry_date + ':' + entry.kind, date: entry.entry_date, kind: entry.kind, status: entry.status, label: entry.full_name, employmentId: entry.employment_id });
    // Payroll configuration is not an employee-accessible payroll calendar. Absence remains explicit;
    // no calendar day is inferred from a paid batch date or salary amount.
    return { from, to, entries: entries.filter(entry => permittedDates.has(entry.date)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), weekStartsOn: preferences.sharing.weekStartsOn, paydayAvailable: false as const, teamCalendarAvailable: true as const, truncated: requests.length > 1000 || wfh.truncated || team.truncated || permittedDates.size < homeDates(from, to).length, wfhEnabled: preferences.policy?.wfhEnabled ?? false, policyId: preferences.policy?.id ?? null };
}
export async function homeDay(p: HomeReadContext) {
    await homeReadSubject(p);
    const today = todayInKualaLumpur();
    const [calendar, preferences] = await Promise.all([homeCalendar(p, today, today), homeOwnPreferences(p.ctx, p.employmentId)]);
    const enabled = isModuleEnabled(p.ctx, 'attendance');
    const clock = enabled ? await ownClockToday(p.ctx, undefined, p.employmentId) : null;
    const leave = calendar.entries.some(entry => entry.kind === 'leave' && entry.status === 'approved'), holiday = calendar.entries.some(entry => entry.kind === 'holiday');
    const lastCapture = clock?.captures.filter(capture => capture.locationName).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    return { date: today, serverNow: clock?.serverNow ?? new Date().toISOString(), clockedIn: clock?.clockedIn ?? null, openSince: clock?.openSince ?? null, workedSeconds: clock?.workedSeconds ?? null, shift: clock?.shift ?? null, locationName: lastCapture?.locationName ?? null, dayOff: leave ? 'leave' as const : holiday ? 'holiday' as const : null, clockAvailable: enabled && !leave && !holiday, wfhEnabled: preferences.policy?.wfhEnabled ?? false, policyId: preferences.policy?.id ?? null };
}
export async function homeTimeOff(p: HomeReadContext) {
    await homeReadSubject(p);
    const today = todayInKualaLumpur(), to = homeDates(today, today)[0];
    const end = new Date(today + 'T12:00:00Z');
    end.setUTCDate(end.getUTCDate() + 365);
    const future = end.toISOString().slice(0, 10);
    const [balances, requests] = await Promise.all([leaveBalances(p.ctx, p.employmentId, p.locale), myTeamLeaveProjection(p.ctx, { employmentIds: [p.employmentId], from: to, to: future, today, homeWindow: true })]);
    const next = requests.flatMap(request => request.dates.filter(day => day.status === 'approved' && day.date >= today).map(day => ({ id: request.requestId, date: day.date, name: request.name, partial: request.session !== 'full_day' }))).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))[0] ?? null;
    return { balances: balances.map(row => ({ id: row.leaveTypeId, name: row.leaveType, balance: row.balance, pending: row.pending, available: row.available })), next, truncated: requests.length > 1000 };
}
export async function homeTasks(p: HomeReadContext) {
    await homeReadSubject(p);
    const [tasks, feedback, reviews, wfh] = await Promise.all([listPendingTasks(p.ctx, p.scopeIds, { attendance: isModuleEnabled(p.ctx, 'attendance'), claims: isModuleEnabled(p.ctx, 'claims') }), isModuleEnabled(p.ctx, 'performance') ? myFeedbackRequests(p.ctx, { employmentId: p.employmentId, limit: 101 }) : Promise.resolve([]), pendingManagerReviewsFor(p.ctx, p.employmentId), homeWorkingRequests(p.ctx, { pendingDecisions: true, companyIds: p.scopeIds })]);
    const items = tasks.map(task => ({ id: task.id, kind: task.kind as string, label: task.subjectName, href: task.linkPath, dueOn: null as string | null }));
    for (const review of reviews)
        if (!items.some(item => item.id === review.id))
            items.push({ id: review.id, kind: 'managerReview', label: review.employee, href: '/approvals', dueOn: review.dueDate });
    for (const request of feedback)
        items.push({ id: request.requestId, kind: 'feedback', label: request.subject, href: '/me/performance', dueOn: null });
    for (const request of wfh.items)
        items.push({ id: request.id, kind: 'wfh', label: request.from + ' – ' + request.to, href: '/home/settings?employmentId=' + encodeURIComponent(p.employmentId) + '#home-working', dueOn: null });
    items.sort((a, b) => (a.dueOn ?? '9999-12-31').localeCompare(b.dueOn ?? '9999-12-31') || a.id.localeCompare(b.id));
    return { date: todayInKualaLumpur(), items: items.slice(0, 100), truncated: items.length > 100 || wfh.truncated, effortAvailable: false as const };
}
export async function homeNotices(p: HomeReadContext) { await homeReadSubject(p); const rows = await noticesForEmployment(p.ctx, p.employmentId, {limit:21}); return { items: rows.slice(0, 20).map(row => ({ id: row.id, title: row.title, summary: row.body.replace(/[#*_`>]/g, '').slice(0, 180), sender: row.publishedBy, publishedAt: row.publishedAt?.toISOString() ?? null, unread: row.firstViewedAt === null, pinned: row.pinned, category: row.category, requiresAcknowledgement: row.requiresAcknowledgement, acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null, contentDigest: row.contentDigest })), truncated: rows.length > 20 }; }
export async function homeAround(p: HomeReadContext) { await homeReadSubject(p); return homeAvailability(p.ctx, p.employmentId); }
export async function homeLittleMoments(p: HomeReadContext) { await homeReadSubject(p); const from = todayInKualaLumpur(), end = new Date(from + 'T12:00:00Z'); end.setUTCDate(end.getUTCDate() + 7); const [moments, greetings] = await Promise.all([homeMoments(p.ctx, p.employmentId, from, end.toISOString().slice(0, 10)), homeReceivedGreetings(p.ctx, p.employmentId)]); return { ...moments, greetings }; }
export async function homeGreeting(p: HomeReadContext) {
    const own = await homeReadSubject(p), today = todayInKualaLumpur();
    const base = await withTenant(p.ctx, async (tx) => { await ownLiveEmploymentTx(tx, p.ctx, p.employmentId); const [person] = await tx.select({ birthday: s.person.dateOfBirth }).from(s.person).where(eq(s.person.id, own.personId)).limit(1); const monthDay = today.slice(5); return { serverNow: new Date().toISOString(), name: own.personName.split(/\s+/)[0] || own.personName, kind: person?.birthday?.slice(5) === monthDay ? 'birthday' as const : own.hiredOn === today ? 'firstDay' as const : own.hiredOn < today && own.hiredOn.slice(5) === monthDay ? 'anniversary' as const : null }; });
    if (base.kind)
        return base;
    const previous = new Date(today + 'T12:00:00Z');
    previous.setUTCDate(previous.getUTCDate() - 1);
    const yesterday = previous.toISOString().slice(0, 10), calendar = await homeCalendar(p, yesterday, today);
    const approved = (date: string) => calendar.entries.some(entry => entry.kind === 'leave' && entry.status === 'approved' && entry.date === date);
    return { ...base, kind: approved(yesterday) && !approved(today) ? 'return' as const : null };
}
export async function homeBrief(p: HomeReadContext) {
    await homeReadSubject(p);
    const today = todayInKualaLumpur(), [tasks, timeOff, payslips] = await Promise.all([homeTasks(p), homeTimeOff(p), isModuleEnabled(p.ctx, 'payroll') ? myPayslips(p.ctx, [p.employmentId], { companyIds: p.scopeIds, releasedOnly: true, limit: 1 }) : Promise.resolve([])]);
    const insights: {
        key: string;
        kind: 'tasks' | 'leave' | 'payslip';
        count?: number;
        date?: string;
        name?: string;
        href: string;
        source: 'tasks' | 'leave' | 'payroll';
    }[] = [];
    if (tasks.items.length)
        insights.push({ key: 'tasks:' + tasks.items.map(item => item.id).sort().join(',').slice(0, 150), kind: 'tasks', count: tasks.items.length, href: '/#home-tasks', source: 'tasks' });
    if (timeOff.next)
        insights.push({ key: 'leave:' + timeOff.next.id + ':' + timeOff.next.date, kind: 'leave', date: timeOff.next.date, name: timeOff.next.name, href: '/leave', source: 'leave' });
    if (payslips[0])
        insights.push({ key: 'payslip:' + payslips[0].id, kind: 'payslip', href: '/me?tab=payroll&employmentId=' + encodeURIComponent(p.employmentId), source: 'payroll' });
    const dismissed = await withTenant(p.ctx, tx => tx.select({ key: s.homeInsightDismissal.sourceKey }).from(s.homeInsightDismissal).where(and(eq(s.homeInsightDismissal.appUserId, p.ctx.userId!), eq(s.homeInsightDismissal.date, today))));
    return { insights: insights.filter(insight => !dismissed.some(row => row.key === insight.key)).slice(0, 4), date: today, truncated: tasks.truncated || timeOff.truncated };
}
