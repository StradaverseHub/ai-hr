/**
 * r209 — Schedule Assignment (0bade264) and the Attendance menu rename (0bade264 + 6448574f).
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
 *     or not a second editor exists, and so does a unit test of the card. So it is asserted across
 *     BOTH sources: the list must LINK into the personnel card's own anchor, that anchor and the
 *     shared control must still be there, and the list must contain no editor of its own.
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createShift } from '../core/roster';
import { assignEmployeeShiftDated, listShiftArrangements } from '../core/shift-arrangement';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

  beforeAll(async () => {
    await migrateTestDb();
  });
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
  afterAll(async () => {
    await closeAll();
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

describe('0bade264 — ONE editor: the list links into the personnel card, it does not copy it', () => {
  const LIST = 'app/admin/attendance/schedule-assignment/page.tsx';
  const CARD = 'app/admin/personnel/[employmentId]/page.tsx';
  const list = read(LIST);
  const card = read(CARD);

  it('the list opens the personnel Attendance tab at the Shift arrangement card', () => {
    // Both ends of the deep link, in one case, because either half alone is satisfiable while broken:
    // the list can point at an anchor that does not exist, and the card can carry an anchor nobody uses.
    expect(list, `${LIST} links to the per-employee card`).toContain(
      '/admin/personnel/${employmentId}?tab=attendance#section-default-shift',
    );
    expect(card, `${CARD} still has the anchor that link targets`).toContain('id="section-default-shift"');
    expect(card, `${CARD} still renders the shared control`).toContain('<EmployeeShiftFields');
    expect(card, `${CARD} still writes through the dated ladder writer`).toContain('setDefaultShiftAction');
    // The tab key the link asks for is a real tab on that page.
    expect(card).toContain("{ key: 'attendance', label: t('tabs.attendance') }");
  });

  it('the list has NO editor of its own — no form, no control, no writer', () => {
    // THE REQUIREMENT IN ONE ASSERTION. "Both surfaces act on the same information" is only true while
    // there is one write path; a second form here would be a second one, and the two would drift.
    expect(list, 'no form element').not.toMatch(/<form\b/);
    expect(list, 'does not render the shared shift control itself').not.toContain('<EmployeeShiftFields');
    expect(list, 'does not import it either').not.toContain("from '@/components/employee-shift-fields'");
    expect(list, 'no writer call').not.toContain('assignEmployeeShiftDated(');
    expect(list, 'no server action').not.toContain("'use server'");
  });

  it('the screen guards itself and is grantable in the function-access matrix', () => {
    expect(list, 'its own server-side admin guard').toMatch(/requireAdmin\(/);
    // Rule 20: a guarded page with no matrix column is a screen nobody can grant or revoke. It rides the
    // existing shift-library column — same guard, same admin surface.
    expect(read('lib/permissions.ts')).toContain("'/admin/attendance/schedule-assignment'");
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
