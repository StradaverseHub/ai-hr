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
 *      work_state → company.default_work_state → national-only. Holiday groups expand to their member
 *      states and feed the same UNION predicate. (ADR-0086: `location.state` used to sit ABOVE work_state
 *      in that order; the work site is no longer an input — see the ADR-0086 block below.)
 *
 * Country semantics (ADR-0055, deliberate change from the old country-blind leave query): the resolver
 * filters by the employee's COMPANY country in both branches, matching the attendance engine and the
 * correct multi-country intent (a SG-company employee's leave no longer subtracts MY national holidays).
 *
 * ── ADR-0086 — the WORK SITE IS NOT AN INPUT TO THIS FUNCTION (supersedes ADR-0067 §(b) and §(c)) ──
 * ADR-0067 let a `location` be MAPPED to a named holiday_group whose `archetype` made it a CALENDAR, and
 * this resolver read the employee's OPEN assignment's location for two things: `location.state` at the
 * TOP of the Step-2 precedence, and `location.holiday_group_id` as an archetype-bearing calendar that
 * outranked the directly-assigned group. Item 0fe1ca2e retired the work-site register on the reporter's
 * say-so; ADR-0086 records the reversal and the measurement behind it (8 sites, 0 mapping a calendar,
 * 1 open assignment whose employee's `work_state` already carried the site's state, 0 holidays moved).
 *
 * So there is NO location join here any more, and none in `effectiveHolidayState` either. They were
 * removed TOGETHER, in one commit, because the second feeds the s.60D completeness guard and the two
 * must agree about which gazette a person follows; `test/holiday-calendar-resolution.test.ts` pins that
 * agreement. What an employment's calendar depends on is now exactly THREE values — company, work_state,
 * holiday_group_id — and `HolidayMemoInputs` below says so in one place for both memos.
 *
 * What ADR-0086 deliberately KEEPS: ADR-0067 §(a) `holiday_group.archetype`, and direct assignment via
 * `employment.holiday_group_id`. A custom/extended calendar is still a real thing — it is chosen on the
 * PERSON now, not through a site. Only the site door closed.
 *
 * Frozen-attendance caveat (accepted decision, NOT a silent gap): attendance day-type rows are FROZEN at
 * check-in (core/attendance.ts) and drive the 1.5x/3.0x OT class = money. Changing a calendar — or, under
 * ADR-0086, removing the site rung from the precedence at all — reclassifies only FRESH dates resolved
 * through this function; already-frozen historical rows are accepted as historical and are NOT
 * retroactively re-classified. No re-freeze job is built (out of scope). If a recompute is ever wanted,
 * that is a separate task. For ADR-0086 specifically the question was MEASURED rather than left to this
 * caveat: `holidays MOVE 0` on production, so there is no reclassification to absorb, fresh or frozen.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
// 0e276da0 — the calendar-coverage read at the foot of this file is SESSION-scoped (a screen asks it),
// unlike every resolver above, which runs inside the caller's tx. `withTenant` is the only addition.
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { todayInKualaLumpur } from '../lib/hr-date';
import { appendEvent, actorOf } from '../db/events';
import { company, employment, holiday, holidayGroup, holidayGroupHoliday } from '../db/schema';

// R18 a519a96e — group INHERITANCE: the employment's assigned group may point at a PARENT group
// (holiday_group.parent_group_id, single level). The parent is joined LIVE (strictly 1:1 — parent_group_id
// → PK) so parent edits propagate instantly with no sync. When a parent exists it supplies the gazette
// source (archetype + states); the child contributes only its own group-scoped extra days.
// ADR-0086: there were TWO such chains until 0fe1ca2e — this one and the LOCATION's mapped calendar. The
// site chain (`location_calendar` / `location_calendar_parent`) is gone with the site rung itself.
const empGroupParent = alias(holidayGroup, 'emp_group_parent');

/**
 * r328 (board 0fe1ca2e) — the READ-ONLY "what would this employment's calendar be WITHOUT the site
 * register" preview, `HolidayWhatIf`, USED TO LIVE HERE, and it is gone on purpose.
 *
 * Its own closing paragraph set the condition: "IT IS TEMPORARY. It is the preview half of removing
 * `location` from holiday resolution; when `assignment.location_id` and the `location` join leave this
 * function, this goes with them." r331 is that removal (ADR-0086), so it went. A preview of a world we
 * now live in is not a preview; leaving it would be a second, divergent copy of a precedence that no
 * longer has the rung it was blanking.
 *
 * `scripts/report-location-holiday-deltas.ts`, its only caller, was the r328 report that measured the
 * change on production before it was made (`holidays MOVE 0`, `EMPTY calendar both sides = 0`). It has
 * served its purpose and is retired with the override it drove; the figures it produced are recorded in
 * ADR-0086 §2, which is where a reader should look for what the removal cost.
 */

export type HolidayWindow = {
  employmentId: string;
  startDate: string;
  endDate: string;
};

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
 * (holiday-group first state → work_state → company.default_work_state → national), collapsed to one
 * label for the completeness guard. Returns { country, state } with state null when the employment
 * resolves to national-only. A holiday group is summarised by its first state (the guard's job is to
 * flag an under-loaded gazette, not to fan out across every group member).
 *
 * ADR-0086 — THE SITE RUNG IS GONE FROM BOTH READERS, TOGETHER. Until r331 this function also joined the
 * OPEN assignment's `location` for `location.state` (the top of the precedence) and for the location's
 * mapped CALENDAR, whose archetype decided whether to suppress the warning. ADR-0067 §(b)/§(c) are
 * superseded, so neither is read here any more. This function and `holidayDatesFor` had to lose the join
 * in ONE commit — they feed different code paths (this one the s.60D guard in core/leave.ts, that one
 * attendance and the working-day leave count) and a person who follows one gazette for their days off and
 * another for the "is your gazette complete?" warning is the r209-class defect this pairing exists to
 * prevent. `test/holiday-calendar-resolution.test.ts` asserts the two AGREE, which is what makes
 * "together" enforceable rather than remembered.
 *
 * ADR-0067 §(a) SURVIVES, and so does the archetype awareness that goes with it: a Custom group assigned
 * DIRECTLY on the profile (`employment.holiday_group_id`) is hand-managed and deliberately ignores the
 * gazette in `holidayDatesFor`, so the "gazette < 11" warning would be false noise — return
 * skipCompleteness and the caller emits nothing. 'extended' is deliberately NOT suppressed: an extended
 * group still includes the gazette, so the warning stays meaningful.
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
      // holidayDatesFor for a custom/extended group assigned DIRECTLY on the profile.
      empGroupArchetype: holidayGroup.archetype,
      // R18 a519a96e: the assigned group's PARENT (single level). When set, the PARENT's archetype/states
      // are the gazette source — keeps this guard in agreement with holidayDatesFor's inheritance.
      empGroupParentId: holidayGroup.parentGroupId,
      empGroupParentArchetype: empGroupParent.archetype,
      empGroupParentStates: empGroupParent.states,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
    .leftJoin(empGroupParent, eq(empGroupParent.id, holidayGroup.parentGroupId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return null;
  // R18 a519a96e — inheritance substitution: with a parent set, the parent's archetype + states ARE the
  // gazette source for the child (the child only adds group-scoped extras, which never affect this guard).
  // Parentless groups keep their own values, so every existing path is unchanged.
  const effEmpGroupArchetype = emp.empGroupParentId ? emp.empGroupParentArchetype : emp.empGroupArchetype;
  const effEmpGroupStates = emp.empGroupParentId ? emp.empGroupParentStates : emp.groupStates;
  // ADR-0067 (direct-assign): a Custom group assigned DIRECTLY on the profile is hand-managed and ignores
  // the gazette in holidayDatesFor — so the "gazette < 11" warning would be false noise. Suppress it to
  // keep effectiveHolidayState and holidayDatesFor in agreement. Extended is deliberately NOT suppressed:
  // an extended group still includes the gazette, so the warning stays meaningful.
  if (effEmpGroupArchetype === 'custom') return { country: emp.country, state: null, skipCompleteness: true };
  const groupFirst = Array.isArray(effEmpGroupStates) ? (effEmpGroupStates as string[])[0] : undefined;
  const state = groupFirst ?? emp.ws ?? emp.cds ?? null;
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
 *  DETERMINING INPUTS, MIRRORED IN TWO MEMO KEYS. This reads exactly THREE employment-level values:
 *  employment.company_id, employment.work_state and employment.holiday_group_id. Two memos key on
 *  precisely those — `holidayDatesByEmployment` below and `holidayKeyOf` in core/absence-days.ts — and
 *  hand every employment sharing them the same answer. Reading a new employment-level input here without
 *  adding it to BOTH keys silently gives one employee another's calendar.
 *
 *  ADR-0086: there were FOUR until r331. The fourth was the OPEN assignment's `location_id` — plus how
 *  many open assignments there were, because the join took one via `.limit(1)`, which is why both memos
 *  carried an "ambiguous open assignment, resolve alone" escape hatch. Nothing here joins `assignment`
 *  any more, so a second open assignment cannot change anybody's calendar and both escape hatches went
 *  with it. */
export async function holidayDatesFor(
  tx: Tx,
  { employmentId, startDate, endDate }: HolidayWindow,
): Promise<Set<string>> {
  const [row] = await tx
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
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
    .leftJoin(empGroupParent, eq(empGroupParent.id, holidayGroup.parentGroupId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!row) return new Set<string>();
  const emp = row;

  // ── R18 a519a96e — group INHERITANCE + group-scoped "additional days" ─────────────────────────────
  // Effective substitution: when the directly-assigned group has a PARENT, the parent's archetype +
  // states[] become the gazette source. Parentless groups keep their own values, so every predicate below
  // is byte-identical to before for existing data (all parents NULL). ADR-0086: there used to be a SECOND
  // chain here — the location's mapped calendar, which outranked this one — and it is gone with the site
  // rung; a calendar is chosen on the PERSON now.
  const effEmpGroupArchetype = emp.empGroupParentId ? emp.empGroupParentArchetype : emp.empGroupArchetype;
  const effEmpGroupStates = emp.empGroupParentId ? emp.empGroupParentStates : emp.groupStates;
  // The active calendar CHAIN (group + its parent) contributes group-scoped extra rows. Extras are
  // ADDITIVE to every resolution path below — never replacement — so a "Company Family Day" stacks on top
  // of whatever calendar the employee resolves to, and a parent's extra day reaches every child group
  // instantly (resolve-at-read; nothing is copied).
  const chainIds: string[] = emp.empHolidayGroupId
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

  // ADR-0086: the ADR-0067 archetype pre-check for the LOCATION's mapped calendar used to sit here,
  // ABOVE the Step-1 business-group override, so a site calendar outranked a company-subtree override.
  // The site rung is retired; the equivalent branch for a group assigned DIRECTLY on the profile still
  // exists below, deliberately BELOW Step 1 (see its own note on placement).

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

  // ── ADR-0067 (direct-assign) — per-employee-group archetype branch, for a custom/extended group assigned
  // DIRECTLY on the profile (employment.holidayGroupId). ADR-0086: this is now the ONLY archetype branch —
  // its twin for a location's mapped calendar, which outranked it, is retired with the site rung, so a
  // named calendar reaches a person one way instead of two. Placement is unchanged and still deliberate:
  // AFTER the Step-1 business-group company override early-return (a company-subtree override still wins)
  // and BEFORE the Step-2 state fallback. It fires ONLY when the Step-1 override produced nothing
  // (groupRows was empty), the employee has a directly-assigned group (empHolidayGroupId set), and that
  // group's archetype is 'custom' or 'extended'. A 'standard' (or unset) group falls through to Step 2
  // BYTE-IDENTICALLY, preserving the regression guarantee for every existing state-based / default employee.
  if (emp.empHolidayGroupId && (effEmpGroupArchetype === 'custom' || effEmpGroupArchetype === 'extended')) {
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

  // Step 2 — 2C fallback: national ∪ effState, resolved group → work_state → company default → national.
  // R18 a519a96e: a group that INHERITS contributes its PARENT's states[] (the effective values above).
  // ADR-0086: `location.state` used to sit ABOVE the group here, and a mapped STANDARD calendar's states[]
  // above that again. Both rungs are retired; `employment.work_state` is the employee-level answer now,
  // which is the one that was already in force for every employee on production (ADR-0086 §2).
  const states: string[] = effEmpGroupStates
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
 * Employments sharing all three get the answer of ONE call. The precedence rules are not re-expressed here,
 * so there is no second copy of them to drift, and the payroll/leave callers of `holidayDatesFor` are
 * untouched.
 *
 * ADR-0086 — THE FOURTH INPUT IS GONE. It was `locationId`, the OPEN assignment's site, and it cost this
 * function a second query and an escape hatch: because the resolver joined `assignment` and took one row
 * via `.limit(1)`, an employment with two open assignments had to be resolved ALONE rather than memoized,
 * or the memo could have picked a different site than the resolver would. The resolver no longer joins
 * `assignment` at all, so the ambiguity cannot arise and the escape hatch is not "removed for tidiness" —
 * there is nothing left for it to disambiguate.
 *
 * Cost: ONE query loads those inputs for every id whatever the headcount, then one resolver call per
 * DISTINCT key — sequential, because every call shares `tx`'s one connection. The worst case (every
 * employment its own key) is the old one-call-per-head plus one query.
 *
 * Exact-equivalence rules, each pinned by test/r298-holiday-memo.test.ts:
 *  - an id with no visible employment row maps to an empty Set, as `holidayDatesFor`'s `if (!emp)` does;
 *  - the inputs are read through the caller's `tx`, so RLS hides from this exactly what it hides from the
 *    resolver.
 * Every requested id (duplicates collapsed) has an entry, and each entry is its OWN Set: mutating one
 * employment's calendar can never change another's.
 */
/**
 * THE DETERMINING INPUTS of `holidayDatesFor`, named once — the three employment-level values that fully
 * decide an employment's calendar for a window. See the resolver's own header for what each one reaches.
 * (ADR-0086 removed a fourth, the open assignment's `locationId`, when the work site stopped being an
 * input to holiday resolution. An input leaving this type is exactly as dangerous as one arriving: both
 * memos must move with the resolver, which is why the type and the key below are the only place either
 * is written down.)
 */
export type HolidayMemoInputs = {
  companyId: string;
  workState: string | null;
  holidayGroupId: string | null;
};

/**
 * THE memo key for a resolved holiday calendar — ONE function, deliberately, because there are TWO memos.
 *
 * `holidayDatesByEmployment` below and `holidayKeyOf` in core/absence-days.ts both hand every employment
 * sharing these inputs the answer of ONE resolver call. Until 0fe1ca2e they expressed that key TWICE,
 * in two files, by hand: a JSON tuple here and a pipe-joined string there. Two copies of a key are two
 * things to edit when a determining input changes, and the failure mode is silent and severe — the memo
 * and the resolver disagree, and one employee is handed another's public holidays, which reaches the
 * frozen attendance day-type (OT class = money) and the working-day leave count. r209 spent two rounds
 * undoing that class of defect. One function means an input cannot leave one key and stay in the other.
 *
 * JSON, not a joined string: null and '' stay distinct, and no value can forge a separator. (The
 * pipe-joined copy this replaces could not distinguish a work_state of '' from none — unreachable today
 * because the setters trim to null, and exactly the kind of "unreachable today" that a refactor reaches.)
 *
 * NOT A CACHE, and it must never become one: it is keyed per CALL, inside one transaction and one window.
 * The window is not part of the key because both callers memoize within a single window.
 */
export function holidayMemoKey(i: HolidayMemoInputs): string {
  return JSON.stringify([i.companyId, i.workState, i.holidayGroupId]);
}

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

  const empById = new Map(emps.map((e) => [e.employmentId, e]));

  const memo = new Map<string, Set<string>>();
  for (const id of ids) {
    const e = empById.get(id);
    if (!e) {
      out.set(id, new Set<string>());
      continue;
    }
    const one = { employmentId: id, startDate, endDate };
    const key = holidayMemoKey({
      companyId: e.companyId,
      workState: e.workState,
      holidayGroupId: e.holidayGroupId,
    });
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
