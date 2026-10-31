'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { recomputeAttendance, type RecomputeResult, type RecomputeScope } from '@/core/attendance-recompute';

/** The scope the screen sends. `dryRun` is decided by the action, never by the caller. */
export type RecomputeRequest = Omit<RecomputeScope, 'dryRun'>;

/**
 * Preview. Writes NOTHING — no attendance column, no event, no pay-run mark — and returns exactly the
 * shape Apply returns, including the already-processed pay runs that Apply would flag, so what the
 * reporter reads before pressing Apply is the real consequence rather than a summary of it.
 */
export async function previewRecomputeAction(p: RecomputeRequest): Promise<RecomputeResult> {
  const s = await requireAdmin();
  return recomputeAttendance(s, { ...p, dryRun: true });
}

/**
 * Apply. Re-runs the whole computation server-side (the client's preview is never trusted) and writes
 * only the CALCULATED columns; the stored clock-in and clock-out times are not among them.
 *
 * `revalidatePath('/attendance')` because the Records screens read these figures.
 */
export async function applyRecomputeAction(p: RecomputeRequest): Promise<RecomputeResult> {
  const s = await requireAdmin();
  const result = await recomputeAttendance(s, { ...p, dryRun: false });
  revalidatePath('/attendance');
  revalidatePath('/attendance/recompute');
  return result;
}
