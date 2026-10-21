import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const page = readFileSync(new URL('../app/approvals/page.tsx', import.meta.url), 'utf8');
function section(from: string, to: string) {
    const start = page.indexOf(from), end = page.indexOf(to, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const result = page.slice(start, end);
    expect(result.length).toBeGreaterThan(100);
    return result;
}
describe('ordinary v3 presentation keeps unrelated detail loaders separate', () => {
    it('discovers assignments through the canonical inbox and preserves Attendance-only detail loading', () => {
        const admission=section('const [rewardReviews, assignedAttendance, assignedTasks] =',"const t = await getTranslations('approvals');");
        expect(admission).toContain('await Promise.all([');
        expect(admission).toContain('!focus&&!admin && !manager ? listPendingTasks(s,scopeIds,{attendance:attendanceOn,claims:claimsOn}) : Promise.resolve([])');
        expect(admission).toContain("assignedTasks.every(task=>task.kind==='attendance')");
        expect(admission).not.toContain('listLeaveRequests(');
        expect(admission).not.toContain('listPendingClaims(');
        const loaders = section('const [leave, leaveCancellations, replacementRequests, loadedCorrections', 'const corrections = attendanceOnly');
        expect(loaders).toContain("attendanceOnly||!include('leave') ? Promise.resolve([]) : listLeaveRequests");
        expect(loaders).toContain("attendanceOnly||!include('leaveCancellation') ? Promise.resolve([]) : listPendingLeaveCancellations");
        expect(loaders).toContain("attendanceOnly||!include('replacementLeave') ? Promise.resolve([]) : listPendingReplacementLeaveRequests");
        expect(loaders).toContain("claimsOn && !attendanceOnly&&include('claim') ? listPendingClaims");
        expect(page).toContain('const own = !focus&&!attendanceOnly && s.personId ? await myOwnEmploymentSubjects');
        expect(page).toContain('own.map(subject=>pendingManagerReviewsFor(s,subject.employmentId))');
    });
    it('uses only actionable non-self frozen v3 requests and does not manufacture historical totals', () => {
        const projection = section('const corrections = attendanceOnly', '// 1e9145d4 — the kind of day');
        expect(projection).toContain('attendanceOnly&&!focus ?');
        expect(projection).toContain('row.workflow?.routingVersion === 3 && row.canDecide && row.personId !== s.personId');
        expect(page).toContain('const decided = attendanceOnly||focus ? { approved: null, rejected: null, cancelled: null } : await decidedStatusCounts');
        expect(page).toContain("(!attendanceOnly || section === 'corrections')");
    });
});
