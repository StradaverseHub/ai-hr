'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { parseCsvRecords } from '@/lib/csv';
import {
  validateLeaveBfImport,
  commitLeaveBfImport,
  reverseLeaveBfImportRun,
} from '@/core/leave-bf-import';
import type {
  LeaveBfImportMode,
  LeaveBfImportPreview,
  LeaveBfImportResult,
  LeaveBfImportSource,
} from '@/lib/leave-bf-import-schema';

/**
 * db55d08a (r369) — the three server actions behind Leave B/F Data Import.
 *
 * Both import actions receive plain CSV TEXT, never a workbook: the .xlsx is decoded IN THE BROWSER by
 * `lib/import-file.ts` (the repo's single decode path) into exactly the text a paste would have produced, so
 * no spreadsheet parser ever runs on a server action's argument. Both re-derive everything from that text —
 * the client's preview is advisory and is never trusted.
 *
 * `requireAdmin()` on all three, matching both sibling importers. The run log is additionally admin-only at
 * the ROW level by RLS (migration 0497), and the importer checks per-row company authority inside its own
 * `analyze()` so a company-scoped admin's out-of-authority rows are refused in the PREVIEW rather than
 * silently at write time.
 */

/**
 * Dry run. Returns the per-row preview and the balance impact; writes nothing at all.
 *
 * The mode is an explicit argument rather than an optional flag, so the client cannot reach one arithmetic
 * by omission and the three actions cannot drift apart. The default lives once, in
 * `resolveLeaveBfImportOptions`, and the screen reads it from the contract rather than hard-coding its own.
 */
export async function validateLeaveBfImportAction(
  csv: string,
  mode: LeaveBfImportMode,
): Promise<LeaveBfImportPreview> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return validateLeaveBfImport(s, { records, mode });
}

/**
 * Commit the valid lines. Re-validates server-side, so a tampered preview cannot widen what is written, and
 * RE-RESOLVES THE MODE from this call's own argument — nothing about which rows are negated is taken from
 * the preview object the browser is holding. That matters because the two calls are separate requests and
 * this one is the one that moves days.
 */
export async function commitLeaveBfImportAction(
  csv: string,
  mode: LeaveBfImportMode,
  source?: LeaveBfImportSource,
): Promise<LeaveBfImportResult> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitLeaveBfImport(s, { records, source, mode });
  revalidateBfSurfaces();
  return result;
}

/**
 * Roll a run back by writing the compensating rows. Never deletes — see `reverseLeaveBfImportRun`.
 *
 * It revalidates the same surfaces a commit does, because a rollback moves exactly the same figures in the
 * opposite direction. The one that is easy to forget is `/me`: the employee's own Leave Balance is the
 * screen the reporter's go-live spot-check compares against Employee Balances.
 */
export async function reverseLeaveBfImportAction(runId: string): Promise<{ reversed: number }> {
  const s = await requireAdmin();
  const out = await reverseLeaveBfImportRun(s, { runId });
  revalidateBfSurfaces();
  return out;
}

/**
 * Every server-rendered surface a brought-forward figure appears on. There is NOTHING TO RECOMPUTE — a
 * balance is derived fresh on every read (`core/read.ts`'s signed ledger sum), so the moment a run
 * commits, Employee Balances and the employee's own My Leave both read the new figure. These calls exist
 * because those pages are CACHED, not because a figure needs rebuilding.
 */
function revalidateBfSurfaces(): void {
  // The import log lives on this page and is server-rendered, so it must be re-read after a write.
  revalidatePath('/admin/leave-config/bf-import');
  // The balance surfaces. Employee Balances is the tab whose Brought Forward / B/F Forfeited columns move.
  revalidatePath('/leave/employee-balances');
  revalidatePath('/me');
}
