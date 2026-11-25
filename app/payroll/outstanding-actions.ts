'use server';

/**
 * a1a80747 r2 — the Payroll Process list's two calls for keeping its "Reprocess Required" counts current
 * (app/payroll/outstanding-refresh.tsx). Both are thin: the authority is core/payroll-run-outstanding.ts, which checks
 * the payroll module, claims only processed runs the caller administers payroll for, and queues the refresh under the
 * caller's own session; the job re-checks each run before it reads anything.
 *
 * Upkeep, not a command the operator gave: a refusal (module off, the worker still being installed) asks for nothing
 * and the list simply keeps showing what it has.
 */
import { getSession } from '@/lib/session';
import { BulkJobError } from '@/core/bulk-job';
import { ModuleNotEnabledError } from '@/core/entitlements';
import { readPayrollRunOutstandingRefresh, requestPayrollRunOutstandingRefresh, RUN_OUTSTANDING_MAX_RUNS } from '@/core/payroll-run-outstanding';

/** Ask for the given runs' outstanding answers to be worked out again. Returns the job to follow, or null. */
export async function requestPayrollOutstandingRefreshAction(batchIds: unknown): Promise<{ jobId: string | null }> {
  const s = await getSession();
  if (!Array.isArray(batchIds)) return { jobId: null };
  const ids = batchIds.slice(0, RUN_OUTSTANDING_MAX_RUNS).filter((id): id is string => typeof id === 'string');
  try {
    return { jobId: (await requestPayrollRunOutstandingRefresh(s, ids)).jobId };
  } catch (e) {
    if (e instanceof BulkJobError || e instanceof ModuleNotEnabledError) return { jobId: null };
    throw e;
  }
}

/** Where the caller's own refresh job is: 'running', 'done' or 'failed'. */
export async function readPayrollOutstandingRefreshAction(jobId: unknown): Promise<'running' | 'done' | 'failed'> {
  const s = await getSession();
  if (typeof jobId !== 'string') return 'failed';
  try {
    return await readPayrollRunOutstandingRefresh(s, jobId);
  } catch (e) {
    if (e instanceof ModuleNotEnabledError) return 'failed';
    throw e;
  }
}
