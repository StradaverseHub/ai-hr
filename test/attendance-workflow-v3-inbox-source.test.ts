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
describe('ordinary v3 admission does not query unrelated module queues', () => {
    it('keeps general queue loading separate from the Attendance-only capability', () => {
        const loaders = section('const [leave, leaveCancellations, replacementRequests, loadedCorrections', 'const corrections = attendanceOnly');
        expect(loaders).toContain("attendanceOnly ? Promise.resolve([]) : listLeaveRequests");
        expect(loaders).toContain('attendanceOnly ? Promise.resolve([]) : listPendingLeaveCancellations');
        expect(loaders).toContain('attendanceOnly ? Promise.resolve([]) : listPendingReplacementLeaveRequests');
        expect(loaders).toContain('claimsOn && !attendanceOnly ? listPendingClaims');
        expect(page).toContain('!attendanceOnly && me?.employmentId ? pendingManagerReviewsFor');
    });
    it('uses only actionable non-self frozen v3 requests and does not manufacture historical totals', () => {
        const projection = section('const corrections = attendanceOnly', '// 1e9145d4 — the kind of day');
        expect(projection).toContain('row.workflow?.routingVersion === 3 && row.canDecide && row.personId !== s.personId');
        expect(page).toContain('const decided = attendanceOnly ? { approved: null, rejected: null, cancelled: null } : await decidedStatusCounts');
        expect(page).toContain("(!attendanceOnly || section === 'corrections')");
    });
});
