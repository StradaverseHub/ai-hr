/**
 * Performance Phase B — 360 peer feedback (ADR-0022, slice 3). The anonymity contract is the point:
 * the manager invites peers; peers respond to their own request; the SUBJECT never learns who was asked
 * and sees feedback only after release, without attribution. RLS enforces it.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import {
  createCycle,
  declinePeerFeedback,
  myFeedbackRequests,
  openCycle,
  peerFeedbackForReview,
  PerfError,
  releaseCycle,
  requestPeerFeedback,
  submitPeerFeedback,
} from '../core/performance';
import { hireEmployee, setReportingLine } from '../core/org';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base, harnessSnapshot } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('ADR-0022 — 360 peer feedback', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  // E (subject) reports to M (manager+reviewer); X and Y are peers. Returns ctxs + the spawned review.
  async function setup() {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Subject');
    const M = await hire(a, base, 'Manager');
    const X = await hire(a, base, 'PeerX');
    const Y = await hire(a, base, 'PeerY');
    // E, X, Y are all M's reports (teammates) — a 360 invites the subject's peers.
    for (const sub of [E, X, Y]) {
      await setReportingLine(a, { subordinateEmploymentId: sub.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    }
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const uX = await createAppUser(base.tenantId, X.personId, 'employee');
    const uY = await createAppUser(base.tenantId, Y.personId, 'employee');
    const eCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], personId: E.personId, entitlements: harnessSnapshot(base.tenantId) };
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId, entitlements: harnessSnapshot(base.tenantId) };
    const xCtx: SessionContext = { tenantId: base.tenantId, userId: uX, roles: ['employee'], personId: X.personId, entitlements: harnessSnapshot(base.tenantId) };
    const yCtx: SessionContext = { tenantId: base.tenantId, userId: uY, roles: ['employee'], personId: Y.personId, entitlements: harnessSnapshot(base.tenantId) };
    const { cycleId } = await createCycle(a, { name: '2026 Annual', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const [review] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.employmentId, E.employmentId));
    return { a, E, M, X, Y, eCtx, mCtx, xCtx, yCtx, cycleId, reviewId: review.id };
  }

  it('manager invites peers; subject cannot invite; subject self + dups are skipped', async () => {
    const { E, X, Y, mCtx, eCtx, reviewId } = await setup();
    const { created } = await requestPeerFeedback(mCtx, { reviewId, peerEmploymentIds: [X.employmentId, Y.employmentId, E.employmentId, X.employmentId] });
    expect(created).toBe(2); // X + Y; subject + duplicate X skipped
    await expect(requestPeerFeedback(eCtx, { reviewId, peerEmploymentIds: [X.employmentId] })).rejects.toThrow();
    // re-inviting X is idempotent
    expect((await requestPeerFeedback(mCtx, { reviewId, peerEmploymentIds: [X.employmentId] })).created).toBe(0);
  });

  it('the peer sees + submits their own request; the subject never sees the requester list (RLS)', async () => {
    const { E, X, mCtx, eCtx, xCtx, reviewId } = await setup();
    await requestPeerFeedback(mCtx, { reviewId, peerEmploymentIds: [X.employmentId] });
    const reqs = await myFeedbackRequests(xCtx);
    expect(reqs.map((r) => r.subject)).toContain('Subject');
    // The SUBJECT cannot read peer_feedback_request rows at all — they must not learn who was asked.
    const seenBySubject = await withTenant(eCtx, (tx) => tx.select().from(schema.peerFeedbackRequest).where(eq(schema.peerFeedbackRequest.subjectEmploymentId, E.employmentId)));
    expect(seenBySubject).toEqual([]);

    await submitPeerFeedback(xCtx, { requestId: reqs[0].requestId, strengths: 'Great collaborator', improvements: 'Delegate more' });
    expect(await eventTypesFor(base.tenantId, reqs[0].requestId)).toContain('peer-feedback-request.submitted');
  });

  it('manager sees ATTRIBUTED feedback; subject sees it anonymized and only after release', async () => {
    const { X, mCtx, eCtx, xCtx, cycleId, reviewId, a } = await setup();
    await requestPeerFeedback(mCtx, { reviewId, peerEmploymentIds: [X.employmentId] });
    const [req] = await myFeedbackRequests(xCtx);
    await submitPeerFeedback(xCtx, { requestId: req.requestId, strengths: 'Calm under pressure' });

    // Manager: attributed.
    const mgrView = await peerFeedbackForReview(mCtx, reviewId);
    expect(mgrView.canManage).toBe(true);
    expect(mgrView.feedback).toHaveLength(1);
    expect(mgrView.feedback[0]).toMatchObject({ strengths: 'Calm under pressure', peer: 'PeerX' });

    // Subject before release: sees nothing.
    expect((await peerFeedbackForReview(eCtx, reviewId)).feedback).toEqual([]);

    // Subject after release: content, but anonymized (no author).
    await releaseCycle(a, { cycleId });
    const subjView = await peerFeedbackForReview(eCtx, reviewId);
    expect(subjView.feedback).toHaveLength(1);
    expect(subjView.feedback[0]).toMatchObject({ strengths: 'Calm under pressure', peer: null });
  });

  it('a peer declines; another peer cannot submit to a request that is not theirs', async () => {
    const { X, Y, mCtx, xCtx, yCtx, reviewId } = await setup();
    await requestPeerFeedback(mCtx, { reviewId, peerEmploymentIds: [X.employmentId, Y.employmentId] });
    const [xReq] = await myFeedbackRequests(xCtx);
    await declinePeerFeedback(yCtx, { requestId: (await myFeedbackRequests(yCtx))[0].requestId });
    // Y's request is gone from their pending list.
    expect(await myFeedbackRequests(yCtx)).toEqual([]);
    // Y cannot submit against X's request (RLS hides it → not found).
    await expect(submitPeerFeedback(yCtx, { requestId: xReq.requestId })).rejects.toBeInstanceOf(PerfError);
  });
});
