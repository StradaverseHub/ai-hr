/**
 * The replacement-leave sweep jobs' partial result, authority and busy employees (core/toil-sweep-worker.ts), on the
 * populated fixture of test/toil-sweep-fixture.ts.
 *
 * - A batch that keeps failing (a real refusal injected as a database error, the way test/leave-cohort-equivalence
 *   injects one) is recorded and left unchanged while the other batches are written; the result says how many
 *   employees were not processed; the close writes no marker for a company with an employee in that batch; running
 *   the sweep again completes them, leaving what an uninterrupted run leaves.
 * - Authority: a non-administrator cannot start either sweep; a creator who loses administrator access mid-run gets
 *   no marker written.
 * - A busy employee is retried rather than reported.
 */
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {SessionContext} from '../db/client';
import {ToilSweepForbiddenError} from '../core/toil';
import {createReplacementYearCloseJob, createToilExpiryJob, readToilSweepJob} from '../core/toil-sweep-job';
import {toilExpiryJobHandler, toilSweepBatches, toilYearCloseJobHandler} from '../core/toil-sweep-worker';
import {runBulkJobTick} from '../core/bulk-job-worker';
import type {CloseReplacementYearResult, ToilExpiryResult} from '../core/toil';
import {adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';
import {AS_OF, TODAY, sweepFixture, sweepSnapshot, type SweepFixture, type SweepSnapshot} from './toil-sweep-fixture';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);

const tick = () => runBulkJobTick(owner.client, {handlers: [toilExpiryJobHandler, toilYearCloseJobHandler]});
const stateOf = async (id: string) => (await owner.client<{state: string}[]>`select state from bulk_job where id=${id}::uuid`)[0].state;
async function tickUntil(done: () => Promise<boolean>) {
  for (let i = 0; i < 4000; i++) { if (await done()) return; if (!await tick()) await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('condition never reached');
}
async function runJob(id: string) {
  await tickUntil(async () => {
    const [row] = await owner.client<{state: string; notified: boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
    return ['completed', 'failed', 'cancelled'].includes(row.state) && row.notified;
  });
  return stateOf(id);
}
type Step = {seq: number; state: string; payload: {employmentIds: string[]; companyIds?: string[]}};
const stepsOf = async (id: string) => [...await owner.client<Step[]>`select seq,state,payload from bulk_job_step where job_id=${id}::uuid order by seq`];
/** A refusal for every leave ledger insert of one employee, as a database error arrives. */
async function failInserts(employmentId: string) {
  await owner.client.unsafe(`create or replace function public.test_fail_sweep() returns trigger language plpgsql as $$ begin if new.employment_id='${employmentId}' then raise exception 'injected failure for this test'; end if; return new; end $$`);
  await owner.client.unsafe(`create trigger test_fail_sweep before insert on leave_ledger for each row execute function public.test_fail_sweep()`);
}
const dropFailure = () => owner.client.unsafe(`drop trigger if exists test_fail_sweep on leave_ledger; drop function if exists public.test_fail_sweep()`);
const activeOf = async (ids: readonly string[]) =>
  (await owner.client<{n: number}[]>`select count(*)::int as n from toil_accrual where employment_id=any(${ids as string[]}::uuid[]) and status='active'`)[0].n;
const markersOf = async () => (await owner.client<{company: string; payload: Record<string, unknown>}[]>`select aggregate_id as company,payload from domain_event
  where tenant_id=${b.tenantId}::uuid and event_type='replacement-leave-year.closed' order by sequence`);
/** Started and prepared, its steps not yet run: pick a batch that leaves Delta (one employee) out. */
async function preparedBatch(id: string, f: SweepFixture) {
  await tickUntil(async () => (await stateOf(id)) === 'running');
  const delta = f.people.find(p => p.companyId === f.companies.delta)!.employmentId;
  const steps = await stepsOf(id);
  expect(steps.length).toBeGreaterThan(2);
  return steps.find(s => !s.payload.employmentIds.includes(delta))!;
}
const perCredit = (s: SweepSnapshot) => ({...s, events: s.events.filter(e => e.event_type !== 'replacement-leave-year.closed')});

describe('a batch that keeps failing leaves only its employees unchanged; running the sweep again completes them', () => {
  it('Process expirations, then the year-end close, each with a refused batch, then each again', async () => {
    // The uninterrupted job run, for comparison.
    await sweepFixture(b);
    const e0 = await createToilExpiryJob(adminCtx(b), {today: TODAY});
    expect(await runJob(e0.id)).toBe('completed');
    const c0 = await createReplacementYearCloseJob(adminCtx(b), {asOf: AS_OF});
    expect(await runJob(c0.id)).toBe('completed');
    const fullExpiry = (await readToilSweepJob(adminCtx(b), e0.id))!.result as ToilExpiryResult;
    const fullClose = (await readToilSweepJob(adminCtx(b), c0.id))!.result as CloseReplacementYearResult;
    const {state: full} = await sweepSnapshot(b);
    const fullMarkers = new Map((await markersOf()).map(m => [m.payload.companyId as string, m.payload]));
    const companyName = new Map((await owner.client<{id: string; name: string}[]>`select id,legal_name as name from company where tenant_id=${b.tenantId}::uuid`).map(r => [r.name, r.id]));
    const fullByName = new Map([...companyName].map(([name, id]) => [name, fullMarkers.get(id)]));

    await resetDb(); b = await seedBase();
    const f = await sweepFixture(b);
    const nameOf = new Map((await owner.client<{id: string; name: string}[]>`select id,legal_name as name from company where tenant_id=${b.tenantId}::uuid`).map(r => [r.id, r.name]));

    // ① Expiry: one batch refused.
    const e1 = await createToilExpiryJob(adminCtx(b), {today: TODAY});
    const eVictim = await preparedBatch(e1.id, f);
    await failInserts(eVictim.payload.employmentIds[0]);
    try { expect(await runJob(e1.id)).toBe('completed'); } finally { await dropFailure(); }
    const e1Done = await readToilSweepJob(adminCtx(b), e1.id);
    expect(e1Done).toMatchObject({state: 'completed', failedEmployees: eVictim.payload.employmentIds.length});
    expect(e1Done!.error).toMatch(/refused by a safeguard|injected failure|could not/i);
    const others = f.people.map(p => p.employmentId).filter(id => !eVictim.payload.employmentIds.includes(id));
    // The refused batch's employees keep every credit they had; the others' due credits are settled.
    const dueActive = async (ids: readonly string[]) => (await owner.client<{n: number}[]>`select count(*)::int as n from toil_accrual
      where employment_id=any(${ids as string[]}::uuid[]) and status='active' and expires_on<=${TODAY}::date and days_credited>days_taken`)[0].n;
    expect(await dueActive(eVictim.payload.employmentIds)).toBeGreaterThan(0);
    expect(await dueActive(others)).toBe(0);
    const e1Result = e1Done!.result as ToilExpiryResult;
    expect(e1Result.processed).toBeGreaterThan(0);
    expect(e1Result.processed).toBeLessThan(fullExpiry.processed);
    // …and running it again completes them.
    const e2 = await createToilExpiryJob(adminCtx(b), {today: TODAY});
    expect(await runJob(e2.id)).toBe('completed');
    const e2Result = (await readToilSweepJob(adminCtx(b), e2.id))!.result as ToilExpiryResult;
    expect(e2Result.processed + e1Result.processed).toBe(fullExpiry.processed);
    expect(await dueActive(eVictim.payload.employmentIds)).toBe(0);

    // ② Year-end close: one batch refused. Its companies get no marker; every other company does.
    const c1 = await createReplacementYearCloseJob(adminCtx(b), {asOf: AS_OF});
    const cVictim = await preparedBatch(c1.id, f);
    await failInserts(cVictim.payload.employmentIds[0]);
    try { expect(await runJob(c1.id)).toBe('completed'); } finally { await dropFailure(); }
    const c1Done = await readToilSweepJob(adminCtx(b), c1.id);
    expect(c1Done).toMatchObject({state: 'completed', failedEmployees: cVictim.payload.employmentIds.length});
    const blocked = new Set(cVictim.payload.companyIds!);
    expect(blocked.has(f.companies.delta)).toBe(false);
    const afterFirst = await markersOf();
    expect(afterFirst.map(m => m.payload.companyId).sort()).toEqual(Object.values(f.companies).filter(id => !blocked.has(id)).sort());
    for (const m of afterFirst) expect(m.payload).toEqual({...fullByName.get(nameOf.get(m.payload.companyId as string)!), companyId: m.payload.companyId});
    expect(await activeOf(cVictim.payload.employmentIds)).toBeGreaterThan(0);
    // …and running it again closes the rest: one marker per company, never two.
    const c2 = await createReplacementYearCloseJob(adminCtx(b), {asOf: AS_OF});
    expect(await runJob(c2.id)).toBe('completed');
    const c2Result = (await readToilSweepJob(adminCtx(b), c2.id))!.result as CloseReplacementYearResult;
    const c1Result = c1Done!.result as CloseReplacementYearResult;
    expect(c1Result.processed + c2Result.processed).toBe(fullClose.processed);
    const markers = await markersOf();
    expect(markers.map(m => m.payload.companyId).sort()).toEqual(Object.values(f.companies).sort());

    // The end state is the uninterrupted run's: credits, ledger, payroll inputs, leave types and every credit's event.
    const {state: after} = await sweepSnapshot(b);
    expect(perCredit(after)).toEqual(perCredit(full));
    // A re-run marker states what that run settled for its company (the first run's part is in its credits' events).
    for (const m of markers.slice(afterFirst.length)) {
      const whole = fullByName.get(nameOf.get(m.payload.companyId as string)!)!;
      expect(m.payload).toMatchObject({asOf: AS_OF, leaveCycle: whole.leaveCycle, carriedForward: whole.carriedForward});
      expect(Number(m.payload.processed)).toBeLessThanOrEqual(Number(whole.processed));
    }
  }, 300_000);
});

describe('authority', () => {
  it('a non-administrator cannot start either sweep', async () => {
    await sweepFixture(b);
    const member = {...adminCtx(b), roles: ['employee']} as SessionContext;
    await expect(createToilExpiryJob(member, {today: TODAY})).rejects.toBeInstanceOf(ToilSweepForbiddenError);
    await expect(createReplacementYearCloseJob(member, {asOf: AS_OF})).rejects.toBeInstanceOf(ToilSweepForbiddenError);
    const [{n}] = await owner.client<{n: number}[]>`select count(*)::int as n from bulk_job where tenant_id=${b.tenantId}::uuid`;
    expect(n).toBe(0);
  }, 120_000);

  it('a creator who loses administrator access before the markers are written gets none', async () => {
    await sweepFixture(b);
    const userId = await createAppUser(b.tenantId, null, 'hr_admin');
    const ctx: SessionContext = {...adminCtx(b), userId, grants: [{role: 'hr_admin', companyId: null}], roles: ['hr_admin']};
    const job = await createReplacementYearCloseJob(ctx, {asOf: AS_OF});
    // Every batch written, the markers not yet.
    await tickUntil(async () => (await stateOf(job.id)) === 'finalizing');
    const [{n: settled}] = await owner.client<{n: number}[]>`select count(*)::int as n from domain_event where tenant_id=${b.tenantId}::uuid and event_type in ('toil.converted','toil.lapsed')`;
    expect(settled).toBeGreaterThan(0);
    await owner.client`delete from role_assignment where app_user_id=${userId}::uuid`;
    expect(await runJob(job.id)).toBe('failed');
    expect(await markersOf()).toEqual([]);
    const [row] = await owner.client<{error: string; result: unknown}[]>`select error,result from bulk_job where id=${job.id}::uuid`;
    expect(row.error).toMatch(/access/i);
    expect(row.result).toBeNull();
  }, 120_000);
});

describe('a busy employee', () => {
  it('is retried while another writer holds their credit, then processed', async () => {
    const f = await sweepFixture(b);
    const job = await createToilExpiryJob(adminCtx(b), {today: TODAY});
    await tickUntil(async () => (await stateOf(job.id)) === 'running');
    const first = (await stepsOf(job.id))[0].payload.employmentIds[0];
    const holder = await owner.client.reserve();
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtextextended(${b.tenantId + ':' + first},0))`;
      for (let i = 0; i < 6; i++) await tick();
      const [row] = await owner.client<{state: string; transient_retries: number; steps_done: number}[]>`select state,transient_retries,steps_done from bulk_job where id=${job.id}::uuid`;
      expect(row).toMatchObject({state: 'running', steps_done: 0});
      expect(row.transient_retries).toBeGreaterThan(0);
      await holder`rollback`;
    } finally { holder.release(); }
    await owner.client`update bulk_job set not_before=null where id=${job.id}::uuid`;
    expect(await runJob(job.id)).toBe('completed');
    expect(await readToilSweepJob(adminCtx(b), job.id)).toMatchObject({state: 'completed', failedEmployees: 0, error: null});
    void f;
  }, 120_000);
});

describe('batches', () => {
  it('hold at most the family employees-per-batch and a bounded number of credits, never splitting an employee', () => {
    const e = (id: string, credits: number) => ({employmentId: id, credits});
    expect(toilSweepBatches([e('a', 1), e('b', 2), e('c', 1), e('d', 1), e('e', 1), e('f', 1)], 5, 40).map(b => b.map(x => x.employmentId))).toEqual([['a', 'b', 'c', 'd', 'e'], ['f']]);
    expect(toilSweepBatches([e('a', 30), e('b', 20), e('c', 90), e('d', 1)], 5, 40).map(b => b.map(x => x.employmentId))).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(toilSweepBatches([], 5, 40)).toEqual([]);
  });
});
