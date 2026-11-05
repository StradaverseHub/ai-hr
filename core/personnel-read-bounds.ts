import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { tryLockAccessConfigurationReadTx, tryLockAccessConfigurationTx } from './access-configuration-lock';

export class PersonnelReadBusyError extends Error {
  constructor(options?: ErrorOptions) {
    super('Personnel is temporarily busy.', options);
    this.name = 'PersonnelReadBusyError';
  }
}

export async function withPersonnelRead<T>(ctx: SessionContext, read: (tx: Tx) => Promise<T>, options?: { sharedAccessLock: true } | { existingTx: Tx }): Promise<T> {
  const existingTx = options && 'existingTx' in options ? options.existingTx : undefined;
  const tryLock = options && 'sharedAccessLock' in options ? tryLockAccessConfigurationReadTx : tryLockAccessConfigurationTx;
  const boundedRead = async (tx: Tx) => {
    if (!await tryLock(tx, ctx.tenantId)) throw new PersonnelReadBusyError();
    // Keep any tighter caller deadline. SET LOCAL is cleared with this transaction.
    await tx.execute(sql`select set_config('statement_timeout', least(
      coalesce(nullif(setting::int, 0), 20000), 20000)::text, true)
      from pg_catalog.pg_settings where name = 'statement_timeout'`);
    return read(tx);
  };
  try {
    return await (existingTx ? boundedRead(existingTx) : withTenant(ctx, boundedRead));
  } catch (error) {
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
      if ('code' in cause && cause.code === '57014') throw new PersonnelReadBusyError({ cause: error });
      if (cause.cause === cause) break;
    }
    throw error;
  }
}
