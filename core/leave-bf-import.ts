/**
 * db55d08a (r369) — LEAVE B/F DATA IMPORT: bulk-load the BROUGHT-FORWARD opening figure a leave year
 * starts with.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS BESIDE THE OTHER TWO IMPORTERS, AND WHY THE THREE ARE NOT DUPLICATES
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   BALANCES → `core/leave-import.ts` (Leave Adjustments › Leave Balance Import). RAW `leave_ledger`
 *              movements: the uploader states the entry type and the effective date themselves.
 *   RECORDS  → `core/leave-history-import.ts` (r362/r367). `leave_request` rows, plus the matching debit
 *              when the run deducts. Its six-step rail and its run table are this module's precedent.
 *   B/F      → this module. The uploader states an EMPLOYEE, a LEAVE CODE, a YEAR and a NUMBER OF DAYS.
 *              Nothing else. The service works out the entry type and the date.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ BROUGHT FORWARD IS A VIEW OF LAST YEAR, NOT A FIELD — AND THE ONLY ROUTE TO IT WAS A TRAP
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No column anywhere holds Brought Forward. `core/read.ts` derives it on every read:
 *
 *     priorBalance = coalesce(sum(leave_ledger.days) filter (where effective_on < cycleStart), 0)
 *
 * surfaced as `broughtForward`; and the Employee Balances GRID column is that same figure put through the
 * leave type's carry rule — `carriedForward` ← `carryAllowanceFrom` (core/leave-compute.ts). So the two
 * legitimately print different numbers when a cap bites, and BOTH are shown in this screen's preview.
 *
 * `openLeaveYear` writes NO row for the carried days. It writes at most a cap-forfeit adjustment and the
 * entitlement accrual; the carry is realised by NOT being forfeited. That is exactly why Brought Forward
 * has to be a sum over the prior cycle, and exactly why it cannot be "set".
 *
 * The Balance Import screen CAN be made to produce a B/F figure, but only by someone who knows two things
 * written down nowhere: the line must be dated in the PREVIOUS leave year, and it must be an `adjustment`
 * rather than an `accrual`. Do the natural thing instead — 3.5 days dated 1 January 2026 — and two things
 * go wrong at once. The days land under Earned to Date rather than Brought Forward; and, far worse:
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ THIS IMPORTER WRITES `adjustment` AND NEVER `accrual`. THAT IS THE LOAD-BEARING DECISION.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `yearOpenMarkerCond` (core/leave.ts) is `entry_type = 'accrual' AND effective_on BETWEEN yearStart AND
 * yearEnd`. ANY accrual row dated anywhere in 2026 — including a hand-imported one — puts that
 * (employment, leave type) into `openedSet`, so Generate Entitlement grants NOTHING for the year and posts
 * no cap forfeit. The employee ends up with the imported 3.5 days where they should have had a full annual
 * allowance, and nothing warns anybody. It reaches money: an Annual Leave balance is encashed at
 * resignation (`core/leave-encashment.ts`), so a wrong figure becomes a wrong payment in both directions.
 *
 * The entry type is therefore named ONCE, in the client-safe contract, as a literal:
 * `LEAVE_BF_ENTRY_TYPE` (lib/leave-bf-import-schema.ts). Every insert below writes that constant by
 * reference. test/leave-bf-import.test.ts pins BOTH halves — the constant itself, and that a COMMITTED
 * row does not satisfy `yearOpenMarkerCond` — because a green test over the constant alone would pass a
 * service that had quietly stopped using it.
 *
 * DELIBERATELY NOT IN THIS ITEM: the same trap is live on the existing Leave Balance Import screen, whose
 * pre-existing-accrual warning only looks for a row dated exactly 1 January (core/leave-import.ts:160-170)
 * and is therefore narrower than the engine's marker. That screen is not edited here and the warning is
 * not widened here — it is its own item, and widening it would not catch the damaging case anyway, because
 * in that case there is no pre-existing accrual at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT WRITES, EXACTLY
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One `leave_ledger` row per accepted line (two under Replace when a previous run left a figure there):
 *
 *   entryType     LEAVE_BF_ENTRY_TYPE — 'adjustment'. See above.
 *   days          the file's B/F days (and, for the Replace negation, minus what a previous run wrote).
 *   employmentId  the resolved employment.
 *   leaveTypeId   THE RESOLVED BALANCE DEDUCTION SOURCE (cdf9ca48), not the filed type. A borrower leave
 *                 type has no ledger of its own, so putting the days on it would leave the figure
 *                 invisible on the balance every screen actually reads. Same resolution the history
 *                 importer's debit uses, so the two are talking about one balance.
 *   effectiveOn   THE DAY BEFORE that employee's leave year opens, worked out per employee:
 *                 `earnedCycleStart(hiredOn, <year>-12-31, cycle)` minus one day. Calendar cycles open on
 *                 1 January, anniversary cycles open on the hire-month anniversary, and a leave TYPE may
 *                 override the company's cycle (`yearCycleOverride`, e1a51aea). NEVER a hardcoded
 *                 31 December — that is the bug this date resolution exists to prevent, and the reporter
 *                 must not have to know the rule.
 *   sourceRequestId  null. No leave record is created; nothing appears in anybody's leave history.
 *   reason        the file's Remark, or `LEAVE_BF_REASON_DEFAULT`. A HUMAN reason, never a 'sys:' code.
 *   bfImportRunId the run, so the batch can be undone.
 *
 * ⚠️ THE REASON STRING IS A DECISION, NOT A LABEL — `classifyLedgerAdjustment` (core/read.ts) was read
 * before choosing it. A null or human reason classifies as 'config', so this row ALSO appears in the
 * PRIOR leave year's Adjustment column. That is correct and is stated rather than discovered: the days
 * were brought forward, which is an administrative fact about the year that ended, and the row is dated in
 * that year. A 'sys:' prefix would classify it under `systemCorrectionKind` as a machine correction, which
 * it is not, and would additionally make it a candidate for the forfeit/recalc reconciliation sweeps that
 * hunt those prefixes — 0353's own constraint says a human reason must never collide with them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * VALIDATION USES THE **WRITE PATH'S** CARRY PREDICATE, AND THAT IS A FINDING IN ITSELF
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * "Carry-forward not enabled" is `carryEnabled` (core/leave-compute.ts): a positive `carryPercent`, OR
 * `carryForwardEnabled` when it is set, and otherwise a positive `carryMax`.
 *
 * It is NOT `carryMax` alone, and the difference is real. The READ path (`carryAllowanceFrom`) ignores
 * `carryForwardEnabled` while the WRITE path (`openLeaveYear` → `resolveCarryAllowance` → `carryEnabled`)
 * honours it. So a type with `carry_forward_enabled = false` and `carry_forward_max = 5` would DISPLAY up
 * to 5.00 brought forward while `openLeaveYear` forfeited the lot. Validating on the write-path predicate
 * keeps this screen from promising a figure the engine will take away. The divergence itself is recorded
 * as a finding for the round entry; it is not fixed here.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE CONSUMPTION-ORDER QUESTION, ANSWERED RATHER THAN ASSUMED
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The reporter asked whether carried days are used up before the current year's. `reconstructCarry`
 * (core/leave.ts) was read before anything here was written, and THE RULE IS: the ledger keeps ONE running
 * balance and nothing on it is tagged carried-or-current. The only place the two are told apart is the
 * expiry forfeit, where `unconsumedCarry = max(0, carried − debitsInWindow)` treats every day taken inside
 * the carry window as having eaten the carried days FIRST. That is a reconstruction for the forfeit, not an
 * ordering the ledger enforces, and its own comment calls it "a weaker rule: no ordering claim".
 *
 * SO THIS MODULE ASSUMES NO ORDERING. It writes one dated row into the prior cycle and lets
 * `priorBalance` and `carryAllowanceFrom` do exactly what they already do. Nothing here needs the answer,
 * and nothing here changes it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * SHAPE, COPIED FROM THE IMPORTERS THAT ALREADY WORK — WITH ONE DELIBERATE DIFFERENCE
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One private `analyze()`; `validateLeaveBfImport` (dry run) and `commitLeaveBfImport`; the commit RE-RUNS
 * analyze server-side so a tampered client preview can never widen what is written. Per-row AUTHORITY is
 * checked inside analyze, not deferred to commit, so the preview can never show a false "Valid" for a row
 * RLS would reject — core/leave-import.ts's rule. Each accepted line writes in its OWN `withTenant`
 * transaction, so a per-row RLS or FK failure aborts that line only (`commitLeaveHistoryImport`'s rule).
 *
 * THE DIFFERENCE: THE RUN ROW IS WRITTEN **FIRST**, AND A FAILURE TO WRITE IT ABORTS THE WHOLE IMPORT.
 * Both other importers record the run at the END and tolerate losing it. Here every ledger row carries
 * `bf_import_run_id`, so the run must exist before the first insert — and, more than that, a B/F import
 * with no run row could never be rolled back, which is the one thing the approved plan promises the
 * reporter about this tool. Writing unrollbackable rows into a money-adjacent ledger to save an import is
 * the wrong trade. The counts and the error report are UPDATEd onto the run at the end.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  appUser,
  company,
  employment,
  leaveBfImportRun,
  leaveLedger,
  person,
} from '../db/schema';
import { isGroupAdmin, hasGrantFor, withEffectiveGrants } from '../lib/authz';
import {
  LEAVE_BF_COLUMNS,
  LEAVE_BF_ENTRY_TYPE,
  LEAVE_BF_REQUIRED_KEYS,
  canonicalBfColumnKey,
  resolveLeaveBfImportOptions,
  type LeaveBfBalanceImpact,
  type LeaveBfImportError,
  type LeaveBfImportMode,
  type LeaveBfImportOptions,
  type LeaveBfImportPreview,
  type LeaveBfImportResult,
  type LeaveBfImportSource,
  type LeaveBfRecord,
  type LeaveBfRowResult,
  type LeaveBfRowStatus,
  type LeaveBfRunRow,
} from '../lib/leave-bf-import-schema';
import { carryAllowanceFrom, carryEnabled } from './leave-compute';
import { earnedCycleStart, resolveLeaveYearCycle } from './leave';
import { listLeaveTypes } from './read';

export {
  LEAVE_BF_COLUMNS,
  LEAVE_BF_ENTRY_TYPE,
  canonicalBfColumnKey,
  resolveLeaveBfImportOptions,
  type LeaveBfBalanceImpact,
  type LeaveBfImportError,
  type LeaveBfImportMode,
  type LeaveBfImportOptions,
  type LeaveBfImportPreview,
  type LeaveBfImportResult,
  type LeaveBfImportSource,
  type LeaveBfRecord,
  type LeaveBfRowResult,
  type LeaveBfRowStatus,
  type LeaveBfRunRow,
};

/** How many rejected rows the run log keeps. The screen says so when the cap bit (0341's rule). */
export const LEAVE_BF_ERROR_CAP = 200;
/** How many past runs the log on the screen shows. */
export const LEAVE_BF_RUN_LIMIT = 20;

/**
 * The reason stamped on a B/F row when the file's Remark is blank. A HUMAN string — see the header for why
 * a 'sys:' prefix would be wrong — and deliberately one that reads as an explanation in the Explain
 * panel's transaction list, which is where HR will meet it.
 */
export const LEAVE_BF_REASON_DEFAULT = 'Brought forward (B/F import)';
/** The reason on the negation a Replace writes over a previous run's figure. */
export const LEAVE_BF_REPLACED_REASON = 'Brought forward replaced (B/F import)';
/**
 * The prefix on every row a ROLLBACK writes. It is what lets the reversal select the rows a run wrote
 * WITHOUT sweeping in its own compensating rows, so a second rollback cannot compound (the
 * `reverseLeaveAdjustmentBatch` hazard, solved with a prefix instead of an exact-reason match because a
 * B/F run's rows each carry their own line's Remark and there is no single reason to match on).
 * Human, never 'sys:' — a person undid a person's action.
 */
export const LEAVE_BF_REVERSAL_REASON_PREFIX = 'Rollback of B/F import';

/** Thrown for a rollback the caller may not do, or a run that cannot be rolled back twice. */
export class LeaveBfImportError_ extends Error {}
/** The public name; the class above is suffixed only to avoid colliding with the row-error TYPE. */
export { LeaveBfImportError_ as LeaveBfImportFailure };

const norm = (s: string | undefined) => (s ?? '').trim();
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The day before an ISO date. Pure UTC calendar arithmetic on a date-only string, so it derives nothing
 * from an instant and no tenant-timezone question arises (`leaveCycleEnd` in core/leave.ts takes the same
 * approach for the same reason — the DATES rule is about `new Date()`, not about date-string arithmetic).
 */
function dayBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
}

/** A line that passed validation and is ready to write, paired with its preview result. */
type ResolvedRow = {
  result: LeaveBfRowResult;
  employmentId: string;
  /** The type the line was FILED under — kept so the preview can show pooling. */
  leaveTypeId: string;
  /** The ledger the figure lands on: the resolved Balance Deduction Source. */
  balanceTypeId: string;
  entitlementYear: number;
  /** The day that employee's `entitlementYear` leave year opens. */
  cycleStart: string;
  /** `dayBefore(cycleStart)` — where the row is dated. */
  effectiveOn: string;
  days: number;
  remark: string;
};

/**
 * Re-key a record onto the contract's canonical keys. `parseCsvRecords` lower-cases and underscores a
 * header but keeps punctuation, so the reporter's "B/F Days" arrives as `b/f_days`; the canonicaliser
 * closes that gap. Unknown headers are kept under their canonical form and ignored — a migration file
 * routinely carries extra columns and refusing the file over them helps nobody.
 */
function canonicalise(rec: LeaveBfRecord): LeaveBfRecord {
  const out: LeaveBfRecord = {};
  for (const [k, v] of Object.entries(rec)) {
    const key = canonicalBfColumnKey(k);
    // First spelling wins, so a file carrying BOTH `bf_days` and an alias of it is not reordered into a
    // different answer by object key order.
    if (!(key in out)) out[key] = v;
  }
  return out;
}

/** The ledger rows in hand for the pairs a run touches — enough to answer every "before" question. */
type LedgerRow = { employmentId: string; leaveTypeId: string; days: number; effectiveOn: string; fromBfImport: boolean };

/**
 * Pure validation phase (dry run). Reads the tenant's employments and leave types once, validates each
 * record in memory, then makes ONE pass over the ledger for the balance preview.
 */
async function analyze(
  ctx: SessionContext,
  rawRecords: LeaveBfRecord[],
  opts?: LeaveBfImportOptions,
): Promise<{
  preview: LeaveBfImportPreview;
  resolved: ResolvedRow[];
  /** The ONE resolution of the run's options, shared by the preview and the write. */
  options: { mode: LeaveBfImportMode };
}> {
  const records = rawRecords.map(canonicalise);
  const options = resolveLeaveBfImportOptions(opts);
  const effective = withEffectiveGrants(ctx);
  const groupAdmin = isGroupAdmin(effective);

  // Leave types by code, case-insensitive, non-archived (listLeaveTypes excludes archived by default).
  const types = await listLeaveTypes(ctx);
  const typeByCode = new Map(types.map((t) => [t.code.toLowerCase(), t.id]));
  const typeById = new Map(types.map((t) => [t.id, t]));
  const codeById = new Map(types.map((t) => [t.id, t.code]));
  /**
   * WHICH LEDGER THE FIGURE LANDS ON (cdf9ca48). One hop, never a walk: `updateLeaveType` refuses a source
   * that itself has a source, so the graph cannot be deeper — the history importer's own note.
   */
  const balanceTypeOf = (leaveTypeId: string): string =>
    typeById.get(leaveTypeId)?.balanceSourceTypeId ?? leaveTypeId;
  /**
   * The carry rule of a leave type, as the WRITE path reads it. `carryEnabled` takes a ResolvedPolicy, and
   * the three fields it looks at are all type-level columns (`leaveTypeRuleColumns`), so the policy can be
   * assembled from the type row alone — `days` is irrelevant to the carry question and is passed as 0
   * rather than invented.
   */
  const carryRuleOf = (leaveTypeId: string) => {
    const t = typeById.get(leaveTypeId);
    const carryMax = Math.max(0, Number(t?.carryForwardMax ?? 0) || 0);
    const raw = t?.carryForwardPercent;
    const carryPercent = raw == null || raw === '' ? null : Number(raw);
    return {
      carryMax,
      carryPercent: carryPercent != null && Number.isFinite(carryPercent) ? carryPercent : null,
      enabled: carryEnabled({
        days: 0,
        carryMax,
        carryPercent: carryPercent != null && Number.isFinite(carryPercent) ? carryPercent : null,
        carryForwardEnabled: t?.carryForwardEnabled ?? undefined,
      }),
    };
  };

  const emps = await withTenant(ctx, async (tx) => {
    // Every employment the caller may see (RLS-scoped). NOT active-only: a migration's opening figures are
    // partly about people who have since left, and "resigned or inactive" is a WARNING in the reporter's
    // own list rather than a rejection.
    return tx
      .select({
        id: employment.id,
        companyId: employment.companyId,
        code: employment.employeeCode,
        terminatedOn: employment.terminatedOn,
        // `hiredOn` and the company's leave cycle are what resolve WHICH DAY the entitlement year opens;
        // `fullName` is for the preview, because HR reads a name there and not an employment id.
        hiredOn: employment.hiredOn,
        leaveCycle: company.leaveCycle,
        fullName: person.fullName,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .innerJoin(person, eq(person.id, employment.personId));
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

  const presentColumns = new Set(records.length ? Object.keys(records[0]) : []);
  const missingColumns = LEAVE_BF_REQUIRED_KEYS.filter((c) => !presentColumns.has(c));

  /** employee|code|year seen in this file — the reporter's in-file duplicate rule. */
  const seen = new Set<string>();
  const resolved: ResolvedRow[] = [];

  records.forEach((rec, idx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const employeeId = norm(rec.employee_id);
    const leaveCode = norm(rec.leave_code);
    const yearRaw = norm(rec.entitlement_year);
    const daysRaw = norm(rec.bf_days).replace(/[,_]/g, '');
    const remark = norm(rec.remark);

    // ── Employee ────────────────────────────────────────────────────────────────────────────────
    if (!employeeId) errors.push('Employee ID is required');
    const emp = employeeId ? byCode.get(employeeId.toLowerCase()) : undefined;
    if (employeeId && !emp) errors.push('Employee ID not found');
    if (emp?.terminated) warnings.push('Employee is no longer active');
    // Authority HERE, not at commit, so the preview never shows a Valid row RLS would then refuse.
    if (emp && !(groupAdmin || hasGrantFor(effective, 'hr_admin', emp.companyId))) {
      errors.push("Not authorized for this employee's company");
    }

    // ── Leave code, and the carry rule that decides whether the figure survives ──────────────────
    if (!leaveCode) errors.push('Leave Code is required');
    const leaveTypeId = leaveCode ? typeByCode.get(leaveCode.toLowerCase()) : undefined;
    if (leaveCode && !leaveTypeId) errors.push('Leave Code not found');
    const balanceTypeId = leaveTypeId ? balanceTypeOf(leaveTypeId) : '';
    const balanceCode = balanceTypeId ? (codeById.get(balanceTypeId) ?? '') : '';
    const carry = balanceTypeId ? carryRuleOf(balanceTypeId) : null;
    /**
     * ⚠️ THE CARRY QUESTION IS ASKED OF THE **BALANCE** TYPE, NOT THE FILED TYPE, and that is the engine's
     * own answer rather than a convenience. A borrower type (Emergency Leave pooled onto Annual Leave) has
     * no ledger and no carry of its own; the days land on the lender's ledger and the LENDER's carry rule
     * is what `openLeaveYear` will apply. Refusing the line because the borrower carries nothing would
     * block a legitimate load; accepting it while checking the borrower's rule would promise a figure the
     * engine then takes away. The preview names both codes so the pooling is never hidden.
     */
    if (leaveTypeId && carry && !carry.enabled) {
      errors.push(
        balanceCode && balanceCode.toLowerCase() !== leaveCode.toLowerCase()
          ? `Carry forward is not enabled for ${balanceCode}, which is where ${leaveCode}'s balance is held`
          : 'Carry forward is not enabled for this leave type',
      );
    }

    // ── Entitlement Year ────────────────────────────────────────────────────────────────────────
    // REQUIRED here, unlike the history importer's optional column: there is no start date to infer it
    // from, and it is the only thing that says which leave year this figure opens.
    let year = NaN;
    if (!yearRaw) {
      errors.push('Entitlement Year is required');
    } else {
      const y = Number(yearRaw);
      if (!Number.isInteger(y) || y < 1900 || y > 2999) errors.push('Entitlement Year is not a valid year');
      else year = y;
    }

    // ── B/F Days ────────────────────────────────────────────────────────────────────────────────
    // The reporter's three rules, in their order: numeric, not negative, in half-day steps. ZERO IS
    // ALLOWED on purpose and is not an oversight — under Replace, 0 is the instruction "take back what a
    // previous import put there", which is a real and necessary correction. It writes no positive row.
    let days = NaN;
    if (!daysRaw) {
      errors.push('B/F Days is required');
    } else {
      const n = Number(daysRaw);
      if (!Number.isFinite(n)) errors.push('B/F Days is not a number');
      else if (n < 0) errors.push('B/F Days cannot be negative');
      else if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) errors.push('B/F Days must be in steps of 0.5');
      else if (n > 999) errors.push('B/F Days is implausibly large');
      else days = round2(n);
    }

    // ── The cap warning ─────────────────────────────────────────────────────────────────────────
    // Over the leave type's maximum carry-forward: allowed through, because the figure is still recorded
    // and the PREVIEW shows exactly how much of it the grid will print and how much lands in Forfeited BF.
    if (carry && Number.isFinite(days) && carry.enabled) {
      const allowed = carryAllowanceFrom({ balance: days, carryMax: carry.carryMax, carryPercent: carry.carryPercent });
      if (round2(allowed) < days) {
        warnings.push(
          `Above ${balanceCode || leaveCode}'s carry-forward limit: ${round2(allowed).toFixed(2)} will be brought forward and ${round2(days - allowed).toFixed(2)} forfeited`,
        );
      }
    }

    // ── The in-file duplicate rule ──────────────────────────────────────────────────────────────
    // An ERROR, not its own status (see `LeaveBfRowStatus`): two lines for one employee + code + year are
    // not "already loaded", they are a file whose author has not decided which figure they mean.
    if (employeeId && leaveCode && Number.isInteger(year)) {
      const key = `${employeeId.toLowerCase()}\u0000${leaveCode.toLowerCase()}\u0000${year}`;
      if (seen.has(key)) errors.push('Duplicate Employee ID + Leave Code + Entitlement Year in this file');
      else seen.add(key);
    }

    // ── The date the file did not state, worked out per employee ────────────────────────────────
    // `earnedCycleStart` is the ONE definition of a leave-year boundary and is the same function the
    // balance breakdown uses, so the two cannot drift. The anchor is `<year>-12-31`: for a calendar cycle
    // that resolves to `<year>-01-01`, and for an anniversary cycle to `<year>-<hire month>-01` for EVERY
    // hire month (December included, where month >= month still holds). NEVER a hardcoded 31 December.
    let cycleStart = '';
    let effectiveOn = '';
    if (emp && balanceTypeId && Number.isInteger(year)) {
      // The cycle of the ledger that MOVES: a per-type Leave Year Type override (e1a51aea) wins over the
      // company cycle, and it is the balance type's ledger the figure is dated against.
      const cycle = resolveLeaveYearCycle(typeById.get(balanceTypeId)?.yearCycleOverride ?? null, emp.leaveCycle);
      cycleStart = earnedCycleStart(emp.hiredOn, `${year}-12-31`, cycle);
      effectiveOn = dayBefore(cycleStart);
    }

    const status: LeaveBfRowStatus = errors.length > 0 ? 'error' : 'valid';

    resolved.push({
      result: {
        rowNum: idx + 1,
        employeeId,
        employeeName: emp?.fullName ?? '',
        leaveCode,
        // Only when the two differ: an always-populated column would say "pooled" about every line.
        balanceCode: balanceCode && balanceCode.toLowerCase() !== leaveCode.toLowerCase() ? balanceCode : '',
        entitlementYear: Number.isInteger(year) ? String(year) : yearRaw,
        days: daysRaw,
        cycleStart,
        effectiveOn,
        status,
        errors,
        warnings,
      },
      employmentId: emp?.id ?? '',
      leaveTypeId: leaveTypeId ?? '',
      balanceTypeId,
      entitlementYear: Number.isInteger(year) ? year : 0,
      cycleStart,
      effectiveOn,
      days: Number.isFinite(days) ? days : 0,
      remark,
    });
  });

  const rows = resolved.map((r) => r.result);
  const writable = resolved.filter((r) => r.result.status === 'valid');
  const { impact: balanceImpact, beforeByKey } = await bfImpactOf(
    ctx,
    writable,
    codeById,
    carryRuleOf,
    options.mode,
  );

  /**
   * THE REPORTER'S THIRD WARNING: "A B/F figure already exists in the system for that Employee + Leave
   * Code + Year."
   *
   * ⚠️ ANSWERED AGAINST THE REAL DERIVATION RATHER THAN AGAINST THE FIELD THE REPORTER IMAGINES. There is
   * no stored B/F field (see the header), so the honest reading of their question is "is the Brought
   * Forward figure for that year already non-zero" — which is the number the screen they are looking at
   * prints. It fires on the RAW prior-cycle sum, so it also catches a figure that arrived as real accruals
   * and debits rather than from a previous import, and it says so: Replace negates only what a previous
   * B/F import wrote, so where the existing figure came from elsewhere the result will NOT equal the
   * number typed, and the reader has to be told that before they commit rather than after.
   *
   * Pushed after `bfImpactOf` because it needs the ledger, and onto `r.result.warnings` BY REFERENCE —
   * `rows` above holds the same objects, which is the same shape the history importer's day-count pass
   * uses. It does not demote the row from `valid`: it is a warning in the reporter's own list.
   */
  for (const r of writable) {
    const before = beforeByKey.get(`${r.employmentId}\u0000${r.balanceTypeId}\u0000${r.cycleStart}`);
    if (before != null && before !== 0) {
      r.result.warnings.push(
        `${before.toFixed(2)} day(s) are already brought forward into ${r.entitlementYear}. Replace removes only what a previous B/F import put there.`,
      );
    }
  }

  const preview: LeaveBfImportPreview = {
    total: records.length,
    validCount: rows.filter((r) => r.status === 'valid').length,
    errorCount: rows.filter((r) => r.status === 'error').length,
    rows,
    missingColumns,
    mode: options.mode,
    balanceImpact,
  };
  return { preview, resolved, options };
}

/**
 * WHAT CONFIRM IMPORT WILL DO TO EACH BROUGHT-FORWARD FIGURE, computed from the lines that will actually
 * be written and from the ledger as it stands right now.
 *
 * ONE QUERY for every (employment, ledger) pair the run touches. It fetches the rows rather than a
 * pre-aggregated sum because the cut is PER CYCLE — a run can legitimately carry two years for one
 * employee, each with its own `cycleStart` — and a GROUP BY cannot express a different boundary per group.
 * A ledger holds tens of rows per employee per type, so this is cheaper than the per-group query it
 * replaces, and it is the same read that answers the Replace question below.
 *
 * `broughtForwardBefore` is the raw prior-cycle sum: `sum(days) where effective_on < cycleStart`, which is
 * `core/read.ts`'s `priorBalance` verbatim. `carriedForwardAfter` is that figure through
 * `carryAllowanceFrom` — the SAME function `openLeaveYear` and the projection kernel ask — so this preview
 * cannot promise a number the engine would not produce.
 *
 * ORDER IS PINNED (employee id, then ledger code, then year): this array is rendered as a table and read
 * as a comparison, and an unordered scan is not a fact (CLAUDE.md §8).
 *
 * `beforeByKey` is the same `broughtForwardBefore` figures keyed by (employment, ledger, cycle start), so
 * the "already brought forward" warning reads the ONE computation rather than making a second one that
 * could disagree with the table beside it.
 */
async function bfImpactOf(
  ctx: SessionContext,
  writable: ResolvedRow[],
  codeById: Map<string, string>,
  carryRuleOf: (id: string) => { carryMax: number; carryPercent: number | null; enabled: boolean },
  mode: LeaveBfImportMode,
): Promise<{ impact: LeaveBfBalanceImpact[]; beforeByKey: Map<string, number> }> {
  if (writable.length === 0) return { impact: [], beforeByKey: new Map() };

  type Bucket = {
    employmentId: string;
    balanceTypeId: string;
    employeeId: string;
    employeeName: string;
    filed: Set<string>;
    entitlementYear: number;
    cycleStart: string;
    effectiveOn: string;
    lines: number;
    fileDays: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of writable) {
    const key = `${r.employmentId}\u0000${r.balanceTypeId}\u0000${r.cycleStart}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        employmentId: r.employmentId,
        balanceTypeId: r.balanceTypeId,
        employeeId: r.result.employeeId,
        employeeName: r.result.employeeName,
        filed: new Set(),
        entitlementYear: r.entitlementYear,
        cycleStart: r.cycleStart,
        effectiveOn: r.effectiveOn,
        lines: 0,
        fileDays: 0,
      };
      buckets.set(key, b);
    }
    b.filed.add(codeById.get(r.leaveTypeId) ?? r.result.leaveCode);
    b.lines += 1;
    b.fileDays = round2(b.fileDays + r.days);
  }

  const employmentIds = [...new Set([...buckets.values()].map((b) => b.employmentId))];
  const typeIds = [...new Set([...buckets.values()].map((b) => b.balanceTypeId))];
  const ledger = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        days: leaveLedger.days,
        effectiveOn: leaveLedger.effectiveOn,
        bfImportRunId: leaveLedger.bfImportRunId,
      })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, employmentIds),
          inArray(leaveLedger.leaveTypeId, typeIds),
        ),
      );
    const out = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      const k = `${r.employmentId}\u0000${r.leaveTypeId}`;
      const list = out.get(k) ?? [];
      list.push({
        employmentId: r.employmentId,
        leaveTypeId: r.leaveTypeId,
        days: Number(r.days),
        effectiveOn: r.effectiveOn,
        fromBfImport: r.bfImportRunId != null,
      });
      out.set(k, list);
    }
    return out;
  });

  const beforeByKey = new Map<string, number>();
  const out = [...buckets.values()].map((b): LeaveBfBalanceImpact => {
    const pairRows = ledger.get(`${b.employmentId}\u0000${b.balanceTypeId}`) ?? [];
    const broughtForwardBefore = round2(
      pairRows.filter((r) => r.effectiveOn < b.cycleStart).reduce((a, r) => a + r.days, 0),
    );
    beforeByKey.set(`${b.employmentId}\u0000${b.balanceTypeId}\u0000${b.cycleStart}`, broughtForwardBefore);
    // What a PREVIOUS B/F import already put at this exact date. Reversal rows carry the same date and are
    // included, so a rolled-back run nets to 0 here automatically and is not negated twice.
    const previouslyImported = round2(
      pairRows.filter((r) => r.fromBfImport && r.effectiveOn === b.effectiveOn).reduce((a, r) => a + r.days, 0),
    );
    const netDays = mode === 'replace' ? round2(b.fileDays - previouslyImported) : b.fileDays;
    const broughtForwardAfter = round2(broughtForwardBefore + netDays);
    const carry = carryRuleOf(b.balanceTypeId);
    const carriedForwardAfter = round2(
      carry.enabled
        ? carryAllowanceFrom({ balance: broughtForwardAfter, carryMax: carry.carryMax, carryPercent: carry.carryPercent })
        : 0,
    );
    const forfeitedBf = round2(Math.max(0, broughtForwardAfter) - carriedForwardAfter);
    const ledgerCode = codeById.get(b.balanceTypeId) ?? '';
    const filed = [...b.filed].filter((c) => c !== '').sort();
    return {
      employeeId: b.employeeId,
      employeeName: b.employeeName,
      leaveCode: ledgerCode,
      filedCodes: filed.length === 1 && filed[0] === ledgerCode ? [] : filed,
      entitlementYear: String(b.entitlementYear),
      cycleStart: b.cycleStart,
      effectiveOn: b.effectiveOn,
      lines: b.lines,
      fileDays: b.fileDays,
      netDays,
      broughtForwardBefore,
      broughtForwardAfter,
      carriedForwardAfter,
      forfeitedBf,
      capped: forfeitedBf > 0,
    };
  });
  const impact = out.sort(
    (x, y) =>
      x.employeeId.localeCompare(y.employeeId) ||
      x.leaveCode.localeCompare(y.leaveCode) ||
      x.entitlementYear.localeCompare(y.entitlementYear),
  );
  return { impact, beforeByKey };
}

/**
 * Dry run. Validates against the tenant's catalogue and the ledger as it stands; writes nothing at all.
 *
 * The returned `mode` is the SERVER's own resolution, so the screen reports what the server would do
 * rather than what its control happens to be showing.
 */
export async function validateLeaveBfImport(
  ctx: SessionContext,
  p: { records: LeaveBfRecord[] } & LeaveBfImportOptions,
): Promise<LeaveBfImportPreview> {
  const { preview } = await analyze(ctx, p.records, p);
  return preview;
}

/**
 * Commit the valid lines, and only those. Re-runs `analyze()` server-side (never trusts the client
 * preview), writes the run row FIRST, then one or two `leave_ledger` rows per accepted line in that line's
 * OWN transaction, then updates the run with the counts and appends ONE summary event.
 *
 * ⚠️ THE `beforeWarning` PREVIEW IS NOT RE-SHOWN HERE AND IS NOT SUPPOSED TO BE: the mode is re-resolved
 * from THIS call's own argument by `analyze`, so a tampered preview can no more switch Replace to Add than
 * it can widen which lines are written.
 */
export async function commitLeaveBfImport(
  ctx: SessionContext,
  p: { records: LeaveBfRecord[]; source?: LeaveBfImportSource } & LeaveBfImportOptions,
): Promise<LeaveBfImportResult> {
  const { preview, resolved, options } = await analyze(ctx, p.records, p);
  const writable = resolved.filter((r) => r.result.status === 'valid');

  const rejected: LeaveBfImportError[] = resolved
    .filter((r) => r.result.status !== 'valid')
    .map((r) => ({
      rowNum: r.result.rowNum,
      employeeId: r.result.employeeId,
      leaveCode: r.result.leaveCode,
      entitlementYear: r.result.entitlementYear,
      errors: r.result.errors,
    }));

  /**
   * THE RUN ROW, FIRST, AND A FAILURE HERE ABORTS THE IMPORT. Every ledger row references it (the FK), and
   * a B/F batch with no run row could never be rolled back — which is the one promise the approved plan
   * makes the reporter about this tool. Writing unrollbackable rows into a money-adjacent ledger to save an
   * import is the wrong trade, so this throws rather than degrading like the history importer's
   * `recordRun` does.
   */
  const runId = await openRun(ctx, {
    fileName: p.source?.kind === 'file' ? (p.source.name ?? '') : '',
    mode: options.mode,
    totalRows: preview.total,
  });

  const writeFailures: LeaveBfImportError[] = [];
  let imported = 0;
  let ledgerRows = 0;

  // One transaction per LINE: an RLS WITH CHECK denial or an FK error aborts THAT line and nothing else.
  // A single shared transaction would go into an aborted state on the first failure and lose every later
  // line with it — `commitLeaveHistoryImport`'s not-atomic-by-design rule, for the same reason (the
  // reporter is told which rows did not go in and why, so the rest must still go in).
  //
  // A REPLACE LINE'S TWO ROWS SHARE ITS TRANSACTION. The negation without the new figure would leave the
  // employee's brought-forward figure at zero rather than at the number in the file, which is worse than
  // not having run the line at all.
  for (const r of writable) {
    try {
      await withTenant(ctx, async (tx) => {
        let wrote = 0;
        if (options.mode === 'replace') {
          /**
           * What a PREVIOUS B/F import put at this exact date, re-read inside the write transaction rather
           * than taken from the preview: the preview is a separate request and this is the one that moves
           * days. Reversal rows carry the same date, so a rolled-back run nets to 0 here and is not
           * negated a second time.
           *
           * ⚠️ IT SUMS ONLY ROWS CARRYING A `bf_import_run_id`. The rest of the prior-cycle balance — real
           * accruals, real debits, real adjustments — is deliberately untouched. A "replace" that reversed
           * those would destroy history and move days nobody asked it to move. Where a genuine prior
           * balance exists the preview states it and the warning names the figure.
           */
          const [prior] = await tx
            .select({ days: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
            .from(leaveLedger)
            .where(
              and(
                eq(leaveLedger.employmentId, r.employmentId),
                eq(leaveLedger.leaveTypeId, r.balanceTypeId),
                eq(leaveLedger.effectiveOn, r.effectiveOn),
                isNotNull(leaveLedger.bfImportRunId),
              ),
            );
          const priorDays = round2(Number(prior?.days ?? 0));
          if (priorDays !== 0) {
            await tx.insert(leaveLedger).values({
              tenantId: ctx.tenantId,
              employmentId: r.employmentId,
              leaveTypeId: r.balanceTypeId,
              // ⚠️ 'adjustment', from the one constant. Read this module's header before changing it.
              entryType: LEAVE_BF_ENTRY_TYPE,
              days: (-priorDays).toFixed(2),
              sourceRequestId: null,
              effectiveOn: r.effectiveOn,
              reason: LEAVE_BF_REPLACED_REASON,
              bfImportRunId: runId,
            });
            wrote += 1;
          }
        }
        // A zero figure writes no positive row: it would be a ledger entry that changes nothing and an
        // event that did not happen (0353's `leave_adjustment_batch_days_check` reasoning). Under Replace
        // the negation above is the whole of the instruction, and that is exactly what 0 is FOR.
        if (r.days !== 0) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: r.employmentId,
            leaveTypeId: r.balanceTypeId,
            // ⚠️ 'adjustment' AND NEVER 'accrual' — the load-bearing line of this module. An accrual row
            // dated inside the leave year satisfies `yearOpenMarkerCond` (core/leave.ts) and makes Generate
            // Entitlement grant this employee nothing for the whole year.
            entryType: LEAVE_BF_ENTRY_TYPE,
            days: r.days.toFixed(2),
            // No leave record is created, so there is nothing to source it to. Nothing appears in anybody's
            // leave history, which is the difference between this tool and Leave History Data Import.
            sourceRequestId: null,
            // The day BEFORE the leave year opens, so `priorBalance` sees it as brought forward.
            effectiveOn: r.effectiveOn,
            // A HUMAN reason (`classifyLedgerAdjustment` ⇒ 'config'), never a 'sys:' code. See the header.
            reason: r.remark || LEAVE_BF_REASON_DEFAULT,
            bfImportRunId: runId,
          });
          wrote += 1;
        }
        ledgerRows += wrote;
      });
      imported += 1;
    } catch (e) {
      writeFailures.push({
        rowNum: r.result.rowNum,
        employeeId: r.result.employeeId,
        leaveCode: r.result.leaveCode,
        entitlementYear: r.result.entitlementYear,
        errors: [(e as Error).message],
      });
    }
  }

  const errors = [...rejected, ...writeFailures].sort((a, b) => a.rowNum - b.rowNum);
  // imported + failed = total, always. A write failure is a failure even though analyze called it valid.
  const failed = preview.total - imported;

  await closeRun(ctx, {
    runId,
    imported,
    failed,
    ledgerRows,
    errors,
  });

  // Substrate: ONE summary DomainEvent in its own transaction. The ledger rows are the per-item audit and
  // the run row is the read model — the same division employee-import and leave-history-import use.
  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-bf-import',
      aggregateId: runId,
      eventType: 'leave-bf-import.completed',
      actor: actorOf(ctx),
      payload: {
        runId,
        total: preview.total,
        imported,
        failed,
        ledgerRows,
        mode: options.mode,
        source: p.source ?? { kind: 'paste' },
        // The entry type is in the audit trail ON PURPOSE. "Did this import write accruals?" is the
        // question that decides whether a year's entitlement was silently cancelled, and it has to be
        // answerable months later from the record rather than from the code as it stands then.
        entryType: LEAVE_BF_ENTRY_TYPE,
      },
    }),
  );

  return {
    total: preview.total,
    imported,
    failed,
    errors: errors.slice(0, LEAVE_BF_ERROR_CAP),
    errorsTruncated: errors.length > LEAVE_BF_ERROR_CAP,
    runId,
  };
}

/** Open the run row. Throws rather than returning null — see `commitLeaveBfImport` for why. */
async function openRun(
  ctx: SessionContext,
  p: { fileName: string; mode: LeaveBfImportMode; totalRows: number },
): Promise<string> {
  const id = await withTenant(ctx, async (tx) => {
    // Resolve the actor's person ONCE, at the moment of the run, and pin it — so the log keeps naming
    // whoever ran it even after that login is re-pointed. The session only carries personId when the login
    // is tied to an employee, so fall back to app_user (core/import.ts's precedent).
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
      .insert(leaveBfImportRun)
      .values({
        tenantId: ctx.tenantId,
        createdByPersonId: personId,
        createdByUserId: ctx.userId ?? null,
        fileName: p.fileName.slice(0, 255),
        importMode: p.mode,
        totalRows: p.totalRows,
      })
      .returning({ id: leaveBfImportRun.id });
    return row?.id ?? null;
  });
  if (!id) {
    throw new LeaveBfImportError_(
      'This import could not be recorded, so nothing was loaded. A B/F import must be reversible, and a run with no record could not be rolled back.',
    );
  }
  return id;
}

/** Stamp the finished counts and the error report onto the run row. */
function closeRun(
  ctx: SessionContext,
  p: { runId: string; imported: number; failed: number; ledgerRows: number; errors: LeaveBfImportError[] },
): Promise<void> {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(leaveBfImportRun)
      .set({
        importedRows: p.imported,
        failedRows: p.failed,
        ledgerRows: p.ledgerRows,
        errors: p.errors.slice(0, LEAVE_BF_ERROR_CAP),
        errorsTruncated: p.errors.length > LEAVE_BF_ERROR_CAP,
      })
      .where(eq(leaveBfImportRun.id, p.runId));
  });
}

/**
 * ROLL BACK A RUN by writing COMPENSATING rows, never by deleting — the reporter's "Rollback batch option,
 * which is very useful during migration".
 *
 * ADR-0006: the ledger is append-only. Deleting the rows would erase the fact that the import happened, and
 * a balance that silently loses history is what the audit substrate exists to prevent. So the rollback
 * writes the negation of each row, links it to the SAME run, and stamps the run as reversed so the screen
 * stops offering it a second time — `reverseLeaveAdjustmentBatch`'s shape, followed as a PATTERN.
 *
 * ⚠️ EACH ROW IS REVERSED ON **ITS OWN** `effective_on`, not on one date for the whole run, and that is a
 * correctness requirement rather than tidiness. A brought-forward figure is defined by being dated before a
 * particular cycle start; negating it on today's date would leave the prior-cycle sum wrong forever and
 * would ALSO credit today's cycle by the same amount. `reverseLeaveAdjustmentBatch` can use one date
 * because its batch has one; a B/F run has a date per employee.
 *
 * ⚠️ THE ROWS TO NEGATE ARE SELECTED BY RUN ID **MINUS THE ROLLBACK'S OWN ROWS**, matched on the reason
 * prefix. The batch reverser matches its rows on an exact reason because a batch has one; a B/F run's rows
 * each carry their own line's Remark, so there is no single string to match and a prefix exclusion is what
 * keeps a second rollback from compounding. The `reversedAt` check below is the belt; this is the braces.
 */
export async function reverseLeaveBfImportRun(
  ctx: SessionContext,
  p: { runId: string },
): Promise<{ reversed: number }> {
  return withTenant(ctx, async (tx) => {
    const [run] = await tx
      .select({ id: leaveBfImportRun.id, reversedAt: leaveBfImportRun.reversedAt })
      .from(leaveBfImportRun)
      .where(eq(leaveBfImportRun.id, p.runId))
      .limit(1);
    if (!run) throw new LeaveBfImportError_('That import could not be found.');
    if (run.reversedAt) throw new LeaveBfImportError_('That import has already been rolled back.');

    const original = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        days: leaveLedger.days,
        effectiveOn: leaveLedger.effectiveOn,
        reason: leaveLedger.reason,
      })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.bfImportRunId, p.runId),
          sql`coalesce(${leaveLedger.reason}, '') not like ${`${LEAVE_BF_REVERSAL_REASON_PREFIX}%`}`,
        ),
      )
      // Explicit ORDER BY: the inserted array is asserted in the guard, and an unordered scan is not a
      // fact (CLAUDE.md §8).
      .orderBy(leaveLedger.effectiveOn, leaveLedger.employmentId, leaveLedger.id);

    if (original.length) {
      await tx.insert(leaveLedger).values(
        original.map((r) => ({
          tenantId: ctx.tenantId,
          employmentId: r.employmentId,
          leaveTypeId: r.leaveTypeId,
          // ⚠️ 'adjustment' here too: a rollback row that was an accrual would re-create the very trap the
          // import exists to avoid, on the way OUT.
          entryType: LEAVE_BF_ENTRY_TYPE,
          days: (-Number(r.days)).toFixed(2),
          sourceRequestId: null,
          // ITS OWN date. See the header.
          effectiveOn: r.effectiveOn,
          // A HUMAN reason, not a 'sys:' code — this was a person undoing a person's action, and
          // classifyLedgerAdjustment must keep counting it as a config adjustment like its original.
          reason: `${LEAVE_BF_REVERSAL_REASON_PREFIX}: ${r.reason ?? LEAVE_BF_REASON_DEFAULT}`.slice(0, 500),
          bfImportRunId: p.runId,
        })),
      );
    }

    await tx
      .update(leaveBfImportRun)
      .set({ reversedAt: sql`now()`, reversedByUserId: ctx.userId ?? null })
      .where(eq(leaveBfImportRun.id, p.runId));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-bf-import',
      aggregateId: p.runId,
      eventType: 'leave-bf-import.reversed',
      actor: actorOf(ctx),
      payload: { reversed: original.length, entryType: LEAVE_BF_ENTRY_TYPE },
    });

    return { reversed: original.length };
  });
}

/** Past runs, most recent first. RLS (migration 0497) is the authority: admin-only, tenant-scoped. */
export function listLeaveBfImportRuns(
  ctx: SessionContext,
  opts?: { limit?: number },
): Promise<LeaveBfRunRow[]> {
  const limit = Math.max(1, Math.min(LEAVE_BF_RUN_LIMIT, opts?.limit ?? LEAVE_BF_RUN_LIMIT));
  return withTenant(ctx, async (tx: Tx) => {
    const rows = await tx
      .select({
        id: leaveBfImportRun.id,
        actorName: person.fullName,
        fileName: leaveBfImportRun.fileName,
        importMode: leaveBfImportRun.importMode,
        totalRows: leaveBfImportRun.totalRows,
        importedRows: leaveBfImportRun.importedRows,
        failedRows: leaveBfImportRun.failedRows,
        ledgerRows: leaveBfImportRun.ledgerRows,
        errors: leaveBfImportRun.errors,
        errorsTruncated: leaveBfImportRun.errorsTruncated,
        reversedAt: leaveBfImportRun.reversedAt,
        createdAt: leaveBfImportRun.createdAt,
      })
      .from(leaveBfImportRun)
      .leftJoin(person, eq(person.id, leaveBfImportRun.createdByPersonId))
      // Explicit ORDER BY: the screen asserts "most recent first" and an unordered scan is not a fact
      // (CLAUDE.md §8). Tie-broken on id so two runs committed inside the same millisecond still come back
      // in a stable order.
      .orderBy(sql`${leaveBfImportRun.createdAt} desc`, sql`${leaveBfImportRun.id} desc`)
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      actorName: r.actorName,
      fileName: r.fileName,
      // Narrowed on read rather than asserted: the DB CHECK confines the column to the two values, and a
      // row written by an older or newer shape renders as the default rather than crashing the log.
      mode: (r.importMode === 'add' ? 'add' : 'replace') as LeaveBfImportMode,
      totalRows: r.totalRows,
      importedRows: r.importedRows,
      failedRows: r.failedRows,
      ledgerRows: r.ledgerRows,
      // jsonb arrives as `unknown`; a row written by an older or newer shape renders as "no detail" rather
      // than crashing the log for every other run beside it.
      errors: Array.isArray(r.errors) ? (r.errors as LeaveBfImportError[]) : [],
      errorsTruncated: r.errorsTruncated,
      reversedAt: r.reversedAt ? r.reversedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
