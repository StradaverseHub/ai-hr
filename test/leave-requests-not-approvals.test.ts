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

  it('ENUMERATION: the register over every status lives only here — /approvals loads PENDING only', () => {
    // /leave: the paged, sortable projection over all four statuses.
    expect(leavePage).toContain('listLeaveRequestsPage(session, {');
    expect(leavePage).toContain("const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;");
    expect(leavePage).toContain("t('requestsTitle')");
    // /approvals: pending rows, capped, and it never touches the paged projection.
    expect(approvalsPage).toContain("listLeaveRequests(s, scopeIds, 200, { status: 'pending' })");
    expect(approvalsPage).not.toMatch(/listLeaveRequestsPage/);
  });

  it('ENUMERATION: the every-column filter set (0773bda9 + 8ec63139) lives only here', () => {
    // The fourteen narrowings the reporter asked for, none of which /approvals offers.
    for (const name of [
      "name: 'q'",
      "name: 'company'",
      "name: 'bu'",
      "name: 'dept'",
      "name: 'loc'",
      "name: 'emp'",
      "name: 'duration'",
      "name: 'type'",
      "name: 'status'",
      "name: 'from'",
      "name: 'to'",
      "name: 'appliedFrom'",
      "name: 'appliedTo'",
      "name: 'pendingWith'",
      "name: 'approvedBy'",
    ]) {
      expect(leavePage.includes(name), name).toBe(true);
    }
    expect(leavePage).toContain('<FilterPanel');
    // /approvals narrows by approval CATEGORY and sorts; it has no filter panel and no org narrowing.
    expect(approvalsPage).not.toMatch(/<FilterPanel/);
    expect(approvalsPage).not.toMatch(/FilterChips/);
  });

  it('ENUMERATION: the filtered export lives only here — removing the table would orphan /leave/export', () => {
    expect(leavePage).toContain("const exportHref = (format: 'csv' | 'xlsx') =>");
    expect(leavePage).toContain('/leave/export?');
    // The route is real, and app/leave/page.tsx is its ONLY link in the entire application source. This is
    // r74 Decision 5's finding, re-run: drop the table and the route becomes unreachable.
    expect(() => read('app/leave/export/route.ts')).not.toThrow();
    const linkers = sourceFiles().filter((f) => read(f).includes('/leave/export'));
    expect(linkers).toEqual(['app/leave/page.tsx']);
    // /approvals exports nothing.
    expect(approvalsPage).not.toMatch(/exportHref/);
  });

  it('ENUMERATION: admin cancel-on-behalf (22e68ff0) is not an approval and is not on /approvals', () => {
    expect(leavePage).toContain('<AdminCancelLeaveDialog');
    expect(leavePage).toContain('submitAction={adminCancelLeaveAction}');
    // Cancelling an already-APPROVED leave is not a decision on a pending item, so the approvals inbox has
    // no such control — its only leave-cancellation flow decides an employee's give-back REQUEST.
    expect(approvalsPage).not.toMatch(/<AdminCancelLeaveDialog/);
    expect(approvalsPage).toContain('decideLeaveCancellationAction');
  });

  it('ENUMERATION: own-row edit / withdraw / give-back are not on /approvals — it self-bans own rows', () => {
    for (const own of ['<EditLeaveDialog', '<CancelLeaveDialog', '<CancelDatesDialog']) {
      expect(leavePage.includes(own), own).toBe(true);
    }
    // The mine() self-ban: on /approvals the viewer's OWN row shows a label, never a control. So for an HR
    // admin — whose self-service blocks on /leave are suppressed by `ess` (8ec63139) — the Requests table
    // is the only place their own pending request can be edited.
    expect(approvalsPage).toContain('const mine = (personId: string | null) => s.personId != null && personId === s.personId;');
    expect(approvalsPage).toContain('{mine(r.personId) ? (');
    expect(approvalsPage).not.toMatch(/<EditLeaveDialog/);
    expect(leavePage).toContain('const ess = !admin;');
  });

  it('ENUMERATION: the per-employee record screen is a PER-EMPLOYEE alternative, not a replacement', () => {
    // /leave/employee-records answers "this ONE employee's history".
    expect(recordsPage).toContain('employmentIds: [selected.employmentId]');
    // fe3eb141 MOVED the admin cancel-on-behalf action there, as the reporter asked — so this is now
    // the ONE dialog the records page legitimately carries.
    expect(recordsPage).toContain('<AdminCancelLeaveDialog');
    // The other three remain absent, and that is precisely why the Requests subsection cannot be
    // deleted: they are SUBJECT-ONLY controls, and an admin on the records page is never the subject.
    // For an HR admin (whose ESS blocks on /leave are suppressed by `ess`, 8ec63139) the Requests
    // table is still the only place their OWN pending leave can be edited, withdrawn or partly given
    // back. See test/leave-records-cancel.test.ts for the full hold-back enumeration.
    for (const absent of ['<EditLeaveDialog', '<CancelLeaveDialog', '<CancelDatesDialog']) {
      expect(recordsPage.includes(absent), absent).toBe(false);
    }
  });

  it('the subsection is still mounted, behind the same admin gate as before', () => {
    // Nothing about who sees it changed: the inquiry surface is admin-only, and the table sits inside it.
    expect(leavePage).toContain('{admin && (');
    expect(leavePage).toContain('<LeaveInquiryNav active="details"');
    expect(leavePage).toContain('<Pager hrefFor={pagerHref}');
    // And the reason is recorded where the next reader of this page will meet it.
    expect(leavePage).toContain('KEPT AGAIN in r80');
  });
});
