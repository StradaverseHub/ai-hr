/**
 * Bounded transactions for cron sweeps and operator tools (bulk-operation conversion, 10 Nov 2026).
 *
 * These tools used to hold a tenant-wide writer lock (the Access lock, and with it every later clock-in, hire and
 * profile save of the tenant) for their whole run. They now work in short transactions instead: each one takes
 * the same locks, re-reads what it needs, handles items until it has used about OPERATOR_CHUNK_BUDGET_MS, and
 * commits. Every item is still judged under the lock against fresh data, so a run's result is the same; between
 * transactions other work proceeds. Each tool is idempotent per item, so a run stopped part way is completed by
 * running it again.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { AccessConfigurationBusyError } from './access-configuration-lock';
import { waitAccessConfigurationExclusiveTx } from './access-exclusive-wait';

/** About 100 ms of items per transaction, as the employee import chunks (its rehearsal: 200 ms chunks peaked at 1.42 s
 * on a loaded host, 100 ms chunks kept holds near the longest clock-in's). */
export const OPERATOR_CHUNK_BUDGET_MS = 100;

/** Rows a chunk reads at most before it handles them; the time budget usually ends a chunk first. */
export const OPERATOR_CHUNK_ROWS = 400;

/** True once the chunk has used its time budget. The caller always finishes the item in hand first. */
export function chunkDeadline(budgetMs: number = OPERATOR_CHUNK_BUDGET_MS): () => boolean {
  const started = performance.now();
  return () => performance.now() - started >= budgetMs;
}

/** Positive whole number of rows per chunk (tests use 1 to force many chunks); otherwise the default. */
export function chunkRows(requested: number | undefined): number {
  return Number.isSafeInteger(requested) && requested! > 0 ? Math.min(requested!, 5000) : OPERATOR_CHUNK_ROWS;
}

/**
 * The tenant writer lock each chunk of these tools takes first, held to its commit, exactly as their single
 * transaction did. One owner. Under the reader/writer Access lock ordinary writers hold the lock shared all day,
 * so a chunk queues for the exclusive lock in short bounded attempts and backs off from a long holder
 * (core/access-exclusive-wait.ts), then pins the policy generation and configuration rows with
 * app.access_configuration_write_lock(). A chunk that never gets the lock raises the retryable busy error with
 * nothing of its own written; the chunks already committed stay, and the tool is completed by running it again.
 */
export async function lockOperatorChunkTx(tx: Tx, tenantId: string): Promise<void> {
  if (!await waitAccessConfigurationExclusiveTx(tx, tenantId, { attempts: 12, maxBackoffMs: 5000 })) throw new AccessConfigurationBusyError();
  await tx.execute(sql`select app.access_configuration_write_lock()`);
}

