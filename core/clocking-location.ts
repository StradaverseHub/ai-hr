/**
 * Clocking Location Management & Geofencing (ADR-0070). Modelled on core/location.ts, minus the code
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
  location,
} from '../db/schema';

const MAX_RADIUS_M = 100_000;

/**
 * 1fff489c — the SOFT advisory band for a site radius, in metres. Outside it the service returns a
 * `warning` string the UI shows; it NEVER refuses the save. Spec section B is explicit that some sites
 * genuinely need a bigger circle (a project yard, a plantation) and a hard cap would make the field
 * unusable for exactly the customers who need it most. The only HARD limits are >0 (DB CHECK) and
 * ≤ MAX_RADIUS_M (a 100 km "geofence" is a typo, not a site).
 */
export const RADIUS_ADVISORY_MIN_M = 10;
export const RADIUS_ADVISORY_MAX_M = 5_000;

/** Thrown when a clocking point is saved without its Location link, or with one the site may not use. */
export class ClockingLocationLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockingLocationLinkError';
  }
}

/**
 * The per-site radius. REQUIRED on every create/update (the whole point of 1fff489c), a positive integer,
 * hard-capped at MAX_RADIUS_M. The 10..5000 band is NOT enforced here — see RADIUS_ADVISORY_MIN_M.
 */
function cleanRadius(v: number | string | null | undefined): number {
  const n = Math.trunc(Number(v));
  if (v == null || v === '' || !Number.isFinite(n)) {
    throw new Error('Radius (metres) is required — a clocking point without one cannot be geofenced.');
  }
  if (n <= 0) throw new Error('Radius must be a positive number of metres.');
  if (n > MAX_RADIUS_M) throw new Error(`Radius cannot exceed ${MAX_RADIUS_M} metres.`);
  return n;
}

/**
 * The advisory for a radius outside the band, or null. RETURNED to the caller, never thrown — the save
 * has already happened by the time the caller reads this.
 *
 * A CODE, not a sentence: the toast that carries it is user-facing and this product ships in six locales,
 * so the wording lives in messages/*.json (admin.locations.radiusWarningTight / …Wide) and the action
 * localises it. Core stays free of display text, the way the rest of the module's *thrown* messages
 * unfortunately are not.
 */
export type RadiusAdvisory = { code: 'tight' | 'wide'; radiusM: number };

export function radiusWarning(radiusM: number): RadiusAdvisory | null {
  if (radiusM < RADIUS_ADVISORY_MIN_M) return { code: 'tight', radiusM };
  if (radiusM > RADIUS_ADVISORY_MAX_M) return { code: 'wide', radiusM };
  return null;
}

/**
 * Resolve and validate the REQUIRED link from a clocking point to a `location` master record.
 *
 * Two guards, both of which must run inside the caller's tx so they share the RLS session:
 *   • SAME COMPANY — the same cross-company coherence setEmployeeClockingLocations enforces. A group admin
 *     editing several companies would otherwise silently file a point under another company's location.
 *   • NOT ARCHIVED — an archived location is out of every assignment dropdown by design; letting a new
 *     point be filed under one would resurrect it as a group heading nobody can select.
 */
async function resolveLocationLink(tx: Tx, locationId: string | null | undefined, companyId: string): Promise<string> {
  const id = (locationId ?? '').trim();
  if (!id) {
    throw new ClockingLocationLinkError(
      'A clocking point must be linked to a location — pick one from the Locations list above.',
    );
  }
  const [row] = await tx
    .select({ id: location.id, companyId: location.companyId, archivedAt: location.archivedAt })
    .from(location)
    .where(eq(location.id, id))
    .limit(1);
  if (!row || row.companyId !== companyId) {
    throw new ClockingLocationLinkError('That location belongs to a different company.');
  }
  if (row.archivedAt) {
    throw new ClockingLocationLinkError('That location is archived — restore it first, or pick another.');
  }
  return row.id;
}

/** The owning company of an existing clocking point (the company its location link is judged against). */
async function companyOfClockingLocation(tx: Tx, clockingLocationId: string): Promise<string> {
  const [row] = await tx
    .select({ companyId: clockingLocation.companyId })
    .from(clockingLocation)
    .where(eq(clockingLocation.id, clockingLocationId))
    .limit(1);
  if (!row) throw new Error('Clocking location not found');
  return row.companyId;
}

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
  /** 1fff489c — REQUIRED. Metres. See cleanRadius / radiusWarning for the hard vs advisory split. */
  radiusM: number | string;
  /** 1fff489c — REQUIRED. A non-archived `location` in the SAME company. */
  locationId: string;
  address?: string | null;
  remarks?: string | null;
};

/** Every write returns the site id plus an optional SOFT advisory about the radius (never a refusal). */
export type ClockingLocationWriteResult = { id: string; warning: RadiusAdvisory | null };

export async function createClockingLocation(
  ctx: SessionContext,
  p: CreateClockingLocationInput,
): Promise<ClockingLocationWriteResult> {
  const name = cleanName(p.name);
  const lat = cleanCoord(p.lat, 'Latitude', -90, 90);
  const lng = cleanCoord(p.lng, 'Longitude', -180, 180);
  const radiusM = cleanRadius(p.radiusM);
  const address = cleanOptional(p.address);
  const remarks = cleanOptional(p.remarks);
  return withTenant(ctx, async (tx) => {
    const locationId = await resolveLocationLink(tx, p.locationId, p.companyId);
    const [row] = await tx
      .insert(clockingLocation)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, name, lat, lng, radiusM, locationId, address, remarks })
      .returning({ id: clockingLocation.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: row.id,
      eventType: 'clocking-location.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, name, lat, lng, radiusM, locationId, address, remarks },
    });
    return { id: row.id, warning: radiusWarning(radiusM) };
  });
}

export type UpdateClockingLocationInput = {
  clockingLocationId: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number | string;
  locationId: string;
  address?: string | null;
  remarks?: string | null;
};

export async function updateClockingLocation(
  ctx: SessionContext,
  p: UpdateClockingLocationInput,
): Promise<ClockingLocationWriteResult> {
  const name = cleanName(p.name);
  const lat = cleanCoord(p.lat, 'Latitude', -90, 90);
  const lng = cleanCoord(p.lng, 'Longitude', -180, 180);
  const radiusM = cleanRadius(p.radiusM);
  const address = cleanOptional(p.address);
  const remarks = cleanOptional(p.remarks);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        name: clockingLocation.name,
        lat: clockingLocation.lat,
        lng: clockingLocation.lng,
        radiusM: clockingLocation.radiusM,
        locationId: clockingLocation.locationId,
        address: clockingLocation.address,
        remarks: clockingLocation.remarks,
      })
      .from(clockingLocation)
      .where(eq(clockingLocation.id, p.clockingLocationId))
      .limit(1);
    if (!before) throw new Error('Clocking location not found');
    // The link is judged against the SITE's own company, not a caller-supplied one — a forged form field
    // cannot re-home a point into another company's location.
    const locationId = await resolveLocationLink(
      tx,
      p.locationId,
      await companyOfClockingLocation(tx, p.clockingLocationId),
    );
    await tx
      .update(clockingLocation)
      .set({ name, lat, lng, radiusM, locationId, address, remarks })
      .where(eq(clockingLocation.id, p.clockingLocationId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: p.clockingLocationId,
      eventType: 'clocking-location.updated',
      actor: actorOf(ctx),
      payload: { before, after: { name, lat, lng, radiusM, locationId, address, remarks } },
    });
    return { id: p.clockingLocationId, warning: radiusWarning(radiusM) };
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
  /** 1fff489c — the site's own allowed distance. Null only for a row written before 0419 (none exist). */
  radiusM: number | null;
  locationId: string | null;
  locationCode: string | null;
  locationName: string | null;
  address: string | null;
  remarks: string | null;
  archivedAt: Date | null;
  assignedCount: number;
};

/**
 * Clocking sites in scope, joined with company name + assigned-employee headcount + the LOCATION the point
 * sits under (code and name, which drive the grouped admin render and the personnel pre-tick). Tenant-
 * catalog read (RLS lets every tenant member through); companyIds narrows to the admin UI's active scope.
 *
 * The plan called for an INNER join on `location`. It is a LEFT join instead, for two reasons, the second
 * of which is not optional:
 *   1. location_id is nullable in the database (migration 0419 explains why), and an inner join would make
 *      such a row vanish from the admin screen entirely — the one screen on which an unlinked point must
 *      stay visible so it can be fixed. Zero such rows exist today; this is a safety net, not a feature.
 *   2. RLS. `clocking_location` is a TENANT-CATALOG read (every tenant member, ADR-0070 §1) but `location`
 *      is admin-only-read (migration 0111, app.is_admin_for(company_id)). An INNER join would therefore
 *      return ZERO rows for a plain employee — silently emptying the clock-in screen's site list. With a
 *      LEFT join the employee still sees every site; only the location's code/name come back null, which
 *      is exactly the visibility the two policies were written to give.
 */
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
        radiusM: clockingLocation.radiusM,
        locationId: clockingLocation.locationId,
        locationCode: location.code,
        locationName: location.name,
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
      .leftJoin(location, eq(location.id, clockingLocation.locationId))
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

export type AssignedClockingLocation = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** 1fff489c — the site's own radius, so the clock-in screen can say "within 150 m" per site. */
  radiusM: number | null;
  locationId: string | null;
};

/** The clocking sites currently assigned to one employment. Deliberately does NOT join `location`: this is
 *  read by the EMPLOYEE's own clock-in screen, and `location` is admin-only under RLS (see
 *  listClockingLocations above for what an inner join to it costs). */
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
        radiusM: clockingLocation.radiusM,
        locationId: clockingLocation.locationId,
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
 * Enable/disable geofencing for one employment + set its OPTIONAL radius override (metres).
 *
 * 1fff489c CHANGED THE MEANING OF THE RADIUS HERE. It used to be the ONLY radius, and was therefore
 * REQUIRED while enabling (backed by the employment_geofence_radius_required CHECK). The authoritative
 * distance now lives on each clocking site (clocking_location.radius_m), and this column is an OVERRIDE
 * that, when set, replaces every site's radius FOR THIS EMPLOYEE — the escape hatch for a field engineer
 * who legitimately needs a wider circle than the sites themselves define.
 *
 * So: blank while enabled is now VALID and means "each site uses its own radius" (the recommended
 * setting, and what the admin screen says). A supplied value is still validated — positive, ≤ MAX_RADIUS_M
 * — because a zero override would silently make every site unreachable. Disabling still clears it.
 */
export function setGeofencing(
  ctx: SessionContext,
  p: { employmentId: string; enabled: boolean; radiusM?: number | string | null },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ geofencingEnabled: employment.geofencingEnabled, geofenceRadiusM: employment.geofenceRadiusM })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');

    let radiusM: number | null = null;
    if (p.enabled && p.radiusM != null && String(p.radiusM).trim() !== '') {
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
