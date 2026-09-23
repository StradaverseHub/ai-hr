/**
 * ADR-0086 (board 0fe1ca2e, r331) — THE WORK SITE IS NO LONGER AN INPUT TO HOLIDAY RESOLUTION.
 *
 * This file was `test/location-holiday-whatif.test.ts`, the guard on the r328 READ-ONLY preview
 * (`holidayDatesFor`'s `whatIf` override) that let the reporter see a before/after for the removal
 * BEFORE it was made. The preview and the two scripts it drove were, in their own words, temporary:
 * "when `assignment.location_id` and the `location` join leave this function, this goes with them."
 * r331 is that removal, so they went — and this file is UPDATED to pin the world they previewed rather
 * than deleted (CLAUDE.md §8: a guard pinning a decision you are reversing is updated, with the reason).
 *
 * The fixture is unchanged and still shaped like production: a company defaulting to Selangor, an
 * employee whose OPEN assignment is at a Kuala Lumpur site, and a second employee at a site mapped to a
 * named CUSTOM calendar. What each claim asserts has flipped, and the flip IS the change:
 *
 *   1. NON-VACUITY / THE MUTATION TARGET — the site's state no longer decides anybody's calendar. Put
 *      `emp.locationState` back at the top of the Step-2 precedence in core/holidays.ts and assertion 1
 *      goes red. Without it every "identical" below would be a true statement about a rung that never ran.
 *   2. THE PROMISE THE REPORTER WAS GIVEN, now checked on the other side of the change: an employee whose
 *      `work_state` carries what the site was supplying keeps EXACTLY the calendar they had before. The
 *      expected set is the literal answer the pre-change resolver gave for the same fixture.
 *   3. THE ORDER, restated as a consequence rather than a warning: an employee at a site who was relying
 *      on the site for their state now falls to the company default. That is what the r328 carry script
 *      existed to prevent, and it was run cross-tenant on production before this change (ADR-0086 §2:
 *      1 open assignment, its employee's work_state already carrying the site's state, `holidays MOVE 0`).
 *   4. A NAMED SITE CALENDAR NO LONGER REACHES ANYBODY THROUGH A SITE — ADR-0067 §(b) retired. The
 *      calendar itself survives (§(a)); it is chosen on the PERSON now.
 *   5. ONE KEY, TWO MEMOS — unchanged in purpose, narrowed to THREE inputs. An input LEAVING the key is
 *      exactly as dangerous as one arriving, so this is the assertion that makes the two memos move with
 *      the resolver.
 *   6. TWO OPEN ASSIGNMENTS CANNOT DIVERGE ANY MORE. Both memos carried an "ambiguous open assignment,
 *      resolve alone" escape hatch, because the resolver joined `assignment` and took one row via
 *      `.limit(1)`. Nothing joins `assignment` now, so the hatch is not merely removed — there is nothing
 *      left for it to disambiguate, and this pins that rather than trusting the reading.
 *
 * Window is a HISTORICAL year (2025): no hardcoded future dates, and nothing here moves when the clock does.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { createHolidayGroup } from '../core/admin';
import { effectiveHolidayState, holidayDatesByEmployment, holidayDatesFor, holidayMemoKey } from '../core/holidays';
import { createLocation } from '../core/location';
import { hireEmployee, setEmploymentHolidayCalendar } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const START = '2025-01-01';
const END = '2025-12-31';

const NATIONAL = '2025-08-31'; // Merdeka — everybody
const KL_ONLY = '2025-02-01'; // Federal Territory Day — the state the site used to supply
const SELANGOR_ONLY = '2025-07-15'; // the company default's own day (production has none; the fixture does,
//                                     so the fallback is VISIBLE rather than merely absent)
const SITE_CALENDAR_DAY = '2025-05-20'; // a named calendar's own extra day

/** The answer the PRE-CHANGE resolver gave for an employee at the Kuala Lumpur site. Assertion 2 is the
 *  promise that carrying the state onto the employee reproduces it exactly. */
const CALENDAR_BEFORE_THE_CHANGE = [KL_ONLY, NATIONAL].sort();

let b: Base;
let onSite = ''; // company default Selangor, open assignment at a Kuala Lumpur site, work_state NOT carried
let carried = ''; // the same site, but employment.work_state carries Kuala Lumpur (what the carry script did)
let onCalendarSite = ''; // open assignment at a site mapped to a CUSTOM named calendar
let klSiteId = '';

const sorted = (s: Set<string>) => [...s].sort();

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  const ctx = adminCtx(b);

  // The company defaults to Selangor, as the production company does.
  await owner.db
    .update(schema.company)
    .set({ defaultWorkState: 'Selangor' })
    .where(eq(schema.company.id, b.companyId));

  await owner.db.insert(schema.holiday).values([
    { tenantId: b.tenantId, country: 'MY', state: null, holidayDate: NATIONAL, name: 'National Day' },
    { tenantId: b.tenantId, country: 'MY', state: 'Kuala Lumpur', holidayDate: KL_ONLY, name: 'Federal Territory Day' },
    { tenantId: b.tenantId, country: 'MY', state: 'Selangor', holidayDate: SELANGOR_ONLY, name: 'Selangor Day' },
  ]);

  const calendar = await createHolidayGroup(ctx, { name: 'Site Custom', states: [], archetype: 'custom' });
  await owner.db.insert(schema.holiday).values({
    tenantId: b.tenantId,
    country: 'MY',
    holidayGroupId: calendar.id,
    holidayDate: SITE_CALENDAR_DAY,
    name: 'Site Family Day',
  });

  // The `location` rows still exist, still carry a state, and one still carries a mapped calendar until
  // the migration drops that column — which is the point: the resolver stops READING them first, so this
  // fixture proves the reader changed rather than the data disappearing underneath it.
  const klSite = await createLocation(ctx, {
    companyId: b.companyId,
    code: 'SUB-4',
    name: 'Sub 4',
    state: 'Kuala Lumpur',
  });
  klSiteId = klSite.id;
  const calSite = await createLocation(ctx, {
    companyId: b.companyId,
    code: 'SUB-5',
    name: 'Sub 5',
    state: 'Kuala Lumpur',
    holidayGroupId: calendar.id,
  });

  const hire = async (label: string) => {
    const e = await hireEmployee(ctx, {
      person: { fullName: label, primaryEmail: `${label}_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    return e.employmentId;
  };
  const putAtSite = (employmentId: string, locationId: string) =>
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

  onSite = await hire('onSite');
  await putAtSite(onSite, klSiteId);
  carried = await hire('carried');
  await putAtSite(carried, klSiteId);
  // …through the service that owns the work_state ⊕ holiday_group_id rule, exactly as the retired
  // scripts/carry-location-state-to-work-state.ts did on production.
  await setEmploymentHolidayCalendar(ctx, {
    employmentId: carried,
    selection: { kind: 'state', state: 'Kuala Lumpur' },
  });
  onCalendarSite = await hire('onCalendarSite');
  await putAtSite(onCalendarSite, calSite.id);
});

afterAll(closeAll);

const resolve = (employmentId: string) =>
  withTenant(adminCtx(b), (tx) => holidayDatesFor(tx, { employmentId, startDate: START, endDate: END }));

describe('ADR-0086 — the site register removed from holiday resolution', () => {
  it('1. NON-VACUITY: the site state no longer decides the calendar — the company default does', async () => {
    // ⚠️ THE MUTATION TARGET. Restore `emp.locationState` above the group/work_state rungs in
    // core/holidays.ts Step 2 and this assertion goes red: the employee would be back on Kuala Lumpur.
    const now = await resolve(onSite);
    expect(sorted(now)).toEqual([SELANGOR_ONLY, NATIONAL].sort());
    expect(now.has(KL_ONLY), 'the site no longer supplies its state').toBe(false);

    // The site row is still there and still carries the state — so this is the READER changing, not the
    // fixture losing its data. Without this the assertion above would also pass on an empty `location`.
    const [site] = await owner.db
      .select({ state: schema.location.state })
      .from(schema.location)
      .where(eq(schema.location.id, klSiteId));
    expect(site.state, 'the site still carries Kuala Lumpur; the resolver simply stopped reading it').toBe(
      'Kuala Lumpur',
    );
  });

  it('2. THE PROMISE: an employee whose work_state carries the state keeps exactly the calendar they had', async () => {
    const now = await resolve(carried);
    expect(sorted(now)).toEqual(CALENDAR_BEFORE_THE_CHANGE);
    expect(now.has(KL_ONLY)).toBe(true);
  });

  it('2b. THE TWO READERS AGREE about which gazette that employee follows', async () => {
    // holidayDatesFor feeds attendance and the working-day leave count; effectiveHolidayState feeds the
    // s.60D completeness guard. They lost the site join in ONE commit, and this is what makes that
    // enforceable: a state here that the resolver does not use is the r209-class defect.
    const eff = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, carried));
    expect(eff?.state).toBe('Kuala Lumpur');
    expect(eff?.skipCompleteness).toBeUndefined();

    const effUncarried = await withTenant(adminCtx(b), (tx) => effectiveHolidayState(tx, onSite));
    expect(effUncarried?.state, 'the site rung is gone from this reader too').toBe('Selangor');
  });

  it('3. THE ORDER: an employee who never had the state carried falls to the company default', async () => {
    const uncarried = await resolve(onSite);
    const withCarry = await resolve(carried);
    expect(uncarried.has(KL_ONLY)).toBe(false);
    expect(withCarry.has(KL_ONLY)).toBe(true);
    // Both are at the SAME site. The only difference is employment.work_state — which is the whole reason
    // the carry had to run cross-tenant on production before this change, and did.
  });

  it('4. A NAMED SITE CALENDAR NO LONGER REACHES ANYBODY THROUGH A SITE (ADR-0067 §(b) retired)', async () => {
    const now = await resolve(onCalendarSite);
    // Before r331 this resolved to ONLY the custom calendar's own day and no gazette.
    expect(now.has(SITE_CALENDAR_DAY)).toBe(false);
    expect(sorted(now)).toEqual([SELANGOR_ONLY, NATIONAL].sort());

    // …and the mapping is still on the row: again the reader changed, not the data.
    const [mapped] = await owner.db
      .select({ gid: schema.location.holidayGroupId })
      .from(schema.location)
      .where(eq(schema.location.code, 'SUB-5'));
    expect(mapped.gid, 'the site still maps a calendar; nothing reads it').not.toBeNull();
  });

  it('5. ONE KEY, TWO MEMOS: both call sites go through holidayMemoKey, on THREE inputs', () => {
    // Two hand-written copies of the key made "together" a thing a person had to remember. One exported
    // function makes it structural: a determining input cannot leave one key and stay in the other,
    // because there is only one key. ADR-0086 is the case that matters — an input LEFT.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const HAND_ROLLED = /JSON\.stringify\(\[[^\]]*companyId|\$\{[\w.]*companyId\}\|/g;
    const counts: Record<string, number> = {};
    for (const f of ['../core/holidays.ts', '../core/absence-days.ts']) {
      const src = stripComments(readFileSync(new URL(f, import.meta.url), 'utf8'));
      expect(src, `${f} must key its holiday memo through holidayMemoKey`).toContain('holidayMemoKey(');
      counts[f] = (src.match(HAND_ROLLED) ?? []).length;
    }
    expect(counts['../core/holidays.ts'], 'holidayMemoKey is the only place the key is spelled out').toBe(1);
    expect(counts['../core/absence-days.ts'], 'core/absence-days.ts re-expresses the memo key by hand').toBe(0);
    // THREE inputs, and no fourth: a key that still carried locationId would be keying on something the
    // resolver cannot read, so two employees at different sites would be handed separate cache entries
    // for an answer that is provably identical — harmless today, and a lie about what a calendar depends on.
    expect(JSON.parse(holidayMemoKey({ companyId: 'c', workState: null, holidayGroupId: null }))).toHaveLength(3);
    // JSON, so null and '' stay distinct and no value can forge a separator.
    const base = { companyId: 'c', workState: null, holidayGroupId: null };
    expect(holidayMemoKey(base)).not.toEqual(holidayMemoKey({ ...base, workState: '' }));
    expect(holidayMemoKey({ ...base, workState: 'a|b' })).not.toEqual(
      holidayMemoKey({ ...base, workState: 'a', holidayGroupId: 'b' }),
    );
    expect(holidayMemoKey(base)).toEqual(holidayMemoKey({ ...base }));
  });

  it('6. THE BATCH RESOLVER AGREES with the single one, per employee', async () => {
    const batch = await withTenant(adminCtx(b), (tx) =>
      holidayDatesByEmployment(tx, {
        employmentIds: [onSite, carried, onCalendarSite],
        startDate: START,
        endDate: END,
      }),
    );
    for (const id of [onSite, carried, onCalendarSite]) {
      expect(sorted(batch.get(id)!), `batch and single resolver disagree for ${id}`).toEqual(sorted(await resolve(id)));
    }
    // onSite and onCalendarSite share all THREE inputs (same company, no work_state, no group) and are at
    // DIFFERENT sites — under the old four-input key they were two entries; now they are one, and the
    // answer is the same either way, which is the evidence that the fourth input was not determining.
    expect(sorted(batch.get(onSite)!)).toEqual(sorted(batch.get(onCalendarSite)!));
  });

  it('7. NO ASSIGNMENT-LEVEL INPUT REACHES A CALENDAR: the ambiguity escape hatch has nothing to disambiguate', () => {
    // Both memos used to refuse to memoize an employment with MORE THAN ONE open assignment, because the
    // resolver joined `assignment` and took an arbitrary row via `.limit(1)`; picking a different row than
    // the resolver would have handed somebody another person's public holidays. The database forbids
    // overlapping open assignments (`assignment_no_overlap`, migration 0001), so the hatch could not be
    // exercised from a fixture — which is why it is pinned STRUCTURALLY here instead of by data: the only
    // thing that made two open rows matter was the join, and the join is gone.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const resolver = stripComments(readFileSync(new URL('../core/holidays.ts', import.meta.url), 'utf8'));
    const absence = stripComments(readFileSync(new URL('../core/absence-days.ts', import.meta.url), 'utf8'));
    for (const [name, src] of [
      ['core/holidays.ts', resolver],
      ['core/absence-days.ts', absence],
    ] as const) {
      expect(src, `${name} must not read the assignment table to resolve or key a calendar`).not.toMatch(
        /assignment\.locationId|leftJoin\(\s*assignment/,
      );
    }
    // …and nothing in either file still branches on how many open assignments an employment has.
    expect(resolver).not.toContain('openCount');
    expect(absence).not.toContain('openCount');
  });
});
