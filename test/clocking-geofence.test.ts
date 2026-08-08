/**
 * ADR-0070 — Clocking Location Management & Geofencing. Haversine golden vectors, CRUD + archive/
 * restore/delete-guard on the new clocking_location catalog + its DomainEvent substrate, set-based
 * assignment replace with the cross-company guard, per-employee geofencing config, the checkIn/checkOut
 * enforcement path (pass / outside-radius-blocked / zero-sites-fail-closed / missing-coords), the
 * BLOCKED-EVENT mechanism (the regression test for the fatal "event never commits inside a rolled-back
 * transaction" flaw), import/correction geo-nulling, and RLS (tenant-catalog read, admin-of-company write).
 */
import { and, eq, isNull } from 'drizzle-orm';
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
import { hireEmployee } from '../core/org';
import { createCompany, createDepartment } from '../core/admin';
import {
  createClockingLocation,
  updateClockingLocation,
  archiveClockingLocation,
  restoreClockingLocation,
  deleteClockingLocation,
  listClockingLocations,
  listEmployeeClockingLocations,
  setEmployeeClockingLocations,
  setGeofencing,
  radiusWarning,
  ClockingLocationInUseError,
  ClockingLocationLinkError,
  CrossCompanyClockingLocationError,
  RADIUS_ADVISORY_MAX_M,
  RADIUS_ADVISORY_MIN_M,
} from '../core/clocking-location';
import { archiveLocation, createLocation } from '../core/location';
import {
  checkIn,
  checkOut,
  decideAttendanceCorrection,
  haversineMetres,
  importAttendancePunches,
  requestAttendanceCorrection,
  GeolocationRequiredError,
  OutsideGeofenceError,
} from '../core/attendance';
import { type SessionContext } from '../db/client';

let b: Base;
const uniqEmail = () => `geo_${randomUUID().slice(0, 8)}@t.local`;

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

/** A plain-employee SessionContext scoped to one person (for RLS read/write checks). */
async function employeeCtxFor(personId: string): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { tenantId: b.tenantId, userId: u.id, personId, grants: [{ role: 'employee', companyId: null }] };
}

const hire = (ctx: SessionContext, companyId: string, departmentId: string, name = 'Geo Emp') =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/**
 * 1fff489c — every clocking point now REQUIRES a radius AND a link to a non-archived `location` in the
 * same company. These two helpers keep the pre-existing cases (which are about geofencing, not about the
 * link) reading as they did: `mkSite()` supplies a default 300 m radius and memoises one location per
 * company. Cases that are ABOUT the radius or the link pass their own values and call the service direct.
 */
let locationSeq = 0;
const locationByCompany = new Map<string, string>();
async function defaultLocationFor(ctx: SessionContext, companyId: string): Promise<string> {
  const hit = locationByCompany.get(companyId);
  if (hit) return hit;
  // Code is unique per TENANT among non-archived rows, so it has to be distinct across companies too.
  const { id } = await createLocation(ctx, { companyId, code: `SITE${++locationSeq}`, name: `Site ${locationSeq}` });
  locationByCompany.set(companyId, id);
  return id;
}
async function mkSite(
  ctx: SessionContext,
  p: { companyId: string; name: string; lat: number; lng: number; radiusM?: number; locationId?: string },
) {
  const locationId = p.locationId ?? (await defaultLocationFor(ctx, p.companyId));
  return createClockingLocation(ctx, {
    companyId: p.companyId,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    radiusM: p.radiusM ?? 300,
    locationId,
  });
}

async function attendanceRow(employmentId: string, date: string) {
  const [row] = await owner.db
    .select()
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  return row;
}

// Kuala Lumpur-ish coordinates for the "site" and a couple of test offsets.
const HQ = { lat: 3.139, lng: 101.6869 };

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  locationByCompany.clear();
  b = await seedBase();
});

describe('haversineMetres (pure)', () => {
  it('is zero at the same point', () => {
    expect(haversineMetres(HQ.lat, HQ.lng, HQ.lat, HQ.lng)).toBe(0);
  });
  it('is roughly 157m for a ~0.001-degree pair near KL', () => {
    const d = haversineMetres(HQ.lat, HQ.lng, HQ.lat + 0.001, HQ.lng);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(200);
  });
  it('is symmetric', () => {
    const a = haversineMetres(HQ.lat, HQ.lng, HQ.lat + 0.01, HQ.lng + 0.01);
    const c = haversineMetres(HQ.lat + 0.01, HQ.lng + 0.01, HQ.lat, HQ.lng);
    expect(a).toBeCloseTo(c, 6);
  });
});

describe('clocking_location CRUD (ADR-0070)', () => {
  it('creates + updates + persists fields', async () => {
    const a = adminCtx(b);
    const loc = await defaultLocationFor(a, b.companyId);
    const { id } = await mkSite(a, { companyId: b.companyId, name: 'HQ Tower', lat: HQ.lat, lng: HQ.lng });
    const [row] = await owner.db.select().from(schema.clockingLocation).where(eq(schema.clockingLocation.id, id));
    expect(row.name).toBe('HQ Tower');
    expect(row.lat).toBeCloseTo(HQ.lat, 6);
    expect(row.lng).toBeCloseTo(HQ.lng, 6);
    expect(row.address).toBeNull();
    // 1fff489c — the two new columns are persisted, not silently dropped.
    expect(row.radiusM).toBe(300);
    expect(row.locationId).toBe(loc);

    await updateClockingLocation(a, {
      clockingLocationId: id,
      name: 'HQ Tower 2',
      lat: HQ.lat + 1,
      lng: HQ.lng + 1,
      radiusM: 250,
      locationId: loc,
      address: '123 Jalan Test',
      remarks: 'main site',
    });
    const [u] = await owner.db.select().from(schema.clockingLocation).where(eq(schema.clockingLocation.id, id));
    expect(u.name).toBe('HQ Tower 2');
    expect(u.address).toBe('123 Jalan Test');
    expect(u.remarks).toBe('main site');
    expect(u.radiusM).toBe(250);
  });

  it('rejects blank name and out-of-range coordinates', async () => {
    const a = adminCtx(b);
    await expect(mkSite(a, { companyId: b.companyId, name: '  ', lat: 0, lng: 0 })).rejects.toThrow(/name is required/);
    await expect(mkSite(a, { companyId: b.companyId, name: 'X', lat: 999, lng: 0 })).rejects.toThrow(/Latitude/);
    await expect(mkSite(a, { companyId: b.companyId, name: 'X', lat: 0, lng: 999 })).rejects.toThrow(/Longitude/);
  });

  it('name unique per company; archive/restore; hard delete when unreferenced', async () => {
    const a = adminCtx(b);
    const { id } = await mkSite(a, { companyId: b.companyId, name: 'DupSite', lat: HQ.lat, lng: HQ.lng });
    await expect(mkSite(a, { companyId: b.companyId, name: 'DupSite', lat: HQ.lat, lng: HQ.lng })).rejects.toThrow();

    await archiveClockingLocation(a, { clockingLocationId: id });
    expect((await listClockingLocations(a, [b.companyId])).map((l) => l.id)).not.toContain(id);
    expect((await listClockingLocations(a, [b.companyId], { includeArchived: true })).map((l) => l.id)).toContain(id);

    await restoreClockingLocation(a, { clockingLocationId: id });
    expect((await listClockingLocations(a, [b.companyId])).map((l) => l.id)).toContain(id);

    await deleteClockingLocation(a, { clockingLocationId: id });
    expect((await listClockingLocations(a, [b.companyId], { includeArchived: true })).map((l) => l.id)).not.toContain(id);
  });

  it('delete refuses when referenced by an assignment or attendance row', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'Ref Site', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site] });
    await expect(deleteClockingLocation(a, { clockingLocationId: site })).rejects.toBeInstanceOf(ClockingLocationInUseError);

    // free the assignment reference, then reference it via an attendance row instead (geofencing OFF here
    // so no radius check needed; checkIn with a matched site only happens when geofencing is ON, so for
    // this guard test we assign+enable+checkIn to actually populate the attendance FK).
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 500 });
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: HQ });
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [] });
    await expect(deleteClockingLocation(a, { clockingLocationId: site })).rejects.toBeInstanceOf(ClockingLocationInUseError);
  });

  it('appends clocking-location.created/updated/archived/restored/deleted events', async () => {
    const a = adminCtx(b);
    const { id } = await mkSite(a, { companyId: b.companyId, name: 'EvSite', lat: HQ.lat, lng: HQ.lng });
    await updateClockingLocation(a, {
      clockingLocationId: id,
      name: 'EvSite2',
      lat: HQ.lat,
      lng: HQ.lng,
      radiusM: 300,
      locationId: await defaultLocationFor(a, b.companyId),
    });
    await archiveClockingLocation(a, { clockingLocationId: id });
    await restoreClockingLocation(a, { clockingLocationId: id });
    await deleteClockingLocation(a, { clockingLocationId: id });
    const types = await eventTypesFor(b.tenantId, id);
    expect(types).toEqual(
      expect.arrayContaining([
        'clocking-location.created',
        'clocking-location.updated',
        'clocking-location.archived',
        'clocking-location.restored',
        'clocking-location.deleted',
      ]),
    );
  });
});

describe('assignment + geofencing config (ADR-0070)', () => {
  it('set-based replace assigns and unassigns; cross-company rejected', async () => {
    const a = adminCtx(b);
    const { id: site1 } = await mkSite(a, { companyId: b.companyId, name: 'S1', lat: HQ.lat, lng: HQ.lng });
    const { id: site2 } = await mkSite(a, { companyId: b.companyId, name: 'S2', lat: HQ.lat + 0.01, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);

    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site1, site2] });
    let assigned = await listEmployeeClockingLocations(a, e.employmentId);
    expect(assigned.map((s) => s.id).sort()).toEqual([site1, site2].sort());

    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site1] });
    assigned = await listEmployeeClockingLocations(a, e.employmentId);
    expect(assigned.map((s) => s.id)).toEqual([site1]);

    const { id: coB } = await createCompany(a, { legalName: 'Co B Sdn Bhd' });
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    const { id: bSite } = await mkSite(a, { companyId: coB, name: 'BSite', lat: HQ.lat, lng: HQ.lng });
    await expect(
      setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [bSite] }),
    ).rejects.toBeInstanceOf(CrossCompanyClockingLocationError);
    expect(deptB).toBeTruthy();
  });

  it('appends employee.clocking-locations.assigned and employee.geofencing.updated', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'EvS', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });
    const types = await eventTypesFor(b.tenantId, e.employmentId);
    expect(types).toEqual(
      expect.arrayContaining(['employee.clocking-locations.assigned', 'employee.geofencing.updated']),
    );
  });

  /**
   * 1fff489c REPLACED the old assertion here, which was "enable without a radius throws". That was right
   * while the employment radius was the ONLY radius. It is now an OPTIONAL OVERRIDE of each site's own
   * figure, so enabling with a blank one is the RECOMMENDED state, and migration 0419 drops the
   * employment_geofence_radius_required CHECK that used to forbid it at the storage layer too.
   */
  it('setGeofencing: the radius is an OPTIONAL override — blank while enabled is allowed and stored null', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true });
    const [blank] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, e.employmentId));
    expect(blank.geofencingEnabled).toBe(true);
    expect(blank.geofenceRadiusM).toBeNull();
    // An empty-string form value is the same "not supplied", not a zero.
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: '' });
    const [blank2] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, e.employmentId));
    expect(blank2.geofenceRadiusM).toBeNull();
  });

  it('setGeofencing validates a SUPPLIED override: positive, and under the ceiling', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    await expect(setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 0 })).rejects.toThrow(/radius/);
    await expect(setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: -5 })).rejects.toThrow(/radius/);
    await expect(setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 200_000 })).rejects.toThrow(/exceed/);
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });
    const [row] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, e.employmentId));
    expect(row.geofencingEnabled).toBe(true);
    expect(row.geofenceRadiusM).toBe(300);
    // disabling clears the radius (documented: harmless since never read while off, but we clear it anyway)
    await setGeofencing(a, { employmentId: e.employmentId, enabled: false });
    const [row2] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, e.employmentId));
    expect(row2.geofencingEnabled).toBe(false);
    expect(row2.geofenceRadiusM).toBeNull();
  });
});

describe('checkIn/checkOut geofence enforcement (ADR-0070)', () => {
  it('inside radius: row stamped per-punch (coords, matched id, distance, radius, pass, web)', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'InRadius', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });

    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: HQ });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInLat).toBeCloseTo(HQ.lat, 6);
    expect(row.checkInLng).toBeCloseTo(HQ.lng, 6);
    expect(row.checkInClockingLocationId).toBe(site);
    expect(row.checkInDistanceM).toBe(0);
    expect(row.checkInGeofenceStatus).toBe('pass');
    expect(row.checkInRadiusM).toBe(300);
    expect(row.checkInMethod).toBe('web');

    await checkOut(a, { employmentId: e.employmentId, date: '2026-07-06', time: '18:00', geo: HQ });
    const row2 = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row2.checkOutClockingLocationId).toBe(site);
    expect(row2.checkOutGeofenceStatus).toBe('pass');
    expect(row2.checkOutMethod).toBe('web');
  });

  it('outside all sites: OutsideGeofenceError, NO attendance row, blocked event PERSISTED', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'Far', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });

    // ~1.1 degrees away ≈ 100+ km — well outside any sane radius.
    const farAway = { lat: HQ.lat + 1, lng: HQ.lng + 1 };
    await expect(
      checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: farAway }),
    ).rejects.toBeInstanceOf(OutsideGeofenceError);

    // NO attendance row was written (the write transaction rolled back).
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row).toBeUndefined();

    // The blocked event IS persisted — a fresh read after the rollback (the regression test for the fatal
    // "event never commits inside a rolled-back transaction" flaw).
    const types = await eventTypesFor(b.tenantId, e.employmentId);
    expect(types).toContain('attendance.geofence.blocked');

    // The employee's own session can read their own blocked event (subjectEmploymentId scoping, ADR-0015).
    const [person] = await owner.db.select().from(schema.person).where(eq(schema.person.id, e.personId));
    const empCtx = await employeeCtxFor(person.id);
    const rows = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.aggregateId, e.employmentId), eq(schema.domainEvent.eventType, 'attendance.geofence.blocked')));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].subjectEmploymentId).toBe(e.employmentId);
    expect(empCtx.personId).toBe(person.id); // sanity: the session really maps to this employee
  });

  it('within ANY of two assigned sites passes', async () => {
    const a = adminCtx(b);
    const { id: site1 } = await mkSite(a, { companyId: b.companyId, name: 'Near1', lat: HQ.lat, lng: HQ.lng });
    const { id: site2 } = await mkSite(a, { companyId: b.companyId, name: 'Near2', lat: HQ.lat + 1, lng: HQ.lng + 1 });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site1, site2] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });

    // At site2's coordinates — far from site1, but a hit on site2.
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: { lat: HQ.lat + 1, lng: HQ.lng + 1 } });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInClockingLocationId).toBe(site2);
    expect(row.checkInGeofenceStatus).toBe('pass');
  });

  it('enabled + zero assigned sites blocks fail-closed with event', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });
    await expect(
      checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: HQ }),
    ).rejects.toBeInstanceOf(OutsideGeofenceError);
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row).toBeUndefined();
    const types = await eventTypesFor(b.tenantId, e.employmentId);
    expect(types).toContain('attendance.geofence.blocked');
  });

  it('enabled + no coords: GeolocationRequiredError, no row, no event', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'NoCoords', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });

    await expect(
      checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00' }),
    ).rejects.toBeInstanceOf(GeolocationRequiredError);
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row).toBeUndefined();
    const types = await eventTypesFor(b.tenantId, e.employmentId);
    expect(types).not.toContain('attendance.geofence.blocked');
  });

  it('disabled + coords: allowed, coords stored, status not_enforced, site/distance/radius null', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: HQ });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInLat).toBeCloseTo(HQ.lat, 6);
    expect(row.checkInGeofenceStatus).toBe('not_enforced');
    expect(row.checkInClockingLocationId).toBeNull();
    expect(row.checkInDistanceM).toBeNull();
    expect(row.checkInRadiusM).toBeNull();
    expect(row.checkInMethod).toBe('web');
  });

  it('disabled + no coords: allowed, nulls', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00' });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInLat).toBeNull();
    expect(row.checkInGeofenceStatus).toBe('not_enforced');
  });

  it('mid-day toggle: each punch keeps its own frozen status/radius', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'Toggle', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site] });
    // Geofencing OFF at check-in.
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: HQ });
    // Turn geofencing ON with a radius, then check out — inside radius, so it passes with its OWN stamp.
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 500 });
    await checkOut(a, { employmentId: e.employmentId, date: '2026-07-06', time: '18:00', geo: HQ });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInGeofenceStatus).toBe('not_enforced');
    expect(row.checkInRadiusM).toBeNull();
    expect(row.checkOutGeofenceStatus).toBe('pass');
    expect(row.checkOutRadiusM).toBe(500);
  });
});

describe('import + correction geo-nulling (ADR-0070)', () => {
  it('import overwrites a web check-in: geo fields nulled, method import — no contradictory rows', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'ImpSite', lat: HQ.lat, lng: HQ.lng });
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Imp Emp', primaryEmail: uniqEmail() })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2024-01-01', employeeCode: 'IMP1' })
      .returning({ id: schema.employment.id });
    await setEmployeeClockingLocations(a, { employmentId: emp.id, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId: emp.id, enabled: true, radiusM: 300 });
    await checkIn(a, { employmentId: emp.id, date: '2026-07-06', time: '09:00', geo: HQ });
    let row = await attendanceRow(emp.id, '2026-07-06');
    expect(row.checkInGeofenceStatus).toBe('pass');

    const csv = 'Staff ID,Timestamp\nIMP1,2026-07-06 09:05:00\nIMP1,2026-07-06 18:10:00';
    const result = await importAttendancePunches(a, { csvText: csv, dryRun: false });
    expect(result.imported).toBe(1);
    row = await attendanceRow(emp.id, '2026-07-06');
    expect(row.checkInAt).toBe('09:05:00');
    expect(row.checkInMethod).toBe('import');
    expect(row.checkInGeofenceStatus).toBeNull();
    expect(row.checkInClockingLocationId).toBeNull();
    expect(row.checkOutMethod).toBe('import');
  });

  it('import check-in then web check-out: in=import, out=web with out-geo stamped', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'MixSite', lat: HQ.lat, lng: HQ.lng });
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Mix Emp', primaryEmail: uniqEmail() })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2024-01-01', employeeCode: 'MIX1' })
      .returning({ id: schema.employment.id });
    await setEmployeeClockingLocations(a, { employmentId: emp.id, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId: emp.id, enabled: true, radiusM: 300 });

    const csv = 'Staff ID,Timestamp\nMIX1,2026-07-06 09:00:00';
    await importAttendancePunches(a, { csvText: csv, dryRun: false });
    let row = await attendanceRow(emp.id, '2026-07-06');
    expect(row.checkInMethod).toBe('import');
    expect(row.checkOutAt).toBeNull();

    await checkOut(a, { employmentId: emp.id, date: '2026-07-06', time: '18:00', geo: HQ });
    row = await attendanceRow(emp.id, '2026-07-06');
    expect(row.checkInMethod).toBe('import');
    expect(row.checkOutMethod).toBe('web');
    expect(row.checkOutGeofenceStatus).toBe('pass');
    expect(row.checkOutClockingLocationId).toBe(site);
  });

  it('blocked check-out, then approved correction: row completed, geo fields nulled, method NULL', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'CorrSite', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });

    // Check in fine (at the office)...
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: HQ });
    // ...then try to check out from far away (e.g. an offsite meeting) — blocked.
    const farAway = { lat: HQ.lat + 1, lng: HQ.lng + 1 };
    await expect(
      checkOut(a, { employmentId: e.employmentId, date: '2026-07-06', time: '18:00', geo: farAway }),
    ).rejects.toBeInstanceOf(OutsideGeofenceError);
    let row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkOutAt).toBeNull(); // still blocked, no check-out written

    // File + approve a correction (the documented, approval-gated bypass).
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId: e.employmentId,
      date: '2026-07-06',
      checkIn: '09:00:00',
      checkOut: '18:00:00',
      reason: 'Correction',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkOutAt).toBe('18:00:00');
    expect(row.checkInMethod).toBeNull();
    expect(row.checkOutMethod).toBeNull();
    expect(row.checkInGeofenceStatus).toBeNull();
    expect(row.checkOutGeofenceStatus).toBeNull();
    expect(row.checkInClockingLocationId).toBeNull();
    expect(row.checkOutClockingLocationId).toBeNull();
  });
});

describe('RLS (ADR-0070 tenant-catalog pattern)', () => {
  it('a tenant employee SELECTs the clocking_location catalog but cannot write', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'RlsSite', lat: HQ.lat, lng: HQ.lng });
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Plain Emp', primaryEmail: uniqEmail() })
      .returning({ id: schema.person.id });
    const empCtx = await employeeCtxFor(p.id);

    // Read: the tenant-wide catalog policy lets a plain employee through.
    const seen = await listClockingLocations(empCtx, [b.companyId]);
    expect(seen.map((s) => s.id)).toContain(site);

    // Write: RLS WITH CHECK requires is_admin_for(company_id) — a plain employee cannot create.
    await expect(
      mkSite(empCtx, { companyId: b.companyId, name: 'Illegal', lat: HQ.lat, lng: HQ.lng }),
    ).rejects.toThrow();
  });

  it('an admin of another company in the tenant reads but cannot write', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Co B RLS' });
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'AOnly', lat: HQ.lat, lng: HQ.lng });
    const adminB = await adminFor(coB); // scoped to company B only

    // Read: tenant-wide catalog policy — B's admin still sees A's site.
    const seen = await listClockingLocations(adminB, [b.companyId]);
    expect(seen.map((s) => s.id)).toContain(site);

    // Write: cannot update a site outside their company scope.
    // 1fff489c — B's admin is now stopped one step EARLIER than before: `location` is admin-only-read
    // (migration 0111), so A's location is invisible to them and the required link cannot be resolved.
    // The refusal is real either way, but the assertion below no longer proves the clocking_location
    // policy itself — hence the archive attempt that follows, which reaches the UPDATE unguarded.
    await expect(
      updateClockingLocation(adminB, {
        clockingLocationId: site,
        name: 'Hijacked',
        lat: HQ.lat,
        lng: HQ.lng,
        radiusM: 300,
        locationId: await defaultLocationFor(a, b.companyId),
      }),
    ).rejects.toThrow();
    const [untouched] = await owner.db
      .select()
      .from(schema.clockingLocation)
      .where(eq(schema.clockingLocation.id, site));
    expect(untouched.name).toBe('AOnly');

    // The RLS policy itself: archive takes no location link, so this reaches the UPDATE and is refused by
    // WITH CHECK app.is_admin_for(company_id).
    await expect(archiveClockingLocation(adminB, { clockingLocationId: site })).rejects.toThrow();
  });

  it('another tenant sees nothing', async () => {
    const a = adminCtx(b);
    await mkSite(a, { companyId: b.companyId, name: 'TenantASite', lat: HQ.lat, lng: HQ.lng });

    const [t2] = await owner.db.insert(schema.tenant).values({ workosOrgId: `org_${randomUUID()}`, name: 'Other Tenant' }).returning({ id: schema.tenant.id });
    const [c2] = await owner.db.insert(schema.company).values({ tenantId: t2.id, legalName: 'Other Co' }).returning({ id: schema.company.id });
    const [u2] = await owner.db.insert(schema.appUser).values({ tenantId: t2.id, workosUserId: `user_${randomUUID()}` }).returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: t2.id, appUserId: u2.id, companyId: null, role: 'hr_admin' });
    const otherCtx: SessionContext = { tenantId: t2.id, userId: u2.id, grants: [{ role: 'hr_admin', companyId: null }] };

    const seen = await listClockingLocations(otherCtx, [c2.id]);
    expect(seen.length).toBe(0);
  });

  it('employee cannot write employee_clocking_location join rows', async () => {
    const a = adminCtx(b);
    const { id: site } = await mkSite(a, { companyId: b.companyId, name: 'JoinRls', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, e.personId));
    const empCtx = await employeeCtxFor(p.id);
    // A plain employee (not self, not admin) cannot assign sites to this employment.
    await expect(
      setEmployeeClockingLocations(empCtx, { employmentId: e.employmentId, clockingLocationIds: [site] }),
    ).rejects.toThrow();
  });
});

/**
 * ── 1fff489c — the radius moves onto the SITE, and every point is linked to a location ────────────────
 *
 * The centrepiece is 'the NEARER site fails its small radius while the FARTHER site passes its large one'.
 * That case is the entire reason resolveGeofence was rewritten rather than repointed at a new column: the
 * old "nearest site vs the one employee radius" logic refuses it, and refusing it is the defect.
 */
describe('1fff489c — per-site radius', () => {
  /** ~111.19 km per degree of latitude at the equator on the R=6371 km sphere haversineMetres uses. */
  const METRES_PER_DEG_LAT = 111_194.9;
  const north = (metres: number) => ({ lat: HQ.lat + metres / METRES_PER_DEG_LAT, lng: HQ.lng });

  it('a single site is judged against ITS OWN radius when the employee has no override', async () => {
    const a = adminCtx(b);
    const { id: tight } = await mkSite(a, { companyId: b.companyId, name: 'Tight', ...north(0), radiusM: 100 });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [tight] });
    // Enabled with NO override — the site's own 100 m is the only radius in play.
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true });

    // 300 m away: outside the site's 100 m.
    await expect(
      checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: north(300) }),
    ).rejects.toBeInstanceOf(OutsideGeofenceError);
    expect(await attendanceRow(e.employmentId, '2026-07-06')).toBeUndefined();

    // 50 m away: inside it. The row records the SITE's radius, not an employee one.
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: north(50) });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInGeofenceStatus).toBe('pass');
    expect(row.checkInClockingLocationId).toBe(tight);
    expect(row.checkInRadiusM).toBe(100);
  });

  it('THE REGRESSION: the NEARER site fails its small radius, the FARTHER site passes its large one', async () => {
    const a = adminCtx(b);
    // 300 m away with a 100 m circle — the nearest site, and it does NOT authorise this punch.
    const { id: near } = await mkSite(a, { companyId: b.companyId, name: 'Near Gate', ...north(300), radiusM: 100 });
    // 400 m away with a 500 m circle — further off, and it DOES.
    const { id: far } = await mkSite(a, { companyId: b.companyId, name: 'Far Yard', ...north(400), radiusM: 500 });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [near, far] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true });

    // The old logic picked `near` (nearest) and compared it against the single employment radius, so this
    // punch was refused. The rule is now "ANY assigned site whose own radius contains me".
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: north(0) });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInGeofenceStatus).toBe('pass');
    expect(row.checkInClockingLocationId).toBe(far);
    expect(row.checkInRadiusM).toBe(500);
    expect(row.checkInDistanceM).toBeGreaterThan(380);
    expect(row.checkInDistanceM).toBeLessThan(420);
  });

  it('the closest PASSING site wins when two are in range — not the first one found', async () => {
    const a = adminCtx(b);
    const { id: further } = await mkSite(a, { companyId: b.companyId, name: 'A Further', ...north(400), radiusM: 900 });
    const { id: closer } = await mkSite(a, { companyId: b.companyId, name: 'B Closer', ...north(100), radiusM: 900 });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [further, closer] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true });

    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: north(0) });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInClockingLocationId).toBe(closer);
  });

  it('the employment radius is an OVERRIDE: it replaces every site radius, tighter or wider', async () => {
    const a = adminCtx(b);
    const { id: wide } = await mkSite(a, { companyId: b.companyId, name: 'Wide', ...north(0), radiusM: 1000 });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [wide] });

    // Override 100 m TIGHTENS a 1000 m site: 300 m away is now refused.
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 100 });
    await expect(
      checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: north(300) }),
    ).rejects.toBeInstanceOf(OutsideGeofenceError);

    // Override 600 m WIDENS a 100 m site: the same 300 m now passes, and the row records the override.
    await updateClockingLocation(a, {
      clockingLocationId: wide,
      name: 'Wide',
      lat: HQ.lat,
      lng: HQ.lng,
      radiusM: 100,
      locationId: await defaultLocationFor(a, b.companyId),
    });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 600 });
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: north(300) });
    const row = await attendanceRow(e.employmentId, '2026-07-06');
    expect(row.checkInGeofenceStatus).toBe('pass');
    expect(row.checkInRadiusM).toBe(600);
  });

  it('a site with NO radius and no override can never be matched (fail closed)', async () => {
    const a = adminCtx(b);
    // Only reachable for a row written before migration 0419 — the service refuses to create one. Written
    // straight to the table so the fail-closed branch is actually exercised.
    const locationId = await defaultLocationFor(a, b.companyId);
    const [legacy] = await owner.db
      .insert(schema.clockingLocation)
      .values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Legacy', lat: HQ.lat, lng: HQ.lng, locationId })
      .returning({ id: schema.clockingLocation.id });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [legacy.id] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true });

    // Standing exactly ON the point, and still refused: no radius means no distance to be inside of.
    await expect(
      checkIn(a, { employmentId: e.employmentId, date: '2026-07-06', time: '09:00', geo: HQ }),
    ).rejects.toBeInstanceOf(OutsideGeofenceError);
    expect(await attendanceRow(e.employmentId, '2026-07-06')).toBeUndefined();
  });

  it('zero assigned sites: the refusal carries a null distance AND a null radius, together', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true });
    const err: unknown = await checkIn(a, {
      employmentId: e.employmentId,
      date: '2026-07-06',
      time: '09:00',
      geo: HQ,
    }).then(
      () => null,
      (x) => x,
    );
    expect(err).toBeInstanceOf(OutsideGeofenceError);
    const info = (err as OutsideGeofenceError).info;
    // Both null TOGETHER is what localizeClockError's guard depends on — a null {radius} handed to the ICU
    // message would throw at render behind a 200.
    expect(info.distanceM).toBeNull();
    expect(info.radiusM).toBeNull();
    expect(info.nearestLocationId).toBeNull();
  });
});

describe('1fff489c — the radius is required, and the location link is required', () => {
  it('refuses a create with no radius, a zero radius, or a negative radius', async () => {
    const a = adminCtx(b);
    const locationId = await defaultLocationFor(a, b.companyId);
    const base = { companyId: b.companyId, lat: HQ.lat, lng: HQ.lng, locationId };
    await expect(createClockingLocation(a, { ...base, name: 'R1', radiusM: '' })).rejects.toThrow(/required/);
    await expect(createClockingLocation(a, { ...base, name: 'R2', radiusM: 0 })).rejects.toThrow(/positive/);
    await expect(createClockingLocation(a, { ...base, name: 'R3', radiusM: -1 })).rejects.toThrow(/positive/);
    await expect(createClockingLocation(a, { ...base, name: 'R4', radiusM: 500_000 })).rejects.toThrow(/exceed/);
  });

  it('refuses a create with no location link', async () => {
    const a = adminCtx(b);
    await expect(
      createClockingLocation(a, { companyId: b.companyId, name: 'NoLink', lat: HQ.lat, lng: HQ.lng, radiusM: 150, locationId: '' }),
    ).rejects.toBeInstanceOf(ClockingLocationLinkError);
  });

  it("refuses a location belonging to ANOTHER company", async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Co B Link' });
    const { id: foreignLocation } = await createLocation(a, { companyId: coB, code: 'FOREIGN', name: 'Foreign' });
    await expect(
      createClockingLocation(a, {
        companyId: b.companyId,
        name: 'CrossCo',
        lat: HQ.lat,
        lng: HQ.lng,
        radiusM: 150,
        locationId: foreignLocation,
      }),
    ).rejects.toBeInstanceOf(ClockingLocationLinkError);
  });

  it('refuses an ARCHIVED location', async () => {
    const a = adminCtx(b);
    const { id: gone } = await createLocation(a, { companyId: b.companyId, code: 'GONE', name: 'Closed Site' });
    await archiveLocation(a, { locationId: gone });
    await expect(
      createClockingLocation(a, { companyId: b.companyId, name: 'Archived', lat: HQ.lat, lng: HQ.lng, radiusM: 150, locationId: gone }),
    ).rejects.toBeInstanceOf(ClockingLocationLinkError);
  });

  it('an update cannot re-home a point onto another company’s location', async () => {
    const a = adminCtx(b);
    const { id: point } = await mkSite(a, { companyId: b.companyId, name: 'Homed', lat: HQ.lat, lng: HQ.lng });
    const { id: coB } = await createCompany(a, { legalName: 'Co B Rehome' });
    const { id: foreignLocation } = await createLocation(a, { companyId: coB, code: 'REHOME', name: 'Elsewhere' });
    await expect(
      updateClockingLocation(a, {
        clockingLocationId: point,
        name: 'Homed',
        lat: HQ.lat,
        lng: HQ.lng,
        radiusM: 150,
        locationId: foreignLocation,
      }),
    ).rejects.toBeInstanceOf(ClockingLocationLinkError);
  });

  it('the 10..5000 m band WARNS and does not block — the row is saved either way', async () => {
    const a = adminCtx(b);
    const locationId = await defaultLocationFor(a, b.companyId);
    const base = { companyId: b.companyId, lat: HQ.lat, lng: HQ.lng, locationId };

    const tight = await createClockingLocation(a, { ...base, name: 'Tiny', radiusM: RADIUS_ADVISORY_MIN_M - 1 });
    expect(tight.warning).toEqual({ code: 'tight', radiusM: RADIUS_ADVISORY_MIN_M - 1 });
    const wide = await createClockingLocation(a, { ...base, name: 'Huge', radiusM: RADIUS_ADVISORY_MAX_M + 1, lng: HQ.lng + 0.01 });
    expect(wide.warning).toEqual({ code: 'wide', radiusM: RADIUS_ADVISORY_MAX_M + 1 });
    const normal = await createClockingLocation(a, { ...base, name: 'Normal', radiusM: 150, lng: HQ.lng + 0.02 });
    expect(normal.warning).toBeNull();

    // NOT BLOCKED: all three rows are really there, with the radii as typed.
    const saved = await listClockingLocations(a, [b.companyId]);
    const byName = new Map(saved.map((r) => [r.name, r]));
    expect(byName.get('Tiny')?.radiusM).toBe(RADIUS_ADVISORY_MIN_M - 1);
    expect(byName.get('Huge')?.radiusM).toBe(RADIUS_ADVISORY_MAX_M + 1);
    expect(byName.get('Normal')?.radiusM).toBe(150);

    // The band edges themselves are inside it — the advisory is strictly outside 10..5000.
    expect(radiusWarning(RADIUS_ADVISORY_MIN_M)).toBeNull();
    expect(radiusWarning(RADIUS_ADVISORY_MAX_M)).toBeNull();
  });

  it('listClockingLocations carries the linked location’s code and name for the grouped render', async () => {
    const a = adminCtx(b);
    const { id: locationId } = await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });
    await createClockingLocation(a, {
      companyId: b.companyId,
      name: 'HQ — North Gate',
      lat: HQ.lat,
      lng: HQ.lng,
      radiusM: 150,
      locationId,
    });
    const [row] = await listClockingLocations(a, [b.companyId]);
    expect(row.locationId).toBe(locationId);
    expect(row.locationCode).toBe('HQ');
    expect(row.locationName).toBe('Headquarters');
    expect(row.radiusM).toBe(150);
  });
});
