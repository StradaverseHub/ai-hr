/**
 * c8052ae3 — THE RECORD OF WHAT THE MEDICAL / HOSPITALIZATION RESET REMOVED, and the reader that makes it
 * a promise kept.
 *
 * The approved plan tells the reporter, in these words: "Before anything is removed, copy every affected
 * record into a permanent written record you can read on screen and download, so the old figures are never
 * lost." The table (migration 0416) is the first half; this module and
 * /admin/leave/entitlements/ledger-archive are the second, and without them the promise is a row count in
 * a table nobody can open.
 *
 * ⚠️ THE PRECEDENT IS A WARNING AS MUCH AS A MODEL. `leave_shared_group_reset_archive` (0342) has the
 * right SHAPE — denormalised to text so it survives what it describes — and the wrong POSTURE: it is
 * documented as never read, and a test actively asserts no core file reads it. `entitlement_reset_archive`
 * (0397) corrected that by shipping a listing, and this file is the same correction one layer deeper: the
 * rows it describes are not configuration, they are 147 grants to named employees, and this correction
 * DELETES them from a ledger documented as append-only. A record of that which nobody can read would be
 * the worst version of this build.
 *
 * ── IT FEEDS NOTHING ──────────────────────────────────────────────────────────────────────────────────
 * Nothing here is called by any entitlement, accrual, carry-forward or balance path, and nothing here
 * returns a number any engine consumes. Same property `core/entitlement-archive.ts` states and the same
 * reason: evidence that participates in the calculation stops being evidence of what the calculation was.
 *
 * ── THERE IS NO CAPTURE ENTRY POINT HERE, AND THAT IS THE DIFFERENCE FROM entitlement-archive ─────────
 * That module exposes `captureEntitlementResetArchive` because its archive is re-taken by administrators
 * between releases. This one is written ONCE, by an explicitly gated operator script
 * (scripts/reset-medical-hospitalization-ledger.ts) in the same transaction as the deletion it protects.
 * Exposing a capture button here would let the record be re-taken AFTER the rows are gone, which would
 * write an empty snapshot over the top of the only copy. So the writer is SQL called by the script, and
 * this module is strictly a reader.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { withTenant, type SessionContext } from '../db/client';
import { leaveLedgerResetArchive } from '../db/schema';
import { toCsv } from '../lib/csv';

export type LeaveLedgerArchiveLayer = 'ledger' | 'recalc_audit';

export type LeaveLedgerArchiveRow = {
  id: string;
  capturedAt: Date;
  captureTag: string;
  layer: LeaveLedgerArchiveLayer;
  sourceRowId: string | null;
  employeeName: string | null;
  employeeCode: string | null;
  employeeEmail: string | null;
  companyName: string | null;
  leaveTypeName: string | null;
  leaveTypeCode: string | null;
  entryType: string | null;
  daysText: string | null;
  effectiveOnText: string | null;
  reason: string | null;
  entitlementText: string | null;
  sourceRequestText: string | null;
  recordedAtText: string | null;
  note: string | null;
};

/** The capture runs present, newest first, with their row counts. A rehearsal against a restored copy and
 *  the real run are two tags, and the listing offers the choice rather than interleaving them. */
export async function listLeaveLedgerArchiveCaptures(
  ctx: SessionContext,
): Promise<{ captureTag: string; capturedAt: Date; rows: number }[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        captureTag: leaveLedgerResetArchive.captureTag,
        capturedAt: sql<Date>`max(${leaveLedgerResetArchive.capturedAt})`,
        rows: sql<number>`count(*)::int`,
      })
      .from(leaveLedgerResetArchive)
      .groupBy(leaveLedgerResetArchive.captureTag)
      .orderBy(desc(sql`max(${leaveLedgerResetArchive.capturedAt})`));
    return rows.map((r) => ({
      captureTag: r.captureTag,
      capturedAt: new Date(r.capturedAt),
      rows: Number(r.rows),
    }));
  });
}

/**
 * One capture's rows. `captureTag` absent ⇒ the most recent capture, which is what the screen opens on.
 *
 * Ordered so a human can read it and so the CSV and the screen can never disagree: the ledger layer first
 * (that is what was removed), then by employee, leave type and effective date — an employee's own history
 * reads top to bottom, which is how somebody checking "what did Mei Ling lose" will read it.
 */
export async function listLeaveLedgerResetArchive(
  ctx: SessionContext,
  p?: { captureTag?: string },
): Promise<LeaveLedgerArchiveRow[]> {
  return withTenant(ctx, async (tx) => {
    let tag = p?.captureTag;
    if (!tag) {
      const [latest] = await tx
        .select({ captureTag: leaveLedgerResetArchive.captureTag })
        .from(leaveLedgerResetArchive)
        .orderBy(desc(leaveLedgerResetArchive.capturedAt))
        .limit(1);
      tag = latest?.captureTag;
      if (!tag) return [];
    }
    const rows = await tx
      .select()
      .from(leaveLedgerResetArchive)
      .where(and(eq(leaveLedgerResetArchive.captureTag, tag)))
      .orderBy(
        // 'ledger' < 'recalc_audit' alphabetically, so the natural sort happens to be the one we want —
        // stated on the flag anyway so a future layer name cannot silently reorder the record.
        sql`case when ${leaveLedgerResetArchive.layer} = 'ledger' then 0 else 1 end`,
        asc(leaveLedgerResetArchive.employeeName),
        asc(leaveLedgerResetArchive.leaveTypeName),
        asc(leaveLedgerResetArchive.effectiveOnText),
      );
    return rows.map((r) => ({ ...r, layer: r.layer as LeaveLedgerArchiveLayer }));
  });
}

/** The CSV. The half of the promise a browser table cannot keep on its own — 147 rows across two layers
 *  is checked in a spreadsheet, not by scrolling. Same rows, same order, as the screen. */
export async function leaveLedgerResetArchiveCsv(
  ctx: SessionContext,
  p?: { captureTag?: string },
): Promise<{ content: string; filename: string; rows: number }> {
  const rows = await listLeaveLedgerResetArchive(ctx, p);
  const header = [
    'Record type',
    'Employee',
    'Employee code',
    'Email',
    'Company',
    'Leave type',
    'Leave type code',
    'Entry type',
    'Days',
    'Effective on',
    'Reason',
    'Recalculation',
    'Leave request',
    'Recorded at',
    'Original row id',
    'Note',
  ];
  const body = rows.map((r) => [
    r.layer === 'ledger' ? 'Balance record' : 'Recalculation history',
    r.employeeName ?? '',
    r.employeeCode ?? '',
    r.employeeEmail ?? '',
    r.companyName ?? '',
    r.leaveTypeName ?? '',
    r.leaveTypeCode ?? '',
    r.entryType ?? '',
    r.daysText ?? '',
    r.effectiveOnText ?? '',
    r.reason ?? '',
    r.entitlementText ?? '',
    // Spelling the "no request" case out matters more in a spreadsheet than on screen: a blank cell there
    // reads as "unknown", and the whole safety argument for deleting these rows is that NONE of them came
    // from leave anybody took.
    r.sourceRequestText ?? (r.layer === 'ledger' ? 'not sourced from a leave request' : ''),
    r.recordedAtText ?? '',
    r.sourceRowId ?? '',
    r.note ?? '',
  ]);
  const tag = rows[0]?.captureTag ?? 'empty';
  return {
    content: toCsv([header, ...body]),
    filename: `leave-balance-record_${tag.replace(/[^a-zA-Z0-9._-]+/g, '-')}.csv`,
    rows: rows.length,
  };
}
