/** Canonical encrypted-record IO over an explicit caller transaction; no connection owner. */
import type { Sql } from 'postgres';
import { AuthRecordExpiredError, decryptRecord, encryptRecord } from './crypto';
export type AuthSql = Pick<Sql, 'unsafe'>;
function openStoredRecord<T>(sealed: string, key: string): T | null {
  try { return decryptRecord<T>(sealed, key); }
  catch (error) { if (error instanceof AuthRecordExpiredError) return null; throw error; }
}

export async function readRecord<T>(tx: AuthSql, key: string, lock = false): Promise<T | null> {
  const [row] = await tx.unsafe('select sealed from app.internal_auth_read($1,$2)', [key, lock]);
  return row ? openStoredRecord<T>(row.sealed, key) : null;
}

/** A non-locking read of two known keys. Authenticate the first record before opening the second. */
export async function readRecordPair<T>(tx: AuthSql, firstKey: string, secondKey: string, acceptsFirst: (first: T) => boolean): Promise<T | null> {
  const [row] = await tx.unsafe(`select
    (select sealed from app.internal_auth_read($1,false)) as first_record,
    (select sealed from app.internal_auth_read($2,false)) as second_record`, [firstKey, secondKey]);
  if (row?.first_record == null) return null;
  const first = openStoredRecord<T>(row.first_record, firstKey);
  if (!first || !acceptsFirst(first) || row.second_record == null || !openStoredRecord(row.second_record, secondKey)) return null;
  return first;
}
export async function writeRecord(tx: AuthSql, key: string, value: unknown, owner: string | null, expiresAt: number | null = null) {
  await tx.unsafe('select app.internal_auth_write($1,$2::uuid,$3,$4::timestamptz)',
    [key, owner, encryptRecord(value, key, expiresAt), expiresAt === null ? null : new Date(expiresAt).toISOString()]);
}
export async function deleteRecord(tx: AuthSql, key: string) { await tx.unsafe('select app.internal_auth_delete($1)', [key]); }
export async function revokeCredentialsSessions(tx: AuthSql, subject: string) {
  await tx.unsafe('select app.internal_auth_revoke($1::uuid)', [subject]);
}
