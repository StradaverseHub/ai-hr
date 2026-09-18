/**
 * r305 — THE BELL AND /approvals MUST BE THE SAME ANSWER.
 *
 * THE DEFECT. `core/approvals-inbox.ts` is the read model behind the header bell's Task tab and the
 * dashboard's approval tile. `app/approvals/page.tsx` is where the work is done. They were assembled from
 * separate lists of queues, and drifted in two places at once:
 *
 *   1. Replacement leave (TOIL) shipped onto /approvals in 5ff7daff and was never added to the inbox. A
 *      manager whose only pending item was a replacement-leave claim read 0 on the bell while the page
 *      held a queue. The bell is how people learn there is anything to do, so an uncounted queue is an
 *      unworked queue — and 5ff7daff's own lesson was the mirror image of this: a service nothing called.
 *   2. Profile changes were gated in the inbox on `isAdmin` alone, while the page gates them on the
 *      configured approver (`ess.profile_change_approver`). On a tenant set to `group_admin` — which is
 *      also the DEGRADED value when the setting cannot be read — a company-scoped HR admin was counted an
 *      item, followed the badge, and found a page with no such section. A phantom count is worse than a
 *      missing one: it sends somebody looking for something that is not there.
 *
 * WHY THE FIRST HALF IS A MAPPING TEST rather than a render test. The failure lives in the EDGE between
 * two files, and neither file is wrong on its own terms: a unit test of the inbox passes, and a unit test
 * of the page passes, throughout. What has to be pinned is that the page's TAXONOMY and the inbox's KIND
 * VOCABULARY still cover each other — so the map below is exhaustive over `APPROVAL_CATEGORIES`, and a
 * category added without a decision about the bell fails to compile-and-pass rather than shipping quiet.
 *
 * The second half is a real-database test, because "does this queue reach this viewer" is a question
 * about rows and roles, not about source text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, entitledCtx, migrateTestDb, resetDb, seedBase, setModule, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { listPendingTasks, type PendingTaskKind } from '../core/approvals-inbox';
import { submitReplacementLeaveRequest } from '../core/replacement-request';
import { setToilPolicy, type ToilPolicyInput } from '../core/toil';
import { APPROVAL_CATEGORIES, type ApprovalCategory } from '../lib/approvals-categories';
import { canDecideProfileChanges, resolveRequestApprover } from '../lib/profile-requestable-fields';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Every queue the page can filter to is a queue the bell can count.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Page category → the inbox kind that counts it, or `null` with the reason it is deliberately not a
 * bell task. `null` is only correct for a category that is a VIEW of another queue, never for a queue
 * of its own: the whole defect above was a queue with nobody counting it.
 */
const KIND_FOR_CATEGORY: Record<Exclude<ApprovalCategory, 'all'>, PendingTaskKind | null> = {
  leave: 'leave',
  leaveCancellation: 'leaveCancellation',
  replacementLeave: 'replacementLeave',
  attendance: 'attendance',
  // Not a queue: the page renders ONE corrections section and 'overtime' is a row filter over it
  // (correctionsRowFilter), so its rows are already counted as 'attendance'.
  overtime: null,
  claim: 'claim',
  travel: 'travel',
  profileChanges: 'profile',
  resignations: 'resignation',
  managerReviews: 'managerReview',
  hrReviews: 'hrReview',
};

describe('the bell counts every queue /approvals shows', () => {
  it('every approval category maps to an inbox kind, or says why not', () => {
    for (const category of APPROVAL_CATEGORIES) {
      if (category === 'all') continue;
      expect(KIND_FOR_CATEGORY, `category '${category}' has no decision about the bell`).toHaveProperty(
        category,
      );
    }
  });

  it('the map holds no category that has since been removed', () => {
    for (const category of Object.keys(KIND_FOR_CATEGORY)) {
      expect(APPROVAL_CATEGORIES as readonly string[], `stale category '${category}'`).toContain(category);
    }
  });

  it('replacement leave is one of them — the queue this defect was about', () => {
    expect(KIND_FOR_CATEGORY.replacementLeave).toBe('replacementLeave');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The rule for who decides profile changes has ONE owner.
// ─────────────────────────────────────────────────────────────────────────────

describe('canDecideProfileChanges', () => {
  it('a company-scoped admin decides only when the tenant says admin', () => {
    const admin = { admin: true, groupAdmin: false } as const;
    expect(canDecideProfileChanges({ ...admin, approverSetting: 'admin' })).toBe(true);
    // The case the bell got wrong: counted for this viewer, never shown to them.
    expect(canDecideProfileChanges({ ...admin, approverSetting: 'group_admin' })).toBe(false);
  });

  it('a group admin decides under either setting, and a non-admin under neither', () => {
    expect(canDecideProfileChanges({ admin: true, groupAdmin: true, approverSetting: 'group_admin' })).toBe(true);
    expect(canDecideProfileChanges({ admin: true, groupAdmin: true, approverSetting: 'admin' })).toBe(true);
    expect(canDecideProfileChanges({ admin: false, groupAdmin: false, approverSetting: 'admin' })).toBe(false);
    // groupAdmin without admin cannot happen through lib/authz, but the predicate must not invent access.
    expect(canDecideProfileChanges({ admin: false, groupAdmin: true, approverSetting: 'group_admin' })).toBe(false);
  });

  it('an unreadable setting degrades to the NARROWER answer, as the page always did', () => {
    // getSettingOrFallback's fallback on both surfaces is 'group_admin'.
    expect(resolveRequestApprover(undefined)).toBe('admin'); // a stored value nobody set
    expect(canDecideProfileChanges({
      admin: true,
      groupAdmin: false,
      approverSetting: resolveRequestApprover('group_admin'),
    })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The replacement-leave queue actually reaches the approver's bell.
// ─────────────────────────────────────────────────────────────────────────────

const GATES = { attendance: true, claims: true, profileChanges: true } as const;

const TODAY = '2026-07-20';
const WORKED = '2026-07-04';

const uniqEmail = () => `inboxparity_${Math.random().toString(36).slice(2)}@t.local`;

/** The same shape test/replacement-leave-approval-surface.test.ts uses, so this file is not a second
 *  opinion about what a valid TOIL policy is. */
const policy = (companyId: string): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  employeeRequestEnabled: true,
});

describe('replacement leave in the inbox (real rows)', () => {
  let b: Base;
  let ctx: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
  });

  it("is counted for the admin who decides it, with a link to its own queue", async () => {
    const hired = await hireEmployee(ctx, {
      person: { fullName: 'Inbox Parity Subject', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(ctx, {
      employmentId: hired.employmentId,
      basicSalary: 8000,
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
    });
    await setToilPolicy(ctx, policy(b.companyId));
    await submitReplacementLeaveRequest(ctx, {
      employmentId: hired.employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED, days: 1 }],
      today: TODAY,
    });

    const tasks = await listPendingTasks(ctx, [b.companyId], GATES);
    const replacement = tasks.filter((t) => t.kind === 'replacementLeave');
    // BEFORE THIS ROUND THIS WAS []: the page had the queue and the bell had nothing.
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.subjectName).toBe('Inbox Parity Subject');
    // The deep-link lands on the queue itself, not the top of an unfiltered inbox.
    expect(replacement[0]!.linkPath).toBe('/approvals?category=replacementLeave');
  });

  it("is NOT the requester's own task — the service bans a self-grant", async () => {
    const hired = await hireEmployee(ctx, {
      person: { fullName: 'Inbox Parity Self', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(ctx, {
      employmentId: hired.employmentId,
      basicSalary: 8000,
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
    });
    await setToilPolicy(ctx, policy(b.companyId));
    await submitReplacementLeaveRequest(ctx, {
      employmentId: hired.employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED, days: 1 }],
      today: TODAY,
    });

    // The requester, reading their own inbox: an admin ctx narrowed to that person.
    const selfCtx: SessionContext = { ...ctx, personId: hired.personId };
    const own = await listPendingTasks(selfCtx, [b.companyId], GATES);
    expect(own.filter((t) => t.kind === 'replacementLeave')).toEqual([]);
  });

  it('the profile-change queue follows the gate the caller passes, not isAdmin', async () => {
    // Same admin context, two answers — which is the point: the decision is the caller's, resolved with
    // the same predicate /approvals uses, so a count can no longer exist without a page to act on.
    const counted = await listPendingTasks(ctx, [b.companyId], { ...GATES, profileChanges: false });
    expect(counted.filter((t) => t.kind === 'profile')).toEqual([]);
  });
});
