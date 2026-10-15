import type { Sql } from 'postgres';
import { client } from '../../db/client';
import { decryptRecord, encryptRecord } from './crypto';
export type AuthSql = Pick<Sql, 'unsafe'>;
export async function readRecord<T>(tx: AuthSql, key: string, lock = false): Promise<T | null> {
  const rows = await tx.unsafe('select sealed from app.internal_auth_read($1,$2)', [key, lock]);
  if (!rows[0]) return null;
  return decryptRecord<T>(rows[0].sealed, key);
}
export async function writeRecord(tx: AuthSql, key: string, value: unknown, owner: string | null, expiresAt: number | null = null) {
  await tx.unsafe('select app.internal_auth_write($1,$2::uuid,$3,$4::timestamptz)',
    [key, owner, encryptRecord(value, key, expiresAt), expiresAt === null ? null : new Date(expiresAt).toISOString()]);
}
export async function deleteRecord(tx: AuthSql, key: string) { await tx.unsafe('select app.internal_auth_delete($1)', [key]); }
export async function authTransaction<T>(lock: string, fn: (tx: AuthSql) => Promise<T>): Promise<T> {
  return await client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('internal-auth:'||$1,0))", [lock]);
    return fn(tx as unknown as AuthSql);
  }) as T;
}
export async function revokeCredentialsSessions(tx: AuthSql, subject: string) {
  await tx.unsafe('select app.internal_auth_revoke($1::uuid)', [subject]);
}
