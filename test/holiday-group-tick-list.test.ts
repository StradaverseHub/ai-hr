/**
 * 66b8f5a8 — Holiday Module Enhancement & Centralized Holiday Group Management.
 *
 * Covers the four load-bearing pieces of the build:
 *   1. Holiday MASTER fields (holiday_code / holiday_type / description / active) round-trip through
 *      createHoliday → listHolidays → updateHoliday, and default backward-compatibly (type 'public',
 *      active true) for a bare create.
 *   2. The holiday_group_holiday junction: setGroupHolidays / listGroupHolidayIds round-trip, the add/remove
 *      delta, and a holiday-group.holidays.set DomainEvent per write (substrate discipline).
 *   3. Junction RLS: a non-admin ai_hr_app principal cannot write the junction (owner.db would bypass RLS
 *      and prove nothing); a tenant member CAN read it (the resolver path).
 *   4. THE CRITICAL COMPLIANCE DECISION — the resolver UNIONs explicitly-ticked holidays WITH the existing
 *      Malaysian state auto-resolution + inheritance, rather than replacing it. Proven end-to-end through
 *      holidayDatesFor: ticking a Johor holiday into a Sarawak group ADDS Johor WITHOUT dropping the
 *      automatic national + Sarawak resolution.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  createHoliday,
  createHolidayGroup,
  listGroupHolidayIds,
  listHolidays,
  setGroupHolidays,
  updateHoliday,
} from '../core/admin';
import { hireEmployee, setEmploymentHolidayCalendar } from '../core/org';
import { holidayDatesFor } from '../core/holidays';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { withTenant, type SessionContext } from '../db/client';

let b: Base;

const hire = async () => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'TL', primaryEmail: `tl_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('holiday master fields (migration 0190)', () => {
  it('round-trips holiday_code / holiday_type / description / active and defaults backward-compatibly', async () => {
    // A bare create (no master fields) must default to type 'public' + active true — byte-compatible with
    // every existing gazette row.
    await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-01-01', name: 'New Year' });
    // A fully-specified create.
    const cny = await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: '2026-02-17',
      name: 'Chinese New Year',
      holidayCode: 'CNY',
      holidayType: 'company',
      description: 'Two-day company holiday',
      active: false,
    });

    const listed = await listHolidays(adminCtx(b), { country: 'MY' });
    const ny = listed.find((h) => h.name === 'New Year')!;
    expect(ny.holidayType).toBe('public');
    expect(ny.active).toBe(true);
    expect(ny.holidayCode).toBeNull();

    const cnyRow = listed.find((h) => h.name === 'Chinese New Year')!;
    expect(cnyRow.holidayCode).toBe('CNY');
    expect(cnyRow.holidayType).toBe('company');
    expect(cnyRow.description).toBe('Two-day company holiday');
    expect(cnyRow.active).toBe(false);

    // Update flips the master fields; scope stays untouched.
    await updateHoliday(adminCtx(b), { id: cny.id, holidayType: 'optional', active: true, holidayCode: null });
    const after = (await listHolidays(adminCtx(b), { country: 'MY' })).find((h) => h.id === cny.id)!;
    expect(after.holidayType).toBe('optional');
    expect(after.active).toBe(true);
    expect(after.holidayCode).toBeNull();
  });

  it('rejects an unknown holiday_type', async () => {
    await expect(
      createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-05-01', name: 'X', holidayType: 'bogus' }),
    ).rejects.toThrow();
  });
});

describe('holiday_group_holiday junction (tick-list)', () => {
  it('sets, lists, and re-sets a group\'s ticked holidays with a DomainEvent per write', async () => {
    const g = await createHolidayGroup(adminCtx(b), { name: 'Grp', states: ['Sarawak'] });
    const h1 = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-01-01', name: 'A' });
    const h2 = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-02-01', name: 'B' });
    const h3 = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-03-01', name: 'C' });

    await setGroupHolidays(adminCtx(b), { groupId: g.id, holidayIds: [h1.id, h2.id] });
    expect((await listGroupHolidayIds(adminCtx(b), { groupId: g.id })).sort()).toEqual([h1.id, h2.id].sort());

    // Re-set to a different set — delta = add h3, remove h1.
    await setGroupHolidays(adminCtx(b), { groupId: g.id, holidayIds: [h2.id, h3.id] });
    expect((await listGroupHolidayIds(adminCtx(b), { groupId: g.id })).sort()).toEqual([h2.id, h3.id].sort());

    const payload = await latestEventPayload(b.tenantId, g.id, 'holiday-group.holidays.set');
    expect(payload).toBeTruthy();
    expect((payload!.added as string[]).sort()).toEqual([h3.id]);
    expect((payload!.removed as string[]).sort()).toEqual([h1.id]);
    expect(await eventTypesFor(b.tenantId, g.id)).toEqual(
      expect.arrayContaining(['holiday-group.created', 'holiday-group.holidays.set']),
    );
  });

  it('persists ticked holidays passed straight to createHolidayGroup', async () => {
    const h1 = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-01-01', name: 'A' });
    const g = await createHolidayGroup(adminCtx(b), { name: 'Grp2', states: ['Sabah'], holidayIds: [h1.id] });
    expect(await listGroupHolidayIds(adminCtx(b), { groupId: g.id })).toEqual([h1.id]);
  });

  it('rejects a non-admin junction write under RLS, allows a member READ', async () => {
    const g = await createHolidayGroup(adminCtx(b), { name: 'Grp3', states: ['Sabah'] });
    const h1 = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-01-01', name: 'A' });
    const h2 = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-02-01', name: 'B' });
    await setGroupHolidays(adminCtx(b), { groupId: g.id, holidayIds: [h1.id] });

    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Emp', primaryEmail: `emp_${randomUUID().slice(0, 8)}@t.local` })
      .returning({ id: schema.person.id });
    const empUserId = await createAppUser(b.tenantId, p.id, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: empUserId, roles: ['employee'] };

    // A junction INSERT (ticking h2) is rejected — is_admin() is false in the policy WITH CHECK (mirrors
    // holiday_group's 0100 policy: FOR ALL USING(tenant) WITH CHECK(tenant AND is_admin)).
    await expect(setGroupHolidays(empCtx, { groupId: g.id, holidayIds: [h1.id, h2.id] })).rejects.toThrow();
    // Read allowed (the resolver SELECTs the junction as any tenant member).
    const visible = await withTenant(empCtx, (tx) =>
      tx.select({ id: schema.holidayGroupHoliday.id }).from(schema.holidayGroupHoliday),
    );
    expect(visible).toHaveLength(1);
  });
});

describe('resolver UNION — ticked holidays ADD without dropping state auto-resolution', () => {
  const START = '2026-07-20';
  const END = '2026-07-24';
  const datesFor = (employmentId: string) =>
    withTenant(adminCtx(b), (tx) => holidayDatesFor(tx, { employmentId, startDate: START, endDate: END }));

  beforeEach(async () => {
    // National (everyone), Sarawak-only, and Johor-only holidays in the window.
    await owner.db.insert(schema.holiday).values([
      { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: '2026-07-21', name: 'National' },
      { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: '2026-07-22', name: 'Sarawak Day' },
      { tenantId: b.tenantId, country: 'MY', state: 'Johor', holidayDate: '2026-07-23', name: 'Johor Day' },
    ]);
  });

  it('preserves automatic national + state resolution, then UNIONs the ticked holiday', async () => {
    const emp = await hire();
    const g = await createHolidayGroup(adminCtx(b), { name: 'SarawakGrp', states: ['Sarawak'] });
    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: emp, selection: { kind: 'group', groupId: g.id } });

    // Base: automatic national(21) + Sarawak(22); NOT Johor(23).
    const base = await datesFor(emp);
    expect(base.has('2026-07-21')).toBe(true);
    expect(base.has('2026-07-22')).toBe(true);
    expect(base.has('2026-07-23')).toBe(false);

    // Tick the Johor holiday into the group.
    const johor = (await listHolidays(adminCtx(b), { country: 'MY' })).find((h) => h.name === 'Johor Day')!;
    await setGroupHolidays(adminCtx(b), { groupId: g.id, holidayIds: [johor.id] });

    // Now: national(21) + Sarawak(22) STILL resolved automatically + Johor(23) added by the tick.
    const after = await datesFor(emp);
    expect(after.has('2026-07-21')).toBe(true); // national auto-resolution preserved
    expect(after.has('2026-07-22')).toBe(true); // Sarawak state auto-resolution preserved
    expect(after.has('2026-07-23')).toBe(true); // ticked Johor holiday UNIONed in
  });

  it('an employee with no group is unaffected by ticks (chain empty)', async () => {
    const emp = await hire(); // no holiday calendar assigned → national-only
    const g = await createHolidayGroup(adminCtx(b), { name: 'OtherGrp', states: ['Sarawak'] });
    const johor = (await listHolidays(adminCtx(b), { country: 'MY' })).find((h) => h.name === 'Johor Day')!;
    await setGroupHolidays(adminCtx(b), { groupId: g.id, holidayIds: [johor.id] });

    const dates = await datesFor(emp);
    expect(dates.has('2026-07-21')).toBe(true); // national
    expect(dates.has('2026-07-22')).toBe(false); // not Sarawak
    expect(dates.has('2026-07-23')).toBe(false); // a ticked holiday on a group this employee isn't in
  });
});
