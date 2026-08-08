/**
 * c8052ae3 — THE ONE-OFF CORRECTION: take Medical Leave and Hospitalization Leave to exactly 0.00 for
 * every employee, by archiving and then DELETING the leave_ledger rows behind them.
 *
 *   node --env-file=.env.production --import tsx scripts/reset-medical-hospitalization-ledger.ts
 *   node --env-file=.env.production --import tsx scripts/reset-medical-hospitalization-ledger.ts --apply
 *
 * REPORT-ONLY BY DEFAULT, like scripts/apply-dunning.ts and scripts/reactivate-tenant.ts. Without --apply
 * it prints exactly what it would archive and remove, per leave type and per employee, and writes nothing.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ THE APPEND-ONLY POSTURE OF leave_ledger IS BEING SET ASIDE HERE, DELIBERATELY, FOR THIS ONE
 *    CORRECTION. READ THIS BEFORE RUNNING IT, AND BEFORE COPYING ANY OF IT INTO ANYTHING ELSE.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `leave_ledger` is documented as append-only. Nothing else in this codebase deletes from it: the bulk
 * Leave Adjustments feature (491c499f, `leave_adjustment_batch`) reverses a batch by writing COMPENSATING
 * ROWS, and every engine — accrual, carry-forward, forfeit, encashment, recalc — only ever appends. That
 * is the right default and this script is not an argument against it.
 *
 * IT IS SET ASIDE HERE FOR FOUR REASONS, ALL OF WHICH MUST HOLD:
 *
 *  1. A COMPENSATING ROW CANNOT DO THE JOB. 27 of the affected rows are grants dated 2027-01-01 and
 *     2028-01-01 — entitlement queued to land by itself in future leave years, from configuration that no
 *     longer exists (168 Medical days, 900 Hospitalization days). Cancelling those with compensating rows
 *     means posting further future-dated rows, one per future year, forever. That is more of the same
 *     problem, not less of it.
 *
 *  2. THE REPORTER WAS PROMISED A CLEAN 0.00, AND A COMPENSATING ROW CANNOT SHOW ONE. The entitlement
 *     breakdown panel reads "YTD entitled" off accrual-class rows. Compensating to zero would leave it
 *     reading "YTD entitled 14.00" with a "−14.00 adjustment" beside it. The approved plan's words are
 *     "both read 0.00 for everyone, on a genuinely clean footing".
 *
 *  3. NOTHING ANYBODY TOOK IS AT STAKE. Measured on production 2026-08-07: ZERO `debit` rows on both
 *     types, zero approved leave requests (one rejected and one cancelled SICK request, neither of which
 *     touches the ledger), zero rows in `leave_encashment_snapshot`, zero in `leave_generation_run_item`,
 *     and zero `toil_accrual.ledger_entry_id` references — the only foreign key that points at
 *     `leave_ledger` at all. THE SCRIPT RE-CHECKS EVERY ONE OF THESE AT RUN TIME AND REFUSES IF ANY HAS
 *     CHANGED (see `guardOrRefuse`). The measurement is a fact about a day, not a licence.
 *
 *  4. IT IS RECOVERABLE. Every row is copied into `leave_ledger_reset_archive` (migration 0416),
 *     denormalised to text so it outlives the rows, the employments and eventually the leave types it
 *     describes — and the copy is COUNTED AND VERIFIED inside the same transaction before a single DELETE
 *     runs. The archive is readable and downloadable at /admin/leave/entitlements/ledger-archive.
 *
 * Remove any one of those four and the deletion stops being justified. If you are here to reuse this for
 * a different cleanup: do not. Write compensating rows.
 *
 * ── AND IT IS NOT THE FIX ────────────────────────────────────────────────────────────────────────────
 * The negatives were NOT caused by leftover entitlement configuration, which is what the ticket assumed.
 * They were written by `reprojectEntitlementForEmployment`, whose "already granted this cycle" sum had a
 * start date and no end date, so the 2027 and 2028 grants counted as this year's and every ordinary
 * profile save posted the difference as a clawback (production: previous 180.00 → new 60.00, delta
 * −120.00). THAT is fixed in core/leave.ts in the same change, and it had to be, or a cleanup run today
 * would come straight back the next time anybody edited an employee. This script only removes the damage
 * already written down.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────────────
 * It calls NO entitlement generation, no year-open and no accrual. Both types must read 0.00 because no
 * rows exist, not because something granted zero. Setting up new entitlement is the reporter's own next
 * step on the Entitlement Tables screen.
 *
 * ENV CONTRACT: MIGRATION_DATABASE_URL (owner role), like the other out-of-band runners. This runs with
 * no session, so there is no RLS tenant to inherit — every statement below is explicitly scoped by
 * `tenant_id` instead, and the tenant is checked against the constant below before anything happens.
 *
 * IT IMPORTS NO LEAVE-PACK MODULE, on purpose. An operator one-off is not a pack consumer, and
 * test/leave-pack-drift.test.ts would be right to say so. It talks to db/schema and to the SQL capture
 * function directly.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import {
  employment,
  leaveEntitlementRecalcAudit,
  leaveLedger,
  leaveLedgerResetArchive,
  leaveRequest,
  leaveType,
  person,
} from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';

// ── THE GATE ─────────────────────────────────────────────────────────────────────────────────────────
// Hardcoded, not parameterised, and that is the safety property rather than an inconvenience. This script
// deletes from an append-only ledger; it may reach exactly one tenant and exactly two leave types, and a
// `--tenant` flag would be one typo away from doing it somewhere else. A second correction needs a second
// script with its own justification, which is the point.
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const LEAVE_TYPE_IDS = [
  '2c8c8e9d-1e44-42e6-a659-1e9a2c5d9bec', // HOSPITALIZATION
  'bcd25ea2-8598-499e-a726-b19babf45e30', // SICK (Medical Leave)
];
// The codes those two ids MUST resolve to. An id that resolves to a different code means this is not the
// database the plan was measured against, and the run stops.
const EXPECTED_CODES = new Set(['HOSPITALIZATION', 'SICK']);
// What the plan measured and what the reporter approved: "147 stored records across the two leave types".
// A different number means the world moved between measurement and correction — which is not necessarily
// wrong, but it is not what was approved, so it needs a human to say so with --expect.
const EXPECTED_LEDGER_ROWS = 147;
// A third type — UPM Unpaid Medical Leave — is explicitly NOT in scope and holds no ledger rows.

function loadEnv() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // env supplied directly
    }
  }
}

/**
 * A Postgres uuid[] bound from a JS array.
 *
 * ⚠️ `sql`...${ids}::uuid[]`` DOES NOT WORK and fails at run time, not at compile time: drizzle SPREADS a
 * JS array into one placeholder per element, so the statement goes out as `($3)::uuid[]` with a bare uuid
 * string bound to it and Postgres answers `malformed array literal`. Found by
 * test/leave-ledger-reset-archive.test.ts, which sends the same shapes this file does precisely because
 * this file is never executed in a test.
 */
const uuidArray = (ids: string[]) => sql`array[${sql.join(ids.map((v) => sql`${v}::uuid`), sql`, `)}]::uuid[]`;

const argOf = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

export type ResetReport = {
  tag: string;
  apply: boolean;
  types: { leaveTypeId: string; code: string; name: string; rows: number; employments: number; days: number }[];
  ledgerRows: number;
  auditRows: number;
  debitRows: number;
  requestSourcedRows: number;
  approvedRequests: number;
  encashmentSnapshots: number;
  perEmployee: { employee: string; code: string; leaveType: string; rows: number; days: number }[];
  archived: { ledger: number; audit: number } | null;
  deleted: { ledger: number; audit: number } | null;
  refusals: string[];
};

export async function runReset(
  url: string,
  opts: { apply: boolean; tag?: string; expect?: number },
): Promise<ResetReport> {
  const owner = createDb(url);
  const tag = opts.tag ?? `c8052ae3-${todayInKualaLumpur()}`;
  const expect = opts.expect ?? EXPECTED_LEDGER_ROWS;
  const refusals: string[] = [];

  // ── 1. IDENTITY. Do the two ids exist, in THIS tenant, with the codes the plan measured? ───────────
  const types = await owner.db
    .select({ id: leaveType.id, code: leaveType.code, name: leaveType.name, tenantId: leaveType.tenantId })
    .from(leaveType)
    .where(inArray(leaveType.id, LEAVE_TYPE_IDS));
  if (types.length !== LEAVE_TYPE_IDS.length) {
    refusals.push(
      `expected ${LEAVE_TYPE_IDS.length} leave types by id, found ${types.length} — this is not the database the plan measured.`,
    );
  }
  for (const t of types) {
    if (t.tenantId !== TENANT_ID) refusals.push(`leave type ${t.code} belongs to tenant ${t.tenantId}, not ${TENANT_ID}.`);
    if (!EXPECTED_CODES.has(t.code)) refusals.push(`leave type ${t.id} has code '${t.code}', which is not in scope.`);
  }

  const scope = and(eq(leaveLedger.tenantId, TENANT_ID), inArray(leaveLedger.leaveTypeId, LEAVE_TYPE_IDS));

  // ── 2. THE CENSUS, per type and per employee. This is the whole of the report-only output. ─────────
  const perType = await owner.db
    .select({
      leaveTypeId: leaveLedger.leaveTypeId,
      rows: sql<number>`count(*)::int`,
      employments: sql<number>`count(distinct ${leaveLedger.employmentId})::int`,
      days: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
    })
    .from(leaveLedger)
    .where(scope)
    .groupBy(leaveLedger.leaveTypeId);

  const perEmployee = await owner.db
    .select({
      employee: sql<string>`coalesce(${person.fullName}, '(unnamed)')`,
      code: sql<string>`coalesce(${employment.employeeCode}, '')`,
      leaveType: sql<string>`coalesce(${leaveType.name}, '(unknown)')`,
      rows: sql<number>`count(*)::int`,
      days: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
    })
    .from(leaveLedger)
    .innerJoin(employment, eq(employment.id, leaveLedger.employmentId))
    .leftJoin(person, eq(person.id, employment.personId))
    .leftJoin(leaveType, eq(leaveType.id, leaveLedger.leaveTypeId))
    .where(scope)
    .groupBy(person.fullName, employment.employeeCode, leaveType.name)
    .orderBy(sql`3, 1`);

  const [ledgerCountRow] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveLedger)
    .where(scope);
  const ledgerRows = Number(ledgerCountRow?.n ?? 0);

  const [auditCountRow] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveEntitlementRecalcAudit)
    .where(
      and(
        eq(leaveEntitlementRecalcAudit.tenantId, TENANT_ID),
        inArray(leaveEntitlementRecalcAudit.leaveTypeId, LEAVE_TYPE_IDS),
      ),
    );
  const auditRows = Number(auditCountRow?.n ?? 0);

  // ── 3. THE SAFETY RE-CHECK. Reason 3 in the header is a measurement from a day; these are the same
  //       questions asked again, now, and any non-zero answer stops the run. ──────────────────────────
  const [debitRow] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveLedger)
    .where(and(scope, eq(leaveLedger.entryType, 'debit')));
  const debitRows = Number(debitRow?.n ?? 0);

  const [sourcedRow] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveLedger)
    .where(and(scope, sql`${leaveLedger.sourceRequestId} is not null`));
  const requestSourcedRows = Number(sourcedRow?.n ?? 0);

  const [approvedRow] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.tenantId, TENANT_ID),
        inArray(leaveRequest.leaveTypeId, LEAVE_TYPE_IDS),
        // leave_request_status is exactly pending | approved | rejected | cancelled — there is no
        // 'taken'. Only 'approved' matters: a rejected or cancelled request never touched the ledger.
        eq(leaveRequest.status, 'approved'),
      ),
    );
  const approvedRequests = Number(approvedRow?.n ?? 0);

  const [toilRow] = (await owner.db.execute(
    sql`select count(*)::int as n from toil_accrual ta
        join leave_ledger ll on ll.id = ta.ledger_entry_id
        where ll.tenant_id = ${TENANT_ID}::uuid and ll.leave_type_id = any(${uuidArray(LEAVE_TYPE_IDS)})`,
  )) as unknown as { n: number }[];
  const toilRefs = Number(toilRow?.n ?? 0);

  // ADR-0069: a frozen encashment snapshot makes its (employment, leave type) balance untouchable, and a
  // DB TRIGGER enforces it — a delete against a frozen pair would abort the whole transaction with a
  // trigger error, which is safe but unreadable. Refusing here turns that into a sentence.
  const [snapRow] = (await owner.db.execute(
    sql`select count(*)::int as n from leave_encashment_snapshot
        where tenant_id = ${TENANT_ID}::uuid and leave_type_id = any(${uuidArray(LEAVE_TYPE_IDS)})`,
  )) as unknown as { n: number }[];
  const encashmentSnapshots = Number(snapRow?.n ?? 0);

  const guardOrRefuse = (n: number, what: string) => {
    if (n > 0) refusals.push(`${n} ${what} — the safety argument for deleting these rows does NOT hold. Stopping.`);
  };
  guardOrRefuse(debitRows, 'debit row(s) exist on these leave types (somebody TOOK this leave)');
  guardOrRefuse(requestSourcedRows, 'ledger row(s) are sourced from a leave request');
  guardOrRefuse(approvedRequests, 'approved leave request(s) exist on these leave types');
  guardOrRefuse(toilRefs, 'toil_accrual row(s) reference these ledger rows');
  guardOrRefuse(encashmentSnapshots, 'leave_encashment_snapshot row(s) exist on these leave types (ADR-0069 freezes the balance)');

  if (ledgerRows !== expect) {
    refusals.push(
      `found ${ledgerRows} ledger rows but expected ${expect} (the figure the reporter approved). ` +
        `Re-measure, then re-run with --expect ${ledgerRows} if the difference is understood.`,
    );
  }

  const report: ResetReport = {
    tag,
    apply: opts.apply,
    types: perType.map((r) => {
      const t = types.find((x) => x.id === r.leaveTypeId);
      return {
        leaveTypeId: r.leaveTypeId,
        code: t?.code ?? '(unknown)',
        name: t?.name ?? '(unknown)',
        rows: Number(r.rows),
        employments: Number(r.employments),
        days: Number(r.days),
      };
    }),
    ledgerRows,
    auditRows,
    debitRows,
    requestSourcedRows,
    approvedRequests,
    encashmentSnapshots,
    perEmployee: perEmployee.map((r) => ({
      employee: r.employee,
      code: r.code,
      leaveType: r.leaveType,
      rows: Number(r.rows),
      days: Number(r.days),
    })),
    archived: null,
    deleted: null,
    refusals,
  };

  if (!opts.apply || refusals.length > 0) return report;

  // ── 4. THE CORRECTION, in ONE transaction: archive → VERIFY → delete ledger → delete audit. ────────
  //
  // The order is the plan's and it is not arbitrary. The archive is written and its row count CHECKED
  // AGAINST THE SOURCE COUNT before any DELETE runs, so a partial copy aborts the whole transaction with
  // every row still in place. The recalc-audit rows go LAST because they describe the ledger rows: an
  // audit row outliving its ledger row is a record of a correction to something that no longer exists.
  await owner.db.transaction(async (tx) => {
    const captured = (await tx.execute(
      sql`select ledger_rows, audit_rows from app.capture_leave_ledger_reset_archive(
            ${tag}, ${TENANT_ID}::uuid, ${uuidArray(LEAVE_TYPE_IDS)})`,
    )) as unknown as { ledger_rows: number; audit_rows: number }[];
    const archivedLedger = Number(captured[0]?.ledger_rows ?? 0);
    const archivedAudit = Number(captured[0]?.audit_rows ?? 0);

    // THE VERIFY. Not a log line — a throw, inside the transaction, so a short copy takes the deletes
    // down with it. An archive that is missing rows is exactly the failure this whole design exists to
    // make impossible, and it must never be discovered afterwards.
    const [archivedRow] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(leaveLedgerResetArchive)
      .where(
        and(
          eq(leaveLedgerResetArchive.tenantId, TENANT_ID),
          eq(leaveLedgerResetArchive.captureTag, tag),
          eq(leaveLedgerResetArchive.layer, 'ledger'),
        ),
      )) as { n: number }[];
    const archivedInTable = Number(archivedRow?.n ?? 0);
    if (archivedInTable !== ledgerRows) {
      throw new Error(
        `ARCHIVE INCOMPLETE: ${archivedInTable} row(s) captured under tag '${tag}' but ${ledgerRows} ledger row(s) exist. Nothing deleted.`,
      );
    }
    const [archivedAuditRow] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(leaveLedgerResetArchive)
      .where(
        and(
          eq(leaveLedgerResetArchive.tenantId, TENANT_ID),
          eq(leaveLedgerResetArchive.captureTag, tag),
          eq(leaveLedgerResetArchive.layer, 'recalc_audit'),
        ),
      )) as { n: number }[];
    if (Number(archivedAuditRow?.n ?? 0) !== auditRows) {
      throw new Error(
        `RECALC-AUDIT ARCHIVE INCOMPLETE: ${archivedAuditRow?.n ?? 0} captured but ${auditRows} exist. Nothing deleted.`,
      );
    }

    const deletedLedger = await tx
      .delete(leaveLedger)
      .where(and(eq(leaveLedger.tenantId, TENANT_ID), inArray(leaveLedger.leaveTypeId, LEAVE_TYPE_IDS)))
      .returning({ id: leaveLedger.id });
    const deletedAudit = await tx
      .delete(leaveEntitlementRecalcAudit)
      .where(
        and(
          eq(leaveEntitlementRecalcAudit.tenantId, TENANT_ID),
          inArray(leaveEntitlementRecalcAudit.leaveTypeId, LEAVE_TYPE_IDS),
        ),
      )
      .returning({ id: leaveEntitlementRecalcAudit.id });

    // Belt to the braces: nothing may survive the scope, and nothing outside it may have been touched.
    const [leftRow] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(leaveLedger)
      .where(and(eq(leaveLedger.tenantId, TENANT_ID), inArray(leaveLedger.leaveTypeId, LEAVE_TYPE_IDS)))) as {
      n: number;
    }[];
    if (Number(leftRow?.n ?? 0) !== 0) {
      throw new Error(`${leftRow?.n} ledger row(s) survived the delete — rolling back.`);
    }

    report.archived = { ledger: archivedLedger, audit: archivedAudit };
    report.deleted = { ledger: deletedLedger.length, audit: deletedAudit.length };
  });

  return report;
}

if (process.argv[1]?.endsWith('reset-medical-hospitalization-ledger.ts')) {
  loadEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('reset-medical-hospitalization-ledger requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const expectArg = argOf('--expect');
  runReset(url, {
    apply,
    tag: argOf('--tag') ?? undefined,
    expect: expectArg == null ? undefined : Number(expectArg),
  })
    .then((r) => {
      console.log(`\nc8052ae3 Medical / Hospitalization ledger reset — mode=${r.apply ? 'APPLY' : 'REPORT ONLY'}`);
      console.log(`tenant ${TENANT_ID}, capture tag '${r.tag}'\n`);
      for (const t of r.types) {
        console.log(`  ${t.code.padEnd(16)} ${String(t.rows).padStart(4)} rows  ${String(t.employments).padStart(3)} employees  ${t.days.toFixed(2).padStart(9)} days`);
      }
      console.log(`\n  leave_ledger rows                : ${r.ledgerRows}`);
      console.log(`  leave_entitlement_recalc_audit   : ${r.auditRows}`);
      console.log(`  debit rows (must be 0)           : ${r.debitRows}`);
      console.log(`  request-sourced rows (must be 0) : ${r.requestSourcedRows}`);
      console.log(`  approved requests (must be 0)    : ${r.approvedRequests}`);
      console.log(`  encashment snapshots (must be 0) : ${r.encashmentSnapshots}`);
      console.log('\n  per employee:');
      for (const e of r.perEmployee) {
        console.log(`    ${e.leaveType.padEnd(24)} ${e.employee.padEnd(28)} ${String(e.rows).padStart(3)} rows  ${e.days.toFixed(2).padStart(9)} days`);
      }
      if (r.refusals.length > 0) {
        console.error('\nREFUSED — nothing was written:');
        for (const x of r.refusals) console.error(`  · ${x}`);
        process.exit(1);
      }
      if (!r.apply) {
        console.log(
          `\n  Nothing was written. Re-run with --apply to archive these ${r.ledgerRows} rows into ` +
            `leave_ledger_reset_archive and then remove them.`,
        );
      } else {
        console.log(`\n  ARCHIVED: ${r.archived?.ledger} ledger + ${r.archived?.audit} recalc-audit rows under tag '${r.tag}'.`);
        console.log(`  DELETED : ${r.deleted?.ledger} ledger + ${r.deleted?.audit} recalc-audit rows.`);
        console.log('  Read the record at /admin/leave/entitlements/ledger-archive.');
        console.log('  NO entitlement generation was run — both types now read 0.00 because no rows exist.');
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
