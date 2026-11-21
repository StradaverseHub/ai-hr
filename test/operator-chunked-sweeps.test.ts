/** Bounded transactions for the review sweeps and the backup-shift backfill (core/operator-chunks.ts). A run in many
 * chunks ends in the same state as a run in one, a failure keeps earlier chunks and a re-run completes the rest, and
 * no chunk holds the tenant's writer lock while another chunk's work waits. Real PostgreSQL, fictional data. */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { startReview, sweepDueReviews, sweepReviewReminders } from '../core/employment-review';
import { backfillBackupShift, createShift } from '../core/roster';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { reconcileInformationSnapshots } from '../scripts/reconcile-information-snapshots';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// Tests choose how often a chunk's time budget runs out; production uses OPERATOR_CHUNK_BUDGET_MS.
const budget = vi.hoisted(() => ({ exhausted: false }));
vi.mock('../core/operator-chunks', async (load) => {
  const real = await load<typeof import('../core/operator-chunks')>();
  return { ...real, chunkDeadline: (ms?: number) => { const inner = real.chunkDeadline(ms); return () => budget.exhausted || inner(); } };
});

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); budget.exhausted = false; });
afterAll(closeAll);

const sweepCtx = () => ({ tenantId: b.tenantId, roles: ['hr_admin'] });
async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '-')}_${randomUUID().slice(0, 6)}@fixture.test` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-01-01',
  });
}
const setProbationEnd = (employmentId: string, date: string) =>
  owner.db.update(schema.employment).set({ probationEndDate: date }).where(eq(schema.employment.id, employmentId));
/** Business-level end state: reviews, reminder ledger and the events the sweeps appended, ids replaced by names. */
async function reviewState() {
  const names = new Map((await owner.db.select({ id: schema.employment.id, name: schema.person.fullName }).from(schema.employment)
    .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))).map((r) => [r.id, r.name]));
  const reviews = await owner.db.select().from(schema.employmentReview).orderBy(asc(schema.employmentReview.id));
  const review = new Map(reviews.map((r) => [r.id, `${names.get(r.employmentId)}:${r.reviewType}`]));
  const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(asc(schema.domainEvent.id));
  return {
    reviews: reviews.map((r) => [names.get(r.employmentId), r.reviewType, r.status, r.endDate, r.dueDate, r.autoTriggered].join('|')).sort(),
    reminders: (await owner.db.select().from(schema.employmentReviewReminder)).map((r) => [review.get(r.reviewId), r.offsetDays, r.sentOn].join('|')).sort(),
    events: events.filter((e) => e.eventType.startsWith('employment-review')).map((e) =>
      [e.eventType, e.aggregateType, review.get(e.aggregateId) ?? (e.aggregateId === b.tenantId ? 'tenant' : 'other'), e.subjectEmploymentId ? names.get(e.subjectEmploymentId) : '', JSON.stringify(e.payload)].join('|')).sort(),
  };
}
/** A mixed cohort: due, not due, a leaver and a resignation, plus two open reviews inside reminder windows. */
async function cohort() {
  const due = [];
  for (let n = 0; n < 5; n++) { const e = await hire(`Fictional due ${n}`); await setProbationEnd(e.employmentId, '2026-04-30'); due.push(e); }
  const notDue = await hire('Fictional not due'); await setProbationEnd(notDue.employmentId, '2026-12-31');
  const leaver = await hire('Fictional leaver'); await setProbationEnd(leaver.employmentId, '2026-04-30');
  await owner.db.update(schema.employment).set({ terminatedOn: '2026-03-15' }).where(eq(schema.employment.id, leaver.employmentId));
  const resigning = await hire('Fictional resigning'); await setProbationEnd(resigning.employmentId, '2026-04-30');
  await owner.db.insert(schema.resignationRequest).values({ tenantId: b.tenantId, employmentId: resigning.employmentId, personId: resigning.personId, lastWorkingDay: '2026-05-01', status: 'pending' });
  for (const name of ['Fictional reminded A', 'Fictional reminded B']) {
    const e = await hire(name); await setProbationEnd(e.employmentId, '2026-04-20'); await startReview(adminCtx(b), { employmentId: e.employmentId });
  }
  return { due };
}
async function sweep(chunkRows?: number) {
  const opened = await sweepDueReviews(sweepCtx(), { today: '2026-04-01', chunkRows });
  const reminded = await sweepReviewReminders(sweepCtx(), { today: '2026-04-01', chunkRows });
  return { opened: opened.opened, reminders: reminded.reminders };
}

describe('chunked review sweeps', () => {
  it('end in the same state whether a sweep runs in one chunk or one row per chunk', async () => {
    await cohort();
    const single = await sweep();
    const singleState = await reviewState();
    expect(single).toEqual({ opened: 5, reminders: 7 });
    expect(singleState.events.filter((e) => e.startsWith('employment-review.reminders.swept'))).toEqual([
      `employment-review.reminders.swept|employment-review-reminder-sweep|tenant||${JSON.stringify({ today: '2026-04-01', reminders: 7 })}`,
    ]);
    // Same fixture again on a fresh tenant, with the smallest possible chunks (rows and time budget).
    await resetDb(); b = await seedBase(); await cohort();
    const chunked = await sweep(1);
    expect(chunked).toEqual(single);
    expect(await reviewState()).toEqual(singleState);
    budget.exhausted = true;
    expect(await sweep(2)).toEqual({ opened: 0, reminders: 0 }); // idempotent, also in minimal chunks
    expect(await reviewState()).toEqual(singleState);
  });

  it('keeps earlier chunks when a later one fails, and a re-run completes the same end state', async () => {
    const { due } = await cohort();
    // Refuse the review of the last due employment in id order, so earlier chunks commit first.
    const last = [...due].sort((x, y) => x.employmentId.localeCompare(y.employmentId)).at(-1)!;
    await owner.client.unsafe(`create function public.fixture_refuse_review() returns trigger language plpgsql as $$begin if NEW.employment_id='${last.employmentId}' then raise exception 'Fictional review refusal'; end if; return NEW; end$$`);
    await owner.client`create trigger fixture_refuse_review before insert on employment_review for each row execute function public.fixture_refuse_review()`;
    try { await expect(sweepDueReviews(sweepCtx(), { today: '2026-04-01', chunkRows: 1 })).rejects.toThrow(); }
    finally { await owner.client`drop trigger fixture_refuse_review on employment_review`; await owner.client`drop function public.fixture_refuse_review()`; }
    const partial = (await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.autoTriggered, true))).length;
    expect(partial).toBe(4);
    expect((await sweepDueReviews(sweepCtx(), { today: '2026-04-01', chunkRows: 1 })).opened).toBe(1);
    expect((await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.autoTriggered, true))).length).toBe(5);
  });

  it('releases the writer lock between chunks so an ordinary Access writer runs in between', async () => {
    await cohort();
    // Each opened review takes at least 150 ms, so the sweep spans several commits; a writer that starts once the
    // first review is committed must get the lock before the sweep ends (one transaction would make it wait).
    await owner.client.unsafe(`create function public.fixture_slow_review() returns trigger language plpgsql as $$begin perform pg_sleep(0.15); return NEW; end$$`);
    await owner.client`create trigger fixture_slow_review before insert on employment_review for each row execute function public.fixture_slow_review()`;
    try {
      const opened = async () => (await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.autoTriggered, true))).length;
      const sweepRun = sweepDueReviews(sweepCtx(), { today: '2026-04-01', chunkRows: 1 });
      while ((await opened()) < 1) await new Promise((r) => setTimeout(r, 5));
      await withTenant(adminCtx(b), (tx) => tx.execute(sql`select app.access_workforce_write_lock()`));
      const whenWriterRan = await opened();
      expect((await sweepRun).opened).toBe(5);
      expect(whenWriterRan).toBeLessThan(5);
    } finally {
      await owner.client`drop trigger fixture_slow_review on employment_review`; await owner.client`drop function public.fixture_slow_review()`;
    }
  });
});

describe('chunked backup-shift backfill', () => {
  async function fixture(n: number) {
    const ctx = adminCtx(b), ids: string[] = [];
    const shift = await createShift(ctx, { name: 'Fictional chunk shift', code: 'FCS', startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    for (let i = 0; i < n; i++) ids.push((await hire(`Fictional uncovered ${i}`)).employmentId);
    return { ctx, shift, ids: ids.sort() };
  }
  const covered = async () => (await owner.db.select({ id: schema.employment.id, shift: schema.employment.defaultShiftId, type: schema.employment.shiftType })
    .from(schema.employment).where(eq(schema.employment.tenantId, b.tenantId)).orderBy(asc(schema.employment.id)));
  const assigned = async () => (await owner.db.select({ subject: schema.domainEvent.subjectEmploymentId, payload: schema.domainEvent.payload }).from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'employment.shift-arrangement.assigned'))))
    .map((e) => JSON.stringify([e.subject, e.payload])).sort();

  it('writes one audited assignment per row in single-row chunks, as the one-row-per-transaction run did', async () => {
    const f = await fixture(4);
    budget.exhausted = true;
    const result = await backfillBackupShift(f.ctx, { shiftCode: 'fcs', apply: true });
    expect(result.before.map((r) => r.employmentId).sort()).toEqual(expect.arrayContaining(f.ids));
    expect(result.after).toEqual([]);
    expect(result.assignedShiftId).toBe(f.shift.id);
    const rows = await covered();
    expect(rows.filter((r) => f.ids.includes(r.id)).every((r) => r.shift === f.shift.id && r.type === 'fixed')).toBe(true);
    expect((await assigned()).length).toBe(result.before.length);
    // Repeat: nothing left, nothing written.
    const events = await assigned();
    expect((await backfillBackupShift(f.ctx, { shiftCode: 'FCS', apply: true })).before).toEqual([]);
    expect(await assigned()).toEqual(events);
  });

  it('refuses before any write while any nominated subject is held, then completes after release', async () => {
    const f = await fixture(3);
    const before = await covered();
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>((r) => { ready = r; }), done = new Promise<void>((r) => { release = r; });
    const holder = withTenant(f.ctx, async (tx) => { await lockLeaveDependenciesTx(tx, b.tenantId, [f.ids[2]]); ready(); await done; });
    await held;
    try {
      await expect(backfillBackupShift(f.ctx, { shiftCode: 'FCS', apply: true })).rejects.toThrow('Leave source is unavailable');
      expect(await covered()).toEqual(before);
      expect(await assigned()).toEqual([]);
    } finally { release(); await holder; }
    budget.exhausted = true;
    expect((await backfillBackupShift(f.ctx, { shiftCode: 'FCS', apply: true })).after).toEqual([]);
  });
});

describe('chunked information snapshot reconciliation', () => {
  async function manifest(n: number) {
    const [period] = await owner.db.insert(schema.payPeriod).values({ tenantId: b.tenantId, companyId: b.companyId, period: '2025-01', status: 'closed' }).returning();
    const [batch] = await owner.db.insert(schema.payrollBatch).values({ tenantId: b.tenantId, companyId: b.companyId, payPeriodId: period.id, payPeriod: '2025-01', batchDate: '2025-01-25', status: 'closed', releasedAt: new Date('2025-01-25T00:00:00Z') }).returning();
    const items = [];
    for (let i = 0; i < n; i++) {
      const { employmentId } = await hire(`Fictional payslip ${i}`);
      const [slip] = await owner.db.insert(schema.payslip).values({ tenantId: b.tenantId, batchId: batch.id, employmentId, basicSalary: '3000.00', grossPay: '3000.00', statutory: { epfEmployee: 330, epfEmployer: 390, pcb: 10 }, totalDeductions: '340.00', netPay: '2660.00', employerCost: '3390.00' }).returning();
      items.push({ payslipId: slip.id, employmentId, companyId: b.companyId, original: { grade: null, employmentType: 'full_time' as const, hiredOn: '2026-01-01', joinDate: null },
        evidence: [{ path: 'fictional-original.pdf', sha256: 'b'.repeat(64), reference: `Fictional reviewed original ${i}` }] });
    }
    return { version: 1 as const, tenantId: b.tenantId, actorUserId: adminCtx(b).userId!, verifiedOriginals: true as const, items };
  }
  const reconciled = () => owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'employment.information.snapshot-reconciled'));

  it('checks the whole manifest before writing: a refused last item leaves nothing reconciled', async () => {
    const m = await manifest(3);
    budget.exhausted = true; // one item per transaction
    const last = [...m.items].sort((x, y) => x.employmentId.localeCompare(y.employmentId) || x.payslipId.localeCompare(y.payslipId)).at(-1)!;
    await owner.db.insert(schema.informationPayslipSnapshot).values({ tenantId: b.tenantId, payslipId: last.payslipId, employmentId: last.employmentId, companyId: b.companyId, grade: 'Different', employmentType: 'full_time', hiredOn: '2026-01-01', joinDate: null, documentMetadata: {}, recordedBy: adminCtx(b).userId! });
    await expect(reconcileInformationSnapshots(owner, m, true)).rejects.toThrow('cannot be overwritten');
    expect(await owner.db.select().from(schema.informationPayslipSnapshot)).toHaveLength(1);
    expect(await reconciled()).toEqual([]);
  });

  it('writes each chunk with its own evidence record; the union is the whole manifest and a repeat writes nothing', async () => {
    const m = await manifest(3);
    expect(await reconcileInformationSnapshots(owner, m)).toMatchObject({ mode: 'dry-run', checked: 3, missing: 3 });
    expect(await owner.db.select().from(schema.informationPayslipSnapshot)).toHaveLength(0);
    budget.exhausted = true;
    expect(await reconcileInformationSnapshots(owner, m, true)).toMatchObject({ mode: 'applied', checked: 3, missing: 3, alreadyPreserved: 0 });
    const events = await reconciled();
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.aggregateId === m.items[0].payslipId)).toBe(true);
    const evidence = events.flatMap((e) => (e.payload as { snapshots: { payslipId: string; evidence: unknown[] }[] }).snapshots);
    expect(evidence.map((x) => x.payslipId).sort()).toEqual(m.items.map((i) => i.payslipId).sort());
    expect(JSON.stringify(events)).not.toContain('fictional-original.pdf');
    expect(await owner.db.select().from(schema.informationPayslipSnapshot)).toHaveLength(3);
    expect(await reconcileInformationSnapshots(owner, m, true)).toMatchObject({ missing: 0, alreadyPreserved: 3 });
    expect(await reconciled()).toHaveLength(3);
  });
});
