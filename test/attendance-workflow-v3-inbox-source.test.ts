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
describe('ordinary v3/v4 admission and exact assignment keep unrelated detail loaders separate', () => {
    it('discovers real assignments without a role promotion and preserves Attendance-only detail loading', () => {
        const admission=section('const [rewardReviews,',"const t = await getTranslations('approvals');");
        expect(admission).toContain('await Promise.all([');
        expect(admission).toContain('!focus&&!admin&&!manager?listPendingTasks(s,scopeIds,{attendance:attendanceOn,claims:claimsOn,performance:false,rewards:false,probation:false},{noticeAcknowledgements:false}):Promise.resolve([])');
        expect(admission).toContain("assignedTasks.every(task=>task.kind==='attendance')");
        // Managed resignation is another assignment source, not a role promotion or an excuse to load
        // unrelated queues on an exact Attendance focus. It also prevents a mixed inbox becoming Attendance-only.
        expect(admission).toContain("!focus&&probationOn?resignationInbox(s,{kind:'approvals',companyIds:scopeIds,limit:resignationQuery.limit,offset:resignationQuery.offset})");
        const redirect=admission.match(/if\(([^;\n]+)\)redirect\('\/'\);/);
        expect(redirect, 'ordinary unassigned readers still leave the inbox').not.toBeNull();
        expect(redirect![1].replace(/\s+/g,'').split('&&')).toEqual([
            '!focus','!admin','!manager','!resignationWork.total','!rewardReviews.length',
            '!probationApprovals.items.length','!assignedAttendance','!assignedTasks.length',
        ]);
        expect(admission).toContain("const attendanceOnly=!admin&&!manager&&!resignationWork.total&&!rewardReviews.length&&!probationApprovals.items.length&&assignedAttendance&&assignedTasks.every(task=>task.kind==='attendance');");
        expect(page).toContain("const admin=isAdmin(s),manager=(s.roles??[]).includes('manager');");
        const loaders=section('const [leave, leaveCancellations, replacementRequests, loadedCorrections','const corrections = attendanceOnly');
        expect(loaders).toContain("attendanceOnly||!include('leave') ? Promise.resolve([]) : listLeaveRequests");
        expect(loaders).toContain("attendanceOnly||!include('leaveCancellation') ? Promise.resolve([]) : listPendingLeaveCancellations");
        expect(loaders).toContain("attendanceOnly||!include('replacementLeave') ? Promise.resolve([]) : listPendingReplacementLeaveRequests");
        expect(loaders).toMatch(/claimsOn\s*&&\s*!attendanceOnly\s*&&\s*include\('claim'\)\s*\?\s*focus\s*\?\s*listPendingClaims\(s,\{requestId:focusedId\('claim'\)\}\)[^\n]*\n\s*:\s*listPendingClaimsPage\(/);
        expect(page).toContain('const own=!focus&&!attendanceOnly&&s.personId?await myOwnEmploymentSubjects');
    });
    it('proves exact assignment before any focus bypass and keeps the ordinary narrow v3/v4 presentation', () => {
        const admission=page.indexOf('if(focus&&!await isCurrentAssignedApproval');
        const scoped=page.indexOf('const queueScope=focus?undefined:scopeIds;');
        expect(admission).toBeGreaterThanOrEqual(0);expect(scoped).toBeGreaterThan(admission);
        const projection=section('const corrections = attendanceOnly','// 1e9145d4 — the kind of day');
        expect(projection).toContain('attendanceOnly&&!focus');
        expect(projection).toContain('(row.workflow?.routingVersion === 3 || row.workflow?.routingVersion === 4) && row.canDecide && row.personId !== s.personId');
        expect(page).toContain('const decided = attendanceOnly||focus ? { approved: null, rejected: null, cancelled: null } : await decidedStatusCounts');
        expect(page).toContain("(!attendanceOnly || section === 'corrections')");
        expect(page).toContain('if(!focusedRows.some(row=>row.id===focus.id))notFound();');
    });
});
