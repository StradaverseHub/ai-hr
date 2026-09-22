/**
 * 0fe1ca2e — the READ-ONLY preview behind scripts/report-location-holiday-deltas.ts, and the reason the
 * removal's ORDER is load-bearing.
 *
 * The approved plan removes the per-company site register (`location`). Two production employees take
 * their public holidays from a site whose state is Kuala Lumpur while their company's default is Selangor,
 * so the removal moves a real calendar unless `employment.work_state` carries that state FIRST. The plan
 * promises the reporter a demonstrated before/after rather than an assertion, and the report gets its
 * AFTER figure from the REAL resolver via `holidayDatesFor`'s `whatIf` override rather than from a second
 * copy of the precedence rules.
 *
 * This file pins the three claims that preview makes, on a fixture shaped like production:
 *   1. NON-VACUITY — without the override the site's state really is deciding the calendar, and the
 *      override changes nothing for any existing caller (omitted ⇒ byte-identical answer).
 *   2. THE PROMISE — drop the site AND carry its state onto work_state, and the set is IDENTICAL. This is
 *      the "nothing moved" the report prints.
 *   3. THE ORDER — drop the site WITHOUT carrying the state, and the employee loses the site's state
 *      holiday and picks up the company default's. Skipping the work-state step is exactly the one-way
 *      loss of a public holiday the plan warns about, and this is what that looks like.
 * Plus: a site mapped to a NAMED CALENDAR loses the calendar too, because a work_state cannot carry one —
 * the preview blanks every site-derived input together, and a preview that blanked only the state would
 * report a reassuring "nothing moved" for a calendar that does not survive.
 *
 * Window is a HISTORICAL year (2025): no hardcoded future dates, and nothing here moves when the clock does.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { createHolidayGroup } from '../core/admin';
import { holidayDatesByEmployment, holidayDatesFor } from '../core/holidays';
import { createLocation } from '../core/location';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const START = '2025-01-01';
const END = '2025-12-31';

const NATIONAL = '2025-08-31'; // Merdeka — everybody
const KL_ONLY = '2025-02-01'; // Federal Territory Day — the site's state, and the day production would lose
const SELANGOR_ONLY = '2025-07-15'; // the company default's own day (production has none; the fixture does,
//                                     so the fallback is VISIBLE rather than merely absent)
const SITE_CALENDAR_DAY = '2025-05-20'; // a named calendar's own extra day

let b: Base;
let onSite = ''; // company default Selangor, open assignment at a Kuala Lumpur site — the production shape
let onCalendarSite = ''; // open assignment at a site mapped to a CUSTOM named calendar

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

  const klSite = await createLocation(ctx, {
    companyId: b.companyId,
    code: 'SUB-4',
    name: 'Sub 4',
    state: 'Kuala Lumpur',
  });
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
  await putAtSite(onSite, klSite.id);
  onCalendarSite = await hire('onCalendarSite');
  await putAtSite(onCalendarSite, calSite.id);
});

afterAll(closeAll);

const resolve = (employmentId: string, whatIf?: { dropLocation: true; workState: string | null }) =>
  withTenant(adminCtx(b), (tx) => holidayDatesFor(tx, { employmentId, startDate: START, endDate: END, whatIf }));

describe('0fe1ca2e — previewing the site register removal', () => {
  it('NON-VACUITY: the site state decides the calendar today, and omitting whatIf changes nothing', async () => {
    const before = await resolve(onSite);
    // The site's Kuala Lumpur beats the company's Selangor default — if this ever stops being true the
    // preview below is comparing two copies of the same answer and proves nothing.
    expect(sorted(before)).toEqual([KL_ONLY, NATIONAL]);
    expect(before.has(SELANGOR_ONLY)).toBe(false);
  });

  it('THE PROMISE: drop the site AND carry its state onto work_state — the calendar is identical', async () => {
    const before = await resolve(onSite);
    const after = await resolve(onSite, { dropLocation: true, workState: 'Kuala Lumpur' });
    expect(sorted(after)).toEqual(sorted(before));
    expect(after.has(KL_ONLY)).toBe(true);
  });

  it('THE ORDER: drop the site WITHOUT carrying the state — a public holiday is lost', async () => {
    const before = await resolve(onSite);
    const after = await resolve(onSite, { dropLocation: true, workState: null });
    // Loses the site state's day, and falls to the company default's calendar instead.
    expect(before.has(KL_ONLY)).toBe(true);
    expect(after.has(KL_ONLY)).toBe(false);
    expect(sorted(after)).toEqual([SELANGOR_ONLY, NATIONAL].sort());
  });

  it('A NAMED SITE CALENDAR DOES NOT SURVIVE: work_state cannot carry one', async () => {
    const before = await resolve(onCalendarSite);
    // A custom calendar resolves to ONLY its own days — no gazette (ADR-0067).
    expect(sorted(before)).toEqual([SITE_CALENDAR_DAY]);
    const after = await resolve(onCalendarSite, { dropLocation: true, workState: 'Kuala Lumpur' });
    expect(after.has(SITE_CALENDAR_DAY)).toBe(false);
    expect(sorted(after)).toEqual([KL_ONLY, NATIONAL]);
  });

  it('THE MEMOS ARE UNTOUCHED: the batch resolver still answers the LIVE calendar', async () => {
    // holidayDatesByEmployment keys on the four DETERMINING INPUTS read from the database. A what-if is a
    // property of a CALL, not of an employment, so it must never reach that key — a memo that cached a
    // preview under a real employment's key would hand somebody a calendar they do not have.
    const batch = await withTenant(adminCtx(b), (tx) =>
      holidayDatesByEmployment(tx, { employmentIds: [onSite, onCalendarSite], startDate: START, endDate: END }),
    );
    expect(sorted(batch.get(onSite)!)).toEqual([KL_ONLY, NATIONAL]);
    expect(sorted(batch.get(onCalendarSite)!)).toEqual([SITE_CALENDAR_DAY]);
  });
});
