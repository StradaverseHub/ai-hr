/**
 * ADR-0086 (r331) — PH CALENDARS BY LOCATION, REVERSED. This file pinned ADR-0067's decision and is
 * UPDATED to pin its reversal rather than deleted (CLAUDE.md §8: a guard pinning a decision you are
 * reversing is updated, with the reason). What each assertion says has flipped; the fixtures have not.
 *
 * WHAT ADR-0067 DECIDED, and what r331 took back. A "calendar" is a holiday_group row carrying an
 * `archetype` (standard|extended|custom). ADR-0067 §(b) let a `location` be MAPPED to one via
 * `location.holiday_group_id`, and §(c) made the resolver read the employee's OPEN assignment's location —
 * both its `state` (the top of the precedence) and its mapped calendar (which outranked everything). Item
 * 0fe1ca2e retired the work-site register on the reporter's say-so after it was measured unused on
 * production: 8 sites, NONE mapping a calendar, 1 open assignment whose employee's `work_state` already
 * carried the site's state, `holidays MOVE 0` (ADR-0086 §2).
 *
 * ADR-0067 §(a) — the archetype itself — SURVIVES, and so does assigning a calendar directly on the
 * person via `employment.holiday_group_id`. Only the site door closed, and this file keeps one case of
 * each archetype reaching an employee DIRECTLY, so "the archetype still works" is proved here and not
 * merely asserted to live in another file.
 *
 * ⚠️ THE PAIRING GUARD IS THE LOAD-BEARING ONE. `holidayDatesFor` (attendance, the working-day leave
 * count) and `effectiveHolidayState` (the s.60D completeness guard, core/leave.ts) are different code
 * paths that must agree about which gazette a person follows. They lost the site join in ONE commit, and
 * the "resolver and effState agree" test below is what makes that enforceable rather than remembered —
 * it is why ADR-0086 §6 orders the two functions together.
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
import { hireEmployee, setEmploymentHolidayCalendar } from '../core/org';
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

/** Assign a calendar DIRECTLY on the employment — the door ADR-0086 deliberately leaves open. */
const setGroup = async (employmentId: string, holidayGroupId: string) =>
  setEmploymentHolidayCalendar(adminCtx(b), { employmentId, selection: { kind: 'group', groupId: holidayGroupId } });

describe('ADR-0086 — a work site no longer decides anybody’s calendar', () => {
  it('UNMAPPED location is national-only, exactly as it always was (the untouched control)', async () => {
    const unmappedLoc = await makeLocation('UNMAP', null);
    const atUnmapped = await hire();
    await setLocation(atUnmapped, unmappedLoc);
    const noLocation = await hire();

    expect([...(await datesFor(atUnmapped))]).toEqual([NATIONAL]);
    expect([...(await datesFor(noLocation))]).toEqual([NATIONAL]);
    expect(await daysFor(atUnmapped)).toBe(4); // 5 − national only
    expect(await daysFor(noLocation)).toBe(4);
  });

  it('a site’s STANDARD calendar no longer reaches its staff — was national ∪ Sarawak, is national only', async () => {
    // ⚠️ MUTATION TARGET. Restore the location join in core/holidays.ts and `dates.has(SARAWAK)` is true
    // again; without this assertion the whole file would be true of a rung that never ran.
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Std Sarawak', states: ['Sarawak'], archetype: 'standard' });
    const loc = await makeLocation('STD', cal.id);
    const emp = await hire();
    await setLocation(emp, loc);

    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true);
    expect(dates.has(SARAWAK), 'the site calendar’s Sarawak is not applied').toBe(false);
    expect(await daysFor(emp)).toBe(4); // 5 − national (was 3: 5 − national − Sarawak)

    // The mapping is still ON THE ROW. The reader changed; the data did not vanish underneath the test.
    const row = (await listLocations(adminCtx(b), [b.companyId])).find((r) => r.id === loc)!;
    expect(row.holidayGroupId).toBe(cal.id);
  });

  it('a site’s EXTENDED calendar no longer adds the company ad-hoc day through the site', async () => {
    await seedAdHoc();
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Ext Sarawak', states: ['Sarawak'], archetype: 'extended' });
    const emp = await hire();
    await setLocation(emp, await makeLocation('EXT', cal.id));

    const dates = await datesFor(emp);
    // The ad-hoc day still lands — but through the Step-1 company-subtree override (ADR-0055), which is a
    // property of the employee's COMPANY and has nothing to do with the site. Sarawak is what the site's
    // calendar was supplying, and it is gone.
    expect(dates.has(ADHOC)).toBe(true);
    expect(dates.has(SARAWAK)).toBe(false);
    expect(dates.has(NATIONAL), 'Step 1 is single-winner: the company override IS the calendar').toBe(false);
  });

  it('a site’s CUSTOM calendar can no longer strip a national holiday off its staff', async () => {
    // The sharpest of the four: a custom calendar deliberately ignores the gazette, so before r331 this
    // employee WORKED the national holiday because of where they were assigned. Now they do not.
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Site Custom', states: [], archetype: 'custom' });
    const emp = await hire();
    await setLocation(emp, await makeLocation('CUS', cal.id));

    const dates = await datesFor(emp);
    expect([...dates]).toEqual([NATIONAL]); // was [ADHOC] — gazette ignored, hand-loaded day only
    expect(await daysFor(emp)).toBe(4);
  });

  it('two employees at different-archetype sites now resolve IDENTICALLY', async () => {
    const std = await createHolidayGroup(adminCtx(b), { name: 'S', states: ['Sarawak'], archetype: 'standard' });
    const cus = await createHolidayGroup(adminCtx(b), { name: 'C', states: [], archetype: 'custom' });
    const empStd = await hire();
    await setLocation(empStd, await makeLocation('A', std.id));
    const empCus = await hire();
    await setLocation(empCus, await makeLocation('B', cus.id));
    // Was 3 and 5 respectively — the widest divergence the site axis could produce.
    expect(await daysFor(empStd)).toBe(4);
    expect(await daysFor(empCus)).toBe(4);
    expect([...(await datesFor(empStd))]).toEqual([...(await datesFor(empCus))]);
  });
});

describe('ADR-0067 §(a) SURVIVES — the same three archetypes, assigned on the PERSON', () => {
  it('STANDARD assigned directly still resolves national ∪ the group’s states', async () => {
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Std Sarawak', states: ['Sarawak'], archetype: 'standard' });
    const emp = await hire();
    await setGroup(emp, cal.id);
    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true);
    expect(dates.has(SARAWAK)).toBe(true);
    expect(await daysFor(emp)).toBe(3);
  });

  it('EXTENDED assigned directly still resolves the gazette on the group’s states', async () => {
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Ext Sarawak', states: ['Sarawak'], archetype: 'extended' });
    const emp = await hire();
    await setGroup(emp, cal.id);
    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true);
    expect(dates.has(SARAWAK)).toBe(true);
    expect(await daysFor(emp)).toBe(3);
  });

  it('⚠️ AND IT IS NOT THE SAME ORDER: a company-subtree override now BEATS an extended calendar', async () => {
    // A DIFFERENCE ADR-0086 CREATES, recorded rather than discovered later. The location pre-check ran
    // ABOVE the Step-1 company-subtree override, so a site's extended calendar won and its gazette half
    // still applied. The direct-assign branch is placed BELOW Step 1 (core/holidays.ts documents that
    // placement deliberately: "a company-subtree override still wins"). So an operator moving a calendar
    // off a site and onto the person gets a DIFFERENT answer in the one case where the employee's company
    // chain also owns ad-hoc rows: single-winner company override, no gazette.
    //
    // Nobody is affected on production — ADR-0086 §2 measured 0 of 8 sites mapping a calendar, so no
    // calendar has a site to be moved off. This is pinned so the asymmetry is a known property of the
    // system rather than a surprise the first tenant to use both features finds.
    await seedAdHoc();
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Ext Sarawak', states: ['Sarawak'], archetype: 'extended' });
    const emp = await hire();
    await setGroup(emp, cal.id);
    const dates = await datesFor(emp);
    expect([...dates]).toEqual([ADHOC]);
    expect(dates.has(NATIONAL)).toBe(false);
    expect(dates.has(SARAWAK)).toBe(false);
  });

  it('CUSTOM assigned directly still means ONLY the hand-loaded days, gazette ignored', async () => {
    await seedAdHoc();
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Hand', states: [], archetype: 'custom' });
    const emp = await hire();
    await setGroup(emp, cal.id);
    const dates = await datesFor(emp);
    expect([...dates]).toEqual([ADHOC]);
    expect(dates.has(NATIONAL)).toBe(false);
    expect(await daysFor(emp)).toBe(4);
  });
});

describe('ADR-0086 — the state ↔ calendar conflict is moot, and the two readers still AGREE', () => {
  it('a location with BOTH a state AND a mapped calendar decides nothing; resolver and effState agree', async () => {
    // ⚠️ THE PAIRING GUARD (ADR-0086 §6, and the reason the two functions moved in one commit). The site
    // carries Selangor and maps a Sarawak calendar; neither reaches the employee, and — the part that
    // matters — BOTH readers say so. A state here that holidayDatesFor does not use is the r209-class
    // defect: one gazette for your days off, another for the "is your gazette complete?" warning.
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Cal Sarawak', states: ['Sarawak'], archetype: 'standard' });
    const loc = await makeLocation('CONFLICT', cal.id, 'Selangor');
    const emp = await hire();
    await setLocation(emp, loc);

    const dates = await datesFor(emp);
    expect(dates.has(SARAWAK), 'the site calendar’s state').toBe(false);
    expect(dates.has(NATIONAL)).toBe(true);
    const eff = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, emp));
    // The company default was cleared in beforeEach, so national-only — and the completeness guard agrees.
    expect(eff?.state).toBeNull();
    expect(eff?.skipCompleteness).toBeUndefined();
  });

  it('and they agree the other way too: a DIRECTLY assigned calendar moves both readers together', async () => {
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Direct Sarawak', states: ['Sarawak'], archetype: 'standard' });
    const emp = await hire();
    await setGroup(emp, cal.id);
    expect((await datesFor(emp)).has(SARAWAK)).toBe(true);
    const eff = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, emp));
    expect(eff?.state).toBe('Sarawak');
  });
});

describe('ADR-0086 — the single-row join guard has nothing left to guard', () => {
  it('a mapped-location employee resolves one date set, and it is the site-blind one', async () => {
    await seedAdHoc();
    const cal = await createHolidayGroup(adminCtx(b), { name: 'Ext', states: ['Sarawak'], archetype: 'extended' });
    const emp = await hire();
    await setLocation(emp, await makeLocation('SOLO', cal.id));
    // Was national + Sarawak + ad-hoc (3). Now the Step-1 company override is single-winner and the site
    // contributes nothing, so exactly the ad-hoc day — once, no fan-out.
    const dates = await datesFor(emp);
    expect(dates.size).toBe(1);
    expect([...dates]).toEqual([ADHOC]);
  });
});

describe('ADR-0086 — the s.60D completeness skip follows the PERSON’s calendar, not the site’s', () => {
  it('a Custom calendar reached through a SITE no longer suppresses the warning (it no longer applies)', async () => {
    // Only 1 national holiday is loaded → well under the 11 minimum. Before r331 this employee was silent,
    // because the site's Custom calendar meant the gazette did not apply to them. It applies now, and the
    // warning is therefore CORRECT rather than false noise — the suppression followed the calendar away.
    const cus = await createHolidayGroup(adminCtx(b), { name: 'Hand', states: [], archetype: 'custom' });
    const loc = await makeLocation('HAND', cus.id, 'Selangor'); // site still carries a state on purpose
    const emp = await hire();
    await setLocation(emp, loc);

    const res = await requestLeave(adminCtx(b), { employmentId: emp, leaveTypeId: wdTypeId, startDate: START, endDate: END });
    expect(res.holidayWarnings).toBeTruthy();
    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).toContain('holiday.completeness.warned');
  });

  it('a Custom calendar assigned DIRECTLY still suppresses it (ADR-0067 §(a), untouched)', async () => {
    const cus = await createHolidayGroup(adminCtx(b), { name: 'Hand Direct', states: [], archetype: 'custom' });
    const emp = await hire();
    await setGroup(emp, cus.id);

    const res = await requestLeave(adminCtx(b), { employmentId: emp, leaveTypeId: wdTypeId, startDate: START, endDate: END });
    expect(res.holidayWarnings).toBeUndefined();
    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).not.toContain('holiday.completeness.warned');
  });

  it('a Standard/Extended employee with an under-loaded gazette STILL warns, on the state the PERSON carries', async () => {
    const std = await createHolidayGroup(adminCtx(b), { name: 'StdSel', states: ['Selangor'], archetype: 'standard' });
    const emp = await hire();
    await setGroup(emp, std.id);

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
