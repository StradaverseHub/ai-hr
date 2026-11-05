import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { tryLockAccessConfigurationReadTx, tryLockAccessConfigurationTx } from './access-configuration-lock';

export class PersonnelReadBusyError extends Error {
  constructor(options?: ErrorOptions) {
    super('Personnel is temporarily busy.', options);
    this.name = 'PersonnelReadBusyError';
  }
}

// Retry only admission misses. No query or write has run, and no connection stays checked out during the delay.
const sharedReadRetryDelays = [40, 100, 220];
class PersonnelAdmissionBusyError extends PersonnelReadBusyError {}

export async function withPersonnelRead<T>(ctx: SessionContext, read: (tx: Tx) => Promise<T>, options?: { sharedAccessLock: true } | { existingTx: Tx }): Promise<T> {
  const existingTx = options && 'existingTx' in options ? options.existingTx : undefined;
  const shared = !!options && 'sharedAccessLock' in options;
  const tryLock = shared ? tryLockAccessConfigurationReadTx : tryLockAccessConfigurationTx;
  const boundedRead = async (tx: Tx) => {
    if (!await tryLock(tx, ctx.tenantId)) throw new PersonnelAdmissionBusyError();
    // Keep any tighter caller deadline. SET LOCAL is cleared with this transaction.
    await tx.execute(sql`select set_config('statement_timeout', least(
      coalesce(nullif(setting::int, 0), 20000), 20000)::text, true)
      from pg_catalog.pg_settings where name = 'statement_timeout'`);
    return read(tx);
  };
  try {
    if (existingTx) return await boundedRead(existingTx);
    for (const retryDelay of shared ? sharedReadRetryDelays : []) {
      try {
        return await withTenant(ctx, boundedRead);
      } catch (error) {
        if (!(error instanceof PersonnelAdmissionBusyError)) throw error;
        await delay(retryDelay);
      }
    }
    return await withTenant(ctx, boundedRead);
  } catch (error) {
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
      if ('code' in cause && cause.code === '57014') throw new PersonnelReadBusyError({ cause: error });
      if (cause.cause === cause) break;
    }
    throw error;
  }
}
