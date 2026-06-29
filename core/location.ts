/**
 * Location master data (ADR-0054). Company-scoped physical-site records that carry an optional `state`
 * override for holiday resolution. CRUD is HR-admin only — RLS gates every read+write by
 * app.is_admin_for(company_id) (migration 0111). Each write runs inside withTenant and appends a
 * DomainEvent (substrate discipline). The employee↔location link is assignment.location_id, set through
 * the existing effective-dated transferEmployee path in core/org.ts (no assign function here).
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { company, holidayGroup, location } from '../db/schema';
import { MY_STATES } from '../localization/my/holidays';

/** Resolve a holiday-group (calendar) id to a tenant-scoped group, or null when no calendar is assigned.
 *  Throws if the id is non-empty but does not resolve in scope (RLS already tenant-scopes the read), so a
 *  stale/cross-tenant id can't be stored on a location. */
async function resolveHolidayGroupId(tx: Tx, holidayGroupId: string | null | undefined): Promise<string | null> {
  const id = (holidayGroupId ?? '').trim();
  if (!id) return null;
  const [g] = await tx
    .select({ id: holidayGroup.id })
    .from(holidayGroup)
    .where(eq(holidayGroup.id, id))
    .limit(1);
  if (!g) throw new Error('Unknown holiday calendar');
  return g.id;
}

/** Trim + uppercase the code (0030 catalog-integrity pattern); the partial-unique index is exact-match. */
function cleanCode(v: string | undefined): string {
  const s = (v ?? '').trim().toUpperCase();
  if (!s) throw new Error('Location code is required');
  return s;
}
function cleanName(v: string | undefined): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('Location name is required');
  return s;
}
/** ISO-3166 alpha-2, display only (the engine keeps using company.country). */
function cleanCountry(v: string | undefined): string {
  const s = (v || 'MY').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) throw new Error('Country must be a 2-letter code (e.g. MY)');
  return s;
}
/** The holiday-state override. Null = inherit work_state/default/national. Validated against the known
 *  MY state labels so a garbage value can't silently disable holiday matching. */
function cleanState(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  if (!(MY_STATES as readonly string[]).includes(s)) throw new Error(`Unknown state: ${s}`);
  return s;
}

export type CreateLocationInput = {
  companyId: string;
  code: string;
  name: string;
  country?: string;
  state?: string | null;
  // ADR-0067: the named holiday CALENDAR (holiday_group) every employee at this location follows. Null =
  // unmapped → today's resolution (state override → company default → national), byte-identical.
  holidayGroupId?: string | null;
};

export async function createLocation(ctx: SessionContext, p: CreateLocationInput) {
  const code = cleanCode(p.code);
  const name = cleanName(p.name);
  const country = cleanCountry(p.country);
  const state = cleanState(p.state);
  return withTenant(ctx, async (tx) => {
    const holidayGroupId = await resolveHolidayGroupId(tx, p.holidayGroupId);
    const [row] = await tx
      .insert(location)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, code, name, country, state, holidayGroupId })
      .returning({ id: location.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'location',
      aggregateId: row.id,
      eventType: 'location.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, code, name, country, state, holidayGroupId },
    });
    return { id: row.id };
  });
}

export type UpdateLocationInput = {
  locationId: string;
  code: string;
  name: string;
  country?: string;
  state?: string | null;
  holidayGroupId?: string | null;
};

export async function updateLocation(ctx: SessionContext, p: UpdateLocationInput) {
  const code = cleanCode(p.code);
  const name = cleanName(p.name);
  const country = cleanCountry(p.country);
  const state = cleanState(p.state);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        code: location.code,
        name: location.name,
        country: location.country,
        state: location.state,
        holidayGroupId: location.holidayGroupId,
      })
      .from(location)
      .where(eq(location.id, p.locationId))
      .limit(1);
    if (!before) throw new Error('Location not found');
    const holidayGroupId = await resolveHolidayGroupId(tx, p.holidayGroupId);
    await tx
      .update(location)
      .set({ code, name, country, state, holidayGroupId })
      .where(eq(location.id, p.locationId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'location',
      aggregateId: p.locationId,
      eventType: 'location.updated',
      actor: actorOf(ctx),
      payload: { before, after: { code, name, country, state, holidayGroupId } },
    });
    return { id: p.locationId };
  });
}

export async function archiveLocation(ctx: SessionContext, p: { locationId: string }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(location).set({ archivedAt: new Date() }).where(eq(location.id, p.locationId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'location',
      aggregateId: p.locationId,
      eventType: 'location.archived',
      actor: actorOf(ctx),
      payload: { locationId: p.locationId },
    });
    return { id: p.locationId };
  });
}

export async function restoreLocation(ctx: SessionContext, p: { locationId: string }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(location).set({ archivedAt: null }).where(eq(location.id, p.locationId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'location',
      aggregateId: p.locationId,
      eventType: 'location.restored',
      actor: actorOf(ctx),
      payload: { locationId: p.locationId },
    });
    return { id: p.locationId };
  });
}

export type LocationRow = {
  id: string;
  companyId: string;
  companyName: string;
  code: string;
  name: string;
  country: string;
  state: string | null;
  // ADR-0067: the mapped holiday calendar (null = unmapped). name + archetype let the admin row show it.
  holidayGroupId: string | null;
  holidayGroupName: string | null;
  holidayGroupArchetype: string | null;
  archivedAt: Date | null;
  headcount: number;
};

/** Locations in scope, joined with company name + active headcount (open assignment rows pointing here) +
 *  the mapped holiday calendar's name/archetype (left join — null when unmapped).
 *  RLS already scopes rows to admin-of-company; companyIds further narrows to the UI's active scope. */
export function listLocations(
  ctx: SessionContext,
  companyIds: string[],
  opts: { includeArchived?: boolean } = {},
): Promise<LocationRow[]> {
  return withTenant(ctx, (tx) => {
    const conds = [];
    if (companyIds.length) conds.push(inArray(location.companyId, companyIds));
    if (!opts.includeArchived) conds.push(isNull(location.archivedAt));
    return tx
      .select({
        id: location.id,
        companyId: location.companyId,
        companyName: company.legalName,
        code: location.code,
        name: location.name,
        country: location.country,
        state: location.state,
        holidayGroupId: location.holidayGroupId,
        holidayGroupName: holidayGroup.name,
        holidayGroupArchetype: holidayGroup.archetype,
        archivedAt: location.archivedAt,
        headcount: sql<number>`(
          select count(*)::int from assignment a
          where a.location_id = ${location.id}
            and a.valid_to is null and a.superseded_at is null
        )`,
      })
      .from(location)
      .innerJoin(company, eq(company.id, location.companyId))
      .leftJoin(holidayGroup, eq(holidayGroup.id, location.holidayGroupId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(company.legalName), asc(location.code));
  });
}

/** A location's company id (for the cross-company coherence check in transferEmployee). Null if absent. */
export async function locationCompanyId(ctx: SessionContext, locationId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ companyId: location.companyId })
      .from(location)
      .where(eq(location.id, locationId))
      .limit(1);
    return row?.companyId ?? null;
  });
}
