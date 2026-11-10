'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { parseCsvRecords } from '@/lib/csv';
import {
  validateLeaveImport,
  commitLeaveImport,
  type LeaveImportPreview,
  type LeaveImportResult,
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

/** Commit the valid rows. Re-validates server-side (authority + all rules), so a tampered client
 *  preview can't widen what gets written. Only good rows go in; bad rows are skipped. */
export async function commitLeaveImportAction(
  csv: string,
  source?: LeaveImportSource,
): Promise<LeaveImportResult | { job: LeaveImportJobProgress }> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  // The background path needs the leave import worker; an installation without it keeps importing inline.
  if (process.env.LEAVE_IMPORT_BACKGROUND === 'true') return { job: await createLeaveImportJob(s, { records, source }) };
  const result = await commitLeaveImport(s, { records, source });
  revalidatePath('/admin/leave');
  revalidatePath('/leave');
  return result;
}
