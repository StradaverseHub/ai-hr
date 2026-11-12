/**
 * 73cbffa1 · ONE SAVE FOR THE LEAVE TYPE'S DETAILS, ICON AND COLOUR — the service side.
 *
 * The approved plan folds the old separate icon/colour form (`visual=1`) into the identity form, so ONE submit
 * now carries `identity=1`, `leaveUnit=1` and `visual=1`. updateLeaveTypeAction maps those markers to fields of
 * ONE updateLeaveType call; this pins that the service applies them together, writes ONE leave-type.updated
 * event carrying every diff plus the optional reason, and that a combined save which leaves the icon/colour as
 * they are does not change them. The service is unchanged by this item — this is the regression net for the
 * new shape of call. (The busy/closed-payroll refusal on a Paid change is pinned by
 * test/leave-payroll-followup.test.ts "paid-status changes refuse closed effects atomically…", unchanged.)
 *
 * Fictional data only.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createLeaveType, updateLeaveType } from '../core/admin';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const uniqCode = () => `CS_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;

async function row(id: string) {
  const [r] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, id));
  return r;
}

async function updatedEventCount(id: string): Promise<number> {
  const rows = await owner.db
    .select({ seq: schema.domainEvent.sequence })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, b.tenantId),
        eq(schema.domainEvent.aggregateId, id),
        eq(schema.domainEvent.eventType, 'leave-type.updated'),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('73cbffa1 · identity + leaveUnit + visual in one save', () => {
  it('applies every field and writes ONE event with the name/paid/unit/description/icon/colour diffs and the reason', async () => {
    const code = uniqCode();
    const { id } = await createLeaveType(adminCtx(b), { code, name: 'Study Leave (fictional)', paid: true });
    await owner.db.update(schema.leaveType).set({ color: 'blue', icon: 'palmtree' }).where(eq(schema.leaveType.id, id));
    const eventsBefore = await updatedEventCount(id);

    // Exactly the field set updateLeaveTypeAction builds from the combined form.
    await updateLeaveType(adminCtx(b), {
      id,
      name: 'Exam Leave (fictional)',
      newCode: code,
      description: 'Professional exams only.',
      paid: false,
      leaveUnit: 'hour',
      color: 'purple',
      icon: 'graduationcap',
      reason: 'Renamed for the exam policy (fictional)',
    });

    const r = await row(id);
    expect(r.name).toBe('Exam Leave (fictional)');
    expect(r.description).toBe('Professional exams only.');
    expect(r.paid).toBe(false);
    expect(r.leaveUnit).toBe('hour');
    expect(r.color).toBe('purple');
    expect(r.icon).toBe('graduationcap');

    expect(await updatedEventCount(id)).toBe(eventsBefore + 1);
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before).toMatchObject({ name: 'Study Leave (fictional)', paid: true, leaveUnit: 'day', color: 'blue', icon: 'palmtree' });
    expect(after).toMatchObject({
      name: 'Exam Leave (fictional)',
      paid: false,
      leaveUnit: 'hour',
      color: 'purple',
      icon: 'graduationcap',
      description: 'Professional exams only.',
    });
    expect(payload?.reason).toBe('Renamed for the exam policy (fictional)');
  });

  it('a combined save that keeps the stored icon/colour leaves them exactly as they were', async () => {
    const code = uniqCode();
    const { id } = await createLeaveType(adminCtx(b), { code, name: 'Marriage Leave (fictional)', paid: true });
    await owner.db.update(schema.leaveType).set({ color: 'red', icon: 'heart' }).where(eq(schema.leaveType.id, id));

    await updateLeaveType(adminCtx(b), {
      id,
      name: 'Wedding Leave (fictional)',
      newCode: code,
      description: null,
      paid: true,
      leaveUnit: 'day',
      color: 'red',
      icon: 'heart',
    });
    const r = await row(id);
    expect(r.name).toBe('Wedding Leave (fictional)');
    expect(r.color).toBe('red');
    expect(r.icon).toBe('heart');
  });

  it('Default (empty) in either picker clears to null — the standard look', async () => {
    const code = uniqCode();
    const { id } = await createLeaveType(adminCtx(b), { code, name: 'Birthday Leave (fictional)', paid: true });
    await owner.db.update(schema.leaveType).set({ color: 'teal', icon: 'cake' }).where(eq(schema.leaveType.id, id));
    await updateLeaveType(adminCtx(b), {
      id,
      name: 'Birthday Leave (fictional)',
      newCode: code,
      description: null,
      paid: true,
      leaveUnit: 'day',
      color: null,
      icon: null,
    });
    const r = await row(id);
    expect(r.color).toBeNull();
    expect(r.icon).toBeNull();
  });
});
