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
 *
 * ── ADR-0067 — named PH calendars by location (a THIN layer over the above) ──
 * A location can be MAPPED to a named holiday_group whose `archetype` makes it a CALENDAR. When the
 * employee's OPEN assignment points at a mapped location, the resolver applies the archetype:
 *
 *   location.holiday_group_id present?
 *     ├─ custom   → ONLY the location-calendar's company-scoped ad-hoc rows (NO gazette). A national date
 *     │             the custom calendar omits is a normal working day for that location's staff.
 *     ├─ extended → ad-hoc rows ∪ gazette(national ∪ calendar.states)
 *     └─ standard → fall through (no distinct branch) — the calendar.states[] just feed the Step-2 gazette.
 *   absent (NULL) → existing path, BYTE-IDENTICAL to today (Step 1 business-group → Step 2 state precedence).
 *
 * Conflict rule (location has BOTH `state` and a mapped calendar): the CALENDAR's states[] are the gazette
 * source and location.state is ignored for that location's staff — the named calendar is the explicit
 * override. effectiveHolidayState agrees, so attendance and the s.60D guard never disagree.
 *
 * Frozen-attendance caveat (accepted decision, NOT a silent gap): attendance day-type rows are FROZEN at
 * check-in (core/attendance.ts) and drive the 1.5x/3.0x OT class = money. Changing a location's calendar
 * reclassifies only FRESH dates resolved through this function; already-frozen historical rows are accepted
 * as historical and are NOT retroactively re-classified. No re-freeze job is built (out of scope). If a
 * recompute is ever wanted, that is a separate task.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
// 0e276da0 — the calendar-coverage read at the foot of this file is SESSION-scoped (a screen asks it),
// unlike every resolver above, which runs inside the caller's tx. `withTenant` is the only addition.
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { todayInKualaLumpur } from '../lib/hr-date';
import { appendEvent, actorOf } from '../db/events';
import { assignment, company, employment, holiday, holidayGroup, holidayGroupHoliday, location } from '../db/schema';

// ADR-0067 — the LOCATION's named holiday calendar is a holiday_group row joined a SECOND time (the first
// holidayGroup join is the per-employee assigned group, ADR-0040). Aliased so the two joins don't collide.
const locationCalendar = alias(holidayGroup, 'location_calendar');
// R18 a519a96e — group INHERITANCE: each of the two group joins above may point at a PARENT group
// (holiday_group.parent_group_id, single level). The parent is joined LIVE (strictly 1:1 — parent_group_id
// → PK) so parent edits propagate instantly with no sync. When a parent exists it supplies the gazette
// source (archetype + states); the child contributes only its own group-scoped extra days.
const locationCalendarParent = alias(holidayGroup, 'location_calendar_parent');
const empGroupParent = alias(holidayGroup, 'emp_group_parent');

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
        isNull(holiday.holidayGroupId), // …nor a group-scoped extra day (R18 a519a96e)
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
 *
 * ADR-0067 — archetype awareness (the high-severity double-path fix). This function feeds the s.60D
 * completeness guard (core/leave.ts), a DIFFERENT code path from holidayDatesFor. When the employee's OPEN
 * assignment maps to a location whose calendar is archetype 'custom', the gazette is deliberately ignored
 * (custom = exactly what HR loaded), so the "gazette < 11" warning is FALSE NOISE: return skipCompleteness
 * so the caller emits no warning. For 'standard'/'extended' the gazette still applies and the warning is
 * still meaningful — and per §3 the location-CALENDAR's group.states[] is the gazette source (it wins over
 * a bare location.state) so attendance and the guard agree.
 */
export async function effectiveHolidayState(
  tx: Tx,
  employmentId: string,
): Promise<{ country: string; state: string | null; skipCompleteness?: boolean } | null> {
  const [emp] = await tx
    .select({
      country: company.country,
      ws: employment.workState,
      cds: company.defaultWorkState,
      groupStates: holidayGroup.states,
      // ADR-0067 (direct-assign): the per-employee assigned group's archetype, so the s.60D guard mirrors
      // holidayDatesFor for a custom/extended group assigned DIRECTLY on the profile. Reuses the holidayGroup
      // join already present at line 157.
      empGroupArchetype: holidayGroup.archetype,
      // R18 a519a96e: the assigned group's PARENT (single level). When set, the PARENT's archetype/states
      // are the gazette source — keeps this guard in agreement with holidayDatesFor's inheritance.
      empGroupParentId: holidayGroup.parentGroupId,
      empGroupParentArchetype: empGroupParent.archetype,
      empGroupParentStates: empGroupParent.states,
      locationState: location.state,
      // ADR-0067: the location-CALENDAR (mapped on the open assignment's location), its archetype + states.
      calArchetype: locationCalendar.archetype,
      calStates: locationCalendar.states,
      // R18 a519a96e: the location calendar's PARENT (single level), same substitution rule as above.
      calParentId: locationCalendar.parentGroupId,
      calParentArchetype: locationCalendarParent.archetype,
      calParentStates: locationCalendarParent.states,
      mappedCalendar: location.holidayGroupId,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
    .leftJoin(empGroupParent, eq(empGroupParent.id, holidayGroup.parentGroupId))
    .leftJoin(
      assignment,
      and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
    )
    .leftJoin(location, eq(location.id, assignment.locationId))
    .leftJoin(locationCalendar, eq(locationCalendar.id, location.holidayGroupId))
    .leftJoin(locationCalendarParent, eq(locationCalendarParent.id, locationCalendar.parentGroupId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return null;
  // R18 a519a96e — inheritance substitution: with a parent set, the parent's archetype + states ARE the
  // gazette source for the child (the child only adds group-scoped extras, which never affect this guard).
  // Parentless groups keep their own values, so every existing path is unchanged.
  const effCalArchetype = emp.calParentId ? emp.calParentArchetype : emp.calArchetype;
  const effCalStates = emp.calParentId ? emp.calParentStates : emp.calStates;
  const effEmpGroupArchetype = emp.empGroupParentId ? emp.empGroupParentArchetype : emp.empGroupArchetype;
  const effEmpGroupStates = emp.empGroupParentId ? emp.empGroupParentStates : emp.groupStates;
  // A mapped Custom calendar is hand-managed and ignores the gazette → suppress the s.60D warning.
  if (effCalArchetype === 'custom') return { country: emp.country, state: null, skipCompleteness: true };
  // ADR-0067 (direct-assign): a Custom group assigned DIRECTLY on the profile (no location calendar mapped)
  // is likewise hand-managed and ignores the gazette in holidayDatesFor — so the "gazette < 11" warning would
  // be false noise. Suppress it to keep effectiveHolidayState and holidayDatesFor in agreement. Extended is
  // deliberately NOT suppressed here: an extended group still includes the gazette, so the warning stays
  // meaningful (matching how the location 'extended' path is treated).
  if (!emp.mappedCalendar && effEmpGroupArchetype === 'custom')
    return { country: emp.country, state: null, skipCompleteness: true };
  // Standard/Extended: the location-calendar's own states[] are the gazette source (they win over a bare
  // location.state, §3). Fall back to today's precedence when no calendar is mapped.
  const calFirst = Array.isArray(effCalStates) ? (effCalStates as string[])[0] : undefined;
  const groupFirst = Array.isArray(effEmpGroupStates) ? (effEmpGroupStates as string[])[0] : undefined;
  const state = calFirst ?? emp.locationState ?? groupFirst ?? emp.ws ?? emp.cds ?? null;
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
 *  national. Returns a Set<string> of YYYY-MM-DD dates (both callers ask only "is this date a holiday?").
 *
 *  DETERMINING INPUTS, MIRRORED IN TWO MEMO KEYS. From the employment side this reads exactly four values:
 *  employment.company_id, employment.work_state, employment.holiday_group_id, and the OPEN assignment's
 *  location_id (plus how many open assignments there are, because it takes one via `.limit(1)`). Two memos
 *  key on precisely those — `holidayDatesByEmployment` below and `holidayKeyOf` in core/absence-days.ts —
 *  and hand every employment sharing them the same answer. Reading a new employment- or assignment-level
 *  input here without adding it to BOTH keys silently gives one employee another's calendar. */
export async function holidayDatesFor(tx: Tx, { employmentId, startDate, endDate }: HolidayWindow): Promise<Set<string>> {
  const [emp] = await tx
    .select({
      companyId: employment.companyId,
      country: company.country,
      ws: employment.workState,
      cds: company.defaultWorkState,
      groupStates: holidayGroup.states,
      // ADR-0067 (direct-assign): the per-employee assigned group's archetype. When a custom/extended group
      // is assigned DIRECTLY on the profile (employment.holidayGroupId) rather than via a location mapping,
      // this lets the resolver honour the hand-picked / extended semantic instead of degrading to a plain
      // state UNION. Reuses the existing holidayGroup join at line 250 — one extra 1:1 column, .limit(1)-safe.
      empGroupArchetype: holidayGroup.archetype,
      empHolidayGroupId: employment.holidayGroupId,
      // R18 a519a96e: the assigned group's PARENT (single level, strictly 1:1 self-join). When set, the
      // parent supplies the gazette source (archetype + states); the child adds only group-scoped extras.
      empGroupParentId: holidayGroup.parentGroupId,
      empGroupParentArchetype: empGroupParent.archetype,
      empGroupParentStates: empGroupParent.states,
      // ADR-0054: location.state overlay from the employee's OPEN assignment row — the top of the
      // precedence so leave matches attendance (which resolves the same order in core/attendance.ts).
      locationState: location.state,
      // ADR-0067: the location's named CALENDAR (mapped on the open assignment's location) + its archetype
      // and states. The join chain employment → assignment(open) → location → holiday_group is strictly 1:1
      // (the open-assignment predicate is single-row, location.id and holiday_group.id are PKs), so it does
      // NOT fan out the .limit(1) employment select.
      calArchetype: locationCalendar.archetype,
      calStates: locationCalendar.states,
      // R18 a519a96e: the location calendar's PARENT (single level, strictly 1:1 self-join).
      calParentId: locationCalendar.parentGroupId,
      calParentArchetype: locationCalendarParent.archetype,
      calParentStates: locationCalendarParent.states,
      mappedCalendar: location.holidayGroupId,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
    .leftJoin(empGroupParent, eq(empGroupParent.id, holidayGroup.parentGroupId))
    .leftJoin(
      assignment,
      and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
    )
    .leftJoin(location, eq(location.id, assignment.locationId))
    .leftJoin(locationCalendar, eq(locationCalendar.id, location.holidayGroupId))
    .leftJoin(locationCalendarParent, eq(locationCalendarParent.id, locationCalendar.parentGroupId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return new Set<string>();

  // ── R18 a519a96e — group INHERITANCE + group-scoped "additional days" ─────────────────────────────
  // Effective substitution: when the ACTIVE group (location calendar or directly-assigned group) has a
  // PARENT, the parent's archetype + states[] become the gazette source. Parentless groups keep their own
  // values, so every predicate below is byte-identical to before for existing data (all parents NULL).
  const effCalArchetype = emp.calParentId ? emp.calParentArchetype : emp.calArchetype;
  const effCalStates = emp.calParentId ? emp.calParentStates : emp.calStates;
  const effEmpGroupArchetype = emp.empGroupParentId ? emp.empGroupParentArchetype : emp.empGroupArchetype;
  const effEmpGroupStates = emp.empGroupParentId ? emp.empGroupParentStates : emp.groupStates;
  // The active calendar CHAIN (group + its parent) contributes group-scoped extra rows. Extras are
  // ADDITIVE to every resolution path below — never replacement — so a per-office "Company Family Day"
  // stacks on top of whatever calendar the office resolves to, and a parent's extra day reaches every
  // child location instantly (resolve-at-read; nothing is copied). Location calendar wins over the
  // directly-assigned group, mirroring the archetype precedence.
  const chainIds: string[] = emp.mappedCalendar
    ? [emp.mappedCalendar, ...(emp.calParentId ? [emp.calParentId] : [])]
    : emp.empHolidayGroupId
      ? [emp.empHolidayGroupId, ...(emp.empGroupParentId ? [emp.empGroupParentId] : [])]
      : [];
  const chainExtras: string[] = chainIds.length
    ? (
        await tx
          .select({ d: holiday.holidayDate })
          .from(holiday)
          .where(
            and(
              gte(holiday.holidayDate, startDate),
              lte(holiday.holidayDate, endDate),
              eq(holiday.country, emp.country),
              inArray(holiday.holidayGroupId, chainIds),
            ),
          )
      ).map((h) => h.d)
    : [];

  // ── 66b8f5a8 — explicitly TICKED holidays (holiday_group_holiday junction) ─────────────────────────
  // The reporter's tick-list model, delivered as a UNION (NOT a replacement — a replacement would drop MY
  // state auto-resolution + parent-to-child auto-sync). HR ticks holidays from the centralized master list
  // into a group; here we pull the dates ticked into the active calendar CHAIN (group + its parent) and
  // ADD them to whatever the state/archetype/inheritance resolution below produces. Unlike chainExtras
  // (group-SCOPED "additional day" rows keyed on holiday.holiday_group_id), these reference ANY master
  // holiday (national/state/company/other-group rows) — so a group can pick up, e.g., another state's
  // holiday without owning it. Additive to every return path (empty chain ⇒ no-op, byte-identical).
  const chainTicked: string[] = chainIds.length
    ? (
        await tx
          .select({ d: holiday.holidayDate })
          .from(holidayGroupHoliday)
          .innerJoin(holiday, eq(holiday.id, holidayGroupHoliday.holidayId))
          .where(
            and(
              inArray(holidayGroupHoliday.holidayGroupId, chainIds),
              gte(holiday.holidayDate, startDate),
              lte(holiday.holidayDate, endDate),
              eq(holiday.country, emp.country),
            ),
          )
      ).map((h) => h.d)
    : [];
  // Fold the ticked dates into chainExtras so EVERY resolution branch below (which already spreads
  // ...chainExtras into its result Set) unions them without further edits.
  chainExtras.push(...chainTicked);

  // ── ADR-0067 archetype pre-check — runs ONLY when the open assignment's location maps to a CALENDAR.
  // When unmapped (mappedCalendar IS NULL) we fall through to the Step 1 / Step 2 SQL *untouched*, which is
  // what guarantees the "byte-identical when unmapped" regression claim. 'standard' deliberately does NOT
  // branch here either — a standard calendar IS the existing gazette path, just named (its states[] feed
  // Step 2 below), so it falls through too. Only 'custom' and 'extended' need distinct resolution.
  // R18 a519a96e: the EFFECTIVE archetype (the parent's, when the calendar inherits) drives the branch.
  if (emp.mappedCalendar && (effCalArchetype === 'custom' || effCalArchetype === 'extended')) {
    // The company-scoped ad-hoc rows for this employee's company chain in the window (existing Step-1 query).
    const adHocRows = await tx
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
    if (effCalArchetype === 'custom') {
      // CUSTOM = exactly what HR loaded: ONLY the company-scoped ad-hoc rows (∪ the chain's group-scoped
      // extras), no gazette. A national date the custom calendar omits is a normal working day here.
      return new Set([...adHocRows.map((h) => h.d), ...chainExtras]);
    }
    // EXTENDED = official gazette ∪ company ad-hoc. The gazette half is keyed on the CALENDAR's states[]
    // (national ∪ group.states), not location.state (§3: the named calendar is the explicit override).
    const calStates: string[] = Array.isArray(effCalStates) ? (effCalStates as string[]) : [];
    const gazetteRows = await tx
      .select({ d: holiday.holidayDate })
      .from(holiday)
      .where(
        and(
          gte(holiday.holidayDate, startDate),
          lte(holiday.holidayDate, endDate),
          eq(holiday.country, emp.country),
          isNull(holiday.companyId),
          isNull(holiday.holidayGroupId), // group extras are chain-gated, not part of the public gazette
          calStates.length ? or(isNull(holiday.state), inArray(holiday.state, calStates)) : isNull(holiday.state),
        ),
      );
    return new Set([...adHocRows.map((h) => h.d), ...gazetteRows.map((h) => h.d), ...chainExtras]);
  }

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
  // R18 a519a96e: the chain's group-scoped extras stack on top of the override (additive, never replaced).
  if (groupRows.length > 0) return new Set([...groupRows.map((h) => h.d), ...chainExtras]);

  // ── ADR-0067 (direct-assign) — per-employee-group archetype branch. Mirrors the location-calendar
  // pre-check above, but for a custom/extended group assigned DIRECTLY on the profile
  // (employment.holidayGroupId) rather than via a location mapping. Placement is deliberate and documented:
  // it runs AFTER the location-calendar pre-check (a site-level location calendar keeps its higher
  // precedence — a location is a stronger signal than a per-person default) and AFTER the Step-1
  // business-group company override early-return (a company-subtree override still wins), and BEFORE the
  // Step-2 state fallback. It fires ONLY when NO location calendar is mapped (mappedCalendar IS NULL), the
  // Step-1 override produced nothing (groupRows was empty), the employee has a directly-assigned group
  // (empHolidayGroupId set), and that group's archetype is 'custom' or 'extended'. A 'standard' (or unset)
  // group falls through to Step 2 BYTE-IDENTICALLY, preserving the regression guarantee for every existing
  // state-based / default employee.
  if (
    !emp.mappedCalendar &&
    emp.empHolidayGroupId &&
    (effEmpGroupArchetype === 'custom' || effEmpGroupArchetype === 'extended')
  ) {
    // The company-scoped ad-hoc rows for this employee's company chain in the window (same query as Step-1).
    const adHocRows = await tx
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
    if (effEmpGroupArchetype === 'custom') {
      // CUSTOM = exactly the hand-picked list: ONLY the company-scoped ad-hoc rows (∪ the chain's
      // group-scoped extras), no gazette. A national date the custom group omits is therefore a normal
      // working day for that staff member — the reporter's "pick which holidays" model, verbatim.
      return new Set([...adHocRows.map((h) => h.d), ...chainExtras]);
    }
    // EXTENDED = official gazette ∪ company ad-hoc. The gazette half is keyed on the ASSIGNED group's
    // states[] (national ∪ group.states; the PARENT's when the group inherits), mirroring the
    // location-calendar extended path above.
    const groupStates: string[] = Array.isArray(effEmpGroupStates) ? (effEmpGroupStates as string[]) : [];
    const gazetteRows = await tx
      .select({ d: holiday.holidayDate })
      .from(holiday)
      .where(
        and(
          gte(holiday.holidayDate, startDate),
          lte(holiday.holidayDate, endDate),
          eq(holiday.country, emp.country),
          isNull(holiday.companyId),
          isNull(holiday.holidayGroupId), // group extras are chain-gated, not part of the public gazette
          groupStates.length ? or(isNull(holiday.state), inArray(holiday.state, groupStates)) : isNull(holiday.state),
        ),
      );
    return new Set([...adHocRows.map((h) => h.d), ...gazetteRows.map((h) => h.d), ...chainExtras]);
  }

  // Step 2 — 2C fallback: national ∪ effState. A mapped STANDARD calendar contributes its states[] as the
  // gazette state source (the named override wins over a bare location.state, §3); otherwise the existing
  // precedence (location.state → group → work_state → company default → national). R18 a519a96e: a group
  // that INHERITS contributes its PARENT's states[] (the effective values computed above).
  const standardCalStates: string[] | undefined =
    emp.mappedCalendar && effCalArchetype === 'standard' && Array.isArray(effCalStates)
      ? (effCalStates as string[])
      : undefined;
  const states: string[] = standardCalStates
    ? standardCalStates
    : emp.locationState
      ? [emp.locationState]
      : effEmpGroupStates
        ? (effEmpGroupStates as string[])
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
        isNull(holiday.holidayGroupId), // group-scoped extras never leak into the gazette path (chain-gated)
        states.length ? or(isNull(holiday.state), inArray(holiday.state, states)) : isNull(holiday.state),
      ),
    );
  // The chain's group-scoped extras stack on the gazette result (empty chain → no-op, byte-identical).
  return new Set([...baseRows.map((h) => h.d), ...chainExtras]);
}

/**
 * r298 (board b6a995c1) — `holidayDatesFor` for MANY employments over ONE window, for a screen that asks
 * "is this date a holiday?" of a whole population (the Daily Attendance loader, core/attendance.ts).
 *
 * NOT A SECOND RESOLVER, deliberately. It calls the UNCHANGED `holidayDatesFor` above, memoized on the four
 * employment inputs that fully determine its answer — the key core/absence-days.ts `holidayKeyOf` already
 * uses in production:
 *   companyId      → company.country, company.default_work_state, and the is_company_descendant chain
 *   workState      → employment.work_state (the `ws` rung of the state precedence)
 *   holidayGroupId → the directly-assigned group: its archetype, states, parent, extras and ticked days
 *   locationId     → the OPEN assignment's location: its state, its mapped calendar and that calendar's parent
 * Employments sharing all four get the answer of ONE call. The precedence rules are not re-expressed here,
 * so there is no second copy of them to drift, and the payroll/leave callers of `holidayDatesFor` are
 * untouched.
 *
 * Cost: two queries load those inputs for every id whatever the headcount, then one resolver call per
 * DISTINCT key plus one per ambiguous employment — sequential, because every call shares `tx`'s one
 * connection. The worst case (every employment its own key) is the old one-call-per-head plus two queries.
 *
 * Exact-equivalence rules, each pinned by test/r298-holiday-memo.test.ts:
 *  - an employment with MORE THAN ONE open assignment is resolved ON ITS OWN: `holidayDatesFor` joins an
 *    arbitrary one via `.limit(1)`, and the memo must not pick a different one than it would. The database
 *    forbids that state (`assignment_no_overlap`, migration 0001), so this is defence in depth, kept because
 *    core/absence-days.ts makes the same promise and a relaxed constraint must not change anyone's calendar;
 *  - the open-assignment predicate is the resolver's own (valid_to IS NULL AND superseded_at IS NULL);
 *  - an id with no visible employment row maps to an empty Set, as `holidayDatesFor`'s `if (!emp)` does;
 *  - the inputs are read through the caller's `tx`, so RLS hides from this exactly what it hides from the
 *    resolver.
 * Every requested id (duplicates collapsed) has an entry, and each entry is its OWN Set: mutating one
 * employment's calendar can never change another's.
 */
export async function holidayDatesByEmployment(
  tx: Tx,
  { employmentIds, startDate, endDate }: { employmentIds: readonly string[]; startDate: string; endDate: string },
): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(employmentIds)];
  const out = new Map<string, Set<string>>();
  if (ids.length === 0) return out;

  const emps = await tx
    .select({
      employmentId: employment.id,
      companyId: employment.companyId,
      workState: employment.workState,
      holidayGroupId: employment.holidayGroupId,
    })
    .from(employment)
    .where(inArray(employment.id, ids));
  const openAssignments = await tx
    .select({ employmentId: assignment.employmentId, locationId: assignment.locationId })
    .from(assignment)
    .where(and(inArray(assignment.employmentId, ids), isNull(assignment.validTo), isNull(assignment.supersededAt)));

  const empById = new Map(emps.map((e) => [e.employmentId, e]));
  const openCount = new Map<string, number>();
  const locationByEmp = new Map<string, string | null>();
  for (const a of openAssignments) {
    openCount.set(a.employmentId, (openCount.get(a.employmentId) ?? 0) + 1);
    locationByEmp.set(a.employmentId, a.locationId);
  }

  const memo = new Map<string, Set<string>>();
  for (const id of ids) {
    const e = empById.get(id);
    if (!e) {
      out.set(id, new Set<string>());
      continue;
    }
    const one = { employmentId: id, startDate, endDate };
    if ((openCount.get(id) ?? 0) > 1) {
      // Ambiguous open assignment — resolve this one alone rather than guess which row `.limit(1)` takes.
      out.set(id, await holidayDatesFor(tx, one));
      continue;
    }
    // JSON, not a joined string: null and '' stay distinct, and no value can forge a separator.
    const key = JSON.stringify([e.companyId, e.workState, e.holidayGroupId, locationByEmp.get(id) ?? null]);
    let dates = memo.get(key);
    if (!dates) {
      dates = await holidayDatesFor(tx, one);
      memo.set(key, dates);
    }
    out.set(id, new Set(dates));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// 0e276da0 (r269) — CALENDAR COVERAGE: what a named holiday calendar would cost the staff of a
// location attached to it. A PURE, PRESENTATIONAL READ. Nothing above this line changes.
//
// WHY IT EXISTS. §ADR-0067 above: a location mapped to a calendar whose effective archetype is
// 'custom' resolves to ONLY that calendar's own days and NO gazette — "a national date the custom
// calendar omits is a normal working day for that location's staff", which reaches money through the
// frozen attendance day-type (OT class) and the working-day leave count. Nothing warned, because
// effectiveHolidayState deliberately returns skipCompleteness for 'custom' (the s.60D guard would
// otherwise cry wolf over every hand-managed calendar). THAT SKIP IS RIGHT AND STAYS. This read is a
// SEPARATE question asked on a screen, never by the resolver: not "does the gazette have 11 days" but
// "which gazetted days does THIS calendar leave out". It emits no event, writes nothing, and blocks
// nothing — a calendar that deliberately holds fewer days is a real thing.
//
// DELIBERATE PREDICATE CHOICE: the gazette set below uses the SAME predicate as holidayDatesFor's
// gazette branch (company_id IS NULL ∧ holiday_group_id IS NULL ∧ country ∧ state ∈ {null} ∪ states[]),
// with NO filter on `active`, `tentative` or `holiday_type`. The resolver does not read those columns,
// so filtering here would let the screen say a day is covered that the engine will treat as a working
// day. Resolver-consistency is the standard: a day this read calls "left out" IS a working day for
// that location's staff.
//
// WHAT IT CANNOT SEE, said plainly rather than papered over: 'custom' also resolves COMPANY-scoped
// ad-hoc rows (app.is_company_descendant against the EMPLOYEE's company). Those are a property of the
// employee's company chain, not of the calendar, so a calendar this read calls empty may still yield
// days to staff of a company that owns ad-hoc rows. The warning is therefore a WARNING and says so.

/** One gazetted DATE a calendar does not supply. `name` joins the names the gazette gives that date. */
export type HolidayCalendarGap = { date: string; name: string };

/** What a named calendar covers in one year, and what it leaves out. */
export type HolidayCalendarCoverage = {
  groupId: string;
  name: string;
  /** The EFFECTIVE archetype — the PARENT's when the group inherits (R18 a519a96e), exactly as the
   *  resolver substitutes it. A child of a custom parent stands alone even if its own row says otherwise. */
  archetype: string;
  /** true ⇔ effective archetype 'custom': this calendar's staff get these days and NO gazette. */
  standalone: boolean;
  /** The gazette country, or null when the tenant does not resolve to exactly one (see below). */
  country: string | null;
  year: number;
  /** The EFFECTIVE states[] (the parent's when the group inherits). */
  states: string[];
  /** DISTINCT dates the calendar itself supplies in `year` — days off, not junction rows. Two gazette
   *  rows on one date (Federal Territory Day is three rows) are ONE day off and count once. */
  held: number;
  /** DISTINCT gazetted dates that apply to this calendar in `year` (national ∪ states[]). */
  gazette: number;
  /** The gazetted dates `held` does not cover, earliest first. Empty when `country` is null. */
  missing: HolidayCalendarGap[];
};

/** How a calendar reads on screen. PURE. Only a stand-alone (custom) calendar can be at risk: a
 *  standard/extended calendar still gets the gazette, so it can never strip a day. */
export function holidayCalendarRisk(c: HolidayCalendarCoverage): 'empty' | 'incomplete' | null {
  if (!c.standalone) return null;
  if (c.held === 0) return 'empty';
  return c.missing.length > 0 ? 'incomplete' : null;
}

/**
 * PURE diff: the gazetted DATES `held` does not cover, named and ordered. Multiple gazette rows on one
 * date (the same holiday gazetted in several states) collapse to one gap whose name lists each distinct
 * name once, so the reader sees one lost day rather than three.
 */
export function missingGazettedDates(
  held: Iterable<string>,
  gazette: { holidayDate: string; name: string }[],
): HolidayCalendarGap[] {
  const have = new Set(held);
  const byDate = new Map<string, string[]>();
  for (const g of gazette) {
    if (have.has(g.holidayDate)) continue;
    const names = byDate.get(g.holidayDate);
    if (names) {
      if (!names.includes(g.name)) names.push(g.name);
    } else byDate.set(g.holidayDate, [g.name]);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, names]) => ({ date, name: names.join(' / ') }));
}

/**
 * Coverage for EVERY named calendar in the tenant, for one year (default: the current year in the
 * tenant's timezone — §8 "no hardcoded future dates"). One read, one shape, used by both screens.
 *
 * COUNTRY. The gazette is country-keyed; a holiday_group is not. We take the tenant's distinct company
 * countries: exactly one ⇒ that is the gazette. Zero or several ⇒ `country` stays null and `missing`
 * stays EMPTY rather than diffing against a union of two countries' gazettes and naming days that were
 * never owed. The empty-calendar warning still stands in that case — it needs no gazette to be true.
 *
 * Read-only: no event, no write.
 */
export function holidayCalendarCoverage(
  ctx: SessionContext,
  opts: { year?: number } = {},
): Promise<HolidayCalendarCoverage[]> {
  const year = opts.year ?? Number(todayInKualaLumpur().slice(0, 4));
  return withTenant(ctx, async (tx) => {
    const coverageParent = alias(holidayGroup, 'coverage_parent');
    const groups = await tx
      .select({
        id: holidayGroup.id,
        name: holidayGroup.name,
        archetype: holidayGroup.archetype,
        states: holidayGroup.states,
        parentId: holidayGroup.parentGroupId,
        parentArchetype: coverageParent.archetype,
        parentStates: coverageParent.states,
      })
      .from(holidayGroup)
      .leftJoin(coverageParent, eq(coverageParent.id, holidayGroup.parentGroupId))
      .orderBy(holidayGroup.name);
    if (groups.length === 0) return [];

    const countryRows = await tx.selectDistinct({ country: company.country }).from(company);
    const countries = countryRows.map((r) => r.country).filter((c): c is string => !!c);
    const country = countries.length === 1 ? countries[0] : null;
    const inYear = sql`extract(year from ${holiday.holidayDate}) = ${year}`;

    // The gazette that could apply to any calendar this year — national ∪ every state. Filtered per
    // calendar below by its effective states[]. Same predicate as holidayDatesFor's gazette branch.
    const gazetteRows = country
      ? await tx
          .select({ holidayDate: holiday.holidayDate, name: holiday.name, state: holiday.state })
          .from(holiday)
          .where(and(eq(holiday.country, country), isNull(holiday.companyId), isNull(holiday.holidayGroupId), inYear))
      : [];

    // What each calendar itself supplies: the days TICKED into it (holiday_group_holiday, 66b8f5a8) and
    // the group-SCOPED extra days it owns (holiday.holiday_group_id, R18 a519a96e) — the two additive
    // sources holidayDatesFor folds into chainExtras. Read for every group at once, then attributed to
    // the CHAIN (group ∪ its parent) below, exactly as the resolver builds chainIds.
    const countryFilter = country ? eq(holiday.country, country) : undefined;
    const tickedRows = await tx
      .select({ gid: holidayGroupHoliday.holidayGroupId, d: holiday.holidayDate })
      .from(holidayGroupHoliday)
      .innerJoin(holiday, eq(holiday.id, holidayGroupHoliday.holidayId))
      .where(and(inYear, countryFilter));
    const extraRows = await tx
      .select({ gid: holiday.holidayGroupId, d: holiday.holidayDate })
      .from(holiday)
      .where(and(isNotNull(holiday.holidayGroupId), inYear, countryFilter));

    const datesByGroup = new Map<string, Set<string>>();
    const addDate = (gid: string | null, d: string) => {
      if (!gid) return;
      const set = datesByGroup.get(gid);
      if (set) set.add(d);
      else datesByGroup.set(gid, new Set([d]));
    };
    for (const r of tickedRows) addDate(r.gid, r.d);
    for (const r of extraRows) addDate(r.gid, r.d);

    return groups.map((g) => {
      // R18 a519a96e substitution, mirroring the resolver: with a parent set, the PARENT's archetype and
      // states[] are the gazette source; the child only adds its own days.
      const archetype = (g.parentId ? g.parentArchetype : g.archetype) ?? 'standard';
      const rawStates = g.parentId ? g.parentStates : g.states;
      const states = Array.isArray(rawStates) ? (rawStates as string[]) : [];
      const chainIds = [g.id, ...(g.parentId ? [g.parentId] : [])];
      const held = new Set<string>();
      for (const gid of chainIds) for (const d of datesByGroup.get(gid) ?? []) held.add(d);
      const applicable = gazetteRows.filter((r) => r.state === null || states.includes(r.state));
      return {
        groupId: g.id,
        name: g.name,
        archetype,
        standalone: archetype === 'custom',
        country,
        year,
        states,
        held: held.size,
        gazette: new Set(applicable.map((r) => r.holidayDate)).size,
        missing: missingGazettedDates(held, applicable),
      };
    });
  });
}
