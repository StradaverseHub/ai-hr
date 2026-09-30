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
 * ⚠️ THE LOAD-BEARING DECISION, AND r367 REVERSED ITS DEFAULT: THE UPLOADER IS ASKED, NOT ASSUMED
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * r362 (this module, as shipped) wrote the RECORD and no ledger debit, always. The whole argument for
 * that rested on one sentence, which the product PRINTED for the user as a statement of fact
 * (`admin.leaveHistoryImport.noBalanceBody`):
 *
 *     "The balances you migrate already have this leave removed from them, so deducting it again would
 *      take the same days twice."
 *
 * THAT SENTENCE IS AN ASSUMPTION ABOUT THE CUSTOMER'S DATA, and this product never asked about it and
 * cannot verify it. It is true of a customer who brings their own CLOSING balances across. It is false
 * whenever the balances are generated from this system's own entitlement tables with nothing brought
 * forward, because those are WHOLE-YEAR ALLOWANCES and not net figures. The reporter of 073233bb is the
 * second case: 16 days Annual and 14 days Medical for 2026, brought forward 0.00. Their leave was
 * recorded and never deducted, and nothing on any screen said so - Taken read 0.00 beside six records
 * that plainly existed.
 *
 * AND IT REACHES MONEY, which is why r367 is a defect fix and not a preference. A missing debit leaves
 * the ledger balance high; `core/leave-encashment.ts` freezes unused Annual Leave off that same ledger
 * sum at resignation (`ledgerBalanceOf` -> `computeEncashableDays`), so the final payment overpays by
 * exactly the imported days. Five read surfaces carried the overstated figure with it: app/page.tsx,
 * core/my-leave.ts, app/admin/personnel/[employmentId]/page.tsx, app/leave/employee-balances/rows.ts
 * and core/assistant-tools.ts.
 *
 * WHAT r367 DOES: `openingBalancesAreNet`, asked ONCE PER RUN, defaulting to NO.
 *
 *   NO (the default) - the import writes the matching `leave_ledger` debit INSIDE the same transaction
 *      as the `leave_request` insert, with `source_request_id` set, exactly as `finalizeLeaveApproval`
 *      does for an ordinary approval. One action, both halves, so cancelling an imported record gives
 *      the days back like any other leave.
 *   YES - no ledger row, which is r362's behaviour precisely. KEPT, NOT REMOVED: a customer arriving
 *      with their own closing balances is a real migration shape, and r362 shipped one day before the
 *      report against it. The option is what makes both true at once.
 *
 * AND THE ANSWER'S CONSEQUENCE IS SHOWN BEFORE CONFIRM, never afterwards: `analyze()` returns
 * `preview.balanceImpact`, one line per employee and per LEDGER, with the balance before, the balance
 * after, and a flag when it goes below zero. The import does NOT refuse a negative result - an employee
 * who has genuinely taken more than they had earned is a fact about the past and a migration that
 * refused it would lose real history. It is flagged instead, which is the approved plan's own wording.
 *
 * WHICH LEDGER THE DEBIT LANDS ON. The resolved Balance Deduction Source (cdf9ca48), not the filed type:
 * a pooled Emergency Leave record spends Annual Leave's balance, and debiting EL's own empty ledger would
 * make the pool's figure wrong in one direction and EL's in the other. Same resolution the submit guard
 * and `finalizeLeaveApproval` use, so all three are talking about one balance.
 *
 * DAYS, AND WHY THE FILE'S FIGURE IS THE ONE DEBITED. `-days`, the figure the file states and the figure
 * written to `leave_request.days`, so the record and the movement can never disagree. `unpaid_days` is
 * not part of this contract (the file has no such column) and is left NULL, so there is nothing to
 * subtract - the mirror of `finalizeLeaveApproval`'s `-(approvedDays - unpaidDays)` with the second term
 * absent. The calendar disagreement this module already flags is deliberately NOT applied here either:
 * the old system's rest days are not ours, and a debit derived from OUR calendar would silently move a
 * different number of days than the record shows.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE r362 EXCLUSIONS INVERT, AND ALL THREE ARE HANDLED - SEE core/leave-charge.ts
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An approved `leave_request` with no sourced ledger debit was a shape this system had never had, so r362
 * narrowed three money paths. Two of them narrowed on the import MARKER, and a charged imported row makes
 * that narrowing wrong in the opposite direction:
 *
 *   1. core/leave.ts `applyLeaveCancellationApprovalTx` - narrowed on the LEDGER (`chargedDays > 0`), so
 *      it was already right and needed NO change: a charged imported record now takes the live branch,
 *      reverses its whole-span debit and re-debits only the survivors. Pinned, not assumed.
 *   2. core/payroll.ts `unpaidDaysByEmployment` and its multi-cycle copy - excluded on the marker. Now
 *      `leaveDaysAreThisSystems()`: an UNCHARGED imported record is still excluded (a migration tool must
 *      not move pay), a CHARGED one is counted like any other approved unpaid request.
 *   3. core/leave-encashment.ts `approvedLeaveDaysAfter` - same change, same reasoning. The hint's premise
 *      ("already debited at approval") is now TRUE for a charged imported record, and its remedy - cancel
 *      the request - now genuinely gives the days back, so the loop closes.
 *
 * KNOWN AND DELIBERATELY NOT CHANGED: `approvedLeaveDates` (core/leave.ts) is THE span authority for
 * attendance, roster and absence counting, and it sees imported rows. That is defensible on the merits
 * (the person WAS on leave) and inert for a migration whose dates precede go-live. RISK, low: importing a
 * record into a live, unrun payroll month could suppress an absent-day deduction. The tool is for history.
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
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  appUser,
  company,
  employment,
  leaveHistoryImportRun,
  leaveLedger,
  leaveRequest,
  person,
} from '../db/schema';
import { isGroupAdmin, hasGrantFor, withEffectiveGrants } from '../lib/authz';
import {
  LEAVE_HISTORY_COLUMNS,
  LEAVE_HISTORY_REQUIRED_KEYS,
  canonicalColumnKey,
  resolveLeaveHistoryImportOptions,
  type LeaveHistoryBalanceImpact,
  type LeaveHistoryImportError,
  type LeaveHistoryImportOptions,
  type LeaveHistoryImportPreview,
  type LeaveHistoryImportResult,
  type LeaveHistoryImportSource,
  type LeaveHistoryRecord,
  type LeaveHistoryRowResult,
  type LeaveHistoryRowStatus,
  type LeaveHistoryRunRow,
} from '../lib/leave-history-import-schema';
import { holidayDatesByEmployment } from './holidays';
import { earnedCycleStart, resolveLeaveYearCycle, resolveWorkingDaysIso, workingDays } from './leave';
import { listLeaveTypes } from './read';

export {
  LEAVE_HISTORY_COLUMNS,
  canonicalColumnKey,
  resolveLeaveHistoryImportOptions,
  type LeaveHistoryBalanceImpact,
  type LeaveHistoryImportError,
  type LeaveHistoryImportOptions,
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
  /** r367 - for the balance-impact preview only; the ledger rows carry ids, never names. */
  employeeName: string;
  leaveTypeId: string;
  /**
   * r367 - THE LEDGER THIS ROW'S DEBIT LANDS ON: the resolved Balance Deduction Source (cdf9ca48), which
   * is `leaveTypeId` itself for every type that borrows from nothing. Resolved in `analyze` so the
   * PREVIEW and the WRITE cannot name two different ledgers.
   */
  balanceTypeId: string;
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
  opts?: LeaveHistoryImportOptions,
): Promise<{
  preview: LeaveHistoryImportPreview;
  resolved: ResolvedRow[];
  /** r367 - the ONE resolution of the run's options, shared by the preview and the write. */
  options: { openingBalancesAreNet: boolean };
}> {
  const records = rawRecords.map(canonicalise);
  const options = resolveLeaveHistoryImportOptions(opts);
  const deducts = !options.openingBalancesAreNet;
  const effective = withEffectiveGrants(ctx);
  const groupAdmin = isGroupAdmin(effective);

  // Leave types by code, case-insensitive, non-archived (listLeaveTypes excludes archived by default).
  const types = await listLeaveTypes(ctx);
  const typeByCode = new Map(types.map((t) => [t.code.toLowerCase(), t.id]));
  /**
   * r367 - the two things a row needs BESIDE the id, off the read that already ran:
   *   · `balanceSourceTypeId` - which ledger the debit lands on (cdf9ca48). One hop, never a walk:
   *     `updateLeaveType` refuses a source that itself has a source, so the graph cannot be deeper.
   *   · `yearCycleOverride` - the per-type Leave Year Type (e1a51aea), which decides which entitlement
   *     year a start date falls in when the file leaves Entitlement Year blank.
   * `listLeaveTypes` already projects both, so this is a re-index of rows in hand and not a second query.
   */
  const typeById = new Map(types.map((t) => [t.id, t]));
  const codeById = new Map(types.map((t) => [t.id, t.code]));
  const balanceTypeOf = (leaveTypeId: string): string =>
    typeById.get(leaveTypeId)?.balanceSourceTypeId ?? leaveTypeId;

  const { emps, existingRefs } = await withTenant(ctx, async (tx) => {
    // Every employment the caller may see (RLS-scoped). NOT active-only: a migration's history is
    // mostly about people who were here then, including some who have since left.
    const rows = await tx
      .select({
        id: employment.id,
        companyId: employment.companyId,
        code: employment.employeeCode,
        terminatedOn: employment.terminatedOn,
        // r367 - `hiredOn` and the company's leave cycle are what resolve the ENTITLEMENT YEAR a start
        // date falls in (the anniversary cycle is anchored to the hire month), and `fullName` is for the
        // balance-impact preview: HR reads a name there, not an employment id. Both ride on the select
        // that already runs once for the whole tenant.
        hiredOn: employment.hiredOn,
        leaveCycle: company.leaveCycle,
        fullName: person.fullName,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .innerJoin(person, eq(person.id, employment.personId));
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

  const byCode = new Map<
    string,
    { id: string; companyId: string; terminated: boolean; hiredOn: string; leaveCycle: string | null; fullName: string }
  >();
  for (const e of emps) {
    if (e.code) {
      byCode.set(e.code.toLowerCase(), {
        id: e.id,
        companyId: e.companyId,
        terminated: e.terminatedOn != null,
        hiredOn: e.hiredOn,
        leaveCycle: e.leaveCycle,
        fullName: e.fullName,
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
    // Optional IN THE FILE. Stored as stated; a disagreement with the start date's year is a WARNING,
    // never a rejection, because a leave period is configurable and a January leave can legitimately
    // belong to the previous entitlement year.
    //
    // r367 - FILLED WHEN THE COLUMN IS BLANK, rather than stored as null. It is the plan's point 5 and
    // it is FUTURE-PROOFING, not a cause of anything: the column is written today and read by nothing,
    // because Employee Balances takes its year from the entitlement CYCLE START
    // (app/leave/employee-balances/rows.ts: `bd.cycleStart.slice(0, 4)`), not from the request.
    //
    // ⚠️ FROM THE CYCLE, NOT FROM THE CALENDAR YEAR OF THE START DATE, and the difference is the point.
    // A company on an ANNIVERSARY leave cycle (or a leave type carrying a Leave Year Type override,
    // e1a51aea) has a leave year anchored to the hire month, so a March 2025 leave for a July joiner
    // belongs to the year that opened in July 2024. Filling `2025` there would write a figure that
    // DISAGREES with the year Employee Balances prints beside the same record - which is the very
    // complaint this item is about. `earnedCycleStart` is the one definition of that boundary and is
    // the same function the breakdown uses, so the two cannot drift.
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
    } else if (start && emp && leaveTypeId) {
      const cycle = resolveLeaveYearCycle(typeById.get(leaveTypeId)?.yearCycleOverride ?? null, emp.leaveCycle);
      entitlementYear = Number(earnedCycleStart(emp.hiredOn, start, cycle).slice(0, 4));
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
        // r367 - what will be STORED, not what the file said, so the preview answers "which entitlement
        // year will this record land in" for a blank column too. `entitlementYearRaw` is still what the
        // validation above judged; this is its resolved outcome.
        entitlementYear: entitlementYear != null ? String(entitlementYear) : entitlementYearRaw,
        startDate: start ?? startRaw,
        endDate: end ?? endRaw,
        days: daysRaw,
        session: sessionRaw,
        status,
        errors,
        warnings,
      },
      employmentId: emp?.id ?? '',
      employeeName: emp?.fullName ?? '',
      leaveTypeId: leaveTypeId ?? '',
      balanceTypeId: leaveTypeId ? balanceTypeOf(leaveTypeId) : '',
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
  const balanceImpact = deducts
    ? await balanceImpactOf(ctx, resolved.filter((r) => r.result.status === 'valid'), codeById)
    : [];
  const preview: LeaveHistoryImportPreview = {
    total: records.length,
    validCount: rows.filter((r) => r.status === 'valid').length,
    errorCount: rows.filter((r) => r.status === 'error').length,
    duplicateCount: rows.filter((r) => r.status === 'duplicate').length,
    rows,
    missingColumns,
    deducts,
    balanceImpact,
  };
  return { preview, resolved, options };
}

/**
 * r367 - WHAT CONFIRM IMPORT IS ABOUT TO DO TO EACH BALANCE, computed from the rows that will actually be
 * written and from the ledger as it stands right now.
 *
 * ONE QUERY for every balance involved, keyed on the pairs the run touches - not one per employee, and not
 * a call into `leaveBalances` per row. The figure is `sum(leave_ledger.days)` over (employment, leave type),
 * which is what BALANCE means everywhere in this product: `core/read.ts`'s `leaveBalances.balance`,
 * `core/leave.ts`'s `leaveBalance` and `core/leave-encashment.ts`'s `ledgerBalanceOf` are all the same sum.
 * Deliberately NOT the additive column formula the ticket proposed - 6574c6b4 removed that because it
 * double-counted and turned a true +14.00 into -14.00.
 *
 * UNDATED, like the ledger balance every other surface shows: the running total, with no `effective_on`
 * cut. An imported record is dated in the past, so a cut at today would include it in `before` anyway; a
 * cut at the record's own date would answer a different question for every line in the table.
 *
 * GROUPED BY THE LEDGER THAT MOVES. See `LeaveHistoryBalanceImpact` for why, and for what `filedCodes`
 * exists to keep visible.
 *
 * ORDER IS PINNED (employee number, then ledger code): this array is rendered as a table and read as a
 * comparison, and an unordered scan is not a fact (CLAUDE.md section 8).
 */
async function balanceImpactOf(
  ctx: SessionContext,
  writable: ResolvedRow[],
  codeById: Map<string, string>,
): Promise<LeaveHistoryBalanceImpact[]> {
  if (writable.length === 0) return [];

  type Bucket = {
    employmentId: string;
    balanceTypeId: string;
    employeeNo: string;
    employeeName: string;
    filed: Set<string>;
    years: Set<string>;
    records: number;
    days: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of writable) {
    const key = `${r.employmentId}\u0000${r.balanceTypeId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        employmentId: r.employmentId,
        balanceTypeId: r.balanceTypeId,
        employeeNo: r.result.employeeNo,
        employeeName: r.employeeName,
        filed: new Set(),
        years: new Set(),
        records: 0,
        days: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.filed.add(codeById.get(r.leaveTypeId) ?? r.result.leaveCode);
    if (r.entitlementYear != null) bucket.years.add(String(r.entitlementYear));
    bucket.records += 1;
    bucket.days = round2(bucket.days + r.days);
  }

  const employmentIds = [...new Set([...buckets.values()].map((b) => b.employmentId))];
  const typeIds = [...new Set([...buckets.values()].map((b) => b.balanceTypeId))];
  const balances = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
      })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, employmentIds),
          inArray(leaveLedger.leaveTypeId, typeIds),
        ),
      )
      .groupBy(leaveLedger.employmentId, leaveLedger.leaveTypeId);
    // An employment with NO ledger row for the type is absent from this result, and its balance is 0.00 -
    // not unknown. The map's default below is what says so; a missing key must never read as an em dash on
    // a screen whose whole job is to state a figure.
    return new Map(rows.map((r) => [`${r.employmentId}\u0000${r.leaveTypeId}`, Number(r.balance)]));
  });

  const out = [...buckets.entries()].map(([key, b]): LeaveHistoryBalanceImpact => {
    const balanceBefore = round2(balances.get(key) ?? 0);
    const balanceAfter = round2(balanceBefore - b.days);
    const ledgerCode = codeById.get(b.balanceTypeId) ?? '';
    const filed = [...b.filed].filter((c) => c !== '').sort();
    return {
      employeeNo: b.employeeNo,
      employeeName: b.employeeName,
      leaveCode: ledgerCode,
      // Only when the grouping actually hid something: a pooled record filed under another code.
      filedCodes: filed.length === 1 && filed[0] === ledgerCode ? [] : filed,
      entitlementYears: [...b.years].sort(),
      records: b.records,
      days: b.days,
      balanceBefore,
      balanceAfter,
      goesNegative: balanceAfter < 0,
    };
  });
  return out.sort(
    (x, y) => x.employeeNo.localeCompare(y.employeeNo) || x.leaveCode.localeCompare(y.leaveCode),
  );
}

/**
 * Dry run. Validates against the tenant's catalogue and existing references; writes nothing.
 *
 * r367 - takes the run's `openingBalancesAreNet` answer, because the PREVIEW is where its consequence is
 * shown. The returned `deducts` is the server's own resolution of it, so the screen reports what the
 * server would do rather than what its control happens to be showing.
 */
export async function validateLeaveHistoryImport(
  ctx: SessionContext,
  p: { records: LeaveHistoryRecord[] } & LeaveHistoryImportOptions,
): Promise<LeaveHistoryImportPreview> {
  const { preview } = await analyze(ctx, p.records, p);
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
  p: { records: LeaveHistoryRecord[]; source?: LeaveHistoryImportSource } & LeaveHistoryImportOptions,
): Promise<LeaveHistoryImportResult> {
  const { preview, resolved, options } = await analyze(ctx, p.records, p);
  const writable = resolved.filter((r) => r.result.status === 'valid');
  // r367 - RE-RESOLVED FROM THIS CALL'S OWN ARGUMENT by `analyze`, never taken from a preview the client
  // holds. A tampered preview can no more turn the deduction off than it can widen which rows are written.
  const deducts = !options.openingBalancesAreNet;

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
      await withTenant(ctx, async (tx) => {
        const [created] = await tx.insert(leaveRequest).values({
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
        }).returning({ id: leaveRequest.id });
        /**
         * r367 - THE OTHER HALF, IN THE SAME TRANSACTION. This is the whole of the money fix: r362 wrote
         * the record and stopped, so the days were recorded and never deducted.
         *
         * `finalizeLeaveApproval` (core/leave.ts) is the precedent and this is its shape: ONE debit over
         * the whole span, `source_request_id` set to the row just written, `effective_on` = the start date,
         * landing on the resolved Balance Deduction Source.
         *
         * `source_request_id` IS NOT OPTIONAL DETAIL - it is what makes three other things true:
         *   · Taken attributes to the code the leave was FILED under (core/read.ts `takenFiled` joins the
         *     ledger to the request over exactly this column), which is what the reporter asked for;
         *   · cancelling the record reverses it, because `applyLeaveCancellationApprovalTx` sums the
         *     ledger rows sourced to the request and only then re-debits survivors;
         *   · core/leave-charge.ts can tell a charged imported record from an uncharged one at all.
         *
         * SAME TRANSACTION, deliberately, and it does NOT weaken the per-row isolation this module is
         * built on: the transaction is still ONE ROW's, so a failure here aborts this record and its debit
         * together and leaves every other row alone. A record without its debit is the defect being fixed;
         * a debit without its record would be worse still.
         *
         * `openingBalancesAreNet = true` writes nothing here, which is r362's behaviour exactly.
         */
        if (deducts && created) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: r.employmentId,
            leaveTypeId: r.balanceTypeId,
            entryType: 'debit',
            days: (-r.days).toFixed(2),
            sourceRequestId: created.id,
            effectiveOn: r.startDate,
          });
        }
      });
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
        // r367 - WHICH ARITHMETIC RAN, in the audit trail. Two runs of the same file under the two
        // answers do different things to a balance, and "was this import deducted?" has to be
        // answerable months later from the record rather than from whoever was at the keyboard.
        openingBalancesAreNet: options.openingBalancesAreNet,
        deducted: deducts,
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
