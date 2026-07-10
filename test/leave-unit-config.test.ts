/**
 * Leave Unit Configuration (feedback e4980382).
 *
 * A leave type carries a coarse "Leave Unit" (Day | Hour) declaring whether it is managed/applied in whole
 * days or in hours. This is a labelling/reporting setting — it never changes entitlement, accrual, workflow
 * or payroll. This suite proves, end-to-end:
 *   (default)   createLeaveType with no leaveUnit → 'day'; an explicit 'hour' persists + rides the created event.
 *   (update)    updateLeaveType to 'hour' persists and emits a before/after diff on the leave-type.updated event.
 *   (no-clobber) a save from an UNRELATED sub-form (name-only, no leaveUnit marker) leaves leave_unit untouched.
 *   (validate)  an out-of-set value is rejected on both create and update.
 *   (legacy)    a row inserted with the column default (simulating an existing type) reads 'day'.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createLeaveType, updateLeaveType } from '../core/admin';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

const storedUnit = async (id: string): Promise<string> => {
  const [row] = await owner.db
    .select({ leaveUnit: schema.leaveType.leaveUnit })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return row.leaveUnit;
};

const mkCode = () => `LU_${randomUUID().slice(0, 6).toUpperCase()}`;

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

describe('Leave Unit Configuration', () => {
  it('defaults a newly created type to Day when no unit is given', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: mkCode(), name: 'Unitless' });
    expect(await storedUnit(id)).toBe('day');
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.created');
    expect(payload?.leaveUnit).toBe('day');
  });

  it('persists an explicit Hour unit on create and records it on the created event', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: mkCode(), name: 'Hourly', leaveUnit: 'hour' });
    expect(await storedUnit(id)).toBe('hour');
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.created');
    expect(payload?.leaveUnit).toBe('hour');
  });

  it('rejects an invalid unit on create', async () => {
    await expect(
      // @ts-expect-error deliberately out of the closed { day, hour } set
      createLeaveType(adminCtx(b), { code: mkCode(), name: 'Bad', leaveUnit: 'week' }),
    ).rejects.toThrow(/day or hour/i);
  });

  it('updates a type to Hour and emits a before/after diff', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: mkCode(), name: 'Switcher' });
    expect(await storedUnit(id)).toBe('day');

    await updateLeaveType(adminCtx(b), { id, name: 'Switcher', leaveUnit: 'hour' });
    expect(await storedUnit(id)).toBe('hour');

    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before.leaveUnit).toBe('day');
    expect(after.leaveUnit).toBe('hour');
  });

  it('rejects an invalid unit on update', async () => {
    const { id } = await createLeaveType(adminCtx(b), { code: mkCode(), name: 'Guard' });
    await expect(
      // @ts-expect-error deliberately out of the closed { day, hour } set
      updateLeaveType(adminCtx(b), { id, name: 'Guard', leaveUnit: 'minute' }),
    ).rejects.toThrow(/day or hour/i);
    // unchanged
    expect(await storedUnit(id)).toBe('day');
  });

  it('leaves leave_unit UNTOUCHED when an unrelated sub-form saves (no-clobber guard)', async () => {
    // Configure Hour, then simulate a name-only edit (no leaveUnit key ⇒ tri-state undefined).
    const { id } = await createLeaveType(adminCtx(b), { code: mkCode(), name: 'Keep', leaveUnit: 'hour' });
    expect(await storedUnit(id)).toBe('hour');

    await updateLeaveType(adminCtx(b), { id, name: 'Keep Renamed' });
    expect(await storedUnit(id)).toBe('hour'); // the rename must not reset it

    // and the diff of the rename must NOT carry a leaveUnit key (it wasn't touched)
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    const after = payload?.after as Record<string, unknown>;
    expect('leaveUnit' in after).toBe(false);
  });

  it('reads Day for a row created with the column default (existing-type back-compat)', async () => {
    // Insert a leave type WITHOUT specifying leaveUnit — mirrors a pre-migration row after the additive
    // NOT NULL DEFAULT 'day' column is added.
    const [row] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: mkCode(), name: 'Legacy', paid: true })
      .returning({ id: schema.leaveType.id });
    expect(await storedUnit(row.id)).toBe('day');
  });
});
