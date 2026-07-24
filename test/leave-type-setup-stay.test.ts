/**
 * Stay on the current Leave Type configuration page after ANY save (#4e9a4d59).
 *
 * The reported enhancement: every Save inside the Leave Type setup flow (General / Condition /
 * Entitlement / Custom Setting and the secondary steps) must leave HR exactly where they were. Most of
 * that shipped with b9dac2d1 (create/update type) and 9b0503ac (the entitlement-area saves, asserted by
 * test/entitlement-save-stay.test.ts). Two corners still bounced HR off the workspace:
 *
 *   A. the Grade catalog (Panel A of the Entitlement step) — its four saves redirected to /admin/leave;
 *   B. the embedded Approval Workflow matrix — its save/delete redirected to /admin/leave/approval.
 *
 * Both now return through the SAME okEntitlements contract the entitlement saves use (app/admin/
 * _redirects.ts): /admin/leave/entitlements?toast=…#type-<id> — the ?toast= the globally mounted
 * ToastFromQuery renders, plus the #type-<id> anchor LeaveTypeWorkspace's hash effect uses to re-select
 * the type. Failures stay on the Entitlements page too (?error=, no fragment — a fragment before the
 * query would swallow it, the b9dac2d1 precedent).
 *
 * Grades are TENANT-GLOBAL master data (no leaveTypeId column), so the posted leaveTypeId is a UI-return
 * hint the client stamps from the live hash; when absent the redirect degrades to the bare route.
 *
 * These assertions are on the redirect STRING. The client-side hash read (GradeCatalog's submit-time
 * stamp) and the on-screen "same type + same tab" outcome are covered by the browser smoke.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// redirect() in real Next.js THROWS to abort the request; the mock must throw too, or execution would
// fall through. The sentinel carries the target path so tests assert the redirect TARGET.
let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
const redirectSpy = vi.fn((path: string): never => {
  throw new RedirectError(path);
});
const revalidateSpy = vi.fn((_path: string) => undefined);
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
// requireAdmin() (Clerk/session) is unavailable in the harness — return the seeded admin ctx.
vi.mock('../lib/authz', () => ({ requireAdmin: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectSpy(p), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidateSpy(p), revalidateTag: vi.fn(() => undefined) }));
// The actions localise toasts before redirecting; the key-echoing fake keeps the URL assertable.
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import { randomUUID } from 'node:crypto';
import { createJobGrade } from '../core/admin';
import { createLeaveApprovalRule } from '../core/leave-approval-policy';
import {
  archiveJobGradeAction,
  createJobGradeAction,
  deleteJobGradeAction,
  updateJobGradeAction,
} from '../app/admin/actions';
import {
  archiveLeaveApprovalRuleAction,
  archiveLeaveApprovalRuleFromEntitlementsAction,
  saveLeaveApprovalRuleAction,
  saveLeaveApprovalRuleFromEntitlementsAction,
} from '../app/admin/leave-approval/actions';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ENTITLEMENTS = '/admin/leave/entitlements';
const APPROVAL = '/admin/leave/approval';
const LEAVE = '/admin/leave';

/** Run a server action that ends in redirect() (throws RedirectError here) and return the target path. */
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** A unique grade code/name pair — the catalog enforces partial-unique indexes on both. */
const uniqueGrade = () => {
  const n = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return { code: `G${n}`, name: `Grade ${n}` };
};

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = adminCtx(b);
  redirectSpy.mockClear();
  revalidateSpy.mockClear();
});

describe('4e9a4d59 — Grade catalog saves stay on the leave type being configured', () => {
  it('createJobGradeAction anchors back to the open type instead of bouncing to /admin/leave', async () => {
    const g = uniqueGrade();
    const target = await captureRedirect(() =>
      createJobGradeAction(fd({ code: g.code, name: g.name, rank: '3', leaveTypeId: b.annualLeaveTypeId })),
    );
    // The old bug: ok(LEAVE) — a different route, throwing HR out of the setup flow.
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).toContain('savedToast');
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
    expect(target.startsWith(`${LEAVE}?`)).toBe(false);
    expect(revalidateSpy).toHaveBeenCalledWith(ENTITLEMENTS);
  });

  it('updateJobGradeAction (inline row edit) stays on the same type', async () => {
    const g = uniqueGrade();
    const created = await createJobGrade(adminCtx(b), { code: g.code, name: g.name, rank: 1 });
    const renamed = uniqueGrade();
    const target = await captureRedirect(() =>
      updateJobGradeAction(
        fd({
          id: created.id,
          code: renamed.code,
          name: renamed.name,
          rank: '2',
          leaveTypeId: b.annualLeaveTypeId,
        }),
      ),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).toContain('savedToast');
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
  });

  it('archiveJobGradeAction stays on the same type', async () => {
    const g = uniqueGrade();
    const created = await createJobGrade(adminCtx(b), { code: g.code, name: g.name, rank: 1 });
    const target = await captureRedirect(() =>
      archiveJobGradeAction(fd({ id: created.id, archived: 'true', leaveTypeId: b.annualLeaveTypeId })),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
  });

  it('deleteJobGradeAction stays on the same type', async () => {
    const g = uniqueGrade();
    const created = await createJobGrade(adminCtx(b), { code: g.code, name: g.name, rank: 1 });
    const target = await captureRedirect(() =>
      deleteJobGradeAction(fd({ id: created.id, leaveTypeId: b.annualLeaveTypeId })),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
  });

  it('without the leaveTypeId hint the redirect degrades to the bare Entitlements route (no #type)', async () => {
    const g = uniqueGrade();
    const target = await captureRedirect(() =>
      createJobGradeAction(fd({ code: g.code, name: g.name, rank: '0' })),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).not.toContain('#type-');
    // Still the workspace route — never /admin/leave.
    expect(target.startsWith(ENTITLEMENTS)).toBe(true);
  });

  it('a failed grade save stays on the Entitlements page (?error=, no fragment)', async () => {
    const target = await captureRedirect(() =>
      // "1BAD" fails the grade-code shape rule, so createJobGrade throws.
      createJobGradeAction(fd({ code: '1BAD', name: 'Nope', rank: '0', leaveTypeId: b.annualLeaveTypeId })),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?error=`)).toBe(true);
    expect(target).not.toContain('#type-'); // a fragment before ?error= would swallow the query
  });

  it('a failed grade delete also stays on the Entitlements page', async () => {
    const target = await captureRedirect(() =>
      deleteJobGradeAction(fd({ id: randomUUID(), leaveTypeId: b.annualLeaveTypeId })),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?error=`)).toBe(true);
  });
});

describe('4e9a4d59 — Approval Workflow saves posted from the leave type workspace stay on that type', () => {
  it('saveLeaveApprovalRuleFromEntitlementsAction anchors back to the rule’s leave type', async () => {
    const target = await captureRedirect(() =>
      saveLeaveApprovalRuleFromEntitlementsAction(
        fd({
          companyId: b.companyId,
          leaveTypeId: b.annualLeaveTypeId,
          ruleName: 'Workspace rule',
          levels: 'direct_manager,hr_admin',
        }),
      ),
    );
    // The old behaviour: /admin/leave/approval — the standalone Approvals screen, off the setup flow.
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).toContain('savedToast'); // localised key, not the standalone action's English literal
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
    expect(target.startsWith(APPROVAL)).toBe(false);
  });

  it('an "applies to all types" rule (no leaveTypeId) degrades to the bare Entitlements route', async () => {
    const target = await captureRedirect(() =>
      saveLeaveApprovalRuleFromEntitlementsAction(
        fd({ companyId: b.companyId, ruleName: 'Any-type rule', levels: 'hr_admin' }),
      ),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).not.toContain('#type-');
  });

  it('a failed rule save stays on the Entitlements page (?error=)', async () => {
    const target = await captureRedirect(() =>
      // No levels and no template ⇒ cleanRuleInput throws.
      saveLeaveApprovalRuleFromEntitlementsAction(
        fd({ companyId: b.companyId, leaveTypeId: b.annualLeaveTypeId, ruleName: 'Bad rule', levels: '' }),
      ),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?error=`)).toBe(true);
    expect(target).not.toContain('#type-');
  });

  it('archiveLeaveApprovalRuleFromEntitlementsAction keeps HR on the type they were viewing', async () => {
    const rule = await createLeaveApprovalRule(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: b.annualLeaveTypeId,
      levels: ['direct_manager'],
    });
    const target = await captureRedirect(() =>
      archiveLeaveApprovalRuleFromEntitlementsAction(
        fd({ companyId: b.companyId, ruleId: rule.id, leaveTypeId: b.annualLeaveTypeId }),
      ),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).toContain('savedToast');
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
  });

  it('a failed rule delete stays on the Entitlements page (?error=)', async () => {
    const target = await captureRedirect(() =>
      archiveLeaveApprovalRuleFromEntitlementsAction(
        fd({ companyId: b.companyId, ruleId: 'not-a-uuid', leaveTypeId: b.annualLeaveTypeId }),
      ),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?error=`)).toBe(true);
    expect(target).not.toContain('#type-');
  });
});

describe('4e9a4d59 — the standalone Approvals screen is untouched (regression guard)', () => {
  it('saveLeaveApprovalRuleAction still lands on /admin/leave/approval', async () => {
    const target = await captureRedirect(() =>
      saveLeaveApprovalRuleAction(
        fd({
          companyId: b.companyId,
          leaveTypeId: b.annualLeaveTypeId,
          ruleName: 'Standalone rule',
          levels: 'direct_manager',
        }),
      ),
    );
    expect(target.startsWith(`${APPROVAL}?toast=`)).toBe(true);
    expect(target).toContain(encodeURIComponent('Rule created'));
    expect(target).not.toContain('#type-');
  });

  it('saveLeaveApprovalRuleAction failures still land on /admin/leave/approval', async () => {
    const target = await captureRedirect(() =>
      saveLeaveApprovalRuleAction(fd({ companyId: b.companyId, ruleName: 'Bad', levels: '' })),
    );
    expect(target.startsWith(`${APPROVAL}?error=`)).toBe(true);
  });

  it('archiveLeaveApprovalRuleAction still lands on /admin/leave/approval', async () => {
    const rule = await createLeaveApprovalRule(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: b.annualLeaveTypeId,
      levels: ['direct_manager'],
    });
    const target = await captureRedirect(() =>
      // The matrix row now also posts leaveTypeId — the standalone action must keep ignoring it.
      archiveLeaveApprovalRuleAction(
        fd({ companyId: b.companyId, ruleId: rule.id, leaveTypeId: b.annualLeaveTypeId }),
      ),
    );
    expect(target).toBe(`${APPROVAL}?toast=${encodeURIComponent('Rule deleted')}`);
  });

  it('archiveLeaveApprovalRuleAction failures still land on /admin/leave/approval', async () => {
    const target = await captureRedirect(() =>
      archiveLeaveApprovalRuleAction(fd({ companyId: b.companyId, ruleId: 'not-a-uuid' })),
    );
    expect(target.startsWith(`${APPROVAL}?error=`)).toBe(true);
  });
});
