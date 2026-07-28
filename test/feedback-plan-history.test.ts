/**
 * feedback_plan_revision — the negotiation between reporter and agent, kept (0318).
 *
 * WHAT WAS BROKEN. `feedback_request` holds ONE `plan` and ONE `contest_reason`, and both were
 * overwritten on every re-plan. The events recorded `{revision, model}` and `{revision, decidedBy}` —
 * never the plan text, never the reporter's words. So an item that went several rounds could not answer
 * the only question that matters when reviewing it: "I asked for X, you proposed Y, I said no — why does
 * the plan now say Z?" On production that was 29 items and roughly 40 vanished plan versions.
 *
 * The load-bearing test is `a re-plan cannot erase the push-back that caused it`. Everything else here
 * describes the shape of the history; that one is the reason the table exists, because the failure it
 * guards against is exactly the failure that destroyed the old history — a write that clears the
 * reporter's words on its way past.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  approveFeedbackPlan,
  contestFeedbackPlan,
  getFeedback,
  markFeedbackDeployed,
  completeFeedbackBuild,
  refuteDeployment,
  setFeedbackPlan,
  startFeedbackBuild,
  submitFeedback,
} from '../core/feedback';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

/**
 * Assert a query failed for the REASON we mean. Drizzle wraps driver errors as "Failed query: …" and
 * hangs the real Postgres error off `.cause`, so matching the outer message would pass on any failure at
 * all — which would make a permissions test pass when permissions are wide open.
 */
async function expectDbError(run: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await run.then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(err, 'the statement should have been refused').not.toBeNull();
  const chain = [err?.message, err?.cause?.message].filter(Boolean).join(' | ');
  expect(chain).toMatch(pattern);
}

const revisions = (feedbackId: string) =>
  owner.db
    .select()
    .from(schema.feedbackPlanRevision)
    .where(eq(schema.feedbackPlanRevision.feedbackRequestId, feedbackId))
    .orderBy(asc(schema.feedbackPlanRevision.revision));

async function reporterOn(): Promise<{ id: string; rctx: SessionContext }> {
  const R = await hireEmployee(adminCtx(base), {
    person: { fullName: 'Reporter', primaryEmail: `r_${randomUUID().slice(0, 6)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  const uid = await createAppUser(base.tenantId, R.personId, 'employee');
  const rctx = { tenantId: base.tenantId, userId: uid, personId: R.personId, roles: ['employee'] } as SessionContext;
  const { id } = await submitFeedback(rctx, {
    reporterEmploymentId: R.employmentId,
    category: 'issue',
    title: 'Leave balance is wrong',
    description: 'It shows 10 when it should show 12.',
  });
  return { id, rctx };
}

describe('feedback plan history (0318)', () => {
  it('THE GUARD: a re-plan cannot erase the push-back that caused it', async () => {
    const { id, rctx } = await reporterOn();

    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'PLAN A: change the accrual rate.' });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'No — the rate is right, the carry-over is wrong.' });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'PLAN B: fix the carry-over instead.' });

    const rows = await revisions(id);
    expect(rows).toHaveLength(2);

    // v1 keeps the reporter's exact objection, even though feedback_request.contest_reason was cleared
    // by the re-plan. This is the whole point: the words survive the write that used to destroy them.
    expect(rows[0].plan).toContain('PLAN A');
    expect(rows[0].outcome).toBe('contested');
    expect(rows[0].outcomeReason).toBe('No — the rate is right, the carry-over is wrong.');

    expect(rows[1].plan).toContain('PLAN B');
    expect(rows[1].outcome).toBeNull(); // the live one

    // …and the item itself no longer carries the reason, which is exactly why the history is needed.
    const d = (await getFeedback(adminCtx(base), id))!;
    expect(d.contestReason).toBeNull();
    expect(d.planHistory.map((r) => r.outcomeReason)).toContain('No — the rate is right, the carry-over is wrong.');
  });

  it('reads back oldest-first, as a timeline', async () => {
    const { id, rctx } = await reporterOn();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v1' });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'not this' });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v2' });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'still not' });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v3' });

    const d = (await getFeedback(adminCtx(base), id))!;
    expect(d.planHistory.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(d.planHistory.map((r) => r.plan)).toEqual(['v1', 'v2', 'v3']);
    expect(d.planHistory.map((r) => r.outcomeReason)).toEqual(['not this', 'still not', null]);
  });

  it('an approval STAMPS the version without ending it', async () => {
    const { id, rctx } = await reporterOn();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'the plan' });
    await approveFeedbackPlan(rctx, { feedbackId: id });

    const [rev] = await revisions(id);
    expect(rev.approvedAt).not.toBeNull();
    // Still LIVE. An approved plan is the one being built, and closing it here is what previously left a
    // post-deploy refute with nowhere to attach — see the refute test below.
    expect(rev.outcome).toBeNull();
    // Approving carries no payload by design, so the history must not pretend the reporter said anything.
    expect(rev.outcomeReason).toBeNull();
  });

  it('a re-plan with no push-back is `superseded`, not `contested`', async () => {
    const { id } = await reporterOn();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'first draft' });

    // NOT reachable through setFeedbackPlan: it refuses unless the item is open or contested, so an
    // in-app second plan always follows a push-back. `superseded` belongs to the OPERATOR path
    // (improve:push-plan, scripts/improve/remote.ts), which writes raw SQL and skips that status check.
    // Exercised here as that path does it, rather than pretending the service can produce it.
    await owner.db.execute(
      sql`UPDATE feedback_plan_revision SET outcome = 'superseded', outcome_at = now()
           WHERE feedback_request_id = ${id}::uuid AND outcome IS NULL`,
    );
    await owner.db.execute(
      sql`INSERT INTO feedback_plan_revision (tenant_id, feedback_request_id, revision, plan)
          VALUES (${base.tenantId}::uuid, ${id}::uuid, 2, 'better draft')`,
    );

    const rows = await revisions(id);
    expect(rows[0].outcome).toBe('superseded');
    expect(rows[0].outcomeReason).toBeNull(); // nobody spoke; do not imply they did
    expect(rows[1].outcome).toBeNull();
  });

  it('a post-deploy refute closes the SHIPPED version and is distinguishable from a plan contest', async () => {
    const { id, rctx } = await reporterOn();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'shipped plan' });
    await approveFeedbackPlan(rctx, { feedbackId: id });
    await startFeedbackBuild(adminCtx(base), { feedbackId: id, buildRef: 'build/rX' });
    await completeFeedbackBuild(adminCtx(base), { feedbackId: id, buildRef: 'build/rX' });
    await markFeedbackDeployed(adminCtx(base), { feedbackId: id, buildRef: 'main@abc' });

    await refuteDeployment(rctx, { feedbackId: id, reason: 'It ships but the total is still wrong.' });

    const [rev] = await revisions(id);
    // BOTH facts survive on the one version: they approved it, we shipped it, then they sent it back.
    // Folding approval into `outcome` used to close the revision at approval time, leaving this
    // refutation with nothing to attach to — the version was already spent.
    expect(rev.approvedAt).not.toBeNull();
    // 'refuted', not 'contested': "you built the wrong thing" and "you shipped it and it missed" are
    // different complaints, and collapsing them would lose which one the reporter actually made.
    expect(rev.outcome).toBe('refuted');
    expect(rev.outcomeReason).toBe('It ships but the total is still wrong.');
  });

  it('the app can append and close, but never delete or rewrite', async () => {
    // The guarantee is APPEND-AND-CLOSE-ONCE, not read-only: the in-app approve/contest actions run as
    // ai_hr_app, so a SELECT-only grant would simply stop the reporter's own decisions from being
    // recorded. What must hold is that nothing already written can be changed or removed.
    const [{ privs }] = (await owner.db.execute(
      sql`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
            FROM information_schema.role_table_grants
           WHERE table_name = 'feedback_plan_revision' AND grantee = 'ai_hr_app'`,
    )) as unknown as { privs: string | null }[];
    expect(privs ?? '').toBe('INSERT,SELECT,UPDATE');
    expect(privs ?? '').not.toContain('DELETE');
  });

  it('TAMPER: a closed revision cannot be re-labelled, blanked, or re-opened', async () => {
    const { id, rctx } = await reporterOn();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v1' });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'the objection' });

    // Closure is one-way: the UPDATE policy's USING clause is `outcome IS NULL`, so a row that already
    // carries an outcome matches no policy and is invisible to any further UPDATE. Attempting to soften
    // the objection therefore changes nothing rather than raising — the row is simply not there to hit.
    await withTenant(adminCtx(base), (tx) =>
      tx.execute(
        sql`UPDATE feedback_plan_revision SET outcome = 'approved', outcome_reason = NULL
             WHERE feedback_request_id = ${id}::uuid`,
      ),
    );
    const [after] = await revisions(id);
    expect(after.outcome).toBe('contested');
    expect(after.outcomeReason).toBe('the objection');
  });

  it('TAMPER: closing a revision cannot rewrite what was proposed', async () => {
    const { id } = await reporterOn();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'the original proposal' });

    // RLS is row-level, so the close policy alone could not stop a plan-text edit riding along with the
    // outcome. The trigger is what freezes it, and it must RAISE rather than silently ignore the change.
    await expectDbError(
      withTenant(adminCtx(base), (tx) =>
        tx.execute(
          sql`UPDATE feedback_plan_revision SET outcome = 'contested', outcome_at = now(), plan = 'rewritten'
               WHERE feedback_request_id = ${id}::uuid`,
        ),
      ),
      /append-only/i,
    );

    const [row] = await revisions(id);
    expect(row.plan).toBe('the original proposal');
  });

  it('TAMPER: history rows cannot be deleted through the app', async () => {
    const { id } = await reporterOn();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v1' });
    await expectDbError(
      withTenant(adminCtx(base), (tx) =>
        tx.execute(sql`DELETE FROM feedback_plan_revision WHERE feedback_request_id = ${id}::uuid`),
      ),
      /permission denied/i,
    );
    expect(await revisions(id)).toHaveLength(1);
  });
});
