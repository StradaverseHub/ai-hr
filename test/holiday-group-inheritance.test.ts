/**
 * R18 a519a96e — Public-holiday group INHERITANCE (parent-child holiday groups) + group-scoped
 * "additional days".
 *
 * The reporter's model: a BASE group ("Kuala Lumpur") is the master calendar; office groups ("OKR
 * Office", "Bangsar Office") pick it as their PARENT and automatically inherit every holiday, while each
 * office can add extra days ("Company Family Day") that apply ONLY to that office. Parent edits propagate
 * instantly because the resolver reads the parent LIVE (resolve-at-read — nothing is copied).
 *
 * Window: Mon 2026-07-20 → Fri 2026-07-24 = 5 working days.
 *   NATIONAL (Tue 21st) — national gazette.
 *   SARAWAK  (Thu 23rd) — a Sarawak state gazette holiday (the parent group's state).
 *   EXTRA    (Fri 24th) — the office-only additional day (group-scoped holiday row).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import {
  createHoliday,
  createHolidayGroup,
  deleteHolidayGroup,
  updateHolidayGroup,
  listGroupEffectiveHolidays,
} from '../core/admin';
import { createLocation } from '../core/location';
import { hireEmployee, setEmploymentHolidayCalendar } from '../core/org';
import { effectiveHolidayState, holidayDatesFor } from '../core/holidays';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const START = '2026-07-20';
const END = '2026-07-24';
const NATIONAL = '2026-07-21';
const SARAWAK = '2026-07-23';
const EXTRA = '2026-07-24';

const hire = async () => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'I', primaryEmail: `i_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
};

const assignGroup = (employmentId: string, groupId: string) =>
  setEmploymentHolidayCalendar(adminCtx(b), { employmentId, selection: { kind: 'group', groupId } });

const datesFor = async (employmentId: string) =>
  withTenant(adminCtx(b), (tx) => holidayDatesFor(tx, { employmentId, startDate: START, endDate: END }));

/** The base "Kuala Lumpur"-style parent: a standard gazette group on Sarawak (the state we seeded). */
const makeParent = () =>
  createHolidayGroup(adminCtx(b), { name: 'Base Sarawak', states: ['Sarawak'], archetype: 'standard' });

/** An office group inheriting from the parent — zero states of its own (allowed WITH a parent). */
const makeChild = (parentId: string, name = 'OKR Office') =>
  createHolidayGroup(adminCtx(b), { name, states: [], parentGroupId: parentId });

/** Add the office-only additional day to a group (the group-scoped holiday row). */
const addExtra = (groupId: string, holidayDate = EXTRA, name = 'Company Family Day') =>
  createHoliday(adminCtx(b), { country: 'MY', holidayDate, name, holidayGroupId: groupId });

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // No default work-state → an unassigned employee resolves national-only (clean control).
  await owner.db.update(schema.company).set({ defaultWorkState: null }).where(eq(schema.company.id, b.companyId));
  await owner.db.insert(schema.holiday).values([
    { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: NATIONAL, name: 'National Holiday' },
    { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: SARAWAK, name: 'Sarawak Day' },
  ]);
});
afterAll(async () => {
  await closeAll();
});

describe('R18 a519a96e — inheritance: a child group resolves the PARENT calendar', () => {
  it('(a) a directly-assigned child (0 states of its own) inherits the parent gazette states', async () => {
    const parent = await makeParent();
    const child = await makeChild(parent.id);
    const emp = await hire();
    await assignGroup(emp, child.id);

    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true); // national gazette (via the parent's standard archetype)
    expect(dates.has(SARAWAK)).toBe(true); // the PARENT's state — inherited, not configured on the child
  });

  it('(b) parent updates propagate to child staff instantly (resolve-at-read, no copy)', async () => {
    const parent = await makeParent();
    const child = await makeChild(parent.id);
    const emp = await hire();
    await assignGroup(emp, child.id);
    expect((await datesFor(emp)).has(EXTRA)).toBe(false);

    // HR adds a "Special Public Holiday" to the PARENT group AFTER the child staff already exist.
    await addExtra(parent.id, EXTRA, 'Special Public Holiday');
    expect((await datesFor(emp)).has(EXTRA)).toBe(true); // received with zero re-saves
  });

  it('(c) ADR-0086 — a location-mapped child calendar reaches NOBODY; inheritance is a PERSON-level path now', async () => {
    // ⚠️ UPDATED, NOT DELETED (CLAUDE.md §8). This pinned the ADR-0067 §(c) half of R18's inheritance:
    // the same parent-substitution applied through a SITE's mapped calendar as through a directly assigned
    // group. ADR-0086 retires the site rung, so the site half of that claim is withdrawn — and the guard
    // now proves the withdrawal, on the identical fixture, so restoring the join turns it red.
    //
    // (a) and (b) above already pin that inheritance itself is untouched on the surviving path.
    const parent = await makeParent();
    const child = await makeChild(parent.id);
    await addExtra(child.id);
    // ADR-0086 (migration 0484): the site can no longer be GIVEN the child calendar — there is no input
    // and no column for it. The employee is still put at the site, so the claim below is about the site
    // telling the resolver nothing, which a site that cannot carry a calendar states most strongly.
    const { id: locId } = await createLocation(adminCtx(b), {
      companyId: b.companyId,
      code: 'OKR',
      name: 'OKR Office',
    });
    const emp = await hire();
    await owner.db
      .update(schema.assignment)
      .set({ locationId: locId })
      .where(eq(schema.assignment.employmentId, emp));

    const dates = await datesFor(emp);
    expect(dates.has(NATIONAL)).toBe(true); // …from the plain national gazette, not from the calendar
    expect(dates.has(SARAWAK), 'the parent gazette no longer arrives through a site').toBe(false);
    expect(dates.has(EXTRA), 'nor does the office-only extra day').toBe(false);

    // The SAME child calendar, assigned to the SAME kind of employee DIRECTLY, still inherits everything —
    // which is what bounds this reversal to the site door.
    const direct = await hire();
    await assignGroup(direct, child.id);
    const directDates = await datesFor(direct);
    expect(directDates.has(SARAWAK)).toBe(true);
    expect(directDates.has(EXTRA)).toBe(true);
  });
});

describe('R18 a519a96e — group-scoped additional days are office-only', () => {
  it('(d) the child extra applies to child staff, NOT to a sibling office or the parent’s own staff', async () => {
    const parent = await makeParent();
    const okr = await makeChild(parent.id, 'OKR Office');
    const bangsar = await makeChild(parent.id, 'Bangsar Office');
    await addExtra(okr.id);

    const okrEmp = await hire();
    const bangsarEmp = await hire();
    const parentEmp = await hire();
    await assignGroup(okrEmp, okr.id);
    await assignGroup(bangsarEmp, bangsar.id);
    await assignGroup(parentEmp, parent.id);

    expect((await datesFor(okrEmp)).has(EXTRA)).toBe(true); // OKR gets Family Day
    expect((await datesFor(bangsarEmp)).has(EXTRA)).toBe(false); // Bangsar does NOT
    expect((await datesFor(parentEmp)).has(EXTRA)).toBe(false); // the base group itself does NOT
    // Both siblings still share the inherited gazette.
    expect((await datesFor(bangsarEmp)).has(SARAWAK)).toBe(true);
  });

  it('(e) group extras never leak into the public gazette path (no group → national only)', async () => {
    const parent = await makeParent();
    const child = await makeChild(parent.id);
    await addExtra(child.id);
    const emp = await hire(); // NO group assigned — group-scoped rows must not surface (state+company NULL)
    const dates = await datesFor(emp);
    expect([...dates]).toEqual([NATIONAL]);
  });

  it('(f) a PARENT extra reaches every child office (additive over the inherited calendar)', async () => {
    const parent = await makeParent();
    const okr = await makeChild(parent.id, 'OKR Office');
    const bangsar = await makeChild(parent.id, 'Bangsar Office');
    await addExtra(parent.id, EXTRA, 'Special Public Holiday');

    const okrEmp = await hire();
    const bangsarEmp = await hire();
    await assignGroup(okrEmp, okr.id);
    await assignGroup(bangsarEmp, bangsar.id);
    expect((await datesFor(okrEmp)).has(EXTRA)).toBe(true);
    expect((await datesFor(bangsarEmp)).has(EXTRA)).toBe(true);
  });
});

describe('R18 a519a96e — custom parent = hand-picked ∪ extras (gazette excluded)', () => {
  it('(g) a child of a CUSTOM parent sees only its extras; national is a working day', async () => {
    const parent = await createHolidayGroup(adminCtx(b), { name: 'Hand', states: [], archetype: 'custom' });
    const child = await makeChild(parent.id);
    await addExtra(child.id);
    const emp = await hire();
    await assignGroup(emp, child.id);

    const dates = await datesFor(emp);
    expect([...dates]).toEqual([EXTRA]); // only the office extra — no gazette
    expect(dates.has(NATIONAL)).toBe(false);

    // s.60D guard agreement: the effective (parent) archetype is custom → completeness warning suppressed.
    const eff = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, emp));
    expect(eff?.skipCompleteness).toBe(true);
  });
});

describe('R18 a519a96e — admin effective-calendar view (inherited vs own)', () => {
  it('(h) listGroupEffectiveHolidays labels own extras editable and everything else inherited', async () => {
    const parent = await makeParent();
    const child = await makeChild(parent.id);
    await addExtra(child.id); // own
    await addExtra(parent.id, '2026-07-22', 'Parent Extra'); // inherited (parent's own extra)

    const cal = await listGroupEffectiveHolidays(adminCtx(b), { groupId: child.id });
    expect(cal.group.parentName).toBe('Base Sarawak');
    const bySource = new Map(cal.rows.map((r) => [r.holidayDate, r.source]));
    expect(bySource.get(EXTRA)).toBe('own');
    expect(bySource.get('2026-07-22')).toBe('inherited'); // parent extra
    expect(bySource.get(NATIONAL)).toBe('inherited'); // gazette
    expect(bySource.get(SARAWAK)).toBe('inherited'); // parent's state gazette
  });
});

describe('R18 a519a96e — guards', () => {
  it('(i) single level only: a group with a parent cannot be chosen as a parent', async () => {
    const parent = await makeParent();
    const child = await makeChild(parent.id);
    await expect(makeChild(child.id, 'Grandchild')).rejects.toThrow(/one level/i);
  });

  it('(j) a group cannot be its own parent', async () => {
    const parent = await makeParent();
    await expect(
      updateHolidayGroup(adminCtx(b), { id: parent.id, parentGroupId: parent.id }),
    ).rejects.toThrow(/own parent/i);
  });

  it('(k) a group with children cannot itself take a parent', async () => {
    const parent = await makeParent();
    await makeChild(parent.id);
    const other = await createHolidayGroup(adminCtx(b), { name: 'Other', states: ['Selangor'] });
    await expect(
      updateHolidayGroup(adminCtx(b), { id: parent.id, parentGroupId: other.id }),
    ).rejects.toThrow(/one level/i);
  });

  it('(l) deleting a parent with children is blocked (friendly), and deleting a child cascades its extras', async () => {
    const parent = await makeParent();
    const child = await makeChild(parent.id);
    await addExtra(child.id);
    await expect(deleteHolidayGroup(adminCtx(b), { id: parent.id })).rejects.toThrow(/parent of/i);

    // Deleting the CHILD is allowed and takes its own extra rows with it (FK CASCADE).
    await deleteHolidayGroup(adminCtx(b), { id: child.id });
    const orphans = await owner.db
      .select({ id: schema.holiday.id })
      .from(schema.holiday)
      .where(eq(schema.holiday.holidayDate, EXTRA));
    expect(orphans).toHaveLength(0);
  });

  it('(m) zero states still requires a parent for standard/extended; scope stays single-axis', async () => {
    await expect(
      createHolidayGroup(adminCtx(b), { name: 'No states', states: [] }),
    ).rejects.toThrow(/at least one state/i);
    const parent = await makeParent();
    await expect(
      createHoliday(adminCtx(b), {
        country: 'MY',
        holidayDate: EXTRA,
        name: 'Bad scope',
        state: 'Sarawak',
        holidayGroupId: parent.id,
      }),
    ).rejects.toThrow(/at most one/i);
  });
});
