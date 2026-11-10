import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

/**
 * Exclusive Access lock for maintenance, operator tools and rare governance actions that must run while
 * ordinary writers hold the lock shared all day (reader/writer Access lock, wave 4).
 *
 * A plain try never succeeds while shared writers keep overlapping, so that work starves. An unbounded
 * wait keeps its place in the lock queue, and PostgreSQL queues every later shared writer behind it for
 * as long as the oldest shared holder runs. Each attempt here queues for at most `waitMs`, so later
 * shared writers are delayed by at most that while the current short holders drain. A long holder still
 * running at the deadline costs the attempt, not the transaction: the caller holds nothing, backs off and
 * asks again. Take it before any other tenant-wide lock, as the editor lock order requires.
 */
export type AccessExclusiveWaitOptions = Readonly<{
  /** Queue time per attempt. Short, because later shared writers wait behind it. */
  waitMs?: number;
  /** Attempts, including the first. */
  attempts?: number;
  /** First back-off; doubles each attempt, with jitter, up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
}>;

export const ACCESS_EXCLUSIVE_WAIT_MS = 250;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One queued attempt. True when this transaction now holds the exclusive Access lock to commit. */
export async function tryAccessConfigurationExclusiveQueuedTx(tx: Tx, tenantId: string, waitMs = ACCESS_EXCLUSIVE_WAIT_MS): Promise<boolean> {
  const [row] = await tx.execute<{owned: boolean}>(sql`select app.access_configuration_exclusive_wait(${tenantId}::uuid,${waitMs}::integer) as owned`);
  return row?.owned === true;
}

/** Bounded attempts with exponential back-off between them. Returns false when every attempt met a long
 * holder; the caller decides whether that is a retry later (maintenance) or a refusal (a request). */
export async function waitAccessConfigurationExclusiveTx(tx: Tx, tenantId: string, options: AccessExclusiveWaitOptions = {}): Promise<boolean> {
  const waitMs = options.waitMs ?? ACCESS_EXCLUSIVE_WAIT_MS, attempts = options.attempts ?? 4;
  const firstBackoff = options.backoffMs ?? 100, maxBackoff = options.maxBackoffMs ?? 2000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) throw new Error('Access lock wait unavailable');
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await tryAccessConfigurationExclusiveQueuedTx(tx, tenantId, waitMs)) return true;
    if (attempt + 1 < attempts) {
      const ceiling = Math.min(maxBackoff, firstBackoff * 2 ** attempt);
      await pause(Math.round(ceiling / 2 + Math.random() * ceiling / 2));
    }
  }
  return false;
}
