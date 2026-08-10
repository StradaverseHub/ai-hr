/**
 * r80 — "Remove the Request subsection from the Employee Details page (HR Admin → My Leave)", reported as
 * a duplicate of Approval Items.
 *
 * The subsection was HELD. This file is the evidence, kept executable so the finding cannot quietly rot:
 *
 *  1. The premise was already true, in a way the reporter could not see. The Requests table on /leave has
 *     never carried an approve or reject control — consultant feedback #8/#10 took inline approve/reject
 *     off that page ("approvals live in the Approvals inbox", header comment of app/leave/page.tsx). What
 *     survived was `decideLeaveAction` in app/leave/actions.ts: a leave decide path with no caller anywhere
 *     in the repo, yet still a callable endpoint because every export of a 'use server' module is one.
 *     THAT was the duplicate way in, and r80 removed it. §1 proves it is gone AND that the capability it
 *     offered still exists under Approval Items, for both the single and the bulk decide path.
 *
 *  2. The table itself is not a duplicate. §2 enumerates what the subsection offers against what
 *     /approvals offers. Four capabilities exist NOWHERE else for an HR admin: the org-wide request
 *     register over every status, the every-column filter set (0773bda9 + 8ec63139), the filtered
 *     CSV/Excel export (/leave/export, whose only links in the whole app are on this page), and
 *     AdminCancelLeaveDialog (22e68ff0). Removing the table would have undone item 8ec63139 and orphaned
 *     /leave/export — the same conclusion r74 Decision 5 reached about this exact table.
 *
 * Composition and gating are asserted from SOURCE (the RSC pages cannot render in this suite — precedent:
 * test/leave-inquiry-surfaces.test.ts, test/my-absence-layout-restore.test.ts). The one thing source cannot
 * prove — that the removed export is really gone from the module's public surface — is asserted against the
 * loaded module itself.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// app/leave/actions.ts is a server module: give it the Next/next-intl surfaces the harness lacks, exactly
// as test/leave-apply-day-breakdown.test.ts does, so it can be imported for the export-surface check.
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => null) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async () => (k: string) => k,
}));

import * as leaveActions from '../app/leave/actions';
import * as coreLeave from '../core/leave';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const leavePage = read('app/leave/page.tsx');
const leaveActionsSrc = read('app/leave/actions.ts');
const approvalsPage = read('app/approvals/page.tsx');
const approvalsActions = read('app/approvals/actions.ts');
const recordsPage = read('app/leave/employee-records/page.tsx');

/** Every .ts/.tsx under the app's own source roots (node_modules and test/ excluded by construction). */
const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(root + dir, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name)) out.push(rel);
    }
  };
  for (const d of ['app', 'components', 'lib', 'core', 'packs']) walk(d);
  return out;
};

describe('§1 r80 removal: the leave decide path exists ONLY under Approval Items', () => {
  it('app/leave no longer exports a leave decide action', () => {
    // The load-bearing assertion: the module's PUBLIC surface, not a grep. A 'use server' export is a
    // callable endpoint, so "no caller in the repo" would not have been enough to call it dead.
    expect(Object.keys(leaveActions)).not.toContain('decideLeaveAction');
    // The four self-service / admin leave actions this module really does serve are untouched.
    for (const kept of [
      'requestLeaveAction',
      'editLeaveAction',
      'cancelOwnLeaveAction',
      'adminCancelLeaveAction',
      'requestLeaveCancellationAction',
    ]) {
      expect(Object.keys(leaveActions), kept).toContain(kept);
    }
    // And the module no longer reaches the decide service at all — neither call nor import.
    expect(leaveActionsSrc).not.toMatch(/export async function decideLeaveAction/);
    expect(leaveActionsSrc).not.toMatch(/await decideLeave\(/);
    expect(leaveActionsSrc).not.toMatch(/^\s{2}decideLeave,$/m);
  });

  it('CAPABILITY SURVIVES: approving and rejecting leave still runs from Approval Items', () => {
    // The service is unchanged and still exported...
    expect(typeof coreLeave.decideLeave).toBe('function');
    // ...and /approvals is the surface that calls it — single decide AND bulk decide, the two paths that
    // between them carry every approve/reject on the platform.
    expect(approvalsActions).toContain("import { decideLeave, decideLeaveDate, decideLeaveDates, decideLeaveCancellation } from '@/core/leave';");
    expect(approvalsActions).toContain('export async function approveLeaveAction(formData: FormData) {');
    expect(approvalsActions).toContain("await decideLeave(s, { leaveRequestId: String(formData.get('id')), decision, rejectReason });");
    expect(approvalsActions).toContain('await decideLeave(s, { leaveRequestId: item.id, decision, rejectReason, deciderEmploymentId });');
    // The controls that post it are still mounted on the page.
    expect(approvalsPage).toContain('<LeaveDecideControls');
    expect(approvalsPage).toContain('<LeaveDateBreakdown');
  });

  it('SAME ROLES: /approvals admits everyone the removed action could have served', () => {
    // decideLeaveAction ran under the caller's own session with the service asserting authority. /approvals
    // admits admin OR manager and lets the SERVICES decide — so no role lost a route to a decision.
    expect(approvalsPage).toContain('const admin = isAdmin(s);');
    expect(approvalsPage).toContain("const manager = (s.roles ?? []).includes('manager');");
    expect(approvalsPage).toContain("if (!admin && !manager) redirect('/');");
  });
});

describe('§2 r80 hold: the Requests subsection is not a second Approval Items', () => {
  it('carries no approve/reject control of its own — so nothing about approvals is duplicated here', () => {
    expect(leavePage).not.toMatch(/decideLeaveAction/);
    expect(leavePage).not.toMatch(/<LeaveDecideControls/);
    expect(leavePage).not.toMatch(/<DecideButtons/);
    // The page says so itself, and has since consultant feedback #8/#10.
    expect(leavePage).toContain('chips, or inline approve/reject');
  });

  it('ENUMERATION: the register over every status is GONE, and /approvals never replaced it', () => {
    // INVERTED (afd0a87c). /leave no longer runs the paged, all-status projection at all.
    expect(leavePage).not.toContain('listLeaveRequestsPage(session, {');
    expect(leavePage).not.toContain("t('requestsTitle')");
    // The point this test has always made still stands and is why the loss is worth recording:
    // /approvals is NOT a substitute — pending rows only, capped at 200, no filters, no export.
    expect(approvalsPage).toContain("listLeaveRequests(s, scopeIds, 200, { status: 'pending' })");
    expect(approvalsPage).not.toMatch(/listLeaveRequestsPage/);
  });

  it('ENUMERATION: the every-column filter set is GONE — an accepted loss, not a relocation', () => {
    // INVERTED. These fourteen narrowings existed on /leave and nowhere else; the reporter has accepted
    // losing them rather than have them moved. Asserted absent from BOTH pages so a later edit cannot
    // quietly reintroduce half a filter set with no table to narrow.
    for (const name of ["name: 'q'", "name: 'company'", "name: 'bu'", "name: 'loc'", "name: 'duration'", "name: 'pendingWith'", "name: 'approvedBy'"]) {
      expect(leavePage.includes(name), `/leave should no longer have ${name}`).toBe(false);
      expect(approvalsPage.includes(name), `/approvals never had ${name}`).toBe(false);
    }
    expect(approvalsPage).not.toMatch(/FilterChips/);
  });

  it('ENUMERATION: the filtered export route is DELETED, not orphaned', () => {
    // INVERTED. r74 Decision 5 found app/leave/page.tsx was the export route's ONLY link in the whole
    // application, so removing the table would have stranded it. It is deleted in the same change.
    expect(leavePage).not.toContain('/leave/export?');
    expect(() => read('app/leave/export/route.ts')).toThrow();
    expect(sourceFiles().filter((f) => read(f).includes('/leave/export'))).toEqual([]);
    expect(approvalsPage).not.toMatch(/exportHref/);
  });

  it('ENUMERATION: admin cancel-on-behalf moved OFF /leave and is not on /approvals either', () => {
    // NOT a loss: fe3eb141 had already moved this action onto Employee Leave Record, and the dashboard
    // calendar carries it too. /leave simply stops being a third home for it.
    expect(leavePage).not.toContain('<AdminCancelLeaveDialog');
    expect(recordsPage).toContain('<AdminCancelLeaveDialog');
    expect(read('components/planned-absences-grid.tsx')).toContain('<AdminCancelLeaveDialog');
    // Cancelling an already-APPROVED leave is not a decision on a pending item, so the approvals inbox
    // still has no such control — its only cancellation flow decides an employee's give-back REQUEST.
    expect(approvalsPage).not.toMatch(/<AdminCancelLeaveDialog/);
    expect(approvalsPage).toContain('decideLeaveCancellationAction');
  });

  it('ENUMERATION: own-row controls survive for the SUBJECT, and /approvals still self-bans own rows', () => {
    // The three subject-only dialogs stay in source and still serve an ordinary employee — they render
    // from `selfHistory`, which is the viewer's own rows and is empty for an admin.
    for (const own of ['<EditLeaveDialog', '<CancelLeaveDialog', '<CancelDatesDialog']) {
      expect(leavePage.includes(own), own).toBe(true);
    }
    // The `admin ? [] :` arm went with the admin branch (388e53c2): an administrator no longer reaches
    // this code at all, because /leave returns the short page before it. The property being pinned is
    // unchanged and is now pinned at its source — these dialogs render from the viewer's OWN rows.
    expect(leavePage).toContain('const selfHistory = [...history].sort(');
    expect(leavePage).toContain('if (me == null || admin) {');
    // The mine() self-ban is unchanged: on /approvals the viewer's OWN row shows a label, never a control.
    expect(approvalsPage).toContain('const mine = (personId: string | null) => s.personId != null && personId === s.personId;');
    expect(approvalsPage).toContain('{mine(r.personId) ? (');
    expect(approvalsPage).not.toMatch(/<EditLeaveDialog/);
    expect(leavePage).toContain('const ess = !admin;');
  });

  it('ENUMERATION: the per-employee record screen is still per-employee — it did NOT become a replacement', () => {
    // Worth keeping precisely because the removal did not change it: the reporter has said they will
    // redesign this screen separately, and until they do there is no org-wide view anywhere.
    expect(recordsPage).toContain('employmentIds: [selected.employmentId]');
    expect(recordsPage).toContain('<AdminCancelLeaveDialog');
    // The three subject-only controls remain absent here, which is why an ADMIN editing their own pending
    // request is the one capability with no home left. Disclosed and accepted in the approved plan.
    for (const absent of ['<EditLeaveDialog', '<CancelLeaveDialog', '<CancelDatesDialog']) {
      expect(recordsPage.includes(absent), absent).toBe(false);
    }
  });

  it('the subsection is REMOVED, and the inquiry surface it sat inside is intact at its new address', () => {
    // REPOINTED BY 388e53c2, not weakened: the admin landing view — the employee listing and its
    // left-side nav — moved to the Team Leave Tracker route, so it is asserted there. What this test is
    // actually about is that the ORG-WIDE REQUEST TABLE stayed removed, and that is checked on both.
    const trackerPage = read('app/leave/tracker/page.tsx');
    expect(trackerPage).toContain('if (admin) {');
    expect(trackerPage).toContain('<LeaveInquiryNav active="details"');
    // The retired table's pager goes with it, on either page.
    expect(leavePage).not.toContain('<Pager hrefFor={pagerHref}');
    expect(trackerPage).not.toContain('<Pager hrefFor={pagerHref}');
    // And the removal is recorded where the next reader of the page will meet it, replacing the two
    // previous "KEPT" justifications rather than leaving them to be re-litigated a third time. The record
    // stays on /leave, which is where a reader comes looking for the table.
    expect(leavePage).not.toContain('KEPT AGAIN in r80');
    expect(leavePage).toContain('THE ORG-WIDE LEAVE-REQUEST TABLE IS GONE');
  });
});
