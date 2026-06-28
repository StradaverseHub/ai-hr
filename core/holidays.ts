/**
 * Unified public-holiday resolver (ADR-0055 — org-based override over ADR-0038 2C).
 *
 * `holidayDatesFor` returns the set of holiday DATES (YYYY-MM-DD) that apply to an employment in
 * [start, end]. Resolution is single-winner replacement with this precedence:
 *
 *   business-group (company subtree) → state → national
 *
 * Concretely:
 *   1. If ANY company-scoped holiday row matches the employee's company CHAIN in the window, those rows
 *      ARE the calendar (the group override wins — the literal feedback logic). The chain is the upward
 *      ancestor walk: a parent-group calendar set on a parent company cascades to its child companies /
 *      factories / business units. We use the SECURITY DEFINER helper `app.is_company_descendant(child,
 *      ancestor)` (granted to ai_hr_app in migration 0015) — true when the holiday's company is the
 *      employee's company or an ancestor of it. It must be used instead of walking `company` in app SQL,
 *      which company-context RLS could truncate, silently shortening the chain.
 *   2. Otherwise fall back to today's 2C behaviour: national ∪ effState, resolved in priority order
 *      location.state → work_state → company.default_work_state → national-only. Holiday groups expand to
 *      their member states and feed the same UNION predicate.
 *
 * Country semantics (ADR-0055, deliberate change from the old country-blind leave query): the resolver
 * filters by the employee's COMPANY country in both branches, matching the attendance engine and the
 * correct multi-country intent (a SG-company employee's leave no longer subtracts MY national holidays).
 */
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { assignment, company, employment, holiday, holidayGroup, location } from '../db/schema';

export type HolidayWindow = { employmentId: string; startDate: string; endDate: string };

// ── Holiday completeness guard (Phase-B #15) ────────────────────────────────────────────────────────
// EA 1955 s.60D entitles every employee to at least ELEVEN gazetted public holidays a year (5 named +
// any 6 more the employer/state gazettes). If a (state, year) the engine is about to count against has
// fewer than 11 holiday rows loaded, the working-day / rest-day arithmetic is almost certainly wrong —
// a gazetted holiday silently treated as a working day under-counts leave and over-counts payable days.
// This is an operational data-entry prerequisite, not a hard error, so the guard WARNS (domain event +
// a returned warning the screen can surface) but never blocks. The fix is for HR to load the rest of the
// state gazette via the admin Holidays screen.
export const EA_S60D_MINIMUM_HOLIDAYS = 11;

/** A holiday-completeness warning for a (country, state, year) that has fewer than the s.60D minimum of
 *  11 gazetted public holidays loaded. `state` null = the national-only set (no state resolved). */
export type HolidayCompletenessWarning = {
  country: string;
  state: string | null;
  year: number;
  loaded: number;
  required: number;
};

/**
 * Count the gazetted public holidays LOADED for a (country, state, year) — the set the working-day
 * counter would actually apply: national rows (state null) ∪ the given state's rows. A null `state`
 * counts the national-only set (an employment that resolves to no state). Company-scoped (business-group
 * override) rows are excluded — this guard is about the public gazette, not a per-company override
 * calendar. Pure read; no event.
 */
export async function loadedHolidayCount(
  tx: Tx,
  country: string,
  state: string | null,
  year: number,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(holiday)
    .where(
      and(
        eq(holiday.country, country),
        isNull(holiday.companyId), // public gazette only — not a company-subtree override calendar
        sql`extract(year from ${holiday.holidayDate}) = ${year}`,
        state ? or(isNull(holiday.state), eq(holiday.state, state)) : isNull(holiday.state),
      ),
    );
  return row?.n ?? 0;
}

/** Pure threshold check: a warning when `loaded` is below the s.60D minimum, else null. Unit-testable. */
export function holidayCompletenessWarning(
  country: string,
  state: string | null,
  year: number,
  loaded: number,
): HolidayCompletenessWarning | null {
  if (loaded >= EA_S60D_MINIMUM_HOLIDAYS) return null;
  return { country, state, year, loaded, required: EA_S60D_MINIMUM_HOLIDAYS };
}

/** Distinct calendar years a [start, end] window spans (handles a window crossing a year boundary). */
export function yearsSpanned(startDate: string, endDate: string): number[] {
  const sy = Number(startDate.slice(0, 4));
  const ey = Number(endDate.slice(0, 4));
  const out: number[] = [];
  for (let y = sy; y <= ey; y++) out.push(y);
  return out;
}

/**
 * Resolve the SINGLE effective holiday-state for an employment — the same precedence the resolver uses
 * (location.state → holiday-group first state → work_state → company.default_work_state → national),
 * collapsed to one label for the completeness guard. Returns { country, state } with state null when the
 * employment resolves to national-only. A holiday group is summarised by its first state (the guard's job
 * is to flag an under-loaded gazette, not to fan out across every group member).
 */
export async function effectiveHolidayState(
  tx: Tx,
  employmentId: string,
): Promise<{ country: string; state: string | null } | null> {
  const [emp] = await tx
    .select({
      country: company.country,
      ws: employment.workState,
      cds: company.defaultWorkState,
      groupStates: holidayGroup.states,
      locationState: location.state,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
    .leftJoin(
      assignment,
      and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
    )
    .leftJoin(location, eq(location.id, assignment.locationId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return null;
  const groupFirst = Array.isArray(emp.groupStates) ? (emp.groupStates as string[])[0] : undefined;
  const state = emp.locationState ?? groupFirst ?? emp.ws ?? emp.cds ?? null;
  return { country: emp.country, state };
}

/**
 * The high-value safety net (Phase-B #15 Part A). For each (state, year) the given window spans, check
 * whether the loaded gazette meets the s.60D minimum; if not, append a NON-BLOCKING warning domain event
 * and return the warning(s). Callers (leave, payroll) surface the returned warning on-screen and proceed.
 * `module` / `aggregateId` / `subjectEmploymentId` thread the event onto the originating aggregate so the
 * audit trail / substrate sees a real warning, not a silent gap.
 */
export async function warnIfHolidaysIncomplete(
  tx: Tx,
  ctx: SessionContext,
  args: {
    country: string;
    state: string | null;
    years: number[];
    module: string;
    aggregateType: string;
    aggregateId: string;
    subjectEmploymentId?: string | null;
    context?: Record<string, unknown>;
  },
): Promise<HolidayCompletenessWarning[]> {
  const warnings: HolidayCompletenessWarning[] = [];
  for (const year of args.years) {
    const loaded = await loadedHolidayCount(tx, args.country, args.state, year);
    const warning = holidayCompletenessWarning(args.country, args.state, year, loaded);
    if (!warning) continue;
    warnings.push(warning);
    // NON-BLOCKING: the gazetted-holiday count is below the s.60D minimum for this (state, year). Loud,
    // not fatal — the leave/payroll write still commits; HR must finish loading the state gazette.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: args.aggregateType,
      aggregateId: args.aggregateId,
      eventType: 'holiday.completeness.warned',
      actor: actorOf(ctx),
      subjectEmploymentId: args.subjectEmploymentId ?? null,
      payload: {
        module: args.module,
        country: warning.country,
        state: warning.state,
        year: warning.year,
        loaded: warning.loaded,
        required: warning.required,
        ...(args.context ?? {}),
      },
    });
  }
  return warnings;
}

/** The set of holiday dates in [startDate, endDate] for an employment, resolved business-group → state →
 *  national. Returns a Set<string> of YYYY-MM-DD dates (both callers ask only "is this date a holiday?"). */
export async function holidayDatesFor(tx: Tx, { employmentId, startDate, endDate }: HolidayWindow): Promise<Set<string>> {
  const [emp] = await tx
    .select({
      companyId: employment.companyId,
      country: company.country,
      ws: employment.workState,
      cds: company.defaultWorkState,
      groupStates: holidayGroup.states,
      // ADR-0054: location.state overlay from the employee's OPEN assignment row — the top of the
      // precedence so leave matches attendance (which resolves the same order in core/attendance.ts).
      locationState: location.state,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
    .leftJoin(
      assignment,
      and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
    )
    .leftJoin(location, eq(location.id, assignment.locationId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return new Set<string>();

  // Step 1 — business-group override: any company-scoped row in the window matching the company chain
  // (upward ancestor walk via the SECURITY DEFINER helper). If present, it is the WHOLE calendar.
  const groupRows = await tx
    .select({ d: holiday.holidayDate })
    .from(holiday)
    .where(
      and(
        gte(holiday.holidayDate, startDate),
        lte(holiday.holidayDate, endDate),
        eq(holiday.country, emp.country),
        sql`${holiday.companyId} IS NOT NULL`,
        sql`app.is_company_descendant(${emp.companyId}, ${holiday.companyId})`,
      ),
    );
  if (groupRows.length > 0) return new Set(groupRows.map((h) => h.d));

  // Step 2 — 2C fallback: national ∪ effState (location.state → work_state → company default → national).
  const states: string[] = emp.locationState
    ? [emp.locationState]
    : emp.groupStates
      ? (emp.groupStates as string[])
      : emp.ws
        ? [emp.ws]
        : emp.cds
          ? [emp.cds]
          : [];
  const baseRows = await tx
    .select({ d: holiday.holidayDate })
    .from(holiday)
    .where(
      and(
        gte(holiday.holidayDate, startDate),
        lte(holiday.holidayDate, endDate),
        eq(holiday.country, emp.country),
        isNull(holiday.companyId),
        states.length ? or(isNull(holiday.state), inArray(holiday.state, states)) : isNull(holiday.state),
      ),
    );
  return new Set(baseRows.map((h) => h.d));
}
