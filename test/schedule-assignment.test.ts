/**
 * r209 — Schedule Assignment (0bade264) and the Attendance menu rename (0bade264 + 6448574f),
 * r263 — the edit panel on that screen (a485afa1),
 * r265 — the panel becomes a page of its own, /admin/attendance/schedule-assignment/[employmentId]
 *        (a485afa1 rev 2: the reporter contested the panel — it sat at the top of a 74-row list).
 *
 * WHAT THIS FILE PINS, AND WHY EACH HALF NEEDS PINNING SEPARATELY.
 *
 *  1. THE READ. `listShiftArrangements` must answer "which shift is this person on" with the SAME
 *     sentence the attendance engine uses: the live partial unique index
 *     (employment_shift_arrangement_live_uq — superseded_at IS NULL) plus `pickArrangementOn`. Two
 *     things go wrong when a list invents its own rule, and both are asserted below with real rows:
 *     a superseded period reappearing (saving twice for one date must REPLACE, and the list must show
 *     the replacement), and a FUTURE-dated change being reported as today's shift.
 *
 *  2. THE CONTRACT BETWEEN TWO FILES. The request is that this screen and the per-employee card act on
 *     ONE record. That is not a property of either file alone — a unit test of the list passes whether
 *     or not a second writer exists, and so does a unit test of the card. So it is asserted across BOTH
 *     sources, and a485afa1 CHANGED WHAT THAT MEANS without changing the property: r209 kept the two in
 *     step by refusing the list an editor and linking into the card instead; r263 gave the list its own
 *     panel because the link was the complaint, and keeps them in step by making the panel mount the
 *     card's own control (components/employee-shift-fields.tsx) and call the card's own writer
 *     (core/shift-arrangement.ts). r265 moved that panel onto its own page and changed NOTHING about the
 *     property: the assertions now read: the deep link is GONE, the list is a list (no panel, no fields),
 *     the DETAIL page renders the ONE control, the screen's action is an adapter and not a second writer,
 *     and the personnel card is still standing. Plus a database-backed half r209 could not have: the
 *     history a save from Attendance produces is compared, row for row, with the history the same save
 *     through Personnel produces.
 *
 *     AND WHERE EVERY WAY OUT LEADS (r265, the reporter's three sentences): Save returns to the LIST with
 *     the same filters, landed on the row just changed (`focus=<id>#row-<id>`, `saved=1`); Cancel and
 *     Back are plain links to that same place and post nothing; a refused save stays on the DETAIL page
 *     with the reason. Each is asserted on the real action's redirect or the real page's render.
 *
 *     AND ITS THIRD OPERATION. Removal did not exist at either door — the panel is the first surface to
 *     offer it — so `removeShiftArrangement` is pinned here too: it supersedes rather than deletes, it
 *     re-opens the period it had closed, it refuses to take away the last one on file, and it refuses any
 *     entry that is NOT the newest (removal is undone by re-saving the same date, and the writer will not
 *     accept a date earlier than the ladder's last — so an older removal could not be undone at any door).
 *
 * ⚠️ READ BEFORE ADDING A `describe` TO THIS FILE — THE MOCKS ARE FILE-LEVEL, NOT PER-DESCRIBE.
 * `vi.mock` of ../lib/authz, next/cache, next/navigation and next-intl/server sits at module scope below,
 * and so do `beforeAll(migrateTestDb)` / `afterAll(closeAll)` (hoisted out of the first describe by
 * a485afa1 because a second database-backed describe follows it and a per-describe afterAll would close
 * the pool under it). EVERY describe in this file therefore inherits, whether it wants them or not:
 *   · `requireAdmin` is a fake that returns the module-level `ADMIN` — a describe that does not assign
 *     `ADMIN` in its own beforeEach gets whatever the previous describe left there, and NOTHING here
 *     tests real authorization. An authz assertion must live in its own file.
 *   · `redirect()` THROWS (`NEXT_REDIRECT`) and records into `LAST_REDIRECT` instead of navigating — code
 *     after a redirect never runs, and an un-awaited action swallows the throw.
 *   · `getTranslations` returns the KEY, not the sentence, so an assertion on user-facing copy here is
 *     asserting a key name. Locale VALUES are asserted in the last describe, which reads messages/*.json
 *     off disk instead.
 * If a new describe needs any of these to be real, put it in a new file rather than un-mocking here.
 *
 *  3. THE LABELS. i18n-check.mjs proves a key EXISTS in all six locales; it cannot prove a value was
 *     updated, so a locale left saying "Plan OT" passes it silently. Every renamed value is therefore
 *     checked per locale, both positively (it reads the new name) and negatively (no trace of the old
 *     one), plus the two cross-key equalities that make the menus consistent with the screens they open.
 */
import { and, eq, isNull } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { createShift } from '../core/roster';
import {
  assignEmployeeShiftDated,
  listShiftArrangements,
  shiftArrangementHistory,
} from '../core/shift-arrangement';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/**
 * a485afa1 — the two server actions are exercised for real, so the parity case below compares what the
 * two DOORS actually store rather than what two direct calls to the writer store (which would pass even
 * if one door parsed its form differently). requireAdmin(), redirect() and the translator are the three
 * things a server action needs from Next and cannot have here; the harness pattern is
 * test/bank-custom-holder.test.ts's.
 */
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import {
  removeScheduleArrangementAction,
  saveScheduleAssignmentAction,
} from '../app/admin/attendance/schedule-assignment/actions';
import ScheduleAssignmentPage from '../app/admin/attendance/schedule-assignment/page';
import ShiftArrangementPage from '../app/admin/attendance/schedule-assignment/[employmentId]/page';
import { setDefaultShiftAction } from '../app/admin/personnel/[employmentId]/actions';
import { todayInKualaLumpur } from '../lib/hr-date';

/**
 * The screen itself, rendered. A 200 is not a render check and neither is a source scan: the crash this
 * pins (a malformed `?assign=`) passed tsc, the suite and `next build`, and only a real render found it.
 *
 * The SERVER strings come from the mocked `getTranslations` and are therefore KEY NAMES — the assertions
 * below name keys where they mean sentences. The CLIENT islands in the tree (EmployeeShiftFields,
 * ConfirmSubmit) call `useTranslations` instead, which needs a real provider, so they are given the real
 * en.json and render real copy: a key missing from the catalogue would show up here rather than as a
 * MISSING_MESSAGE on a live page.
 */
function toMarkup(tree: unknown): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      timeZone: 'Asia/Kuala_Lumpur',
      messages: JSON.parse(read('messages/en.json')),
      children: tree as never,
    }),
  );
}
/** The LIST, rendered. `?assign=<uuid>` makes it redirect instead (the mocked redirect throws). */
async function renderPage(searchParams: Record<string, string>): Promise<string> {
  return toMarkup(await ScheduleAssignmentPage({ searchParams: Promise.resolve(searchParams) }));
}
/** The DETAIL page, rendered — the `[employmentId]` segment is passed as-is, junk included. */
async function renderDetail(employmentId: string, searchParams: Record<string, string> = {}): Promise<string> {
  return toMarkup(
    await ShiftArrangementPage({
      params: Promise.resolve({ employmentId }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
}

/** Run a server action to its redirect and return where it sent the browser. */
async function runAction(action: (fd: FormData) => Promise<void>, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  LAST_REDIRECT = '';
  await expect(action(fd)).rejects.toThrow('NEXT_REDIRECT');
  return LAST_REDIRECT;
}

// ONE pool for the whole file: hoisted out of the first describe by a485afa1 because a second
// database-backed describe follows it, and a per-describe afterAll would close the pool before that one
// ran its first query.
beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

// A fixed "today" is passed into every read: the status buckets are relative to it, and a test that let
// the clock decide would flip meaning at midnight in the tenant's calendar.
const TODAY = '2026-07-15';
const PAST = '2026-05-01';
const FUTURE = '2026-09-01';

describe('0bade264 — Schedule Assignment lists the LIVE arrangement, by the shared rule', () => {
  let b: Base;
  let shiftA: string;
  let shiftB: string;

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    shiftA = (
      await createShift(adminCtx(b), {
        companyId: b.companyId,
        name: 'Morning',
        code: 'AM',
        startTime: '08:00:00',
        endTime: '17:00:00',
        breakMinutes: 60,
        weeklyPattern: [1, 2, 3, 4, 5],
      })
    ).id;
    shiftB = (
      await createShift(adminCtx(b), {
        companyId: b.companyId,
        name: 'Evening',
        code: 'PM',
        startTime: '14:00:00',
        endTime: '23:00:00',
        breakMinutes: 60,
        weeklyPattern: [1, 2, 3, 4, 5],
      })
    ).id;
  });

  /** An employment with a name and an Employee ID, hired long before every date in this file. */
  async function hire(fullName: string, employeeCode: string) {
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName, primaryEmail: `${employeeCode}_${randomUUID()}@t.local` })
      .returning({ id: schema.person.id });
    const [e] = await owner.db
      .insert(schema.employment)
      .values({
        tenantId: b.tenantId,
        personId: p.id,
        companyId: b.companyId,
        employeeCode,
        hiredOn: '2020-01-01',
      })
      .returning({ id: schema.employment.id });
    return e.id;
  }

  const rowFor = (rows: Awaited<ReturnType<typeof listShiftArrangements>>, employmentId: string) =>
    rows.find((r) => r.employmentId === employmentId)!;

  it('one row per active employee, carrying the six columns the reporter listed', async () => {
    const ana = await hire('Ana Current', 'E001');
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: ana,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
    });

    const rows = await listShiftArrangements(adminCtx(b), { today: TODAY });
    const r = rowFor(rows, ana);
    expect({
      employeeCode: r.employeeCode,
      name: r.name,
      shiftType: r.shiftType,
      shiftCode: r.shiftCode,
      shiftName: r.shiftName,
      effectiveFrom: r.effectiveFrom,
      status: r.status,
    }).toEqual({
      employeeCode: 'E001',
      name: 'Ana Current',
      shiftType: 'fixed',
      shiftCode: 'AM',
      shiftName: 'Morning',
      effectiveFrom: PAST,
      status: 'current',
    });
  });

  it('THE LIVE INDEX: a period superseded by a same-date save is gone from the list', async () => {
    // The ladder's rule (core/shift-arrangement.ts): saving twice for ONE effective date supersedes the
    // first entry rather than adding a second. superseded_at IS NULL is the live index's predicate and
    // the definition of a live period — a list that read every row, or that sorted by created_at and
    // took the newest, would pass most of the time and disagree here.
    const ben = await hire('Ben Replaced', 'E002');
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: ben,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
    });
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: ben,
      shiftType: 'roster',
      shiftId: shiftB,
      effectiveFrom: PAST,
    });

    // The fixture genuinely has a superseded row to leak — otherwise this passes for the wrong reason.
    const all = await owner.db
      .select({ id: schema.employmentShiftArrangement.id })
      .from(schema.employmentShiftArrangement)
      .where(eq(schema.employmentShiftArrangement.employmentId, ben));
    const live = await owner.db
      .select({ id: schema.employmentShiftArrangement.id })
      .from(schema.employmentShiftArrangement)
      .where(
        and(
          eq(schema.employmentShiftArrangement.employmentId, ben),
          isNull(schema.employmentShiftArrangement.supersededAt),
        ),
      );
    expect(all.length, 'both writes are on file').toBe(2);
    expect(live.length, 'exactly one of them is live').toBe(1);

    const rows = await listShiftArrangements(adminCtx(b), { today: TODAY });
    expect(rows.filter((r) => r.employmentId === ben), 'one row per employee, not one per period').toHaveLength(1);
    const r = rowFor(rows, ben);
    expect(r.shiftCode, 'the surviving period is the one shown').toBe('PM');
    expect(r.shiftType).toBe('roster');
  });

  it('a FUTURE-dated change is not reported as today’s shift', async () => {
    // pickArrangementOn takes the greatest valid_from <= the date asked about. A change saved today to
    // start in September must leave the employee on what they are on NOW — the trap a "latest row wins"
    // implementation falls into, and the one that would show HR the wrong shift for six weeks.
    const cara = await hire('Cara Moving', 'E003');
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: cara,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
    });
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: cara,
      shiftType: 'fixed',
      shiftId: shiftB,
      effectiveFrom: FUTURE,
    });

    const now = rowFor(await listShiftArrangements(adminCtx(b), { today: TODAY }), cara);
    expect(now.shiftCode, 'still on the shift in force today').toBe('AM');
    expect(now.effectiveFrom).toBe(PAST);
    expect(now.status).toBe('current');

    // …and the same read on a date after the change answers with the new one, from the same ladder.
    const later = rowFor(await listShiftArrangements(adminCtx(b), { today: '2026-09-02' }), cara);
    expect(later.shiftCode).toBe('PM');
    expect(later.effectiveFrom).toBe(FUTURE);
  });

  it('an arrangement that has not started yet reads "scheduled", not "current"', async () => {
    const dee = await hire('Dee Starting', 'E004');
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: dee,
      shiftType: 'fixed',
      shiftId: shiftB,
      effectiveFrom: FUTURE,
    });
    const r = rowFor(await listShiftArrangements(adminCtx(b), { today: TODAY }), dee);
    expect(r.status).toBe('scheduled');
    expect(r.effectiveFrom).toBe(FUTURE);
  });

  it('an employment with no ladder row still appears, marked as such', async () => {
    // Nobody may fall off this list: "every employee's current arrangement" includes the ones who have
    // none on file. The row falls back to employment.default_shift_id — the same cache every resolver
    // falls back to — and says so rather than pretending it is a dated arrangement.
    const eve = await hire('Eve Legacy', 'E005');
    const rows = await listShiftArrangements(adminCtx(b), { today: TODAY });
    const r = rowFor(rows, eve);
    expect(r.status).toBe('notRecorded');
    expect(r.effectiveFrom).toBeNull();
    expect(r.shiftId).toBeNull();
  });

  it('a terminated employment is out of the list', async () => {
    const fay = await hire('Fay Left', 'E006');
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-06-30' })
      .where(eq(schema.employment.id, fay));
    const rows = await listShiftArrangements(adminCtx(b), { today: TODAY });
    expect(rows.some((r) => r.employmentId === fay)).toBe(false);
  });

  it('search matches employee ID and name; the filters narrow the RESOLVED row', async () => {
    const ana = await hire('Ana Current', 'E001');
    const cara = await hire('Cara Moving', 'E003');
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: ana,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
    });
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: cara,
      shiftType: 'roster',
      shiftId: shiftB,
      effectiveFrom: PAST,
    });

    const codes = async (f: Parameters<typeof listShiftArrangements>[1]) =>
      (await listShiftArrangements(adminCtx(b), { today: TODAY, ...f })).map((r) => r.employeeCode).sort();

    expect(await codes({ q: 'E003' }), 'search by employee ID').toEqual(['E003']);
    expect(await codes({ q: 'ana' }), 'search by name, case-insensitively').toEqual(['E001']);
    expect(await codes({ shiftType: 'roster' })).toEqual(['E003']);
    expect(await codes({ shiftId: shiftA })).toEqual(['E001']);
    expect(await codes({ status: 'current' })).toEqual(['E001', 'E003']);
    expect(await codes({ status: 'scheduled' })).toEqual([]);
  });

  it('the backup-shift filter follows the shift SHOWN, not one the employee used to be on', async () => {
    // The reason the three narrowing filters are applied to the resolved row rather than to the ladder in
    // SQL: filtering periods would match an employee on a shift they have LEFT and then display the one
    // they are actually on — a row that contradicts the filter that produced it.
    const gus = await hire('Gus Moved', 'E007');
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: gus,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: '2026-01-01',
    });
    await assignEmployeeShiftDated(adminCtx(b), {
      employmentId: gus,
      shiftType: 'fixed',
      shiftId: shiftB,
      effectiveFrom: PAST,
    });
    const onOld = await listShiftArrangements(adminCtx(b), { today: TODAY, shiftId: shiftA });
    const onNew = await listShiftArrangements(adminCtx(b), { today: TODAY, shiftId: shiftB });
    expect(onOld.some((r) => r.employmentId === gus), 'not matched by the shift he left').toBe(false);
    expect(onNew.some((r) => r.employmentId === gus), 'matched by the shift he is on').toBe(true);
  });
});

describe('a485afa1 — the two doors write ONE record, and the panel can take one back off', () => {
  const LIST_URL = '/admin/attendance/schedule-assignment';
  let b: Base;
  let shiftA: string;
  let shiftB: string;

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    // The mocked requireAdmin hands the actions this session — the same one the direct calls use, so a
    // difference between the two histories can only come from the two code paths.
    ADMIN = adminCtx(b);
    shiftA = (
      await createShift(ADMIN, {
        companyId: b.companyId,
        name: 'Morning',
        code: 'AM',
        startTime: '08:00:00',
        endTime: '17:00:00',
        breakMinutes: 60,
        weeklyPattern: [1, 2, 3, 4, 5],
      })
    ).id;
    shiftB = (
      await createShift(ADMIN, {
        companyId: b.companyId,
        name: 'Evening',
        code: 'PM',
        startTime: '14:00:00',
        endTime: '23:00:00',
        breakMinutes: 60,
        weeklyPattern: [1, 2, 3, 4, 5],
      })
    ).id;
  });

  async function hire(fullName: string, employeeCode: string) {
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName, primaryEmail: `${employeeCode}_${randomUUID()}@t.local` })
      .returning({ id: schema.person.id });
    const [e] = await owner.db
      .insert(schema.employment)
      .values({
        tenantId: b.tenantId,
        personId: p.id,
        companyId: b.companyId,
        employeeCode,
        hiredOn: '2020-01-01',
      })
      .returning({ id: schema.employment.id });
    return e.id;
  }

  /** The history with only its VOLATILE columns dropped — the row id and the wall-clock it was written. */
  const shapeOf = (rows: Awaited<ReturnType<typeof shiftArrangementHistory>>) =>
    rows.map(({ id, changedAt, ...rest }) => {
      void id;
      void changedAt;
      return rest;
    });

  it('a save from the Attendance panel produces the record a save from Personnel produces', async () => {
    // THE PLAN'S PROMISE, PINNED. "Two doors onto one record" is not provable from either screen alone:
    // it is the claim that the SAME two saves, made at the two doors, leave the same thing behind. Both
    // employees are moved identically — a dated period, then a second one — and the two ladders are
    // compared row for row, previous-shift resolution and all.
    const viaCard = await hire('Ana Personnel', 'E101');
    const viaList = await hire('Bea Attendance', 'E102');

    for (const [action, employmentId] of [
      [setDefaultShiftAction, viaCard],
      [saveScheduleAssignmentAction, viaList],
    ] as const) {
      await runAction(action, {
        employmentId,
        shiftType: 'fixed',
        shiftId: shiftA,
        effectiveFrom: PAST,
        returnTo: LIST_URL,
      });
      await runAction(action, {
        employmentId,
        shiftType: 'roster',
        shiftId: shiftB,
        effectiveFrom: FUTURE,
        returnTo: LIST_URL,
      });
    }

    const fromCard = shapeOf(await shiftArrangementHistory(ADMIN, viaCard));
    const fromList = shapeOf(await shiftArrangementHistory(ADMIN, viaList));
    expect(fromList.length, 'two dated periods — the second save appended, it did not overwrite').toBe(2);
    expect(fromList, 'the Attendance panel and the personnel card record the SAME arrangement').toEqual(fromCard);
    // …and the effective dating is the ladder's, not an in-place update: the older period is closed the
    // day before the newer one begins, at BOTH doors.
    expect(fromList.map((h) => [h.effectiveFrom, h.effectiveTo])).toEqual([
      [FUTURE, null],
      [PAST, '2026-08-31'],
    ]);
  });

  it('Save returns to the LIST, same filters, landed on the row just changed — not to the top', async () => {
    // r265: the detail page posts its OWN url (filters riding along) as returnTo; the action sends a
    // success back to the list, filters intact, with `focus=<id>` and the `#row-<id>` fragment the list
    // renders on every row. That fragment is what lands the browser on the row instead of the top.
    const emp = await hire('Cara Return', 'E103');
    const back = await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
      returnTo: `${LIST_URL}/${emp}?status=current`,
    });
    expect(back, 'the save stays inside Attendance').not.toContain('/admin/personnel/');
    expect(back, 'it lands on the LIST, not back on the detail page').toMatch(new RegExp(`^${LIST_URL}\\?`));
    expect(back, 'the filter the administrator was working under survives the save').toContain('status=current');
    expect(back, 'the row just changed is the one to land on').toContain(`focus=${emp}`);
    expect(back, 'and the browser is sent to that row, not the top').toMatch(new RegExp(`#row-${emp}$`));
    expect(back).toContain('saved=1');
    expect(back, "r263's panel parameter is gone from every redirect").not.toContain('assign=');

    // The other door is untouched and still returns to the profile — Personnel Management keeps its copy.
    const fromCard = await runAction(setDefaultShiftAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
    });
    expect(fromCard).toContain(`/admin/personnel/${emp}`);
  });

  it('a forged returnTo cannot send the browser anywhere but this screen', async () => {
    const emp = await hire('Dee Forged', 'E104');
    const back = await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
      returnTo: 'https://evil.example/steal',
    });
    expect(back, 'an off-site returnTo falls back to the bare list, still landed on the row').toBe(
      `${LIST_URL}?focus=${emp}&saved=1#row-${emp}`,
    );
    // …and neither may another screen's path smuggle its query in: only this list and its detail page
    // are trusted for the filters.
    const other = await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
      returnTo: `/admin/personnel/${emp}?status=current`,
    });
    expect(other).toBe(`${LIST_URL}?focus=${emp}&saved=1#row-${emp}`);
  });

  it('a REFUSED save stays on the detail page, filters kept, with the reason — nothing typed is lost', async () => {
    // The reporter's sentence: "you stay on the page with the reason shown next to the fields, so nothing
    // you entered is lost". The shift library's shift-actions.ts idiom (errTarget): a refusal lands on
    // the form the operator filled in, never on a list that has forgotten every box they typed. TWO
    // halves, each asserted: the redirect carries what was TYPED, and the page renders those as the
    // form's defaults — not what is on file, which is what the operator was trying to change.
    const emp = await hire('Gil Refused', 'E112');
    await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
      returnTo: `${LIST_URL}/${emp}`,
    });
    const before = await shiftArrangementHistory(ADMIN, emp);
    // A date before the ladder's last — the back-insert refusal, one of the two the plan names. Every
    // typed value differs from what is on file (fixed / AM / today) so the echo is provably the echo.
    const back = await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'roster',
      shiftId: shiftB,
      effectiveFrom: '2026-04-01',
      returnTo: `${LIST_URL}/${emp}?status=current&q=Gil`,
    });
    expect(back, 'stays on THIS employee\'s page').toMatch(new RegExp(`^${LIST_URL}/${emp}\\?`));
    expect(back, 'the reason, localized, is on the url the page reads').toContain('error=shiftBackInsertRefused');
    expect(back, 'the filters are still on it for the way back').toContain('status=current');
    expect(back).toContain('q=Gil');
    expect(back, 'a refusal is not a save').not.toContain('saved=1');
    expect((await shiftArrangementHistory(ADMIN, emp)).map((h) => h.id), 'and nothing was written').toEqual(
      before.map((h) => h.id),
    );
    // HALF ONE: what was typed rides back on the url. NOT under `shiftId` — that key is the list's
    // backup-shift filter riding on the same url, and `shiftId=<filter>` must survive untouched.
    expect(back).toContain('typedShiftType=roster');
    expect(back).toContain(`typedShiftId=${shiftB}`);
    expect(back).toContain('typedEffectiveFrom=2026-04-01');
    expect(back, 'the echo does not clobber the filter of the same name').not.toContain(`shiftId=${shiftB}&`);

    // HALF TWO: the page renders THOSE as the form's defaults. The option marked selected in each
    // <select>, and the date box's value — read off the real render.
    const selected = (html: string, name: string) => {
      const start = html.indexOf(`name="${name}"`);
      expect(start, `a <select name="${name}"> is on the page`).toBeGreaterThan(-1);
      return html.slice(start, html.indexOf('</select>', start)).match(/<option value="([^"]*)" selected/)?.[1];
    };
    const params = Object.fromEntries(new URL(`http://x${back}`).searchParams);
    const html = await renderDetail(emp, params);
    expect(selected(html, 'shiftType'), 'shift type: what was typed, not what is on file').toBe('roster');
    expect(selected(html, 'shiftId'), 'backup shift: what was typed').toBe(shiftB);
    expect(html, 'effective date: what was typed').toMatch(/name="effectiveFrom"[^>]*value="2026-04-01"/);
    // …and the reason sits immediately above those fields: after the "In force today" block, before the
    // ARRANGEMENT form — not under the page header two cards away.
    //
    // r329 (8cd601d0) added a Schedule Group card, with its own form, ABOVE the arrangement — so the
    // FIRST `<form` on the page is no longer the one this banner is about. The guard now names the
    // arrangement form by a field only it has. The property is unchanged and is in fact stated more
    // precisely than before: the reason is beside the fields it refuses, whatever else the page grows.
    const reasonAt = html.indexOf('shiftBackInsertRefused');
    expect(reasonAt).toBeGreaterThan(html.indexOf('summaryTitle'));
    const arrangementFieldsAt = html.indexOf('name="shiftType"');
    expect(arrangementFieldsAt, 'the arrangement form is on the page').toBeGreaterThan(-1);
    expect(reasonAt).toBeLessThan(arrangementFieldsAt);
    expect(html.indexOf('<form'), 'a form is on the page').toBeGreaterThan(-1);

    // A malformed echo (a forged or mangled url) is ignored field by field: what is on file comes back.
    const junk = await renderDetail(emp, {
      error: 'x',
      typedShiftType: 'weird',
      typedShiftId: 'not-a-uuid',
      typedEffectiveFrom: 'yesterday',
    });
    expect(selected(junk, 'shiftType')).toBe('fixed');
    expect(selected(junk, 'shiftId')).toBe(shiftA);
    expect(junk).toMatch(new RegExp(`name="effectiveFrom"[^>]*value="${todayInKualaLumpur()}"`));
  });

  it('removing an arrangement supersedes it, re-opens the period before it, and moves the cache', async () => {
    const emp = await hire('Eve Removed', 'E105');
    for (const [shiftId, effectiveFrom] of [
      [shiftA, PAST],
      [shiftB, FUTURE],
    ] as const) {
      await runAction(saveScheduleAssignmentAction, {
        employmentId: emp,
        shiftType: 'fixed',
        shiftId,
        effectiveFrom,
        returnTo: LIST_URL,
      });
    }
    const before = await shiftArrangementHistory(ADMIN, emp);
    expect(before.map((h) => h.effectiveFrom), 'newest first').toEqual([FUTURE, PAST]);

    const back = await runAction(removeScheduleArrangementAction, {
      employmentId: emp,
      arrangementId: before[0].id,
      returnTo: `${LIST_URL}/${emp}?status=current`,
    });
    expect(back).toContain('removed=1');
    // r265: a removal STAYS on the detail page — the administrator is looking at the history they just
    // changed — with the filters still on the url for the way back.
    expect(back).toMatch(new RegExp(`^${LIST_URL}/${emp}\\?`));
    expect(back).toContain('status=current');

    const after = await shiftArrangementHistory(ADMIN, emp);
    expect(after.map((h) => h.effectiveFrom), 'the removed period is gone from the live ladder').toEqual([PAST]);
    expect(after[0].effectiveTo, 'the period it had closed runs on again').toBeNull();

    // The list — the same shared read the screen renders — agrees.
    const [row] = await listShiftArrangements(ADMIN, { today: TODAY, employmentId: emp });
    expect([row.shiftCode, row.status]).toEqual(['AM', 'current']);

    // And employment.default_shift_id, the cache every unmigrated reader still consults, followed it back.
    const [cached] = await owner.db
      .select({ shiftId: schema.employment.defaultShiftId, shiftType: schema.employment.shiftType })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    expect(cached.shiftId, 'the cache must not keep pointing at a period that was removed').toBe(shiftA);
  });

  it('the LAST arrangement on file is refused, in the reader’s own language', async () => {
    // Removing it would leave the employee with no dated period at all and drop every resolver back onto
    // the cache this ladder replaced — "not recorded" is a state a new employee is in, not one an
    // administrator can put an existing one back into by deleting their history.
    const emp = await hire('Fay Only', 'E106');
    await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
      returnTo: LIST_URL,
    });
    const [only] = await shiftArrangementHistory(ADMIN, emp);
    const back = await runAction(removeScheduleArrangementAction, {
      employmentId: emp,
      arrangementId: only.id,
      returnTo: LIST_URL,
    });
    // The mocked translator returns the key, so this asserts the LOCALIZED sentence was reached rather
    // than core's English message being shown to the user.
    expect(back).toContain('error=removeOnlyRefused');
    expect((await shiftArrangementHistory(ADMIN, emp)).map((h) => h.id), 'nothing was removed').toEqual([only.id]);
  });

  it('a malformed [employmentId] renders the page’s own sentence with the way back — never a 500', async () => {
    // THE r263 VERIFIER'S 500, now on the url segment instead of `?assign=`: junk reached
    // eq(employment.id, …) on a uuid column, Postgres threw "invalid input syntax for type uuid", and the
    // page — including the `panelMissing` branch written for exactly this ("a stale bookmark") — never
    // rendered. A well-formed but unknown uuid was always handled; both are asserted so a future edit
    // cannot fix one and lose the other. And a terminated employment reads the same: the list read
    // excludes leavers on purpose (their history stays on their own profile).
    const emp = await hire('Ivy Bookmark', 'E109');
    await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
      returnTo: LIST_URL,
    });
    const left = await hire('Lee Left', 'E113');
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-06-30' }).where(eq(schema.employment.id, left));

    for (const junk of ['not-a-uuid', "'; drop table employment; --", '123', emp.slice(0, -1)]) {
      const html = await renderDetail(junk, { status: 'current' });
      expect(html, `/${junk} says the employee is not on the list`).toContain('panelMissing');
      expect(html, 'and offers the way back, filters kept').toContain(`href="${LIST_URL}?status=current"`);
      expect(html, 'no form is offered for nobody').not.toContain('name="effectiveFrom"');
    }
    for (const [who, id] of [
      ['a well-formed uuid nobody owns', '00000000-0000-4000-8000-000000000000'],
      ['a terminated employment', left],
    ] as const) {
      const html = await renderDetail(id);
      expect(html, `${who} reads the same`).toContain('panelMissing');
      expect(html, `${who} offers no form`).not.toContain('name="effectiveFrom"');
    }

    // And the page still opens for a real one — the shape check narrows nothing it should not.
    const real = await renderDetail(emp);
    expect(real, 'the employee the page is open on').toContain('Ivy Bookmark');
    expect(real, 'their arrangement is being edited, not reported missing').not.toContain('panelMissing');
    expect(real, 'the shared control is mounted').toContain('name="effectiveFrom"');

    // The LIST drops a malformed `?assign=` rather than forwarding it: it renders as if the param were
    // not there — no redirect, no panel, no sentence.
    const list = await renderPage({ assign: 'not-a-uuid' });
    expect(list).toContain('Ivy Bookmark');
    expect(list).not.toContain('panelMissing');
    expect(list).not.toContain('assign-panel');
  });

  it('?assign=<uuid> — r263’s panel link — redirects to the employee’s page, filters and all', async () => {
    // A bookmark or a link in a chat written before r265 must still open the same employee.
    const emp = await hire('Mia Bookmarked', 'E114');
    LAST_REDIRECT = '';
    await expect(renderPage({ assign: emp, status: 'current', q: 'Mia' })).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toBe(`${LIST_URL}/${emp}?q=Mia&status=current`);
  });

  it('the summary block shows the SAME status the list row shows, from the same resolver', async () => {
    // Both surfaces read `listShiftArrangements` for the same employment on the same `today`, so the chip
    // on the page cannot disagree with the chip on the row behind it. Asserted on the RENDERED chips —
    // the label key and its hint key — against what the resolver itself answers for the page's own
    // "today" (the real clock, in the tenant's calendar: the page does not take a fixed date).
    const today = todayInKualaLumpur();
    const plusDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
    const chip = (html: string) => {
      const m = html.match(/title="(status\w+Hint)"[^>]*>(status\w+)<\/span>/);
      return m ? { hint: m[1], label: m[2] } : null;
    };

    const nowOn = await hire('Nia Current', 'E115');
    const laterOn = await hire('Ola Scheduled', 'E116');
    const nothing = await hire('Pat Unrecorded', 'E117');
    await assignEmployeeShiftDated(ADMIN, { employmentId: nowOn, shiftType: 'fixed', shiftId: shiftA, effectiveFrom: plusDays(today, -30) });
    await assignEmployeeShiftDated(ADMIN, { employmentId: laterOn, shiftType: 'roster', shiftId: shiftB, effectiveFrom: plusDays(today, 30) });

    const listHtml = await renderPage({});
    for (const emp of [nowOn, laterOn, nothing]) {
      const [resolved] = await listShiftArrangements(ADMIN, { employmentId: emp, today });
      const expected = { label: `status${resolved.status[0].toUpperCase()}${resolved.status.slice(1)}` };
      const onPage = chip(await renderDetail(emp));
      const rowStart = listHtml.indexOf(`id="row-${emp}"`);
      expect(rowStart, 'the list renders an anchor for this row').toBeGreaterThan(-1);
      const onRow = chip(listHtml.slice(rowStart, listHtml.indexOf('</tr>', rowStart)));
      expect(onPage?.label, `${resolved.name}: the page's chip is the resolver's answer`).toBe(expected.label);
      expect(onRow, `${resolved.name}: the row's chip is the SAME chip`).toEqual(onPage);
    }
    // The fixture genuinely covered all three states — otherwise the loop proves less than it says.
    const states = await Promise.all(
      [nowOn, laterOn, nothing].map(async (e) => (await listShiftArrangements(ADMIN, { employmentId: e, today }))[0].status),
    );
    expect(states).toEqual(['current', 'scheduled', 'notRecorded']);
  });

  it('Back and Cancel are plain links to the list, filters kept, landed on the row — nothing is posted', async () => {
    const emp = await hire('Quin Cancel', 'E118');
    const html = await renderDetail(emp, { q: 'Quin', status: 'current', shiftType: 'fixed' });
    // renderToStaticMarkup escapes & in attributes.
    const back = `${LIST_URL}?q=Quin&amp;shiftType=fixed&amp;status=current&amp;focus=${emp}#row-${emp}`;
    const links = html.split(`href="${back}"`).length - 1;
    expect(links, 'Back (page header) and Cancel (beside Save) both point at that exact url').toBe(2);
    expect(html, 'Back reads the page’s own key').toContain('detailBack');
    expect(html, 'Cancel reads its own key').toContain('detailCancel');
    // The way back is a LINK, not a form. r329 (8cd601d0) added the Schedule Group card, which has a form
    // of its own — deliberately, because the group and the arrangement are two records with two writers
    // and two transactions, and posting them together would half-apply a refused arrangement after an
    // accepted group change. So the page now carries TWO forms (Schedule Group, then Save) and still no
    // history Remove. The count stays pinned, and each is named, so a third form cannot arrive unnoticed.
    expect(html.match(/<form /g)?.length ?? 0, 'two forms — Schedule Group and Save').toBe(2);
    expect(html, 'the first is the Schedule Group').toContain('<select name="attendanceRuleId"');
    expect(html, 'the second is the arrangement').toContain('name="shiftType"');
    expect(
      html.indexOf('name="attendanceRuleId"'),
      'the group is chosen FIRST — it is what narrows the shift list below it',
    ).toBeLessThan(html.indexOf('name="shiftType"'));
    // …and BOTH forms post THIS page as their returnTo, filters riding along, so a refusal lands back here.
    const returnTo = `name="returnTo" value="${LIST_URL}/${emp}?q=Quin&amp;shiftType=fixed&amp;status=current"`;
    expect(html.split(returnTo).length - 1, 'both forms come back to this page').toBe(2);
  });

  it('an older change cannot be removed — only the newest, which is the only one that can be put back', async () => {
    // THE VERIFIER'S SECOND FINDING. Removal is undone by saving the same arrangement back at the same
    // date, and the writer refuses a date earlier than the ladder's last — so removing a MIDDLE period
    // was irreversible at BOTH doors. Three periods, and the middle one is refused.
    const emp = await hire('Jo Ladder', 'E110');
    const MID = '2026-06-15';
    for (const [shiftId, effectiveFrom] of [
      [shiftA, PAST],
      [shiftB, MID],
      [shiftA, FUTURE],
    ] as const) {
      await runAction(saveScheduleAssignmentAction, {
        employmentId: emp,
        shiftType: 'fixed',
        shiftId,
        effectiveFrom,
        returnTo: LIST_URL,
      });
    }
    const before = await shiftArrangementHistory(ADMIN, emp);
    expect(before.map((h) => h.effectiveFrom), 'a three-period ladder, newest first').toEqual([
      FUTURE,
      MID,
      PAST,
    ]);

    const refused = await runAction(removeScheduleArrangementAction, {
      employmentId: emp,
      arrangementId: before[1].id,
      returnTo: LIST_URL,
    });
    expect(refused, 'the middle period is refused, in the reader’s language').toContain(
      'error=removeNotNewestRefused',
    );
    expect(
      (await shiftArrangementHistory(ADMIN, emp)).map((h) => [h.effectiveFrom, h.effectiveTo]),
      'and nothing on the ladder moved',
    ).toEqual(before.map((h) => [h.effectiveFrom, h.effectiveTo]));

    // WHY it is refused, shown rather than asserted in prose: the same date cannot be saved back while a
    // later entry stands, so a removed middle period could never be put back at either door.
    const blocked = await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftB,
      effectiveFrom: MID,
      returnTo: LIST_URL,
    });
    expect(blocked, 'back-insert is out of scope for v1 — this is the door that would have to reopen').toContain(
      'error=shiftBackInsertRefused',
    );

    // The NEWEST one, by contrast, is removable AND genuinely re-creatable — the claim this round makes.
    const removed = await runAction(removeScheduleArrangementAction, {
      employmentId: emp,
      arrangementId: before[0].id,
      returnTo: LIST_URL,
    });
    expect(removed).toContain('removed=1');
    const restored = await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: FUTURE,
      returnTo: LIST_URL,
    });
    expect(restored, 'saving it again puts it back').toContain('saved=1');
    expect((await shiftArrangementHistory(ADMIN, emp)).map((h) => h.effectiveFrom)).toEqual([
      FUTURE,
      MID,
      PAST,
    ]);
  });

  it('the page offers Remove on the newest row only, and says so', async () => {
    const emp = await hire('Kit Rows', 'E111');
    for (const [shiftId, effectiveFrom] of [
      [shiftA, PAST],
      [shiftB, '2026-06-15'],
      [shiftA, FUTURE],
    ] as const) {
      await runAction(saveScheduleAssignmentAction, {
        employmentId: emp,
        shiftType: 'fixed',
        shiftId,
        effectiveFrom,
        returnTo: LIST_URL,
      });
    }
    const hist = await shiftArrangementHistory(ADMIN, emp);
    const html = await renderDetail(emp);
    const offered = [...html.matchAll(/name="arrangementId" value="([0-9a-fA-F-]{36})"/g)].map((m) => m[1]);
    expect(offered, 'three history rows, ONE Remove form, on the newest period').toEqual([hist[0].id]);
    expect(html, 'and the screen says why the older rows have none').toContain('historyRemoveNote');
  });

  it('a malformed employmentId is refused by field, and no SQL reaches the screen', async () => {
    // The banner used to print the whole statement — table, column list and bound parameters — because
    // the id went to Postgres unchecked and the error's own message was reflected into the URL.
    for (const action of [saveScheduleAssignmentAction, removeScheduleArrangementAction]) {
      const back = await runAction(action, {
        employmentId: 'junk',
        arrangementId: randomUUID(),
        shiftType: 'fixed',
        shiftId: shiftA,
        effectiveFrom: PAST,
        returnTo: LIST_URL,
      });
      expect(back, 'no statement, no column list, no bound parameters reach the banner').not.toMatch(
        /Failed|select|from%22|params|employment%22/i,
      );
      expect(back, 'and the field that was wrong is named instead').toContain('error=badEmployment');
    }
  });

  it('an arrangement that is not on the named employee’s ladder is refused, not silently ignored', async () => {
    const one = await hire('Gus One', 'E107');
    const two = await hire('Hal Two', 'E108');
    for (const employmentId of [one, two]) {
      await runAction(saveScheduleAssignmentAction, {
        employmentId,
        shiftType: 'fixed',
        shiftId: shiftA,
        effectiveFrom: PAST,
        returnTo: LIST_URL,
      });
      await runAction(saveScheduleAssignmentAction, {
        employmentId,
        shiftType: 'fixed',
        shiftId: shiftB,
        effectiveFrom: FUTURE,
        returnTo: LIST_URL,
      });
    }
    const [hals] = await shiftArrangementHistory(ADMIN, two);
    const back = await runAction(removeScheduleArrangementAction, {
      employmentId: one,
      arrangementId: hals.id,
      returnTo: LIST_URL,
    });
    expect(back).toContain('error=removeNotFound');
    expect((await shiftArrangementHistory(ADMIN, two)).length, "Hal's ladder is untouched").toBe(2);
    expect((await shiftArrangementHistory(ADMIN, one)).length, "and so is Gus's").toBe(2);
  });
});

describe('a485afa1 — ONE record, TWO doors: the row opens its own page, through the shared control and writer', () => {
  const LIST = 'app/admin/attendance/schedule-assignment/page.tsx';
  const DETAIL = 'app/admin/attendance/schedule-assignment/[employmentId]/page.tsx';
  const ACTIONS = 'app/admin/attendance/schedule-assignment/actions.ts';
  const CARD = 'app/admin/personnel/[employmentId]/page.tsx';
  const list = read(LIST);
  const detail = read(DETAIL);
  const actions = read(ACTIONS);
  const card = read(CARD);
  /**
   * CODE only — block comments and comment lines dropped. The page's header deliberately QUOTES the r209
   * deep link it replaced (a comment that explains a removal has to name what was removed), and a source
   * scan that cannot tell the two apart would either fail on the explanation or force the explanation out.
   */
  const withoutComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
  const listCode = withoutComments(list);
  const detailCode = withoutComments(detail);

  it('the trip into Personnel Management is GONE — the row action opens the employee’s OWN page', () => {
    // r209's deep link, asserted absent. This is the reporter's whole complaint: assigning a shift to
    // twenty people was twenty round trips out of the Attendance module.
    for (const [name, code] of [
      [LIST, listCode],
      [DETAIL, detailCode],
    ] as const) {
      expect(code, `${name} must not send the administrator into Personnel Management`).not.toContain(
        '/admin/personnel/${employmentId}?tab=attendance#section-default-shift',
      );
      expect(code, `${name} must not link into the personnel profile at all`).not.toContain('/admin/personnel/');
    }
    // …and what replaced it in r265: the row's own page, filters riding along, under this same route.
    expect(list, 'the row action opens the detail page').toContain('hrefWith(`${PAGE}/${employmentId}`, {})');
    // r263's panel is gone from the list — in CODE, not merely renamed: no anchor, no panel parameter
    // driving a render, no fields, no history on the list.
    expect(listCode, `${LIST} still renders the r263 panel anchor`).not.toContain('assign-panel');
    expect(listCode, `${LIST} must not read the history — that is the detail page's`).not.toContain(
      'shiftArrangementHistory',
    );
    // Every row is an anchor the way back can land on.
    expect(list, 'each row carries the id the detail page returns to').toContain('id={`row-${r.employmentId}`}');
  });

  it('the DETAIL page mounts the personnel card’s own control — the list mounts nothing', () => {
    // THE PROMISE IN ONE ASSERTION. The reporter was told the two screens "cannot drift apart" because
    // they are two doors onto one record. A forked field list is exactly how that sentence stops being
    // true, so the three controls must be declared in ONE file and rendered by BOTH doors.
    expect(detail, `${DETAIL} imports the shared control`).toContain("from '@/components/employee-shift-fields'");
    expect(detail, `${DETAIL} renders it`).toContain('<EmployeeShiftFields');
    expect(card, `${CARD} still renders the same one`).toContain('<EmployeeShiftFields');
    // No second copy of the fields anywhere in this screen's own folder — and the list renders none.
    for (const field of ['shiftType', 'shiftId', 'effectiveFrom']) {
      for (const [name, src] of [
        [LIST, list],
        [DETAIL, detail],
      ] as const) {
        expect(src, `${name} re-declares the ${field} control instead of mounting the shared one`).not.toContain(
          `name="${field}"`,
        );
      }
    }
    expect(listCode, `${LIST} is a list again — it does not mount the control`).not.toContain('EmployeeShiftFields');
    expect(listCode, `${LIST} offers no Remove`).not.toContain('ConfirmSubmit');
  });

  it('there is still exactly ONE writer, and this screen is not a second one', () => {
    // The r209 reasoning that survives a485afa1 intact: a second write path over one table is how the two
    // surfaces would start to disagree. The screen's own action is an ADAPTER — it parses a form and picks
    // a URL to come back to; everything that decides what is stored stays in core.
    expect(actions, `${ACTIONS} writes through the shared dated writer`).toContain('assignEmployeeShiftDated(');
    expect(actions, `${ACTIONS} must not touch the ladder table itself`).not.toContain('employmentShiftArrangement');
    expect(actions, `${ACTIONS} must not open its own transaction`).not.toContain('withTenant(');
    expect(list, `${LIST} must not write from the page`).not.toContain('assignEmployeeShiftDated(');
    expect(detail, `${DETAIL} must not write from the page`).not.toContain('assignEmployeeShiftDated(');
    expect(detail, `${DETAIL} posts to the adapter`).toContain('action={saveScheduleAssignmentAction}');
    // The four fields are parsed into the same call shape the personnel action makes.
    for (const arg of ['employmentId,', 'shiftType,', 'shiftId: rawShift || null,', 'effectiveFrom: rawEffective || null,']) {
      expect(actions, `${ACTIONS} calls the writer with ${arg}`).toContain(arg);
    }
  });

  it('Personnel Management KEEPS its copy — the first door is untouched', () => {
    // "You asked for a second entry point, not for the first one to be taken away." An HR administrator
    // working through somebody's whole record must still find the schedule where it has always been.
    expect(card, `${CARD} still has the Shift arrangement card`).toContain('id="section-default-shift"');
    expect(card, `${CARD} still writes through the dated ladder writer`).toContain('setDefaultShiftAction');
    expect(card).toContain("{ key: 'attendance', label: t('tabs.attendance') }");
  });

  it('removal goes through core too, and re-opens the period it closed', () => {
    const core = read('core/shift-arrangement.ts');
    expect(actions, 'the screen calls the shared remover').toContain('removeShiftArrangement(');
    const fn = core.slice(core.indexOf('export async function removeShiftArrangement'));
    expect(fn, 'it supersedes rather than deletes').toContain('supersededAt: new Date()');
    expect(fn, 'the predecessor inherits the removed period’s end').toContain('validTo: target.validTo');
    expect(fn, 'and the employment cache is refreshed').toContain('pickArrangementOn(');
  });

  it('both screens guard themselves, both are grantable in the function-access matrix, and no third route exists', () => {
    expect(list, 'the list: its own server-side admin guard').toMatch(/requireAdmin\(/);
    expect(detail, 'the detail page: its own server-side admin guard').toMatch(/requireAdmin\(/);
    expect(actions, 'and so does every write it offers').toMatch(/requireAdmin\(\)/);
    // Rule 20: a guarded page with no matrix column is a screen nobody can grant or revoke. Both ride the
    // existing shift-library column — same guard, same admin surface — and the sub-page's entry landed
    // in the same commit as its page.tsx (test/function-access.test.ts fails in both directions).
    const permissions = read('lib/permissions.ts');
    expect(permissions).toContain("'/admin/attendance/schedule-assignment'");
    expect(permissions).toContain("'/admin/attendance/schedule-assignment/[employmentId]'");
    // r329 (8cd601d0) added the BULK screen — putting many employments in a Schedule Group in one action,
    // which is what makes r277's allowed-shift refusal bite (1 of 75 production employments was in a
    // group, and the guard is a no-op on an employment in none). It is registered on the same column in
    // the same commit, exactly as '[employmentId]' was.
    expect(permissions).toContain("'/admin/attendance/schedule-assignment/bulk'");
    // Exactly the three pages: a FOURTH page.tsx under this screen would need its own entry, so the folder
    // shape is pinned. status-chip.tsx is the ONE chip the list and the detail page render (a page.tsx may
    // export nothing but its default, and a second copy of the class map is the drift this file refuses).
    const dir = path.join(root, 'app/admin/attendance/schedule-assignment');
    expect(fs.readdirSync(dir).sort(), 'the screen is a list, its actions, one chip and two sub-routes').toEqual([
      '[employmentId]',
      'actions.ts',
      'bulk',
      // r394: every page folder carries the shared navigation shell (test/r394-route-loading.test.ts).
      'loading.tsx',
      'page.tsx',
      'status-chip.tsx',
    ]);
    expect(fs.readdirSync(path.join(dir, '[employmentId]')).sort()).toEqual(['loading.tsx', 'page.tsx']);
    // The bulk screen is a page plus ONE client island — the ticking. Everything it decides is on the
    // server, and the island imports its server action rather than being handed one as a prop.
    expect(fs.readdirSync(path.join(dir, 'bulk')).sort()).toEqual(['bulk-form.tsx', 'loading.tsx', 'page.tsx']);
    expect(list, 'the list renders the shared chip').toContain('<StatusChip');
    expect(detail, 'and so does the detail page').toContain('<StatusChip');
  });

  it('reads the ladder through the shared resolver rather than re-deciding "current"', () => {
    const core = read('core/shift-arrangement.ts');
    const fn = core.slice(core.indexOf('export function listShiftArrangements'));
    expect(fn, 'the live-index read').toContain('liveArrangementsTx(');
    expect(fn, 'the shared in-force rule').toContain('pickArrangementOn(');
    // …and no second ordering rule of its own over the periods.
    expect(fn, 'no hand-rolled latest-period sort').not.toMatch(/\.sort\(/);
  });
});

describe('6448574f + 0bade264 — every renamed label is renamed in every locale', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  type Catalog = { nav: Record<string, string>; me: Record<string, string> };
  const cat = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Catalog;

  /** The strings these screens were called BEFORE r209, per locale. None may survive anywhere below. */
  const OLD: Record<(typeof LOCALES)[number], { planOt: string; request: string; attendance: string }> = {
    en: { planOt: 'Plan OT', request: 'Attendance Request', attendance: 'Attendance' },
    ms: { planOt: 'Rancang OT', request: 'Permohonan Kehadiran', attendance: 'Kehadiran' },
    zh: { planOt: '加班计划', request: '考勤申请', attendance: '考勤' },
    ta: { planOt: 'கூடுதல் நேரத் திட்டம்', request: 'வருகைக் கோரிக்கை', attendance: 'கலந்துகொள்வு' },
    th: { planOt: 'วางแผน OT', request: 'คำขอเวลาทำงาน', attendance: 'การเข้างาน' },
    vi: { planOt: 'Kế hoạch OT', request: 'Yêu cầu chấm công', attendance: 'Chấm công' },
  };

  it('6448574f: the English names are the ones the reporter asked for', () => {
    const en = cat('en');
    expect(en.nav.attendanceRequest).toBe('Attendance Irregularity');
    expect(en.me.attendanceRequest).toBe('Attendance Irregularity');
    expect(en.nav.planOvertime).toBe('Self Overtime');
    expect(en.me.planOtTitle).toBe('Self Overtime');
  });

  it('6448574f: no locale still says "Plan OT" or "Attendance Request", in the menu OR the body copy', () => {
    // The half i18n-check.mjs cannot do. Parity passes with a locale left entirely on the old wording,
    // and a menu renamed in English only is the "half-translated" outcome the plan rules out by name.
    for (const loc of LOCALES) {
      const c = cat(loc);
      const planOtStrings = {
        'nav.planOvertime': c.nav.planOvertime,
        'me.planOtTitle': c.me.planOtTitle,
        'me.backToPlanOt': c.me.backToPlanOt,
        'me.overtimeMovedHeading': c.me.overtimeMovedHeading,
        'me.overtimeMovedBody': c.me.overtimeMovedBody,
      };
      for (const [key, value] of Object.entries(planOtStrings)) {
        expect(value, `${loc}: ${key} still names the screen "${OLD[loc].planOt}"`).not.toContain(OLD[loc].planOt);
      }
      for (const [key, value] of Object.entries({
        'nav.attendanceRequest': c.nav.attendanceRequest,
        'me.attendanceRequest': c.me.attendanceRequest,
      })) {
        expect(value, `${loc}: ${key} still says "${OLD[loc].request}"`).not.toContain(OLD[loc].request);
      }
    }
  });

  it('6448574f: the menu row and the screen it opens read the SAME words, in every locale', () => {
    // WHY THIS STILL HOLDS AFTER c6bb5f5a, WHICH REVERSED THE PREMISE. It used to read: /attendance/plan-ot
    // FORWARDS to /attendance/requests?section=overtime, so the row and the tab it lands on are one
    // destination under two labels. The forward is gone — Self Overtime is a screen of its own again, at
    // the reporter's confirmed request — but the half that made the assertion worth having is untouched: a
    // menu row and the screen it opens must not have two different names, or the employee goes looking for
    // a screen that (as far as they can see) is not there. So the pairs are re-pointed at the page TITLES.
    //
    // `me.planOtTitle` is that page's own title key, revived by c6bb5f5a — it had been orphaned since the
    // list moved into a tab, and a title key that no page renders is exactly how the two drift apart.
    for (const loc of LOCALES) {
      const c = cat(loc);
      expect(c.nav.planOvertime, `${loc}: Self Overtime row vs its page title`).toBe(c.me.planOtTitle);
      // The section heading on that page reads the same words as its title and its row — three names for
      // one thing is the state this assertion exists to prevent.
      expect(c.nav.planOvertime, `${loc}: Self Overtime row vs the list heading`).toBe(c.me.maSectionOvertime);
      expect(c.nav.attendanceRequest, `${loc}: nav row vs the screen title key`).toBe(c.me.attendanceRequest);
      // c6bb5f5a's two new rows, held to the same rule from the day they shipped.
      //
      // ⚠️ b833a077 (r362) — ONE OF THE PAIR IS GONE AND THE OTHER IS UNCHANGED. The line that stood here
      //   expect(c.nav.myTravel, `${loc}: My Travel row vs its page title`).toBe(c.me.myTravel);
      // pinned a LIVE row against a LIVE page title. My Travel was removed completely: there is no row
      // and no page title, so the claim it made is no longer about anything. Both keys are RETIRED rather
      // than deleted (the repo convention), and the rule is restated at the level that still applies to a
      // retired pair — they must carry the SAME retirement marker. Left as it was, the assertion would
      // still have passed on two identical markers while asserting something false; asserted this way it
      // fails if either key is quietly revived, or revived on one side only, which is the real hazard.
      expect(c.nav.myTravel, `${loc}: nav.myTravel must stay retired`).toMatch(/^\[retired r362 —/);
      expect(c.me.myTravel, `${loc}: me.myTravel must stay retired`).toMatch(/^\[retired r362 —/);
      expect(c.nav.myAttendanceRequestStatus, `${loc}: request-status row vs its page title`).toBe(
        c.me.myAttendanceRequestStatus,
      );
    }
  });

  it('0bade264: the Administration menu is "Attendance" and nothing else is, in every locale', () => {
    // The collision the rename would otherwise create. Both halves per locale: the menu took the plain
    // module word, so the operational Records column had to give it up. Reverting either alone fails here.
    //
    // NOTE the two spellings in the old catalogue: `nav.attendanceSettings` used "வருகை" while
    // `nav.attendance` used "கலந்துகொள்வு" for the same word in Tamil. The MENU keeps the term the
    // settings key already used (below); what matters for the collision is that the two now differ.
    const PLAIN_WORD: Record<(typeof LOCALES)[number], string> = {
      en: 'Attendance',
      ms: 'Kehadiran',
      zh: '考勤',
      ta: 'வருகை',
      th: 'การเข้างาน',
      vi: 'Chấm công',
    };
    expect(cat('en').nav.attendance).toBe('Attendance Records');
    for (const loc of LOCALES) {
      const c = cat(loc);
      expect(c.nav.attendanceSettings, `${loc}: the Administration menu reads the plain module word`).toBe(
        PLAIN_WORD[loc],
      );
      expect(c.nav.attendance, `${loc}: the Records column must not read the same as the menu`).not.toBe(
        c.nav.attendanceSettings,
      );
      expect(c.nav.attendance, `${loc}: nav.attendance was renamed, not left as the bare module word`).not.toBe(
        OLD[loc].attendance,
      );
    }
  });

  it('0bade264: Schedule Assignment has a label in every locale, and it is not blank or English-only', () => {
    for (const loc of LOCALES) {
      const v = cat(loc).nav.scheduleAssignment;
      expect(typeof v, `${loc}: nav.scheduleAssignment`).toBe('string');
      expect(v, `${loc}: nav.scheduleAssignment is blank`).not.toBe('');
      if (loc !== 'en') {
        expect(v, `${loc}: nav.scheduleAssignment was left in English`).not.toBe('Schedule Assignment');
      }
    }
  });
});
