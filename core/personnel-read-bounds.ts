import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { tryLockAccessConfigurationReadTx } from './access-configuration-lock';

export class PersonnelReadBusyError extends Error {
  constructor(readonly reason: 'access-lock' | 'statement-timeout', options?: ErrorOptions) {
    super('Personnel is temporarily busy.', options);
    this.name = 'PersonnelReadBusyError';
  }
}

// Retry admission misses after the transaction returns its connection to the pool.
const retryDelays = [40, 100, 220];

export async function withPersonnelRead<T>(ctx: SessionContext, read: (tx: Tx) => Promise<T>, options: { existingTx?: Tx } = {}): Promise<T> {
  const boundedRead = async (tx: Tx) => {
    if (!await tryLockAccessConfigurationReadTx(tx, ctx.tenantId)) throw new PersonnelReadBusyError('access-lock');
    // Keep any tighter caller deadline. SET LOCAL is cleared with this transaction.
    await tx.execute(sql`select set_config('statement_timeout', least(
      coalesce(nullif(setting::int, 0), 20000), 20000)::text, true)
      from pg_catalog.pg_settings where name = 'statement_timeout'`);
    return read(tx);
  };
  try {
    if (options.existingTx) return await boundedRead(options.existingTx);
    for (const retryDelay of retryDelays) {
      try {
        return await withTenant(ctx, boundedRead);
      } catch (error) {
        if (!(error instanceof PersonnelReadBusyError) || error.reason !== 'access-lock') throw error;
        await delay(retryDelay);
      }
    }
    return await withTenant(ctx, boundedRead);
  } catch (error) {
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
      if ('code' in cause && cause.code === '57014') throw new PersonnelReadBusyError('statement-timeout', { cause: error });
      if (cause.cause === cause) break;
    }
    throw error;
  }
}
