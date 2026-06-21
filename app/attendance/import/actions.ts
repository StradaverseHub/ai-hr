'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { importAttendancePunches, type PunchImportResult } from '@/core/attendance';

/** Dry-run reconcile. Returns the per-day preview; writes nothing. */
export async function dryRunPunchImportAction(csvText: string): Promise<PunchImportResult> {
  const s = await requireAdmin();
  return importAttendancePunches(s, { csvText, dryRun: true });
}

/** Commit the reconciled rows. Re-reconciles server-side (the client preview is never trusted) and
 *  upserts one attendance row per (employee, business day). */
export async function commitPunchImportAction(csvText: string): Promise<PunchImportResult> {
  const s = await requireAdmin();
  const result = await importAttendancePunches(s, { csvText, dryRun: false });
  revalidatePath('/attendance');
  return result;
}
