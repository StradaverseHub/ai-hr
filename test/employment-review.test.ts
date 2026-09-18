/**
 * Automated Probation / Contract / Internship Review Workflow (0110).
 *
 * Covers: computeReviewWindow math per type; startReview (opens pending_manager, snapshots end/due,
 * resolves admin manager, rejects null end-date, blocks a second open review); authorization (non-manager
 * non-admin can't start/submit; manager can't decide; nobody decides their own — super_admin escape);
 * the state machine; decisions are advisory (no assignment mutation, extend stored on row only, terminate
 * doesn't terminate); deadlocks (no-manager, manager==subject, only-HR-admin-on-probation); event
 * coverage + the explicit negative PII assertion; notifications; pendingApprovalsCount for a manager
 * WITHOUT the platform role; RLS; sweepDueReviews (opens due, idempotent, excludes leavers).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  computeReviewWindow,
  decideReview,
  pendingManagerReviewsFor,
  reviewsFor,
  startReview,
  submitManagerEvaluation,
  sweepDueReviews,
  subtractReviewLead,
  ReviewError,
} from '../core/employment-review';
import { pendingApprovalsCount } from '../core/approvals-inbox';
import { dispatchNotifications } from '../core/notifications';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
  harnessSnapshot,
} from './harness';

let b: Base;

async function hire(name: string, employmentType: 'full_time' | 'contract' | 'intern' | 'part_time' = 'full_time') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType,
    hiredOn: '2026-01-01',
  });
  return e;
}

/** Set an end-date column directly (owner) — bypasses the service so individual tests are concise. */
async function setEnd(employmentId: string, col: 'probationEndDate' | 'contractEndDate' | 'internshipEndDate', date: string | null) {
  await owner.db.update(schema.employment).set({ [col]: date }).where(eq(schema.employment.id, employmentId));
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('computeReviewWindow + subtractReviewLead', () => {
  it('maps each employment type to its end column + due = end − 1 month', () => {
    const emp = { probationEndDate: '2026-04-30', contractEndDate: '2026-06-15', internshipEndDate: '2026-03-31' };
    expect(computeReviewWindow('full_time', emp)).toEqual({ reviewType: 'probation', endDate: '2026-04-30', dueDate: '2026-03-30' });
    expect(computeReviewWindow('contract', emp)).toEqual({ reviewType: 'contract', endDate: '2026-06-15', dueDate: '2026-05-15' });
    expect(computeReviewWindow('intern', emp)).toEqual({ reviewType: 'internship', endDate: '2026-03-31', dueDate: '2026-02-28' });
  });
  it('part_time → no review', () => {
    expect(computeReviewWindow('part_time', { probationEndDate: '2026-04-30', contractEndDate: null, internshipEndDate: null })).toBeNull();
  });
  it('subtractReviewLead clamps to the last day of the target month', () => {
    expect(subtractReviewLead('2026-03-31')).toBe('2026-02-28');
    expect(subtractReviewLead('2026-01-15')).toBe('2025-12-15');
  });
});

describe('startReview', () => {
  it('opens pending_manager, snapshots end/due, resolves the admin manager', async () => {
    const a = adminCtx(b);
    const E = await hire('Subject');
    const M = await hire('Manager');
    await setReportingLine(a, { subordinateEmploymentId: E.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');

    const { reviewId } = await startReview(a, { employmentId: E.employmentId });
    const [row] = await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.id, reviewId));
    expect(row.status).toBe('pending_manager');
    expect(row.reviewType).toBe('probation');
    expect(row.endDate).toBe('2026-04-30');
    expect(row.dueDate).toBe('2026-03-30');
    expect(row.managerEmploymentId).toBe(M.employmentId);
  });

  it('rejects when the relevant end-date is null', async () => {
    const E = await hire('NoDate');
    await expect(startReview(adminCtx(b), { employmentId: E.employmentId })).rejects.toThrow(ReviewError);
  });

  it('blocks a second open review for the same (employment, type)', async () => {
    const E = await hire('Twice');
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');
    await startReview(adminCtx(b), { employmentId: E.employmentId });
    await expect(startReview(adminCtx(b), { employmentId: E.employmentId })).rejects.toThrow(/already/i);
  });
});

describe('authorization', () => {
  it('a non-manager non-admin cannot start, and a manager cannot decide; nobody decides their own', async () => {
    const a = adminCtx(b);
    const E = await hire('Sub');
    const M = await hire('Mgr');
    const X = await hire('Peer');
    await setReportingLine(a, { subordinateEmploymentId: E.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');
    const uM = await createAppUser(b.tenantId, M.personId, 'employee'); // manager WITHOUT the platform role
    const uX = await createAppUser(b.tenantId, X.personId, 'employee');
    const mgrCtx: SessionContext = { tenantId: b.tenantId, userId: uM, personId: M.personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) };
    const peerCtx: SessionContext = { tenantId: b.tenantId, userId: uX, personId: X.personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) };

    // peer cannot start
    await expect(startReview(peerCtx, { employmentId: E.employmentId })).rejects.toThrow();

    const { reviewId } = await startReview(a, { employmentId: E.employmentId });
    // peer cannot submit the manager evaluation; assigned manager can
    await expect(submitManagerEvaluation(peerCtx, { reviewId, recommendation: 'recommend_confirm' })).rejects.toThrow();
    await submitManagerEvaluation(mgrCtx, { reviewId, recommendation: 'recommend_confirm' });
    // a manager cannot decide (stage 2 is admin-only)
    await expect(decideReview(mgrCtx, { reviewId, decision: 'confirm' })).rejects.toThrow();
    // admin decides fine
    await decideReview(a, { reviewId, decision: 'confirm' });
  });

  it('nobody decides their own review — super_admin escape honored', async () => {
    const a = adminCtx(b);
    const HR = await hire('HrPerson');
    await setEnd(HR.employmentId, 'probationEndDate', '2026-04-30');
    const uHr = await createAppUser(b.tenantId, HR.personId, 'hr_admin');
    const hrCtx: SessionContext = { tenantId: b.tenantId, userId: uHr, personId: HR.personId, roles: ['hr_admin'], entitlements: harnessSnapshot(b.tenantId) };
    const { reviewId } = await startReview(a, { employmentId: HR.employmentId });
    // advance to pending_hr (admin submits stage 1 via admin fallback)
    await submitManagerEvaluation(a, { reviewId, recommendation: 'recommend_confirm' });
    // the HR person cannot decide their own
    await expect(decideReview(hrCtx, { reviewId, decision: 'confirm' })).rejects.toThrow(/your own/i);
    // a super_admin can
    const uSuper = await createAppUser(b.tenantId, (await hire('Sup')).personId, 'super_admin');
    const superCtx: SessionContext = { tenantId: b.tenantId, userId: uSuper, roles: ['super_admin'], entitlements: harnessSnapshot(b.tenantId) };
    await decideReview(superCtx, { reviewId, decision: 'confirm' });
  });
});

describe('state machine + advisory decisions', () => {
  it('pending_manager → submit → pending_hr → decide → completed; out-of-order throws', async () => {
    const a = adminCtx(b);
    const E = await hire('Flow');
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');
    const { reviewId } = await startReview(a, { employmentId: E.employmentId });
    // cannot decide before the manager stage
    await expect(decideReview(a, { reviewId, decision: 'confirm' })).rejects.toThrow();
    await submitManagerEvaluation(a, { reviewId, recommendation: 'recommend_confirm' });
    // cannot re-submit
    await expect(submitManagerEvaluation(a, { reviewId, recommendation: 'recommend_extend' })).rejects.toThrow();
    await decideReview(a, { reviewId, decision: 'confirm' });
    const [row] = await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.id, reviewId));
    expect(row.status).toBe('completed');
  });

  it('confirm does NOT mutate the assignment; extend stores extend_to_date only; terminate does not terminate', async () => {
    const a = adminCtx(b);
    // confirm
    const E1 = await hire('Conf');
    await setEnd(E1.employmentId, 'probationEndDate', '2026-04-30');
    const r1 = await startReview(a, { employmentId: E1.employmentId });
    const [asgBefore] = await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, E1.employmentId));
    await submitManagerEvaluation(a, { reviewId: r1.reviewId, recommendation: 'recommend_confirm' });
    await decideReview(a, { reviewId: r1.reviewId, decision: 'confirm' });
    // the live assignment row is UNCHANGED by confirm — decisions are advisory (no new version). R81:
    // there is no stored status left to flip, so this compares the row's identity and dated window instead.
    const asgAfter = await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, E1.employmentId));
    expect(asgAfter).toHaveLength(1);
    expect(asgAfter[0].validFrom).toBe(asgBefore.validFrom);
    expect(asgAfter[0].id).toBe(asgBefore.id);

    // extend
    const E2 = await hire('Ext');
    await setEnd(E2.employmentId, 'probationEndDate', '2026-04-30');
    const r2 = await startReview(a, { employmentId: E2.employmentId });
    await submitManagerEvaluation(a, { reviewId: r2.reviewId, recommendation: 'recommend_extend' });
    await expect(decideReview(a, { reviewId: r2.reviewId, decision: 'extend' })).rejects.toThrow(/extension date/i);
    await decideReview(a, { reviewId: r2.reviewId, decision: 'extend', extendToDate: '2026-07-31' });
    const [rev2] = await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.id, r2.reviewId));
    expect(rev2.extendToDate).toBe('2026-07-31');
    // *_end_date NOT written back
    const [emp2] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, E2.employmentId));
    expect(emp2.probationEndDate).toBe('2026-04-30');

    // terminate (advisory)
    const E3 = await hire('Term');
    await setEnd(E3.employmentId, 'probationEndDate', '2026-04-30');
    const r3 = await startReview(a, { employmentId: E3.employmentId });
    await submitManagerEvaluation(a, { reviewId: r3.reviewId, recommendation: 'recommend_terminate' });
    await decideReview(a, { reviewId: r3.reviewId, decision: 'terminate' });
    const [emp3] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, E3.employmentId));
    expect(emp3.terminatedOn).toBeNull();
  });
});

describe('deadlocks', () => {
  it('a no-manager review advances via the admin fallback', async () => {
    const a = adminCtx(b);
    const E = await hire('Orphan'); // no reporting line
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');
    const { reviewId } = await startReview(a, { employmentId: E.employmentId });
    const [row] = await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.id, reviewId));
    expect(row.managerEmploymentId).toBeNull();
    await submitManagerEvaluation(a, { reviewId, recommendation: 'recommend_confirm' }); // admin fallback
    await decideReview(a, { reviewId, decision: 'confirm' });
  });
});

describe('events + PII', () => {
  it('appends started/manager-evaluated/decided with the right actor and tenantId; recommendation NOT in the manager-evaluated payload', async () => {
    const a = adminCtx(b);
    const E = await hire('Evt');
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');
    const { reviewId } = await startReview(a, { employmentId: E.employmentId });
    await submitManagerEvaluation(a, { reviewId, recommendation: 'recommend_terminate', comments: 'secret' });
    await decideReview(a, { reviewId, decision: 'confirm' });

    const evs = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId, reviewId));
    const byType = new Map(evs.map((e) => [e.eventType, e]));
    expect(byType.has('employment-review.started')).toBe(true);
    expect(byType.has('employment-review.manager-evaluated')).toBe(true);
    expect(byType.has('employment-review.decided')).toBe(true);
    for (const e of evs) {
      expect(e.tenantId).toBe(b.tenantId);
      expect(e.subjectEmploymentId).toBe(E.employmentId);
      expect(e.actorType).toBe('user');
    }
    // Explicit negative PII assertion: the manager recommendation is NOT in the subject-visible payload.
    const mePayload = byType.get('employment-review.manager-evaluated')!.payload as Record<string, unknown>;
    expect(JSON.stringify(mePayload)).not.toContain('recommend_terminate');
    expect(JSON.stringify(mePayload)).not.toContain('secret');
  });

  it('the sweep records a system actor (auto)', async () => {
    const E = await hire('AutoEvt');
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');
    await sweepDueReviews({ tenantId: b.tenantId, roles: ['hr_admin'] }, { today: '2026-04-01' });
    const [rev] = await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.employmentId, E.employmentId));
    expect(rev.autoTriggered).toBe(true);
    const [ev] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, rev.id), eq(schema.domainEvent.eventType, 'employment-review.started')));
    expect(ev.actorType).toBe('system');
  });
});

describe('notifications', () => {
  it('started notifies manager + HR; decided notifies the subject; a no-manager review notifies HR only', async () => {
    // ADR-0077 slice 3: `notifications` is a per-tenant MODULE now, not NOTIFICATIONS_ENABLED. Grant the
    // row, then resolve the session from it.
    //
    // Both halves matter. seedBase's parity set is narrowed by the live env
    // (`legacyEnabledModulesIn(process.env)`), so whether this tenant carries a notifications row depends
    // on whether the machine running the suite happens to have NOTIFICATIONS_ENABLED in .env.local —
    // green here, red in CI. And `adminCtx` derives its snapshot from that same env, so it would report
    // the module OFF exactly where no row was seeded, making `dispatchNotifications` a silent no-op and
    // every assertion below vacuously true (no notification rows ⇒ nothing to contradict them). The
    // setModule + entitledCtx pair removes the environment from the question entirely: the ROW is what
    // turns dispatch on. entitledCtx is a point-in-time read, so it is built AFTER the grant.
    await setModule(b.tenantId, 'notifications', 'active');
    const a = await entitledCtx(b);
    // Need an HR-admin EMPLOYMENT in the same company so hrAdminsForCompany resolves a recipient.
    const HR = await hire('HrAdmin');
    await createAppUser(b.tenantId, HR.personId, 'hr_admin');
    const E = await hire('Subj');
    const M = await hire('TheMgr');
    await setReportingLine(a, { subordinateEmploymentId: E.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');

    const { reviewId } = await startReview(a, { employmentId: E.employmentId });
    await dispatchNotifications(a);
    const startedNotifs = await owner.db.select().from(schema.notification).where(eq(schema.notification.kind, 'review.started'));
    const recipients = new Set(startedNotifs.map((n) => n.recipientEmploymentId));
    expect(recipients.has(M.employmentId)).toBe(true); // manager
    expect(recipients.has(HR.employmentId)).toBe(true); // HR admin

    await submitManagerEvaluation(a, { reviewId, recommendation: 'recommend_confirm' });
    await decideReview(a, { reviewId, decision: 'confirm' });
    await dispatchNotifications(a);
    const decided = await owner.db.select().from(schema.notification).where(eq(schema.notification.kind, 'review.decided'));
    expect(decided.map((n) => n.recipientEmploymentId)).toContain(E.employmentId); // subject

    // a no-manager review notifies HR only
    const E2 = await hire('NoMgr');
    await setEnd(E2.employmentId, 'probationEndDate', '2026-04-30');
    const r2 = await startReview(a, { employmentId: E2.employmentId });
    await dispatchNotifications(a);
    const started2 = await owner.db
      .select()
      .from(schema.notification)
      .where(and(eq(schema.notification.kind, 'review.started'), eq(schema.notification.sourceEventId, (await firstStartedEventId(r2.reviewId)))));
    expect(started2.every((n) => n.recipientEmploymentId === HR.employmentId)).toBe(true);
  });
});

async function firstStartedEventId(reviewId: string): Promise<string> {
  const [ev] = await owner.db
    .select({ id: schema.domainEvent.id })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.aggregateId, reviewId), eq(schema.domainEvent.eventType, 'employment-review.started')));
  return ev.id;
}

describe('pendingApprovalsCount', () => {
  it('a Direct Manager WITHOUT the manager platform role still gets a non-zero count for an assigned review', async () => {
    const a = adminCtx(b);
    const E = await hire('Reportee');
    const M = await hire('LineMgr');
    await setReportingLine(a, { subordinateEmploymentId: E.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');
    await startReview(a, { employmentId: E.employmentId });

    const uM = await createAppUser(b.tenantId, M.personId, 'employee'); // NO manager role
    // r292 — a REAL snapshot: pendingApprovalsCount fans out into the Claims and Attendance queues, which
    // are service-gated now (core/module-gate.ts), and a context with neither a snapshot nor an exemption
    // marker is the state EntitlementsUnresolvedError exists to flag. Taken from adminCtx so it says what a
    // freshly seeded tenant actually holds rather than a hand-written guess.
    const mgrCtx: SessionContext = { tenantId: b.tenantId, userId: uM, personId: M.personId, roles: ['employee'], entitlements: adminCtx(b).entitlements };
    expect(await pendingManagerReviewsFor(mgrCtx, M.employmentId)).toHaveLength(1);
    expect(await pendingApprovalsCount(mgrCtx, undefined, { attendance: true, claims: true, profileChanges: false })).toBeGreaterThanOrEqual(1);
  });
});

describe('RLS', () => {
  it('a foreign employee cannot read another employee’s review', async () => {
    const a = adminCtx(b);
    const E = await hire('Owner');
    const X = await hire('Stranger');
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30');
    const { reviewId } = await startReview(a, { employmentId: E.employmentId });

    const uX = await createAppUser(b.tenantId, X.personId, 'employee');
    const peerCtx: SessionContext = { tenantId: b.tenantId, userId: uX, personId: X.personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) };
    const seen = await withTenant(peerCtx, (tx) => tx.select().from(schema.employmentReview).where(eq(schema.employmentReview.id, reviewId)));
    expect(seen).toHaveLength(0);
    // own + admin see it
    expect(await reviewsFor(a, E.employmentId)).toHaveLength(1);
  });
});

describe('sweepDueReviews', () => {
  it('opens exactly the due ones, is idempotent, and excludes leavers', async () => {
    const a = adminCtx(b);
    const Due = await hire('Due'); // due
    const NotDue = await hire('NotDue'); // far end-date
    const Termed = await hire('Termed'); // terminated
    const Resigning = await hire('Resigning'); // open resignation
    await setEnd(Due.employmentId, 'probationEndDate', '2026-04-30'); // due 2026-03-30
    await setEnd(NotDue.employmentId, 'probationEndDate', '2026-12-31'); // due 2026-11-30
    await setEnd(Termed.employmentId, 'probationEndDate', '2026-04-30');
    await setEnd(Resigning.employmentId, 'probationEndDate', '2026-04-30');
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-03-15' }).where(eq(schema.employment.id, Termed.employmentId));
    await owner.db.insert(schema.resignationRequest).values({ tenantId: b.tenantId, employmentId: Resigning.employmentId, personId: Resigning.personId, lastWorkingDay: '2026-05-01', status: 'pending' });

    const r1 = await sweepDueReviews({ tenantId: b.tenantId, roles: ['hr_admin'] }, { today: '2026-04-01' });
    expect(r1.opened).toBe(1); // only Due
    const allOpen = await owner.db.select().from(schema.employmentReview);
    expect(allOpen.map((r) => r.employmentId)).toEqual([Due.employmentId]);

    // idempotent
    const r2 = await sweepDueReviews({ tenantId: b.tenantId, roles: ['hr_admin'] }, { today: '2026-04-01' });
    expect(r2.opened).toBe(0);
    expect(await owner.db.select().from(schema.employmentReview)).toHaveLength(1);
    // sanity: a, just to keep adminCtx referenced
    expect(a.tenantId).toBe(b.tenantId);
  });

  it('a COMPLETED review is not re-opened on a later sweep (H5)', async () => {
    const a = adminCtx(b);
    const E = await hire('Reviewed');
    await setEnd(E.employmentId, 'probationEndDate', '2026-04-30'); // due 2026-03-30

    // First sweep opens the review.
    const r1 = await sweepDueReviews({ tenantId: b.tenantId, roles: ['hr_admin'] }, { today: '2026-04-01' });
    expect(r1.opened).toBe(1);
    const [rev] = await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.employmentId, E.employmentId));

    // Complete it (manager evaluation → HR decision). The *_end_date is unchanged, so dueDate stays <= today.
    await submitManagerEvaluation(a, { reviewId: rev.id, recommendation: 'recommend_confirm' });
    await decideReview(a, { reviewId: rev.id, decision: 'confirm' });
    const [done] = await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.id, rev.id));
    expect(done.status).toBe('completed');

    // A later sweep must NOT re-open a duplicate review for the same (employment, type) — a completed
    // review blocks just like an open one (v1 has no legitimate re-trigger).
    const r2 = await sweepDueReviews({ tenantId: b.tenantId, roles: ['hr_admin'] }, { today: '2026-05-01' });
    expect(r2.opened).toBe(0);
    expect(await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.employmentId, E.employmentId))).toHaveLength(1);

    // startReviewTx is gated too: a manual re-open after completion is rejected.
    await expect(startReview(a, { employmentId: E.employmentId })).rejects.toThrow(/already/i);
  });
});
