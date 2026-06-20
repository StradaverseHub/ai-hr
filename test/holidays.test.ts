/** Public-holiday admin service (Bug 3): list / create / delete, RLS role-gating, DomainEvents. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { createHoliday, deleteHoliday, listHolidays, listHolidayYears, DuplicateError } from '../core/admin';

let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('public holidays — admin CRUD', () => {
  it('creates, lists, filters by year/country, and deletes — with domain events', async () => {
    const a = adminCtx(base);

    const h1 = await createHoliday(a, { country: 'MY', holidayDate: '2026-05-01', name: 'Labour Day' });
    await createHoliday(a, { country: 'MY', holidayDate: '2026-12-25', name: 'Christmas' });
    await createHoliday(a, { country: 'SG', holidayDate: '2026-08-09', name: 'National Day' });
    await createHoliday(a, { country: 'MY', holidayDate: '2025-05-01', name: 'Labour Day 2025' });

    // Unfiltered: all four, ordered by date.
    const all = await listHolidays(a);
    expect(all).toHaveLength(4);
    expect(all.map((h) => h.holidayDate)).toEqual([
      '2025-05-01',
      '2026-05-01',
      '2026-08-09',
      '2026-12-25',
    ]);

    // Filter by country.
    const my = await listHolidays(a, { country: 'MY' });
    expect(my.map((h) => h.country)).toEqual(['MY', 'MY', 'MY']);

    // Filter by year.
    const y2026 = await listHolidays(a, { year: 2026 });
    expect(y2026.map((h) => h.holidayDate)).toEqual(['2026-05-01', '2026-08-09', '2026-12-25']);

    // Combined filter.
    const my2026 = await listHolidays(a, { country: 'MY', year: 2026 });
    expect(my2026).toHaveLength(2);

    // Distinct years, descending.
    expect(await listHolidayYears(a)).toEqual([2026, 2025]);

    // Create event recorded.
    expect(await eventTypesFor(base.tenantId, h1.id)).toContain('holiday.created');

    // Delete + event.
    await deleteHoliday(a, { id: h1.id });
    expect(await listHolidays(a, { country: 'MY', year: 2026 })).toHaveLength(1);
    expect(await eventTypesFor(base.tenantId, h1.id)).toContain('holiday.deleted');
  });

  it('rejects a duplicate (same country + date)', async () => {
    const a = adminCtx(base);
    await createHoliday(a, { country: 'MY', holidayDate: '2026-05-01', name: 'Labour Day' });
    await expect(
      createHoliday(a, { country: 'MY', holidayDate: '2026-05-01', name: 'Dup' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('validates country and date shape', async () => {
    const a = adminCtx(base);
    await expect(createHoliday(a, { country: 'MYS', holidayDate: '2026-05-01', name: 'x' })).rejects.toThrow();
    await expect(createHoliday(a, { country: 'MY', holidayDate: '2026-5-1', name: 'x' })).rejects.toThrow();
    await expect(createHoliday(a, { country: 'MY', holidayDate: '2026-05-01', name: '  ' })).rejects.toThrow();
  });

  it('RLS: a non-admin session cannot create a holiday', async () => {
    const employee: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'] };
    await expect(
      createHoliday(employee, { country: 'MY', holidayDate: '2026-05-01', name: 'Sneaky' }),
    ).rejects.toThrow();
  });

  it('tenant isolation: holidays from another tenant are invisible', async () => {
    const a = adminCtx(base);
    await createHoliday(a, { country: 'MY', holidayDate: '2026-05-01', name: 'Labour Day' });

    const other = await seedBase();
    const otherAdmin = adminCtx(other);
    expect(await listHolidays(otherAdmin)).toHaveLength(0);
    // And the same date is free in the other tenant (unique index is per-tenant).
    await expect(
      createHoliday(otherAdmin, { country: 'MY', holidayDate: '2026-05-01', name: 'Their Labour Day' }),
    ).resolves.toBeTruthy();
  });
});
