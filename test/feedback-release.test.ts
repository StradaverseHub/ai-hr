/** Execute the actual operator SQL on disposable Postgres; the transport never contacts a host. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { feedbackBoardCounts, getFeedback, listFeedback, setFeedbackPlan, approveFeedbackPlan, submitFeedback, refuteDeployment } from '../core/feedback';
import { recordFeedbackRelease } from '../scripts/improve/remote';
import { feedbackRequest, domainEvent, appUser, roleAssignment } from '../db/schema';
import { feedbackBoardStatus } from '../lib/feedback-release';
const transport = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: transport.run }));
let base: Base;
beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => { await resetDb(); base = await seedBase(); transport.run.mockReset(); });
const sha = 'a'.repeat(40);
async function item() {
  const { id } = await submitFeedback(adminCtx(base), { category: 'enhancement', title: 'Fictional release progress', description: 'Fixture only.' });
  await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Add release progress.' });
  await approveFeedbackPlan(adminCtx(base), { feedbackId: id });
  return { id, tenantId: base.tenantId, reporterEmploymentId: null, sourceSha: sha, buildId: 'fixture-build', buildRef: 'fixture-pr', evidence: "release-record/'safe'/$fb$" };
}
async function record(p: Parameters<typeof recordFeedbackRelease>[0]) {
  transport.run.mockClear(); transport.run.mockReturnValue(''); recordFeedbackRelease(p);
  const text = transport.run.mock.calls[0][2].input;
  const connection = await owner.client.reserve();
  try { await connection.unsafe(text).simple(); } catch (error) { await connection.unsafe('ROLLBACK').simple(); throw error; } finally { connection.release(); }
}
describe('feedback release evidence', () => {
  it('applies the real additive migration to populated pre-release Feedback tables without changing rows or RLS', async () => {
    const first = await item(); await item(); await item();
    const rollback = new Error('rollback-only-feedback-upgrade-proof');
    let observed = false;
    try {
      await owner.db.transaction(async tx => {
        // Reconstruct only this candidate's new column; every baseline table, policy and grant remains real.
        await tx.execute(sql`ALTER TABLE feedback_request DROP COLUMN release`);
        await tx.execute(sql`UPDATE feedback_request SET status='deployed' WHERE id=${first.id}`);
        const before = Array.from(await tx.execute(sql`SELECT to_jsonb(f) AS row FROM feedback_request f ORDER BY id`));
        const security = Array.from(await tx.execute(sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='feedback_request'::regclass`));
        expect(before).toHaveLength(3);
        await tx.execute(sql.raw(readFileSync('db/migrations/0728_feedback_release_evidence.sql', 'utf8')));
        const after = Array.from(await tx.execute(sql`SELECT to_jsonb(f)-'release' AS row FROM feedback_request f ORDER BY id`));
        expect(after).toEqual(before);
        expect(Array.from(await tx.execute(sql`SELECT release FROM feedback_request ORDER BY id`))).toEqual([{ release: null }, { release: null }, { release: null }]);
        expect(Array.from(await tx.execute(sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='feedback_request'::regclass`))).toEqual(security);
        observed = true; throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    expect(observed).toBe(true);
    expect((await getFeedback(adminCtx(base), first.id))?.release).toBeNull();
  });

  it('requires staging → ready → production for the same exact build, records audit and filters/counts by that milestone', async () => {
    const p = await item();
    await expect(record({ ...p, stage: 'production' })).rejects.toThrow();
    await record({ ...p, stage: 'staging' });
    await expect(record({ ...p, stage: 'production_ready', buildId: 'other' })).rejects.toThrow();
    expect(await listFeedback(adminCtx(base), { status: 'production_ready' })).toEqual([]);
    await record({ ...p, stage: 'production_ready' });
    await record({ ...p, stage: 'production' });
    const rows = await listFeedback(adminCtx(base), { status: 'production' });
    expect(rows.map(r => r.id)).toEqual([p.id]); expect(feedbackBoardStatus(rows[0])).toBe('production');
    expect(await feedbackBoardCounts(adminCtx(base))).toEqual([{ status: 'production', count: 1 }]);
    await record({ ...p, stage: 'production' }); // uncertain transport retry is idempotent
    const audits = await owner.db.select().from(domainEvent).where(and(eq(domainEvent.aggregateId, p.id), eq(domainEvent.eventType, 'feedback.release.recorded')));
    expect(audits).toHaveLength(3);
    expect((await getFeedback(adminCtx(base), p.id))?.release).toMatchObject({ stage: 'production', sourceSha: sha, buildId: p.buildId });
    await expect(record({ ...p, stage: 'staging' })).rejects.toThrow();
    const foreign = await seedBase();
    expect(await listFeedback(adminCtx(foreign), { status: 'production' })).toEqual([]);
    await expect(record({ ...p, tenantId: foreign.tenantId, stage: 'staging' })).rejects.toThrow();
  });
  it('keeps legacy deployments uncertain and invalidates evidence for a reopened/replanned cycle', async () => {
    const p = await item(); await record({ ...p, stage: 'staging' });
    await refuteDeployment(adminCtx(base), { feedbackId: p.id, reason: 'Needs another round.' });
    expect((await listFeedback(adminCtx(base)))[0].status).toBe('contested');
    await setFeedbackPlan(adminCtx(base), { feedbackId: p.id, plan: 'New round.' });
    await approveFeedbackPlan(adminCtx(base), { feedbackId: p.id });
    await expect(record({ ...p, stage: 'production_ready' })).rejects.toThrow();
    // Simulate an old deployment writer after a new plan; old JSON must never certify this cycle.
    await owner.db.update(feedbackRequest).set({ status: 'deployed' }).where(eq(feedbackRequest.id, p.id));
    expect((await feedbackBoardCounts(adminCtx(base)))).toEqual([{ status: 'deployed', count: 1 }]);
    const rows = await listFeedback(adminCtx(base), { status: 'deployed' });
    expect(feedbackBoardStatus(rows[0])).toBe('deployed');
    expect(await listFeedback(adminCtx(base), { status: 'staging' })).toEqual([]);
  });
  it('shows release facts to the user-only reporter under Feedback RLS, without widening other account access', async () => {
    const [user] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: 'fictional-release-reporter', personId: null }).returning({ id: appUser.id });
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: user.id, role: 'employee', companyId: null });
    const ctx = { ...adminCtx(base), userId: user.id, roles: ['employee'] as const, grants: [{ role: 'employee' as const, companyId: null }] };
    const reporter = { ...ctx, roles: [...ctx.roles] };
    const { id } = await submitFeedback(reporter, { category: 'issue', title: 'Account-only release fixture', description: 'Fictional.' });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Fix it.' });
    await approveFeedbackPlan(reporter, { feedbackId: id });
    await record({ id, tenantId: base.tenantId, reporterEmploymentId: null, stage: 'staging', sourceSha: sha, buildId: 'fixture', buildRef: 'fixture', evidence: 'fixture' });
    expect((await getFeedback(reporter, id))?.release?.stage).toBe('staging');
    expect((await feedbackBoardCounts(reporter))).toEqual([{ status: 'staging', count: 1 }]);
  });
  it('validates evidence before invoking SSH and refuses a wrong reporter binding atomically', async () => {
    const p = await item();
    expect(() => recordFeedbackRelease({ ...p, stage: 'staging', evidence: '' })).toThrow();
    expect(transport.run).not.toHaveBeenCalled();
    await expect(record({ ...p, stage: 'staging', reporterEmploymentId: '00000000-0000-0000-0000-000000000001' })).rejects.toThrow();
    expect((await getFeedback(adminCtx(base), p.id))?.status).toBe('approved');
    expect((await getFeedback(adminCtx(base), p.id))?.release).toBeNull();
  });
});
