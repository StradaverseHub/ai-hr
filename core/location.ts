/**
 * Location master data (ADR-0054). Company-scoped physical-site records that carry an optional `state`
 * override for holiday resolution. CRUD is HR-admin only — RLS gates every read+write by
 * app.is_admin_for(company_id) (migration 0111). Each write runs inside withTenant and appends a
 * DomainEvent (substrate discipline). The employee↔location link is assignment.location_id, set through
 * the existing effective-dated transferEmployee path in core/org.ts (no assign function here).
 */
import { and, asc, desc, eq, inArray, isNull, isNotNull, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { company, domainEvent, employment, location } from '../db/schema';
import { assertProfileValueAllowed } from './profile-options';
import { validateStateFor } from './state-vocabulary';

// ADR-0086 (item 0fe1ca2e, r331) — `resolveHolidayGroupId` lived here. It validated the holiday CALENDAR
// a location was mapped to (ADR-0067 §(b)) before storing it, so a stale or cross-tenant id could not
// reach `location.holiday_group_id`. Migration 0484 drops that column: a work site is no longer one of the
// ways a holiday calendar is chosen, and `employment.holiday_group_id` — validated by
// `setEmploymentHolidayCalendar` (core/org.ts) — is the surviving door.

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
/**
 * The holiday-state override. Null = inherit work_state/default/national. Validated so a garbage value
 * can't silently disable holiday matching.
 *
 * ADR-0077 slice 6 — this used the UNION across every registered pack, with a comment saying per-company
 * narrowing was a later slice. It now narrows to the OWNING COMPANY's country, which is the country the
 * holiday engine actually resolves against (`location.country` is display-only — see cleanCountry).
 * See core/state-vocabulary.ts for why the company's country and not the location's, and for the live
 * production row that distinction protects.
 */
function cleanState(v: string | null | undefined, companyCountry: string | null | undefined): string | null {
  return validateStateFor(v, [companyCountry]);
}

/**
 * 1fff489c — the Branch this location serves, validated against the SAME catalogue employment.org_branch
 * is validated against: profile_option category 'branch', with the same legacy-value tolerance and the
 * same empty-catalogue free-text fallback (see assertProfileValueAllowed). One vocabulary, one rule — a
 * second validator here would be the thing that eventually lets a branch be mapped to a location under a
 * spelling the Employment tab will not accept, and then the resolver silently matches nobody.
 *
 * Null/blank clears the mapping. Runs inside the caller's tx so it shares the RLS session.
 */
async function cleanBranch(tx: Tx, v: string | null | undefined, legacy: string | null): Promise<string | null> {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  await assertProfileValueAllowed(tx, 'branch', s, legacy);
  return s;
}

// ── 1fff489c — duplicate saves are a USER MISTAKE, not a crash ────────────────────────────────────────
//
// `location` carries TWO partial unique indexes — location_code_uq (tenant, code) and location_branch_uq
// (tenant, company, branch), both WHERE archived_at IS NULL. Until this block, tripping either one let the
// raw driver error out to app/admin/_redirects.ts `fail()`, which puts `(e as Error).message` straight in
// the ?error= banner — and drizzle's message is "Failed query: update "location" set "code" = $1, …
// params: TWO,Two,MY,,BUKIT JALIL,…". SQL and parameter VALUES, shown to an HR admin.
//
// The data was never at risk (the index does its job and the transaction rolls back); the banner was. The
// Branch dropdown makes it far likelier to be hit — nine companies picking from a two-value catalogue —
// so both constraints are now mapped to a typed error the action layer localises.
//
// SHAPE COPIED FROM core/roster.ts shiftUniqueError: sniff 23505 down the cause chain, then discriminate
// on the CONSTRAINT NAME (drizzle keeps the driver error as `cause`, whose message names the index) rather
// than on which field the caller happened to change.

/** 23505 anywhere in the cause chain. Same walk as roster.ts / payroll-policy.ts / admin.ts. */
function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

/**
 * A live location in this company already maps this branch. `conflictCode` is the CODE of that location
 * when it could be resolved (a second read — see branchConflictCode), null when it could not.
 */
export class LocationBranchTakenError extends Error {
  constructor(
    public readonly branch: string,
    public readonly conflictCode: string | null,
  ) {
    super('location-branch-taken');
    this.name = 'LocationBranchTakenError';
  }
}

/** A live location in this TENANT already uses this code (location_code_uq is tenant-wide, not per company). */
export class LocationCodeTakenError extends Error {
  constructor(public readonly code: string) {
    super('location-code-taken');
    this.name = 'LocationCodeTakenError';
  }
}

/** Map a unique-index violation to the typed error for its constraint; pass anything else through. */
function locationUniqueError(e: unknown, n: { code: string; branch: string | null }): unknown {
  if (!isUniqueViolation(e)) return e;
  let msg = '';
  let cur = e as { message?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    msg += cur.message ?? '';
    cur = cur.cause as { message?: string; cause?: unknown } | null | undefined;
  }
  if (n.branch && /location_branch_uq/i.test(msg)) return new LocationBranchTakenError(n.branch, null);
  if (/location_code_uq/i.test(msg)) return new LocationCodeTakenError(n.code);
  // Unreachable while those two are the only unique indexes on the table; kept for the same reason
  // shiftUniqueError keeps its fallback — a third index must not re-open the raw-SQL banner.
  return new Error('A location with this code or branch already exists.');
}

/**
 * The CODE of the live location that already claims `branch`, so the message can name it.
 *
 * A SECOND transaction, deliberately: the one that hit the 23505 is aborted, and every further statement
 * on it would fail with "current transaction is aborted". Called only on the failure path, so the happy
 * path costs nothing. Returns null if the holder cannot be read (a race that archived it in between, or
 * RLS) — the caller then falls back to the wording that names only the branch.
 */
function branchConflictCode(
  ctx: SessionContext,
  branch: string,
  scope: { companyId: string } | { locationId: string },
): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    let companyId: string | null = null;
    let excludeId: string | null = null;
    if ('companyId' in scope) {
      companyId = scope.companyId;
    } else {
      // An UPDATE clashes with some OTHER row in its own company — resolve both from the id being saved.
      excludeId = scope.locationId;
      const [self] = await tx
        .select({ companyId: location.companyId })
        .from(location)
        .where(eq(location.id, scope.locationId))
        .limit(1);
      companyId = self?.companyId ?? null;
    }
    if (!companyId) return null;
    const conds = [eq(location.companyId, companyId), eq(location.branch, branch), isNull(location.archivedAt)];
    if (excludeId) conds.push(ne(location.id, excludeId));
    const [row] = await tx.select({ code: location.code }).from(location).where(and(...conds)).limit(1);
    return row?.code ?? null;
  });
}

/** Re-throwable: fill in the conflicting location's code on a branch clash, leave everything else alone. */
async function withBranchConflictCode(
  ctx: SessionContext,
  e: unknown,
  scope: { companyId: string } | { locationId: string },
): Promise<unknown> {
  if (!(e instanceof LocationBranchTakenError) || e.conflictCode) return e;
  // THE RECOVERY READ MUST NEVER REPLACE THE TYPED ERROR. It runs on the failure path, in a SECOND
  // transaction (the first is aborted by the 23505), so it can fail for reasons of its own — a dropped
  // connection, a statement timeout, the row archived between the two reads. If it throws and we let
  // that propagate, the caller's `fail()` renders THAT raw drizzle message in the admin banner, which
  // is precisely the defect this whole path exists to close. Losing the conflicting code costs the
  // reader one detail; losing the typed error costs them the SQL.
  let code: string | null = null;
  try {
    code = await branchConflictCode(ctx, e.branch, scope);
  } catch {
    return e; // typed, without the code — branchTakenNoCode covers the wording
  }
  return code ? new LocationBranchTakenError(e.branch, code) : e;
}

/** The owning company's country — the vocabulary the state above is judged against. */
async function companyCountryOf(tx: Tx, companyId: string): Promise<string | null> {
  const [row] = await tx.select({ country: company.country }).from(company).where(eq(company.id, companyId)).limit(1);
  if (!row) throw new Error('Company not found');
  return row.country;
}

export type CreateLocationInput = {
  companyId: string;
  code: string;
  name: string;
  country?: string;
  state?: string | null;
  // ADR-0067: the named holiday CALENDAR (holiday_group) every employee at this location follows. Null =
  // unmapped → today's resolution (state override → company default → national), byte-identical.
  // 1fff489c — the Branch (profile_option 'branch') this location serves. Null = not mapped yet.
  branch?: string | null;
};

export async function createLocation(ctx: SessionContext, p: CreateLocationInput) {
  const code = cleanCode(p.code);
  const name = cleanName(p.name);
  const country = cleanCountry(p.country);
  try {
    return await withTenant(ctx, async (tx) => {
      // Inside the transaction: the state is judged against the OWNING COMPANY's country, which has to be
      // read first. RLS scopes that read to this tenant, so a companyId from another tenant fails here
      // rather than validating against a company the caller cannot see.
      const state = cleanState(p.state, await companyCountryOf(tx, p.companyId));
      // No legacy value on a create — an out-of-catalogue branch is refused outright.
      const branch = await cleanBranch(tx, p.branch, null);
      let row: { id: string };
      try {
        [row] = await tx
          .insert(location)
          .values({ tenantId: ctx.tenantId, companyId: p.companyId, code, name, country, state, branch })
          .returning({ id: location.id });
      } catch (e) {
        // 1fff489c — a duplicate code or branch leaves as a typed error, never as raw SQL + parameters.
        throw locationUniqueError(e, { code, branch });
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'location',
        aggregateId: row.id,
        eventType: 'location.created',
        actor: actorOf(ctx),
        payload: { companyId: p.companyId, code, name, country, state, branch },
      });
      return { id: row.id };
    });
  } catch (e) {
    // The aborted transaction cannot answer "which location holds it?" — a fresh one can.
    throw await withBranchConflictCode(ctx, e, { companyId: p.companyId });
  }
}

export type UpdateLocationInput = {
  locationId: string;
  code: string;
  name: string;
  country?: string;
  state?: string | null;
  branch?: string | null;
};

export async function updateLocation(ctx: SessionContext, p: UpdateLocationInput) {
  const code = cleanCode(p.code);
  const name = cleanName(p.name);
  const country = cleanCountry(p.country);
  try {
    return await withTenant(ctx, async (tx) => {
      const [before] = await tx
        .select({
          code: location.code,
          name: location.name,
          country: location.country,
          state: location.state,
          branch: location.branch,
          // Selected for validation, NOT echoed into the event payload below — `before` is the audit
          // record of what the user changed, and companyId is not one of the editable fields.
          companyId: location.companyId,
        })
        .from(location)
        .where(eq(location.id, p.locationId))
        .limit(1);
      if (!before) throw new Error('Location not found');
      const { companyId, ...beforeAudit } = before;
      const state = cleanState(p.state, await companyCountryOf(tx, companyId));
      // Legacy-value tolerance: re-saving a location whose branch was recorded before the catalogue tightened
      // must never fail on the value it already had — the same rule setEmploymentInfo applies to org_branch.
      const branch = await cleanBranch(tx, p.branch, before.branch);
      try {
        await tx
          .update(location)
          .set({ code, name, country, state, branch })
          .where(eq(location.id, p.locationId));
      } catch (e) {
        // 1fff489c — mapping a branch another live location already holds is the likeliest way to reach
        // here (nine companies, a two-value catalogue). It leaves as a typed error, never as raw SQL.
        throw locationUniqueError(e, { code, branch });
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'location',
        aggregateId: p.locationId,
        eventType: 'location.updated',
        actor: actorOf(ctx),
        payload: { before: beforeAudit, after: { code, name, country, state, branch } },
      });
      return { id: p.locationId };
    });
  } catch (e) {
    throw await withBranchConflictCode(ctx, e, { locationId: p.locationId });
  }
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
  // 1fff489c — the mapped Branch (null = not mapped yet, one of the four distinct empty states).
  branch: string | null;
  archivedAt: Date | null;
  headcount: number;
};

/** Locations in scope, joined with company name + active headcount (open assignment rows pointing here) +
 *  RLS already scopes rows to admin-of-company; companyIds further narrows to the UI's active scope.
 *  ADR-0086: the mapped holiday calendar's name/archetype used to come back here too, via a left join on
 *  `location.holiday_group_id`. That column is gone (migration 0484); a calendar is chosen on the person. */
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
        branch: location.branch,
        archivedAt: location.archivedAt,
        headcount: sql<number>`(
          select count(*)::int from assignment a
          where a.location_id = ${location.id}
            and a.valid_to is null and a.superseded_at is null
        )`,
      })
      .from(location)
      .innerJoin(company, eq(company.id, location.companyId))
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

// ── 1fff489c PHASE 2: Branch-driven location assignment ──────────────────────────────────────────────

/** The location a branch resolves to, as the Attendance tab's SUGGESTION needs it. */
export type ResolvedBranchLocation = { id: string; code: string; name: string; branch: string };

/**
 * The non-archived location in THIS COMPANY whose branch equals the given value, or null.
 *
 * SCOPE IS THE POINT. `profile_option` (where branch values live) is tenant-wide, but `location` is
 * company-scoped, so "BUKIT JALIL" is one catalogue entry that nine companies may each map to a location
 * of their own. Resolving tenant-wide would hand an ISEDECOR employee a Chin Hin location. The company
 * always comes from the employment, never from the caller's form.
 *
 * Archived locations are excluded here, not filtered by the caller: an archived location is out of every
 * assignment dropdown by design, and a suggestion the admin cannot then select is worse than no
 * suggestion. Comparison is exact — cleanBranch stores the catalogue's own text on both sides.
 */
export function resolveLocationForBranch(
  ctx: SessionContext,
  companyId: string,
  branch: string | null | undefined,
): Promise<ResolvedBranchLocation | null> {
  const b = (branch ?? '').replace(/\s+/g, ' ').trim();
  if (!b) return Promise.resolve(null);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: location.id, code: location.code, name: location.name, branch: location.branch })
      .from(location)
      .where(
        and(
          eq(location.companyId, companyId),
          eq(location.branch, b),
          isNull(location.archivedAt),
        ),
      )
      .limit(1);
    return row?.branch ? { id: row.id, code: row.code, name: row.name, branch: row.branch } : null;
  });
}

/** One branch in use by live employees that no live location claims, plus how many people it affects. */
export type UnmappedBranch = { companyId: string; branch: string; headcount: number };

/**
 * Every branch that live employees in these companies actually carry but which has NO live location
 * mapped to it — the admin screen's "fix it once instead of chasing it person by person" count.
 *
 * Grouped BY COMPANY for the same reason resolveLocationForBranch is scoped by company: BUKIT JALIL can
 * be mapped in one company and unmapped in the next, and reporting it tenant-wide would either hide a
 * real gap or invent one. Terminated employments are excluded — a branch nobody works at any more is not
 * a configuration gap.
 */
export function listUnmappedBranches(ctx: SessionContext, companyIds: string[]): Promise<UnmappedBranch[]> {
  if (!companyIds.length) return Promise.resolve([]);
  return withTenant(ctx, (tx) =>
    tx
      .select({
        companyId: employment.companyId,
        branch: sql<string>`${employment.orgBranch}`,
        headcount: sql<number>`count(*)::int`,
      })
      .from(employment)
      .where(
        and(
          inArray(employment.companyId, companyIds),
          isNotNull(employment.orgBranch),
          sql`btrim(${employment.orgBranch}) <> ''`,
          isNull(employment.terminatedOn),
          sql`not exists (
            select 1 from location l
            where l.company_id = ${employment.companyId}
              and l.branch = ${employment.orgBranch}
              and l.archived_at is null
          )`,
        ),
      )
      .groupBy(employment.companyId, employment.orgBranch)
      .orderBy(asc(employment.companyId), asc(employment.orgBranch)),
  );
}

/** How an employee's work location came to be what it is. Recorded on the event stream, not on a column. */
export type LocationSource = 'branch_derived' | 'manual';

/**
 * 1fff489c step 9 — stamp the PROVENANCE of a work-location change.
 *
 * The location itself is written by the effective-dated movement path (setLocationAction →
 * createMovementEvent → setEmploymentAssignment), which is shared by half a dozen callers and deliberately
 * knows nothing about branches. Rather than thread a provenance flag through that writer — and change the
 * meaning of `employment.assignment.changed` for every one of them — this appends a small companion event
 * carrying only the answer to "who decided this": the admin, or the branch mapping.
 *
 * No new column, per the plan: the event stream already carries it and core/read.ts can project the split
 * whenever a report wants it. Called AFTER the movement succeeds, so a rejected movement leaves no claim
 * about a change that never happened.
 */
export function recordLocationSource(
  ctx: SessionContext,
  p: { employmentId: string; locationId: string | null; effectiveDate: string; source: LocationSource },
) {
  return withTenant(ctx, async (tx) => {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.location.changed',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        employmentId: p.employmentId,
        locationId: p.locationId,
        effectiveDate: p.effectiveDate,
        source: p.source,
      },
    });
    return { employmentId: p.employmentId, source: p.source };
  });
}

/**
 * The date the employee's Branch last changed, as a YYYY-MM-DD string, or null if it never has.
 *
 * Read straight off the ledger rather than through movementHistory: the branch lives on
 * employment.org_branch, a FLAT (non-effective-dated) column whose before/after only exists inside the
 * `employment.info.updated` payload — movementHistory's row summary does not carry it, and reconstructing
 * it would mean a movementDetail call per row. This is the one query that answers the question.
 *
 * A branch change made through the Movement comparison form carries the movement's own effective date in
 * the payload; a plain Employment-tab save does not (flat columns apply immediately), so the event's own
 * occurrence date in Kuala Lumpur is the honest answer there. Used ONLY to pre-fill the suggestion's
 * effective date — the admin can always overtype it, and nothing commits without Confirm.
 */
export function branchChangeDateFor(ctx: SessionContext, employmentId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        effectiveDate: sql<string>`coalesce(
          ${domainEvent.payload}->>'effectiveDate',
          to_char((${domainEvent.occurredAt} at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD')
        )`,
      })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.subjectEmploymentId, employmentId),
          eq(domainEvent.eventType, 'employment.info.updated'),
          sql`${domainEvent.payload}->'before'->>'orgBranch' is distinct from ${domainEvent.payload}->'after'->>'orgBranch'`,
        ),
      )
      .orderBy(desc(domainEvent.sequence))
      .limit(1);
    return row?.effectiveDate ?? null;
  });
}
