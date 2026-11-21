'use server';

import { requireAdmin } from '@/lib/authz';
import { parseCsvRecords } from '@/lib/csv';
import {
  validateLeaveImport,
  type LeaveImportPreview,
  type LeaveImportSource,
} from '@/core/leave-import';
import { createLeaveImportJob } from '@/core/leave-import-job';
import type { LeaveImportJobProgress } from '@/lib/leave-import-job';

/** Dry-run validation. Returns a per-row preview; writes nothing. Server re-validates on commit,
 *  so this preview is advisory only. */
export async function validateLeaveImportAction(csv: string): Promise<LeaveImportPreview> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return validateLeaveImport(s, { records });
}

/** Start the import of the valid rows as a background job (shared bulk-job kernel, kind `leave_ledger`). No ledger
 *  row is written in this request: the import worker re-validates the whole file under the creator's authority, then
 *  writes each row under its own locks, so a tampered client preview can't widen what gets written. */
export async function commitLeaveImportAction(
  csv: string,
  source?: LeaveImportSource,
): Promise<{ job: LeaveImportJobProgress }> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return { job: await createLeaveImportJob(s, { records, source }) };
}
