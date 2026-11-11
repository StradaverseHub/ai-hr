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
 *    sentence carrying that reference (lib/database-error-token.ts). The sentence says what went wrong and
 *    what to do about it: SPECIFIC when the refusal names a rule we can explain (03877e — a date that would
 *    end a record before it starts, a required field, an overlapping period, a closed payroll), otherwise
 *    the general sentence for its SQLSTATE class. It is English here; ErrorBanner and ToastFromQuery
 *    recognise the reference and show the same sentence in the viewer's language from messages/*.json
 *    (common.databaseErrorReason, falling back to common.databaseError).
 *
 * Server code only (it logs). It deliberately does not import 'server-only', because core/ import paths and
 * scripts/ run outside Next, where that module throws; test/r388-public-error.test.ts keeps it out of
 * client components instead.
 */
import { randomBytes } from 'node:crypto';
import { pgErrorDetail, pgSqlState, isDatabaseError, type PgErrorDetail } from './db-error';
import {
  formatDatabaseErrorReasonRef,
  formatDatabaseErrorRef,
  type DatabaseErrorKind,
  type DatabaseErrorReason,
} from './database-error-token';
import { CHECK_CONSTRAINT_REASONS, CHOICE_CONSTRAINT } from './database-check-reasons';

/** English source of common.databaseError.* — pinned against messages/en.json by the r388 test. Each says
 *  what happened and what the reader can do next; the reference is for support, not for the reader. */
export const DATABASE_ERROR_TEXT_EN: Record<DatabaseErrorKind, string> = {
  system: 'Something went wrong on our side and nothing was saved. Try again in a moment; if it keeps happening, send reference {ref} to your administrator.',
  permission: 'You do not have permission to make this change, so nothing was saved. Ask your administrator if you need access. Reference {ref}.',
  duplicate: 'This would create a second copy of a record that already exists, so nothing was saved. Open the existing record and change it instead. Reference {ref}.',
  linked: 'This record is connected to other records, so it cannot be changed or removed this way. Nothing was saved. Reference {ref}.',
  invalidValue: 'One of the values entered breaks a rule for this record, so nothing was saved. Check the values you changed and try again. Reference {ref}.',
  rule: 'A safeguard that protects existing records refused this change, so nothing was saved. Check what you changed against the records it affects and try again. Reference {ref}.',
  nricDuplicate: 'This NRIC already exists in another employee record. Duplicate NRIC numbers are not allowed under the current People General Settings. Reference {ref}.',
  busy: 'The system was busy with another change to the same records, so this one was not saved. Wait a moment and try again. Reference {ref}.',
};

/** English source of common.databaseErrorReason.* — the specific explanations (03877e). */
export const DATABASE_ERROR_REASON_TEXT_EN: Record<DatabaseErrorReason, string> = {
  dateOrder: 'The dates entered would make a record end before it starts, so nothing was saved. Check that the effective date is not earlier than the start of the record it changes, such as the current salary, position or assignment. Reference {ref}.',
  required: 'A required field was left empty, so nothing was saved. Fill in every required field and try again. Reference {ref}.',
  textTooLong: 'One of the text entries is longer than this field allows, so nothing was saved. Shorten it and try again. Reference {ref}.',
  numberOutOfRange: 'One of the numbers entered is outside the allowed range (for example negative, or too large), so nothing was saved. Correct it and try again. Reference {ref}.',
  invalidDate: 'One of the dates is not a real calendar date or is outside the supported range, so nothing was saved. Check the dates and try again. Reference {ref}.',
  wrongFormat: 'One of the values is in the wrong format, for example letters in a number field, so nothing was saved. Check the entries and try again. Reference {ref}.',
  choiceNotAllowed: 'One of the options chosen is no longer accepted, so nothing was saved. Reload the page, choose again from the list and try again. Reference {ref}.',
  overlap: 'This would overlap another record that covers the same dates, so nothing was saved. Change the dates so they do not overlap, or edit the existing record instead. Reference {ref}.',
  missingReference: 'Something this record points to, such as a company, department, position or employee, no longer exists. Nothing was saved. Reload the page, choose it again and try again. Reference {ref}.',
  inUse: 'This record is still used by other records, so it cannot be removed. Remove or change those records first. Reference {ref}.',
  closedPayroll: 'Payroll for this period is already closed, so the records it paid cannot be changed. Nothing was saved. Use a date after the last closed payroll month, or ask payroll to reopen it. Reference {ref}.',
  locked: 'This record is locked and can no longer be changed, so nothing was saved. Create a new entry instead of editing this one. Reference {ref}.',
  changedMeanwhile: 'This record was changed by someone else while you were working on it, so nothing was saved. Reload the page and make your change again. Reference {ref}.',
  outsideScope: 'This record belongs to a company or area you are not allowed to change, so nothing was saved. Ask your administrator if you need access. Reference {ref}.',
};

/** Which plain sentence a SQLSTATE gets. Unknown or absent codes (a dropped connection) are 'system'. */
export function databaseErrorKind(sqlState: string | undefined): DatabaseErrorKind {
  if (!sqlState) return 'system';
  if (sqlState === 'PN001') return 'nricDuplicate';
  if (sqlState === '42501') return 'permission'; // insufficient_privilege, including an RLS refusal
  if (sqlState === '23505' || sqlState === '23P01') return 'duplicate'; // unique / exclusion (overlap)
  if (sqlState === '23503') return 'linked'; // foreign_key_violation
  if (sqlState === '23502' || sqlState === '23514' || sqlState.startsWith('22')) return 'invalidValue';
  if (sqlState === 'P0001') return 'rule'; // RAISE EXCEPTION in our triggers; 29 of 44 embed ids, so never shown
  if (sqlState === '40001' || sqlState === '40P01' || sqlState === '55P03' || sqlState === '57014') return 'busy';
  return 'system';
}

/**
 * Our triggers raise ~2,500 distinct sentences, written for developers and often carrying ids, so none is
 * shown. A few families are unambiguous enough to explain; anything else keeps its kind's sentence, because
 * a confidently wrong explanation is worse than a general one. Matched on the driver's message only.
 */
const TRIGGER_REASONS: [RegExp, DatabaseErrorReason][] = [
  [/closed payroll|payroll (?:(?:period|month|run|batch) )?(?:is )?(?:already )?(?:closed|finali[sz]ed|locked)|(?:closed|finali[sz]ed) (?:payroll|pay run)/i, 'closedPayroll'],
  [/changed; (validate|reload|refresh|retry)|\bstale\b|changed since|no longer current|changed by another/i, 'changedMeanwhile'],
  [/\b(is|are) (immutable|read-only|append-only)\b/i, 'locked'],
];

/** The specific explanation for a refusal, or undefined when only its kind's sentence is honest. */
export function databaseErrorReason(d: PgErrorDetail): DatabaseErrorReason | undefined {
  const message = d.message ?? '';
  switch (d.sqlState) {
    case '22000':
      // range_serialize: daterange(valid_from, valid_to) with the end before the start — the production
      // failure behind this change (a Transfer backdated before the current salary record).
      return d.routine === 'range_serialize' || /range lower bound must be less than or equal/i.test(message) ? 'dateOrder' : undefined;
    case '22001':
      return 'textTooLong';
    case '22003':
      return 'numberOutOfRange';
    case '22007':
    case '22008':
      return 'invalidDate';
    case '22P02':
      return 'wrongFormat';
    case '23502':
      return 'required';
    case '23P01':
      return 'overlap';
    case '23503':
      // Postgres words the two directions differently; the wording is the server's, not ours.
      if (/^update or delete on table/i.test(message)) return 'inUse';
      if (/^insert or update on table/i.test(message)) return 'missingReference';
      return undefined;
    case '23514':
      if (d.constraint) {
        return CHECK_CONSTRAINT_REASONS[d.constraint] ?? (CHOICE_CONSTRAINT.test(d.constraint) ? 'choiceNotAllowed' : undefined);
      }
      return TRIGGER_REASONS.find(([re]) => re.test(message))?.[1];
    case 'P0001':
      return TRIGGER_REASONS.find(([re]) => re.test(message))?.[1];
    case '42501':
      return /row-level security|outside[^.]*scope|administrator scope/i.test(message) ? 'outsideScope' : undefined;
    default:
      return undefined;
  }
}

/** The text a user may see for `e`. Never returns SQL, parameter values or a driver message. */
export function publicErrorMessage(e: unknown): string {
  if (!isDatabaseError(e)) return e instanceof Error ? e.message : String(e);
  const sqlState = pgSqlState(e);
  const id = randomBytes(3).toString('hex').toUpperCase();
  const reason = sqlState === 'PN001' ? undefined : databaseErrorReason(pgErrorDetail(e));
  const kind = databaseErrorKind(sqlState);
  const ref = reason ? formatDatabaseErrorReasonRef(reason, id) : formatDatabaseErrorRef(kind, id);
  if (sqlState === 'PN001') console.error(`[database error ${ref}] sqlstate=PN001`);
  else console.error(`[database error ${ref}] sqlstate=${sqlState ?? 'none'}`, e);
  return (reason ? DATABASE_ERROR_REASON_TEXT_EN[reason] : DATABASE_ERROR_TEXT_EN[kind]).replace('{ref}', ref);
}
