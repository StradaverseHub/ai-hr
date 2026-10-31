/** Native transaction composition only. A returned source reference is not a deletion custody proof. */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { createConfig } from '../core/employee-id-config';
import {
  createEmployeeDraftWithReservedCode, discardEmployeeDraft, saveEmployeeDraft,
} from '../core/employee-draft';
import {
  adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base,
} from './harness';

let b: Base;
let ctx: SessionContext;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); ctx = adminCtx(b); });

const input = () => ({
  companyId: b.companyId, fullName: 'Native discard draft', primaryEmail: `draft.${randomUUID()}@demo.test`,
});
async function configuredDraft() {
  await createConfig(ctx, {
    companyId: b.companyId, prefix: 'TX', startNumber: 10, numberLength: 4,
    increment: 3, allowManualOverride: true,
  });
  return createEmployeeDraftWithReservedCode(ctx, input());
}
async function legacyDraft() {
  // Retained pre-setup reservation shape. New creation correctly requires a configured or manual ID;
  // this persisted historical fixture exercises the unchanged native legacy release owner.
  const draft = await saveEmployeeDraft(ctx, { data: {}, currentStep: 1 });
  await owner.db.update(s.employeeDraft).set({
    companyId: b.companyId, reservedEmployeeCode: 'EMP-0010', reservedNumber: 10, reservedAt: new Date(),
  }).where(eq(s.employeeDraft.id, draft.id));
  await owner.db.insert(s.tenantCounter).values({ tenantId: b.tenantId, kind: 'employee_code', value: 10 });
  return { id: draft.id, employeeCode: 'EMP-0010' };
}
async function snapshot() {
  return {
    drafts: await owner.db.select().from(s.employeeDraft).where(eq(s.employeeDraft.tenantId, b.tenantId)).orderBy(s.employeeDraft.id),
    configs: await owner.db.select().from(s.employeeIdConfig).where(eq(s.employeeIdConfig.tenantId, b.tenantId)).orderBy(s.employeeIdConfig.id),
    counters: await owner.db.select().from(s.tenantCounter).where(eq(s.tenantCounter.tenantId, b.tenantId)).orderBy(s.tenantCounter.kind),
    events: await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId, b.tenantId)).orderBy(s.domainEvent.id),
    people: await owner.db.select().from(s.person).where(eq(s.person.tenantId, b.tenantId)).orderBy(s.person.id),
    employments: await owner.db.select().from(s.employment).where(eq(s.employment.tenantId, b.tenantId)).orderBy(s.employment.id),
  };
}
async function discardedEvents(id: string) {
  return owner.db.select().from(s.domainEvent).where(and(
    eq(s.domainEvent.tenantId, b.tenantId), eq(s.domainEvent.aggregateId, id),
    eq(s.domainEvent.eventType, 'employee-draft.discarded'),
  ));
}

async function expectAuditFault(work: Promise<unknown>) {
  try {
    await work;
    throw new Error('Expected the native audit insert to fail.');
  } catch (error) {
    const messages: string[] = [];
    let cause: unknown = error;
    while (cause instanceof Error) {
      messages.push(cause.message);
      cause = cause.cause;
    }
    expect(messages.join('\n')).toContain('draft discard audit fault');
  }
}

describe('native draft discard transaction seam', () => {
  it('keeps the ordinary call void, with exactly one native event and the same tip release', async () => {
    const draft = await configuredDraft();
    const before = await snapshot();
    expect(before.configs[0].currentRunningNumber).toBe(10);
    expect(await discardEmployeeDraft(ctx, draft.id)).toBeUndefined();
    const after = await snapshot();
    expect(after.drafts).toEqual([]);
    expect(after.configs[0].currentRunningNumber).toBe(7);
    expect(after.counters).toEqual(before.counters);
    expect(after.people).toEqual(before.people);
    expect(after.employments).toEqual(before.employments);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(await discardedEvents(draft.id)).toEqual([expect.objectContaining({
      aggregateType: 'employee-draft', aggregateId: draft.id, actorType: 'user', actorId: ctx.userId,
      subjectEmploymentId: null, payload: { reservedEmployeeCode: draft.employeeCode, released: true },
    })]);
  });

  it('commits an explicit enclosing transaction without changing its default void result', async () => {
    const draft = await saveEmployeeDraft(ctx, { data: {}, currentStep: 1 });
    await withTenant(ctx, async tx => {
      expect(await discardEmployeeDraft(ctx, draft.id, tx)).toBeUndefined();
      expect(await tx.select().from(s.employeeDraft).where(eq(s.employeeDraft.id, draft.id))).toEqual([]);
    });
    expect(await discardedEvents(draft.id)).toEqual([expect.objectContaining({ payload: {} })]);
    const after = await snapshot();
    expect(after.drafts).toEqual([]);
    expect(after.configs).toEqual([]);
    expect(after.counters).toEqual([]);
  });

  it.each(['configured', 'legacy'] as const)('captures the actual %s native event in the current transaction', async kind => {
    const draft = await (kind === 'configured' ? configuredDraft() : legacyDraft());
    const result = await withTenant(ctx, async tx => {
      const result = await discardEmployeeDraft(ctx, draft.id, tx, { returnResult: true });
      expect(result).toEqual({ draftId: draft.id, reservedEmployeeCode: draft.employeeCode, released: true, eventId: expect.any(String) });
      const [event] = await tx.select().from(s.domainEvent).where(eq(s.domainEvent.id, result.eventId));
      expect(event).toMatchObject({
        id: result.eventId, tenantId: b.tenantId, aggregateType: 'employee-draft', aggregateId: draft.id,
        eventType: 'employee-draft.discarded', actorType: 'user', actorId: ctx.userId,
        payload: { reservedEmployeeCode: draft.employeeCode, released: true },
      });
      const [source] = await tx.execute<{ same_tx: boolean }>(sql`
        select xmin = pg_current_xact_id()::xid as same_tx from domain_event where id = ${result.eventId}::uuid
      `);
      expect(source.same_tx).toBe(true);
      expect(await tx.select().from(s.employeeDraft).where(eq(s.employeeDraft.id, draft.id))).toEqual([]);
      return result;
    });
    expect(await discardedEvents(draft.id)).toEqual([expect.objectContaining({ id: result.eventId })]);
    const after = await snapshot();
    expect(after.drafts).toEqual([]);
    if (kind === 'configured') expect(after.configs[0].currentRunningNumber).toBe(7);
    else expect(after.counters).toEqual([expect.objectContaining({ kind: 'employee_code', value: 9 })]);
  });

  it.each(['configured', 'legacy'] as const)('rolls back the entire %s delete, counter release and event with the outer transaction', async kind => {
    const draft = await (kind === 'configured' ? configuredDraft() : legacyDraft());
    const before = await snapshot();
    await expect(withTenant(ctx, async tx => {
      const result = await discardEmployeeDraft(ctx, draft.id, tx, { returnResult: true });
      expect(result.released).toBe(true);
      expect(await tx.select().from(s.domainEvent).where(eq(s.domainEvent.id, result.eventId))).toHaveLength(1);
      throw new Error('outer discard rollback');
    })).rejects.toThrow('outer discard rollback');
    expect(await snapshot()).toEqual(before);
  });

  it('captures a non-tip gap without releasing the later reservation', async () => {
    const draft = await configuredDraft();
    const later = await createEmployeeDraftWithReservedCode(ctx, input());
    const result = await withTenant(ctx, tx => discardEmployeeDraft(ctx, draft.id, tx, { returnResult: true }));
    expect(result.released).toBe(false);
    expect(await discardedEvents(draft.id)).toEqual([expect.objectContaining({
      id: result.eventId, payload: { reservedEmployeeCode: draft.employeeCode, released: false },
    })]);
    const after = await snapshot();
    expect(after.configs[0].currentRunningNumber).toBe(13);
    expect(after.drafts.map(row => row.id)).toEqual([later.id]);
  });

  it('uses the current configured increment when returning a held tip', async () => {
    const draft = await configuredDraft();
    await owner.db.update(s.employeeIdConfig).set({ increment: 2 })
      .where(and(eq(s.employeeIdConfig.tenantId, b.tenantId), eq(s.employeeIdConfig.companyId, b.companyId)));
    const result = await withTenant(ctx, tx => discardEmployeeDraft(ctx, draft.id, tx, { returnResult: true }));
    expect(result.released).toBe(true);
    expect((await snapshot()).configs[0].currentRunningNumber).toBe(8);
  });

  it('captures a manual reservation without inventing a counter release', async () => {
    const draft = await createEmployeeDraftWithReservedCode(ctx, { ...input(), employeeIdMode: 'manual', employeeCode: 'MANUAL-TX' });
    const result = await withTenant(ctx, tx => discardEmployeeDraft(ctx, draft.id, tx, { returnResult: true }));
    expect(result).toEqual({ draftId: draft.id, reservedEmployeeCode: 'MANUAL-TX', released: false, eventId: expect.any(String) });
    expect((await snapshot()).counters).toEqual([]);
    expect(await discardedEvents(draft.id)).toEqual([expect.objectContaining({
      id: result.eventId, payload: { reservedEmployeeCode: 'MANUAL-TX', released: false },
    })]);
  });

  it('refuses capture without an enclosing transaction before any native effects', async () => {
    const draft = await configuredDraft();
    const before = await snapshot();
    await expect(Reflect.apply(discardEmployeeDraft, undefined, [ctx, draft.id, undefined, { returnResult: true }]))
      .rejects.toThrow('requires an enclosing transaction');
    expect(await snapshot()).toEqual(before);
  });

  it('preserves the native non-admin refusal and missing-draft failure without effects', async () => {
    const draft = await configuredDraft();
    const userId = await createAppUser(b.tenantId, null, 'employee');
    const employee: SessionContext = { ...ctx, userId, roles: ['employee'] };
    const before = await snapshot();
    await expect(discardEmployeeDraft(employee, draft.id)).rejects.toThrow('Only an admin');
    await expect(withTenant(employee, tx => discardEmployeeDraft(employee, draft.id, tx, { returnResult: true })))
      .rejects.toThrow('Only an admin');
    await expect(discardEmployeeDraft(ctx, randomUUID())).rejects.toThrow('Draft not found (or not visible).');
    await expect(withTenant(ctx, tx => discardEmployeeDraft(ctx, randomUUID(), tx, { returnResult: true })))
      .rejects.toThrow('Draft not found (or not visible).');
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back deletion and the released counter when the actual native audit insert fails', async () => {
    const draft = await configuredDraft();
    const before = await snapshot();
    await owner.db.execute(sql`CREATE FUNCTION draft_discard_native_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='employee-draft.discarded' THEN RAISE EXCEPTION 'draft discard audit fault'; END IF; RETURN NEW; END $$`);
    await owner.db.execute(sql`CREATE TRIGGER draft_discard_native_fault BEFORE INSERT ON domain_event
      FOR EACH ROW EXECUTE FUNCTION draft_discard_native_fault()`);
    try {
      await expectAuditFault(discardEmployeeDraft(ctx, draft.id));
      expect(await snapshot()).toEqual(before);
      await expectAuditFault(withTenant(ctx, tx => discardEmployeeDraft(ctx, draft.id, tx, { returnResult: true })));
      expect(await snapshot()).toEqual(before);
    } finally {
      await owner.db.execute(sql`DROP TRIGGER draft_discard_native_fault ON domain_event`);
      await owner.db.execute(sql`DROP FUNCTION draft_discard_native_fault()`);
    }
  });
});
