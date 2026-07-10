/**
 * f3321963 — Shift Settings Enhancement & Simplified Shift Configuration (Phase 1).
 *
 * Covers the additive, backward-compatible shift-TEMPLATE-type foundation:
 *   1. Backward-compat / tri-state default — a shift created WITHOUT `type` stores 'normal' (the DB default),
 *      so every legacy row and every existing caller keeps today's exact behaviour.
 *   2. The three-value enum is validated + persisted (normal / semi_flexi / full_flexi); an out-of-enum value
 *      is rejected before it can reach the DB CHECK.
 *   3. Semi-Flexi FORCES the per-break Flexible=true / Clocking-Required=false flags (the reporter's fixed,
 *      non-editable rule), regardless of what was supplied; Normal keeps supplied flags (or none).
 *   4. Substrate — createShift / updateShift append shift.created / shift.updated DomainEvents carrying `type`.
 *   5. updateShift can migrate an existing Normal shift to Semi-Flexi (and re-coerces its break flags).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createShift, updateShift, listShifts } from '../core/roster';

let b: Base;

const storedShift = async (id: string) => {
  const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, id));
  return row;
};

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

describe('f3321963 shift template type', () => {
  it('defaults to "normal" when type is omitted (backward compatible)', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'Legacy',
      code: `LEG_${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    });
    const row = await storedShift(s.id);
    expect(row.type).toBe('normal');
    // listShifts (the read the admin page uses) surfaces the type.
    const list = await listShifts(a, b.companyId);
    expect(list.find((x) => x.id === s.id)?.type).toBe('normal');
  });

  it('persists an explicit semi_flexi type', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'Flexi',
      code: `SF_${randomUUID().slice(0, 6)}`,
      type: 'semi_flexi',
      startTime: '07:00:00',
      endTime: '19:00:00',
      breakMinutes: 60,
    });
    expect((await storedShift(s.id)).type).toBe('semi_flexi');
  });

  it('rejects an out-of-enum type value', async () => {
    const a = adminCtx(b);
    await expect(
      createShift(a, {
        companyId: b.companyId,
        name: 'Bad',
        code: `BAD_${randomUUID().slice(0, 6)}`,
        // @ts-expect-error — deliberately invalid
        type: 'weird',
        startTime: '09:00:00',
        endTime: '18:00:00',
        breakMinutes: 60,
      }),
    ).rejects.toThrow(/Invalid shift type/i);
  });

  it('Semi-Flexi forces break flags Flexible=true / Clocking=false, overriding supplied values', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'SemiBreaks',
      code: `SFB_${randomUUID().slice(0, 6)}`,
      type: 'semi_flexi',
      startTime: '07:00:00',
      endTime: '19:00:00',
      breakPeriods: [
        // supply the OPPOSITE of the forced values to prove the coercion.
        { start: '12:00', end: '13:00', flexible: false, clockingRequired: true },
      ],
    });
    const row = await storedShift(s.id);
    expect(row.breakPeriods).toHaveLength(1);
    expect(row.breakPeriods![0].flexible).toBe(true);
    expect(row.breakPeriods![0].clockingRequired).toBe(false);
    // canonical scalar = 60 minutes (12:00–13:00)
    expect(row.breakMinutes).toBe(60);
  });

  it('Normal keeps a plain break as { start, end } with no forced flags', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'NormalBreaks',
      code: `NB_${randomUUID().slice(0, 6)}`,
      // type omitted ⇒ normal
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakPeriods: [{ start: '13:00', end: '14:00' }],
    });
    const row = await storedShift(s.id);
    expect(row.breakPeriods![0]).toEqual({ start: '13:00:00', end: '14:00:00' });
    expect(row.breakPeriods![0].flexible).toBeUndefined();
    expect(row.breakPeriods![0].clockingRequired).toBeUndefined();
  });

  it('updateShift migrates Normal → Semi-Flexi and re-coerces its break flags; both writes append events', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'Migrating',
      code: `MIG_${randomUUID().slice(0, 6)}`,
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakPeriods: [{ start: '12:00', end: '13:00', flexible: false, clockingRequired: true }],
    });
    // Normal keeps the supplied flags.
    let row = await storedShift(s.id);
    expect(row.type).toBe('normal');
    expect(row.breakPeriods![0].flexible).toBe(false);
    expect(row.breakPeriods![0].clockingRequired).toBe(true);

    await updateShift(a, {
      shiftId: s.id,
      name: 'Migrating',
      code: row.code!,
      type: 'semi_flexi',
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakPeriods: [{ start: '12:00', end: '13:00', flexible: false, clockingRequired: true }],
    });
    row = await storedShift(s.id);
    expect(row.type).toBe('semi_flexi');
    expect(row.breakPeriods![0].flexible).toBe(true);
    expect(row.breakPeriods![0].clockingRequired).toBe(false);

    const events = await eventTypesFor(b.tenantId, s.id);
    expect(events).toContain('shift.created');
    expect(events).toContain('shift.updated');
  });
});
