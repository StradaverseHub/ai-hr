/**
 * r298 (board b6a995c1) — the Daily Attendance loader stops resolving holidays one employee at a time.
 *
 * `holidayDatesByEmployment` (core/holidays.ts) answers `holidayDatesFor` for a whole population by calling
 * the UNCHANGED resolver once per distinct set of the four employment inputs that decide a calendar —
 * company, work state, directly-assigned holiday group, and the open assignment's location — and resolving
 * an employment with more than one open assignment on its own. The reporter's condition, verbatim: "show,
 * for a spread of employees set up every different way, that the new answer is identical to the old one for
 * every single person. If any employee's list differs, the change does not ship."
 *
 * So every employee below is checked three ways: the batch answer (a) deep-equals `holidayDatesFor` for that
 * employee, (b) equals a LITERAL calendar written in this file — so the test does not lean only on the code
 * it audits — and (c) is the same whether the employee is asked about alone or inside the full batch, in
 * either order.
 *
 * WHY THE FIXTURE IS SHAPED IN PAIRS. A memo key that is missing an input merges two employees who differ
 * only in that input, and hands one of them the other's calendar. Only a pair that differs in EXACTLY that
 * one input, AND resolves to different dates, can catch it. `PAIRS` below names one such pair per key
 * component and a test asserts each pair really does resolve differently, so the fixture cannot be edited
 * into vacuity without a red test.
 *
 * Window: all of March 2025 (historical). Rows just outside it (28 Feb, 1 Apr) must never appear.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { createHolidayGroup } from '../core/admin';
import { attendanceForDate } from '../core/attendance';
import { holidayDatesByEmployment, holidayDatesFor } from '../core/holidays';
import { createLocation } from '../core/location';
import { hireEmployee, setEmploymentHolidayCalendar } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const START = '2025-03-01';
const END = '2025-03-31';

const NAT = '2025-03-03'; // Mon — national gazette
const SARAWAK = '2025-03-04'; // state gazette
const JOHOR = '2025-03-05'; // state gazette (also TICKED into one group)
const SABAH = '2025-03-06'; // state gazette
const SELANGOR = '2025-03-07'; // state gazette
const ADHOC_G = '2025-03-11'; // Tue — company-scoped ad-hoc day on the PARENT company G
const EXTRA_LOC_CUS = '2025-03-12'; // group-scoped extra day on the custom LOCATION calendar
const EXTRA_PARENT = '2025-03-13'; // group-scoped extra day on the PARENT group (reaches its child group)
const EXTRA_GRP_CUS = '2025-03-14'; // group-scoped extra day on the directly-assigned custom group
const OUTSIDE_BEFORE = '2025-02-28';
const OUTSIDE_AFTER = '2025-04-01';

/** Every employee in the fixture, by the one way it is set up. */
type Name =
  | 'nationalOnly' // company A (no default state), no work state, no group, open assignment with no location
  | 'noOpenAssignment' // as nationalOnly, but its only assignment is closed
  | 'wsSarawak'
  | 'wsJohor'
  | 'locCustomCal' // location mapped to a CUSTOM calendar
  | 'locExtendedCal' // location mapped to an EXTENDED calendar
  | 'locStandardCal' // location mapped to a STANDARD calendar (and carrying a conflicting state)
  | 'locStateSabah' // location with only a state
  | 'locStateJohor' // location with only a state
  | 'locPlain' // location with neither
  | 'grpCustom' // directly-assigned custom group
  | 'grpExtended' // directly-assigned extended group
  | 'grpChild' // directly-assigned group that INHERITS from a parent group
  | 'grpTicked' // directly-assigned group with a ticked holiday
  | 'grpSelangor' // directly-assigned plain standard group
  | 'twoOpenAssignments' // two open assignments, at locStateSabah's and locStateJohor's locations
  | 'companyDefaultJohor' // company D, whose default_work_state is Johor
  | 'childCompany' // company C, a child of G — G's ad-hoc day reaches it via is_company_descendant
  | 'childCompanyWsSarawak'
  | 'childCompanyCustomCal'
  | 'childCompanyExtendedCal'
  | 'parentCompany' // company G itself
  | 'unrelatedCompany' // company U — must NOT get G's ad-hoc day
  | 'unrelatedCompanyCustomCal';

/** The literal calendars, worked out by hand from the resolver's precedence (see the notes per line). */
const EXPECTED: Record<Exclude<Name, 'twoOpenAssignments'>, string[]> = {
  nationalOnly: [NAT], // Step 2, no state anywhere
  noOpenAssignment: [NAT], // no location to read → same as nationalOnly
  wsSarawak: [NAT, SARAWAK],
  wsJohor: [NAT, JOHOR],
  locCustomCal: [EXTRA_LOC_CUS], // custom: A's chain has no ad-hoc row, so only the calendar's own extra day
  locExtendedCal: [NAT, SABAH], // extended: gazette on the calendar's states
  locStandardCal: [NAT, SELANGOR], // the calendar's Selangor beats the location's own Sarawak
  locStateSabah: [NAT, SABAH],
  locStateJohor: [NAT, JOHOR],
  locPlain: [NAT],
  grpCustom: [EXTRA_GRP_CUS], // direct custom: no gazette, only the group's extra day
  grpExtended: [NAT, JOHOR], // direct extended: gazette on the group's states
  grpChild: [NAT, SABAH, EXTRA_PARENT], // the parent's archetype + states, plus the parent's extra day
  grpTicked: [NAT, SARAWAK, JOHOR], // Sarawak by state, Johor by tick (a union, not a replacement)
  grpSelangor: [NAT, SELANGOR],
  companyDefaultJohor: [NAT, JOHOR], // company default_work_state
  childCompany: [ADHOC_G], // Step 1: the parent's ad-hoc day IS the calendar
  childCompanyWsSarawak: [ADHOC_G], // …and it wins over the employee's own state
  childCompanyCustomCal: [ADHOC_G, EXTRA_LOC_CUS], // custom: chain ad-hoc ∪ calendar extra
  childCompanyExtendedCal: [NAT, SABAH, ADHOC_G], // extended: chain ad-hoc ∪ gazette
  parentCompany: [ADHOC_G],
  unrelatedCompany: [NAT], // G's ad-hoc day does not leak across an unrelated subtree
  unrelatedCompanyCustomCal: [EXTRA_LOC_CUS],
};
/** `holidayDatesFor` joins ONE of the two open assignments via `.limit(1)`; which one is not specified. */
const TWO_OPEN_EITHER = [EXPECTED.locStateSabah, EXPECTED.locStateJohor];

/** One pair per memo-key component: the two employees differ in exactly that input. */
const PAIRS: { component: string; a: Name; b: Name }[] = [
  { component: 'companyId', a: 'nationalOnly', b: 'companyDefaultJohor' },
  { component: 'companyId (company chain)', a: 'childCompany', b: 'unrelatedCompany' },
  { component: 'companyId (chain vs own state)', a: 'wsSarawak', b: 'childCompanyWsSarawak' },
  { component: 'workState', a: 'wsSarawak', b: 'wsJohor' },
  { component: 'workState (vs none)', a: 'nationalOnly', b: 'wsSarawak' },
  { component: 'holidayGroupId', a: 'grpTicked', b: 'grpSelangor' },
  { component: 'holidayGroupId (vs none)', a: 'nationalOnly', b: 'grpCustom' },
  { component: 'locationId', a: 'locStateSabah', b: 'locStateJohor' },
  { component: 'locationId (calendar vs none)', a: 'locCustomCal', b: 'locPlain' },
];

let b: Base;
const E = {} as Record<Name, string>;
let overlapDropped = false;
let secondOpenAssignmentId: string | null = null;

/** Put `assignment_no_overlap` back exactly as migration 0001 defines it, removing the injected overlap first. */
const restoreOverlapConstraint = async () => {
  if (!overlapDropped) return;
  if (secondOpenAssignmentId) {
    await owner.db.delete(schema.assignment).where(eq(schema.assignment.id, secondOpenAssignmentId));
    secondOpenAssignmentId = null;
  }
  await owner.db.execute(
    sql`ALTER TABLE assignment ADD CONSTRAINT assignment_no_overlap EXCLUDE USING gist (employment_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&) WHERE (superseded_at IS NULL)`,
  );
  overlapDropped = false;
};

const sorted = (s: Set<string> | undefined) => [...(s ?? new Set<string>())].sort();

const makeCompany = async (legalName: string, opts: { parentCompanyId?: string; defaultWorkState?: string } = {}) => {
  const [c] = await owner.db
    .insert(schema.company)
    .values({
      tenantId: b.tenantId,
      legalName,
      parentCompanyId: opts.parentCompanyId ?? null,
      defaultWorkState: opts.defaultWorkState ?? null,
    })
    .returning({ id: schema.company.id });
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: c.id, name: `${legalName} Ops` })
    .returning({ id: schema.department.id });
  return { companyId: c.id, deptId: d.id };
};

const openAssignment = (employmentId: string) =>
  and(
    eq(schema.assignment.employmentId, employmentId),
    isNull(schema.assignment.validTo),
    isNull(schema.assignment.supersededAt),
  );

const seedFixture = async () => {
  b = await seedBase();
  const ctx = adminCtx(b);
  await owner.db.update(schema.company).set({ defaultWorkState: null }).where(eq(schema.company.id, b.companyId));
  const A = { companyId: b.companyId, deptId: b.deptA };
  const D = await makeCompany('Default Johor Sdn Bhd', { defaultWorkState: 'Johor' });
  const G = await makeCompany('Group Holdings Bhd');
  const C = await makeCompany('Group Factory Sdn Bhd', { parentCompanyId: G.companyId });
  const U = await makeCompany('Unrelated Sdn Bhd');

  // ── the gazette, plus rows just outside the window ──
  const gazette = await owner.db
    .insert(schema.holiday)
    .values([
      { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: NAT, name: 'National' },
      { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: SARAWAK, name: 'Sarawak Day' },
      { tenantId: b.tenantId, country: 'MY', state: 'Johor', holidayDate: JOHOR, name: 'Johor Day' },
      { tenantId: b.tenantId, country: 'MY', state: 'Sabah', holidayDate: SABAH, name: 'Sabah Day' },
      { tenantId: b.tenantId, country: 'MY', state: 'Selangor', holidayDate: SELANGOR, name: 'Selangor Day' },
      { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: OUTSIDE_AFTER, name: 'National (April)' },
      { tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: OUTSIDE_BEFORE, name: 'Sarawak (Feb)' },
      { tenantId: b.tenantId, country: 'MY', state: null, companyId: G.companyId, holidayDate: ADHOC_G, name: 'Group Founders Day' },
    ])
    .returning({ id: schema.holiday.id, name: schema.holiday.name });
  const johorRowId = gazette.find((h) => h.name === 'Johor Day')!.id;

  // ── holiday groups / calendars ──
  const calCustom = await createHolidayGroup(ctx, { name: 'Site Custom', states: [], archetype: 'custom' });
  const calExtended = await createHolidayGroup(ctx, { name: 'Site Extended', states: ['Sabah'], archetype: 'extended' });
  const calStandard = await createHolidayGroup(ctx, { name: 'Site Standard', states: ['Selangor'], archetype: 'standard' });
  const grpCustom = await createHolidayGroup(ctx, { name: 'Direct Custom', states: [], archetype: 'custom' });
  const grpExtended = await createHolidayGroup(ctx, { name: 'Direct Extended', states: ['Johor'], archetype: 'extended' });
  const grpParent = await createHolidayGroup(ctx, { name: 'Base Sabah', states: ['Sabah'], archetype: 'standard' });
  const grpChild = await createHolidayGroup(ctx, { name: 'Office Child', states: [], parentGroupId: grpParent.id });
  const grpTicked = await createHolidayGroup(ctx, {
    name: 'Sarawak Plus Johor',
    states: ['Sarawak'],
    archetype: 'standard',
    holidayIds: [johorRowId],
  });
  const grpSelangor = await createHolidayGroup(ctx, { name: 'Plain Selangor', states: ['Selangor'], archetype: 'standard' });
  await owner.db.insert(schema.holiday).values([
    { tenantId: b.tenantId, country: 'MY', holidayGroupId: calCustom.id, holidayDate: EXTRA_LOC_CUS, name: 'Site Family Day' },
    { tenantId: b.tenantId, country: 'MY', holidayGroupId: grpParent.id, holidayDate: EXTRA_PARENT, name: 'Base Family Day' },
    { tenantId: b.tenantId, country: 'MY', holidayGroupId: grpCustom.id, holidayDate: EXTRA_GRP_CUS, name: 'Direct Family Day' },
  ]);

  // ── locations ──
  const loc = async (companyId: string, code: string, holidayGroupId: string | null, state: string | null) =>
    (await createLocation(ctx, { companyId, code, name: code, state, holidayGroupId })).id;
  const L = {
    custom: await loc(A.companyId, 'A-CUS', calCustom.id, null),
    extended: await loc(A.companyId, 'A-EXT', calExtended.id, null),
    standard: await loc(A.companyId, 'A-STD', calStandard.id, 'Sarawak'),
    sabah: await loc(A.companyId, 'A-SABAH', null, 'Sabah'),
    johor: await loc(A.companyId, 'A-JOHOR', null, 'Johor'),
    plain: await loc(A.companyId, 'A-PLAIN', null, null),
    cCustom: await loc(C.companyId, 'C-CUS', calCustom.id, null),
    cExtended: await loc(C.companyId, 'C-EXT', calExtended.id, null),
    uCustom: await loc(U.companyId, 'U-CUS', calCustom.id, null),
  };

  const hire = async (name: Name, at: { companyId: string; deptId: string }) => {
    const e = await hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
      companyId: at.companyId,
      departmentId: at.deptId,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    E[name] = e.employmentId;
    return e.employmentId;
  };
  const setLocation = (employmentId: string, locationId: string) =>
    owner.db.update(schema.assignment).set({ locationId }).where(openAssignment(employmentId));
  const setState = (employmentId: string, state: string) =>
    setEmploymentHolidayCalendar(ctx, { employmentId, selection: { kind: 'state', state } });
  const setGroup = (employmentId: string, groupId: string) =>
    setEmploymentHolidayCalendar(ctx, { employmentId, selection: { kind: 'group', groupId } });

  // FIRST, before any other assignment row exists: the employee with TWO open assignments. The database
  // forbids this — `assignment_no_overlap` (migration 0001) excludes two open-ended rows for one employment
  // — so the memo's "resolve it alone" rule is defence in depth for a state only a bypassed constraint can
  // produce. Built the way test/performance-eligibility.test.ts builds it: drop the constraint, insert, and
  // restore it (afterAll, or at once if this hook fails) so the worker database is left as migrated. The
  // Sabah row is both the earlier valid_from and the earlier heap row; the Johor row is later on both.
  const two = await hire('twoOpenAssignments', A);
  await setLocation(two, L.sabah);
  await owner.db.execute(sql`ALTER TABLE assignment DROP CONSTRAINT assignment_no_overlap`);
  overlapDropped = true;
  const [second] = await owner.db
    .insert(schema.assignment)
    .values({
      tenantId: b.tenantId,
      employmentId: two,
      departmentId: A.deptId,
      employmentType: 'full_time',
      validFrom: '2024-06-01',
      locationId: L.johor,
    })
    .returning({ id: schema.assignment.id });
  secondOpenAssignmentId = second.id;

  await hire('nationalOnly', A);
  const noOpen = await hire('noOpenAssignment', A);
  await owner.db.update(schema.assignment).set({ validTo: '2024-12-31' }).where(openAssignment(noOpen));
  await setState(await hire('wsSarawak', A), 'Sarawak');
  await setState(await hire('wsJohor', A), 'Johor');
  await setLocation(await hire('locCustomCal', A), L.custom);
  await setLocation(await hire('locExtendedCal', A), L.extended);
  await setLocation(await hire('locStandardCal', A), L.standard);
  await setLocation(await hire('locStateSabah', A), L.sabah);
  await setLocation(await hire('locStateJohor', A), L.johor);
  await setLocation(await hire('locPlain', A), L.plain);
  await setGroup(await hire('grpCustom', A), grpCustom.id);
  await setGroup(await hire('grpExtended', A), grpExtended.id);
  await setGroup(await hire('grpChild', A), grpChild.id);
  await setGroup(await hire('grpTicked', A), grpTicked.id);
  await setGroup(await hire('grpSelangor', A), grpSelangor.id);
  await hire('companyDefaultJohor', D);
  await hire('childCompany', C);
  await setState(await hire('childCompanyWsSarawak', C), 'Sarawak');
  await setLocation(await hire('childCompanyCustomCal', C), L.cCustom);
  await setLocation(await hire('childCompanyExtendedCal', C), L.cExtended);
  await hire('parentCompany', G);
  await hire('unrelatedCompany', U);
  await setLocation(await hire('unrelatedCompanyCustomCal', U), L.uCustom);
};

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  try {
    await seedFixture();
  } catch (e) {
    await restoreOverlapConstraint();
    throw e;
  }
}, 120_000);

afterAll(async () => {
  try {
    await restoreOverlapConstraint();
  } finally {
    await closeAll();
  }
});

const allNames = () => Object.keys(E) as Name[];
const batch = (employmentIds: string[]) =>
  withTenant(adminCtx(b), (tx) => holidayDatesByEmployment(tx, { employmentIds, startDate: START, endDate: END }));
const single = (employmentId: string) =>
  withTenant(adminCtx(b), (tx) => holidayDatesFor(tx, { employmentId, startDate: START, endDate: END }));

describe('r298 — the fixture really discriminates every key component', () => {
  it('covers every configured employee, and each pair differing in ONE input resolves to different dates', () => {
    expect(allNames().sort()).toEqual([...Object.keys(EXPECTED), 'twoOpenAssignments'].sort());
    for (const p of PAIRS) {
      expect(EXPECTED[p.a as keyof typeof EXPECTED], `${p.component}: ${p.a} vs ${p.b}`).not.toEqual(
        EXPECTED[p.b as keyof typeof EXPECTED],
      );
    }
    // The ambiguous employee's two candidate calendars differ too, or the exclusion could not matter.
    expect(TWO_OPEN_EITHER[0]).not.toEqual(TWO_OPEN_EITHER[1]);
  });

  it('the pairs really differ in the stored inputs, and the ambiguous employee has two open assignments', async () => {
    const rows = await owner.db
      .select({
        id: schema.employment.id,
        companyId: schema.employment.companyId,
        workState: schema.employment.workState,
        holidayGroupId: schema.employment.holidayGroupId,
      })
      .from(schema.employment);
    const open = await owner.db
      .select({ employmentId: schema.assignment.employmentId, locationId: schema.assignment.locationId })
      .from(schema.assignment)
      .where(and(isNull(schema.assignment.validTo), isNull(schema.assignment.supersededAt)))
      .orderBy(schema.assignment.employmentId, schema.assignment.validFrom);
    const inputs = (n: Name) => {
      const r = rows.find((x) => x.id === E[n])!;
      const locs = open.filter((o) => o.employmentId === E[n]).map((o) => o.locationId);
      return { companyId: r.companyId, workState: r.workState, holidayGroupId: r.holidayGroupId, locs };
    };
    const differing = (x: Name, y: Name) => {
      const a = inputs(x);
      const c = inputs(y);
      return (['companyId', 'workState', 'holidayGroupId', 'locs'] as const).filter(
        (k) => JSON.stringify(a[k]) !== JSON.stringify(c[k]),
      );
    };
    const componentOf = (label: string) => (label.split(' ')[0] === 'locationId' ? 'locs' : label.split(' ')[0]);
    for (const p of PAIRS) expect(differing(p.a, p.b), `${p.a} vs ${p.b}`).toEqual([componentOf(p.component)]);
    expect(inputs('twoOpenAssignments').locs).toHaveLength(2);
    expect(inputs('noOpenAssignment').locs).toHaveLength(0);
  });
});

describe('r298 — holidayDatesByEmployment gives every employee exactly what holidayDatesFor gives', () => {
  it('(a)+(b) for EVERY employee: the batch answer equals holidayDatesFor, and equals the literal calendar', async () => {
    const names = allNames();
    const got = await batch(names.map((n) => E[n]));
    for (const n of names) {
      const old = sorted(await single(E[n]));
      const now = sorted(got.get(E[n]));
      expect(now, `${n}: batch vs holidayDatesFor`).toEqual(old);
      if (n === 'twoOpenAssignments') expect(TWO_OPEN_EITHER, `${n}: literal`).toContainEqual(now);
      else expect(now, `${n}: literal`).toEqual([...EXPECTED[n]].sort());
    }
  });

  it('(c) an employee gets the same answer asked alone as inside the full batch, in either batch order', async () => {
    const names = allNames();
    const forward = await batch(names.map((n) => E[n]));
    const reverse = await batch(names.map((n) => E[n]).reverse());
    for (const n of names) {
      const alone = await batch([E[n]]);
      expect(sorted(forward.get(E[n])), `${n}: batch (forward) vs alone`).toEqual(sorted(alone.get(E[n])));
      expect(sorted(reverse.get(E[n])), `${n}: batch (reverse) vs alone`).toEqual(sorted(alone.get(E[n])));
    }
  });

  it('(d) the Map holds exactly the requested ids, duplicates collapsed; an unknown id maps to an empty set', async () => {
    const unknown = randomUUID();
    const asked = [E.nationalOnly, E.wsJohor, E.nationalOnly, unknown, E.grpChild, E.wsJohor];
    const got = await batch(asked);
    expect([...got.keys()].sort()).toEqual([...new Set(asked)].sort());
    expect(got.size).toBe(4);
    expect(sorted(got.get(unknown))).toEqual([]);
    expect(sorted(await single(unknown))).toEqual([]); // …which is what holidayDatesFor says too
    expect(sorted(got.get(E.grpChild))).toEqual([...EXPECTED.grpChild].sort());
    expect((await batch([])).size).toBe(0);
  });

  it('each entry is its own Set: two employees sharing a calendar do not share the object', async () => {
    const got = await batch([E.nationalOnly, E.noOpenAssignment, E.unrelatedCompany]);
    const a = got.get(E.nationalOnly)!;
    const c = got.get(E.noOpenAssignment)!;
    expect(a).not.toBe(c);
    a.add('1999-01-01');
    expect(sorted(c)).toEqual([NAT]);
  });

  it('a one-day window (the Daily Attendance shape) agrees with holidayDatesFor for every employee', async () => {
    for (const day of [NAT, ADHOC_G, EXTRA_LOC_CUS, JOHOR]) {
      const names = allNames();
      const got = await withTenant(adminCtx(b), (tx) =>
        holidayDatesByEmployment(tx, { employmentIds: names.map((n) => E[n]), startDate: day, endDate: day }),
      );
      for (const n of names) {
        const old = await withTenant(adminCtx(b), (tx) =>
          holidayDatesFor(tx, { employmentId: E[n], startDate: day, endDate: day }),
        );
        expect(sorted(got.get(E[n])), `${n} on ${day}`).toEqual(sorted(old));
      }
    }
  });
});

describe('r298 — the Daily Attendance loader reads the batched calendars', () => {
  it('a no-row employee on their holiday gets context "holiday"; one whose calendar omits that date does not', async () => {
    const onNat = await attendanceForDate(adminCtx(b), NAT);
    const ctxOn = (rows: typeof onNat, n: Name) => {
      const mine = rows.filter((r) => r.employmentId === E[n]);
      expect(mine.length, `${n} appears`).toBeGreaterThan(0);
      for (const r of mine) expect(r.attendanceId, `${n} has no row`).toBeNull();
      return [...new Set(mine.map((r) => r.context))];
    };
    // NAT (a Monday, a working day): national holiday for most…
    expect(ctxOn(onNat, 'nationalOnly')).toEqual(['holiday']);
    expect(ctxOn(onNat, 'noOpenAssignment')).toEqual(['holiday']);
    expect(ctxOn(onNat, 'grpChild')).toEqual(['holiday']);
    expect(ctxOn(onNat, 'unrelatedCompany')).toEqual(['holiday']);
    // …but a working day under a calendar that omits it.
    expect(ctxOn(onNat, 'locCustomCal')).toEqual([null]);
    expect(ctxOn(onNat, 'grpCustom')).toEqual([null]);
    expect(ctxOn(onNat, 'childCompanyCustomCal')).toEqual([null]);
    // NOT in this list, deliberately: `childCompany`. Its March calendar is only ADHOC_G, but the Step-1
    // company override is WINDOW-scoped — on a one-day window holding no company row it does not fire, and
    // the day falls through to the gazette. That is holidayDatesFor's behaviour on main, and the loop below
    // holds the loader to it.
    expect(ctxOn(onNat, 'childCompany')).toEqual(['holiday']);

    // ADHOC_G (a Tuesday): the parent company's day reaches the child company, not the unrelated one.
    const onAdhoc = await attendanceForDate(adminCtx(b), ADHOC_G);
    expect(ctxOn(onAdhoc, 'childCompany')).toEqual(['holiday']);
    expect(ctxOn(onAdhoc, 'parentCompany')).toEqual(['holiday']);
    expect(ctxOn(onAdhoc, 'unrelatedCompany')).toEqual([null]);
    expect(ctxOn(onAdhoc, 'nationalOnly')).toEqual([null]);

    // And the loader agrees with holidayDatesFor for every employee on both days.
    for (const [day, rows] of [
      [NAT, onNat],
      [ADHOC_G, onAdhoc],
    ] as const) {
      for (const n of allNames()) {
        const isHoliday = (
          await withTenant(adminCtx(b), (tx) => holidayDatesFor(tx, { employmentId: E[n], startDate: day, endDate: day }))
        ).has(day);
        expect(ctxOn(rows, n), `${n} on ${day}`).toEqual([isHoliday ? 'holiday' : null]);
      }
    }
  });

  it('an employee WITH an attendance row is not given holiday context (the batch only covers no-row employees)', async () => {
    await owner.db
      .insert(schema.attendance)
      .values({ tenantId: b.tenantId, employmentId: E.wsSarawak, attendanceDate: SARAWAK, status: 'present' });
    try {
      const rows = await attendanceForDate(adminCtx(b), SARAWAK);
      const mine = rows.filter((r) => r.employmentId === E.wsSarawak);
      expect(mine).toHaveLength(1);
      expect(mine[0].attendanceId).not.toBeNull();
      expect(mine[0].context).toBeNull();
      // Its colleague on the same calendar with no row still reads holiday.
      expect(rows.find((r) => r.employmentId === E.grpTicked)!.context).toBe('holiday');
    } finally {
      await owner.db.execute(
        sql`DELETE FROM attendance WHERE employment_id = ${E.wsSarawak} AND attendance_date = ${SARAWAK}`,
      );
    }
  });
});
