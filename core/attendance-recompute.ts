/**
 * Recompute Attendance (feedback 1c1b321a) — re-work already-recorded days against the settings the
 * tenant actually has now.
 *
 * THE PROBLEM. A day's figures are decided once, at the moment someone clocks out, and then kept. Change
 * the shift afterwards — its start, its break schedule, its normal-hours rounding, its overtime windows —
 * and every day already recorded keeps the figures it was given under the old settings. The Records
 * screens make that visible, because they read the shift LIVE: a day can show a shift that now starts at
 * 08:30 sitting next to a Late mark that was measured against 08:00.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. This is a new SCOPE and a new SCREEN over machinery that already
 * ships. It is the THIRD path that re-derives a whole day against a fresh schedule and writes the result;
 * the other two are approving a clock-time correction (core/attendance.ts decideAttendanceCorrection) and
 * re-uploading a clocking file (importAttendancePunches). All three resolve the schedule fresh, all three
 * re-decide the day type from the calendar and the roster, and all three write through the same
 * stage1Columns helper. Recompute follows them rather than introducing a fourth behaviour.
 *
 * THE HARD BOUNDARY. Only CALCULATED figures are rewritten. `check_in_at` and `check_out_at` are read and
 * never written — they are the input, not the output. That is the reporter's explicit requirement, and it
 * is enforced structurally: core/attendance.ts recomputeDayFigures cannot return those two columns.
 *
 * DAYS IT REFUSES TO GUESS AT. A stored day with a clock-in and no clock-out cannot be worked out
 * cleanly, so it is reported as needing review and left EXACTLY as it is. Days with no clocking at all are
 * outside this entirely: absence is implicit in this schema (no row), and there is nothing to re-work
 * where nothing was recorded.
 *
 * ALREADY-PAID DAYS. Where a refreshed day belongs to a pay run that has already been processed, nothing
 * about that run is edited — no payslip, no total. The run's existing needs-recalculation notice is raised
 * instead (core/payroll.ts markBatchNeedsRecalc), and the preview says so before anything is applied.
 *
 * IDEMPOTENCE is structural rather than defended: every written value is a pure function of (stored punch
 * times, current schedule, date), so a second run over the same range writes the same values and reports
 * zero updated. test/attendance-recompute.test.ts pins it.
 *
 * PERMANENCE. Every run is kept in the domain-event ledger: one `attendance.recomputed` event per changed
 * day, plus one `attendance-recompute.run` event carrying the whole per-day before/after array. That run
 * event is what lets the screen re-open a past run, and it is why the history needs no table of its own.
 */
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { recomputeDayFigures, type DayType } from './attendance';
import { batchesCoveringAttendanceDates, markBatchNeedsRecalc } from './payroll';
import { assignment, attendance, attendanceCorrection, employment, person } from '../db/schema';

/** Why a stored day was left alone. Every value here means "untouched", never "guessed at". */
export type RecomputeFlagReason =
  /** A clock-in with no clock-out. The day cannot be worked out cleanly, so it is not worked out at all. */
  | 'missing-clock-out'
  /** No clock-in on a stored row (defensive — the engine cannot derive anything without one). */
  | 'no-clock-in'
  /** A stored `absent` row. Nothing in the tree writes this status and deriveAttendance cannot produce it,
   *  so this is a defensive skip rather than a case with a producer. */
  | 'stored-absent';

/** The calculated figures of one day — the complete set this feature may rewrite, and therefore the
 *  complete set the preview shows side by side. Deliberately mirrors the attendance columns 1:1. */
export type RecomputeFigures = {
  status: string;
  dayType: DayType | null;
  workedMinutes: number | null;
  otMinutes: number | null;
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  underMinutes: number | null;
  lateDeductMinutes: number | null;
  earlyOutDeductMinutes: number | null;
  otFlatMinutes: number | null;
  ot00Minutes: number | null;
  ot10Minutes: number | null;
  ot15Minutes: number | null;
  ot20Minutes: number | null;
  ot30Minutes: number | null;
};

/** One day that WOULD change (preview) or DID change (apply), as it stands now and as it becomes. */
export type RecomputeRow = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  date: string;
  /** The shift the day was measured against; null on a rest day or a company-policy day. */
  shiftCode: string | null;
  /** Shown so the screen can state plainly that these two never move. Never written. */
  checkInAt: string;
  checkOutAt: string | null;
  before: RecomputeFigures;
  after: RecomputeFigures;
  /** True when a human-approved OT figure was kept and only its per-rate split recut (ADR-0069). */
  otPreserved: boolean;
};

/** A day left exactly as it is, and why. */
export type RecomputeFlag = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  date: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  reason: RecomputeFlagReason;
};

/** An already-processed pay run that owns at least one changed day. Nothing on the run is edited. */
export type RecomputeBatchWarning = {
  batchId: string;
  payPeriod: string;
  batchDate: string;
  employmentIds: string[];
};

export type RecomputeResult = {
  runId: string;
  dryRun: boolean;
  ranAt: string;
  companyId: string;
  departmentId: string | null;
  employmentIds: string[] | null;
  from: string;
  to: string;
  /** Stored days inside the scope that were looked at (flagged days included — they were checked). */
  checked: number;
  updated: number;
  unchanged: number;
  flagged: number;
  rows: RecomputeRow[];
  flags: RecomputeFlag[];
  batchWarnings: RecomputeBatchWarning[];
};

export type RecomputeScope = {
  companyId: string;
  departmentId?: string | null;
  employmentIds?: string[] | null;
  from: string;
  to: string;
  dryRun: boolean;
};

export class RecomputeScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecomputeScopeError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every calculated column of a stored attendance row, in the order the preview reads them. */
const figuresOf = (r: {
  status: string;
  dayType: DayType | null;
  workedMinutes: number | null;
  otMinutes: number | null;
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  underMinutes: number | null;
  lateDeductMinutes: number | null;
  earlyOutDeductMinutes: number | null;
  otFlatMinutes: number | null;
  ot00Minutes: number | null;
  ot10Minutes: number | null;
  ot15Minutes: number | null;
  ot20Minutes: number | null;
  ot30Minutes: number | null;
}): RecomputeFigures => ({
  status: r.status,
  dayType: r.dayType,
  workedMinutes: r.workedMinutes,
  otMinutes: r.otMinutes,
  lateMinutes: r.lateMinutes,
  earlyOutMinutes: r.earlyOutMinutes,
  underMinutes: r.underMinutes,
  lateDeductMinutes: r.lateDeductMinutes,
  earlyOutDeductMinutes: r.earlyOutDeductMinutes,
  otFlatMinutes: r.otFlatMinutes,
  ot00Minutes: r.ot00Minutes,
  ot10Minutes: r.ot10Minutes,
  ot15Minutes: r.ot15Minutes,
  ot20Minutes: r.ot20Minutes,
  ot30Minutes: r.ot30Minutes,
});

/** Field-by-field equality over the figures.
 *
 *  `calc_trace` is deliberately NOT compared: it is the WORKING behind the figures, it carries a version
 *  stamp, and a trace-only difference is not a change any reader would recognise as one. Comparing it
 *  would report a whole company as "updated" the first time a trace version moves.
 *
 *  A row whose figures all match is counted unchanged and NOT WRITTEN AT ALL. That is deliberate: it is
 *  what makes "run the same range twice and the second run changes nothing" a property of the code rather
 *  than a claim about it, and it keeps a recompute off rows it has nothing to say about. The documented
 *  consequence is that an unchanged day does not get a refreshed trace — correct, since the trace it
 *  already carries explains the same figures. */
const sameFigures = (a: RecomputeFigures, b: RecomputeFigures): boolean =>
  (Object.keys(a) as (keyof RecomputeFigures)[]).every((k) => a[k] === b[k]);

/**
 * Preview or apply a recompute over one company, optionally narrowed to a department or to specific
 * employees, across a date range.
 *
 * `dryRun: true` writes NOTHING — no attendance column, no event, no batch mark — and returns exactly the
 * shape an apply would, including the pay-run warnings, so the screen previews the real consequence.
 */
export async function recomputeAttendance(ctx: SessionContext, p: RecomputeScope): Promise<RecomputeResult> {
  if (!ISO_DATE.test(p.from) || !ISO_DATE.test(p.to)) {
    throw new RecomputeScopeError('A date range is required (YYYY-MM-DD).');
  }
  if (p.from > p.to) throw new RecomputeScopeError('The start date must not be after the end date.');
  if (!p.companyId) throw new RecomputeScopeError('A company is required.');

  const runId = randomUUID();
  const ranAt = new Date().toISOString();
  const narrowed = p.employmentIds && p.employmentIds.length > 0 ? p.employmentIds : null;

  return withTenant(ctx, async (tx) => {
    // The employment set, through the SAME current-assignment join attendanceForDate uses for its
    // department filter, so the two screens cannot disagree about who is in a department. RLS fences the
    // company to the caller's scope; an out-of-scope companyId simply selects nobody.
    const currentAssignment = and(
      eq(assignment.employmentId, employment.id),
      isNull(assignment.validTo),
      isNull(assignment.supersededAt),
    );
    const people = await tx
      .select({
        employmentId: employment.id,
        employeeCode: employment.employeeCode,
        name: person.fullName,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .where(
        and(
          eq(employment.companyId, p.companyId),
          isNull(employment.terminatedOn),
          p.departmentId ? eq(assignment.departmentId, p.departmentId) : undefined,
          narrowed ? inArray(employment.id, narrowed) : undefined,
        ),
      )
      .orderBy(asc(person.fullName));

    const empty: RecomputeResult = {
      runId,
      dryRun: p.dryRun,
      ranAt,
      companyId: p.companyId,
      departmentId: p.departmentId ?? null,
      employmentIds: narrowed,
      from: p.from,
      to: p.to,
      checked: 0,
      updated: 0,
      unchanged: 0,
      flagged: 0,
      rows: [],
      flags: [],
      batchWarnings: [],
    };
    if (people.length === 0) return empty;

    const empIds = people.map((x) => x.employmentId);
    const who = new Map(people.map((x) => [x.employmentId, x]));

    // The stored days. Only rows that EXIST are in scope: a day with no attendance row shows as Absent
    // because nothing was recorded, and there is nothing to re-work where nothing was recorded.
    const rows = await tx
      .select({
        id: attendance.id,
        employmentId: attendance.employmentId,
        date: attendance.attendanceDate,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        status: attendance.status,
        dayType: attendance.dayType,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
        lateMinutes: attendance.lateMinutes,
        earlyOutMinutes: attendance.earlyOutMinutes,
        underMinutes: attendance.underMinutes,
        lateDeductMinutes: attendance.lateDeductMinutes,
        earlyOutDeductMinutes: attendance.earlyOutDeductMinutes,
        otFlatMinutes: attendance.otFlatMinutes,
        ot00Minutes: attendance.ot00Minutes,
        ot10Minutes: attendance.ot10Minutes,
        ot15Minutes: attendance.ot15Minutes,
        ot20Minutes: attendance.ot20Minutes,
        ot30Minutes: attendance.ot30Minutes,
      })
      .from(attendance)
      .where(
        and(
          inArray(attendance.employmentId, empIds),
          gte(attendance.attendanceDate, p.from),
          lte(attendance.attendanceDate, p.to),
        ),
      )
      .orderBy(asc(attendance.attendanceDate), asc(attendance.employmentId));
    if (rows.length === 0) return empty;

    // ADR-0069 — the human-approved OT figures in range. A recompute refreshes the MEASURED figures beside
    // an approved OT total; it never overwrites the total itself (TOIL auto-accrual reads it).
    const approvals = await tx
      .select({
        employmentId: attendanceCorrection.employmentId,
        date: attendanceCorrection.attendanceDate,
        approvedOtMinutes: attendanceCorrection.approvedOtMinutes,
      })
      .from(attendanceCorrection)
      .where(
        and(
          inArray(attendanceCorrection.employmentId, empIds),
          gte(attendanceCorrection.attendanceDate, p.from),
          lte(attendanceCorrection.attendanceDate, p.to),
          eq(attendanceCorrection.status, 'approved'),
        ),
      );
    const approvedOt = new Map<string, number>();
    for (const a of approvals) {
      if (a.approvedOtMinutes != null) approvedOt.set(`${a.employmentId}|${a.date}`, a.approvedOtMinutes);
    }

    // The changed days and, beside each, the attendance row id and the exact column bag to write. Kept as
    // ONE list so the write, the per-day event and the reported row can never fall out of step.
    const changed: { row: RecomputeRow; attendanceId: string; columns: Record<string, unknown> }[] = [];
    const flags: RecomputeFlag[] = [];
    let unchanged = 0;

    for (const r of rows) {
      const id = who.get(r.employmentId)!;
      if (r.status === 'absent') {
        flags.push({ ...idOf(id), date: r.date, checkInAt: r.checkInAt, checkOutAt: r.checkOutAt, reason: 'stored-absent' });
        continue;
      }
      if (r.checkInAt == null) {
        flags.push({ ...idOf(id), date: r.date, checkInAt: null, checkOutAt: r.checkOutAt, reason: 'no-clock-in' });
        continue;
      }
      if (r.checkOutAt == null) {
        flags.push({ ...idOf(id), date: r.date, checkInAt: r.checkInAt, checkOutAt: null, reason: 'missing-clock-out' });
        continue;
      }
      const d = await recomputeDayFigures(tx, {
        employmentId: r.employmentId,
        date: r.date,
        checkInAt: r.checkInAt,
        checkOutAt: r.checkOutAt,
        approvedOtMinutes: approvedOt.get(`${r.employmentId}|${r.date}`) ?? null,
      });
      const before = figuresOf(r);
      const after = figuresOf(d.columns);
      if (sameFigures(before, after)) {
        unchanged += 1;
        continue;
      }
      changed.push({
        attendanceId: r.id,
        columns: d.columns,
        row: {
          ...idOf(id),
          date: r.date,
          shiftCode: d.shiftCode,
          checkInAt: r.checkInAt,
          checkOutAt: r.checkOutAt,
          before,
          after,
          otPreserved: d.otPreserved,
        },
      });
    }
    const changedRows = changed.map((c) => c.row);

    // The pay-run interlock. Computed for the PREVIEW too, read-only, from exactly the days that would
    // move — so the warning the reporter sees before pressing Apply is the same set Apply then raises.
    // Only worked/OT movements can change what a run paid; a lateness-only refresh does not.
    const payAffecting = changedRows
      .filter((c) => c.before.workedMinutes !== c.after.workedMinutes || c.before.otMinutes !== c.after.otMinutes)
      .map((c) => ({ employmentId: c.employmentId, date: c.date }));
    const batchWarnings = await batchesCoveringAttendanceDates(tx, {
      companyId: p.companyId,
      entries: payAffecting,
    });

    const result: RecomputeResult = {
      runId,
      dryRun: p.dryRun,
      ranAt,
      companyId: p.companyId,
      departmentId: p.departmentId ?? null,
      employmentIds: narrowed,
      from: p.from,
      to: p.to,
      checked: rows.length,
      updated: changed.length,
      unchanged,
      flagged: flags.length,
      rows: changedRows,
      flags,
      batchWarnings,
    };
    if (p.dryRun) return result;

    for (const c of changed) {
      await tx.update(attendance).set(c.columns).where(eq(attendance.id, c.attendanceId));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'attendance',
        aggregateId: c.attendanceId,
        eventType: 'attendance.recomputed',
        actor: actorOf(ctx),
        subjectEmploymentId: c.row.employmentId,
        // Minutes only — the same precedent attendance.amended already sets (ADR-0030 Layer 0).
        payload: { runId, date: c.row.date, before: c.row.before, after: c.row.after },
      });
    }
    // The run event. It carries the WHOLE per-day array because that array is the run history: the screen
    // re-opens a past run by reading this payload back, and /admin/audit renders no payloads at all. At
    // tenant scale (hundreds of attendance rows) the payload is small.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-recompute',
      aggregateId: runId,
      eventType: 'attendance-recompute.run',
      actor: actorOf(ctx),
      // No subject: a run spans employees, so it is admin-only to read (fail-closed, ADR-0015).
      payload: {
        runId,
        companyId: p.companyId,
        departmentId: p.departmentId ?? null,
        employmentIds: narrowed,
        from: p.from,
        to: p.to,
        checked: result.checked,
        updated: result.updated,
        unchanged: result.unchanged,
        flagged: result.flagged,
        rows: changedRows,
        flags,
        batchWarnings,
      },
    });
    // Raise each affected processed run's EXISTING needs-recalculation notice, in this same transaction.
    // No payslip and no run total is edited: markBatchNeedsRecalc sets the mark, appends the run's own
    // `payroll-batch.recalc-required` event, and is already a no-op for draft and closed runs.
    for (const b of batchWarnings) {
      await markBatchNeedsRecalc(tx, ctx, { batchId: b.batchId, employmentIds: b.employmentIds });
    }
    return result;
  });
}

const idOf = (x: { employmentId: string; employeeCode: string | null; name: string }) => ({
  employmentId: x.employmentId,
  employeeCode: x.employeeCode,
  name: x.name,
});

/** One past run, rebuilt from its stored `attendance-recompute.run` event — the Recent Recomputes list and
 *  the re-open. Read-only; the payload IS the record, so nothing is recomputed to render it. */
export type RecomputeRunSummary = {
  runId: string;
  occurredAt: string;
  actorName: string | null;
  companyId: string;
  departmentId: string | null;
  employmentIds: string[] | null;
  from: string;
  to: string;
  checked: number;
  updated: number;
  unchanged: number;
  flagged: number;
  rows: RecomputeRow[];
  flags: RecomputeFlag[];
  batchWarnings: RecomputeBatchWarning[];
};

/**
 * Rebuild the Recent Recomputes list from `attendance-recompute.run` ledger rows.
 *
 * A PURE function over rows the caller already fetched (`auditEvents(s, { aggregateType:
 * 'attendance-recompute' })`), deliberately: the ledger read stays access-fenced where it belongs, this
 * module gains no dependency on core/read.ts, and the mapping is testable without a database.
 *
 * Every field is read defensively. These payloads are PERMANENT and will outlive the build that wrote
 * them, so a row whose payload predates a field renders with that field empty rather than throwing the
 * whole list away.
 */
export function recomputeRunsFromEvents(
  events: { aggregateId: string; eventType: string; actorName: string | null; payload: unknown; occurredAt: Date }[],
): RecomputeRunSummary[] {
  const out: RecomputeRunSummary[] = [];
  for (const e of events) {
    if (e.eventType !== 'attendance-recompute.run') continue;
    const pl = (e.payload ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' ? v : 0);
    out.push({
      runId: typeof pl.runId === 'string' ? pl.runId : e.aggregateId,
      occurredAt: e.occurredAt instanceof Date ? e.occurredAt.toISOString() : String(e.occurredAt),
      actorName: e.actorName,
      companyId: typeof pl.companyId === 'string' ? pl.companyId : '',
      departmentId: typeof pl.departmentId === 'string' ? pl.departmentId : null,
      employmentIds: Array.isArray(pl.employmentIds) ? (pl.employmentIds as string[]) : null,
      from: typeof pl.from === 'string' ? pl.from : '',
      to: typeof pl.to === 'string' ? pl.to : '',
      checked: num(pl.checked),
      updated: num(pl.updated),
      unchanged: num(pl.unchanged),
      flagged: num(pl.flagged),
      rows: Array.isArray(pl.rows) ? (pl.rows as RecomputeRow[]) : [],
      flags: Array.isArray(pl.flags) ? (pl.flags as RecomputeFlag[]) : [],
      batchWarnings: Array.isArray(pl.batchWarnings) ? (pl.batchWarnings as RecomputeBatchWarning[]) : [],
    });
  }
  return out;
}
