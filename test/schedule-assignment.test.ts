/**
 * r209 — Schedule Assignment (0bade264) and the Attendance menu rename (0bade264 + 6448574f),
 * r263 — the edit panel on that screen (a485afa1).
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
 *     (core/shift-arrangement.ts). So the assertions now read: the deep link is GONE, both screens
 *     render the ONE control, the screen's action is an adapter and not a second writer, and the
 *     personnel card is still standing. Plus a database-backed half r209 could not have: the history a
 *     save from Attendance produces is compared, row for row, with the history the same save through
 *     Personnel produces.
 *
 *     AND ITS THIRD OPERATION. Removal did not exist at either door — the panel is the first surface to
 *     offer it — so `removeShiftArrangement` is pinned here too: it supersedes rather than deletes, it
 *     re-opens the period it had closed, and it refuses to take away the last one on file.
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

import {
  removeScheduleArrangementAction,
  saveScheduleAssignmentAction,
} from '../app/admin/attendance/schedule-assignment/actions';
import { setDefaultShiftAction } from '../app/admin/personnel/[employmentId]/actions';

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

  it('saving from the panel comes back to the list, filters and panel intact — the round trip is gone', async () => {
    const emp = await hire('Cara Return', 'E103');
    const back = await runAction(saveScheduleAssignmentAction, {
      employmentId: emp,
      shiftType: 'fixed',
      shiftId: shiftA,
      effectiveFrom: PAST,
      returnTo: `${LIST_URL}?status=current&assign=${emp}`,
    });
    expect(back, 'the save stays inside Attendance').not.toContain('/admin/personnel/');
    expect(back).toContain(`${LIST_URL}?`);
    expect(back, 'the filter the administrator was working under survives the save').toContain('status=current');
    expect(back, 'and the panel stays open on the employee just saved').toContain(`assign=${emp}`);
    expect(back).toContain('saved=1');

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
    expect(back, 'an off-site returnTo falls back to the bare page').toBe(`${LIST_URL}?saved=1#assign-panel`);
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
      returnTo: LIST_URL,
    });
    expect(back).toContain('removed=1');

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

describe('a485afa1 — ONE record, TWO doors: the list edits in place, through the shared control and writer', () => {
  const LIST = 'app/admin/attendance/schedule-assignment/page.tsx';
  const ACTIONS = 'app/admin/attendance/schedule-assignment/actions.ts';
  const CARD = 'app/admin/personnel/[employmentId]/page.tsx';
  const list = read(LIST);
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

  it('the trip into Personnel Management is GONE — the row action opens a panel on this screen', () => {
    // r209's deep link, asserted absent. This is the reporter's whole complaint: assigning a shift to
    // twenty people was twenty round trips out of the Attendance module.
    expect(listCode, `${LIST} must not send the administrator into Personnel Management`).not.toContain(
      '/admin/personnel/${employmentId}?tab=attendance#section-default-shift',
    );
    expect(listCode, `${LIST} must not link into the personnel profile at all`).not.toContain('/admin/personnel/');
    // …and what replaced it: a URL-driven panel on this same screen.
    expect(list, 'the row action opens the panel').toContain("hrefWith({ assign: employmentId })");
    expect(list, 'the panel is a real anchor on this page').toContain('id="assign-panel"');
  });

  it('the panel MOUNTS the personnel card’s own control — it does not fork the three fields', () => {
    // THE PROMISE IN ONE ASSERTION. The reporter was told the two screens "cannot drift apart" because
    // they are two doors onto one record. A forked field list is exactly how that sentence stops being
    // true, so the three controls must be declared in ONE file and rendered by BOTH screens.
    expect(list, `${LIST} imports the shared control`).toContain("from '@/components/employee-shift-fields'");
    expect(list, `${LIST} renders it`).toContain('<EmployeeShiftFields');
    expect(card, `${CARD} still renders the same one`).toContain('<EmployeeShiftFields');
    // No second copy of the fields anywhere in this screen's own folder.
    for (const field of ['shiftType', 'shiftId', 'effectiveFrom']) {
      expect(list, `${LIST} re-declares the ${field} control instead of mounting the shared one`).not.toContain(
        `name="${field}"`,
      );
    }
  });

  it('there is still exactly ONE writer, and this screen is not a second one', () => {
    // The r209 reasoning that survives a485afa1 intact: a second write path over one table is how the two
    // surfaces would start to disagree. The screen's own action is an ADAPTER — it parses a form and picks
    // a URL to come back to; everything that decides what is stored stays in core.
    expect(actions, `${ACTIONS} writes through the shared dated writer`).toContain('assignEmployeeShiftDated(');
    expect(actions, `${ACTIONS} must not touch the ladder table itself`).not.toContain('employmentShiftArrangement');
    expect(actions, `${ACTIONS} must not open its own transaction`).not.toContain('withTenant(');
    expect(list, `${LIST} must not write from the page`).not.toContain('assignEmployeeShiftDated(');
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

  it('the screen guards itself, is grantable in the function-access matrix, and minted no new route', () => {
    expect(list, 'its own server-side admin guard').toMatch(/requireAdmin\(/);
    expect(actions, 'and so does every write it offers').toMatch(/requireAdmin\(\)/);
    // Rule 20: a guarded page with no matrix column is a screen nobody can grant or revoke. It rides the
    // existing shift-library column — same guard, same admin surface.
    expect(read('lib/permissions.ts')).toContain("'/admin/attendance/schedule-assignment'");
    // a485afa1 added an edit panel, NOT a sub-route: a new page.tsx here would need its own entry in the
    // same commit (test/function-access.test.ts fails in both directions), so its absence is pinned.
    const dir = path.join(root, 'app/admin/attendance/schedule-assignment');
    expect(fs.readdirSync(dir).sort(), 'no sub-route was added under this screen').toEqual([
      'actions.ts',
      'page.tsx',
    ]);
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
      expect(c.nav.myTravel, `${loc}: My Travel row vs its page title`).toBe(c.me.myTravel);
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
