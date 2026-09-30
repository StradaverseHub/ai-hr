/**
 * LEAVE BALANCE IMPORT ("Leave Data Import & Migration Tool") — bulk-load leave ledger transactions
 * (opening balances, carry-forward amounts, ad-hoc credits and correcting adjustments) from a
 * paste-CSV, mirroring the
 * dry-run/commit shape of core/import.ts (employee), core/attendance.ts importAttendancePunches, and
 * core/pay-components.ts importBatchComponents.
 *
 * Writes directly into leave_ledger as admin-driven adjustments — exactly the semantics grantAdHocLeave
 * (core/leave.ts) already uses for historical/backdated leave rows: no requestLeave / decideLeave, no
 * eligibility check, no supporting-document requirement. This is a trusted-HR-admin migration path.
 * sourceRequestId is left null for import rows (like grantAdHocLeave), so imported rows are ledger-only.
 *
 * Balance is always computed live from leave_ledger (leaveBalance() = signed sum(days)), so an imported
 * row shows up in the employee's balance immediately — no separate posting step.
 *
 * SCOPE BOUNDARY: this NEVER touches leave_policy or entitlement config. An 'accrual'-type row from the
 * file is a plain ledger accrual against an existing leave type, not an edit to the policy engine.
 *
 * ⚠️ …BUT AN IMPORTED 'accrual' ROW IS STILL READ BY THE ENTITLEMENT ENGINE, AND THAT IS ITEM b2713800.
 * `yearOpenMarkerCond` (core/leave.ts) treats ANY accrual row inside a leave year as that year's own
 * "already opened" marker, with no filter on `reason` — so an imported accrual dated in a year that has NOT
 * yet been generated makes the next Generate Entitlement skip that (employment, leave type) entirely and
 * grant nothing. One import line, and the employee's whole year of entitlement is gone, silently; balances
 * are encashed at resignation, so it is a wrong payment. The importer cannot fix the kernel's marker (two
 * engines depend on it — see that predicate's header), so it SAYS SO at preview time: see the year-open
 * marker if/else in `analyze()`. The message names `adjustment`, which moves the balance identically and is
 * not a marker.
 *
 * TOIL DECISION (v1): in_lieu_accrual (TOIL) is rejected with a clear message. A bare in_lieu_accrual
 * ledger row would have no companion toil_accrual row (db/migrations/0076_toil.sql) and would be
 * invisible to the TOIL expiry sweep — a silent data-integrity gap. TOIL import is a named follow-up.
 *
 * YEAR-BOUNDARY DECISION (v1, option a): openLeaveYear / the carry-forward forfeit sweep both scan
 * leave_ledger by effectiveOn range, so a row backdated into a year that has ALREADY been rolled over
 * for that employee can retroactively change what a prior openLeaveYear computed. We do NOT block such
 * rows (final-pay reconciliation legitimately needs backdated history), but flag them as a non-blocking
 * 'rolled-over year' warning so HR is told to re-run openLeaveYear for the affected year if needed.
 *
 * b2713800 corrected that warning's KEY. It read "an accrual row dated at 1 January" — exact only until
 * r193 moved the grant to max(1 January, entitlement-table start, join date). It now asks the kernel's own
 * question (any accrual row inside the leave year), which is also what makes its new `else` branch honest.
 */
// `and` and `sql` left with the 1-January marker query b2713800 removed (the marker set is now derived in
// memory from the one ledger read). `inArray` / `isNull` were already unused before it.
import { eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { employment, person, employeeStatutoryMy, leaveType, leaveLedger } from '../db/schema';
import { isGroupAdmin, hasGrantFor, withEffectiveGrants } from '../lib/authz';
import { listLeaveTypes } from './read';
import { isReplacementLeaveType } from './ess-view';
import { leaveCreditRegisterLive } from './leave-credit-live';
import {
  LEAVE_IMPORT_COLUMNS,
  LEAVE_IMPORT_ENTRY_TYPES,
  type LeaveImportEntryType,
  type LeaveImportRecord,
  type LeaveRowResult,
  type LeaveImportPreview,
  type LeaveImportResult,
  type LeaveImportSource,
} from '../lib/leave-import-schema';

export {
  LEAVE_IMPORT_COLUMNS,
  LEAVE_IMPORT_ENTRY_TYPES,
  type LeaveImportEntryType,
  type LeaveImportRecord,
  type LeaveRowResult,
  type LeaveImportPreview,
  type LeaveImportResult,
  type LeaveImportSource,
};

// YYYY-MM-DD with real month/day ranges (mirrors DATE_RE in core/import.ts L33).
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const onlyDigits = (s: string) => s.replace(/\D+/g, '');
const norm = (s: string | undefined) => (s ?? '').trim();
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A resolved employment matched from a file's employee_id, carrying the fields analyze() needs. */
type MatchedEmp = { id: string; companyId: string; terminated: boolean };

/** A row that passed validation and is ready to write, paired with its preview result. */
type ResolvedRow = {
  result: LeaveRowResult;
  employmentId: string;
  leaveTypeId: string;
  entryType: LeaveImportEntryType;
  days: number;
  effectiveOn: string;
  dedupeKey: string; // employment|leaveType|entryType|effectiveOn|days — the ticket's duplicate key
};

/**
 * Pure validation phase (dry run). Reads the tenant's employments + leave types once, then validates
 * each record in memory:
 *  - authority (per-row, so the preview reflects true commit-ability under RLS — no fake "Success")
 *  - employee_id → employment (active OR terminated; terminated is a warning, not "not found")
 *  - leave_type → non-archived leaveType.code (case-insensitive)
 *  - transaction_type → entryType enum (in_lieu_accrual rejected)
 *  - sign-vs-entryType invariant
 *  - date format, mandatory fields, finite non-zero days
 *  - in-file duplicate (error) + already-in-ledger duplicate (warning + skip-on-commit)
 *  - the year-open marker, BOTH WAYS: rolled-over-year warning where a marker exists, and the
 *    cancelled-entitlement warning on an 'accrual' row where one does NOT (b2713800). Both non-blocking.
 */
async function analyze(
  ctx: SessionContext,
  records: LeaveImportRecord[],
): Promise<{ preview: LeaveImportPreview; resolved: ResolvedRow[] }> {
  const effective = withEffectiveGrants(ctx);
  const groupAdmin = isGroupAdmin(effective);

  // Leave types (non-archived) matched by code, case-insensitive. listLeaveTypes lives in core/read.
  const types = await listLeaveTypes(ctx);
  const typeByCode = new Map(types.map((t) => [t.code.toLowerCase(), t.id]));
  // 3fb1a611 (r299) — the Replacement Leave type(s): an imported row on one is a balance with no credit behind
  // it (no date worked, no expiry, no place in the expiring-first order), the same ghost Leave Adjustments now
  // refuses. Replacement Leave balances change on Leave Config › Leave Credit.
  const replacementTypeIds = new Set(types.filter((t) => isReplacementLeaveType(t)).map((t) => t.id));
  // …ONLY WHILE THE TENANT'S LEAVE CREDIT REGISTER IS LIVE (fix pass, D3) — the same condition, for the same
  // reason, as Leave Adjustments (core/leave-adjustment.ts): without the paid `toil` module there is no Leave
  // Credit screen to go to, and the import is main@60a40452's. Asked lazily, once, and only when a row actually
  // names a Replacement Leave type, so a file of other types never reaches an entitlement question.
  let registerLive: boolean | undefined;
  const leaveCreditLive = () => (registerLive ??= leaveCreditRegisterLive(ctx));

  // Every employment the caller may see (RLS-scoped), matched on employeeCode / primaryEmail / IC.
  // NOT active-only: leave history migration routinely includes people who have since left (their final
  // unconsumed balance matters for final-pay reconciliation). Match ALL employments; terminated ones are
  // flagged, never conflated with "not found".
  const { emps, existingKeys, openedYears } = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: employment.id,
        companyId: employment.companyId,
        code: employment.employeeCode,
        email: person.primaryEmail,
        ic: employeeStatutoryMy.icNumber,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId));
    // Existing ledger rows keyed on (employment|leaveType|entryType|effectiveOn|days) so a re-upload of an
    // already-loaded batch is a no-op (warning + skip on commit), per the ticket's dedupe requirement.
    const ledger = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        entryType: leaveLedger.entryType,
        effectiveOn: leaveLedger.effectiveOn,
        days: leaveLedger.days,
      })
      .from(leaveLedger);
    const existingKeys = new Set(
      ledger.map((l) => `${l.employmentId}|${l.leaveTypeId}|${l.entryType}|${l.effectiveOn}|${round2(Number(l.days)).toFixed(2)}`),
    );
    // ⚠️ THE YEAR-OPEN MARKER, KEYED THE WAY THE KERNEL KEYS IT. `yearOpenMarkerCond` (core/leave.ts,
    // read its header) is `entryType = 'accrual' AND effective_on BETWEEN <year>-01-01 AND <year>-12-31`:
    // ANY accrual row inside the leave year, deliberately WITHOUT a filter on `reason`. Two kernel engines
    // consume it — `openLeaveYear` (do not grant twice) and `expireCarriedLeave` (only sweep a year that
    // was opened) — so (employment, leave type, calendar year of effective_on) is the key here too.
    //
    // OLD CLAIM, NOW RETIRED: "an 'accrual' row dated at Jan-1 is openLeaveYear's own open-marker", which
    // is what this set used to select on (`extract(month…) = 1 and extract(day…) = 1`). That was true only
    // until r193 moved the grant to max(1 January, entitlement-table start, join date) — a March joiner's
    // hire grant IS the marker for their first year and is not dated 1 January. A Jan-1-only key made the
    // rolled-over warning below MISS those years, and would have made the new accrual warning beside it
    // fire on rows that cancel nothing.
    //
    // Derived from the ledger read above rather than from a second query: that read is already unfiltered,
    // so the marker set costs nothing extra and cannot drift from the rows the dedupe key is built from.
    const openedYears = new Set(
      ledger
        .filter((l) => l.entryType === 'accrual')
        .map((l) => `${l.employmentId}|${l.leaveTypeId}|${l.effectiveOn.slice(0, 4)}`),
    );
    return { emps: rows, existingKeys, openedYears };
  });

  const byRef = new Map<string, MatchedEmp>();
  for (const e of emps) {
    const m: MatchedEmp = { id: e.id, companyId: e.companyId, terminated: e.terminatedOn != null };
    if (e.code) byRef.set(e.code.toLowerCase(), m);
    if (e.email) byRef.set(e.email.toLowerCase(), m);
    if (e.ic) byRef.set(onlyDigits(e.ic), m);
  }
  const matchRef = (ref: string): MatchedEmp | undefined =>
    byRef.get(ref.toLowerCase()) ?? (onlyDigits(ref) ? byRef.get(onlyDigits(ref)) : undefined);

  // `openedYears` — which (employment, leave type, leave year) pairs already carry a year-open marker — is
  // built from the single ledger read above. It used to be a SECOND query with a 1-January filter; see the
  // retired claim recorded there.

  const presentColumns = new Set(records.length ? Object.keys(records[0]) : []);
  const missingColumns = LEAVE_IMPORT_COLUMNS.required.filter((c) => !presentColumns.has(c));

  const seenInFile = new Set<string>(); // in-file dedupe key
  const resolved: ResolvedRow[] = [];

  records.forEach((rec, idx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const employeeRef = norm(rec.employee_id);
    const leaveTypeRaw = norm(rec.leave_type);
    const txnRaw = norm(rec.transaction_type).toLowerCase().replace(/[\s-]+/g, '_');
    const daysRaw = norm(rec.days).replace(/[,_]/g, '');
    const dateRaw = norm(rec.effective_date);

    // ── Mandatory fields ──
    if (!employeeRef) errors.push('Missing employee_id');
    if (!leaveTypeRaw) errors.push('Missing leave_type');
    if (!txnRaw) errors.push('Missing transaction_type');
    if (!daysRaw) errors.push('Missing days');
    if (!dateRaw) errors.push('Missing effective_date');

    // ── Employee resolution (active + terminated) ──
    const emp = employeeRef ? matchRef(employeeRef) : undefined;
    if (employeeRef && !emp) errors.push(`Employee not found: ${employeeRef}`);
    if (emp?.terminated) warnings.push('Terminated employee');

    // ── Authority: check the acting admin can write for the employee's company. Doing this in analyze()
    //    (not deferred to commit) means the preview never shows a false "Success" for a row that RLS would
    //    reject at commit. ──
    if (emp && !(groupAdmin || hasGrantFor(effective, 'hr_admin', emp.companyId))) {
      errors.push("Not authorized for this employee's company");
    }

    // ── Leave type resolution (non-archived, case-insensitive) ──
    const leaveTypeId = leaveTypeRaw ? typeByCode.get(leaveTypeRaw.toLowerCase()) : undefined;
    if (leaveTypeRaw && !leaveTypeId) errors.push(`Leave type not found: ${leaveTypeRaw}`);
    if (leaveTypeId && replacementTypeIds.has(leaveTypeId) && leaveCreditLive()) {
      errors.push('Replacement Leave balances are changed on Leave Config › Leave Credit, not by import');
    }

    // ── Transaction type → entryType enum (in_lieu_accrual explicitly rejected) ──
    let entryType: LeaveImportEntryType | undefined;
    if (txnRaw) {
      if ((LEAVE_IMPORT_ENTRY_TYPES as readonly string[]).includes(txnRaw)) {
        entryType = txnRaw as LeaveImportEntryType;
      } else if (txnRaw === 'in_lieu_accrual') {
        errors.push('TOIL import not supported — use the TOIL grant tool');
      } else {
        errors.push(`Invalid transaction_type: ${rec.transaction_type}`);
      }
    }

    // ── Days: finite, non-zero, 2dp, sane magnitude, sign-vs-entryType invariant ──
    const daysNum = daysRaw === '' ? NaN : Number(daysRaw);
    let days = NaN;
    if (daysRaw) {
      if (!Number.isFinite(daysNum) || daysNum === 0) {
        errors.push(`Invalid days: ${rec.days}`);
      } else {
        days = round2(daysNum);
        if (Math.abs(days) > 366) warnings.push('Days magnitude over 366');
        // Sign invariant (mirrors every core/leave.ts debit writer using negative days, and grantAdHocLeave's
        // positive-days boundary check). adjustment is the catch-all correction type (opening balance /
        // carry-forward) so it may be either sign.
        if (entryType === 'debit' && days > 0) errors.push('A debit row must have days ≤ 0');
        if ((entryType === 'accrual') && days < 0) errors.push('An accrual row must have days ≥ 0');
      }
    }

    // ── Date format ──
    if (dateRaw && !DATE_RE.test(dateRaw)) errors.push(`effective_date must be YYYY-MM-DD (got "${dateRaw}")`);

    // ── Duplicate detection (only meaningful once the row is otherwise resolvable) ──
    let dedupeKey = '';
    if (emp && leaveTypeId && entryType && Number.isFinite(days) && dateRaw && DATE_RE.test(dateRaw)) {
      dedupeKey = `${emp.id}|${leaveTypeId}|${entryType}|${dateRaw}|${days.toFixed(2)}`;
      if (seenInFile.has(dedupeKey)) {
        errors.push('Duplicate row in this file');
      } else {
        seenInFile.add(dedupeKey);
        if (existingKeys.has(dedupeKey)) warnings.push('Already imported — will be skipped');
      }
      /**
       * ── THE YEAR-OPEN MARKER, BOTH WAYS ROUND (item b2713800) ──────────────────────────────────────
       *
       * One question — "does a year-open marker already exist for this employment, this leave type and
       * this leave year?" — with a different consequence per answer, so the two warnings are one if/else
       * and can never both fire.
       *
       * YES ⇒ the row lands in a year that has ALREADY been granted. Backdated history can retroactively
       * change what that year's openLeaveYear computed, so HR is told to re-run it. Non-blocking: final-pay
       * reconciliation legitimately needs backdated rows (see this file's YEAR-BOUNDARY DECISION).
       *
       * NO, AND THE ROW IS ITSELF AN ACCRUAL ⇒ THE DAMAGING CASE, AND IT IS THE ONE WITH NO PRE-EXISTING
       * ACCRUAL AT ALL. The imported row is what lands FIRST, and by landing it BECOMES the marker: the next
       * Generate Entitlement for that year reads `yearOpenMarkerCond` (core/leave.ts), finds this row, logs
       * `already_open`, and posts NOTHING. The employee's whole year of entitlement is cancelled by an import
       * line, with no error anywhere — and leave balances are encashed at resignation, so the missing days are
       * missing money. A warning conditioned on FINDING an existing accrual is green on exactly these rows,
       * which is why the condition is the absence, not the presence.
       *
       * `adjustment` is the answer the message names because it moves the balance by the same signed days and
       * is NOT a marker — the same reason Leave History Data Import writes `adjustment` and never `accrual`.
       *
       * Only when the row would actually be written: a row with errors is never imported, so telling HR what
       * it will do to the year would be false. The non-damaging accrual (a marker already exists) takes the
       * rolled-over branch instead.
       */
      if (openedYears.has(`${emp.id}|${leaveTypeId}|${dateRaw.slice(0, 4)}`)) {
        warnings.push('Effective date falls in an already-rolled-over leave year');
      } else if (entryType === 'accrual' && errors.length === 0) {
        warnings.push(
          `Entitlement for ${dateRaw.slice(0, 4)} will NOT be generated for this leave type — ` +
            'Generate Entitlement reads an imported accrual row as the leave year already being opened and ' +
            'grants nothing. Use transaction_type "adjustment" for an opening balance or a carry-forward.',
        );
      }
    }

    const ok = errors.length === 0;
    resolved.push({
      result: { rowNum: idx + 1, employeeRef, leaveType: leaveTypeRaw, ok, errors, warnings },
      employmentId: emp?.id ?? '',
      leaveTypeId: leaveTypeId ?? '',
      entryType: (entryType ?? 'adjustment') as LeaveImportEntryType,
      days: Number.isFinite(days) ? days : 0,
      effectiveOn: dateRaw,
      dedupeKey,
    });
  });

  const preview: LeaveImportPreview = {
    total: records.length,
    validCount: resolved.filter((r) => r.result.ok).length,
    rows: resolved.map((r) => r.result),
    missingColumns,
  };
  return { preview, resolved };
}

/** Dry-run wrapper — validates against the tenant catalog + existing ledger, writes nothing. */
export async function validateLeaveImport(
  ctx: SessionContext,
  p: { records: LeaveImportRecord[] },
): Promise<LeaveImportPreview> {
  const { preview } = await analyze(ctx, p.records);
  return preview;
}

/**
 * Commit the valid, non-duplicate, authorized rows. Re-runs analyze() server-side (never trusts the
 * client preview), writes one leave_ledger row per accepted record inside withTenant, continues past a
 * per-row failure so one bad row can't strand the rest (mirrors commitEmployeeImport's not-atomic-by-
 * design loop). RLS WITH CHECK denials (can_see_employment / company-scope rejection, migration
 * 0109_hierarchy_visibility_rls.sql) are caught per-row and surfaced as a clear failure message rather
 * than aborting the whole batch. ONE summary event is appended (per-row skip convention matching
 * grantAdHocLeave / openLeaveYear — the ledger rows are the per-item audit).
 */
export async function commitLeaveImport(
  ctx: SessionContext,
  p: { records: LeaveImportRecord[]; source?: LeaveImportSource },
): Promise<LeaveImportResult> {
  const { resolved } = await analyze(ctx, p.records);
  // Skip = a valid row that already exists in the ledger (already-imported warning) — never written.
  const alreadyImported = (r: ResolvedRow) => r.result.warnings.some((w) => w.startsWith('Already imported'));
  const writable = resolved.filter((r) => r.result.ok && !alreadyImported(r));
  const skipped = resolved.filter((r) => r.result.ok && alreadyImported(r)).length;

  const failed: LeaveImportResult['failed'] = [];
  let imported = 0;
  const batchId = randomUUID();

  // Each row runs in its OWN transaction (like commitEmployeeImport's per-row services): a per-row RLS
  // WITH CHECK denial or FK error aborts only that row's transaction, so the JS catch below can record it
  // and continue. A single shared transaction would go into an aborted state on the first per-row error,
  // failing every subsequent insert AND the summary event too — the not-atomic-by-design requirement.
  for (const r of writable) {
    try {
      await withTenant(ctx, (tx) =>
        tx.insert(leaveLedger).values({
          tenantId: ctx.tenantId,
          employmentId: r.employmentId,
          leaveTypeId: r.leaveTypeId,
          entryType: r.entryType,
          days: r.days.toFixed(2),
          effectiveOn: r.effectiveOn,
          reason: 'Imported (leave migration)',
        }),
      );
      imported += 1;
    } catch (e) {
      // RLS WITH CHECK (can_see_employment / company scope) or any per-row DB error: record + continue.
      failed.push({ rowNum: r.result.rowNum, employeeRef: r.result.employeeRef, message: (e as Error).message });
    }
  }

  // Substrate: ONE summary DomainEvent in its own transaction. Per-row ledger inserts are the per-item
  // audit (deliberate skip, matching grantAdHocLeave / openLeaveYear). No subjectEmploymentId — batch-level.
  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-ledger-import',
      aggregateId: batchId,
      eventType: 'leave.import.completed',
      actor: actorOf(ctx),
      // source: how the batch reached commit (file upload vs paste) so a migration is distinguishable
      // in audit. Payload-only enrichment of THE existing summary event — no new write.
      payload: { imported, failed: failed.length, skipped, totalRows: resolved.length, source: p.source ?? null },
    }),
  );

  return { imported, failed, skipped, totalRows: resolved.length };
}
