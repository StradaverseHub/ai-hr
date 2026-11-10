/**
 * The two replacement-leave sweeps as background jobs (core/toil-sweep-worker.ts) leave EXACTLY what the old
 * single-transaction sweeps left, on a populated fixture (test/toil-sweep-fixture.ts): four companies including an
 * anniversary leave-cycle one, credits that lapse, convert to pay for First-Schedule and other employees, carry
 * forward or not, partly taken, self-declared, fully used, and not yet due. Each arm runs in a fresh database built
 * by the same fixture: accruals, ledger, payroll inputs, leave types, domain events (type, actor, payload, order) and
 * the reported results are compared with ids mapped to names.
 */
import {appendFileSync} from 'node:fs';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {closeReplacementLeaveYear, runToilExpiry} from '../core/toil';
import {createReplacementYearCloseJob, createToilExpiryJob, readToilSweepJob} from '../core/toil-sweep-job';
import {toilExpiryJobHandler, toilYearCloseJobHandler} from '../core/toil-sweep-worker';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {LEAVE_COHORT_BATCH_EMPLOYEES} from '../core/leave-cohort-run';
import {adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';
import {AS_OF, EMPLOYEES, TODAY, sweepEventOrder, sweepFixture, sweepSnapshot} from './toil-sweep-fixture';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);

const tick = () => runBulkJobTick(owner.client, {handlers: [toilExpiryJobHandler, toilYearCloseJobHandler]});
async function runJob(id: string) {
  for (let i = 0; i < 2000; i++) {
    const [row] = await owner.client<{state: string; notified: boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
    if (['completed', 'failed', 'cancelled'].includes(row.state) && row.notified) return row.state;
    if (!await tick()) await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}
const jobRow = async (id: string) => (await owner.client<{steps_total: number; counters: Record<string, number>; metrics: Record<string, number>}[]>`select steps_total,counters,metrics from bulk_job where id=${id}::uuid`)[0];

describe('the replacement-leave sweeps in batches leave exactly what the single-transaction sweeps left', () => {
  it('Process expirations, then Close the replacement-leave year', async () => {
    // Arm A: the synchronous sweeps.
    await sweepFixture(b);
    const before = (await sweepSnapshot(b)).state;
    const syncExpiry = await runToilExpiry(adminCtx(b), {today: TODAY});
    const syncClose = await closeReplacementLeaveYear(adminCtx(b), {asOf: AS_OF});
    const {state: sync} = await sweepSnapshot(b);
    const syncOrder = await sweepEventOrder(b, TODAY);
    // Arm B: the background jobs, in a fresh database built the same way.
    await resetDb(); b = await seedBase(); await sweepFixture(b);
    const expiry = await createToilExpiryJob(adminCtx(b), {today: TODAY});
    expect(expiry.state).toBe('queued');
    expect(await runJob(expiry.id)).toBe('completed');
    const expiryDone = await readToilSweepJob(adminCtx(b), expiry.id);
    const close = await createReplacementYearCloseJob(adminCtx(b), {asOf: AS_OF});
    expect(await runJob(close.id)).toBe('completed');
    const closeDone = await readToilSweepJob(adminCtx(b), close.id);
    const {state: job} = await sweepSnapshot(b);
    const jobOrder = await sweepEventOrder(b, TODAY);

    // Same events in the same order: each run's credits in employment and accrual order, then the markers.
    expect(syncOrder.actual).toEqual(syncOrder.expected);
    expect(jobOrder.actual).toEqual(jobOrder.expected);
    expect(expiryDone).toMatchObject({state: 'completed', failedEmployees: 0, error: null, total: EMPLOYEES, done: EMPLOYEES});
    expect(closeDone).toMatchObject({state: 'completed', failedEmployees: 0, error: null, total: EMPLOYEES});
    expect(expiryDone!.result).toEqual(syncExpiry);
    expect(closeDone!.result).toEqual(syncClose);
    expect(job).toEqual(sync);

    // The fixture exercises what it claims to: both branches, both valuation bases, carry-forward, and an
    // anniversary boundary; and the run really was several batches.
    expect(syncExpiry.converted).toBeGreaterThan(0); expect(syncExpiry.lapsed).toBeGreaterThan(0); expect(syncExpiry.convertedAmount).toBeGreaterThan(0);
    expect(syncClose).toMatchObject({alreadyClosed: false}); expect(syncClose.carriedForward).toBeGreaterThan(0);
    expect(syncClose.converted).toBeGreaterThan(0); expect(syncClose.lapsed).toBeGreaterThan(0);
    const bases = new Set(sync.events.map(e => e.payload.valuationBasis).filter(Boolean));
    expect([...bases].sort()).toEqual(['generic_orp', 'statutory_exact']);
    const markers = sync.events.filter(e => e.event_type === 'replacement-leave-year.closed');
    expect(markers.map(m => m.aggregate_id).sort()).toEqual(['company:Acme Sdn Bhd', 'company:Beta Anniversary Sdn Bhd', 'company:Delta Sdn Bhd', 'company:Gamma Sdn Bhd']);
    expect(markers).toHaveLength(4);
    expect(markers.find(m => m.aggregate_id === 'company:Beta Anniversary Sdn Bhd')!.payload.leaveCycle).toBe('anniversary');
    const annivDebits = (sync.ledger as {employment_id: string; entry_type: string; effective_on: string}[]).filter(r => r.entry_type === 'debit' && r.effective_on !== TODAY && r.effective_on !== AS_OF);
    expect(annivDebits.length).toBeGreaterThan(0);
    expect(sync.events.length).toBeGreaterThan(EMPLOYEES * 2);
    expect(job.accruals).not.toEqual(before.accruals);
    expect(sync.payrollInputs).toEqual(before.payrollInputs);
    const [{n: batches}] = await owner.client<{n: number}[]>`select count(*)::int as n from bulk_job where kind='toil_year_close'`;
    expect(batches).toBe(1);
    expect((await jobRow(close.id)).steps_total).toBe(Math.ceil(EMPLOYEES / LEAVE_COHORT_BATCH_EMPLOYEES));
    expect((await jobRow(expiry.id)).steps_total).toBeGreaterThan(1);
    // One batch per chunk transaction; the kernel records the longest hold of the kind's locks (to COMMIT).
    for (const id of [expiry.id, close.id]) {
      const {metrics} = await jobRow(id);
      // Evidence for a run that asks for it (the kernel's own timings for this fixture's chunks).
      if (process.env.TOIL_SWEEP_METRICS_FILE) appendFileSync(process.env.TOIL_SWEEP_METRICS_FILE, `${id === expiry.id ? 'toil_expiry' : 'toil_year_close'} ${JSON.stringify(metrics)}\n`);
      expect(Number(metrics.chunks)).toBeGreaterThan(1);
      expect(Number(metrics.chunkHoldMs)).toBeLessThan(1000);
    }

    // A re-fire of the close is reported as already closed, by both paths.
    expect(await closeReplacementLeaveYear(adminCtx(b), {asOf: AS_OF})).toMatchObject({alreadyClosed: true, processed: 0});
    const again = await createReplacementYearCloseJob(adminCtx(b), {asOf: AS_OF});
    expect(await runJob(again.id)).toBe('completed');
    expect((await readToilSweepJob(adminCtx(b), again.id))!.result).toMatchObject({alreadyClosed: true, processed: 0, carriedForward: 0});
    expect((await sweepSnapshot(b)).state).toEqual(job);
  }, 300_000);

  it('creates the REPLACEMENT leave type once, before any batch, when the tenant has none (as the synchronous sweep did)', async () => {
    await sweepFixture(b, {replacementType: false});
    const syncExpiry = await runToilExpiry(adminCtx(b), {today: TODAY});
    const syncClose = await closeReplacementLeaveYear(adminCtx(b), {asOf: AS_OF});
    const {state: sync} = await sweepSnapshot(b);
    await resetDb(); b = await seedBase(); await sweepFixture(b, {replacementType: false});
    const expiry = await createToilExpiryJob(adminCtx(b), {today: TODAY});
    expect(await runJob(expiry.id)).toBe('completed');
    const close = await createReplacementYearCloseJob(adminCtx(b), {asOf: AS_OF});
    expect(await runJob(close.id)).toBe('completed');
    const {state: job} = await sweepSnapshot(b);
    expect((await readToilSweepJob(adminCtx(b), expiry.id))!.result).toEqual(syncExpiry);
    expect((await readToilSweepJob(adminCtx(b), close.id))!.result).toEqual(syncClose);
    expect(job).toEqual(sync);
    const created = (job.leaveTypes as {code: string}[]).filter(t => t.code === 'REPLACEMENT');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({name: 'Replacement Leave (in lieu)', paid: true, counting: 'working_days', live: true});
  }, 300_000);

  it('counts the due credits a dual-scoped administrator can see but not settle, as the synchronous sweep did', async () => {
    // hr_admin in Acme, payroll partner in Gamma: Gamma's due credits are visible but not settleable.
    const dual = async (companies: {acme: string; gamma: string}): Promise<SessionContext> => {
      const [u] = await owner.db.insert(schema.appUser).values({tenantId: b.tenantId, workosUserId: `user_${Math.random().toString(36).slice(2)}`}).returning({id: schema.appUser.id});
      await owner.db.insert(schema.roleAssignment).values([
        {tenantId: b.tenantId, appUserId: u.id, companyId: companies.acme, role: 'hr_admin'},
        {tenantId: b.tenantId, appUserId: u.id, companyId: companies.gamma, role: 'payroll_partner'},
      ]);
      return {tenantId: b.tenantId, userId: u.id, grants: [{role: 'hr_admin', companyId: companies.acme}, {role: 'payroll_partner', companyId: companies.gamma}],
        entitlements: (await entitledCtx(b)).entitlements};
    };
    const syncExpiry = await runToilExpiry(await dual((await sweepFixture(b)).companies), {today: TODAY});
    const {state: sync, map: syncMap} = await sweepSnapshot(b);
    await resetDb(); b = await seedBase();
    const ctx = await dual((await sweepFixture(b)).companies);
    const job = await createToilExpiryJob(ctx, {today: TODAY});
    expect(await runJob(job.id)).toBe('completed');
    const done = await readToilSweepJob(ctx, job.id);
    const {state: after, map: jobMap} = await sweepSnapshot(b);
    expect(syncExpiry.skippedOutOfScope).toBeGreaterThan(0);
    expect(syncExpiry.processed).toBeGreaterThan(0);
    expect(done!.result).toEqual(syncExpiry);
    // The actor is a different login in each arm; everything else is identical.
    const actorless = (s: typeof sync) => ({...s, events: s.events.map(e => ({...e, actor_id: 'ACTOR'}))});
    expect(actorless(after)).toEqual(actorless(sync));
    void syncMap; void jobMap;
  }, 300_000);
});
