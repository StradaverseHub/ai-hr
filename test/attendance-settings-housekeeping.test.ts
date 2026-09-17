/**
 * ad52212d ROUND 2 — the housekeeping actions on the Attendance settings lists.
 *
 * The item asks for Duplicate, Activate/Deactivate and a delete that REFUSES while something is still using
 * the record, "with a message naming what is using it", across the three settings categories. Round 2's
 * honest scope, measured against the code rather than against the request:
 *
 *   • SHIFT — already built, and not rebuilt here. core/roster.ts has copyShift (cf21e554), archiveShift /
 *     unarchiveShift (the reporter's activate/deactivate) and deleteShift's ShiftInUseError (R17 3e8350db,
 *     widened by 18504ca6). The source-shape case at the bottom of this file PINS that, because "it already
 *     exists" is a claim a later reader must be able to check without taking this comment's word for it.
 *   • OVERTIME PATTERN — the gap, and what the rest of this file covers. attendance_rule had a `status`
 *     column editable only by opening the whole edit form, no duplicate at all, and a refusal that said
 *     "one or more shifts" without saying which.
 *   • WORK SCHEDULE — deliberately NOT here. There is no Work Schedule LIST to duplicate or activate
 *     against: /admin/attendance-policy/schedule is one form per company (attendance_policy, unique on
 *     company_id), so "draft vs active" is a status column that does not exist. That is round 3, which the
 *     approved plan says needs a migration; inventing one here is how a number reaches production out of
 *     order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createShift } from '../core/roster';
import { todayInKualaLumpur } from '../lib/hr-date';
import { actionOf } from '../lib/audit-format';
import {
  AttendanceRuleInUseError,
  copyAttendanceRule,
  createAttendanceRule,
  deleteAttendanceRule,
  getAttendanceRule,
  listAttendanceRules,
  setAttendanceRuleStatus,
  type AttendanceRuleInput,
} from '../core/attendance-rule';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

let b: Base;

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

/** A complete rule input — every field the service requires, so each case overrides only what it is about. */
const ruleInput = (over: Partial<AttendanceRuleInput> = {}): AttendanceRuleInput => ({
  name: `R_${randomUUID().slice(0, 8)}`,
  description: null,
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

const shiftOn = (ruleId: string, name: string) => ({
  companyId: b.companyId,
  name,
  code: `C_${randomUUID().slice(0, 6)}`,
  startTime: '09:00:00',
  endTime: '18:00:00',
  breakMinutes: 60,
  weeklyPattern: [1, 2, 3, 4, 5],
  ruleId,
});

describe('ad52212d round 2 — Duplicate an overtime pattern', () => {
  it('copies every setting AND every overtime band, under a free name', async () => {
    const a = adminCtx(b);
    const src = await createAttendanceRule(
      a,
      ruleInput({
        name: 'Night OT',
        description: 'Nights',
        lateGracePeriodMinutes: 7,
        lateAfterMinutes: 15,
        lateDeductMinutes: 30,
        includeGraceInLateness: true,
        applyToEarlyOt: true,
        otRows: [
          { fromMinutes: 0, toMinutes: 120, ratePattern: 'flat', rate: 1.5, phRate: 3, roundingMode: 'down', roundToMinutes: 15 },
          { fromMinutes: 121, toMinutes: 0, ratePattern: 'flat', rate: 2, phRate: null, roundingMode: 'none', roundToMinutes: null },
        ],
      }),
    );

    const copy = await copyAttendanceRule(a, { ruleId: src.id });
    const made = (await getAttendanceRule(a, copy.id))!;

    expect(made.name).toBe('Night OT (copy)');
    expect(made.isDefault, 'a duplicate is never a second Standard').toBe(false);
    // The settings that make it the same pattern.
    expect({
      description: made.description,
      lateGracePeriodMinutes: made.lateGracePeriodMinutes,
      lateAfterMinutes: made.lateAfterMinutes,
      lateDeductMinutes: made.lateDeductMinutes,
      includeGraceInLateness: made.includeGraceInLateness,
      applyToEarlyOt: made.applyToEarlyOt,
    }).toEqual({
      description: 'Nights',
      lateGracePeriodMinutes: 7,
      lateAfterMinutes: 15,
      lateDeductMinutes: 30,
      includeGraceInLateness: true,
      applyToEarlyOt: true,
    });
    // THE BANDS ARE THE PATTERN. A copy that silently lost them would be worse than no copy at all.
    expect(
      made.otRows.map((r) => ({
        fromMinutes: r.fromMinutes,
        toMinutes: r.toMinutes,
        rate: r.rate,
        phRate: r.phRate,
        roundingMode: r.roundingMode,
        roundToMinutes: r.roundToMinutes,
      })),
    ).toEqual([
      { fromMinutes: 0, toMinutes: 120, rate: '1.50', phRate: '3.00', roundingMode: 'down', roundToMinutes: 15 },
      { fromMinutes: 121, toMinutes: 0, rate: '2.00', phRate: null, roundingMode: 'none', roundToMinutes: null },
    ]);
    expect(await eventTypesFor(b.tenantId, copy.id)).toContain('attendance-rule.copied');
  });

  it('duplicating twice yields (copy) then (copy 2) — never a dead end on the second click', async () => {
    const a = adminCtx(b);
    const src = await createAttendanceRule(a, ruleInput({ name: 'Standard OT' }));
    await copyAttendanceRule(a, { ruleId: src.id });
    const second = await copyAttendanceRule(a, { ruleId: src.id });
    expect((await getAttendanceRule(a, second.id))!.name).toBe('Standard OT (copy 2)');
    // attendance_rule_tenant_name_uq is case-insensitive and tenant-wide, so all three had to be distinct
    // for either insert to land at all.
    const names = (await listAttendanceRules(a)).map((r) => r.name);
    expect(names).toContain('Standard OT (copy)');
    expect(names).toContain('Standard OT (copy 2)');
  });

  it('lands ACTIVE from an inactive source — you duplicate a pattern in order to use it', async () => {
    const a = adminCtx(b);
    const src = await createAttendanceRule(a, ruleInput({ name: 'Retired OT', status: 'inactive' }));
    const copy = await copyAttendanceRule(a, { ruleId: src.id });
    expect((await getAttendanceRule(a, src.id))!.status, 'the source is untouched').toBe('inactive');
    expect((await getAttendanceRule(a, copy.id))!.status).toBe('active');
  });

  it('NEVER back-dates the copy’s deductions — the start date is stamped today, not inherited', async () => {
    // 7c834696's guarantee is that a wage deduction can never reach a payroll period that is already
    // closed, which is enforced by never taking the effective-from date from a caller. A duplicate that
    // carried the source's stored date would be exactly such a caller, one release later.
    const a = adminCtx(b);
    const src = await createAttendanceRule(a, ruleInput({ name: 'Deducting', applyDeductions: true }));
    // Force the SOURCE's start date into the past, the way a rule switched on months ago would look.
    await owner.db
      .update(schema.attendanceRule)
      .set({ deductionsEffectiveFrom: '2020-01-01' })
      .where(eq(schema.attendanceRule.id, src.id));

    const copy = await copyAttendanceRule(a, { ruleId: src.id });
    const made = (await getAttendanceRule(a, copy.id))!;
    expect(made.applyDeductions, 'the switch itself travels').toBe(true);
    expect(made.deductionsEffectiveFrom, 'but the date is re-stamped').toBe(todayInKualaLumpur());
  });
});

describe('ad52212d round 2 — Activate / Deactivate an overtime pattern', () => {
  it('flips the status from the list and appends the activated/deactivated PAIR', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(a, ruleInput({ name: 'Toggle me' }));
    await setAttendanceRuleStatus(a, { ruleId: rule.id, status: 'inactive' });
    expect((await getAttendanceRule(a, rule.id))!.status).toBe('inactive');
    await setAttendanceRuleStatus(a, { ruleId: rule.id, status: 'active' });
    expect((await getAttendanceRule(a, rule.id))!.status).toBe('active');
    const types = await eventTypesFor(b.tenantId, rule.id);
    expect(types).toEqual(expect.arrayContaining(['attendance-rule.deactivated', 'attendance-rule.activated']));
  });

  it('and those two names are the ones the Audit Trail’s Activate / Deactivate filter can find', async () => {
    // domain_event is APPEND-ONLY: a name that actionOf() cannot classify is a row that stays filed under
    // "Other" for the life of the tenant. This case is the reason the service does not emit one
    // `status-changed` — it pins the classification, not just the string.
    expect(actionOf('attendance-rule.activated')).toBe('unarchived');
    expect(actionOf('attendance-rule.deactivated')).toBe('archived');
    expect(actionOf('attendance-rule.status-changed'), 'the shape that was rejected').toBe('other');
  });

  it('touches ONLY the status — the bands and settings are not rewritten', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(
      a,
      ruleInput({
        name: 'Untouched',
        lateGracePeriodMinutes: 9,
        otRows: [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.75, phRate: null, roundingMode: 'none', roundToMinutes: null }],
      }),
    );
    await setAttendanceRuleStatus(a, { ruleId: rule.id, status: 'inactive' });
    const after = (await getAttendanceRule(a, rule.id))!;
    expect(after.lateGracePeriodMinutes).toBe(9);
    expect(after.otRows.map((r) => r.rate)).toEqual(['1.75']);
  });

  it('WHY IT IS NOT updateAttendanceRule: a legacy rule with a broken band ladder can still be switched off', async () => {
    // 7c834696 stage 1 added ladder validation on SAVE, and said so in as many words: a rule stored before
    // it that breaks the rule keeps calculating and is refused the next time someone EDITS it. Routing the
    // status toggle through the edit path would turn "switch this off" into that refusal — on precisely the
    // rules an administrator most wants to switch off.
    const a = adminCtx(b);
    const [legacy] = await owner.db
      .insert(schema.attendanceRule)
      .values({ tenantId: b.tenantId, name: 'Legacy gap', status: 'active' })
      .returning({ id: schema.attendanceRule.id });
    await owner.db.insert(schema.attendanceRuleOtRow).values([
      { tenantId: b.tenantId, ruleId: legacy.id, fromMinutes: 0, toMinutes: 60, rate: '1.50', sortOrder: 0 },
      // Starts at 120 rather than 61 — a hole the ladder validator refuses on save.
      { tenantId: b.tenantId, ruleId: legacy.id, fromMinutes: 120, toMinutes: 0, rate: '2.00', sortOrder: 1 },
    ]);

    await setAttendanceRuleStatus(a, { ruleId: legacy.id, status: 'inactive' });
    expect((await getAttendanceRule(a, legacy.id))!.status).toBe('inactive');
  });
});

describe('ad52212d round 2 — deleting an overtime pattern NAMES what is using it', () => {
  it('refuses, and the message says which shifts', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(a, ruleInput({ name: 'Used OT' }));
    await createShift(a, shiftOn(rule.id, 'Morning A'));
    await createShift(a, shiftOn(rule.id, 'Night B'));

    const err = await deleteAttendanceRule(a, { ruleId: rule.id }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AttendanceRuleInUseError);
    // The whole point of the change: the administrator is told where to go, not merely that they cannot.
    expect((err as Error).message).toContain('Morning A');
    expect((err as Error).message).toContain('Night B');
    // …and it is still refused, which is what protects the assignment.
    expect((await getAttendanceRule(a, rule.id))!.name).toBe('Used OT');
  });

  it('lists three and counts the rest honestly, rather than "and 1 more" over any number', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(a, ruleInput({ name: 'Popular OT' }));
    for (const n of ['S1', 'S2', 'S3', 'S4', 'S5']) await createShift(a, shiftOn(rule.id, n));

    const err = (await deleteAttendanceRule(a, { ruleId: rule.id }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('S1, S2, S3');
    expect(err.message, 'five shifts ⇒ two unnamed, not one').toContain('and 2 more shifts');
  });

  it('deletes cleanly once nothing uses it', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(a, ruleInput({ name: 'Unused OT' }));
    await deleteAttendanceRule(a, { ruleId: rule.id });
    expect(await getAttendanceRule(a, rule.id)).toBeNull();
  });
});

describe('ad52212d round 2 — the list wiring (a contract that spans two files)', () => {
  // 6d091cc0 (r301) — the list MOVED from /admin/attendance-policy/page.tsx (a redirect stub now) to the Schedule
  // Group card on Attendance › Schedule › General. The contract followed it; nothing about it was relaxed.
  const PAGE = 'app/admin/attendance-policy/schedule-group-card.tsx';
  const ACTIONS = 'app/admin/attendance-policy/rule-actions.ts';

  it('the Overtime Pattern list offers Duplicate and an Activate/Deactivate toggle', () => {
    const src = read(PAGE);
    expect(src, 'Duplicate is wired to its action').toContain('copyAttendanceRuleAction');
    expect(src, 'the status toggle is wired to its action').toContain('setAttendanceRuleStatusAction');
    expect(src, 'the toggle is labelled from the catalogue, both ways').toContain("tr('deactivate')");
    expect(src).toContain("tr('activate')");
    expect(src, 'Duplicate is labelled from the catalogue').toContain("tr('duplicate')");
  });

  it('THE TRAP: the toggle posts its target status as a VALUE, and the action reads it as one', () => {
    // Trap 17, and this form has been bitten by it before (7c834696's "Apply to Early Overtime" saved ON
    // every time because a hidden input is submitted whatever it says). A presence check here would make
    // every one of these buttons a deactivate button. The defect would live in the CONTRACT between the two
    // files, so it is pinned across both — a unit test of either half passes throughout.
    const page = read(PAGE);
    expect(page, 'the hidden field carries the TARGET status, not the current one').toContain(
      `value={r.status === 'active' ? 'inactive' : 'active'}`,
    );
    const actions = read(ACTIONS);
    expect(actions, 'the action reads the value').toContain(
      `status: fd.get('status') === 'inactive' ? 'inactive' : 'active'`,
    );
    expect(actions, 'and never its presence').not.toMatch(/fd\.get\('status'\)\s*!=\s*null/);
  });

  it('Duplicate lands on the copy’s own edit form, like the shift library next door', () => {
    // The reason to duplicate is to change the two or three bands that differ; the list would make the
    // operator hunt for the row they just created.
    // r301 — the copy's edit form is its editor PANEL on the Schedule General tab (`?editGroup=<copy id>`), and
    // the panel address is built in one place. test/r301-schedule-general.test.ts runs the action and opens it.
    expect(read(ACTIONS)).toContain('redirect(groupEditorPath(copied.id))');
    expect(read('app/admin/attendance-policy/schedule-panel.ts')).toContain(
      'export const groupEditorPath = (ruleId: string) => `${SCHEDULE}?editGroup=${encodeURIComponent(ruleId)}`;',
    );
  });

  it('ALREADY BUILT, NOT REBUILT: the Shift list already has all four actions', () => {
    // Round 2 asks for these "across the three lists". This case is the evidence for the claim in this
    // file's header that the Shift half needed nothing — so a later reader can check it instead of
    // trusting it, and so deleting any of them registers as a regression here.
    const shiftPage = read('app/admin/attendance/page.tsx');
    for (const action of ['copyShiftAction', 'archiveShiftAction', 'unarchiveShiftAction', 'deleteShiftAction']) {
      expect(shiftPage, `the shift list wires ${action}`).toContain(action);
    }
    const roster = read('core/roster.ts');
    expect(roster, 'and the refusal names the KIND of thing holding the shift').toContain('ShiftInUseError');
    expect(roster).toContain('roster entries, assigned as an employee default, or recorded in employee shift history');
  });
});
