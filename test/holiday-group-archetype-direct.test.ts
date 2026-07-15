/**
 * ADR-0067 (direct-assign) — holiday-group ARCHETYPE honoured when a group is assigned DIRECTLY to an
 * employee on their profile (employment.holiday_group_id), not only when mapped via a location.
 *
 * The gap this closes: the archetype pre-check in holidayDatesFor / effectiveHolidayState previously fired
 * ONLY for a location-mapped calendar. A custom/extended group assigned directly on the profile silently
 * degraded to the plain state / national fallback (Step-2). This suite proves a directly-assigned custom
 * group now behaves as hand-picked (the reporter's "pick which holidays, leave out Wesak" model) — the
 * gazette (national + state) is deliberately excluded, only the hand-picked company rows count — while every
 * existing state-based / standard / default employee resolves BYTE-IDENTICALLY to before.
 *
 * Precedence (documented + locked below): (1) a location-mapped calendar wins over a directly-assigned
 * group; (2) the Step-1 business-group company override (any company-scoped ad-hoc row in the chain) wins
 * over the directly-assigned group branch — so the hand-picked "Deepavali yes" day, entered as a
 * company-scoped holiday, is returned by Step-1 and the national/state dates are excluded either way. The
 * NEW behaviour the fix adds is: when Step-1 is empty (no company ad-hoc row), a directly-assigned CUSTOM
 * group now returns the empty/hand-picked set instead of degrading to national∪state.
 *
 * Window: Mon 2026-07-20 → Fri 2026-07-24 = 5 working days.
 *   NATIONAL (Tue 21st) — national gazette, applies to everyone by default.
 *   ADHOC    (Wed 22nd) — a company-scoped ad-hoc day on the seedBase company chain (the hand-picked day).
 *   SARAWAK  (Thu 23rd) — a Sarawak state gazette holiday HR did NOT hand-pick.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { createHolidayGroup } from '../core/admin';
import { createLocation } from '../core/location';
import { hireEmployee, setEmploymentHolidayCalendar } from '../core/org';
import { requestLeave } from '../core/leave';
import { effectiveHolidayState, holidayDatesFor } from '../core/holidays';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let wdTypeId: string;

const START = '2026-07-20';
const END = '2026-07-24';
const NATIONAL = '2026-07-21'; // Tue — national gazette, applies to everyone by default
const ADHOC = '2026-07-22'; // Wed — company-scoped ad-hoc day (the hand-picked day)
const SARAWAK = '2026-07-23'; // Thu — a Sarawak state gazette holiday

const hire = async () => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'D', primaryEmail: `d_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
};

/** Point the employee's OPEN assignment at a location (used only for the precedence test). */
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

/** Assign a group DIRECTLY on the employee's profile (the path this feature fixes). */
const assignGroup = (employmentId: string, groupId: string) =>
  setEmploymentHolidayCalendar(adminCtx(b), { employmentId, selection: { kind: 'group', groupId } });

const daysFor = async (employmentId: string) =>
  (await requestLeave(adminCtx(b), { employmentId, leaveTypeId: wdTypeId, startDate: START, endDate: END })).days;

const datesFor = async (employmentId: string) =>
  withTenant(adminCtx(b), (tx) => holidayDatesFor(tx, { employmentId, startDate: START, endDate: END }));

/** Add the company-scoped ad-hoc day (a "company-defined extra day") on the seedBase company chain. */
const seedAdHoc = () =>
  owner.db.insert(schema.holiday).values({
    tenantId: b.tenantId,
    country: 'MY',
    state: null,
    companyId: b.companyId,
    holidayDate: ADHOC,
    name: 'Founders Day',
  });

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
  // No default work-state → an unassigned employee resolves national-only (a clean control).
  await owner.db.update(schema.company).set({ defaultWorkState: null }).where(eq(schema.company.id, b.companyId));
  // Public gazette: a national day + a Sarawak state day. The company ad-hoc day is seeded per-test.
  await owner.db.insert(schema.holiday).values([
    { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: NATIONAL, name: 'National Holiday' },
    { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: SARAWAK, name: 'Sarawak Day' },
  ]);
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0067 (direct-assign) — CUSTOM group assigned directly is hand-picked', () => {
  it('(a) the core proof: a CUSTOM group excludes the gazette — national + state are working days', async () => {
    // The scenario that FAILED before the fix: a custom group (no states) assigned directly, with NO
    // company ad-hoc row, previously degraded to Step-2 (national ∪ state) and subtracted the national day.
    // With the fix the custom branch runs, the gazette is ignored, and NOTHING is subtracted — every day,
    // including the national holiday, is a normal working day. This is the reporter's model verbatim.
    const cus = await createHolidayGroup(adminCtx(b), { name: 'Hand-picked', states: [], archetype: 'custom' });
    const emp = await hire();
    await assignGroup(emp, cus.id);

    const dates = await datesFor(emp);
    expect([...dates]).toEqual([]); // nothing hand-picked → nothing counts as a holiday
    expect(dates.has(NATIONAL)).toBe(false); // the national holiday is NOT subtracted → a working day
    expect(dates.has(SARAWAK)).toBe(false); // the un-picked Sarawak state day is also a working day
    expect(await daysFor(emp)).toBe(5); // 5 − nothing (custom with no hand-picked dates)
  });

  it('(a2) a hand-picked company day IS honoured; the omitted national date stays a working day', async () => {
    // "Deepavali yes": the hand-picked day is authored as a company-scoped holiday. The company-subtree
    // override (Step-1) returns ONLY the hand-picked day and the national/state gazette is excluded — the
    // exact "pick which holidays, leave out Wesak" result the reporter asked for.
    await seedAdHoc();
    const cus = await createHolidayGroup(adminCtx(b), { name: 'Hand-picked', states: [], archetype: 'custom' });
    const emp = await hire();
    await assignGroup(emp, cus.id);

    const dates = await datesFor(emp);
    expect([...dates]).toEqual([ADHOC]); // only the hand-picked company day
    expect(dates.has(NATIONAL)).toBe(false); // national NOT subtracted → a working day
    expect(dates.has(SARAWAK)).toBe(false); // un-picked state day → a working day
    expect(await daysFor(emp)).toBe(4); // 5 − ad-hoc only
  });
});

describe('ADR-0067 (direct-assign) — EXTENDED group assigned directly keeps the gazette', () => {
  it('(b) EXTENDED direct-assign = the group.states gazette (national ∪ Sarawak)', async () => {
    // Extended (no company ad-hoc row, so Step-1 is empty) resolves the gazette keyed on the group's
    // states[] — national ∪ Sarawak — matching how a location-mapped extended calendar behaves.
    const ext = await createHolidayGroup(adminCtx(b), { name: 'Ext Sarawak', states: ['Sarawak'], archetype: 'extended' });
    const emp = await hire();
    await assignGroup(emp, ext.id);

    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true); // gazette national
    expect(dates.has(SARAWAK)).toBe(true); // gazette state (group.states)
    expect(await daysFor(emp)).toBe(3); // 5 − national − Sarawak
  });
});

describe('ADR-0067 (direct-assign) — regression: unchanged for standard / default employees', () => {
  it('(c) a legacy STANDARD group assigned directly resolves via the state path, identical to before', async () => {
    // Standard with Sarawak in states behaves exactly like a Sarawak-state resolution: national + Sarawak.
    // No company ad-hoc row, so Step-1 is empty and Step-2 keys on the group states — byte-identical to
    // the pre-change behaviour for a standard/state-based group.
    const std = await createHolidayGroup(adminCtx(b), { name: 'Std Sarawak', states: ['Sarawak'], archetype: 'standard' });
    const emp = await hire();
    await assignGroup(emp, std.id);

    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true);
    expect(dates.has(SARAWAK)).toBe(true);
    expect(dates.has(ADHOC)).toBe(false);
    expect(await daysFor(emp)).toBe(3); // 5 − national − Sarawak
  });

  it('(d) an employee with NO group resolves national-only (fallback intact)', async () => {
    const emp = await hire();
    const dates = await datesFor(emp);
    expect([...dates]).toEqual([NATIONAL]); // national gazette only
    expect(await daysFor(emp)).toBe(4);
  });
});

describe('ADR-0067 (direct-assign) — precedence: location calendar and Step-1 override still win', () => {
  it('(e1) a location-mapped calendar wins over a different directly-assigned custom group', async () => {
    // The location calendar is STANDARD Sarawak (national ∪ Sarawak). The directly-assigned group is a
    // custom group with nothing hand-loaded (which alone would subtract NOTHING). The LOCATION calendar
    // (higher precedence) drives the set — proving a directly-assigned group never overrides a location.
    const locCal = await createHolidayGroup(adminCtx(b), { name: 'Loc std', states: ['Sarawak'], archetype: 'standard' });
    const directCal = await createHolidayGroup(adminCtx(b), { name: 'Direct custom', states: [], archetype: 'custom' });
    const emp = await hire();
    await assignGroup(emp, directCal.id); // directly assigned (lower precedence)
    await setLocation(emp, await makeLocation('LOCWIN', locCal.id)); // location calendar (higher precedence)

    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true); // location standard calendar drives it (gazette applies)
    expect(dates.has(SARAWAK)).toBe(true);
    expect(await daysFor(emp)).toBe(3); // NOT 5 — the custom direct group did NOT win
  });

  it('(e2) a company-scoped Step-1 override still wins over a directly-assigned custom group', async () => {
    // With a company-scoped ad-hoc row present, Step-1's single-winner override fires BEFORE the
    // direct-assign custom branch and returns ONLY the company rows — the national/state gazette excluded.
    await seedAdHoc();
    const cus = await createHolidayGroup(adminCtx(b), { name: 'Direct custom', states: [], archetype: 'custom' });
    const emp = await hire();
    await assignGroup(emp, cus.id);

    const dates = await datesFor(emp);
    expect([...dates]).toEqual([ADHOC]); // Step-1 company override wins (same set the custom branch would give)
    expect(dates.has(NATIONAL)).toBe(false);
  });
});

describe('ADR-0067 (direct-assign) — s.60D completeness guard symmetry', () => {
  it('(f1) a directly-assigned CUSTOM group emits NO false "gazette < 11" completeness warning', async () => {
    // Only 2 gazette holidays loaded → well under the 11 minimum. A normal employee WOULD warn; a
    // hand-managed custom group must NOT (it ignores the gazette in holidayDatesFor).
    const cus = await createHolidayGroup(adminCtx(b), { name: 'Hand', states: [], archetype: 'custom' });
    const emp = await hire();
    await assignGroup(emp, cus.id);

    const eff = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, emp));
    expect(eff?.skipCompleteness).toBe(true);

    const res = await requestLeave(adminCtx(b), { employmentId: emp, leaveTypeId: wdTypeId, startDate: START, endDate: END });
    expect(res.holidayWarnings).toBeUndefined();
    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).not.toContain('holiday.completeness.warned');
  });

  it('(f2) a directly-assigned EXTENDED group with an under-loaded gazette STILL warns', async () => {
    // Extended still includes the gazette, so the completeness guard remains meaningful.
    const ext = await createHolidayGroup(adminCtx(b), { name: 'ExtSel', states: ['Selangor'], archetype: 'extended' });
    const emp = await hire();
    await assignGroup(emp, ext.id);

    const eff = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, emp));
    expect(eff?.skipCompleteness).toBeFalsy();

    const res = await requestLeave(adminCtx(b), { employmentId: emp, leaveTypeId: wdTypeId, startDate: START, endDate: END });
    expect(res.holidayWarnings).toBeTruthy();
    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).toContain('holiday.completeness.warned');
  });
});
