/** Authored real-employee/configuration participation acceptance. UNRUN until coordinated runtime. */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { createLeaveType, updateLeaveType, setLeaveTypeRules, archiveLeaveType, deleteLeaveType } from '../core/admin';
import { hireEmployee } from '../core/org';
import { lockLeaveDependenciesTx } from '../core/leave-dependency-lock';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);

describe('participating canonical leave catalogue commands', () => {
  it.each(['create', 'update', 'rules', 'archive', 'delete'] as const)('%s refuses an active employee interval without catalogue/event effects, then succeeds', async command => {
    const ctx = adminCtx(b);
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Catalogue Participation',
      primaryEmail: `catalogue-${randomUUID()}@t.local` }, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
    const { id } = await createLeaveType(ctx, { code: 'CFG_OWNED', name: 'Fictional Config Owned' });
    const mutate = async () => {
      switch (command) {
        case 'create': return createLeaveType(ctx, { code: 'CFG_NEW', name: 'Fictional Config New' });
        case 'update': return updateLeaveType(ctx, { id, name: 'Fictional Config Renamed' });
        case 'rules': return setLeaveTypeRules(ctx, { id, carryForwardEnabled: true, carryForwardMax: 3 });
        case 'archive': return archiveLeaveType(ctx, { id, archived: true });
        case 'delete': return deleteLeaveType(ctx, { id });
      }
    };
    const state = async () => ({
      types: await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.tenantId, b.tenantId))
        .orderBy(schema.leaveType.id),
      events: await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent)
        .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.aggregateType, 'leave-type')))
        .orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned catalogue handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      await lockLeaveDependenciesTx(tx, b.tenantId, [employee.employmentId]); ready(); await finish;
    });
    void holder.catch(failed);
    try {
      await started;
      await expect(mutate()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate();
    const after = await state();
    const row = after.types.find(type => type.id === id);
    if (command !== 'delete') expect(row).toBeDefined();
    switch (command) {
      case 'create': expect(after.types.find(type => type.code === 'CFG_NEW')?.name).toBe('Fictional Config New'); break;
      case 'update': expect(row?.name).toBe('Fictional Config Renamed'); break;
      case 'rules': expect(row?.carryForwardEnabled).toBe(true); expect(Number(row?.carryForwardMax)).toBe(3); break;
      case 'archive': expect(row?.archivedAt).not.toBeNull(); break;
      case 'delete': expect(row).toBeUndefined(); break;
    }
    expect(after.events.length).toBeGreaterThan(before.events.length);
  });
});
