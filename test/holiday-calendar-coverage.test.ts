/**
 * 0e276da0 (r269) — warn before a work location is attached to a named holiday calendar that would
 * leave its staff without public holidays.
 *
 * THE DEFECT THIS PINS, measured on production 2026-09-11 and re-measured 2026-09-12: four named
 * calendars, ALL archetype 'custom', two of them holding ZERO days. ADR-0067 (core/holidays.ts §custom)
 * resolves a location mapped to a custom calendar to ONLY that calendar's own days and NO gazette — "a
 * national date the custom calendar omits is a normal working day for that location's staff" — which
 * reaches money through the frozen attendance day-type (OT class) and the working-day leave count.
 * Nothing warned, because effectiveHolidayState deliberately returns skipCompleteness for 'custom'.
 *
 * THAT SKIP IS CORRECT for a populated custom calendar and is NOT touched here; the last describe block
 * pins it still firing. `holidayCalendarCoverage` is a SEPARATE, presentational read: the resolver is
 * unchanged, no event is appended, nothing is blocked.
 *
 * Dates are derived from the clock (§8 "no hardcoded future dates"), through todayInKualaLumpur().
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createHoliday, createHolidayGroup, setGroupHolidays } from '../core/admin';
import { createLocation } from '../core/location';
import { hireEmployee } from '../core/org';
import { withTenant } from '../db/client';
import {
  effectiveHolidayState,
  holidayCalendarCoverage,
  holidayCalendarRisk,
  missingGazettedDates,
} from '../core/holidays';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

/** The year the read defaults to — the tenant's wall-clock year, never UTC's. */
const YEAR = Number(todayInKualaLumpur().slice(0, 4));
const d = (mm: string, dd: string) => `${YEAR}-${mm}-${dd}`;

/** Eleven national days — the EA s.60D shape, on fixed distinct dates inside `YEAR`. */
const NATIONAL: { date: string; name: string }[] = [
  { date: d('01', '05'), name: 'Nat 1' },
  { date: d('02', '05'), name: 'Nat 2' },
  { date: d('03', '05'), name: 'Nat 3' },
  { date: d('04', '05'), name: 'Nat 4' },
  { date: d('05', '05'), name: 'Nat 5' },
  { date: d('06', '05'), name: 'Nat 6' },
  { date: d('07', '05'), name: 'Nat 7' },
  { date: d('08', '05'), name: 'Nat 8' },
  { date: d('09', '05'), name: 'Nat 9' },
  { date: d('10', '05'), name: 'Nat 10' },
  { date: d('11', '05'), name: 'Nat 11' },
];
/** One date gazetted in TWO states under the same name — production's Federal Territory Day shape. */
const FT_DAY = d('02', '16');
/** A Sarawak-only day, to prove a calendar is never told it is missing another state's holiday. */
const GAWAI = d('06', '16');

/** ids of the created gazette rows, by date+state, so a calendar can tick exactly what it wants. */
let holidayIds: Map<string, string>;
const idFor = (date: string, state: string | null = null) => {
  const id = holidayIds.get(`${date}|${state ?? ''}`);
  if (!id) throw new Error(`fixture: no holiday for ${date} / ${state}`);
  return id;
};

const loadGazette = async () => {
  holidayIds = new Map();
  const add = async (date: string, name: string, state: string | null) => {
    const { id } = await createHoliday(adminCtx(b), { country: 'MY', holidayDate: date, name, state });
    holidayIds.set(`${date}|${state ?? ''}`, id);
  };
  for (const n of NATIONAL) await add(n.date, n.name, null);
  await add(FT_DAY, 'Federal Territory Day', 'Kuala Lumpur');
  await add(FT_DAY, 'Federal Territory Day', 'Labuan');
  await add(GAWAI, 'Gawai Dayak', 'Sarawak');
};

const makeCalendar = async (name: string, archetype: string, states: string[], parentGroupId?: string) => {
  const { id } = await createHolidayGroup(adminCtx(b), { name, states, archetype, parentGroupId: parentGroupId ?? null });
  return id;
};

const coverageOf = async (groupId: string, year = YEAR) => {
  const all = await holidayCalendarCoverage(adminCtx(b), { year });
  const c = all.find((x) => x.groupId === groupId);
  if (!c) throw new Error('coverage missing for the calendar under test');
  return c;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await loadGazette();
});
afterAll(async () => {
  await closeAll();
});

describe('missingGazettedDates (pure)', () => {
  it('names every gazetted date not held, earliest first', () => {
    const gaps = missingGazettedDates([NATIONAL[0].date], [NATIONAL[1], NATIONAL[0]].map((n) => ({ holidayDate: n.date, name: n.name })));
    expect(gaps).toEqual([{ date: NATIONAL[1].date, name: 'Nat 2' }]);
  });

  it('collapses two gazette rows on ONE date into one lost day, naming each distinct name once', () => {
    const gaps = missingGazettedDates([], [
      { holidayDate: FT_DAY, name: 'Federal Territory Day' },
      { holidayDate: FT_DAY, name: 'Federal Territory Day' },
      { holidayDate: FT_DAY, name: 'Wilayah Day' },
    ]);
    expect(gaps).toEqual([{ date: FT_DAY, name: 'Federal Territory Day / Wilayah Day' }]);
  });

  it('returns nothing when every gazetted date is held', () => {
    expect(missingGazettedDates(NATIONAL.map((n) => n.date), NATIONAL.map((n) => ({ holidayDate: n.date, name: n.name })))).toEqual([]);
  });
});

describe('holidayCalendarCoverage — a stand-alone (Custom) calendar', () => {
  it('an EMPTY custom calendar reads as empty and names every gazetted day its staff would work', async () => {
    const cal = await makeCalendar('JOHOR OFFICE', 'custom', ['Johor']);
    const c = await coverageOf(cal);

    expect(c.standalone).toBe(true);
    expect(c.country).toBe('MY');
    expect(c.year).toBe(YEAR);
    expect(c.held).toBe(0);
    // Johor has no state rows loaded, so the 11 national days are the whole gazette it is judged against.
    expect(c.gazette).toBe(11);
    expect(holidayCalendarRisk(c)).toBe('empty');
    // THE NAMED ASSERTION the non-vacuity check reverts against: every national day is named as lost.
    expect(c.missing.map((m) => m.date)).toEqual(NATIONAL.map((n) => n.date));
    expect(c.missing.map((m) => m.name)).toEqual(NATIONAL.map((n) => n.name));
  });

  it('a calendar missing ONE national day names exactly that day', async () => {
    const cal = await makeCalendar('KUALA LUMPUR SITE', 'custom', ['Johor']);
    const omitted = NATIONAL[3];
    await setGroupHolidays(adminCtx(b), {
      groupId: cal,
      holidayIds: NATIONAL.filter((n) => n.date !== omitted.date).map((n) => idFor(n.date)),
    });
    const c = await coverageOf(cal);

    expect(c.held).toBe(10);
    expect(c.gazette).toBe(11);
    expect(holidayCalendarRisk(c)).toBe('incomplete');
    // THE NAMED ASSERTION the non-vacuity check reverts against.
    expect(c.missing).toEqual([{ date: omitted.date, name: omitted.name }]);
  });

  it('a populated calendar that omits nothing raises no warning', async () => {
    const cal = await makeCalendar('KUALA LUMPUR HQ', 'custom', ['Johor']);
    await setGroupHolidays(adminCtx(b), { groupId: cal, holidayIds: NATIONAL.map((n) => idFor(n.date)) });
    const c = await coverageOf(cal);

    expect(c.held).toBe(11);
    expect(c.missing).toEqual([]);
    expect(holidayCalendarRisk(c)).toBeNull();
  });

  it('is judged against national ∪ its OWN states — never another state’s holiday', async () => {
    const kl = await makeCalendar('KL', 'custom', ['Kuala Lumpur']);
    const jb = await makeCalendar('JB', 'custom', ['Johor']);
    for (const cal of [kl, jb]) {
      await setGroupHolidays(adminCtx(b), { groupId: cal, holidayIds: NATIONAL.map((n) => idFor(n.date)) });
    }

    // KL owes its staff the Federal Territory Day it did not tick…
    const klC = await coverageOf(kl);
    expect(klC.gazette).toBe(12);
    expect(klC.missing).toEqual([{ date: FT_DAY, name: 'Federal Territory Day' }]);
    // …while Johor owes neither that day nor Sarawak's Gawai Dayak.
    const jbC = await coverageOf(jb);
    expect(jbC.gazette).toBe(11);
    expect(jbC.missing).toEqual([]);
  });

  it('counts DAYS OFF, not junction rows: one date gazetted in two states is one day', async () => {
    // Production's KUALA LUMPUR HQ shape: Federal Territory Day is three rows on one date, and ticking
    // all of them buys the staff ONE day off.
    const cal = await makeCalendar('FT', 'custom', ['Kuala Lumpur', 'Labuan']);
    await setGroupHolidays(adminCtx(b), {
      groupId: cal,
      holidayIds: [idFor(FT_DAY, 'Kuala Lumpur'), idFor(FT_DAY, 'Labuan')],
    });
    const c = await coverageOf(cal);

    expect(c.held).toBe(1); // two rows, one day
    expect(c.gazette).toBe(12); // 11 national + the one FT date
    expect(c.missing.map((m) => m.date)).toEqual(NATIONAL.map((n) => n.date)); // the FT date is NOT missing
  });

  it('counts a group-scoped extra day (holiday.holiday_group_id) as held, like the resolver does', async () => {
    const cal = await makeCalendar('EXTRA', 'custom', ['Johor']);
    await createHoliday(adminCtx(b), {
      country: 'MY',
      holidayDate: d('12', '20'),
      name: 'Company Family Day',
      holidayGroupId: cal,
    });
    const c = await coverageOf(cal);

    expect(c.held).toBe(1);
    expect(holidayCalendarRisk(c)).toBe('incomplete'); // not empty — it holds a day
    expect(c.missing).toHaveLength(11);
  });

  it('INHERITANCE (R18): a child takes its parent’s archetype, states and days — the JOHOR SITE shape', async () => {
    const parent = await makeCalendar('JOHOR OFFICE', 'custom', ['Kuala Lumpur']);
    const child = await makeCalendar('JOHOR SITE', 'standard', ['Johor'], parent);
    // Every day is ticked into the PARENT; the child holds nothing of its own.
    await setGroupHolidays(adminCtx(b), {
      groupId: parent,
      holidayIds: [...NATIONAL.map((n) => idFor(n.date)), idFor(FT_DAY, 'Kuala Lumpur')],
    });
    const c = await coverageOf(child);

    // The parent's archetype governs, so the child stands alone even though its own row says 'standard'.
    expect(c.archetype).toBe('custom');
    expect(c.standalone).toBe(true);
    expect(c.states).toEqual(['Kuala Lumpur']); // the parent's states, not the child's
    expect(c.held).toBe(12); // the parent's days reach the child live
    expect(holidayCalendarRisk(c)).toBeNull();
  });

  it('an EMPTY child of an EMPTY custom parent is still empty (production’s JOHOR SITE today)', async () => {
    const parent = await makeCalendar('JOHOR OFFICE', 'custom', ['Johor']);
    const child = await makeCalendar('JOHOR SITE', 'custom', ['Johor'], parent);
    const c = await coverageOf(child);

    expect(c.held).toBe(0);
    expect(holidayCalendarRisk(c)).toBe('empty');
    expect(c.missing).toHaveLength(11);
  });

  it('defaults to the tenant’s CURRENT year when no year is asked for', async () => {
    const cal = await makeCalendar('DEFAULT YEAR', 'custom', ['Johor']);
    const [c] = (await holidayCalendarCoverage(adminCtx(b))).filter((x) => x.groupId === cal);
    expect(c.year).toBe(YEAR);
    expect(c.gazette).toBe(11);
  });
});

describe('holidayCalendarCoverage — Standard and Extended never warn', () => {
  it('an EMPTY standard calendar raises nothing: the gazette still applies to its staff', async () => {
    const cal = await makeCalendar('STANDARD', 'standard', ['Johor']);
    const c = await coverageOf(cal);

    expect(c.standalone).toBe(false);
    expect(c.held).toBe(0);
    expect(holidayCalendarRisk(c)).toBeNull();
  });

  it('an EMPTY extended calendar raises nothing either: extended = gazette ∪ extras', async () => {
    const cal = await makeCalendar('EXTENDED', 'extended', ['Johor']);
    const c = await coverageOf(cal);

    expect(c.standalone).toBe(false);
    expect(holidayCalendarRisk(c)).toBeNull();
  });
});

describe('the s.60D completeness skip is NOT touched', () => {
  it('effectiveHolidayState still returns skipCompleteness for a location mapped to a Custom calendar', async () => {
    const cal = await makeCalendar('CUSTOM', 'custom', ['Johor']);
    const { id: locationId } = await createLocation(adminCtx(b), {
      companyId: b.companyId,
      code: 'C1',
      name: 'C1',
      holidayGroupId: cal,
    });
    const e = await hireEmployee(adminCtx(b), {
      person: { fullName: 'S', primaryEmail: `s_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await owner.db
      .update(schema.assignment)
      .set({ locationId })
      .where(
        and(
          eq(schema.assignment.employmentId, e.employmentId),
          isNull(schema.assignment.validTo),
          isNull(schema.assignment.supersededAt),
        ),
      );

    const eff = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, e.employmentId));
    expect(eff?.skipCompleteness).toBe(true);
  });
});
