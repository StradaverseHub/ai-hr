/** core/mobile-command-receipt.ts against the database and RLS: replay, conflict, serialisation, approver-owned subject. */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { canonicalJson, MOBILE_COMMAND_EVENT, MobileCommandOwnerRequired, withMobileCommandReceipt } from '../core/mobile-command-receipt';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
const hiredOn = () => `${Number(todayInKualaLumpur().slice(0, 4)) - 1}-01-01`;
async function hire(name: string, role: 'employee' | 'manager' = 'employee') {
  const e = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: randomUUID() + '@receipt.test' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: hiredOn() });
  const userId = await createAppUser(base.tenantId, e.personId, role);
  const ctx: SessionContext = { tenantId: base.tenantId, userId, personId: e.personId, roles: [role], grants: [{ role, companyId: base.companyId }], entitlements: harnessSnapshot(base.tenantId) };
  return { ...e, ctx };
}
const Decision = z.object({ outcome: z.literal('accepted'), id: z.string().uuid(), note: z.string() });
const receipts = () => owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, MOBILE_COMMAND_EVENT)).orderBy(schema.domainEvent.sequence);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);

describe('withMobileCommandReceipt', () => {
  it('replays the stored response for the same intent, whatever its key order, without running again', async () => {
    const a = await hire('Receipt Replay');
    const requestId = randomUUID();
    let runs = 0;
    const command = (intent: unknown) => ({ kind: 'test.decision', requestId, intent, actorEmploymentId: a.employmentId, response: Decision });
    const first = await withMobileCommandReceipt(a.ctx, command({ target: 'x', days: [1, 2], note: 'n' }), async () => { runs++; return { outcome: 'accepted' as const, id: randomUUID(), note: 'first' }; });
    const replay = await withMobileCommandReceipt(a.ctx, command({ note: 'n', days: [1, 2], target: 'x' }), async () => { runs++; return { outcome: 'accepted' as const, id: randomUUID(), note: 'second' }; });
    expect(first).toMatchObject({ outcome: 'accepted', note: 'first' });
    expect(replay).toEqual(first);
    expect(runs).toBe(1);
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: a.ctx.userId, subjectEmploymentId: a.employmentId, aggregateId: requestId });
    expect((rows[0].payload as { response: unknown }).response).toEqual(first);
  });

  it('refuses a different intent, kind or employment under the same requestId as request_conflict, running nothing', async () => {
    const a = await hire('Receipt Conflict');
    const requestId = randomUUID();
    let runs = 0;
    const run = async () => { runs++; return { outcome: 'accepted' as const, id: randomUUID(), note: 'ok' }; };
    await withMobileCommandReceipt(a.ctx, { kind: 'test.decision', requestId, intent: { a: 1 }, actorEmploymentId: a.employmentId, response: Decision }, run);
    for (const changed of [{ kind: 'test.decision', intent: { a: 2 } }, { kind: 'test.other', intent: { a: 1 } }]) {
      expect(await withMobileCommandReceipt(a.ctx, { ...changed, requestId, actorEmploymentId: a.employmentId, response: Decision }, run)).toEqual({ outcome: 'refused', code: 'request_conflict' });
    }
    expect(runs).toBe(1);
    expect(await receipts()).toHaveLength(1);
  });

  it('serialises concurrent requests with one requestId: one run, one receipt, identical answers', async () => {
    const a = await hire('Receipt Race');
    const requestId = randomUUID();
    let runs = 0, inside = 0, overlap = false;
    const run = async () => { runs++; inside++; if (inside > 1) overlap = true; await sleep(150); inside--; return { outcome: 'accepted' as const, id: randomUUID(), note: 'raced' }; };
    const command = { kind: 'test.decision', requestId, intent: { a: 1 }, actorEmploymentId: a.employmentId, response: Decision };
    const results = await Promise.all([1, 2, 3].map(() => withMobileCommandReceipt(a.ctx, command, run)));
    expect(runs).toBe(1);
    expect(overlap).toBe(false);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(await receipts()).toHaveLength(1);
  });

  it('keeps receipts per actor: another user with the same requestId is not a replay of mine', async () => {
    const a = await hire('Receipt Actor One'), b = await hire('Receipt Actor Two');
    const requestId = randomUUID();
    const mine = await withMobileCommandReceipt(a.ctx, { kind: 'test.decision', requestId, intent: { a: 1 }, actorEmploymentId: a.employmentId, response: Decision }, async () => ({ outcome: 'accepted' as const, id: randomUUID(), note: 'a' }));
    const theirs = await withMobileCommandReceipt(b.ctx, { kind: 'test.decision', requestId, intent: { a: 1 }, actorEmploymentId: b.employmentId, response: Decision }, async () => ({ outcome: 'accepted' as const, id: randomUUID(), note: 'b' }));
    expect(theirs).not.toEqual(mine);
    expect(await receipts()).toHaveLength(2);
  });

  it('refuses an employment that is not the actor’s own and records nothing when run throws', async () => {
    const a = await hire('Receipt Owner'), b = await hire('Receipt Other');
    let runs = 0;
    await expect(withMobileCommandReceipt(a.ctx, { kind: 'test.decision', requestId: randomUUID(), intent: {}, actorEmploymentId: b.employmentId, response: Decision }, async () => { runs++; return { outcome: 'accepted' as const, id: randomUUID(), note: 'x' }; })).rejects.toBeInstanceOf(MobileCommandOwnerRequired);
    const requestId = randomUUID();
    await expect(withMobileCommandReceipt(a.ctx, { kind: 'test.decision', requestId, intent: {}, actorEmploymentId: a.employmentId, response: Decision }, async () => { throw new Error('domain refused'); })).rejects.toThrow('domain refused');
    expect(runs).toBe(0);
    expect(await receipts()).toHaveLength(0);
    // The failed attempt left no receipt, so the same requestId may still run.
    expect(await withMobileCommandReceipt(a.ctx, { kind: 'test.decision', requestId, intent: {}, actorEmploymentId: a.employmentId, response: Decision }, async () => ({ outcome: 'accepted' as const, id: randomUUID(), note: 'retry' }))).toMatchObject({ note: 'retry' });
  });

  it('an approver still replays their own receipt after the employee’s manager changes', async () => {
    const employee = await hire('Receipt Employee'), approver = await hire('Receipt Approver', 'manager'), successor = await hire('Receipt Successor', 'manager');
    await setReportingLine(adminCtx(base), { subordinateEmploymentId: employee.employmentId, managerEmploymentId: approver.employmentId, lineType: 'administrative', validFrom: hiredOn() });
    // Non-vacuity: an employee-keyed event, visible to the approver now, is invisible after the change.
    const [probe] = await owner.db.insert(schema.domainEvent).values({ tenantId: base.tenantId, aggregateType: 'receipt-probe', aggregateId: randomUUID(), eventType: 'receipt.probe', actorType: 'system', subjectEmploymentId: employee.employmentId, payload: {} }).returning({ id: schema.domainEvent.id });
    const sees = () => withTenant(approver.ctx, (tx) => tx.select({ id: schema.domainEvent.id }).from(schema.domainEvent).where(and(eq(schema.domainEvent.id, probe.id))));
    expect(await sees()).toHaveLength(1);

    const requestId = randomUUID();
    let runs = 0;
    const command = { kind: 'test.decision', requestId, intent: { employmentId: employee.employmentId, decision: 'approve' }, actorEmploymentId: approver.employmentId, response: Decision };
    const first = await withMobileCommandReceipt(approver.ctx, command, async () => { runs++; return { outcome: 'accepted' as const, id: randomUUID(), note: 'approved' }; });

    const [{ today }] = await owner.db.execute<{ today: string }>(sql`select current_date::text as today`);
    await setReportingLine(adminCtx(base), { subordinateEmploymentId: employee.employmentId, managerEmploymentId: successor.employmentId, lineType: 'administrative', validFrom: today });
    expect(await sees()).toHaveLength(0);

    const replay = await withMobileCommandReceipt(approver.ctx, command, async () => { runs++; return { outcome: 'accepted' as const, id: randomUUID(), note: 'twice' }; });
    expect(replay).toEqual(first);
    expect(runs).toBe(1);
    const [row] = await receipts();
    expect(row.subjectEmploymentId).toBe(approver.employmentId);
  });

  it('canonical JSON ignores key order and refuses non-JSON intent', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: 'x', z: undefined })).toBe('{"a":"x","b":[1,{"c":2,"d":1}]}');
    expect(() => canonicalJson({ at: new Date() })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
  });
});
