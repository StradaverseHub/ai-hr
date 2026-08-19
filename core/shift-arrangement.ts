/**
 * 18504ca6 — EFFECTIVE DATE ON THE SHIFT ARRANGEMENT CARD: the dated writer and the card's history read.
 *
 * THE GAP. The Location card on the personnel Attendance tab is effective-dated; the Shift arrangement card
 * directly below it was not. Saving there ran core/roster.ts assignEmployeeShift, which UPDATEs
 * employment.shift_type + employment.default_shift_id IN PLACE — so the previous shift was gone, with no date
 * and no history, and the system could not say which shift someone was on last month.
 *
 * WHAT THIS MODULE OWNS. `assignEmployeeShiftDated` is the CARD's write path: it appends a dated period to
 * employment_shift_arrangement (migration 0421), closes the previous period the day before, and keeps
 * employment.default_shift_id / shift_type up to date as a CACHE of the period in force today so every
 * existing reader keeps working unchanged.
 *
 * WHY NOT JUST EXTEND core/roster.ts assignEmployeeShift. This round, three workstreams share these files and
 * core/roster.ts belongs to another one; the ladder was therefore built as its own module (the same shape the
 * plan's DESIGN CHOICE section describes — mirror the compensation ladder, not the Movement module). The two
 * writers coexist safely because the resolvers fall back to employment.default_shift_id for any employment
 * with NO ladder row, and the legacy writer's only production caller (backfillBackupShift) touches exactly
 * those employments — the ones with no shift and therefore no ladder row. FOLLOW-UP for whoever owns
 * core/roster.ts: assignEmployeeShift should delegate here, so a legacy write can never leave a ladder that
 * already exists stale.
 *
 * THE DATE RULES (all four are the reporter's, from the approved plan):
 *   · required, a real ISO date, and never earlier than the employee's own start date;
 *   · a change may be dated in the past OR the future, but only AFTER the last change already recorded —
 *     slotting one in BEFORE an existing entry is refused with a message that names the blocking date;
 *   · saving twice for the SAME date REPLACES that entry (supersede + insert) instead of creating a second;
 *   · periods can never overlap, because each simply runs until the next begins.
 */
import { and, asc, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { appUser, company, employment, employmentShiftArrangement, person, shift } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  arrangementsForEmploymentTx,
  liveArrangementsTx,
  pickArrangementOn,
  type ArrangementPeriod,
} from './shift-arrangement-resolve';
import { ArchivedShiftError, BackupShiftRequiredError, ShiftHasNoWorkingPatternError } from './roster';

export {
  arrangementsForEmploymentTx,
  liveArrangementsTx,
  pickArrangementOn,
  type ArrangementPeriod,
} from './shift-arrangement-resolve';

/** The effective date was missing or not a real calendar date. */
export class InvalidEffectiveDateError extends Error {
  constructor() {
    super('Enter a valid effective date (YYYY-MM-DD).');
    this.name = 'InvalidEffectiveDateError';
  }
}

/** The effective date is earlier than the employee's own start date. `startDate` is for the localized copy. */
export class ShiftEffectiveBeforeStartError extends Error {
  constructor(readonly startDate: string) {
    super(`The effective date cannot be earlier than the employee's start date (${startDate}).`);
    this.name = 'ShiftEffectiveBeforeStartError';
  }
}

/**
 * A change dated BEFORE one already recorded. Out of scope for v1 and disclosed to the reporter as such:
 * inserting a period between two existing ones has to re-close both neighbours and re-answer every date in
 * between, which is a bigger change than this item bought. `lastEffectiveFrom` names the blocking entry so
 * the message on screen can too.
 */
export class ShiftBackInsertError extends Error {
  constructor(readonly lastEffectiveFrom: string) {
    super(
      `This employee already has a shift change dated ${lastEffectiveFrom}. A change dated before that one cannot be added yet.`,
    );
    this.name = 'ShiftBackInsertError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date in ISO form — "2026-02-30" and "2026-13-01" are refused. */
function isRealIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** ISO date shifted by whole days, in UTC so no host timezone can move the calendar day. */
function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The employee's own start date — the floor for any effective date, and the valid_from migration 0421
 * backfills. The SAME coalesce as the migration on purpose: hired_on is NOT NULL today, but if the two
 * expressions ever disagreed an employment would get a backfilled period the writer then refused to extend.
 */
function startDateOf(emp: { hiredOn: string | null; joinDate: string | null; createdAt: Date }): string {
  return emp.hiredOn ?? emp.joinDate ?? emp.createdAt.toISOString().slice(0, 10);
}

export type AssignEmployeeShiftDatedInput = {
  employmentId: string;
  shiftType: 'fixed' | 'roster';
  shiftId: string | null;
  /**
   * The reporter's Effective date. The card always sends one. OMITTED means "replace the entry currently at
   * the top of the ladder" (or start one at the employee's start date when there is none) — the legacy,
   * undated semantics, kept so a non-UI caller cannot accidentally open a second period it never asked for.
   */
  effectiveFrom?: string | null;
};

/**
 * Set the employee's shift arrangement FROM A DATE. One transaction: validate, close the open period, insert
 * the new one, refresh the employment cache, append the audit event.
 */
export async function assignEmployeeShiftDated(
  ctx: SessionContext,
  p: AssignEmployeeShiftDatedInput,
): Promise<{ id: string; effectiveFrom: string }> {
  const shiftId = p.shiftId || null;
  // b8aa3466 — the backup shift is mandatory on BOTH arrangements; the same refusal the legacy writer gives.
  if (!shiftId) throw new BackupShiftRequiredError();
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({
        id: employment.id,
        hiredOn: employment.hiredOn,
        joinDate: employment.joinDate,
        createdAt: employment.createdAt,
        beforeShift: employment.defaultShiftId,
        beforeType: employment.shiftType,
      })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new Error('Employment not found');

    const [sh] = await tx
      .select({ id: shift.id, archivedAt: shift.archivedAt, pattern: shift.weeklyPattern, halfPattern: shift.halfPattern })
      .from(shift)
      .where(eq(shift.id, shiftId))
      .limit(1);
    if (!sh) throw new Error('Shift not found');
    // The same two invariants the legacy writer enforces, and for the same reasons: an archived shift is not
    // assignable (R33 f21d6eee — no company check, the library is shared), and a shift with no weekly working
    // pattern would make EVERY unrostered day a rest day for this person (b8aa3466).
    if (sh.archivedAt) throw new ArchivedShiftError();
    // b8aa3466 — "has a working pattern" is Full ∪ HALF now: an all-half-days shift is walkable, and the
    // guard exists to stop an UNWALKABLE backup shift making every day a rest day, not to stop half days.
    if (new Set([...(sh.pattern ?? []), ...(sh.halfPattern ?? [])]).size === 0) throw new ShiftHasNoWorkingPatternError();

    const rows = await arrangementsForEmploymentTx(tx, p.employmentId);
    const last: ArrangementPeriod | undefined = rows[rows.length - 1];
    const startDate = startDateOf(emp);

    let effectiveFrom: string;
    if (p.effectiveFrom == null || p.effectiveFrom === '') {
      // Undated legacy semantics — replace the newest entry in place (or open the first one at the start date).
      effectiveFrom = last?.validFrom ?? startDate;
    } else {
      effectiveFrom = p.effectiveFrom.trim();
      if (!isRealIsoDate(effectiveFrom)) throw new InvalidEffectiveDateError();
      if (effectiveFrom < startDate) throw new ShiftEffectiveBeforeStartError(startDate);
      if (last && effectiveFrom < last.validFrom) throw new ShiftBackInsertError(last.validFrom);
    }

    if (last && effectiveFrom === last.validFrom) {
      // SAME DATE ⇒ REPLACE. Supersede FIRST so the row leaves the partial unique index
      // (tenant, employment, valid_from) WHERE superseded_at IS NULL before its replacement enters it — the
      // same ordering core/comp.ts supersedeCompensation uses against its EXCLUDE constraint.
      await tx
        .update(employmentShiftArrangement)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(employmentShiftArrangement.employmentId, p.employmentId),
            eq(employmentShiftArrangement.validFrom, last.validFrom),
            isNull(employmentShiftArrangement.supersededAt),
          ),
        );
    } else if (last) {
      // A LATER date ⇒ the previous period is closed the day before, so the two can never overlap.
      await tx
        .update(employmentShiftArrangement)
        .set({ validTo: addDaysIso(effectiveFrom, -1) })
        .where(
          and(
            eq(employmentShiftArrangement.employmentId, p.employmentId),
            eq(employmentShiftArrangement.validFrom, last.validFrom),
            isNull(employmentShiftArrangement.supersededAt),
          ),
        );
    }

    await tx.insert(employmentShiftArrangement).values({
      tenantId: ctx.tenantId,
      employmentId: p.employmentId,
      shiftType: p.shiftType,
      shiftId,
      validFrom: effectiveFrom,
      validTo: null,
      createdBy: ctx.userId ?? null,
    });

    // employment.default_shift_id / shift_type stay a CACHE of the period in force TODAY. A future-dated
    // change therefore leaves them alone (the employee is still on their current shift), and every reader
    // that has not been moved onto the ladder keeps answering exactly what it answers now. pickArrangementOn
    // falls back to the earliest period, so the cache is never left null while a ladder exists.
    const after = await arrangementsForEmploymentTx(tx, p.employmentId);
    const inForce = pickArrangementOn(after, todayInKualaLumpur());
    if (inForce) {
      await tx
        .update(employment)
        .set({ shiftType: inForce.shiftType, defaultShiftId: inForce.shiftId })
        .where(eq(employment.id, p.employmentId));
    }

    // SUBSTRATE: same aggregate and event type as the legacy writer (so the Others-tab Change History keeps
    // listing shift changes in one series), with `effectiveFrom` added — additive, so lib/audit-format.ts
    // renders it as one more flat line and needs no change.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.shift-arrangement.assigned',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        before: last
          ? { shiftType: last.shiftType, defaultShiftId: last.shiftId }
          : { shiftType: emp.beforeType, defaultShiftId: emp.beforeShift },
        after: { shiftType: p.shiftType, defaultShiftId: shiftId },
        effectiveFrom,
      },
    });

    return { id: p.employmentId, effectiveFrom };
  });
}

/** One line of the Shift history list under the card. */
export type ShiftArrangementHistoryRow = {
  id: string;
  /** The date this period starts — the reporter's Effective date. */
  effectiveFrom: string;
  /** Closed to the day before the next period starts; null on the current, open period. */
  effectiveTo: string | null;
  shiftType: 'fixed' | 'roster';
  shiftId: string;
  /** Resolved here, NOT left to the audit card: lib/audit-format.ts prints a raw uuid → uuid pair. */
  shiftCode: string | null;
  shiftName: string;
  previousShiftCode: string | null;
  previousShiftName: string | null;
  /** Who changed it. Null on the period migration 0421 recorded from the employee's existing shift. */
  changedByName: string | null;
  changedAt: string;
  /** True for that same backfilled first period — the screen labels its "changed on" as the release. */
  recordedOnRelease: boolean;
};

/**
 * The Shift history list for one employee, newest first: effective date, previous shift, new shift, who
 * changed it and when. LIVE periods only — a period replaced by a second save for the same date is gone from
 * the list, which is exactly what "saving twice for one date replaces that entry" promises the reporter.
 * Read-only, RLS-scoped (see_employment), no DomainEvent.
 */
export function shiftArrangementHistory(
  ctx: SessionContext,
  employmentId: string,
): Promise<ShiftArrangementHistoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: employmentShiftArrangement.id,
        effectiveFrom: employmentShiftArrangement.validFrom,
        effectiveTo: employmentShiftArrangement.validTo,
        shiftType: employmentShiftArrangement.shiftType,
        shiftId: employmentShiftArrangement.shiftId,
        shiftCode: shift.code,
        shiftName: shift.name,
        createdAt: employmentShiftArrangement.createdAt,
        createdBy: employmentShiftArrangement.createdBy,
        changedByName: person.fullName,
      })
      .from(employmentShiftArrangement)
      .innerJoin(shift, eq(shift.id, employmentShiftArrangement.shiftId))
      .leftJoin(appUser, eq(appUser.id, employmentShiftArrangement.createdBy))
      .leftJoin(person, eq(person.id, appUser.personId))
      .where(
        and(
          eq(employmentShiftArrangement.employmentId, employmentId),
          isNull(employmentShiftArrangement.supersededAt),
        ),
      )
      .orderBy(asc(employmentShiftArrangement.validFrom), desc(employmentShiftArrangement.createdAt));
    return rows.map((r, i) => {
      const prev = i > 0 ? rows[i - 1] : undefined;
      return {
        id: r.id,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
        shiftType: r.shiftType,
        shiftId: r.shiftId,
        shiftCode: r.shiftCode,
        shiftName: r.shiftName,
        previousShiftCode: prev?.shiftCode ?? null,
        previousShiftName: prev?.shiftName ?? null,
        changedByName: r.changedByName ?? null,
        changedAt: r.createdAt.toISOString(),
        // The backfilled period: nobody made that change — it is the shift the employee already had,
        // recorded as applying since their start date. Only the FIRST period can be it.
        recordedOnRelease: i === 0 && r.createdBy == null,
      };
    }).reverse(); // ascending while previous-shift is resolved, newest-first for the screen
  });
}

// ── 0bade264 (r209) · SCHEDULE ASSIGNMENT — every employee's current arrangement, in one read ────────

/** One row of the Schedule Assignment list: who, on what, from when, and whether that is in force yet. */
export type ShiftArrangementListRow = {
  employmentId: string;
  /** The reporter's "Employee ID" (employment.employee_code). Nullable — legacy rows may have none. */
  employeeCode: string | null;
  name: string;
  company: string;
  shiftType: 'fixed' | 'roster';
  /** Null only alongside status 'notRecorded' AND an employment whose cache is empty too. */
  shiftId: string | null;
  shiftCode: string | null;
  shiftName: string | null;
  /** valid_from of the period shown. Null for 'notRecorded' — there is no dated period to name. */
  effectiveFrom: string | null;
  /**
   * `current`      — a live period is in force today (the greatest valid_from <= today).
   * `scheduled`    — the employee HAS live periods but the earliest starts after today.
   * `notRecorded`  — no live period at all; the shift shown is employment.default_shift_id, the cache
   *                  every resolver falls back to (core/shift-arrangement-resolve.ts).
   */
  status: 'current' | 'scheduled' | 'notRecorded';
};

/** Filters the Schedule Assignment screen posts as plain GET params. All optional; all narrowing. */
export type ShiftArrangementListFilters = {
  /** Free text over employee ID and name. */
  q?: string;
  shiftType?: 'fixed' | 'roster';
  /** Backup shift of the arrangement SHOWN (the resolved one), not of every period the employee has. */
  shiftId?: string;
  status?: ShiftArrangementListRow['status'];
  /** Today in the tenant's calendar. Defaults to todayInKualaLumpur(); injectable so a test can pin it. */
  today?: string;
};

/** LIKE metacharacters escaped so a code containing '%' or '_' searches for itself. */
function likeLiteral(v: string): string {
  return v.replace(/([\\%_])/g, '\\$1');
}

/**
 * Every ACTIVE employee's shift arrangement as it stands, for the Schedule Assignment screen.
 *
 * WHAT "CURRENT" MEANS HERE, AND WHY THIS FUNCTION DOES NOT DECIDE IT. The arrangement ladder has a
 * partial unique index — employment_shift_arrangement_live_uq on (tenant, employment, valid_from) WHERE
 * superseded_at IS NULL — and that predicate IS the definition of a live period: a save for a date that
 * already has one supersedes its predecessor rather than adding a second. `liveArrangementsTx` reads
 * exactly that predicate, and `pickArrangementOn` applies the one house rule for choosing among the
 * survivors (greatest valid_from <= the date; else the earliest). Both live in
 * core/shift-arrangement-resolve.ts and are shared with the attendance/OT derivation, the personnel card
 * and the roster resolver — so this screen answers "which shift is this person on" with the same
 * sentence the engine uses. DO NOT sort the periods here and take the last: a second rule is how a list
 * starts disagreeing with the payslip it is meant to explain.
 *
 * TERMINATED EMPLOYMENTS ARE OUT. They have no current arrangement to assign; their history stays on
 * their own profile, where shiftArrangementHistory already renders it.
 *
 * Unpaginated by design, like the shift library it sits beside: the filters narrow, and the screen is a
 * working list an administrator scans rather than a report they page through.
 */
export function listShiftArrangements(
  ctx: SessionContext,
  filters: ShiftArrangementListFilters = {},
): Promise<ShiftArrangementListRow[]> {
  return withTenant(ctx, async (tx) => {
    const today = filters.today ?? todayInKualaLumpur();
    const q = filters.q?.trim();
    const conds = [isNull(employment.terminatedOn)];
    if (q) {
      const pattern = `%${likeLiteral(q)}%`;
      // Non-null assertion: `or` is only undefined when given no arguments.
      conds.push(or(ilike(person.fullName, pattern), ilike(employment.employeeCode, pattern))!);
    }

    const emps = await tx
      .select({
        employmentId: employment.id,
        employeeCode: employment.employeeCode,
        name: person.fullName,
        company: company.legalName,
        // The CACHE (employment.default_shift_id / shift_type) — read only for an employment with no
        // ladder row at all, which is the exact fallback every other resolver makes. Reading it for
        // everyone else would put a stale answer on screen the moment a future-dated change is saved.
        cachedShiftType: employment.shiftType,
        cachedShiftId: employment.defaultShiftId,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(and(...conds))
      .orderBy(asc(person.fullName));

    // ONE batched read of the ladder for the whole page, and one of the shift library, rather than a
    // query per row.
    const periodsByEmployment = await liveArrangementsTx(
      tx,
      emps.map((e) => e.employmentId),
    );
    const shifts = await tx.select({ id: shift.id, code: shift.code, name: shift.name }).from(shift);
    const shiftById = new Map(shifts.map((s) => [s.id, s]));

    const rows: ShiftArrangementListRow[] = emps.map((e) => {
      const periods = periodsByEmployment.get(e.employmentId);
      const inForce = pickArrangementOn(periods, today);
      // pickArrangementOn resolves a date BEFORE the earliest period to that earliest period (the
      // release promise — see its header). For a LIST that means "their first arrangement has not
      // started yet", which is a different thing from "this is what they are on today" and is said so.
      const status: ShiftArrangementListRow['status'] = !inForce
        ? 'notRecorded'
        : inForce.validFrom <= today
          ? 'current'
          : 'scheduled';
      const shiftId = inForce ? inForce.shiftId : e.cachedShiftId;
      const sh = shiftId ? shiftById.get(shiftId) : undefined;
      return {
        employmentId: e.employmentId,
        employeeCode: e.employeeCode,
        name: e.name,
        company: e.company,
        shiftType: inForce ? inForce.shiftType : e.cachedShiftType,
        shiftId: shiftId ?? null,
        shiftCode: sh?.code ?? null,
        shiftName: sh?.name ?? null,
        effectiveFrom: inForce ? inForce.validFrom : null,
        status,
      };
    });

    // The three narrowing filters are applied to the RESOLVED row, not to the ladder: filtering the
    // periods in SQL would match an employee on a shift they used to be on (or will be on) and then
    // display the one they are actually on — a list whose rows contradict their own filter.
    return rows.filter(
      (r) =>
        (!filters.shiftType || r.shiftType === filters.shiftType) &&
        (!filters.shiftId || r.shiftId === filters.shiftId) &&
        (!filters.status || r.status === filters.status),
    );
  });
}
