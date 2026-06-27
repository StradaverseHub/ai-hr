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
import type { Tx } from '../db/client';
import { assignment, company, employment, holiday, holidayGroup, location } from '../db/schema';

export type HolidayWindow = { employmentId: string; startDate: string; endDate: string };

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
