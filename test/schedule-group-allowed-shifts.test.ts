/**
 * 870b79e2 (r277) — "refuse an employee being put on a shift that is not in their group's allowed list,
 * with a clear message saying which shifts are allowed".
 *
 * ⚠️ THE POINT OF THIS FILE IS THE NUMBER FOUR. "Which shift is this person on" has FOUR writers, and the
 * approved plan says in so many words that a check on a form would miss three of them:
 *
 *   1. the profile BACKUP SHIFT            core/roster.ts assignEmployeeShift → employment.default_shift_id
 *   2. the per-date roster BRUSH           core/roster.ts assignShift (assignRosterRow loops it)
 *   3. ROSTER GENERATION                   core/roster.ts assignShiftBulk (generateRosterFromTemplate)
 *   4. the dated ARRANGEMENT LADDER        core/shift-arrangement.ts assignEmployeeShiftDated
 *
 * …plus copyRoster, which is not one of the four but writes roster rows FORWARD in time from a window
 * nobody re-examines, so a group assigned after the source was rostered would otherwise slip through it.
 * Each is exercised below against the same group, so a refusal deleted from any one of them fails here.
 *
 * THE ALLOWED LIST IS shift.rule_id READ BACKWARDS — no junction table, no second column. Which is also
 * why setRuleShifts (the group screen's "Shifts allowed" editor) is pinned here: it is the only thing that
 * decides what the refusal will allow.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createAttendanceRule, ensureStandardRule, setRuleShifts, type AttendanceRuleInput } from '../core/attendance-rule';
import {
  ShiftNotInScheduleGroupError,
  assignDefaultShift,
  assignShift,
  assignShiftBulk,
  copyRoster,
  createShift,
} from '../core/roster';
import { assignEmployeeShiftDated } from '../core/shift-arrangement';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const WED = '2026-07-01';
const NEXT_WED = '2026-07-08';
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
  weeklyPattern: [1, 2, 3, 4, 5],
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

const setGroup = (employmentId: string, ruleId: string | null) =>
  owner.db.update(schema.employment).set({ attendanceRuleId: ruleId }).where(eq(schema.employment.id, employmentId));

const rosterRows = (employmentId: string) =>
  owner.db
    .select({ shiftDate: schema.rosterAssignment.shiftDate, shiftId: schema.rosterAssignment.shiftId })
    .from(schema.rosterAssignment)
    .where(eq(schema.rosterAssignment.employmentId, employmentId))
    .orderBy(schema.rosterAssignment.shiftDate);

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('870b79e2 — an employee with no Schedule Group is not constrained (release day)', () => {
  it('every writer still accepts any shift when the column is NULL', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('A02'));
    const inGroup = await createShift(a, workdayShift('In Group', { ruleId: group.id }));
    const outside = await createShift(a, workdayShift('Outside'));

    const emp = await makeEmp();
    // No group ⇒ a shift that belongs to a group the employee is not in is still perfectly assignable.
    await assignDefaultShift(a, { employmentId: emp, shiftId: outside.id });
    await assignShift(a, { employmentId: emp, shiftDate: WED, shiftId: inGroup.id });
    expect((await rosterRows(emp)).map((r) => r.shiftId)).toEqual([inGroup.id]);
  });
});

describe('870b79e2 — all four writers refuse a shift the group does not allow', () => {
  /** One group allowing exactly one shift, one employee in it, and one shift outside it. */
  async function scenario() {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('A02'));
    const allowed = await createShift(a, workdayShift('Morning', { ruleId: group.id }));
    const forbidden = await createShift(a, workdayShift('Night'));
    const emp = await makeEmp();
    await setGroup(emp, group.id);
    return { a, group, allowed, forbidden, emp };
  }

  it('1 — the profile backup shift (assignEmployeeShift), and the message names the allowed shifts', async () => {
    const { a, allowed, forbidden, emp } = await scenario();
    await assignDefaultShift(a, { employmentId: emp, shiftId: allowed.id }); // the allowed one goes through
    await expect(assignDefaultShift(a, { employmentId: emp, shiftId: forbidden.id })).rejects.toThrow(
      ShiftNotInScheduleGroupError,
    );
    // The refusal is an INSTRUCTION or it is noise: it must name the group, the shift refused, and what
    // the group does allow. Asserted on the text because the text is the deliverable.
    await expect(assignDefaultShift(a, { employmentId: emp, shiftId: forbidden.id })).rejects.toThrow(/“Night”/);
    await expect(assignDefaultShift(a, { employmentId: emp, shiftId: forbidden.id })).rejects.toThrow(/“A02”/);
    await expect(assignDefaultShift(a, { employmentId: emp, shiftId: forbidden.id })).rejects.toThrow(/allows: Morning\./);
    // …and the refused write did not happen.
    const [row] = await owner.db
      .select({ shiftId: schema.employment.defaultShiftId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    expect(row.shiftId).toBe(allowed.id);
  });

  it('2 — the per-date roster brush (assignShift)', async () => {
    const { a, allowed, forbidden, emp } = await scenario();
    await assignShift(a, { employmentId: emp, shiftDate: WED, shiftId: allowed.id });
    await expect(assignShift(a, { employmentId: emp, shiftDate: WED, shiftId: forbidden.id })).rejects.toThrow(
      ShiftNotInScheduleGroupError,
    );
    // The upsert did not overwrite the good row.
    expect((await rosterRows(emp)).map((r) => r.shiftId)).toEqual([allowed.id]);
  });

  it('3 — roster generation (assignShiftBulk) fails WHOLE, not half', async () => {
    const { a, group, allowed, forbidden, emp } = await scenario();
    const free = await makeEmp(); // no group — would otherwise have been written
    expect(group.id).toBeTruthy();

    await expect(
      assignShiftBulk(a, { employmentIds: [free, emp], shiftDates: [WED, NEXT_WED], shiftId: forbidden.id }),
    ).rejects.toThrow(ShiftNotInScheduleGroupError);
    // ⚠️ The check runs BEFORE the insert, so the ungrouped employee in the same batch got nothing either.
    // A half-written roster is the outcome worth pinning: it is what a per-row check would have produced.
    expect(await rosterRows(free)).toEqual([]);
    expect(await rosterRows(emp)).toEqual([]);

    // The allowed shift writes the whole batch.
    const ok = await assignShiftBulk(a, { employmentIds: [free, emp], shiftDates: [WED, NEXT_WED], shiftId: allowed.id });
    expect(ok.assigned).toBe(4);
  });

  it('4 — the dated arrangement ladder (assignEmployeeShiftDated)', async () => {
    const { a, allowed, forbidden, emp } = await scenario();
    await assignEmployeeShiftDated(a, { employmentId: emp, shiftType: 'fixed', shiftId: allowed.id, effectiveFrom: WED });
    await expect(
      assignEmployeeShiftDated(a, { employmentId: emp, shiftType: 'fixed', shiftId: forbidden.id, effectiveFrom: NEXT_WED }),
    ).rejects.toThrow(ShiftNotInScheduleGroupError);
    const ladder = await owner.db
      .select({ shiftId: schema.employmentShiftArrangement.shiftId })
      .from(schema.employmentShiftArrangement)
      .where(eq(schema.employmentShiftArrangement.employmentId, emp))
      .orderBy(schema.employmentShiftArrangement.validFrom);
    expect(ladder.map((r) => r.shiftId)).toEqual([allowed.id]);
  });

  it('5 — copyRoster, the path whose rows nobody re-examines', async () => {
    const { a, allowed, forbidden, emp } = await scenario();
    // Rostered onto the forbidden shift BEFORE the group existed for them…
    await setGroup(emp, null);
    await assignShift(a, { employmentId: emp, shiftDate: WED, shiftId: forbidden.id });
    // …then put in the group. Copying that week forward must not smuggle the old shift into the future.
    const [group] = await owner.db
      .select({ id: schema.attendanceRule.id })
      .from(schema.attendanceRule)
      .where(eq(schema.attendanceRule.name, 'A02'));
    await setGroup(emp, group.id);
    await expect(
      copyRoster(a, { sourceFrom: WED, sourceTo: WED, targetFrom: NEXT_WED, employmentIds: [emp] }),
    ).rejects.toThrow(ShiftNotInScheduleGroupError);
    expect((await rosterRows(emp)).map((r) => r.shiftDate)).toEqual([WED]);
    expect(allowed.id).toBeTruthy();
  });

  it('a group that allows NO shift refuses everything, and says so rather than allowing everything', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const empty = await createAttendanceRule(a, ruleInput('Empty Group'));
    const anyShift = await createShift(a, workdayShift('Any'));
    const emp = await makeEmp();
    await setGroup(emp, empty.id);
    // The permissive reading ("no list means no restriction") would silently defeat the whole guard on
    // exactly the misconfiguration it exists to catch, so the refusal is explicit and names the fix.
    await expect(assignDefaultShift(a, { employmentId: emp, shiftId: anyShift.id })).rejects.toThrow(
      /does not allow any shift yet/,
    );
  });
});

describe('870b79e2 — setRuleShifts is the editor that decides what the refusal allows', () => {
  it('ticking attaches, unticking detaches to NO group — never to a group it is not listed under', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const groupA = await createAttendanceRule(a, ruleInput('A'));
    const groupB = await createAttendanceRule(a, ruleInput('B'));
    const s1 = await createShift(a, workdayShift('One'));
    const s2 = await createShift(a, workdayShift('Two', { ruleId: groupB.id }));

    // Attach both to A — s2 MOVES out of B, because a shift belongs to exactly one group.
    const moved = await setRuleShifts(a, { ruleId: groupA.id, shiftIds: [s1.id, s2.id] });
    expect(moved).toEqual({ attached: 2, detached: 0 });
    const after = await owner.db
      .select({ id: schema.shift.id, ruleId: schema.shift.ruleId })
      .from(schema.shift)
      .orderBy(schema.shift.name);
    expect(after.find((r) => r.id === s1.id)?.ruleId).toBe(groupA.id);
    expect(after.find((r) => r.id === s2.id)?.ruleId).toBe(groupA.id);

    // Untick s1 — it goes to NULL (⇒ the tenant Standard), not to B and not left pointing at A.
    const back = await setRuleShifts(a, { ruleId: groupA.id, shiftIds: [s2.id] });
    expect(back).toEqual({ attached: 0, detached: 1 });
    const [s1row] = await owner.db
      .select({ ruleId: schema.shift.ruleId })
      .from(schema.shift)
      .where(eq(schema.shift.id, s1.id));
    expect(s1row.ruleId).toBeNull();

    // Idempotent: saving the same selection twice writes nothing.
    expect(await setRuleShifts(a, { ruleId: groupA.id, shiftIds: [s2.id] })).toEqual({ attached: 0, detached: 0 });
  });

  it('what the editor writes is exactly what the refusal then allows', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('A02'));
    const shift = await createShift(a, workdayShift('Morning'));
    const emp = await makeEmp();
    await setGroup(emp, group.id);

    // Not yet in the group's list ⇒ refused…
    await expect(assignDefaultShift(a, { employmentId: emp, shiftId: shift.id })).rejects.toThrow(
      ShiftNotInScheduleGroupError,
    );
    // …add it from the group's side and the SAME assignment goes through. This pairing is what makes the
    // refusal above non-vacuous: it is the list that changed, not the shift and not the employee.
    await setRuleShifts(a, { ruleId: group.id, shiftIds: [shift.id] });
    await assignDefaultShift(a, { employmentId: emp, shiftId: shift.id });
    const [row] = await owner.db
      .select({ shiftId: schema.employment.defaultShiftId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    expect(row.shiftId).toBe(shift.id);
  });
});
