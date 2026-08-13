/**
 * 23390097 BLOCKER — CAN A NON-ADMINISTRATOR STILL WRITE THE ROSTER BY POSTING TO THE ACTION?
 *
 * The grid was made read-only for a supervisor (test/roster-month-grid.dom.test.tsx pins that). It was
 * not enough and could never have been: the three cell actions are Server Actions, their ids ship inside
 * that same supervisor's JavaScript bundle, and a Server Action is a POST endpoint whether or not a
 * button points at it. Generate and Copy are form actions, which is the same thing.
 *
 * So the five roster writes were reaching the database with a session RLS refuses. THE MESSAGE WAS the
 * defect this file was written about: drizzle wraps
 * PostgresError 42501 as `Failed query: insert into "roster_assignment" … params: <tenant uuid>,
 * <employment uuid>, …`, the cell actions returned that verbatim for `toast.error`, and Generate / Copy
 * encoded it into `?error=` for ErrorBanner to render. SQL and internal identifiers, on an HR screen,
 * handed to the one person who is not allowed to be there.
 *
 * Every test below uses a REAL non-admin session against the REAL database, and a date FAR IN THE
 * FUTURE — the past-date rule would have refused today and earlier all by itself, so a future date is
 * the only one that proves the new right rather than the old one. `whatTheUserSees` is the string the
 * screen would actually print; the assertions are on that, not on an internal error type.
 *
 * 42afb2d2, 2026-08-12 — "app.can_admin_employment rejected every one of them" WOULD HAVE BEEN WRONG,
 * and the earlier draft of this header said it. roster_assignment_rls is ONE `FOR ALL` policy: its
 * WITH CHECK (can_admin_employment) governs INSERT and the new row of an UPDATE, but a DELETE was checked
 * against USING alone (can_see_employment), which a supervisor and the employee themselves both pass.
 * Measured as ai_hr_app in a rolled-back transaction against a real active reporting line: INSERT 42501,
 * UPDATE 42501, DELETE 1. So of the three brushes below, `clear` was the ONLY one whose refusal was
 * produced by `assertRosterAdmin` rather than doubled by the database.
 *
 * 154865f4, 2026-08-13 — THAT GAP IS NOW CLOSED, and this file did not need to change for it.
 * `0436_roster_assignment_delete_guard.sql` adds a RESTRICTIVE FOR DELETE policy, so the database
 * refuses all three verbs; test/roster-delete-rls.test.ts holds the matrix and the watched-fail.
 * `assertRosterAdmin` is now belt over a brace for `clear` as it always was for the other two — and it
 * stays, because the database's DELETE refusal is SILENT (a restrictive USING clause filters rather
 * than raising: zero rows removed, no error), so without this guard a supervisor would be told the
 * removal worked. Everything asserted below is unchanged and still measures the guard, not the policy.
 * See the note on core/roster.ts's `clearRoster`.
 *
 * WATCHED-FAIL (recorded, not assumed): with `assertRosterAdmin` removed from core/roster.ts and from
 * the five actions, the first describe below still passes — the database still refuses — and every
 * assertion in the other two fails, each on a message beginning `Failed query: insert into
 * "roster_assignment"` and carrying the tenant and employment UUIDs. That is the blocker, reproduced.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import {
  assertRosterAdmin,
  assignRosterRow,
  assignShift,
  createShift,
  RosterAdminRequiredError,
  rosterForRange,
} from '../core/roster';

/** The session every action resolves. Swapped per test between an administrator and a supervisor. */
let SESSION: SessionContext;
vi.mock('@/lib/session', () => ({ getSession: async () => SESSION }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/** next/navigation's redirect() signals by THROWING; a stub that merely records would let the action
 *  run on past its own refusal, which is the opposite of what is being tested. */
let LAST_REDIRECT = '';
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));

import {
  assignCellAction,
  bulkAssignAction,
  copyRosterAction,
  generateRosterAction,
  rowAssignAction,
} from '../app/roster/actions';

/** Anything that betrays the driver: the wrapper, the statement, or its bound parameters. */
const RAW_SQL = /failed query|insert into|update\s+"|delete from|\bparams:/i;
/** A tenant or employment id. The plan's words: "including tenant and employment UUIDs". */
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A date nothing else can refuse: comfortably after today, so the past-date rule is not what answers. */
const FUTURE = '2099-01-05';
const FUTURE_2 = '2099-01-06';
const FUTURE_MONTH_END = '2099-01-31';

let b: Base;
let admin: SessionContext;
let supervisor: SessionContext;
let employmentId = '';
let shiftId = '';

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  admin = adminCtx(b);
  // A REAL non-admin session: the same tenant and the same logged-in user, holding a role that is not
  // hr_admin / super_admin. This is exactly what a supervisor's session context looks like.
  supervisor = { ...admin, roles: ['manager'] };
  // The DEFAULT session for this file is the supervisor — the caller the blocker is about. The last
  // describe overrides it with the administrator in its own beforeEach, which runs after this one.
  SESSION = supervisor;
  LAST_REDIRECT = '';

  employmentId = (
    await hireEmployee(admin, {
      person: { fullName: 'Ahmad Zulkifli', primaryEmail: `az_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
      employeeCode: 'A0001',
    })
  ).employmentId;
  shiftId = (
    await createShift(admin, {
      companyId: b.companyId,
      name: 'WITH 0.5 OT HOUR ADJ - MORNING FULL (0800 - 1700)',
      code: 'MB28',
      startTime: '08:00:00',
      endTime: '17:00:00',
      weeklyPattern: [1, 2, 3, 4, 5],
    })
  ).id;
});

/** Every roster row stored for the test employee, whatever the date. */
const stored = () => rosterForRange(admin, { employmentIds: [employmentId], from: '2020-01-01', to: '2099-12-31' });

/** What the screen would print for a refused action: the toast text, or the ?error= the banner renders. */
async function whatTheUserSees(run: () => Promise<{ ok: boolean; error?: string }>): Promise<string> {
  const r = await run();
  expect(r.ok, 'the action must refuse, not succeed').toBe(false);
  return r.error ?? '';
}

/** Run a form action that reports by redirecting, and return the `error` it put in the query string. */
async function redirectError(run: () => Promise<unknown>): Promise<string> {
  await expect(run()).rejects.toThrow('NEXT_REDIRECT');
  return new URL(LAST_REDIRECT, 'https://x.invalid').searchParams.get('error') ?? '';
}

describe('why the guard exists — the database refuses, in its own words', () => {
  it('a supervisor writing the roster directly gets the RAW driver text, UUIDs and all', async () => {
    // The unguarded call the five actions used to make. Nothing here is being fixed — this is the
    // measurement that makes the rest of the file necessary, and it must keep passing: where RLS stops
    // refusing, the application guard becomes the only thing standing between a supervisor and the
    // roster. For DELETE that was literally true until 154865f4 (see the note in the header).
    const err = await assignShift(supervisor, { employmentId, shiftDate: FUTURE, shiftId }).catch((e: unknown) => e);
    expect(err, 'RLS must refuse a supervisor outright').toBeInstanceOf(Error);
    const chain = flatten(err);
    expect(chain, 'this is what used to reach the toast').toMatch(RAW_SQL);
    expect(await stored(), 'refused, so nothing was written').toHaveLength(0);
  });

  it('assertRosterAdmin refuses a supervisor and admits an administrator', () => {
    expect(() => assertRosterAdmin(supervisor)).toThrow(RosterAdminRequiredError);
    expect(() => assertRosterAdmin(admin)).not.toThrow();
    // The message a person reads: plain, actionable, and free of anything the database said.
    const message = new RosterAdminRequiredError().message;
    expect(message).toMatch(/HR administrator/i);
    expect(message).not.toMatch(RAW_SQL);
    expect(message).not.toMatch(ANY_UUID);
  });
});

describe('the five roster writes refuse a supervisor IN THE SERVER (23390097)', () => {
  // `clear` was the load-bearing one: it ends in a DELETE, which RLS did not refuse a supervisor until
  // 154865f4 (42afb2d2 → 0436, header). It still is the load-bearing one, for a second reason: the
  // database's delete refusal is silent, so this guard is what makes it a MESSAGE. The other two
  // brushes would fail on 42501 with the guard removed; `clear` would report a success that removed
  // nothing.
  it('assignCellAction — a shift, a rest day and a clear are all refused, readably', async () => {
    for (const brush of [shiftId, 'rest', 'clear']) {
      const seen = await whatTheUserSees(() => assignCellAction({ employmentId, shiftDate: FUTURE, brush }));
      expect(seen, `brush=${brush}`).toMatch(/HR administrator/i);
      expect(seen, `brush=${brush} must not print the query`).not.toMatch(RAW_SQL);
      expect(seen, `brush=${brush} must not print an id`).not.toMatch(ANY_UUID);
    }
    expect(await stored()).toHaveLength(0);
  });

  it('bulkAssignAction — refused before any employee or date is touched', async () => {
    const seen = await whatTheUserSees(() =>
      bulkAssignAction({ employmentIds: [employmentId], shiftDates: [FUTURE, FUTURE_2], brush: shiftId }),
    );
    expect(seen).toMatch(/HR administrator/i);
    expect(seen).not.toMatch(RAW_SQL);
    expect(seen).not.toMatch(ANY_UUID);
    expect(await stored()).toHaveLength(0);
  });

  it('rowAssignAction — the row Edit panel is refused too', async () => {
    const seen = await whatTheUserSees(() =>
      rowAssignAction({ employmentId, shiftDates: [FUTURE, FUTURE_2], brush: 'rest' }),
    );
    expect(seen).toMatch(/HR administrator/i);
    expect(seen).not.toMatch(RAW_SQL);
    expect(seen).not.toMatch(ANY_UUID);
    expect(await stored()).toHaveLength(0);
  });

  it('assignRosterRow refuses at the CORE boundary as well, not only in the action', async () => {
    await expect(assignRosterRow(supervisor, { employmentId, shiftDates: [FUTURE], brush: shiftId })).rejects.toThrow(
      RosterAdminRequiredError,
    );
    expect(await stored()).toHaveLength(0);
  });

  it('generateRosterAction — the ?error= the banner renders names the right, not the query', async () => {
    const seen = await redirectError(() => generateRosterAction(formOf({
      companyId: b.companyId,
      shiftId,
      from: FUTURE,
      to: FUTURE_MONTH_END,
      employmentIds: [employmentId],
    })));
    expect(seen).toMatch(/HR administrator/i);
    expect(seen).not.toMatch(RAW_SQL);
    expect(seen).not.toMatch(ANY_UUID);
    expect(await stored()).toHaveLength(0);
  });

  it('copyRosterAction — same', async () => {
    // Something real to copy, so the refusal cannot be mistaken for an empty source window.
    await assignShift(admin, { employmentId, shiftDate: '2098-12-01', shiftId });
    const seen = await redirectError(() => copyRosterAction(formOf({
      companyId: b.companyId,
      sourceFrom: '2098-12-01',
      sourceTo: '2098-12-31',
      targetFrom: FUTURE,
      employmentIds: [employmentId],
    })));
    expect(seen).toMatch(/HR administrator/i);
    expect(seen).not.toMatch(RAW_SQL);
    expect(seen).not.toMatch(ANY_UUID);
    expect(await stored(), 'the one seeded row, and nothing copied').toHaveLength(1);
  });
});

describe('the guard must not refuse everything — an administrator still rosters', () => {
  beforeEach(() => {
    SESSION = admin;
  });

  it('assignCellAction, bulkAssignAction and rowAssignAction all still write', async () => {
    expect(await assignCellAction({ employmentId, shiftDate: FUTURE, brush: shiftId })).toEqual({ ok: true });
    expect(await bulkAssignAction({ employmentIds: [employmentId], shiftDates: [FUTURE_2], brush: 'rest' })).toEqual({ ok: true });
    expect(await rowAssignAction({ employmentId, shiftDates: ['2099-01-07', '2099-01-08'], brush: shiftId })).toEqual({ ok: true });
    expect(await stored()).toHaveLength(4);
  });

  it('generateRosterAction still redirects with its summary', async () => {
    await expect(
      generateRosterAction(formOf({ companyId: b.companyId, shiftId, from: FUTURE, to: FUTURE_MONTH_END, employmentIds: [employmentId] })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('generated=');
    expect(LAST_REDIRECT).not.toContain('error=');
    expect((await stored()).length).toBeGreaterThan(0);
  });

  /**
   * THE BACKSTOP, tested with an ADMINISTRATOR so the admin guard cannot be what produces the result.
   *
   * A brush that is not a uuid makes Postgres raise 22P02 and drizzle wrap it as `Failed query: insert
   * into "roster_assignment" … params: …`. Before readableError() that string was the toast. The action
   * must still report failure — it must not swallow the refusal — but not in the driver's words.
   */
  it('any OTHER driver failure is reported readably too, never as raw SQL', async () => {
    const seen = await whatTheUserSees(() => assignCellAction({ employmentId, shiftDate: FUTURE, brush: 'not-a-uuid' }));
    expect(seen).not.toMatch(RAW_SQL);
    expect(seen).not.toMatch(ANY_UUID);
    expect(seen.trim()).not.toBe('');
    expect(await stored()).toHaveLength(0);
  });
});

/** A FormData carrying what the roster forms post, including repeated `employmentIds`. */
function formOf(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const one of v) fd.append(k, one);
    else fd.set(k, v);
  }
  return fd;
}

/** Every message in an error's `cause` chain — drizzle hangs the real PostgresError off the wrapper. */
function flatten(e: unknown): string {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur instanceof Error; i++) {
    out.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return out.join(' | ');
}
