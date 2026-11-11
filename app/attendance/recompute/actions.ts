'use server';

import { requireAdmin } from '@/lib/authz';
import type { SessionContext } from '@/db/client';
import { RecomputeScopeError, type RecomputeScope } from '@/core/attendance-recompute';
import { RecomputeJobRefused, startRecomputeJob, type RecomputeJobProgress } from '@/core/attendance-recompute-job';

/** The scope the screen sends. `dryRun` is decided by the action, never by the caller. */
export type RecomputeRequest = Omit<RecomputeScope, 'dryRun'>;
/** A started job, or why it was refused: a scope or authority sentence, or a code the screen translates. */
export type RecomputeStart = { ok: true; job: RecomputeJobProgress; existing: boolean } | { ok: false; error: string; code?: string };

async function start(s: SessionContext, p: RecomputeRequest, dryRun: boolean, operationKey?: string): Promise<RecomputeStart> {
  try {
    return { ok: true, ...(await startRecomputeJob(s, { ...p, dryRun, operationKey })) };
  } catch (e) {
    if (e instanceof RecomputeScopeError) return { ok: false, error: e.message };
    if (e instanceof RecomputeJobRefused) return { ok: false, error: e.code, code: e.code };
    throw e;
  }
}

/**
 * Preview. Admits a background preview (draft 5045): it writes NOTHING — no attendance column, no event, no
 * pay-run mark — and its result has exactly the shape Apply's has, including the already-processed pay runs that
 * Apply would flag, so what the reporter reads before pressing Apply is the real consequence.
 */
export async function previewRecomputeAction(p: RecomputeRequest, operationKey?: string): Promise<RecomputeStart> {
  const s = await requireAdmin();
  return start(s, p, true, operationKey);
}

/**
 * Apply. Admits a background apply that re-runs the whole computation (the preview is never trusted) and writes
 * only the CALCULATED columns; the stored clock-in and clock-out times are not among them. The screen refreshes
 * the Records figures when the job finishes.
 */
export async function applyRecomputeAction(p: RecomputeRequest, operationKey?: string): Promise<RecomputeStart> {
  const s = await requireAdmin();
  return start(s, p, false, operationKey);
}
