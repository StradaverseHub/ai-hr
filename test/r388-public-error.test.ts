/**
 * r388 — A DATABASE ERROR NEVER REACHES A URL OR A SCREEN AS TEXT.
 *
 * Drizzle's message for a failed statement is the SQL plus every bound parameter. Server actions put
 * `(e as Error).message` into `?error=` and into form state from ~200 places, so record ids and, on a
 * personnel write, a person's name reached the address bar, browser history and access logs. Three of
 * those places had been patched locally (f1bbc572, 464b58e6, the roster write path); this pins the one
 * chokepoint that replaced the rest, and a source sweep that keeps new call sites on it.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publicErrorMessage,
  databaseErrorKind,
  databaseErrorReason,
  DATABASE_ERROR_REASON_TEXT_EN,
  DATABASE_ERROR_TEXT_EN,
} from '../lib/public-error';
import { isDatabaseError, pgErrorDetail, pgSqlState } from '../lib/db-error';
import {
  DATABASE_ERROR_KINDS,
  DATABASE_ERROR_REASONS,
  formatDatabaseErrorReasonRef,
  formatDatabaseErrorRef,
  parseDatabaseErrorRef,
} from '../lib/database-error-token';
import { CHECK_CONSTRAINT_REASONS, CHOICE_CONSTRAINT } from '../lib/database-check-reasons';
import { fail, failCompany } from '../app/admin/_redirects';

const PERSON = 'Siti Aminah binti Ahmad';
const ID = '3f9a2c1d-7b4e-4c2a-9d1f-0a1b2c3d4e5f';

/** A drizzle-shaped failure: its own Error over the driver's PostgresError, as node_modules/drizzle-orm throws it. */
function drizzleError(
  code: string | undefined,
  driverMessage = 'new row violates row-level security policy',
  fields: Record<string, string> = {},
) {
  const cause = Object.assign(new Error(driverMessage), code ? { code } : {}, fields);
  const e = new Error(`Failed query: update "person" set "full_name" = $1 where "id" = $2\nparams: ${PERSON},${ID}`);
  (e as Error & { cause?: unknown }).cause = cause;
  return e;
}

function noLeak(text: string) {
  expect(text).not.toMatch(/failed query|params:|update "|insert into|delete from|select /i);
  expect(text).not.toContain(PERSON);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
}

afterEach(() => vi.restoreAllMocks());

describe('publicErrorMessage', () => {
  it('replaces a drizzle failure with a plain sentence carrying a reference, and logs the original', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = publicErrorMessage(drizzleError('42501'));
    noLeak(text);
    const parsed = parseDatabaseErrorRef(text);
    expect(parsed?.kind).toBe('permission');
    expect(text).toBe(DATABASE_ERROR_TEXT_EN.permission.replace('{ref}', parsed!.ref));
    // The full error went to the server log under the same reference, so nothing is lost for support.
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain(parsed!.ref);
    expect(log.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it.each([
    ['23505', 'duplicate'],
    ['23503', 'linked'],
    ['23502', 'invalidValue'],
    ['23514', 'invalidValue'],
    ['22P02', 'invalidValue'],
    ['P0001', 'rule'],
    ['40001', 'busy'],
    ['40P01', 'busy'],
    ['XX000', 'system'],
  ])('maps SQLSTATE %s to %s', (code, kind) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(databaseErrorKind(code)).toBe(kind);
    const text = publicErrorMessage(drizzleError(code, `row ${ID} refused`));
    noLeak(text);
    expect(parseDatabaseErrorRef(text)?.kind).toBe(kind);
  });

  it('treats a dropped connection and a pool that never connected as database errors too', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dropped = drizzleError(undefined, 'Connection terminated unexpectedly');
    expect(pgSqlState(dropped)).toBeUndefined();
    expect(isDatabaseError(dropped)).toBe(true);
    expect(parseDatabaseErrorRef(publicErrorMessage(dropped))?.kind).toBe('system');
    const refused = Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:5432'), { code: 'ECONNREFUSED' });
    const text = publicErrorMessage(refused);
    expect(text).not.toContain('192.0.2.10');
    expect(parseDatabaseErrorRef(text)?.kind).toBe('system');
    const named = Object.assign(new Error('boom'), { name: 'DrizzleQueryError' });
    expect(isDatabaseError(named)).toBe(true);
  });

  it('leaves a domain refusal exactly as written, and never says "undefined" for a thrown string', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(publicErrorMessage(new Error('Select a bank from the Malaysian bank list'))).toBe(
      'Select a bank from the Malaysian bank list',
    );
    // A domain error with a non-SQLSTATE code (application codes are lower case) is not a database error.
    expect(publicErrorMessage(Object.assign(new Error('Outside the geofence'), { code: 'outsideGeofence' }))).toBe(
      'Outside the geofence',
    );
    expect(publicErrorMessage('plain refusal')).toBe('plain refusal');
    expect(log).not.toHaveBeenCalled();
  });
});

describe('the reference format', () => {
  it('round-trips every kind and ignores ordinary messages', () => {
    for (const kind of Object.values(DATABASE_ERROR_KINDS)) {
      const ref = formatDatabaseErrorRef(kind, 'A1B2C3');
      expect(parseDatabaseErrorRef(`Something. Reference ${ref}.`)).toEqual({ kind, ref });
    }
    expect(parseDatabaseErrorRef('Select a bank from the Malaysian bank list')).toBeNull();
    expect(parseDatabaseErrorRef(undefined)).toBeNull();
  });

  it('round-trips every reason inside its own kind, and keeps references written before reasons existed', () => {
    for (const { reason, kind } of Object.values(DATABASE_ERROR_REASONS)) {
      const ref = formatDatabaseErrorReasonRef(reason, 'A1B2C3');
      expect(ref).toMatch(/^DB-[SPDLVRBN][A-Z]{2}-A1B2C3$/);
      expect(parseDatabaseErrorRef(`Something. Reference ${ref}.`)).toEqual({ kind, reason, ref });
    }
    // The production reference from 5 Nov 2026 still reads as the invalid-value sentence.
    expect(parseDatabaseErrorRef('Reference DB-V-03877E.')).toEqual({ kind: 'invalidValue', ref: 'DB-V-03877E' });
    // A newer server's unknown reason, or a reason under the wrong kind, falls back to the kind's sentence.
    expect(parseDatabaseErrorRef('Reference DB-VZZ-03877E.')).toEqual({ kind: 'invalidValue', ref: 'DB-VZZ-03877E' });
    expect(parseDatabaseErrorRef('Reference DB-PDO-03877E.')).toEqual({ kind: 'permission', ref: 'DB-PDO-03877E' });
  });

  it('never reuses a reason code', () => {
    const reasons = Object.values(DATABASE_ERROR_REASONS).map((r) => r.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe('03877e — the specific explanation for each refusal', () => {
  /** What the production log recorded for DB-V-03877E, with a placeholder id. */
  const productionRangeError = () =>
    drizzleError('22000', 'range lower bound must be less than or equal to range upper bound', {
      routine: 'range_serialize',
    });

  it('explains the production failure as a date ordering problem, with a reference that names it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = publicErrorMessage(productionRangeError());
    noLeak(text);
    const parsed = parseDatabaseErrorRef(text);
    expect(parsed).toMatchObject({ kind: 'invalidValue', reason: 'dateOrder' });
    expect(parsed!.ref).toMatch(/^DB-VDO-[0-9A-F]{6}$/);
    expect(text).toBe(DATABASE_ERROR_REASON_TEXT_EN.dateOrder.replace('{ref}', parsed!.ref));
    expect(text).toMatch(/end before it starts/);
  });

  it.each([
    ['22000', 'range lower bound must be less than or equal to range upper bound', {}, 'dateOrder'],
    ['22001', 'value too long for type character varying(200)', {}, 'textTooLong'],
    ['22003', 'numeric field overflow', {}, 'numberOutOfRange'],
    ['22007', 'invalid input syntax for type date', {}, 'invalidDate'],
    ['22008', 'date/time field value out of range', {}, 'invalidDate'],
    ['22P02', 'invalid input syntax for type numeric', {}, 'wrongFormat'],
    ['23502', 'null value in column "department_id" violates not-null constraint', { column_name: 'department_id' }, 'required'],
    ['23P01', 'conflicting key value violates exclusion constraint', { constraint_name: 'compensation_no_overlap' }, 'overlap'],
    ['23503', 'insert or update on table "assignment" violates foreign key constraint', {}, 'missingReference'],
    ['23503', 'update or delete on table "department" violates foreign key constraint', {}, 'inUse'],
    ['23514', 'new row violates check constraint', { constraint_name: 'notice_window_check' }, 'dateOrder'],
    ['23514', 'new row violates check constraint', { constraint_name: 'notice_title_check' }, 'required'],
    ['23514', 'new row violates check constraint', { constraint_name: 'shift_late_grace_nonneg' }, 'numberOutOfRange'],
    ['23514', 'new row violates check constraint', { constraint_name: 'leave_cancellation_request_status_check' }, 'choiceNotAllowed'],
    ['P0001', 'Payroll period is closed', {}, 'closedPayroll'],
    ['23514', 'Activated overtime scope is immutable', {}, 'locked'],
    ['P0001', 'Payroll import record changed; validate a new attempt', {}, 'changedMeanwhile'],
    ['42501', 'new row violates row-level security policy for table "assignment"', {}, 'outsideScope'],
  ] as const)('%s "%s" → %s', (code, message, fields, reason) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(databaseErrorReason(pgErrorDetail(drizzleError(code, message, fields)))).toBe(reason);
    const text = publicErrorMessage(drizzleError(code, `${message} ${ID} ${PERSON}`, fields));
    noLeak(text);
    expect(parseDatabaseErrorRef(text)?.reason).toBe(reason);
  });

  it('keeps the general sentence when the rule is not one it can honestly explain', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const e of [
      drizzleError('23514', 'new row violates check constraint', { constraint_name: 'assistant_bank_retained_columns' }),
      drizzleError('23514', 'Exact requested interval identity required'),
      drizzleError('P0001', 'Persist every exact individual assignment member'),
      drizzleError('22000', 'some other data exception'),
      drizzleError('42501', 'permission denied for table payroll_batch'),
      drizzleError('23505', 'duplicate key value violates unique constraint'),
    ]) {
      const parsed = parseDatabaseErrorRef(publicErrorMessage(e));
      expect(parsed).not.toBeNull();
      expect(parsed!.reason).toBeUndefined();
      expect(parsed!.ref).toMatch(/^DB-[SPDLVRBN]-[0-9A-F]{6}$/);
    }
  });

  it('every check rule with an explanation names a constraint that exists in db/migrations', () => {
    const sql = execFileSync('git', ['ls-files', 'db/migrations'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const names = Object.keys(CHECK_CONSTRAINT_REASONS);
    expect(names.length).toBeGreaterThan(50);
    const missing = names.filter((n) => !new RegExp(`constraint\\s+"?${n}"?\\s+check`, 'i').test(sql));
    expect(missing).toEqual([]);
    // A listed rule is never ALSO caught by the pick-list pattern with a different meaning.
    expect(names.filter((n) => CHOICE_CONSTRAINT.test(n))).toEqual([]);
  });
});

describe('common.databaseError in all six locales', () => {
  const kinds = Object.values(DATABASE_ERROR_KINDS);
  it.each(['en', 'ms', 'ta', 'th', 'vi', 'zh'])('%s has every sentence, each keeping the {ref} placeholder', (locale) => {
    const messages = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).common.databaseError;
    expect(Object.keys(messages).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      expect(messages[kind]).toContain('{ref}');
      expect(messages[kind].trim().length).toBeGreaterThan(10);
    }
  });
  it('the English catalogue is exactly the server-side source', () => {
    const en = JSON.parse(readFileSync('messages/en.json', 'utf8')).common.databaseError;
    expect(en).toEqual(DATABASE_ERROR_TEXT_EN);
  });

  const reasons = Object.values(DATABASE_ERROR_REASONS).map((r) => r.reason);
  it.each(['en', 'ms', 'ta', 'th', 'vi', 'zh'])('%s has every specific explanation, each keeping {ref}', (locale) => {
    const messages = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'));
    const reasonText = messages.common.databaseErrorReason;
    expect(Object.keys(reasonText).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      expect(reasonText[reason]).toContain('{ref}');
      expect(reasonText[reason].trim().length).toBeGreaterThan(10);
    }
    // 03877e — the salary refusal names the day the current salary starts, twice (the problem and the fix).
    expect(messages.people.detail.salaryBeforeCurrentRecordError.match(/\{date\}/g)).toHaveLength(2);
  });
  it('the English explanations are exactly the server-side source', () => {
    const en = JSON.parse(readFileSync('messages/en.json', 'utf8')).common.databaseErrorReason;
    expect(en).toEqual(DATABASE_ERROR_REASON_TEXT_EN);
  });
});

describe('the shared redirect helpers', () => {
  const urlOf = (run: () => never): string => {
    try {
      run();
    } catch (e) {
      const digest = (e as { digest?: string }).digest ?? '';
      expect(digest.startsWith('NEXT_REDIRECT')).toBe(true);
      return decodeURIComponent(digest);
    }
    throw new Error('expected a redirect');
  };
  it('fail() and failCompany() put the plain sentence in ?error=, never the SQL', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const url of [
      urlOf(() => fail('/admin/organization', drizzleError('23503'))),
      urlOf(() => failCompany(drizzleError('23503'), '11111111-1111-1111-1111-111111111111', 'general')),
    ]) {
      expect(url).toContain('?error=');
      const error = url.slice(url.indexOf('?error=') + 7);
      noLeak(error.replace(/^(\/admin\/organization\/)?[0-9a-f-]{36}/, ''));
      expect(parseDatabaseErrorRef(error)?.kind).toBe('linked');
    }
  });
  it('a domain refusal still reaches ?error= verbatim', () => {
    const url = urlOf(() => fail('/admin/organization', new Error('Choose a signatory who is an active employee')));
    expect(url).toContain('?error=Choose a signatory who is an active employee');
  });
});

describe('source sweep: server code reaches users only through publicErrorMessage', () => {
  // Files git tracks under app/, plus the two core import paths whose row errors are shown on screen.
  const files = execFileSync('git', ['ls-files', 'app', 'core/import.ts', 'core/leave-import.ts'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const isClient = (src: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(src);
  const RAW = /\((e|err|error)\s+as\s+Error\)\.message|\b(e|err)\s+instanceof\s+Error\s*\?\s*(e|err)\.message/;
  // The only server-side reads of the raw text left, each because it TESTS the text rather than shows it.
  const LOGIC = [
    ['app/admin/actions.ts', "const raw = e instanceof Error ? e.message : String(e);"], // routes 'Failed query:' to saveDatabaseError
    ['app/admin/settings/actions.ts', "const msg = (e as Error).message ?? '';"], // fieldOfGradeError matches domain wording
    ['app/roster/actions.ts', "const message = e instanceof Error ? e.message : '';"], // readableError already redacts driver text
  ];

  it('scans a real tree (non-vacuity)', () => {
    expect(files.length).toBeGreaterThan(300);
    const uses = files.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/publicErrorMessage\(/g)?.length ?? 0), 0);
    expect(uses).toBeGreaterThan(200);
    for (const [file, line] of LOGIC) expect(readFileSync(file, 'utf8')).toContain(line);
  });

  it('no server file shows (e as Error).message or e.message to a user', () => {
    const offenders: string[] = [];
    let serverFiles = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (isClient(src)) continue;
      serverFiles++;
      src.split('\n').forEach((line, i) => {
        const s = line.trim();
        if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*')) return;
        if (!RAW.test(line)) return;
        if (LOGIC.some(([file, allowed]) => f === file && line.includes(allowed))) return;
        offenders.push(`${f}:${i + 1}: ${s}`);
      });
    }
    expect(serverFiles).toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });

  it('no client component imports the server-side sanitiser', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return isClient(src) && /from ['"]@\/lib\/public-error['"]|from ['"](\.\.\/)+lib\/public-error['"]/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
