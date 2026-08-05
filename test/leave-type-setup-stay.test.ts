/**
 * Stay on the current Leave Type configuration page after ANY save (#4e9a4d59) — NOW FULLY HISTORICAL.
 *
 * The reported enhancement: every Save inside the Leave Type setup flow (General / Condition /
 * Entitlement / Custom Setting and the secondary steps) must leave HR exactly where they were. Most of
 * that shipped with b9dac2d1 (create/update type) and 9b0503ac (the entitlement-area saves, asserted by
 * test/entitlement-save-stay.test.ts). Two corners bounced HR off the workspace, and BOTH have since had
 * their surface removed rather than fixed:
 *
 *   A. the Grade catalog — retired by b1b81a08, which moved grade master data out of Leave Config into
 *      Settings → System Labels → Organisation Labels. Guarded now by
 *      test/grade-system-label-relocation.test.ts.
 *   B. the embedded Approval Workflow matrix — retired by e4238594, which deleted the leave-type
 *      workspace's Approval Workflow sub-step as a duplicate of the Approval Workflow tab. Its two
 *      stay-on-this-type wrappers went with it.
 *
 * 706d34e8 (r155) then removed the LAST caller on the other side of B: the Approval Workflow tab's own
 * per-rule matrix. With no screen posting them, the standalone `saveLeaveApprovalRuleAction` /
 * `archiveLeaveApprovalRuleAction` retired too — a server action with no screen is still an addressable
 * write path into `leave_approval_policy`, which is the silent-configuration problem 241817ef exists to
 * end. So there is no longer a redirect target on this path to assert, in either direction.
 *
 * WHAT THIS FILE IS FOR NOW. It is the runtime (as opposed to source-text) guard that none of those four
 * server actions is exported any more. That distinction is the point: the source-text assertions live in
 * test/leave-approval-page-restructure.test.ts and test/leave-type-general-substeps.test.ts, and a
 * re-export or a barrel would satisfy those while still handing Next.js an action to register. Importing
 * the module and reading its exported keys cannot be fooled that way.
 *
 * It no longer needs the database (the previous version seeded a tenant only to drive the removed
 * actions' redirects), so it is deliberately DB-free and fast.
 */
import { describe, expect, it } from 'vitest';

/** Every per-rule approval writer that has been retired here, with the item that retired it. */
const RETIRED_ACTIONS: readonly [string, string][] = [
  ['saveLeaveApprovalRuleFromEntitlementsAction', 'e4238594 — the workspace sub-step wrapper'],
  ['archiveLeaveApprovalRuleFromEntitlementsAction', 'e4238594 — the workspace sub-step wrapper'],
  ['saveLeaveApprovalRuleAction', '706d34e8 — the Approval Workflows matrix, its only caller'],
  ['archiveLeaveApprovalRuleAction', '706d34e8 — the Approval Workflows matrix, its only caller'],
];

/** The writers that MUST survive: the approval screen still configures templates, assignments, escalation. */
const LIVE_ACTIONS: readonly string[] = [
  'saveLeaveEscalationPolicyAction',
  'saveApprovalTemplateAction',
  'duplicateApprovalTemplateAction',
  'setApprovalTemplateActiveAction',
  'deleteApprovalTemplateAction',
  'setTenantDefaultTemplateAction',
  'assignApprovalTemplateAction',
  'unassignApprovalTemplateAction',
];

describe('the per-rule approval writers retired WITH their screens (4e9a4d59 → e4238594 → 706d34e8)', () => {
  it('none of the retired actions is exported', async () => {
    const mod = await import('../app/admin/leave-approval/actions');
    const exported = new Set(Object.keys(mod));
    for (const [name, why] of RETIRED_ACTIONS) {
      expect(exported.has(name), `${name} must stay retired (${why})`).toBe(false);
    }
  });

  it('the actions the surviving sections post are all still exported', async () => {
    // Asserted positively so a cleanup that overshoots — taking the template or assignment writers with
    // the rule writers — fails here instead of silently making the screen read-only.
    const mod = await import('../app/admin/leave-approval/actions');
    const exported = new Set(Object.keys(mod));
    for (const name of LIVE_ACTIONS) {
      expect(exported.has(name), `${name} must survive`).toBe(true);
    }
  });

  it('the DOMAIN operations behind the retired actions are NOT retired', async () => {
    // Removing a screen is not removing a service. resolveApprovalChain routes on these rows and
    // core/leave-approval-consolidation.ts rewrites them; test/leave-approval-rule-matrix.test.ts drives
    // the core functions directly. Deleting them along with their UI is the mistake this pins against.
    const core = await import('../core/leave-approval-policy');
    for (const fn of [
      'createLeaveApprovalRule',
      'updateLeaveApprovalRule',
      'archiveLeaveApprovalRule',
      'listLeaveApprovalRules',
      'isCompanyDefaultApprovalRule',
      'resolveApprovalChain',
    ]) {
      expect(typeof (core as Record<string, unknown>)[fn], `core must keep ${fn}`).toBe('function');
    }
  });
});
