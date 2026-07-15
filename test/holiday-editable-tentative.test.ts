/**
 * Follow-on #15b (ADR-0063) — editable + tentative state holidays.
 *
 * Covers the missing CRUD op `updateHoliday` (edit date + name, event-logged, collision → DuplicateError,
 * missing id → throw) and the new `tentative` flag (create with it; flipping it persists; a tentative
 * holiday STILL counts as a holiday in working-day leave counting — it must NOT be excluded).
 *
 * Working-day window (reused from state-holidays.test.ts): Mon 2026-07-20 → Fri 2026-07-24 = 5 working days.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { createHoliday, updateHoliday, listHolidays, DuplicateError } from '../core/admin';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let wdTypeId: string;

const hire = async (workState: string | null) => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'HE', primaryEmail: `he_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  if (workState) await owner.db.update(schema.employment).set({ workState }).where(eq(schema.employment.id, e.employmentId));
  return e;
};
const daysFor = async (employmentId: string) =>
  (await requestLeave(adminCtx(b), { employmentId, leaveTypeId: wdTypeId, startDate: '2026-07-20', endDate: '2026-07-24' })).days;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'WD', name: 'Working-day leave', paid: true, counting: 'working_days' })
    .returning({ id: schema.leaveType.id });
  wdTypeId = lt.id;
});
afterAll(async () => {
  await closeAll();
});

describe('updateHoliday — edit date + name (the missing CRUD op)', () => {
  it('updates a holiday date and name and appends holiday.updated with before/after', async () => {
    const { id } = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-21',
      name: 'Provisional Ruler Birthday',
      state: 'Selangor',
    });
    await updateHoliday(adminCtx(b), { id, holidayDate: '2026-07-23', name: 'Ruler Birthday (gazetted)' });

    const [row] = await owner.db
      .select({ d: schema.holiday.holidayDate, n: schema.holiday.name, s: schema.holiday.state })
      .from(schema.holiday)
      .where(eq(schema.holiday.id, id));
    expect(row.d).toBe('2026-07-23');
    expect(row.n).toBe('Ruler Birthday (gazetted)');
    expect(row.s).toBe('Selangor'); // scope immutable

    expect(await eventTypesFor(b.tenantId, id)).toContain('holiday.updated');
    const payload = await latestEventPayload(b.tenantId, id, 'holiday.updated');
    expect((payload?.before as Record<string, unknown>)?.holidayDate).toBe('2026-07-21');
    expect((payload?.before as Record<string, unknown>)?.name).toBe('Provisional Ruler Birthday');
    expect((payload?.after as Record<string, unknown>)?.holidayDate).toBe('2026-07-23');
    expect((payload?.after as Record<string, unknown>)?.name).toBe('Ruler Birthday (gazetted)');
    // scope-in-audit (mirrors create): state carried on both sides
    expect((payload?.after as Record<string, unknown>)?.state).toBe('Selangor');
  });

  it('moving a date onto an existing holiday throws DuplicateError', async () => {
    await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'National A' });
    const { id } = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-22', name: 'National B' });
    await expect(updateHoliday(adminCtx(b), { id, holidayDate: '2026-07-21' })).rejects.toBeInstanceOf(DuplicateError);
  });

  it('updating a missing id throws', async () => {
    await expect(
      updateHoliday(adminCtx(b), { id: randomUUID(), name: 'Nope' }),
    ).rejects.toThrow();
  });

  it('rejects a malformed date (same YYYY-MM-DD guard as create)', async () => {
    const { id } = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'National' });
    await expect(updateHoliday(adminCtx(b), { id, holidayDate: '21-07-2026' })).rejects.toThrow();
  });
});

describe('tentative flag', () => {
  it('createHoliday with tentative:true stores it; listHolidays returns it', async () => {
    const { id } = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-22',
      name: 'Unconfirmed State Holiday',
      state: 'Sarawak',
      tentative: true,
    });
    const [row] = await owner.db
      .select({ t: schema.holiday.tentative })
      .from(schema.holiday)
      .where(eq(schema.holiday.id, id));
    expect(row.t).toBe(true);

    const listed = await listHolidays(adminCtx(b), {});
    const found = listed.find((h) => h.id === id);
    expect(found?.tentative).toBe(true);
  });

  it('flipping tentative true→false (confirm) persists and is event-logged', async () => {
    const { id } = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-22',
      name: 'State Holiday',
      state: 'Sarawak',
      tentative: true,
    });
    await updateHoliday(adminCtx(b), { id, tentative: false });
    const [row] = await owner.db
      .select({ t: schema.holiday.tentative })
      .from(schema.holiday)
      .where(eq(schema.holiday.id, id));
    expect(row.t).toBe(false);

    const payload = await latestEventPayload(b.tenantId, id, 'holiday.updated');
    expect((payload?.before as Record<string, unknown>)?.tentative).toBe(true);
    expect((payload?.after as Record<string, unknown>)?.tentative).toBe(false);
  });

  it('a tentative holiday STILL counts as a holiday in working-day leave counting (not excluded)', async () => {
    // National Tue 21st (confirmed) + Sarawak Wed 22nd (TENTATIVE). A Sarawak employee taking Mon–Fri must
    // get 3 working days (5 − both) — the tentative Sarawak day MUST be excluded from working days too.
    await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-21', name: 'National Holiday' });
    await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-07-22',
      name: 'Tentative Sarawak Day',
      state: 'Sarawak',
      tentative: true,
    });
    const sarawak = await hire('Sarawak');
    expect(await daysFor(sarawak.employmentId)).toBe(3); // 5 − national − tentative Sarawak
  });
});
