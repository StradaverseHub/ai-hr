/** Canonical encrypted-record IO over an explicit caller transaction; no connection owner. */
import type { Sql } from 'postgres';
import { AuthRecordExpiredError, decryptRecord, encryptRecord } from './crypto';
export type AuthSql = Pick<Sql, 'unsafe'>;
export async function readRecord<T>(tx: AuthSql, key: string, lock = false): Promise<T | null> {
  const rows = await tx.unsafe('select sealed from app.internal_auth_read($1,$2)', [key, lock]);
  if (!rows[0]) return null;
  try { return decryptRecord<T>(rows[0].sealed, key); }
  catch (error) { if (error instanceof AuthRecordExpiredError) return null; throw error; }
}
export async function writeRecord(tx: AuthSql, key: string, value: unknown, owner: string | null, expiresAt: number | null = null) {
  await tx.unsafe('select app.internal_auth_write($1,$2::uuid,$3,$4::timestamptz)',
    [key, owner, encryptRecord(value, key, expiresAt), expiresAt === null ? null : new Date(expiresAt).toISOString()]);
}
export async function deleteRecord(tx: AuthSql, key: string) { await tx.unsafe('select app.internal_auth_delete($1)', [key]); }
export async function revokeCredentialsSessions(tx: AuthSql, subject: string) {
  await tx.unsafe('select app.internal_auth_revoke($1::uuid)', [subject]);
}
