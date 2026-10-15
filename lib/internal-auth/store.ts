import { client } from '../../db/client';
import type { AuthSql } from './record-store';
export { readRecord, writeRecord, deleteRecord, revokeCredentialsSessions } from './record-store';
export type { AuthSql } from './record-store';
export async function authTransaction<T>(lock: string, fn: (tx: AuthSql) => Promise<T>): Promise<T> {
  return await client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('internal-auth:'||$1,0))", [lock]);
    return fn(tx as unknown as AuthSql);
  }) as T;
}
