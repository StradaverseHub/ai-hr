'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { parseCsvRecords } from '@/lib/csv';
import {
  validateLeaveHistoryImport,
  commitLeaveHistoryImport,
} from '@/core/leave-history-import';
import type {
  LeaveHistoryImportPreview,
  LeaveHistoryImportResult,
  LeaveHistoryImportSource,
} from '@/lib/leave-history-import-schema';

/**
 * 3f15ffdb (r362) — the two server actions behind Leave History Data Import.
 *
 * Both receive plain CSV TEXT, never a workbook: the .xlsx is decoded in the browser by
 * `lib/import-file.ts` (the repo's single decode path) into exactly the text a paste would have
 * produced, so no spreadsheet parser ever runs on a server action's argument. Both re-derive
 * everything from that text — the client's preview is advisory and is never trusted.
 *
 * `requireAdmin()` on both, which is ticket point 11: a normal employee cannot reach this function.
 * The run log is additionally admin-only at the ROW level by RLS (migration 0490), and the importer
 * checks per-row company authority inside `analyze()` so a company-scoped admin's out-of-authority
 * rows are refused in the PREVIEW rather than silently at write time.
 */

/**
 * Dry run. Returns the per-row preview; writes nothing at all.
 *
 * r367 — takes the run's `openingBalancesAreNet` answer as an explicit BOOLEAN rather than an optional
 * flag, so the client cannot reach the "deduct" arithmetic by omission and the two actions cannot drift
 * apart. The default lives once, in `resolveLeaveHistoryImportOptions`, and the screen reads it from the
 * contract rather than hard-coding `false` of its own.
 */
export async function validateLeaveHistoryImportAction(
  csv: string,
  openingBalancesAreNet: boolean,
): Promise<LeaveHistoryImportPreview> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return validateLeaveHistoryImport(s, { records, openingBalancesAreNet });
}

/**
 * Commit the valid rows. Re-validates server-side, so a tampered preview cannot widen what is written.
 *
 * r367 — AND THE BALANCE ANSWER IS RE-RESOLVED HERE TOO. The commit passes its OWN argument to
 * `commitLeaveHistoryImport`, which re-runs `analyze` with it; nothing about the deduction is taken from
 * the preview object the browser is holding. That matters because the two calls are separate requests and
 * this one is the one that writes money.
 */
export async function commitLeaveHistoryImportAction(
  csv: string,
  openingBalancesAreNet: boolean,
  source?: LeaveHistoryImportSource,
): Promise<LeaveHistoryImportResult> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitLeaveHistoryImport(s, { records, source, openingBalancesAreNet });
  // The import log lives on this page and is server-rendered, so it must be re-read after a commit.
  revalidatePath('/admin/leave-config/history-import');
  // …and the records themselves land in leave history, on both the admin register and the self-view.
  revalidatePath('/leave');
  revalidatePath('/leave/employee-records');
  // r367 — …and, when the run deducted, the BALANCE surfaces move too. Employee Balances is the tab the
  // reporter was looking at when Taken read 0.00 beside six records, and it is server-rendered.
  revalidatePath('/leave/employee-balances');
  revalidatePath('/me');
  return result;
}
