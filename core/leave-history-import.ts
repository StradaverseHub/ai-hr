/**
 * 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT: bulk-load past leave RECORDS for a migration.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS BESIDE `core/leave-import.ts`, AND WHY THEY ARE NOT DUPLICATES
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A customer arriving on this platform brings two different things:
 *
 *   BALANCES — `core/leave-import.ts` (Leave Config › Leave Adjustments › Leave Balance Import). It
 *              writes `leave_ledger` rows and nothing else; its own header says "ledger-only". Every
 *              balance figure in the product is a signed sum over that table, so that tool moves the
 *              numbers and leaves no record behind.
 *   RECORDS  — this module. Leave History is built ENTIRELY from `leave_request` (core/read.ts's
 *              `leaveRequestSelection`, the shared projection behind `listLeaveRequests` and
 *              `listLeaveRequestsPage`). So a past leave with its original reference, dates and
 *              remark must land there. No parallel table: anything stored outside `leave_request` is
 *              invisible to every history surface, which is the whole point of the item.
 *
 * They are complements. Together you get a complete picture; either alone is half a migration.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ THE LOAD-BEARING DECISION: AN IMPORTED RECORD WRITES NO LEDGER ROW
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The reporter raised this themselves (ticket point 9) and the approved plan answers it: importing
 * history does NOT touch anybody's leave balance.
 *
 * THE EVIDENCE, not the intuition. A normal approval writes BOTH halves — `finalizeLeaveApproval`
 * (core/leave.ts) inserts the `leave_ledger` debit AND flips the request to approved. Balances derive
 * from the ledger alone, and even "Taken" is derived from ledger debits carrying a `source_request_id`
 * (core/read.ts). A migrated OPENING BALANCE already has the past leave removed from it — that is what
 * an opening balance is — so a record-plus-debit import would deduct the same days a second time, off
 * a figure that is encashed at termination (core/leave-encashment.ts). Record-only is therefore not
 * caution; it is the only arithmetic that adds up.
 *
 * TWO CONSEQUENCES, disclosed to the reporter in the approved plan and true by construction here:
 *   · an imported record appears in Leave History but is NOT in the "Taken" figure on the balance
 *     screens — that figure counts what actually came off the balance, and by design nothing did;
 *   · cancelling an imported record gives nothing back, because `chargedDays` is a sum over the same
 *     ledger link, guarded by `> 0`. Correct: nothing was ever taken.
 *
 * WHAT THAT DECISION COST ELSEWHERE, and what r362 did about it. An approved `leave_request` with no
 * sourced ledger debit is a shape this system had never had, so three money paths were read line by
 * line before this module was written and two of them were wrong for it:
 *
 *   1. core/leave.ts `applyLeaveCancellationApprovalTx` — the whole-span reversal is guarded on
 *      `chargedDays > 0`, but the PER-SEGMENT RE-DEBIT was not. Giving back one day of a five-day
 *      uncharged record reversed nothing and then inserted a fresh −4.00 debit: a deduction with no
 *      matching credit. FIXED in r362 (`wasCharged`), and the fix also closes the same hole for an
 *      approved UNPAID-type request, where it was already live.
 *   2. core/payroll.ts `unpaidDaysByEmployment` (and its multi-cycle copy) reads `leave_request`, not
 *      the ledger, and admits any approved request of an unpaid type starting in the period. One
 *      imported unpaid record dated inside a not-yet-run period would have cut that person's salary.
 *      FIXED in r362: `imported_history` rows are excluded. A migration tool must not move money.
 *   3. core/leave-encashment.ts `approvedLeaveDaysAfter` raises a final-pay hint whose premise
 *      ("already debited at approval") is false for these rows, and whose documented remedy (cancel
 *      the request) correctly gives back nothing — a loop that cannot close. FIXED: excluded.
 *
 * KNOWN AND DELIBERATELY NOT CHANGED: `approvedLeaveDates` (core/leave.ts) is THE span authority for
 * attendance, roster and absence counting, and it will now see imported rows, so an imported record
 * suppresses an absence on its dates. That is defensible on the merits (the person WAS on leave) and
 * inert for a migration, whose dates precede go-live and have no attendance behind them. Narrowing a
 * four-pack authority for this item would be a far larger change than the item, so it is named here
 * rather than made quietly. RISK, low: importing a record into a live, unrun payroll month could
 * suppress an absent-day deduction. The tool is for history; this is not.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * SHAPE, COPIED FROM THE IMPORTERS THAT ALREADY WORK
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One private `analyze()`; two public exports (`validateLeaveHistoryImport` dry-run,
 * `commitLeaveHistoryImport`); the commit RE-RUNS analyze server-side so a tampered client preview can
 * never widen what is written. Per-row AUTHORITY is checked inside analyze (not deferred to commit) so
 * the preview can never show a false "Valid" for a row RLS would reject — core/leave-import.ts's rule.
 *
 * NOT ATOMIC, BY DESIGN AND BY THE APPROVED PLAN. Each accepted row writes in its OWN `withTenant`
 * transaction, so a per-row RLS or FK failure aborts that row only. A single shared transaction goes
 * into an aborted state on the first failure and takes every later insert — and the run-log write —
 * down with it, which is the opposite of what the ticket asks for ("do not silently skip them… tell
 * the user which records were not imported and why"). This mirrors `commitLeaveImport` and
 * `commitEmployeeImport` exactly.
 *
 * IDEMPOTENT ON RE-UPLOAD, and enforced in two places on purpose. `analyze()` marks a row `duplicate`
 * when its Leave Reference already exists (in this file, or already in `leave_request`), and the
 * PARTIAL UNIQUE INDEX from migration 0490 is the backstop for the race analyze cannot see. Importing
 * the same file twice therefore imports nothing the second time and reports every row as a duplicate,
 * which is a success, not a failure.
 *
 * THE FILE'S FIGURE IS THE FIGURE THAT IS KEPT. Where `Number of Day` disagrees with what this
 * system's calendar works out from the start and end dates, the row is FLAGGED and still imported. The
 * old system's rest days and holidays are not ours; a migration that rejected rows on our arithmetic
 * would throw out good history wholesale. Same call, and the same reasoning, as decision 6 of
 * core/payroll-history-import.ts.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  appUser,
  employment,
  leaveHistoryImportRun,
  leaveRequest,
  person,
} from '../db/schema';
import { isGroupAdmin, hasGrantFor, withEffectiveGrants } from '../lib/authz';
import {
  LEAVE_HISTORY_COLUMNS,
  LEAVE_HISTORY_REQUIRED_KEYS,
  canonicalColumnKey,
  type LeaveHistoryImportError,
  type LeaveHistoryImportPreview,
  type LeaveHistoryImportResult,
  type LeaveHistoryImportSource,
  type LeaveHistoryRecord,
  type LeaveHistoryRowResult,
  type LeaveHistoryRowStatus,
  type LeaveHistoryRunRow,
} from '../lib/leave-history-import-schema';
import { holidayDatesByEmployment } from './holidays';
import { resolveWorkingDaysIso, workingDays } from './leave';
import { listLeaveTypes } from './read';

export {
  LEAVE_HISTORY_COLUMNS,
  canonicalColumnKey,
  type LeaveHistoryImportError,
  type LeaveHistoryImportPreview,
  type LeaveHistoryImportResult,
  type LeaveHistoryImportSource,
  type LeaveHistoryRecord,
  type LeaveHistoryRowResult,
  type LeaveHistoryRowStatus,
  type LeaveHistoryRunRow,
};

/** YYYY-MM-DD with real month/day ranges (mirrors DATE_RE in core/leave-import.ts). */
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Excel and most legacy exports write one of these three. Anything else is reported, never guessed. */
const DMY_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

/** How many rejected rows the run log keeps. The screen says so when the cap bit (0341's rule). */
export const LEAVE_HISTORY_ERROR_CAP = 200;
/** How many past runs the log on the screen shows. */
export const LEAVE_HISTORY_RUN_LIMIT = 20;

const norm = (s: string | undefined) => (s ?? '').trim();
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A date cell → ISO, or null when it is not a date at all.
 *
 * ISO is accepted as written. `dd/mm/yyyy` and `dd-mm-yyyy` are accepted because that is what a
 * Malaysian HR export writes and what Excel shows a Malaysian user; `mm/dd/yyyy` is NOT guessed at,
 * because 03/04/2025 is a real date under both readings and silently choosing one would mis-date leave
 * with no way for anyone to notice. A file in that format reports an invalid date, which is loud.
 *
 * The round trip through Date is deliberate: it rejects 31/02/2025, which the regex alone accepts.
 */
function toIsoDate(raw: string): string | null {
  const s = norm(raw);
  if (s === '') return null;
  if (ISO_DATE_RE.test(s)) return isRealDate(s) ? s : null;
  const m = DMY_RE.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return ISO_DATE_RE.test(iso) && isRealDate(iso) ? iso : null;
}

/** True when the ISO string names a date that exists (rejects 2025-02-31, which the regex allows). */
function isRealDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/**
 * A business DATE → the instant to stamp on a timestamptz column.
 *
 * Midnight Asia/Kuala_Lumpur (the product's business clock, lib/hr-date.ts), not midnight UTC.
 * `created_at` and `decided_at` are read back and FORMATTED in the tenant's calendar, so a row stamped
 * at 00:00Z shows as the PREVIOUS day for the eight hours between the two midnights — the same
 * off-by-one-day class `todayInKualaLumpur` exists for. Malaysia has a fixed +08:00 offset and no DST,
 * so the offset is written as a literal; there is no zone rule here that could change under it.
 */
function startOfBusinessDay(iso: string): Date {
  return new Date(`${iso}T00:00:00+08:00`);
}

/** A row that passed validation and is ready to write, paired with its preview result. */
type ResolvedRow = {
  result: LeaveHistoryRowResult;
  employmentId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  days: number;
  durationType: 'full_day' | 'half_day_am' | 'half_day_pm';
  externalReference: string;
  entitlementYear: number | null;
  entryDate: string | null;
  submitDate: string | null;
  approvedDate: string | null;
  remark: string;
};

/**
 * Re-key a record onto the contract's canonical keys. `parseCsvRecords` lower-cases and underscores a
 * header but keeps punctuation, so the reporter's own "Employee No." arrives as `employee_no.`; the
 * canonicaliser closes that gap (and the short alias table handles the three spellings a customer's own
 * export plausibly already uses). Unknown headers are kept under their canonical form and ignored —
 * a migration file routinely carries extra columns and refusing the file over them helps nobody.
 */
function canonicalise(rec: LeaveHistoryRecord): LeaveHistoryRecord {
  const out: LeaveHistoryRecord = {};
  for (const [k, v] of Object.entries(rec)) {
    const key = canonicalColumnKey(k);
    // First spelling wins, so a file carrying BOTH `employee_no` and an alias of it is not reordered
    // into a different answer by object key order.
    if (!(key in out)) out[key] = v;
  }
  return out;
}

/**
 * Pure validation phase (dry run). Reads the tenant's employments, leave types and existing references
 * once, then validates each record in memory, then makes ONE pass for the calendar day-count check.
 */
async function analyze(
  ctx: SessionContext,
  rawRecords: LeaveHistoryRecord[],
): Promise<{ preview: LeaveHistoryImportPreview; resolved: ResolvedRow[] }> {
  const records = rawRecords.map(canonicalise);
  const effective = withEffectiveGrants(ctx);
  const groupAdmin = isGroupAdmin(effective);

  // Leave types by code, case-insensitive, non-archived (listLeaveTypes excludes archived by default).
  const types = await listLeaveTypes(ctx);
  const typeByCode = new Map(types.map((t) => [t.code.toLowerCase(), t.id]));

  const { emps, existingRefs } = await withTenant(ctx, async (tx) => {
    // Every employment the caller may see (RLS-scoped). NOT active-only: a migration's history is
    // mostly about people who were here then, including some who have since left.
    const rows = await tx
      .select({
        id: employment.id,
        companyId: employment.companyId,
        code: employment.employeeCode,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment);
    // Leave references already in the system. `employment_employee_code_uq` (tenant_id, employee_code)
    // and `leave_request_external_reference_uq` (tenant_id, external_reference) are the DB invariants
    // behind treating both of these as maps rather than as multimaps.
    const refs = await tx
      .select({ ref: leaveRequest.externalReference })
      .from(leaveRequest)
      .where(isNotNull(leaveRequest.externalReference));
    return {
      emps: rows,
      existingRefs: new Set(refs.map((r) => (r.ref ?? '').toLowerCase()).filter((r) => r !== '')),
    };
  });

  const byCode = new Map<string, { id: string; companyId: string; terminated: boolean }>();
  for (const e of emps) {
    if (e.code) {
      byCode.set(e.code.toLowerCase(), {
        id: e.id,
        companyId: e.companyId,
        terminated: e.terminatedOn != null,
      });
    }
  }

  const presentColumns = new Set(
    records.length ? Object.keys(records[0]) : [],
  );
  const missingColumns = LEAVE_HISTORY_REQUIRED_KEYS.filter((c) => !presentColumns.has(c));

  const seenRefs = new Set<string>(); // in-file reference dedupe
  const resolved: ResolvedRow[] = [];
  /** Rows whose day count is worth checking against our calendar, resolved in the second pass. */
  const dayCheck: { idx: number; employmentId: string; start: string; end: string; days: number }[] = [];

  records.forEach((rec, idx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const employeeNo = norm(rec.employee_no);
    const leaveReference = norm(rec.leave_reference);
    const leaveCode = norm(rec.leave_code);
    const entitlementYearRaw = norm(rec.entitlement_year);
    const startRaw = norm(rec.leave_start_date);
    const endRaw = norm(rec.leave_end_date);
    const daysRaw = norm(rec.number_of_day).replace(/[,_]/g, '');
    const sessionRaw = norm(rec.session).toUpperCase();
    const entryRaw = norm(rec.entry_date);
    const submitRaw = norm(rec.submit_date);
    const approvedRaw = norm(rec.approved_date);
    const remark = norm(rec.remark);

    // ── Employee ────────────────────────────────────────────────────────────────────────────────
    if (!employeeNo) errors.push('Employee No. is required');
    const emp = employeeNo ? byCode.get(employeeNo.toLowerCase()) : undefined;
    if (employeeNo && !emp) errors.push('Employee No. not found');
    if (emp?.terminated) warnings.push('Employee has been terminated');
    // Authority here, not at commit, so the preview never shows a Valid row RLS would then refuse.
    if (emp && !(groupAdmin || hasGrantFor(effective, 'hr_admin', emp.companyId))) {
      errors.push("Not authorized for this employee's company");
    }

    // ── Leave code ──────────────────────────────────────────────────────────────────────────────
    if (!leaveCode) errors.push('Leave Code is required');
    const leaveTypeId = leaveCode ? typeByCode.get(leaveCode.toLowerCase()) : undefined;
    if (leaveCode && !leaveTypeId) errors.push('Leave Code not found');

    // ── Dates ───────────────────────────────────────────────────────────────────────────────────
    const start = toIsoDate(startRaw);
    const end = toIsoDate(endRaw);
    if (!startRaw) errors.push('Leave Start Date is required');
    else if (!start) errors.push('Invalid Leave Start Date');
    if (!endRaw) errors.push('Leave End Date is required');
    else if (!end) errors.push('Invalid Leave End Date');
    if (start && end && start > end) errors.push('Leave Start Date cannot be later than Leave End Date');

    const entryDate = entryRaw ? toIsoDate(entryRaw) : null;
    if (entryRaw && !entryDate) errors.push('Invalid Entry Date');
    const submitDate = submitRaw ? toIsoDate(submitRaw) : null;
    if (submitRaw && !submitDate) errors.push('Invalid Submit Date');
    const approvedDate = approvedRaw ? toIsoDate(approvedRaw) : null;
    if (approvedRaw && !approvedDate) errors.push('Invalid Approved Date');

    // ── Entitlement year ────────────────────────────────────────────────────────────────────────
    // Optional. Stored as stated; a disagreement with the start date's year is a WARNING, never a
    // rejection, because a leave period is configurable and a January leave can legitimately belong
    // to the previous entitlement year.
    let entitlementYear: number | null = null;
    if (entitlementYearRaw) {
      const y = Number(entitlementYearRaw);
      if (!Number.isInteger(y) || y < 1900 || y > 2999) {
        errors.push('Entitlement Year is not a valid year');
      } else {
        entitlementYear = y;
        if (start && String(y) !== start.slice(0, 4)) {
          warnings.push(`Entitlement Year ${y} does not match the leave start year ${start.slice(0, 4)}`);
        }
      }
    }

    // ── Number of Day ───────────────────────────────────────────────────────────────────────────
    let days = NaN;
    if (!daysRaw) {
      errors.push('Number of Day is required');
    } else {
      const n = Number(daysRaw);
      if (!Number.isFinite(n) || n <= 0) errors.push('Number of Day is invalid');
      else {
        days = round2(n);
        if (days > 366) errors.push('Number of Day is invalid');
      }
    }

    // ── Session ─────────────────────────────────────────────────────────────────────────────────
    // Blank for a full day or a multi-day span, exactly as the ticket asks; AM/PM is never forced.
    let durationType: ResolvedRow['durationType'] = 'full_day';
    if (sessionRaw) {
      if (sessionRaw === 'AM') durationType = 'half_day_am';
      else if (sessionRaw === 'PM') durationType = 'half_day_pm';
      else errors.push('Session must be AM, PM or blank');
      if (durationType !== 'full_day' && start && end && start !== end) {
        // Not an error: the file is the record of what happened, and a legacy system may well have
        // stamped a session on a span. The reader is told the two disagree.
        warnings.push('Session is set on a multi-day record');
      }
    }

    // ── Leave Reference, and the duplicate rule ─────────────────────────────────────────────────
    // A duplicate is its OWN status, not an error: on a re-upload of an already-loaded file it is the
    // expected answer. Checked against BOTH this file and what is already in the system, which is what
    // makes a second import of the same file a no-op.
    let duplicate = false;
    if (!leaveReference) {
      errors.push('Leave Reference is required');
    } else {
      const key = leaveReference.toLowerCase();
      if (seenRefs.has(key)) {
        duplicate = true;
        errors.push('Duplicate Leave Reference in this file');
      } else if (existingRefs.has(key)) {
        duplicate = true;
        errors.push('Leave Reference already imported');
      } else {
        seenRefs.add(key);
      }
    }

    // A row can be BOTH malformed and a duplicate. It is reported as `error` in that case: the
    // reference is the least of its problems and the reader needs the fixable reason first.
    const hardErrors = errors.filter((e) => !e.startsWith('Duplicate Leave Reference') && !e.startsWith('Leave Reference already'));
    const status: LeaveHistoryRowStatus =
      hardErrors.length > 0 ? 'error' : duplicate ? 'duplicate' : 'valid';

    if (status === 'valid' && emp && leaveTypeId && start && end && Number.isFinite(days)) {
      dayCheck.push({ idx: resolved.length, employmentId: emp.id, start, end, days });
    }

    resolved.push({
      result: {
        rowNum: idx + 1,
        employeeNo,
        leaveReference,
        leaveCode,
        entitlementYear: entitlementYearRaw,
        startDate: start ?? startRaw,
        endDate: end ?? endRaw,
        days: daysRaw,
        session: sessionRaw,
        status,
        errors,
        warnings,
      },
      employmentId: emp?.id ?? '',
      leaveTypeId: leaveTypeId ?? '',
      startDate: start ?? '',
      endDate: end ?? '',
      days: Number.isFinite(days) ? days : 0,
      durationType,
      externalReference: leaveReference,
      entitlementYear,
      entryDate,
      submitDate,
      approvedDate,
      remark,
    });
  });

  // ── The calendar day-count check, in ONE pass over the union window ───────────────────────────
  // NON-BLOCKING by design (see the header): the file's figure is what is stored. Resolved for the
  // whole batch at once — the holiday set over the union range and each employment's working-day
  // roster memoised — rather than per row, which would be one query per row on a 1,000-row file.
  if (dayCheck.length > 0) {
    const minStart = dayCheck.reduce((a, r) => (r.start < a ? r.start : a), dayCheck[0].start);
    const maxEnd = dayCheck.reduce((a, r) => (r.end > a ? r.end : a), dayCheck[0].end);
    await withTenant(ctx, async (tx) => {
      const holidays = await holidayDatesByEmployment(tx, {
        employmentIds: dayCheck.map((r) => r.employmentId),
        startDate: minStart,
        endDate: maxEnd,
      });
      const rosterMemo = new Map<string, number[]>();
      for (const r of dayCheck) {
        let roster = rosterMemo.get(r.employmentId);
        if (!roster) {
          roster = await resolveWorkingDaysIso(tx, r.employmentId);
          rosterMemo.set(r.employmentId, roster);
        }
        const expected = workingDays(r.start, r.end, holidays.get(r.employmentId) ?? new Set(), roster);
        if (round2(expected) !== r.days) {
          resolved[r.idx].result.warnings.push(
            `Our calendar makes this ${expected} day(s); the file says ${r.days}. Kept as ${r.days}.`,
          );
        }
      }
    });
  }

  const rows = resolved.map((r) => r.result);
  const preview: LeaveHistoryImportPreview = {
    total: records.length,
    validCount: rows.filter((r) => r.status === 'valid').length,
    errorCount: rows.filter((r) => r.status === 'error').length,
    duplicateCount: rows.filter((r) => r.status === 'duplicate').length,
    rows,
    missingColumns,
  };
  return { preview, resolved };
}

/** Dry run. Validates against the tenant's catalogue and existing references; writes nothing. */
export async function validateLeaveHistoryImport(
  ctx: SessionContext,
  p: { records: LeaveHistoryRecord[] },
): Promise<LeaveHistoryImportPreview> {
  const { preview } = await analyze(ctx, p.records);
  return preview;
}

/**
 * Commit the valid rows, and only those. Re-runs `analyze()` server-side (never trusts the client
 * preview), writes one `leave_request` per accepted record in its OWN transaction, records the run,
 * and appends ONE summary event. Invalid and duplicate rows are never written and are handed back with
 * their reasons — the ticket's "do not silently skip them".
 */
export async function commitLeaveHistoryImport(
  ctx: SessionContext,
  p: { records: LeaveHistoryRecord[]; source?: LeaveHistoryImportSource },
): Promise<LeaveHistoryImportResult> {
  const { preview, resolved } = await analyze(ctx, p.records);
  const writable = resolved.filter((r) => r.result.status === 'valid');

  const rejected: LeaveHistoryImportError[] = resolved
    .filter((r) => r.result.status !== 'valid')
    .map((r) => ({
      rowNum: r.result.rowNum,
      employeeNo: r.result.employeeNo,
      leaveReference: r.result.leaveReference,
      errors: r.result.errors,
    }));

  const writeFailures: LeaveHistoryImportError[] = [];
  let imported = 0;
  const batchId = randomUUID();

  // One transaction per row: an RLS WITH CHECK denial, an FK error or the partial unique index firing
  // on a reference inserted between analyze and now aborts THAT row and nothing else. A single shared
  // transaction would go into an aborted state on the first failure and lose every later row AND the
  // run-log write with it — the not-atomic-by-design requirement (see the header).
  for (const r of writable) {
    try {
      await withTenant(ctx, (tx) =>
        tx.insert(leaveRequest).values({
          tenantId: ctx.tenantId,
          employmentId: r.employmentId,
          leaveTypeId: r.leaveTypeId,
          startDate: r.startDate,
          endDate: r.endDate,
          days: r.days.toFixed(2),
          durationType: r.durationType,
          // ALREADY APPROVED: the ticket's point 8 — the employee never re-applies through ESS. No
          // approval steps are created, because there is no decision left to take; the decision was
          // taken years ago in the system this row came from.
          status: 'approved',
          reason: r.remark || null,
          // The original approver is not in the file and inventing one would put a name against a
          // decision that person may never have made. The DATE is what the file states.
          decidedByEmploymentId: null,
          decidedAt: r.approvedDate ? startOfBusinessDay(r.approvedDate) : null,
          // Entry Date is what the leave history shows as "applied on" (core/read.ts maps createdAt to
          // `appliedOn`), so the imported record reads with its original entry date rather than today's.
          ...(r.entryDate ? { createdAt: startOfBusinessDay(r.entryDate) } : {}),
          externalReference: r.externalReference,
          entitlementYear: r.entitlementYear,
          submittedOn: r.submitDate,
          importedHistory: true,
        }),
      );
      imported += 1;
    } catch (e) {
      writeFailures.push({
        rowNum: r.result.rowNum,
        employeeNo: r.result.employeeNo,
        leaveReference: r.result.leaveReference,
        errors: [(e as Error).message],
      });
    }
  }

  const errors = [...rejected, ...writeFailures].sort((a, b) => a.rowNum - b.rowNum);
  // Counts the ticket asks for, and they are disjoint: imported + failed + duplicates = total.
  // A write failure is a failure even though analyze called the row valid.
  const duplicates = preview.duplicateCount;
  const failed = preview.total - imported - duplicates;

  const runId = await recordRun(ctx, {
    fileName: p.source?.kind === 'file' ? (p.source.name ?? '') : '',
    totalRows: preview.total,
    imported,
    failed,
    duplicates,
    errors,
  });

  // Substrate: ONE summary DomainEvent in its own transaction. The leave_request rows are the per-item
  // audit, and the run row is the read model — the same division employee-import uses.
  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-history-import',
      aggregateId: batchId,
      eventType: 'leave-history-import.completed',
      actor: actorOf(ctx),
      payload: {
        runId,
        total: preview.total,
        imported,
        failed,
        duplicates,
        source: p.source ?? { kind: 'paste' },
      },
    }),
  );

  return {
    total: preview.total,
    imported,
    failed,
    duplicates,
    errors: errors.slice(0, LEAVE_HISTORY_ERROR_CAP),
    errorsTruncated: errors.length > LEAVE_HISTORY_ERROR_CAP,
    runId,
  };
}

/**
 * Write the run log row. Never throws: a failed audit write must not lose an import that succeeded —
 * the rows are in, and the event log still carries the summary. Returns null when it could not be
 * written, which the caller surfaces rather than hides.
 */
async function recordRun(
  ctx: SessionContext,
  p: {
    fileName: string;
    totalRows: number;
    imported: number;
    failed: number;
    duplicates: number;
    errors: LeaveHistoryImportError[];
  },
): Promise<string | null> {
  try {
    return await withTenant(ctx, async (tx) => {
      // Resolve the actor's person ONCE, at the moment of the run, and pin it — so the log keeps
      // naming whoever ran it even after that login is re-pointed. The session only carries personId
      // when the login is tied to an employee, so fall back to app_user (core/import.ts's precedent).
      let personId = ctx.personId ?? null;
      if (!personId && ctx.userId) {
        const [u] = await tx
          .select({ personId: appUser.personId })
          .from(appUser)
          .where(and(eq(appUser.tenantId, ctx.tenantId), eq(appUser.workosUserId, ctx.userId)))
          .limit(1);
        personId = u?.personId ?? null;
      }
      const [row] = await tx
        .insert(leaveHistoryImportRun)
        .values({
          tenantId: ctx.tenantId,
          createdByPersonId: personId,
          createdByUserId: ctx.userId ?? null,
          fileName: p.fileName.slice(0, 255),
          totalRows: p.totalRows,
          importedRows: p.imported,
          failedRows: p.failed,
          duplicateRows: p.duplicates,
          errors: p.errors.slice(0, LEAVE_HISTORY_ERROR_CAP),
          errorsTruncated: p.errors.length > LEAVE_HISTORY_ERROR_CAP,
        })
        .returning({ id: leaveHistoryImportRun.id });
      return row?.id ?? null;
    });
  } catch {
    return null;
  }
}

/** Past runs, most recent first. RLS (migration 0490) is the authority: admin-only, tenant-scoped. */
export function listLeaveHistoryImportRuns(
  ctx: SessionContext,
  opts?: { limit?: number },
): Promise<LeaveHistoryRunRow[]> {
  const limit = Math.max(1, Math.min(LEAVE_HISTORY_RUN_LIMIT, opts?.limit ?? LEAVE_HISTORY_RUN_LIMIT));
  return withTenant(ctx, async (tx: Tx) => {
    const rows = await tx
      .select({
        id: leaveHistoryImportRun.id,
        actorName: person.fullName,
        fileName: leaveHistoryImportRun.fileName,
        totalRows: leaveHistoryImportRun.totalRows,
        importedRows: leaveHistoryImportRun.importedRows,
        failedRows: leaveHistoryImportRun.failedRows,
        duplicateRows: leaveHistoryImportRun.duplicateRows,
        errors: leaveHistoryImportRun.errors,
        errorsTruncated: leaveHistoryImportRun.errorsTruncated,
        createdAt: leaveHistoryImportRun.createdAt,
      })
      .from(leaveHistoryImportRun)
      .leftJoin(person, eq(person.id, leaveHistoryImportRun.createdByPersonId))
      // Explicit ORDER BY: the screen asserts "most recent first" and an unordered scan is not a fact
      // (CLAUDE.md §8 — pin invariants, and any asserted array needs an ORDER BY). Tie-broken on id so
      // two runs committed inside the same millisecond still come back in a stable order.
      .orderBy(sql`${leaveHistoryImportRun.createdAt} desc`, sql`${leaveHistoryImportRun.id} desc`)
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      // jsonb arrives as `unknown`; a row written by an older or newer shape renders as "no detail"
      // rather than crashing the log for every other run beside it.
      errors: Array.isArray(r.errors) ? (r.errors as LeaveHistoryImportError[]) : [],
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
