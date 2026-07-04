'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { parseCsvRecords } from '@/lib/csv';
import {
  validateLeaveImport,
  commitLeaveImport,
  type LeaveImportPreview,
  type LeaveImportResult,
} from '@/core/leave-import';

/** Dry-run validation. Returns a per-row preview; writes nothing. Server re-validates on commit,
 *  so this preview is advisory only. */
export async function validateLeaveImportAction(csv: string): Promise<LeaveImportPreview> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return validateLeaveImport(s, { records });
}

/** Commit the valid rows. Re-validates server-side (authority + all rules), so a tampered client
 *  preview can't widen what gets written. Only good rows go in; bad rows are skipped. */
export async function commitLeaveImportAction(csv: string): Promise<LeaveImportResult> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitLeaveImport(s, { records });
  revalidatePath('/admin/leave');
  revalidatePath('/leave');
  return result;
}
