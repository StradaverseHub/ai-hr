/**
 * ADR-0054 — Location master data: CRUD + integrity, the DomainEvent substrate, RLS read+write scoping
 * (as a real ai_hr_app admin, NOT owner.db which bypasses RLS), the INSERT…RETURNING-under-app-role path,
 * cross-company coherence, effective-dating via assignment, and the decisive time-engine consistency:
 * the four time engines all agree with leave on a state-specific holiday. ⚠️ ADR-0086 (r331) moved the
 * INPUT of that agreement down one rung: `location.state` was the top of the precedence and is no longer
 * read at all; `employment.work_state` carries it. The consistency claim is unchanged and still decisive —
 * see the test itself. Plus a byte-identical compat golden test (null-location path).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { CrossCompanyError, hireEmployee, setEmploymentHolidayCalendar, transferEmployee } from '../core/org';
import { createCompany, createDepartment } from '../core/admin';
import {
  createLocation,
  updateLocation,
  archiveLocation,
  restoreLocation,
  listLocations,
} from '../core/location';
import {
  attendanceForDate,
  attendanceMonthSummary,
  checkIn,
  checkOut,
  requestAttendanceCorrection,
} from '../core/attendance';
import { type SessionContext } from '../db/client';

let b: Base;
const uniqEmail = () => `loc_${randomUUID().slice(0, 8)}@t.local`;

/** A company-scoped hr_admin SessionContext (carries the grant so authz + RLS see it). */
async function adminFor(companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

async function openAssignment(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    );
  return row;
}

const hire = (ctx: SessionContext, companyId: string, departmentId: string, extra?: Record<string, unknown>) =>
  hireEmployee(ctx, {
    person: { fullName: 'Loc Emp', primaryEmail: uniqEmail() },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
    ...extra,
  });

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('location master data (ADR-0054)', () => {
  it('creates + updates: code is uppercased, fields persist', async () => {
    const a = adminCtx(b);
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'hq', name: 'Head Office' });
    const [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, id));
    expect(row.code).toBe('HQ'); // uppercased
    expect(row.name).toBe('Head Office');
    expect(row.country).toBe('MY');
    expect(row.state).toBeNull();

    await updateLocation(a, { locationId: id, code: 'hq2', name: 'HQ Tower', country: 'my', state: 'Sarawak' });
    const [u] = await owner.db.select().from(schema.location).where(eq(schema.location.id, id));
    expect(u.code).toBe('HQ2');
    expect(u.name).toBe('HQ Tower');
    expect(u.state).toBe('Sarawak');
  });

  it('rejects an unknown state and blank code/name', async () => {
    const a = adminCtx(b);
    await expect(createLocation(a, { companyId: b.companyId, code: 'X', name: 'X', state: 'Atlantis' })).rejects.toThrow(/Unknown state/);
    await expect(createLocation(a, { companyId: b.companyId, code: '  ', name: 'X' })).rejects.toThrow(/code is required/);
    await expect(createLocation(a, { companyId: b.companyId, code: 'X', name: '  ' })).rejects.toThrow(/name is required/);
  });

  it('code is unique among non-archived; archive frees the code; restore works', async () => {
    const a = adminCtx(b);
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'DUP', name: 'One' });
    await expect(createLocation(a, { companyId: b.companyId, code: 'DUP', name: 'Two' })).rejects.toThrow();

    await archiveLocation(a, { locationId: id });
    // default list hides archived, includeArchived shows it.
    expect((await listLocations(a, [b.companyId])).map((l) => l.id)).not.toContain(id);
    expect((await listLocations(a, [b.companyId], { includeArchived: true })).map((l) => l.id)).toContain(id);
    // archived row persists (soft delete) and the code is now reusable.
    const { id: id2 } = await createLocation(a, { companyId: b.companyId, code: 'DUP', name: 'Two' });
    expect(id2).toBeTruthy();
    // restore is blocked while another non-archived row holds the same code (partial-unique guard).
    await expect(restoreLocation(a, { locationId: id })).rejects.toThrow();

    // free the code, then restore succeeds and the row reappears in the default list.
    await archiveLocation(a, { locationId: id2 });
    await restoreLocation(a, { locationId: id });
    expect((await listLocations(a, [b.companyId])).map((l) => l.id)).toContain(id);
  });

  /**
   * ADR-0086 (item 0fe1ca2e, r331) — AN ABSENT `state` MEANS KEEP, AND THE SAVE BUTTON DEPENDS ON IT.
   *
   * r331 removed the State control from the site register: nothing reads `location.state` any more, so
   * offering one would have been offering a control that changes nothing while the screen's own note
   * claimed it drove public holidays. The column is KEPT (db/schema.ts) as the record of what each site
   * was supplying before the r328 carry moved that state onto `employment.work_state`.
   *
   * THE DEFECT THAT CREATED, and what this pins: `updateLocationAction` passed
   * `state: fd.get('state') || null`. With the field gone from the form that is an explicit NULL on every
   * Save, so renaming a site would have silently erased its state — destroying precisely the history the
   * decision to keep the column was protecting, on a screen that no longer mentions state at all.
   *
   * ⚠️ IT LIVES IN THE CONTRACT BETWEEN TWO FILES, so it is pinned across both (CLAUDE.md §8): the service
   * must treat absent as keep, AND the action must actually omit it. Either half alone is satisfiable by a
   * change that still loses the data.
   */
  it('ADR-0086: updating a location WITHOUT a state keeps the stored one; an explicit null clears it', async () => {
    const a = adminCtx(b);
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'KEEP', name: 'Keeper', state: 'Sarawak' });

    // Exactly the shape the register's Save posts now — code / name / country / branch, and no state.
    await updateLocation(a, { locationId: id, code: 'KEEP', name: 'Keeper Renamed' });
    const afterRename = (await listLocations(a, [b.companyId])).find((r) => r.id === id)!;
    expect(afterRename.name, 'the rename applied').toBe('Keeper Renamed');
    expect(afterRename.state, 'an unrelated Save must not erase the state').toBe('Sarawak');

    // …and the caller that MEANS "clear it" still can: undefined and null are different answers.
    await updateLocation(a, { locationId: id, code: 'KEEP', name: 'Keeper Renamed', state: null });
    expect((await listLocations(a, [b.companyId])).find((r) => r.id === id)!.state).toBeNull();
  });

  it('ADR-0086: the register’s own action omits `state` rather than posting null', () => {
    // The other half of the contract above. `updateLocation` treating absent as "keep" is only protective
    // if the action stops sending a value — and the action reading a field the form no longer renders is
    // exactly how this returns.
    const src = readFileSync(resolvePath(__dirname, '..', 'app/admin/actions.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const update = src.slice(src.indexOf('export async function updateLocationAction'));
    const body = update.slice(0, update.indexOf('export async function', 1));
    expect(body, 'the Save must not post a state').not.toContain("fd.get('state')");
    // …and the fields it DOES still post, so this cannot pass on an action that stopped posting anything.
    for (const kept of ['code', 'name', 'country', 'branch']) {
      expect(body, `${kept} is still posted`).toContain(`fd.get('${kept}')`);
    }
  });

  it('appends location.created / updated / archived / restored events', async () => {
    const a = adminCtx(b);
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'EV', name: 'Ev' });
    await updateLocation(a, { locationId: id, code: 'EV', name: 'Ev2' });
    await archiveLocation(a, { locationId: id });
    await restoreLocation(a, { locationId: id });
    const types = await eventTypesFor(b.tenantId, id);
    expect(types).toEqual(
      expect.arrayContaining(['location.created', 'location.updated', 'location.archived', 'location.restored']),
    );
  });

  it('RLS: a company-A admin cannot create/update/see a company-B location', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Co B Sdn Bhd' });
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    // a group-wide admin makes a B location for the read-leak test
    const { id: bLoc } = await createLocation(a, { companyId: coB, code: 'BLOC', name: 'B Site' });

    const adminA = await adminFor(b.companyId); // scoped to company A only

    // write scoping: cannot create under B
    await expect(createLocation(adminA, { companyId: coB, code: 'X', name: 'X' })).rejects.toThrow();
    // update scoping: the B row is invisible to A's UPDATE … WHERE (RLS USING), so it's a no-op write that
    // throws "Location not found" (the before-read returns nothing).
    await expect(updateLocation(adminA, { locationId: bLoc, code: 'Y', name: 'Y' })).rejects.toThrow(/not found/);
    // read scoping (the read-leak finding): A's listLocations does NOT see B's location.
    const seen = await listLocations(adminA, [coB]);
    expect(seen.map((l) => l.id)).not.toContain(bLoc);
    expect(deptB).toBeTruthy();
  });

  it('assigns a location through transferEmployee as an app-role admin (INSERT…RETURNING under RLS)', async () => {
    const a = adminCtx(b);
    const { id: loc } = await createLocation(a, { companyId: b.companyId, code: 'SITE', name: 'Site' });
    const e = await hire(a, b.companyId, b.deptA);
    const adminA = await adminFor(b.companyId);
    const { assignmentId } = await transferEmployee(adminA, {
      employmentId: e.employmentId,
      effectiveDate: '2026-02-01',
      locationId: loc,
    });
    expect(assignmentId).toBeTruthy(); // RETURNING succeeded under the non-owner app role
    const open = await openAssignment(e.employmentId);
    expect(open.locationId).toBe(loc);
  });

  it('cross-company coherence: transferEmployee rejects a location from another company', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Co B Sdn Bhd' });
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    const { id: bLoc } = await createLocation(a, { companyId: coB, code: 'BLOC', name: 'B Site' });
    const e = await hire(a, b.companyId, b.deptA); // employment in company A
    await expect(
      transferEmployee(a, { employmentId: e.employmentId, effectiveDate: '2026-02-01', locationId: bLoc }),
    ).rejects.toThrow(CrossCompanyError);
    expect(deptB).toBeTruthy();
  });

  it('effective-dating: setting a location CLOSEs the prior assignment and opens a new version carrying it', async () => {
    const a = adminCtx(b);
    const { id: loc } = await createLocation(a, { companyId: b.companyId, code: 'EFF', name: 'Eff' });
    const e = await hire(a, b.companyId, b.deptA);
    const prior = await openAssignment(e.employmentId);
    expect(prior.locationId).toBeNull();

    await transferEmployee(a, { employmentId: e.employmentId, effectiveDate: '2026-03-01', locationId: loc });
    // the prior version is CLOSEd (valid_to set), never deleted.
    const [priorAfter] = await owner.db.select().from(schema.assignment).where(eq(schema.assignment.id, prior.id));
    expect(priorAfter.validTo).toBe('2026-03-01');
    // the open version is the new one and carries the location.
    const open = await openAssignment(e.employmentId);
    expect(open.id).not.toBe(prior.id);
    expect(open.locationId).toBe(loc);
  });

  // ── The decisive time-engine consistency test, ADR-0086 EDITION ────────────────────────────────────
  /**
   * ⚠️ UPDATED, NOT DELETED (CLAUDE.md §8). ADR-0054 made `location.state` the top rung of the holiday
   * precedence so that checkIn, attendanceForDate and attendanceMonthSummary all agreed with leave about
   * a state-specific holiday. ADR-0086 (item 0fe1ca2e, r331) retires the work-site register: the SITE is
   * no longer read, and `employment.work_state` carries that job — which is what it already did for every
   * affected employee on production before the change (ADR-0086 §2).
   *
   * THE CLAIM THIS TEST EXISTS TO MAKE IS UNCHANGED: whatever decides an employee's gazette, all four
   * engines decide it the SAME way. Only the input moved down a rung. So the fixture keeps the Sarawak
   * SITE — and pins that it decides nothing — while the identical assertions now ride on work_state.
   */
  it('ADR-0086: the SITE no longer classifies a state holiday; employment.work_state does, and all engines agree', async () => {
    const a = adminCtx(b);
    // A Sarawak-only holiday on a Wednesday (2026-07-22 = Wed, a normal workday otherwise).
    const HOL = '2026-07-22';
    await owner.db.insert(schema.holiday).values({ tenantId: b.tenantId, country: 'MY', state: 'Sarawak', holidayDate: HOL, name: 'Sarawak Day (test)' });

    const { id: kch } = await createLocation(a, { companyId: b.companyId, code: 'KCH', name: 'Kuching', state: 'Sarawak' });

    // (1) THE REVERSAL. An employee at the Sarawak SITE with NO work_state — the exact shape that used to
    //     resolve 'holiday'. ⚠️ MUTATION TARGET: restore the location join in core/holidays.ts and this
    //     flips back to 'holiday'.
    const siteOnly = await hire(a, b.companyId, b.deptA);
    await transferEmployee(a, { employmentId: siteOnly.employmentId, effectiveDate: '2024-01-01', locationId: kch });
    await checkIn(a, { employmentId: siteOnly.employmentId, date: HOL, time: '09:00:00' });
    const [siteRow] = await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, siteOnly.employmentId));
    expect(siteRow.dayType, 'the site’s Sarawak no longer reaches the day type').toBe('workday');

    // (2) THE REPLACEMENT. The same employee shape, but the state carried on the PERSON — at the same site,
    //     so the only difference between (1) and (2) is work_state.
    const swk = await hire(a, b.companyId, b.deptA);
    await transferEmployee(a, { employmentId: swk.employmentId, effectiveDate: '2024-01-01', locationId: kch });
    await setEmploymentHolidayCalendar(a, { employmentId: swk.employmentId, selection: { kind: 'state', state: 'Sarawak' } });
    await checkIn(a, { employmentId: swk.employmentId, date: HOL, time: '09:00:00' });
    const [swkRow] = await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, swk.employmentId));
    expect(swkRow.dayType).toBe('holiday');

    // Employee with no location and no work_state — unaffected (the company has no default_work_state).
    const nat = await hire(a, b.companyId, b.deptB);
    await checkIn(a, { employmentId: nat.employmentId, date: HOL, time: '09:00:00' });
    const [natRow] = await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, nat.employmentId));
    expect(natRow.dayType).toBe('workday'); // national-only employee: a Sarawak holiday is a normal workday

    // attendanceForDate (dayContextFor): contextualize an employee who did NOT check in, so the context is
    // computed from the holiday set rather than from a stamped row.
    const swk2 = await hire(a, b.companyId, b.deptA);
    await transferEmployee(a, { employmentId: swk2.employmentId, effectiveDate: '2024-01-01', locationId: kch });
    await setEmploymentHolidayCalendar(a, { employmentId: swk2.employmentId, selection: { kind: 'state', state: 'Sarawak' } });
    const siteOnly2 = await hire(a, b.companyId, b.deptA); // same SITE, no work_state — the control
    await transferEmployee(a, { employmentId: siteOnly2.employmentId, effectiveDate: '2024-01-01', locationId: kch });
    const ctxRows = await attendanceForDate(a, HOL, [b.companyId]);
    expect(ctxRows.find((r) => r.employmentId === swk2.employmentId)?.context).toBe('holiday');
    expect(
      ctxRows.find((r) => r.employmentId === siteOnly2.employmentId)?.context,
      'at the same site, without the state on the person: an ordinary Wednesday',
    ).toBeNull();
    expect(ctxRows.find((r) => r.employmentId === nat.employmentId)?.context).toBeNull(); // already has a row

    // attendanceMonthSummary: the Sarawak holiday is NOT counted as an absence for the Sarawak employee,
    // but IS for a national-only employee with no row that day.
    const nat2 = await hire(a, b.companyId, b.deptB); // no location, no work_state, never checks in
    const sum = await attendanceMonthSummary(a, { month: '2026-07', companyIds: [b.companyId], today: '2026-07-31' });
    const swk2Sum = sum.find((r) => r.employmentId === swk2.employmentId)!;
    const nat2Sum = sum.find((r) => r.employmentId === nat2.employmentId)!;
    const siteOnly2Sum = sum.find((r) => r.employmentId === siteOnly2.employmentId)!;
    // The ONLY difference is work_state — absent for the national employee (a normal Wednesday workday)
    // but a holiday (not absent) for the Sarawak employee…
    expect(nat2Sum.absent).toBe(swk2Sum.absent + 1);
    // …and the employee at the Sarawak SITE with no work_state counts exactly like the national one.
    expect(siteOnly2Sum.absent).toBe(nat2Sum.absent);
  });

  // ── Byte-identical compat: the null-location path is unchanged (precedent #148) ────────────────────
  it('with zero locations and no state holidays, attendance is byte-identical to pre-change', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    // A plain workday, no location anywhere.
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:30:00' }); // Mon, late (>09:15)
    await checkOut(a, { employmentId: e.employmentId, date: '2026-07-06', time: '18:00:00' });
    const [row] = await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, e.employmentId));
    expect(row.status).toBe('late');
    expect(row.dayType).toBe('workday');
    expect(row.workedMinutes).toBe(450); // 09:30→18:00 = 510 span − 60 break
    expect(row.otMinutes).toBe(0); // 450 ≤ 480 scheduled (09:00–18:00 − 60)

    // a correction funnels through the same resolver — still workday.
    await requestAttendanceCorrection(a, {
      employmentId: e.employmentId,
      date: '2026-07-06',
      checkIn: '09:00:00',
      checkOut: '18:00:00',
      reason: 'Correction',
    });

    const sum = await attendanceMonthSummary(a, { month: '2026-07', companyIds: [b.companyId], today: '2026-07-06' });
    const mine = sum.find((r) => r.employmentId === e.employmentId)!;
    expect(mine.late).toBe(1);
    // Jul 1–3 (Wed–Fri) are workdays with no row ⇒ 3 absences; Jul 6 has the row. This is unchanged
    // pre-change behaviour (national-only path with no location), proving byte-identical compat.
    expect(mine.absent).toBe(3);
  });
});
