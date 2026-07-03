/**
 * Clocking Location Management & Geofencing (ADR-0069). Modelled on core/location.ts, minus the code
 * field (a clocking site has no code namespace to reuse). RLS is the 0065 pay_component tenant-catalog
 * pattern — see the ADR for why this is a SEPARATE table/registry from `location`.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  attendance,
  clockingLocation,
  company,
  employeeClockingLocation,
  employment,
} from '../db/schema';

const MAX_RADIUS_M = 100_000;

function cleanName(v: string | undefined): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('Location name is required');
  return s;
}
function cleanCoord(v: number | undefined, label: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return n;
}
function cleanOptional(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s || null;
}

export type CreateClockingLocationInput = {
  companyId: string;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
  remarks?: string | null;
};

export async function createClockingLocation(ctx: SessionContext, p: CreateClockingLocationInput) {
  const name = cleanName(p.name);
  const lat = cleanCoord(p.lat, 'Latitude', -90, 90);
  const lng = cleanCoord(p.lng, 'Longitude', -180, 180);
  const address = cleanOptional(p.address);
  const remarks = cleanOptional(p.remarks);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(clockingLocation)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, name, lat, lng, address, remarks })
      .returning({ id: clockingLocation.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: row.id,
      eventType: 'clocking-location.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, name, lat, lng, address, remarks },
    });
    return { id: row.id };
  });
}

export type UpdateClockingLocationInput = {
  clockingLocationId: string;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
  remarks?: string | null;
};

export async function updateClockingLocation(ctx: SessionContext, p: UpdateClockingLocationInput) {
  const name = cleanName(p.name);
  const lat = cleanCoord(p.lat, 'Latitude', -90, 90);
  const lng = cleanCoord(p.lng, 'Longitude', -180, 180);
  const address = cleanOptional(p.address);
  const remarks = cleanOptional(p.remarks);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        name: clockingLocation.name,
        lat: clockingLocation.lat,
        lng: clockingLocation.lng,
        address: clockingLocation.address,
        remarks: clockingLocation.remarks,
      })
      .from(clockingLocation)
      .where(eq(clockingLocation.id, p.clockingLocationId))
      .limit(1);
    if (!before) throw new Error('Clocking location not found');
    await tx
      .update(clockingLocation)
      .set({ name, lat, lng, address, remarks })
      .where(eq(clockingLocation.id, p.clockingLocationId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: p.clockingLocationId,
      eventType: 'clocking-location.updated',
      actor: actorOf(ctx),
      payload: { before, after: { name, lat, lng, address, remarks } },
    });
    return { id: p.clockingLocationId };
  });
}

export async function archiveClockingLocation(ctx: SessionContext, p: { clockingLocationId: string }) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(clockingLocation)
      .set({ archivedAt: new Date() })
      .where(eq(clockingLocation.id, p.clockingLocationId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: p.clockingLocationId,
      eventType: 'clocking-location.archived',
      actor: actorOf(ctx),
      payload: { clockingLocationId: p.clockingLocationId },
    });
    return { id: p.clockingLocationId };
  });
}

export async function restoreClockingLocation(ctx: SessionContext, p: { clockingLocationId: string }) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(clockingLocation)
      .set({ archivedAt: null })
      .where(eq(clockingLocation.id, p.clockingLocationId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: p.clockingLocationId,
      eventType: 'clocking-location.restored',
      actor: actorOf(ctx),
      payload: { clockingLocationId: p.clockingLocationId },
    });
    return { id: p.clockingLocationId };
  });
}

/** Thrown when a hard-delete is refused because the site is referenced (assignments or attendance rows). */
export class ClockingLocationInUseError extends Error {
  constructor(public readonly refs: number) {
    super('clocking-location-in-use');
    this.name = 'ClockingLocationInUseError';
  }
}

/**
 * Hard-delete a clocking site — the request asks for both archive AND delete. GUARDED: refuse if
 * referenced by any employee assignment OR any attendance punch (check-in or check-out matched-site
 * column); callers should archive an in-use site instead. RLS confines the write to an admin of the
 * site's own company.
 */
export function deleteClockingLocation(ctx: SessionContext, p: { clockingLocationId: string }) {
  return withTenant(ctx, async (tx) => {
    const [assignRefs] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(employeeClockingLocation)
      .where(eq(employeeClockingLocation.clockingLocationId, p.clockingLocationId));
    const [attRefs] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attendance)
      .where(
        sql`${attendance.checkInClockingLocationId} = ${p.clockingLocationId} OR ${attendance.checkOutClockingLocationId} = ${p.clockingLocationId}`,
      );
    const refs = (assignRefs?.n ?? 0) + (attRefs?.n ?? 0);
    if (refs > 0) throw new ClockingLocationInUseError(refs);
    await tx.delete(clockingLocation).where(eq(clockingLocation.id, p.clockingLocationId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: p.clockingLocationId,
      eventType: 'clocking-location.deleted',
      actor: actorOf(ctx),
      payload: { clockingLocationId: p.clockingLocationId },
    });
    return { id: p.clockingLocationId };
  });
}

export type ClockingLocationRow = {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  remarks: string | null;
  archivedAt: Date | null;
  assignedCount: number;
};

/** Clocking sites in scope, joined with company name + assigned-employee headcount. Tenant-catalog read
 *  (RLS lets every tenant member through); companyIds narrows to the admin UI's active scope. */
export function listClockingLocations(
  ctx: SessionContext,
  companyIds: string[],
  opts: { includeArchived?: boolean } = {},
): Promise<ClockingLocationRow[]> {
  return withTenant(ctx, (tx) => {
    const conds = [];
    if (companyIds.length) conds.push(inArray(clockingLocation.companyId, companyIds));
    if (!opts.includeArchived) conds.push(isNull(clockingLocation.archivedAt));
    return tx
      .select({
        id: clockingLocation.id,
        companyId: clockingLocation.companyId,
        companyName: company.legalName,
        name: clockingLocation.name,
        lat: clockingLocation.lat,
        lng: clockingLocation.lng,
        address: clockingLocation.address,
        remarks: clockingLocation.remarks,
        archivedAt: clockingLocation.archivedAt,
        assignedCount: sql<number>`(
          select count(*)::int from employee_clocking_location ecl
          where ecl.clocking_location_id = ${clockingLocation.id}
        )`,
      })
      .from(clockingLocation)
      .innerJoin(company, eq(company.id, clockingLocation.companyId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(company.legalName), asc(clockingLocation.name));
  });
}

/** A clocking site's company id (for the cross-company assignment guard). Null if absent. */
async function clockingLocationCompanyId(tx: Tx, clockingLocationId: string): Promise<string | null> {
  const [row] = await tx
    .select({ companyId: clockingLocation.companyId })
    .from(clockingLocation)
    .where(eq(clockingLocation.id, clockingLocationId))
    .limit(1);
  return row?.companyId ?? null;
}

export type AssignedClockingLocation = { id: string; name: string; lat: number; lng: number };

/** The clocking sites currently assigned to one employment. */
export function listEmployeeClockingLocations(
  ctx: SessionContext,
  employmentId: string,
): Promise<AssignedClockingLocation[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: clockingLocation.id,
        name: clockingLocation.name,
        lat: clockingLocation.lat,
        lng: clockingLocation.lng,
      })
      .from(employeeClockingLocation)
      .innerJoin(clockingLocation, eq(clockingLocation.id, employeeClockingLocation.clockingLocationId))
      .where(eq(employeeClockingLocation.employmentId, employmentId))
      .orderBy(asc(clockingLocation.name)),
  );
}

/** Thrown when an assignment set references a clocking site outside the employment's own company (a
 *  group admin editing a subordinate cross-company would otherwise silently mix sites). */
export class CrossCompanyClockingLocationError extends Error {
  constructor() {
    super('One or more selected clocking locations belong to a different company.');
    this.name = 'CrossCompanyClockingLocationError';
  }
}

/**
 * Set-based replace of an employment's assigned clocking sites (delete-then-insert inside one
 * transaction — a simple "currently assigned" list, no effective-dating, per the request). GUARD: every
 * clockingLocationId must belong to the employment's own tenant+company, else CrossCompanyClockingLocationError.
 */
export function setEmployeeClockingLocations(
  ctx: SessionContext,
  p: { employmentId: string; clockingLocationIds: string[] },
) {
  const ids = [...new Set(p.clockingLocationIds)];
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ companyId: employment.companyId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new Error('Employment not found');

    if (ids.length) {
      const companyIds = await Promise.all(ids.map((id) => clockingLocationCompanyId(tx, id)));
      if (companyIds.some((c) => c !== emp.companyId)) throw new CrossCompanyClockingLocationError();
    }

    const before = await tx
      .select({ id: employeeClockingLocation.clockingLocationId })
      .from(employeeClockingLocation)
      .where(eq(employeeClockingLocation.employmentId, p.employmentId));
    const beforeIds = before.map((b) => b.id);

    await tx.delete(employeeClockingLocation).where(eq(employeeClockingLocation.employmentId, p.employmentId));
    if (ids.length) {
      await tx
        .insert(employeeClockingLocation)
        .values(ids.map((clockingLocationId) => ({ tenantId: ctx.tenantId, employmentId: p.employmentId, clockingLocationId })));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employee.clocking-locations.assigned',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: beforeIds, after: ids },
    });
    return { employmentId: p.employmentId, clockingLocationIds: ids };
  });
}

/**
 * Enable/disable geofencing for one employment + set its radius (metres). Radius is required and must be
 * a positive integer ≤ MAX_RADIUS_M when enabling; ignored (stored null) when disabling.
 */
export function setGeofencing(
  ctx: SessionContext,
  p: { employmentId: string; enabled: boolean; radiusM?: number | null },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ geofencingEnabled: employment.geofencingEnabled, geofenceRadiusM: employment.geofenceRadiusM })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');

    let radiusM: number | null = null;
    if (p.enabled) {
      const n = Math.trunc(Number(p.radiusM));
      if (!Number.isFinite(n) || n <= 0) throw new Error('Geofencing radius must be a positive number of metres.');
      if (n > MAX_RADIUS_M) throw new Error(`Geofencing radius cannot exceed ${MAX_RADIUS_M} metres.`);
      radiusM = n;
    }

    await tx
      .update(employment)
      .set({ geofencingEnabled: p.enabled, geofenceRadiusM: radiusM })
      .where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employee.geofencing.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { enabled: p.enabled, radiusM, before },
    });
    return { employmentId: p.employmentId, enabled: p.enabled, radiusM };
  });
}
