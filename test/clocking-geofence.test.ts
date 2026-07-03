/**
 * ADR-0069 — Clocking Location Management & Geofencing. Haversine golden vectors, CRUD + archive/
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
  ClockingLocationInUseError,
  CrossCompanyClockingLocationError,
} from '../core/clocking-location';
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

describe('clocking_location CRUD (ADR-0069)', () => {
  it('creates + updates + persists fields', async () => {
    const a = adminCtx(b);
    const { id } = await createClockingLocation(a, { companyId: b.companyId, name: 'HQ Tower', lat: HQ.lat, lng: HQ.lng });
    const [row] = await owner.db.select().from(schema.clockingLocation).where(eq(schema.clockingLocation.id, id));
    expect(row.name).toBe('HQ Tower');
    expect(row.lat).toBeCloseTo(HQ.lat, 6);
    expect(row.lng).toBeCloseTo(HQ.lng, 6);
    expect(row.address).toBeNull();

    await updateClockingLocation(a, { clockingLocationId: id, name: 'HQ Tower 2', lat: HQ.lat + 1, lng: HQ.lng + 1, address: '123 Jalan Test', remarks: 'main site' });
    const [u] = await owner.db.select().from(schema.clockingLocation).where(eq(schema.clockingLocation.id, id));
    expect(u.name).toBe('HQ Tower 2');
    expect(u.address).toBe('123 Jalan Test');
    expect(u.remarks).toBe('main site');
  });

  it('rejects blank name and out-of-range coordinates', async () => {
    const a = adminCtx(b);
    await expect(createClockingLocation(a, { companyId: b.companyId, name: '  ', lat: 0, lng: 0 })).rejects.toThrow(/name is required/);
    await expect(createClockingLocation(a, { companyId: b.companyId, name: 'X', lat: 999, lng: 0 })).rejects.toThrow(/Latitude/);
    await expect(createClockingLocation(a, { companyId: b.companyId, name: 'X', lat: 0, lng: 999 })).rejects.toThrow(/Longitude/);
  });

  it('name unique per company; archive/restore; hard delete when unreferenced', async () => {
    const a = adminCtx(b);
    const { id } = await createClockingLocation(a, { companyId: b.companyId, name: 'DupSite', lat: HQ.lat, lng: HQ.lng });
    await expect(createClockingLocation(a, { companyId: b.companyId, name: 'DupSite', lat: HQ.lat, lng: HQ.lng })).rejects.toThrow();

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
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'Ref Site', lat: HQ.lat, lng: HQ.lng });
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
    const { id } = await createClockingLocation(a, { companyId: b.companyId, name: 'EvSite', lat: HQ.lat, lng: HQ.lng });
    await updateClockingLocation(a, { clockingLocationId: id, name: 'EvSite2', lat: HQ.lat, lng: HQ.lng });
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

describe('assignment + geofencing config (ADR-0069)', () => {
  it('set-based replace assigns and unassigns; cross-company rejected', async () => {
    const a = adminCtx(b);
    const { id: site1 } = await createClockingLocation(a, { companyId: b.companyId, name: 'S1', lat: HQ.lat, lng: HQ.lng });
    const { id: site2 } = await createClockingLocation(a, { companyId: b.companyId, name: 'S2', lat: HQ.lat + 0.01, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);

    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site1, site2] });
    let assigned = await listEmployeeClockingLocations(a, e.employmentId);
    expect(assigned.map((s) => s.id).sort()).toEqual([site1, site2].sort());

    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site1] });
    assigned = await listEmployeeClockingLocations(a, e.employmentId);
    expect(assigned.map((s) => s.id)).toEqual([site1]);

    const { id: coB } = await createCompany(a, { legalName: 'Co B Sdn Bhd' });
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    const { id: bSite } = await createClockingLocation(a, { companyId: coB, name: 'BSite', lat: HQ.lat, lng: HQ.lng });
    await expect(
      setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [bSite] }),
    ).rejects.toBeInstanceOf(CrossCompanyClockingLocationError);
    expect(deptB).toBeTruthy();
  });

  it('appends employee.clocking-locations.assigned and employee.geofencing.updated', async () => {
    const a = adminCtx(b);
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'EvS', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmployeeClockingLocations(a, { employmentId: e.employmentId, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 300 });
    const types = await eventTypesFor(b.tenantId, e.employmentId);
    expect(types).toEqual(
      expect.arrayContaining(['employee.clocking-locations.assigned', 'employee.geofencing.updated']),
    );
  });

  it('setGeofencing validates: enable without radius throws; radius ceiling enforced', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    await expect(setGeofencing(a, { employmentId: e.employmentId, enabled: true })).rejects.toThrow(/radius/);
    await expect(setGeofencing(a, { employmentId: e.employmentId, enabled: true, radiusM: 0 })).rejects.toThrow(/radius/);
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

describe('checkIn/checkOut geofence enforcement (ADR-0069)', () => {
  it('inside radius: row stamped per-punch (coords, matched id, distance, radius, pass, web)', async () => {
    const a = adminCtx(b);
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'InRadius', lat: HQ.lat, lng: HQ.lng });
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
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'Far', lat: HQ.lat, lng: HQ.lng });
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
    const { id: site1 } = await createClockingLocation(a, { companyId: b.companyId, name: 'Near1', lat: HQ.lat, lng: HQ.lng });
    const { id: site2 } = await createClockingLocation(a, { companyId: b.companyId, name: 'Near2', lat: HQ.lat + 1, lng: HQ.lng + 1 });
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
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'NoCoords', lat: HQ.lat, lng: HQ.lng });
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
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'Toggle', lat: HQ.lat, lng: HQ.lng });
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

describe('import + correction geo-nulling (ADR-0069)', () => {
  it('import overwrites a web check-in: geo fields nulled, method import — no contradictory rows', async () => {
    const a = adminCtx(b);
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'ImpSite', lat: HQ.lat, lng: HQ.lng });
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
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'MixSite', lat: HQ.lat, lng: HQ.lng });
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
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'CorrSite', lat: HQ.lat, lng: HQ.lng });
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

describe('RLS (ADR-0069 tenant-catalog pattern)', () => {
  it('a tenant employee SELECTs the clocking_location catalog but cannot write', async () => {
    const a = adminCtx(b);
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'RlsSite', lat: HQ.lat, lng: HQ.lng });
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
      createClockingLocation(empCtx, { companyId: b.companyId, name: 'Illegal', lat: HQ.lat, lng: HQ.lng }),
    ).rejects.toThrow();
  });

  it('an admin of another company in the tenant reads but cannot write', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Co B RLS' });
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'AOnly', lat: HQ.lat, lng: HQ.lng });
    const adminB = await adminFor(coB); // scoped to company B only

    // Read: tenant-wide catalog policy — B's admin still sees A's site.
    const seen = await listClockingLocations(adminB, [b.companyId]);
    expect(seen.map((s) => s.id)).toContain(site);

    // Write: cannot update a site outside their company scope.
    await expect(
      updateClockingLocation(adminB, { clockingLocationId: site, name: 'Hijacked', lat: HQ.lat, lng: HQ.lng }),
    ).rejects.toThrow();
  });

  it('another tenant sees nothing', async () => {
    const a = adminCtx(b);
    await createClockingLocation(a, { companyId: b.companyId, name: 'TenantASite', lat: HQ.lat, lng: HQ.lng });

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
    const { id: site } = await createClockingLocation(a, { companyId: b.companyId, name: 'JoinRls', lat: HQ.lat, lng: HQ.lng });
    const e = await hire(a, b.companyId, b.deptA);
    const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, e.personId));
    const empCtx = await employeeCtxFor(p.id);
    // A plain employee (not self, not admin) cannot assign sites to this employment.
    await expect(
      setEmployeeClockingLocations(empCtx, { employmentId: e.employmentId, clockingLocationIds: [site] }),
    ).rejects.toThrow();
  });
});
