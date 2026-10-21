import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const actions = readFileSync(new URL('../app/approvals/actions.ts', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
const toast = readFileSync(new URL('../components/ui/toast-trigger.tsx', import.meta.url), 'utf8');
function actionSection(start: string, end: string) {
    const first = actions.indexOf(start), last = actions.indexOf(end, first);
    expect(first).toBeGreaterThanOrEqual(0); expect(last).toBeGreaterThan(first);
    const value = actions.slice(first, last); expect(value.length).toBeGreaterThan(100); return value;
}
describe('last assigned Attendance task retains feedback without broadening inbox admission', () => {
    it('resolves a post-decision allowed destination while preserving legacy audiences', () => {
        const destination = actionSection('async function attendanceDecisionReturnUrl', 'function done(');
        expect(destination).toContain("!isAdmin(s) && !(s.roles ?? []).includes('manager')");
        expect(destination).toContain('await hasPendingAttendanceParticipantAssignment(s)');
        expect(destination).toContain('await pendingRewardReviews(s, scopeIds)');
        expect(destination).toContain('return `/?${query.toString()}`');
        expect(destination).toContain('return approvalsReturnUrl({ ...nav, ...feedback })');
        expect(destination).toContain("query.set('toast', feedback.toast)");
        expect(destination).toContain("query.set('error', feedback.error)");
    });
    it('uses that destination after single and all-Attendance bulk decisions; the neutral shell renders feedback', () => {
        const action = actionSection('export async function approveCorrectionAction', '/**');
        expect(action.indexOf('await decideAttendanceCorrection')).toBeLessThan(action.indexOf('attendanceDecisionReturnUrl'));
        expect(action).toContain('attendanceDecisionReturnUrl(s, nav, { toast })');
        expect(actions).toContain("items.every(item => item.type === 'attendance') ? await attendanceDecisionReturnUrl");
        expect(shell).toContain('<ToastFromQuery />');
        expect(toast).toContain("params.get('toast')");
        expect(toast).toContain("params.get('error')");
    });
});
