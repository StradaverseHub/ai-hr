/**
 * Clocking Location Management & Geofencing (ADR-0070). Modelled on core/location.ts, minus the code
 * field (a clocking site has no code namespace to reuse). RLS is the 0065 pay_component tenant-catalog
 * pattern for READ — see the ADR for why this is a SEPARATE table/registry from `location`.
 *
 * f9afd1ce (2026-09-11, migration 0459) — a clocking location is a SHARED, TENANT-LEVEL record. It has no
 * owner company: created once, available to every company. Three consequences, each enforced here:
 *   • WRITE AUTHORITY IS THE GROUP ADMINISTRATOR'S. A shared record may be in use by companies an
 *     administrator does not manage, so every writer below (create, update, archive, restore, delete)
 *     calls `assertGroupAdmin` first. The database says the same thing (RLS: INSERT/UPDATE/DELETE require
 *     app.is_group_admin()), and the screen renders the forms for group admins only. Three places, on
 *     purpose — the service is the one that answers in plain English.
 *   • THE LINK TO `location` IS OPTIONAL and may point at a non-archived location of ANY company. `location`
 *     is company-scoped; a site five companies share cannot honestly be required to belong to one company's
 *     holiday-calendar record.
 *   • ASSIGNMENT IS NOT SCOPED BY COMPANY. An employee of company B may be assigned a site that also serves
 *     company A. RLS on employee_clocking_location (can_admin_employment) is unchanged and is the guard that
 *     matters there: who may edit THIS employment's assignments, not which sites exist.
 *
 * f9afd1ce rev 2 (r267, migration 0461) — REPORT LABEL. A site carries an optional short label that the
 * Attendance report's Clocking Location column prints instead of the full name (core/reporting.ts reads
 * coalesce(report_label, name) for that one column). BLANK MEANS THE NAME, and the rule is enforced HERE:
 * `cleanReportLabel` trims and stores NULL for an empty label, so the report's coalesce is never fooled by
 * a row holding '' (there is deliberately no CHECK — CLAUDE.md §6). Every other reader — the locations
 * list, the employee's profile, the clock-in screen — keeps the name; the list shows the label beside it.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { isGroupAdmin, withEffectiveGrants } from '../lib/authz';
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

/** Thrown when a clocking point is saved with a location link it may not use (missing or archived). */
export class ClockingLocationLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockingLocationLinkError';
  }
}

/**
 * f9afd1ce — thrown by every writer when the caller is not a group administrator. The message names the
 * rule in the words the plan gave the reporter, because `app/admin/_redirects.ts fail()` copies it into
 * the banner verbatim: a company administrator who tries must be told WHY, and what they still can do.
 */
export class ClockingLocationAuthorityError extends Error {
  constructor() {
    super(
      'Only a group administrator can create, edit, archive or delete a shared clocking location — it may be in use by companies you do not manage. Assigning an existing location to an employee is still done on the employee’s profile.',
    );
    this.name = 'ClockingLocationAuthorityError';
  }
}

/**
 * The service-level half of the write authority. `withEffectiveGrants` treats a roles-only session the
 * way `withTenant` does (group-wide grants), so this judgement and the database's app.is_group_admin()
 * agree for the same context — a guard that disagreed with RLS would refuse in one place and silently
 * no-op in the other (an UPDATE policy's USING filters rows; it does not throw).
 */
function assertGroupAdmin(ctx: SessionContext): void {
  if (!isGroupAdmin(withEffectiveGrants(ctx))) throw new ClockingLocationAuthorityError();
}

/** 23505 anywhere in the cause chain. Same walk as core/location.ts / roster.ts / payroll-policy.ts. */
function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

/**
 * A clocking location with this name already exists in the TENANT (clocking_location_name_uq is per
 * tenant since 0459 — one record per physical place). Typed so app/admin/actions.ts can say so in the
 * admin's language; without it `fail()` copies drizzle's "Failed query: insert into … params: …" into
 * the banner, which is what the `location` master shipped with before 1fff489c.
 */
export class ClockingLocationNameTakenError extends Error {
  constructor(public readonly siteName: string) {
    super('clocking-location-name-taken');
    this.name = 'ClockingLocationNameTakenError';
  }
}

/** Map a unique-index violation to the typed error for its constraint; pass anything else through. */
function clockingUniqueError(e: unknown, siteName: string): unknown {
  if (!isUniqueViolation(e)) return e;
  let msg = '';
  let cur = e as { message?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    msg += cur.message ?? '';
    cur = cur.cause as { message?: string; cause?: unknown } | null | undefined;
  }
  if (/clocking_location_name_uq/i.test(msg)) return new ClockingLocationNameTakenError(siteName);
  // Unreachable while that is the only unique index on the table; kept so a future index cannot re-open
  // the raw-SQL banner.
  return new Error('A clocking location with this name already exists.');
}

/**
 * The id of the ONE row a writer's UPDATE/DELETE actually touched. An RLS UPDATE/DELETE policy's USING
 * clause FILTERS rows rather than throwing, so a write that reached no row would otherwise "succeed"
 * and append a clocking-location.* event about nothing. Every mutating writer reads its `.returning()`
 * through this before it appends.
 */
function touched(rows: { id: string }[]): string {
  const row = rows[0];
  if (!row) throw new Error('Clocking location not found, or you may not change it.');
  return row.id;
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
 * Resolve and validate the OPTIONAL link from a clocking point to a `location` master record.
 *
 * Blank means "no link" and returns null — the point then renders under the "Not linked to a location"
 * group on the admin screen and is never pre-ticked from anyone's work location. A supplied id must name
 * a location the caller can see (any company: the caller is a group admin, and `location`'s RLS lets a
 * group admin see every company's rows) that is NOT ARCHIVED — an archived location is out of every
 * assignment dropdown by design; letting a new point be filed under one would resurrect it as a group
 * heading nobody can select. Runs inside the caller's tx so it shares the RLS session.
 */
async function resolveLocationLink(tx: Tx, locationId: string | null | undefined): Promise<string | null> {
  const id = (locationId ?? '').trim();
  if (!id) return null;
  const [row] = await tx
    .select({ id: location.id, archivedAt: location.archivedAt })
    .from(location)
    .where(eq(location.id, id))
    .limit(1);
  if (!row) {
    throw new ClockingLocationLinkError('That location does not exist, or is not visible to you — pick one from the list.');
  }
  if (row.archivedAt) {
    throw new ClockingLocationLinkError('That location is archived — restore it first, or pick another.');
  }
  return row.id;
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

/**
 * f9afd1ce rev 2 — the report label. A report COLUMN value, so it is one line: inner whitespace collapsed,
 * trimmed, and capped — the cap is the sanity limit for something meant to be shorter than the name, not a
 * display width. Blank (or omitted) → NULL, which the report's coalesce reads as "print the name".
 */
export const MAX_REPORT_LABEL_CHARS = 60;
function cleanReportLabel(v: string | null | undefined): string | null {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > MAX_REPORT_LABEL_CHARS) {
    throw new Error(`Report label must be ${MAX_REPORT_LABEL_CHARS} characters or fewer — it is a short name for the report column, not a second address.`);
  }
  return s;
}

export type CreateClockingLocationInput = {
  name: string;
  lat: number;
  lng: number;
  /** 1fff489c — REQUIRED. Metres. See cleanRadius / radiusWarning for the hard vs advisory split. */
  radiusM: number | string;
  /** f9afd1ce — OPTIONAL. A non-archived `location` of any company in the tenant; blank = no link. */
  locationId?: string | null;
  address?: string | null;
  remarks?: string | null;
  /** f9afd1ce rev 2 — OPTIONAL. The short name the Attendance report prints; blank = the name is printed. */
  reportLabel?: string | null;
};

/** Every write returns the site id plus an optional SOFT advisory about the radius (never a refusal). */
export type ClockingLocationWriteResult = { id: string; warning: RadiusAdvisory | null };

export async function createClockingLocation(
  ctx: SessionContext,
  p: CreateClockingLocationInput,
): Promise<ClockingLocationWriteResult> {
  assertGroupAdmin(ctx);
  const name = cleanName(p.name);
  const lat = cleanCoord(p.lat, 'Latitude', -90, 90);
  const lng = cleanCoord(p.lng, 'Longitude', -180, 180);
  const radiusM = cleanRadius(p.radiusM);
  const address = cleanOptional(p.address);
  const remarks = cleanOptional(p.remarks);
  const reportLabel = cleanReportLabel(p.reportLabel);
  return withTenant(ctx, async (tx) => {
    const locationId = await resolveLocationLink(tx, p.locationId);
    let row: { id: string };
    try {
      [row] = await tx
        .insert(clockingLocation)
        .values({ tenantId: ctx.tenantId, name, lat, lng, radiusM, locationId, address, remarks, reportLabel })
        .returning({ id: clockingLocation.id });
    } catch (e) {
      // A name already used anywhere in the tenant leaves as a typed error, never as raw SQL + params.
      throw clockingUniqueError(e, name);
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: row.id,
      eventType: 'clocking-location.created',
      actor: actorOf(ctx),
      payload: { name, lat, lng, radiusM, locationId, address, remarks, reportLabel },
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
  locationId?: string | null;
  address?: string | null;
  remarks?: string | null;
  /** f9afd1ce rev 2 — OPTIONAL. Blank clears the label, and the report goes back to printing the name. */
  reportLabel?: string | null;
};

export async function updateClockingLocation(
  ctx: SessionContext,
  p: UpdateClockingLocationInput,
): Promise<ClockingLocationWriteResult> {
  assertGroupAdmin(ctx);
  const name = cleanName(p.name);
  const lat = cleanCoord(p.lat, 'Latitude', -90, 90);
  const lng = cleanCoord(p.lng, 'Longitude', -180, 180);
  const radiusM = cleanRadius(p.radiusM);
  const address = cleanOptional(p.address);
  const remarks = cleanOptional(p.remarks);
  const reportLabel = cleanReportLabel(p.reportLabel);
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
        reportLabel: clockingLocation.reportLabel,
      })
      .from(clockingLocation)
      .where(eq(clockingLocation.id, p.clockingLocationId))
      .limit(1);
    if (!before) throw new Error('Clocking location not found');
    const locationId = await resolveLocationLink(tx, p.locationId);
    let updated: { id: string }[];
    try {
      updated = await tx
        .update(clockingLocation)
        .set({ name, lat, lng, radiusM, locationId, address, remarks, reportLabel })
        .where(eq(clockingLocation.id, p.clockingLocationId))
        .returning({ id: clockingLocation.id });
    } catch (e) {
      throw clockingUniqueError(e, name);
    }
    touched(updated);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: p.clockingLocationId,
      eventType: 'clocking-location.updated',
      actor: actorOf(ctx),
      payload: { before, after: { name, lat, lng, radiusM, locationId, address, remarks, reportLabel } },
    });
    return { id: p.clockingLocationId, warning: radiusWarning(radiusM) };
  });
}

export async function archiveClockingLocation(ctx: SessionContext, p: { clockingLocationId: string }) {
  assertGroupAdmin(ctx);
  return withTenant(ctx, async (tx) => {
    touched(
      await tx
        .update(clockingLocation)
        .set({ archivedAt: new Date() })
        .where(eq(clockingLocation.id, p.clockingLocationId))
        .returning({ id: clockingLocation.id }),
    );
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
  assertGroupAdmin(ctx);
  return withTenant(ctx, async (tx) => {
    touched(
      await tx
        .update(clockingLocation)
        .set({ archivedAt: null })
        .where(eq(clockingLocation.id, p.clockingLocationId))
        .returning({ id: clockingLocation.id }),
    );
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
 * column); callers should archive an in-use site instead. Group admins only (service + RLS DELETE policy).
 * `async` like the other writers so the authority refusal is a REJECTION, never a synchronous throw.
 */
export async function deleteClockingLocation(ctx: SessionContext, p: { clockingLocationId: string }) {
  assertGroupAdmin(ctx);
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
    touched(
      await tx
        .delete(clockingLocation)
        .where(eq(clockingLocation.id, p.clockingLocationId))
        .returning({ id: clockingLocation.id }),
    );
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
  name: string;
  lat: number;
  lng: number;
  /** 1fff489c — the site's own allowed distance. Null only for a row written before 0419 (none exist). */
  radiusM: number | null;
  locationId: string | null;
  /** Null when unlinked — OR when the linked location is one this caller's RLS does not let them see. */
  locationCode: string | null;
  locationName: string | null;
  /** The linked location's company (a `location` belongs to one company; a clocking site does not). */
  locationCompanyName: string | null;
  /** The linked location's own archive stamp, so the group heading's pill never depends on a second list. */
  locationArchivedAt: Date | null;
  address: string | null;
  remarks: string | null;
  /** f9afd1ce rev 2 — the Attendance report's short name for the site; null = the report prints the name. */
  reportLabel: string | null;
  archivedAt: Date | null;
  assignedCount: number;
  /**
   * f9afd1ce "Used by" — the distinct companies whose employees are assigned to this site, by display
   * label (company_label, else legal_name), sorted. Empty when nobody is assigned. Derived from the
   * assignments, never stored: a shared site has no owner company, so this is the only honest answer to
   * "who uses it".
   */
  usedByCompanies: string[];
};

/**
 * Every clocking site in the tenant, joined with the LOCATION the point sits under (code, name and that
 * location's company — these drive the grouped admin render and the personnel pre-tick), the assigned-
 * employee headcount, and the "Used by" company list. Tenant-catalog read (RLS lets every tenant member
 * through). f9afd1ce: NO company parameter — a shared master has no company to filter by, and the
 * personnel screen offers every site to every employee.
 *
 * Ordered by linked location code, then location name, then site name; Postgres puts NULLs last on ASC,
 * so unlinked sites follow the linked ones — the order the admin screen groups them in.
 *
 * LEFT joins on `location` (and its company), for two reasons, the second of which is not optional:
 *   1. location_id is nullable and now OPTIONAL; an inner join would make an unlinked row vanish from the
 *      admin screen entirely — the one screen on which such a point must stay visible.
 *   2. RLS. `clocking_location` is a TENANT-CATALOG read (every tenant member, ADR-0070 §1) but `location`
 *      is admin-only-read (migration 0111, is_admin_for(company_id)). An INNER join would return ZERO rows
 *      for a plain employee — silently emptying the clock-in screen's site list — and would hide from a
 *      COMPANY admin every shared site linked to another company's location. With a LEFT join every
 *      caller sees every site; only the location's code/name come back null, which the admin screen
 *      renders as its own group ("linked to a location outside your scope") rather than as unlinked.
 */
export function listClockingLocations(
  ctx: SessionContext,
  opts: { includeArchived?: boolean } = {},
): Promise<ClockingLocationRow[]> {
  return withTenant(ctx, (tx) => {
    const conds = [];
    if (!opts.includeArchived) conds.push(isNull(clockingLocation.archivedAt));
    return tx
      .select({
        id: clockingLocation.id,
        name: clockingLocation.name,
        lat: clockingLocation.lat,
        lng: clockingLocation.lng,
        radiusM: clockingLocation.radiusM,
        locationId: clockingLocation.locationId,
        locationCode: location.code,
        locationName: location.name,
        locationCompanyName: sql<string | null>`coalesce(${company.companyLabel}, ${company.legalName})`,
        locationArchivedAt: location.archivedAt,
        address: clockingLocation.address,
        remarks: clockingLocation.remarks,
        reportLabel: clockingLocation.reportLabel,
        archivedAt: clockingLocation.archivedAt,
        assignedCount: sql<number>`(
          select count(*)::int from employee_clocking_location ecl
          where ecl.clocking_location_id = ${clockingLocation.id}
        )`,
        usedByCompanies: sql<string[]>`coalesce((
          select array_agg(distinct coalesce(uc.company_label, uc.legal_name) order by coalesce(uc.company_label, uc.legal_name))
          from employee_clocking_location ecl
          join employment ue on ue.id = ecl.employment_id
          join company uc on uc.id = ue.company_id
          where ecl.clocking_location_id = ${clockingLocation.id}
        ), '{}'::text[])`,
      })
      .from(clockingLocation)
      .leftJoin(location, eq(location.id, clockingLocation.locationId))
      .leftJoin(company, eq(company.id, location.companyId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(location.code), asc(location.name), asc(clockingLocation.name));
  });
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

/**
 * Set-based replace of an employment's assigned clocking sites (delete-then-insert inside one
 * transaction — a simple "currently assigned" list, no effective-dating, per the request).
 *
 * f9afd1ce REMOVED the cross-company guard that lived here. Sites are shared: an employee of company B
 * may be assigned a gate that also serves company A, and that is the point. Who may edit THIS employment's
 * assignments is still decided by RLS on employee_clocking_location (can_admin_employment); which sites
 * exist is decided by the tenant-wide catalog read. The FK to clocking_location refuses an id that is not
 * a site at all.
 */
export function setEmployeeClockingLocations(
  ctx: SessionContext,
  p: { employmentId: string; clockingLocationIds: string[] },
) {
  const ids = [...new Set(p.clockingLocationIds)];
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new Error('Employment not found');

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
