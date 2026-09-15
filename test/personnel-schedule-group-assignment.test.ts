/**
 * f513ec02 (r281) — PUTTING A PERSON IN A SCHEDULE GROUP, and the reverse of the allowed-shift refusal.
 *
 * r277 (870b79e2) shipped `employment.attendance_rule_id` (migration 0464), the additive rule resolution
 * that reads it, and the refusal four shift writers call. What it did not ship was a way to SET the
 * column: no writer, no screen. Employee → Schedule Group → Shift was reachable from both ends and from
 * neither middle. Two things close it, and both are pinned here:
 *
 *   A. THE CONTROL. A Schedule Group select on the Personnel → Attendance tab, directly under the Holiday
 *      Group it is modelled on, whose BLANK option is a real value meaning "no group — resolve the rules
 *      from the shift, exactly as before". Feedback 57840a6e is the recorded cost of collapsing a
 *      tri-state ON THIS SAME SCREEN (a checkbox that could not carry three states pinned employees to an
 *      explicit "No" they never chose), so the blank option is asserted structurally, not by eye.
 *
 *   B. THE REVERSE CHECK, which is the substance of the item. Every existing caller of
 *      `assertShiftsAllowedForEmploymentsTx` moves the SHIFT while the group stands still. This writer
 *      moves the GROUP while the shift stands still — the one direction that could seat somebody in a
 *      group forbidding the shift they are already working. It is checked against all THREE places a
 *      current shift is stored (today's roster row, the dated arrangement in force, the backup-shift
 *      cache), because each of those is a stored (employment, shift) pair that the four assignment-side
 *      refusals declare impossible once the group exists. §3 exercises one rung per case, and each rung
 *      is paired with a positive control on the SAME employee so none of them can pass vacuously.
 *
 * THE RELEASE-DAY PROMISE. No employment carries a group today, so nothing may move. §2 pins it where it
 * can actually be falsified: the writer's NULL path leaves a verdict byte-identical to the one the same
 * employee, the same shift and the same clocking produced before the column was ever written.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { checkIn } from '../core/attendance';
import {
  createAttendanceRule,
  ensureStandardRule,
  setAttendanceRuleStatus,
  type AttendanceRuleInput,
} from '../core/attendance-rule';
import {
  ScheduleGroupNotFoundError,
  ShiftNotInScheduleGroupError,
  assignDefaultShift,
  assignShift,
  createShift,
  employmentScheduleGroupId,
  setEmploymentScheduleGroup,
} from '../core/roster';
import { assignEmployeeShiftDated } from '../core/shift-arrangement';
import { ATTENDANCE_TAB_SECTION_ORDER } from '../lib/personnel-tab-sections';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

// The action layer calls requireAdmin() (a session), which the harness has no request for — hand back the
// seeded admin ctx so the action's writes still run under RLS. Precedent: the sibling relocation tests.
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

import { setEmploymentScheduleGroupAction } from '../app/admin/personnel/[employmentId]/actions';

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');
const PAGE = () => read('app/admin/personnel/[employmentId]/page.tsx');
const ACTIONS = () => read('app/admin/personnel/[employmentId]/actions.ts');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** A fixed past Wednesday — inside every shift's Mon–Fri pattern, and never "today". */
const WED = '2026-07-01';
let b: Base;

const ruleInput = (name: string, over: Partial<AttendanceRuleInput> = {}): AttendanceRuleInput => ({
  name,
  status: 'active',
  lateGracePeriodMinutes: 0,
  lateAfterMinutes: 0,
  lateDeductMinutes: 0,
  includeGraceInLateness: false,
  earlyGracePeriodMinutes: 0,
  earlyAfterMinutes: 0,
  earlyDeductMinutes: 0,
  includeGraceInEarlyOut: false,
  applyToEarlyOt: false,
  otRows: [],
  ...over,
});

const workdayShift = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  code: `C_${randomUUID().slice(0, 6)}`,
  startTime: '09:00:00',
  endTime: '18:00:00',
  breakMinutes: 60,
  // Every weekday INCLUDING the weekend, so "today" is a working day whatever day the gate runs on and a
  // dated-arrangement write is never refused for a shift with no pattern.
  weeklyPattern: [1, 2, 3, 4, 5, 6, 7],
  ...over,
});

async function makeEmp(): Promise<string> {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Group Member', primaryEmail: `grp_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

const storedGroup = async (employmentId: string): Promise<string | null> => {
  const [row] = await owner.db
    .select({ ruleId: schema.employment.attendanceRuleId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row?.ruleId ?? null;
};

/** Null the backup-shift cache WITHOUT touching the ladder — the stale-cache state rung 2 exists for. */
const clearCache = (employmentId: string) =>
  owner.db
    .update(schema.employment)
    .set({ defaultShiftId: null })
    .where(eq(schema.employment.id, employmentId));

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  LAST_REDIRECT = '';
});

// ── §1 · THE CONTROL — a select whose blank option is a value, on the tab that owns the precedent ─────
describe('§1 the Schedule Group field on the Personnel Attendance tab', () => {
  it('(1) renders inside the tab save scope, under Holiday Calendar and above Clocking', () => {
    const page = PAGE();
    const scope = page.slice(page.indexOf('tabKey="attendance"'), page.indexOf('</TabSaveScope>', page.indexOf('tabKey="attendance"')));
    const holiday = scope.indexOf('{holidayCalendarCard}');
    const group = scope.indexOf('{scheduleGroupCard}');
    const clocking = scope.indexOf('{clockingCard}');
    expect(holiday, 'Holiday Calendar is on this tab').toBeGreaterThan(-1);
    expect(group, 'the Schedule Group card is on this tab').toBeGreaterThan(-1);
    // Item 52a30630 pinned Holiday Calendar to the top of this tab; f513ec02 must not reverse that.
    expect(holiday, 'Holiday Calendar stays first').toBeLessThan(group);
    expect(group, 'Schedule Group sits above Clocking & Geofencing').toBeLessThan(clocking);
  });

  /**
   * THE 57840a6e GUARD. The defect that feedback records is a control that cannot carry three states
   * rendering one of them and then persisting it. Three things together make that unrepresentable here,
   * and all three are asserted because any one of them alone can be undone by a refactor that still
   * "looks right": a select (not a checkbox), a FIRST option whose value is the empty string, and a
   * defaultValue taken from the STORED column rather than from any default.
   */
  it("(2) BLANK IS A REAL OPTION — a select, an empty-string option, and a defaultValue from the stored column", () => {
    const page = PAGE();
    const from = page.indexOf('const scheduleGroupCard');
    expect(from, 'the card exists').toBeGreaterThan(-1);
    const card = page.slice(from, page.indexOf('const locationCard', from));
    expect(card, 'a select, never a checkbox — the 57840a6e collapse must stay impossible').toContain(
      '<select name="attendanceRuleId"',
    );
    expect(card).not.toContain('type="checkbox"');
    expect(card).toContain("defaultValue={scheduleGroupCurrentId ?? ''}");
    const blank = card.indexOf('<option value="">');
    expect(blank, 'the blank option is present').toBeGreaterThan(-1);
    expect(blank, 'and it comes FIRST, so a stored value can never be shadowed by a named group').toBeLessThan(
      card.indexOf('scheduleGroupOptions.map'),
    );
    // And the writer maps it to null rather than reading an absent field as "leave as-is".
    expect(ACTIONS()).toContain("attendanceRuleId: (formData.get('attendanceRuleId') as string) || null,");
  });

  it('(3) the card is a section of the Attendance tab’s one Save, with a writer behind it', () => {
    expect([...ATTENDANCE_TAB_SECTION_ORDER]).toContain('schedule');
    const page = PAGE();
    expect(page).toContain('data-save-section="schedule"');
    // `covers` prints the card names on the sticky bar; a card in the scope but not named is a bar that
    // owns more than it says (r255/r256 both had to correct that).
    expect(page).toContain("attendance: [t('holidayCalendarCardTitle'), t('scheduleGroupCardTitle'), ...whenLive(tc('cardTitle'))],");
    expect(ACTIONS()).toContain('schedule: applyScheduleGroupSection,');
  });

  it('(4) every new key resolves in all six locales, with the ICU argument the option needs', () => {
    const keys = [
      'scheduleGroupCardTitle',
      'scheduleGroup',
      'scheduleGroupNone',
      'scheduleGroupInactiveOption',
      'scheduleGroupHint',
      'scheduleGroupManage',
      'scheduleGroupEmpty',
    ];
    for (const loc of LOCALES) {
      const detail = JSON.parse(read(`messages/${loc}.json`)).people.detail as Record<string, string>;
      for (const k of keys) {
        expect(typeof detail[k], `${loc}.people.detail.${k} exists`).toBe('string');
        expect(detail[k].length, `${loc}.${k} is not empty`).toBeGreaterThan(0);
      }
      expect(detail.scheduleGroupInactiveOption, `${loc} keeps the {name} argument`).toContain('{name}');
    }
  });
});

// ── §2 · THE WRITER — and the release-day promise that nothing moves ──────────────────────────────────
describe('§2 the writer', () => {
  it('(5) the action puts an employee in a group and appends one event', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('A02'));
    const emp = await makeEmp();

    const fd = new FormData();
    fd.set('employmentId', emp);
    fd.set('attendanceRuleId', group.id);
    await expect(setEmploymentScheduleGroupAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');
    expect(await storedGroup(emp)).toBe(group.id);
    expect(await eventTypesFor(b.tenantId, emp)).toContain('employment.schedule-group.changed');
    // The read the screen renders from must agree with the column the writer set.
    expect(await employmentScheduleGroupId(a, emp)).toBe(group.id);
  });

  /**
   * ⚠️ THE RELEASE-DAY PROMISE, AND THE REASON IT IS STRUCTURAL RATHER THAN LUCKY.
   *
   * Zero employments carry a group today, so nothing may move. What makes that hold after this round is
   * not caution — it is the reverse check itself. A group is only accepted when it ALLOWS the shift the
   * employee is on, the allowed list IS `shift.rule_id` read backwards, and rule resolution reads the
   * group first; so any group this writer accepts carries the very rule the shift already pointed at, and
   * the "group outranks shift" precedence is invisible on every assignment the system will take. The
   * verdict below is therefore identical across all four states — no group, a no-op write, a legally
   * assigned group, and a cleared one — while the COLUMN visibly moves through them.
   *
   * The inverse (a group that disagrees with the shift genuinely changing a verdict) is pinned in
   * test/schedule-group-resolution.test.ts, which writes the column as the migration role precisely
   * because no screen could reach that state.
   */
  it('(6) nothing moves: the writer’s null path, a legal group and a clear all leave the verdict alone', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const strict = await createAttendanceRule(a, ruleInput('Strict', { lateGracePeriodMinutes: 0 }));
    const lenient = await createAttendanceRule(a, ruleInput('Lenient', { lateGracePeriodMinutes: 30 }));
    const sh = await createShift(a, workdayShift('Morning', { ruleId: strict.id }));
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: sh.id });
    await assignShift(a, { employmentId: emp, shiftDate: WED, shiftId: sh.id });

    const verdict = async () => {
      await owner.db.delete(schema.attendance).where(eq(schema.attendance.employmentId, emp));
      return (await checkIn(a, { employmentId: emp, date: WED, time: '09:20:00' })).status;
    };

    // 1. NO GROUP — the shift's own strict rule. This is the figure release day promises.
    expect(await verdict()).toBe('late');

    // 2. The writer called with NULL on an already-null column: a no-op, and nothing moves.
    const noop = await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: null });
    expect(noop.changed).toBe(false);
    expect(await storedGroup(emp)).toBeNull();
    expect(await verdict()).toBe('late');

    // 3. A group the check ACCEPTS — necessarily the rule this shift already carries. Column set, verdict
    //    unchanged, which is the whole point: an accepted group never disagrees with the shift.
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: strict.id });
    expect(await storedGroup(emp)).toBe(strict.id);
    expect(await verdict()).toBe('late');

    // 3b. …and the group that WOULD have moved the verdict is exactly the one the check refuses.
    await expect(
      setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: lenient.id }),
    ).rejects.toBeInstanceOf(ShiftNotInScheduleGroupError);
    expect(await storedGroup(emp), 'the refused group left the accepted one in place').toBe(strict.id);

    // 4. BLANK ⇒ NULL, never an explicit value — and back to where release day started.
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: '' });
    expect(await storedGroup(emp)).toBeNull();
    expect(await verdict()).toBe('late');
  });

  it('(7) an unchanged save writes nothing and appends no event', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('A02'));
    const emp = await makeEmp();
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });
    const before = (await eventTypesFor(b.tenantId, emp)).filter((e) => e === 'employment.schedule-group.changed');
    const again = await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });
    expect(again.changed).toBe(false);
    const after = (await eventTypesFor(b.tenantId, emp)).filter((e) => e === 'employment.schedule-group.changed');
    expect(after.length, 'the Attendance tab’s Save must not grow an audit row per unrelated save').toBe(
      before.length,
    );
  });

  it('(8) a group id this tenant does not have is refused, not written', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const emp = await makeEmp();
    await expect(
      setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: randomUUID() }),
    ).rejects.toBeInstanceOf(ScheduleGroupNotFoundError);
    expect(await storedGroup(emp)).toBeNull();
  });

  it('(9) an INACTIVE group that is already assigned can still be re-saved (the picker keeps it)', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('A02'));
    const emp = await makeEmp();
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });
    await setAttendanceRuleStatus(a, { ruleId: group.id, status: 'inactive' });
    // Not a no-op path: clear it and put it back, which is what an operator saving the card would do.
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: null });
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });
    expect(await storedGroup(emp)).toBe(group.id);
  });
});

// ── §3 · THE REVERSE CHECK — the substance of the item ────────────────────────────────────────────────
describe('§3 setting a group re-validates the shift the employee is already on', () => {
  /** One group allowing exactly one shift, plus a shift outside it. */
  async function groups() {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('A02'));
    const allowed = await createShift(a, workdayShift('Morning', { ruleId: group.id }));
    const forbidden = await createShift(a, workdayShift('Night'));
    return { a, group, allowed, forbidden };
  }

  it('(10) RUNG 3 — the backup shift (employment.default_shift_id)', async () => {
    const { a, group, allowed, forbidden } = await groups();

    // NEGATIVE: the backup shift is not in the group ⇒ the group cannot be assigned, and the message says
    // which shifts it does allow.
    const bad = await makeEmp();
    await assignDefaultShift(a, { employmentId: bad, shiftId: forbidden.id });
    await expect(
      setEmploymentScheduleGroup(a, { employmentId: bad, attendanceRuleId: group.id }),
    ).rejects.toBeInstanceOf(ShiftNotInScheduleGroupError);
    await expect(
      setEmploymentScheduleGroup(a, { employmentId: bad, attendanceRuleId: group.id }),
    ).rejects.toThrow(/Night(.|\n)*allows: Morning/);
    // THE WRITE IS ROLLED BACK. The column is updated before the assertion runs (so the shared refusal can
    // read it); a refusal must therefore leave no trace at all.
    expect(await storedGroup(bad), 'a refused assignment stores nothing').toBeNull();
    expect(await eventTypesFor(b.tenantId, bad)).not.toContain('employment.schedule-group.changed');

    // POSITIVE CONTROL: same group, same writer, a backup shift the group DOES allow.
    const ok = await makeEmp();
    await assignDefaultShift(a, { employmentId: ok, shiftId: allowed.id });
    await setEmploymentScheduleGroup(a, { employmentId: ok, attendanceRuleId: group.id });
    expect(await storedGroup(ok)).toBe(group.id);
  });

  it('(11) RUNG 2 — the dated arrangement, read even when the backup-shift cache is empty', async () => {
    const { a, group, allowed, forbidden } = await groups();
    const today = todayInKualaLumpur();

    const bad = await makeEmp();
    await assignEmployeeShiftDated(a, {
      employmentId: bad,
      shiftType: 'fixed',
      shiftId: forbidden.id,
      effectiveFrom: today,
    });
    // The ladder write also refreshes the cache; nulling it leaves rung 2 as the ONLY source that can
    // answer, which is the state a future-dated change legitimately produces.
    await clearCache(bad);
    await expect(
      setEmploymentScheduleGroup(a, { employmentId: bad, attendanceRuleId: group.id }),
    ).rejects.toBeInstanceOf(ShiftNotInScheduleGroupError);
    expect(await storedGroup(bad)).toBeNull();

    const ok = await makeEmp();
    await assignEmployeeShiftDated(a, {
      employmentId: ok,
      shiftType: 'fixed',
      shiftId: allowed.id,
      effectiveFrom: today,
    });
    await clearCache(ok);
    await setEmploymentScheduleGroup(a, { employmentId: ok, attendanceRuleId: group.id });
    expect(await storedGroup(ok)).toBe(group.id);
  });

  it('(12) RUNG 1 — today’s roster row, even when every other source is allowed', async () => {
    const { a, group, allowed, forbidden } = await groups();
    const today = todayInKualaLumpur();

    // Backup shift ALLOWED, today's rostered shift FORBIDDEN. Only a check that reads the roster row can
    // refuse this one, so it fails the moment rung 1 is dropped.
    const bad = await makeEmp();
    await assignDefaultShift(a, { employmentId: bad, shiftId: allowed.id });
    await assignShift(a, { employmentId: bad, shiftDate: today, shiftId: forbidden.id });
    await expect(
      setEmploymentScheduleGroup(a, { employmentId: bad, attendanceRuleId: group.id }),
    ).rejects.toBeInstanceOf(ShiftNotInScheduleGroupError);
    expect(await storedGroup(bad)).toBeNull();

    // POSITIVE CONTROL: the same shape with the rostered shift allowed too — so the case above is failing
    // on the roster row and not merely because a roster row exists.
    const ok = await makeEmp();
    await assignDefaultShift(a, { employmentId: ok, shiftId: allowed.id });
    await assignShift(a, { employmentId: ok, shiftDate: today, shiftId: allowed.id });
    await setEmploymentScheduleGroup(a, { employmentId: ok, attendanceRuleId: group.id });
    expect(await storedGroup(ok)).toBe(group.id);
  });

  /**
   * A UNION, NOT A LADDER. core/attendance.ts stops at the first rung that answers, because it is judging
   * ONE day. This check may not: a person rostered onto an allowed shift TODAY whose backup shift the
   * group forbids would be admitted, and tomorrow — no roster row — they would be working a shift
   * `assertShiftsAllowedForEmploymentsTx` refuses to assign. The invariant the four writers maintain is
   * "no stored pair contradicts the group", so every stored pair is read.
   */
  it('(13) an ALLOWED roster row does not excuse a forbidden backup shift', async () => {
    const { a, group, allowed, forbidden } = await groups();
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: forbidden.id });
    await assignShift(a, { employmentId: emp, shiftDate: todayInKualaLumpur(), shiftId: allowed.id });
    await expect(
      setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id }),
    ).rejects.toBeInstanceOf(ShiftNotInScheduleGroupError);
    expect(await storedGroup(emp)).toBeNull();
  });

  it('(14) TAKING SOMEBODY OUT of a group is never refused, whatever shift they are on', async () => {
    const { a, group, allowed, forbidden } = await groups();
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: allowed.id });
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: group.id });
    // The shift is taken off the group behind their back (setRuleShifts does not re-examine members), so
    // the employee is now in the contradictory state. The way OUT must not itself be blocked.
    await owner.db.update(schema.shift).set({ ruleId: null }).where(eq(schema.shift.id, allowed.id));
    expect(forbidden.id).toBeTruthy();
    await setEmploymentScheduleGroup(a, { employmentId: emp, attendanceRuleId: null });
    expect(await storedGroup(emp)).toBeNull();
  });

  it('(15) the refusal reaches the SCREEN with its message intact, through the tab’s per-card action', async () => {
    const { a, group, forbidden } = await groups();
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: forbidden.id });
    const fd = new FormData();
    fd.set('employmentId', emp);
    fd.set('attendanceRuleId', group.id);
    await expect(setEmploymentScheduleGroupAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('error=');
    expect(decodeURIComponent(LAST_REDIRECT)).toContain('allows: Morning');
    expect(LAST_REDIRECT).not.toContain('toast=Saved');
    expect(await storedGroup(emp)).toBeNull();
  });
});
