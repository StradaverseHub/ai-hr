/**
 * PH calendars by location (ADR-0067) — resolution correctness for the three archetypes, the
 * location→calendar mapping, the unmapped-location backward-compat guard, the s.60D completeness
 * suppression for Custom calendars, the delete guard, the single-row join guard, and RLS.
 *
 * A "calendar" is a holiday_group row carrying an `archetype` (standard|extended|custom), MAPPED to a
 * location via location.holiday_group_id. Every employee whose OPEN assignment points at that location
 * follows the calendar automatically for leave counting (and attendance, through the shared resolver).
 *
 * Window: Mon 2026-07-20 → Fri 2026-07-24 = 5 working days. National holiday (Tue 21st) applies to
 * everyone; a company ad-hoc day (Wed 22nd) and a Sarawak state holiday (Thu 23rd) vary by calendar.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { createHolidayGroup, deleteHolidayGroup, listHolidayGroups } from '../core/admin';
import { createLocation, listLocations, updateLocation } from '../core/location';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { effectiveHolidayState, holidayDatesFor } from '../core/holidays';
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

let b: Base;
let wdTypeId: string;

const START = '2026-07-20';
const END = '2026-07-24';
const NATIONAL = '2026-07-21'; // Tue — national, applies to everyone
const ADHOC = '2026-07-22'; // Wed — a company-defined ad-hoc day (company-scoped holiday row)
const SARAWAK = '2026-07-23'; // Thu — a Sarawak state holiday

const hire = async () => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'C', primaryEmail: `c_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
};

/** Point the employee's OPEN assignment at a location (the link the resolver reads). */
const setLocation = async (employmentId: string, locationId: string) =>
  owner.db
    .update(schema.assignment)
    .set({ locationId })
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    );

const makeLocation = async (code: string, holidayGroupId: string | null, state: string | null = null) => {
  const { id } = await createLocation(adminCtx(b), {
    companyId: b.companyId,
    code,
    name: code,
    state,
    holidayGroupId,
  });
  return id;
};

const daysFor = async (employmentId: string) =>
  (await requestLeave(adminCtx(b), { employmentId, leaveTypeId: wdTypeId, startDate: START, endDate: END })).days;

const datesFor = async (employmentId: string) =>
  withTenant(adminCtx(b), (tx) => holidayDatesFor(tx, { employmentId, startDate: START, endDate: END }));

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
  // Default company has no work-state so an unmapped employee resolves national-only (clean control).
  await owner.db.update(schema.company).set({ defaultWorkState: null }).where(eq(schema.company.id, b.companyId));
  // Only the public gazette (national + a Sarawak state day) is loaded globally. The company-scoped ad-hoc
  // day is added per-test (via seedAdHoc) ONLY for the Extended/Custom cases, so it can't trip the existing
  // Step-1 business-group override (ADR-0055 single-winner) in the Standard/unmapped controls.
  await owner.db.insert(schema.holiday).values([
    { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: NATIONAL, name: 'National Holiday' },
    { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: SARAWAK, name: 'Sarawak Day' },
  ]);
});

/** Add the company-scoped ad-hoc day (a "company-defined extra day") on the seedBase company. */
const seedAdHoc = () =>
  owner.db
    .insert(schema.holiday)
    .values({ tenantId: b.tenantId, country: 'MY', state: null, companyId: b.companyId, holidayDate: ADHOC, name: 'Founders Day' });
afterAll(async () => {
  await closeAll();
});

describe('ADR-0067 — archetype resolution through holidayDatesFor', () => {
  it('UNMAPPED location is byte-identical to today (national-only): 4 working days', async () => {
    // Control: an employee at an unmapped location (and another with no location at all) resolves exactly
    // as before — national holiday only. This is the load-bearing backward-compat guard.
    const unmappedLoc = await makeLocation('UNMAP', null);
    const atUnmapped = await hire();
    await setLocation(atUnmapped, unmappedLoc);
    const noLocation = await hire();

    expect([...(await datesFor(atUnmapped))]).toEqual([NATIONAL]);
    expect([...(await datesFor(noLocation))]).toEqual([NATIONAL]);
    expect(await daysFor(atUnmapped)).toBe(4); // 5 − national only
    expect(await daysFor(noLocation)).toBe(4);
  });

  it('STANDARD calendar = the existing gazette path (national ∪ calendar.states), identical to an unmapped control', async () => {
    // Standard with Sarawak in its states behaves exactly like a Sarawak-state resolution: national + Sarawak.
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Std Sarawak', states: ['Sarawak'], archetype: 'standard' });
    const loc = await makeLocation('STD', cal.id);
    const emp = await hire();
    await setLocation(emp, loc);

    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true);
    expect(dates.has(SARAWAK)).toBe(true);
    expect(dates.has(ADHOC)).toBe(false); // standard does NOT pull in company ad-hoc days
    expect(await daysFor(emp)).toBe(3); // 5 − national − Sarawak
  });

  it('EXTENDED calendar adds the company ad-hoc day ON TOP of the gazette', async () => {
    await seedAdHoc();
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Ext Sarawak', states: ['Sarawak'], archetype: 'extended' });
    const loc = await makeLocation('EXT', cal.id);
    const emp = await hire();
    await setLocation(emp, loc);

    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true); // gazette national
    expect(dates.has(SARAWAK)).toBe(true); // gazette state (calendar.states)
    expect(dates.has(ADHOC)).toBe(true); // ∪ company ad-hoc day
    expect(await daysFor(emp)).toBe(2); // 5 − national − Sarawak − ad-hoc
  });

  it('CUSTOM calendar = ONLY the company ad-hoc day; a national date it omits counts as a working day', async () => {
    await seedAdHoc();
    // Custom calendars need no states; the gazette is deliberately ignored.
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Site Custom', states: [], archetype: 'custom' });
    const loc = await makeLocation('CUS', cal.id);
    const emp = await hire();
    await setLocation(emp, loc);

    const dates = await datesFor(emp);
    expect([...dates]).toEqual([ADHOC]); // only the hand-loaded company day
    expect(dates.has(NATIONAL)).toBe(false); // the national holiday is NOT subtracted → a working day
    expect(await daysFor(emp)).toBe(4); // 5 − ad-hoc only (national counts as a normal working day)
  });

  it('the location mapping DRIVES the calendar: two employees at different-archetype locations diverge', async () => {
    // No company ad-hoc row here, so Standard falls cleanly through to the gazette path. A Custom calendar
    // with nothing hand-loaded subtracts NOTHING (the gazette is ignored) → every day is a working day.
    const std = await createHolidayGroup(adminCtx(b), { name: 'S', states: ['Sarawak'], archetype: 'standard' });
    const cus = await createHolidayGroup(adminCtx(b), { name: 'C', states: [], archetype: 'custom' });
    const empStd = await hire();
    await setLocation(empStd, await makeLocation('A', std.id));
    const empCus = await hire();
    await setLocation(empCus, await makeLocation('B', cus.id));
    expect(await daysFor(empStd)).toBe(3); // national + Sarawak excluded (gazette)
    expect(await daysFor(empCus)).toBe(5); // nothing excluded — custom with no hand-loaded dates
  });
});

describe('ADR-0067 — state ↔ calendar conflict: the calendar wins', () => {
  it('a location with BOTH a state AND a mapped calendar uses the calendar.states[]; resolver and effState agree', async () => {
    // Location.state = Selangor, but the mapped Standard calendar says Sarawak. The named calendar wins.
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Cal Sarawak', states: ['Sarawak'], archetype: 'standard' });
    const loc = await makeLocation('CONFLICT', cal.id, 'Selangor');
    const emp = await hire();
    await setLocation(emp, loc);

    const dates = await datesFor(emp);
    expect(dates.has(SARAWAK)).toBe(true); // calendar's Sarawak applied (NOT the location's Selangor)
    const eff = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, emp));
    expect(eff?.state).toBe('Sarawak'); // completeness guard agrees on the same state
  });
});

describe('ADR-0067 — single-row join guard', () => {
  it('a mapped-location employee does not fan out the .limit(1) employment select (one resolved date set)', async () => {
    await seedAdHoc();
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Ext', states: ['Sarawak'], archetype: 'extended' });
    const emp = await hire();
    await setLocation(emp, await makeLocation('SOLO', cal.id));
    // Extended resolves national + Sarawak + ad-hoc, each EXACTLY once (a join fan-out would duplicate, but
    // a Set collapses duplicates so we additionally assert the count equals the 3 distinct dates).
    const dates = await datesFor(emp);
    expect(dates.size).toBe(3);
    expect([...dates].sort()).toEqual([NATIONAL, ADHOC, SARAWAK].sort());
  });
});

describe('ADR-0067 — s.60D completeness guard stays QUIET for Custom calendars', () => {
  it('a Custom-calendar employee (location still carries a state) does NOT emit holiday.completeness.warned', async () => {
    // Only 1 national holiday loaded → well under the 11 minimum. A normal employee WOULD warn.
    const cus = await createHolidayGroup(adminCtx(b), { name: 'Hand', states: [], archetype: 'custom' });
    const loc = await makeLocation('HAND', cus.id, 'Selangor'); // location still carries a state on purpose
    const emp = await hire();
    await setLocation(emp, loc);

    const res = await requestLeave(adminCtx(b), { employmentId: emp, leaveTypeId: wdTypeId, startDate: START, endDate: END });
    expect(res.holidayWarnings).toBeUndefined();
    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).not.toContain('holiday.completeness.warned');
  });

  it('a Standard/Extended employee with an under-loaded gazette STILL warns (the guard is meaningful there)', async () => {
    const std = await createHolidayGroup(adminCtx(b), { name: 'StdSel', states: ['Selangor'], archetype: 'standard' });
    const loc = await makeLocation('STDSEL', std.id);
    const emp = await hire();
    await setLocation(emp, loc);

    const res = await requestLeave(adminCtx(b), { employmentId: emp, leaveTypeId: wdTypeId, startDate: START, endDate: END });
    expect(res.holidayWarnings).toBeTruthy();
    expect(res.holidayWarnings![0]).toMatchObject({ state: 'Selangor', year: 2026 });
    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).toContain('holiday.completeness.warned');
  });
});

describe('ADR-0067 — delete guard covers location references', () => {
  it('deleteHolidayGroup throws InUseError when a LOCATION (not just an employment) maps to it', async () => {
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Mapped', states: ['Sarawak'], archetype: 'standard' });
    await makeLocation('MAP', cal.id);
    await expect(deleteHolidayGroup(adminCtx(b), { id: cal.id })).rejects.toThrow(/location/i);
  });

  it('un-mapping the location lets the calendar delete', async () => {
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Free', states: ['Sarawak'], archetype: 'standard' });
    const loc = await makeLocation('FREE', cal.id);
    await updateLocation(adminCtx(b), { locationId: loc, code: 'FREE', name: 'FREE', holidayGroupId: null });
    await expect(deleteHolidayGroup(adminCtx(b), { id: cal.id })).resolves.toBeUndefined();
  });
});

describe('ADR-0067 — config CRUD threads archetype + mapping, with events', () => {
  it('create/list a calendar carries its archetype; location list shows the mapped name + archetype', async () => {
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Cal X', states: ['Sarawak'], archetype: 'extended' });
    const groups = await listHolidayGroups(adminCtx(b));
    expect(groups.find((g) => g.id === cal.id)?.archetype).toBe('extended');
    expect(await eventTypesFor(b.tenantId, cal.id)).toContain('holiday-group.created');

    const loc = await makeLocation('LX', cal.id);
    const rows = await listLocations(adminCtx(b), [b.companyId]);
    const row = rows.find((r) => r.id === loc)!;
    expect(row.holidayGroupId).toBe(cal.id);
    expect(row.holidayGroupName).toBe('Cal X');
    expect(row.holidayGroupArchetype).toBe('extended');
    expect(await eventTypesFor(b.tenantId, loc)).toContain('location.created');
  });
});

describe('ADR-0067 — RLS: a foreign tenant cannot see another tenant’s calendars/mappings', () => {
  it('listHolidayGroups + listLocations are tenant-isolated', async () => {
    const cal = await createHolidayGroup(adminCtx(b), { name: 'TenantA Cal', states: ['Sarawak'], archetype: 'custom' });
    await makeLocation('TA', cal.id);

    // A second tenant with its own admin context.
    const other = await seedBase();
    const otherGroups = await listHolidayGroups(adminCtx(other));
    expect(otherGroups.find((g) => g.id === cal.id)).toBeUndefined();
    const otherLocs = await listLocations(adminCtx(other), [other.companyId]);
    expect(otherLocs.find((r) => r.holidayGroupId === cal.id)).toBeUndefined();
  });
});
