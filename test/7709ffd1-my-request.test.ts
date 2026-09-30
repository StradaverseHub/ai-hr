/**
 * 7709ffd1 (r369) · MY REQUEST — the rename, the full-width screen, the published row ceiling and the export.
 *
 * WHAT THE TICKET ASKED FOR was a shorter menu row ("My Attendance Request Status" truncated in the rail to
 * "My Attendance Request …"), a page that uses the width beside the menu, and an Export to Excel. What the
 * plan found while reading the screen is the thing this file spends most of its cases on:
 *
 *   THE LIST STOPPED AT 200 AND SAID NOTHING. The page asked `myAttendanceCorrections` for `{ limit: 200 }`
 *   — a private number no caller could see — filtered by status IN MEMORY over whatever those 200 happened
 *   to contain, and handed the pager a total of `rows.length`. An employee past the cap read "200" and was
 *   told nothing. Putting a DOWNLOAD on that arrangement converts a short list into a FILE that looks
 *   complete and is not, and a file has no banner to say otherwise, so the ceiling is fixed BEFORE the
 *   export and the export inherits it.
 *
 * THE SHAPE OF THE FIX is r367's (67268d83): publish the kernel's ceiling as a NAMED export, have every
 * caller that will show or serialise the rows bound itself against that one constant, and REFUSE past it
 * rather than clamp. The clamp is deliberately one higher than the ceiling so "there is at least one more
 * than I may show" is knowable rather than guessed.
 *
 * THE CASES, in the order the risk sits:
 *   1 · The refusal, at the boundary, and end to end against a fixture that really files more rows than the
 *       ceiling — so "the kernel truncates" and "the caller refuses first" are both measured, not assumed.
 *   2 · ONE whitelist and ONE ceiling across the screen and the export. A second copy in the route is how a
 *       file comes to hold "every request" while the tab said "Rejected".
 *   3 · Submitted is the MALAYSIAN calendar day in BOTH renditions. A UTC slice on one side and a KL day on
 *       the other would print two different days for one request — the exact fault cac9a3a1 was raised over.
 *   4 · The rename: `nav` and `me` in all six catalogues, the key and the href untouched.
 *   5 · The export never takes whose rows it serialises from the query string.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { MY_ATTENDANCE_REQUEST_ROW_CEILING, myAttendanceCorrections } from '../core/attendance';
import { parseRequestStatus, requestRowsProbeLimit, resolveRequestRows } from '../app/attendance/request-status/rows';
import { REQUEST_STATUSES } from '../app/attendance/request-ui';
import { todayInKualaLumpur } from '../lib/hr-date';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments removed: a guard that greps for a token must not be satisfied by a comment. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const PAGE = read('app/attendance/request-status/page.tsx');
const ROWS = read('app/attendance/request-status/rows.ts');
const EXPORT = read('app/attendance/request-status/export/route.ts');
const PACK = read('packs/attendance/index.ts');

// ── 1 · THE CEILING, AND THE REFUSAL ────────────────────────────────────────────────────────────────

describe('7709ffd1 — the published row ceiling refuses rather than clamping', () => {
  it('the probe asks for exactly one row past the ceiling, so a cut list is knowable', () => {
    expect(requestRowsProbeLimit(MY_ATTENDANCE_REQUEST_ROW_CEILING)).toBe(MY_ATTENDANCE_REQUEST_ROW_CEILING + 1);
    // …and the kernel's own clamp lets that one extra row through. If the clamp were the ceiling itself, a
    // complete list of exactly `ceiling` rows and a truncated one would be the same array and the refusal
    // below could never fire — which is the whole hazard this round closes.
    expect(code(read('core/attendance.ts')), 'the clamp is one past the ceiling, by name').toContain(
      'MY_ATTENDANCE_REQUEST_ROW_CEILING + 1',
    );
  });

  it('at the ceiling the list is complete; one row past it, the answer is refused and EMPTY', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

    const atCeiling = resolveRequestRows(rows(MY_ATTENDANCE_REQUEST_ROW_CEILING), MY_ATTENDANCE_REQUEST_ROW_CEILING);
    expect(atCeiling.refusal, 'exactly the ceiling is a complete answer').toBeNull();
    expect(atCeiling.rows).toHaveLength(MY_ATTENDANCE_REQUEST_ROW_CEILING);

    const past = resolveRequestRows(rows(MY_ATTENDANCE_REQUEST_ROW_CEILING + 1), MY_ATTENDANCE_REQUEST_ROW_CEILING);
    expect(past.refusal, 'one row past the ceiling is refused').toBe('too_many');
    // EMPTY, not sliced. A caller that forgets to read `refusal` then shows nothing rather than the first N
    // rows under a total of N — which is the defect, dressed as the remedy.
    expect(past.rows, 'a refused answer carries no rows to render by accident').toEqual([]);
  });

  it('the screen draws the refusal INSTEAD of the list, keeps the pills, and offers no export or pager', () => {
    const src = code(PAGE);
    expect(src, 'the screen bounds itself against the kernel constant, not a private number').toContain(
      'requestRowsProbeLimit(MY_ATTENDANCE_REQUEST_ROW_CEILING)',
    );
    expect(src, 'the private 200 is gone').not.toContain('limit: 200');
    // ⚠️ THE STATUS NARROWS THE READ NOW, which is what makes the refusal actionable: the way out of it is
    // to press a status pill. Filtering the fetched array instead would leave the reader no way out at all.
    expect(src, 'the status goes into the query').toMatch(/myAttendanceCorrections\([\s\S]{0,200}status: statusFilter/);
    expect(src, 'and is no longer applied to the fetched array').not.toMatch(/requests\.filter\(/);
    // The refusal sentence, and the three things that must NOT be drawn beside it.
    expect(src, 'the refusal is its own branch').toContain("refusal === 'too_many'");
    expect(src, 'and it names the ceiling rather than a bare apology').toContain(
      "t('maTooManyRequests', { ceiling: MY_ATTENDANCE_REQUEST_ROW_CEILING })",
    );
    expect(src, 'no pager over a refused list — its total would be 0 beside a sentence saying hundreds').toMatch(
      /refusal == null \? \(\s*<Pager/,
    );
    expect(src, 'and no export link: a file cannot be more complete than the screen it was asked from').toMatch(
      /refusal == null && reqPage\.state\.total > 0 \? \(/,
    );
    // `maNoRequests` says "you have not filed any", which is FALSE here: they have more than we show, not
    // none. Both sentences exist and they are different branches.
    expect(src).toContain("t('maNoRequests')");
    expect(src).toContain("t('maExportNone')");
  });
});

// ── 2 · ONE WHITELIST, ONE CEILING, TWO CONSUMERS ───────────────────────────────────────────────────

describe('7709ffd1 — the file and the tab cannot narrow differently', () => {
  it('the `?status=` whitelist is derived from REQUEST_STATUSES and lives in ONE module', () => {
    for (const st of REQUEST_STATUSES) expect(parseRequestStatus(st), `${st} is a real status`).toBe(st);
    expect(parseRequestStatus('completed'), 'a status the database has no value for is not offered').toBeNull();
    expect(parseRequestStatus(undefined)).toBeNull();
    expect(parseRequestStatus(null)).toBeNull();
    expect(parseRequestStatus('')).toBeNull();
    expect(ROWS, 'derived from the shared tuple, never restated').toContain('REQUEST_STATUSES.includes(');
  });

  it('both the screen and the export read the ONE whitelist and the ONE ceiling', () => {
    for (const [name, src] of [
      ['the screen', PAGE],
      ['the export', EXPORT],
    ] as const) {
      expect(code(src), `${name} narrows through parseRequestStatus`).toContain('parseRequestStatus');
      expect(code(src), `${name} bounds itself against the published ceiling`).toContain(
        'MY_ATTENDANCE_REQUEST_ROW_CEILING',
      );
      expect(code(src), `${name} resolves the refusal through the shared helper`).toContain('resolveRequestRows');
      expect(code(src), `${name} must not keep its own copy of the whitelist`).not.toMatch(/REQUEST_STATUSES\.includes\(/);
    }
    // The export refuses past the ceiling rather than serialising a short file.
    expect(code(EXPORT), 'past the ceiling the export answers a sentence, not a workbook').toMatch(
      /refusal === 'too_many'[\s\S]{0,240}status: 400/,
    );
  });

  it("the file's Status column resolves the SAME key the screen's pill does", () => {
    // r363's decision — `cancelled` reads "Withdrawn" on this screen — must reach the workbook too, or a
    // withdrawn row says one thing on screen and another in the file the reader sends on.
    expect(code(EXPORT), 'the export labels a status through the shared vocabulary').toContain('statusLabel(');
    expect(code(EXPORT), 'and names a request kind through the shared map').toContain('KIND_LABEL[');
    expect(code(EXPORT), 'and asks what was asked for with the screen’s own function').toContain('askedFor(r, t)');
    expect(code(EXPORT), 'no second copy of the status vocabulary in the route').not.toContain("=== 'cancelled'");
  });
});

// ── 3 · THE SUBMITTED DATE IS THE MALAYSIAN CALENDAR DAY, IN BOTH RENDITIONS ─────────────────────────

describe('7709ffd1 — Submitted is the Malaysian day, on screen and in the file', () => {
  it('neither rendition is a UTC slice, and the two are the same expression', () => {
    expect(code(PAGE), 'the screen prints the Malaysian calendar day of created_at').toContain(
      'const submittedOn = (r: RequestRow) => todayInKualaLumpur(r.createdAt)',
    );
    expect(code(PAGE), 'the UTC slice is gone from the screen').not.toContain("toISOString().slice(0, 10)");
    expect(code(EXPORT), 'and the file takes it off the same clock').toContain('todayInKualaLumpur(r.createdAt)');
    expect(code(EXPORT), 'the file’s own stamp is Malaysian too, never a UTC slice').toContain(
      'todayInKualaLumpur().replace(/-/g',
    );
    expect(code(EXPORT)).not.toContain("toISOString().slice(0, 10)");
  });

  it('and the distinction is real: a request filed at 01:00 in Kuala Lumpur is NOT yesterday', () => {
    // 17:00 UTC on the 26th is 01:00 MYT on the 27th. The retired expression printed the 26th.
    const filed = new Date('2026-07-26T17:00:00Z');
    expect(filed.toISOString().slice(0, 10), 'the retired UTC slice, for the record').toBe('2026-07-26');
    expect(todayInKualaLumpur(filed), 'the day it was actually filed, where it was filed').toBe('2026-07-27');
  });
});

// ── 4 · THE RENAME ──────────────────────────────────────────────────────────────────────────────────

describe('7709ffd1 — "My Request": the labels moved and nothing else did', () => {
  it('the menu row keeps its key, its href and its glyph', () => {
    // Renaming the KEY would touch this pack, three exact-set nav guards and the label-parity case in
    // test/schedule-assignment.test.ts for no user-visible benefit — the same label-only pattern r362 used
    // when My Records became Attendance Overview.
    expect(PACK).toContain("{ href: '/attendance/request-status', labelKey: 'myAttendanceRequestStatus', icon: ClipboardList }");
  });

  it('nav and me carry the SAME new words in all six catalogues', () => {
    for (const loc of LOCALES) {
      const c = CATALOGUES[loc] as unknown as { nav: Record<string, string>; me: Record<string, string> };
      expect(typeof c.nav.myAttendanceRequestStatus, `${loc}: nav`).toBe('string');
      expect(c.nav.myAttendanceRequestStatus, `${loc}: the row and the page title are one string`).toBe(
        c.me.myAttendanceRequestStatus,
      );
      expect(typeof c.me.maRequestsTitle, `${loc}: the card header`).toBe('string');
      // The three keys the round added, present in every locale — i18n/request.ts deep-merges over English,
      // so a key missing from one catalogue renders English rather than failing, and absence has to be asserted.
      for (const k of ['maExportExcel', 'maExportNone', 'maTooManyRequests'] as const) {
        expect(typeof c.me[k], `${loc}: me.${k}`).toBe('string');
        expect(c.me[k], `${loc}: me.${k} is blank`).not.toBe('');
      }
      expect(c.me.maTooManyRequests, `${loc}: the refusal names the ceiling`).toContain('{ceiling}');
    }
  });

  it('English reads "My Request" and "My requests", and the old long name is gone', () => {
    expect(en.nav.myAttendanceRequestStatus).toBe('My Request');
    expect(en.me.myAttendanceRequestStatus).toBe('My Request');
    expect(en.me.maRequestsTitle).toBe('My requests');
    for (const loc of LOCALES) {
      const c = CATALOGUES[loc] as unknown as { nav: Record<string, string> };
      expect(c.nav.myAttendanceRequestStatus, `${loc}: the truncating label is retired`).not.toBe(
        'My Attendance Request Status',
      );
    }
    // The help sentence is still true of the screen and is deliberately unchanged.
    expect(en.me.myAttendanceRequestStatusHelp).toContain('attendance request');
  });
});

// ── 5 · THE EXPORT NEVER TAKES WHOSE ROWS IT SERIALISES FROM THE QUERY STRING ────────────────────────

describe('7709ffd1 — nobody exports somebody else’s requests', () => {
  it('the employment is resolved server-side and no employment id is read off the URL', () => {
    const src = code(EXPORT);
    expect(src, 'the session decides whose rows these are').toContain('myEmployment(s)');
    expect(src, 'no active employment is a 403, not an empty file').toMatch(/if \(!me\) return new Response\('Forbidden', \{ status: 403 \}\)/);
    // Not "validated" — never read at all. There is no comparison to get wrong.
    expect(src, 'the URL cannot name an employment').not.toMatch(/searchParams\.get\(['"]employmentId['"]\)/);
    expect(src, 'nor an employee code').not.toMatch(/searchParams\.get\(['"]employeeCode['"]\)/);
    // Only these two things come off the query string.
    const reads = [...src.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]).sort();
    expect(reads, 'format and status, and nothing else').toEqual(['format', 'status']);
  });

  it('the workbook is named for the employee and the Malaysian date, and promises no .xlsx', () => {
    expect(code(EXPORT)).toContain('`MyRequest_${me.employeeCode ?? me.employmentId}_${stamp}`');
    // serializeReport's xlsx writer returns ext 'xls' + application/vnd.ms-excel (lib/report-export.ts), so
    // the route must take the extension from the serializer and never write one itself.
    expect(code(EXPORT), 'the extension comes from the serializer').toContain('contentDisposition(base, ext)');
    expect(code(EXPORT), 'and nothing here claims .xlsx').not.toMatch(/\.xlsx['"`]/);
  });
});

// ── 1b · THE REFUSAL, END TO END, AGAINST A FIXTURE OVER THE CEILING ────────────────────────────────

describe('7709ffd1 — a fixture over the ceiling really is refused', () => {
  let b: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('files ceiling + 1 requests: the read returns them all and the caller refuses', async () => {
    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Ceiling Worker', primaryEmail: `ceil_${Math.random().toString(36).slice(2, 10)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });

    // DISTINCT dates: `attendance_correction_one_pending_uq` is unique on (employment, date) where pending.
    // Inserted as the owner in one statement — this case is about the CEILING, not about the request form.
    const N = MY_ATTENDANCE_REQUEST_ROW_CEILING + 1;
    const day0 = Date.parse('2021-01-01T00:00:00Z');
    await owner.db.insert(schema.attendanceCorrection).values(
      Array.from({ length: N }, (_, i) => ({
        tenantId: b.tenantId,
        employmentId: e.employmentId,
        attendanceDate: new Date(day0 + i * 86_400_000).toISOString().slice(0, 10),
        proposedCheckIn: '09:00',
        proposedCheckOut: '18:00',
        reason: `filed ${i}`,
      })),
    );

    const fetched = await myAttendanceCorrections(a, e.employmentId, {
      limit: requestRowsProbeLimit(MY_ATTENDANCE_REQUEST_ROW_CEILING),
    });
    // The kernel really does hand back the extra row — without it the refusal could never fire.
    expect(fetched, 'the probe read reaches one past the ceiling').toHaveLength(N);

    const resolved = resolveRequestRows(fetched, MY_ATTENDANCE_REQUEST_ROW_CEILING);
    expect(resolved.refusal, 'so the screen and the export both refuse').toBe('too_many');
    expect(resolved.rows, 'and neither renders a short list under a wrong total').toEqual([]);
  });

  it('at the ceiling exactly, the same fixture is served in full', async () => {
    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Ceiling Worker Two', primaryEmail: `ceil2_${Math.random().toString(36).slice(2, 10)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    const N = MY_ATTENDANCE_REQUEST_ROW_CEILING;
    const day0 = Date.parse('2021-01-01T00:00:00Z');
    await owner.db.insert(schema.attendanceCorrection).values(
      Array.from({ length: N }, (_, i) => ({
        tenantId: b.tenantId,
        employmentId: e.employmentId,
        attendanceDate: new Date(day0 + i * 86_400_000).toISOString().slice(0, 10),
        requestedOtMinutes: 60,
        reason: `ot ${i}`,
      })),
    );
    const fetched = await myAttendanceCorrections(a, e.employmentId, {
      limit: requestRowsProbeLimit(MY_ATTENDANCE_REQUEST_ROW_CEILING),
    });
    expect(fetched).toHaveLength(N);
    const resolved = resolveRequestRows(fetched, MY_ATTENDANCE_REQUEST_ROW_CEILING);
    expect(resolved.refusal, 'the boundary is exclusive: the ceiling itself is complete').toBeNull();
    expect(resolved.rows).toHaveLength(N);
  });
});
