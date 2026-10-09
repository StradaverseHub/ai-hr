/**
 * Clocking Location Management & Geofencing (ADR-0070). Modelled on core/location.ts, minus the code
 * field (a clocking site has no code namespace to reuse). RLS is the 0065 pay_component tenant-catalog
 * pattern for READ — see the ADR for why this is a SEPARATE table/registry from `location`.
 *
 * f9afd1ce (2026-09-11, migration 0459) — a clocking location is a SHARED, TENANT-LEVEL record. It has no
 * owner company: created once, available to every company [r423: to the companies ticked on it]. Three
 * consequences, each enforced here:
 *   • WRITE AUTHORITY IS THE GROUP ADMINISTRATOR'S. A shared record may be in use by companies an
 *     administrator does not manage, so every writer below (create, update, archive, restore, delete)
 *     calls `assertGroupAdmin` first. The database says the same thing (RLS: INSERT/UPDATE/DELETE require
 *     app.is_group_admin()), and the screen renders the forms for group admins only. Three places, on
 *     purpose — the service is the one that answers in plain English.
 *   • THE LINK TO `location` IS OPTIONAL and may point at a non-archived location of ANY company. `location`
 *     is company-scoped; a site five companies share cannot honestly be required to belong to one company's
 *     holiday-calendar record.
 *   • ASSIGNMENT IS NOT SCOPED BY COMPANY. [REVERSED by r423 — see below: a site is now open to named
 *     companies and only an employee of one of them may be given it.] RLS on employee_clocking_location
 *     (can_admin_employment) is unchanged: who may edit THIS employment's assignments.
 *
 * f9afd1ce rev 2 (r267, migration 0461) — REPORT LABEL. A site carries an optional short label that the
 * Attendance report's Clocking Location column prints instead of the full name (core/reporting.ts reads
 * coalesce(report_label, name) for that one column). BLANK MEANS THE NAME, and the rule is enforced HERE:
 * `cleanReportLabel` trims and stores NULL for an empty label, so the report's coalesce is never fooled by
 * a row holding '' (there is deliberately no CHECK — CLAUDE.md §6). Every other reader — the locations
 * list, the employee's profile, the clock-in screen — keeps the name; the list shows the label beside it.
 *
 * r423 (83c0d3c8, migration 0517) — A SHARED LOCATION IS OPENED TO NAMED COMPANIES, AND ONE SWITCH DECIDES.
 *   • Still ONE record per physical place, still written by a group administrator only. What is new is the
 *     list of companies allowed to use it (clocking_location_company): at least one, enforced here. A company
 *     cannot be unticked while employees of that company are assigned to the location
 *     (ClockingLocationCompanyInUseError carries how many). This REVERSES f9afd1ce's "assignment is not
 *     scoped by company": an employee may be given only an ACTIVE location open to THEIR company.
 *   • A location carries an optional STATE (display and filtering only — it never drives holidays),
 *     validated against the selected companies' countries.
 *   • The employee's Attendance tab has ONE switch, "Use Geofencing for Clocking" (employment.
 *     geofencing_enabled), written together with the assignments by `setClockingControl`, which replaced
 *     the two independent writers (the site list and the toggle + radius override). OFF clears the
 *     assignments; ON requires at least one usable location. The per-employee radius override is retired:
 *     each location's own radius is the only radius.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { isGroupAdmin, withEffectiveGrants } from '../lib/authz';
import { validateStateFor } from './state-vocabulary';
import {
  attendance,
  clockingLocation,
  clockingLocationCompany,
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
 * r423 — a clocking location must be open to at least one company. A location no company may use cannot be
 * given to anybody, so it is refused rather than saved as a dead record.
 */
export class ClockingLocationCompanyRequiredError extends Error {
  constructor() {
    super('Tick at least one company allowed to use this clocking location.');
    this.name = 'ClockingLocationCompanyRequiredError';
  }
}

/**
 * r423 — a company cannot be unticked while employees of that company are assigned to the location. The
 * count (and the companies' names) travel with the error so the screen can say how many to move first.
 */
export class ClockingLocationCompanyInUseError extends Error {
  constructor(
    public readonly count: number,
    public readonly companyNames: string[],
  ) {
    super(
      `${companyNames.join(', ')} cannot be unticked: ${count} employee(s) of that company are assigned to this location. Move them to another location first.`,
    );
    this.name = 'ClockingLocationCompanyInUseError';
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

/**
 * r423 — the companies a location is opened to. Deduplicated; at least one; every id must be a company of
 * this tenant the caller can see (a group administrator sees every company). Returns the ids and their
 * countries, which the state is validated against. Runs inside the caller's tx so it shares RLS.
 */
async function resolveCompanies(tx: Tx, ids: readonly string[] | undefined): Promise<{ ids: string[]; countries: string[] }> {
  const wanted = [...new Set((ids ?? []).map((v) => String(v).trim()).filter(Boolean))];
  if (wanted.length === 0) throw new ClockingLocationCompanyRequiredError();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (wanted.some((v) => !UUID.test(v))) throw new Error('One of the selected companies does not exist.');
  const rows = await tx.select({ id: company.id, country: company.country }).from(company).where(inArray(company.id, wanted));
  if (rows.length !== wanted.length) throw new Error('One of the selected companies does not exist, or is not visible to you.');
  return { ids: [...wanted].sort(), countries: [...new Set(rows.map((r) => r.country))] };
}

/** r423 — the optional state: blank → NULL; otherwise one of the selected companies' countries' states. */
function cleanState(v: string | null | undefined, countries: readonly string[]): string | null {
  return validateStateFor(v, countries, 'state');
}

/** r423 — the company ids a location is currently opened to, sorted (the event's before/after shape). */
async function companyIdsOf(tx: Tx, clockingLocationId: string): Promise<string[]> {
  const rows = await tx
    .select({ companyId: clockingLocationCompany.companyId })
    .from(clockingLocationCompany)
    .where(eq(clockingLocationCompany.clockingLocationId, clockingLocationId));
  return rows.map((r) => r.companyId).sort();
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
  /** r423 — REQUIRED, at least one. The companies whose employees may be given this location. */
  companyIds: string[];
  /** r423 — OPTIONAL. A state of one of the selected companies' countries; display and filtering only. */
  state?: string | null;
  /** r423 — the Status radio. Omitted = Active. Inactive is the existing archive stamp. */
  active?: boolean;
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
    const companies = await resolveCompanies(tx, p.companyIds);
    const state = cleanState(p.state, companies.countries);
    const archivedAt = p.active === false ? new Date() : null;
    let row: { id: string };
    try {
      [row] = await tx
        .insert(clockingLocation)
        .values({ tenantId: ctx.tenantId, name, lat, lng, radiusM, locationId, address, remarks, reportLabel, state, archivedAt })
        .returning({ id: clockingLocation.id });
    } catch (e) {
      // A name already used anywhere in the tenant leaves as a typed error, never as raw SQL + params.
      throw clockingUniqueError(e, name);
    }
    await tx
      .insert(clockingLocationCompany)
      .values(companies.ids.map((companyId) => ({ tenantId: ctx.tenantId, clockingLocationId: row.id, companyId })));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: row.id,
      eventType: 'clocking-location.created',
      actor: actorOf(ctx),
      payload: {
        name, lat, lng, radiusM, locationId, address, remarks, reportLabel,
        companyIds: companies.ids, state, active: archivedAt == null,
      },
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
  /** r423 — REQUIRED, at least one. Unticking a company with assigned employees is refused with a count. */
  companyIds: string[];
  /** r423 — OPTIONAL. Blank clears it. */
  state?: string | null;
  /** r423 — the Status radio. Omitted = leave the status as it is. */
  active?: boolean;
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
        state: clockingLocation.state,
        archivedAt: clockingLocation.archivedAt,
      })
      .from(clockingLocation)
      .where(eq(clockingLocation.id, p.clockingLocationId))
      .limit(1);
    if (!before) throw new Error('Clocking location not found');
    const locationId = await resolveLocationLink(tx, p.locationId);
    const companies = await resolveCompanies(tx, p.companyIds);
    const state = cleanState(p.state, companies.countries);
    const beforeCompanyIds = await companyIdsOf(tx, p.clockingLocationId);
    const removed = beforeCompanyIds.filter((id) => !companies.ids.includes(id));
    const added = companies.ids.filter((id) => !beforeCompanyIds.includes(id));

    // r423 — a company cannot be unticked while its employees are assigned here: their only usable site
    // would vanish under them with no message. Counted as the caller (a group administrator sees every
    // employment), so the number is the whole number, not the part one company admin could see.
    if (removed.length) {
      const inUse = await tx
        .select({
          n: sql<number>`count(distinct ${employeeClockingLocation.employmentId})::int`,
          names: sql<string[]>`coalesce(array_agg(distinct coalesce(${company.companyLabel}, ${company.legalName})), '{}'::text[])`,
        })
        .from(employeeClockingLocation)
        .innerJoin(employment, eq(employment.id, employeeClockingLocation.employmentId))
        .innerJoin(company, eq(company.id, employment.companyId))
        .where(and(eq(employeeClockingLocation.clockingLocationId, p.clockingLocationId), inArray(employment.companyId, removed)));
      const n = inUse[0]?.n ?? 0;
      if (n > 0) throw new ClockingLocationCompanyInUseError(n, [...(inUse[0]?.names ?? [])].sort());
    }

    const archivedAt =
      p.active === undefined ? before.archivedAt : p.active ? null : (before.archivedAt ?? new Date());
    let updated: { id: string }[];
    try {
      updated = await tx
        .update(clockingLocation)
        .set({ name, lat, lng, radiusM, locationId, address, remarks, reportLabel, state, archivedAt })
        .where(eq(clockingLocation.id, p.clockingLocationId))
        .returning({ id: clockingLocation.id });
    } catch (e) {
      throw clockingUniqueError(e, name);
    }
    touched(updated);
    if (removed.length) {
      await tx
        .delete(clockingLocationCompany)
        .where(and(eq(clockingLocationCompany.clockingLocationId, p.clockingLocationId), inArray(clockingLocationCompany.companyId, removed)));
    }
    if (added.length) {
      await tx
        .insert(clockingLocationCompany)
        .values(added.map((companyId) => ({ tenantId: ctx.tenantId, clockingLocationId: p.clockingLocationId, companyId })));
    }
    const { archivedAt: beforeArchivedAt, ...beforeFields } = before;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-location',
      aggregateId: p.clockingLocationId,
      eventType: 'clocking-location.updated',
      actor: actorOf(ctx),
      payload: {
        before: { ...beforeFields, companyIds: beforeCompanyIds, active: beforeArchivedAt == null },
        after: { name, lat, lng, radiusM, locationId, address, remarks, reportLabel, state, companyIds: companies.ids, active: archivedAt == null },
      },
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

export type ClockingLocationCompanyRef = { id: string; name: string };

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
  /** The linked location's company (a `location` belongs to one company). */
  locationCompanyName: string | null;
  /** The linked location's own archive stamp. */
  locationArchivedAt: Date | null;
  address: string | null;
  remarks: string | null;
  /** f9afd1ce rev 2 — the Attendance report's short name for the site; null = the report prints the name. */
  reportLabel: string | null;
  /** r423 — the state the site is in (display and filtering only). */
  state: string | null;
  archivedAt: Date | null;
  /** Assigned employments the caller can see (a company admin's count covers only their companies). */
  assignedCount: number;
  /**
   * r423 — the companies this location is open to, by display label, sorted, FILTERED TO THE COMPANIES THE
   * CALLER ADMINISTERS (every company for a group administrator). A company administrator is never shown
   * another company's name: the filter is in the query (app.is_admin_for), not in the screen.
   */
  companies: ClockingLocationCompanyRef[];
};

export type ListClockingLocationsOptions = {
  /** Kept for the callers that only want live sites (the default) or every site. `status` wins when set. */
  includeArchived?: boolean;
  /** r423 — the list's Status filter. */
  status?: 'all' | 'active' | 'inactive';
  /** r423 — name or address contains this text (case-insensitive). */
  q?: string;
  /** r423 — only locations open to this company. */
  companyId?: string;
};

/**
 * r423 — the clocking locations, as the Attendance › Locations list shows them: each with the companies it
 * is open to, its state, status and assigned headcount, filtered by search / company / status.
 *
 * WHO SEES WHAT. A group administrator sees every location and every company on it. Anyone else sees only
 * the locations open to at least one company they ADMINISTER, and on each only those companies' names —
 * both decided in SQL by app.is_admin_for, and clocking_location_company's own RLS says the same thing
 * underneath. (A plain employee therefore gets an empty list here; their own Clock screen reads through
 * listEmployeeClockingLocations and core/attendance.ts, never through this.)
 *
 * LEFT joins on `location` (and its company): location_id is optional, and `location` is admin-read under
 * RLS, so an inner join would hide rows linked to a location this caller cannot see.
 *
 * Ordered by name: the list is a register of places, not a grouping by work location any more.
 */
export function listClockingLocations(
  ctx: SessionContext,
  opts: ListClockingLocationsOptions = {},
): Promise<ClockingLocationRow[]> {
  const groupAdmin = isGroupAdmin(withEffectiveGrants(ctx));
  return withTenant(ctx, async (tx) => {
    const conds = [];
    const status = opts.status ?? (opts.includeArchived ? 'all' : 'active');
    if (status === 'active') conds.push(isNull(clockingLocation.archivedAt));
    if (status === 'inactive') conds.push(isNotNull(clockingLocation.archivedAt));
    const q = (opts.q ?? '').trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(sql`(${clockingLocation.name} ilike ${like} or coalesce(${clockingLocation.address}, '') ilike ${like})`);
    }
    if (!groupAdmin) {
      conds.push(sql`exists (
        select 1 from clocking_location_company vc
        where vc.clocking_location_id = ${clockingLocation.id} and app.is_admin_for(vc.company_id)
      )`);
    }
    if (opts.companyId) {
      conds.push(sql`exists (
        select 1 from clocking_location_company fc
        where fc.clocking_location_id = ${clockingLocation.id} and fc.company_id = ${opts.companyId}::uuid
      )`);
    }
    const rows = await tx
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
        state: clockingLocation.state,
        archivedAt: clockingLocation.archivedAt,
        assignedCount: sql<number>`(
          select count(*)::int from employee_clocking_location ecl
          where ecl.clocking_location_id = ${clockingLocation.id}
        )`,
        companies: sql<ClockingLocationCompanyRef[]>`coalesce((
          select json_agg(json_build_object('id', cc.id, 'name', coalesce(cc.company_label, cc.legal_name))
                          order by coalesce(cc.company_label, cc.legal_name), cc.id)
          from clocking_location_company clc
          join company cc on cc.id = clc.company_id
          where clc.clocking_location_id = ${clockingLocation.id}
            and (app.is_group_admin() or app.is_admin_for(clc.company_id))
        ), '[]'::json)`,
      })
      .from(clockingLocation)
      .leftJoin(location, eq(location.id, clockingLocation.locationId))
      .leftJoin(company, eq(company.id, location.companyId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(clockingLocation.name), asc(clockingLocation.id));
    return rows;
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
  address: string | null;
  archivedAt: Date | null;
  /**
   * r423 — whether this assignment can be clocked at: the location is ACTIVE and open to the employment's
   * CURRENT company. An assignment that is not (deactivated, or the employee transferred to a company the
   * site is not open to) stays on file and is shown flagged; it does not count towards the one required
   * location and core/attendance.ts never matches it.
   */
  usable: boolean;
};

/** The clocking sites currently assigned to one employment. Deliberately does NOT join `location`: this is
 *  read under the EMPLOYEE's own session too, and `location` is admin-only under RLS. */
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
        address: clockingLocation.address,
        archivedAt: clockingLocation.archivedAt,
        usable: sql<boolean>`(${clockingLocation.archivedAt} is null and exists (
          select 1 from clocking_location_company uc
          join employment ue on ue.company_id = uc.company_id
          where uc.clocking_location_id = ${clockingLocation.id} and ue.id = ${employeeClockingLocation.employmentId}
        ))`,
      })
      .from(employeeClockingLocation)
      .innerJoin(clockingLocation, eq(clockingLocation.id, employeeClockingLocation.clockingLocationId))
      .where(eq(employeeClockingLocation.employmentId, employmentId))
      .orderBy(asc(clockingLocation.name), asc(clockingLocation.id)),
  );
}

/**
 * r423 — refused when the switch is ON and no usable location is chosen. The words are the plan's.
 */
export class ClockingLocationRequiredError extends Error {
  constructor() {
    super('Choose at least one clocking location, or turn geofencing off.');
    this.name = 'ClockingLocationRequiredError';
  }
}

/** r423 — refused when a NEWLY chosen location is inactive or not open to the employee's company. */
export class ClockingLocationNotAvailableError extends Error {
  constructor() {
    super('That clocking location is inactive or not open to this employee’s company — choose one from the list.');
    this.name = 'ClockingLocationNotAvailableError';
  }
}

/**
 * r423 — THE ONE WRITER of an employee's clocking control: the "Use Geofencing for Clocking" switch and the
 * clocking locations it needs, in ONE transaction and ONE event. It replaced two independent writers (the
 * set-based site list and the toggle + radius override), which could be saved apart and leave the switch on
 * with nothing assigned.
 *
 *   OFF → the assignments are cleared (the event keeps the old list) and the switch is stored off.
 *   ON  → at least one chosen location must be USABLE: active AND open to the employment's company. A
 *         location newly added must itself be usable (the picker offers only those; a crafted post is
 *         refused). One already assigned that has become unusable may stay — it is shown flagged, counts for
 *         nothing and never matches at clock-in — so a save never silently drops history the admin can see.
 *
 * employment.geofence_radius_m is not written: the override is retired (0517).
 * Who may write THIS employment is RLS on employee_clocking_location (can_admin_employment) and on
 * employment, unchanged.
 */
export function setClockingControl(
  ctx: SessionContext,
  p: { employmentId: string; enabled: boolean; clockingLocationIds: string[] },
) {
  const ids = [...new Set(p.clockingLocationIds.map((v) => String(v).trim()).filter(Boolean))];
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ id: employment.id, companyId: employment.companyId, geofencingEnabled: employment.geofencingEnabled })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new Error('Employment not found');

    const before = await tx
      .select({ id: employeeClockingLocation.clockingLocationId })
      .from(employeeClockingLocation)
      .where(eq(employeeClockingLocation.employmentId, p.employmentId));
    const beforeIds = before.map((b) => b.id).sort();

    let afterIds: string[] = [];
    if (p.enabled) {
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (ids.some((v) => !UUID.test(v))) throw new ClockingLocationNotAvailableError();
      const usableRows = ids.length
        ? await tx
            .select({ id: clockingLocation.id })
            .from(clockingLocation)
            .where(
              and(
                inArray(clockingLocation.id, ids),
                isNull(clockingLocation.archivedAt),
                sql`exists (select 1 from clocking_location_company uc
                            where uc.clocking_location_id = ${clockingLocation.id} and uc.company_id = ${emp.companyId})`,
              ),
            )
        : [];
      const usable = new Set(usableRows.map((r) => r.id));
      const kept = new Set(beforeIds);
      if (ids.some((id) => !usable.has(id) && !kept.has(id))) throw new ClockingLocationNotAvailableError();
      if (usable.size === 0) throw new ClockingLocationRequiredError();
      afterIds = [...ids].sort();
    }

    await tx.delete(employeeClockingLocation).where(eq(employeeClockingLocation.employmentId, p.employmentId));
    if (afterIds.length) {
      await tx
        .insert(employeeClockingLocation)
        .values(afterIds.map((clockingLocationId) => ({ tenantId: ctx.tenantId, employmentId: p.employmentId, clockingLocationId })));
    }
    const updated = await tx
      .update(employment)
      .set({ geofencingEnabled: p.enabled })
      .where(eq(employment.id, p.employmentId))
      .returning({ id: employment.id });
    if (!updated.length) throw new Error('Employment not found, or you may not change it.');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employee.clocking-control.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        before: { enabled: emp.geofencingEnabled, clockingLocationIds: beforeIds },
        after: { enabled: p.enabled, clockingLocationIds: afterIds },
      },
    });
    return { employmentId: p.employmentId, enabled: p.enabled, clockingLocationIds: afterIds };
  });
}

/**
 * r430 (board item b8ca6efe, migration 0520) — THE ONE WRITER of an employee's Web Clocking Attendance
 * Photo setting: required (a photo must be taken or the clocking is refused), optional (the employee may
 * take one or skip it), or not_required (no camera step at all, the default every employee starts on).
 * Lives beside setClockingControl — same "employee-level attendance capture rule" cohesion, same column
 * family on `employment`. Read SERVER-SIDE and enforced at every clock-in/out
 * (core/attendance-clock.ts captureEmployeeClockTx); this writer only changes which rule applies, never
 * enforces it itself.
 */
export type AttendancePhotoSetting = 'required' | 'optional' | 'not_required';

export function setAttendancePhotoSetting(
  ctx: SessionContext,
  p: { employmentId: string; setting: AttendancePhotoSetting },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ attendancePhotoSetting: employment.attendancePhotoSetting })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!before) throw new Error('Employment not found');
    const updated = await tx
      .update(employment)
      .set({ attendancePhotoSetting: p.setting })
      .where(eq(employment.id, p.employmentId))
      .returning({ id: employment.id });
    if (!updated.length) throw new Error('Employment not found, or you may not change it.');
    // Substrate (ADR-0006): consistent with attendance.card.assigned/cleared and
    // attendance.device.registered/revoked — a per-employee attendance-capture RULE change, not a punch.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'attendance.photo-setting.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: before.attendancePhotoSetting, after: p.setting },
    });
    return { employmentId: p.employmentId, attendancePhotoSetting: p.setting };
  });
}
