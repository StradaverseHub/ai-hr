import type {BulkJobState} from './bulk-job';

const ACTIVE_STATES: readonly BulkJobState[] = ['queued', 'preparing', 'running', 'finalizing', 'discarding'];

/** Where an active job's time goes (docs/PERFORMANCE-TIMING.md): queuedMs from creation to its first claim, workMs the
 * running total of its units, units how many. Running totals stay correct under the claim's greatest() merge of
 * metrics (core/bulk-job-worker.ts) because they only grow. A terminal job's notice units are not the user's wait, so
 * they are not counted. */
export function recordUnitTiming(job: {state: BulkJobState; created_at: Date; metrics: Record<string, number | string> | null},
  metrics: Record<string, number>, unitMs: number, finishedAt = Date.now()): void {
  if (!ACTIVE_STATES.includes(job.state)) return;
  const prior = (name: string) => {const value = Number(job.metrics?.[name]); return Number.isFinite(value) ? value : 0;};
  metrics.workMs = prior('workMs') + Math.max(0, Math.round(unitMs));
  metrics.units = prior('units') + 1;
  if (!prior('queuedMs')) metrics.queuedMs = Math.max(1, Math.round(finishedAt - unitMs - new Date(job.created_at).getTime()));
}
