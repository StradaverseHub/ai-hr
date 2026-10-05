/**
 * r388 — THE ONE PLACE A CAUGHT ERROR BECOMES TEXT FOR A USER.
 *
 * Server actions used to put `(e as Error).message` into `?error=` and into returned form state. For a domain
 * refusal that is right: those sentences are written for the reader ("Select a bank from the Malaysian bank
 * list"). For a database failure it is not: drizzle's message is the whole SQL statement plus every bound
 * parameter (ids, and on a personnel write a person's name), so it leaked into the address bar, browser
 * history, server access logs and the screen. See lib/db-error.ts for the classification.
 *
 * publicErrorMessage(e):
 *  - not a database error → its own message, unchanged (so every existing domain message still surfaces);
 *  - a database error     → logged in full on the server under a short reference, and replaced by a plain
 *    sentence chosen by its SQLSTATE class, carrying that reference (lib/database-error-token.ts). The
 *    sentence is English here; ErrorBanner and ToastFromQuery recognise the reference and show the same
 *    sentence in the viewer's language from messages/*.json (common.databaseError).
 *
 * Server code only (it logs). It deliberately does not import 'server-only', because core/ import paths and
 * scripts/ run outside Next, where that module throws; test/r388-public-error.test.ts keeps it out of
 * client components instead.
 */
import { randomBytes } from 'node:crypto';
import { pgSqlState, isDatabaseError } from './db-error';
import { formatDatabaseErrorRef, type DatabaseErrorKind } from './database-error-token';

/** English source of common.databaseError.* — pinned against messages/en.json by the r388 test. */
export const DATABASE_ERROR_TEXT_EN: Record<DatabaseErrorKind, string> = {
  system: 'This change could not be completed because of a system error. If it keeps happening, report reference {ref}.',
  permission: 'You do not have permission to make this change. Reference {ref}.',
  duplicate: 'This would create a duplicate of a record that already exists. Reference {ref}.',
  linked: 'This record is still linked to other records, so it cannot be changed or removed this way. Reference {ref}.',
  invalidValue: 'One of the values entered is not allowed here. Reference {ref}.',
  rule: 'This change was refused by a safeguard that protects existing records, such as a closed payroll. Reference {ref}.',
  busy: 'The system was busy and the change was not completed. Please try again. Reference {ref}.',
};

/** Which plain sentence a SQLSTATE gets. Unknown or absent codes (a dropped connection) are 'system'. */
export function databaseErrorKind(sqlState: string | undefined): DatabaseErrorKind {
  if (!sqlState) return 'system';
  if (sqlState === '42501') return 'permission'; // insufficient_privilege, including an RLS refusal
  if (sqlState === '23505') return 'duplicate'; // unique_violation
  if (sqlState === '23503') return 'linked'; // foreign_key_violation
  if (sqlState === '23502' || sqlState === '23514' || sqlState.startsWith('22')) return 'invalidValue';
  if (sqlState === 'P0001') return 'rule'; // RAISE EXCEPTION in our triggers; 29 of 44 embed ids, so never shown
  if (sqlState === '40001' || sqlState === '40P01' || sqlState === '55P03' || sqlState === '57014') return 'busy';
  return 'system';
}

/** The text a user may see for `e`. Never returns SQL, parameter values or a driver message. */
export function publicErrorMessage(e: unknown): string {
  if (!isDatabaseError(e)) return e instanceof Error ? e.message : String(e);
  const sqlState = pgSqlState(e);
  const kind = databaseErrorKind(sqlState);
  const ref = formatDatabaseErrorRef(kind, randomBytes(3).toString('hex').toUpperCase());
  console.error(`[database error ${ref}] sqlstate=${sqlState ?? 'none'}`, e);
  return DATABASE_ERROR_TEXT_EN[kind].replace('{ref}', ref);
}
