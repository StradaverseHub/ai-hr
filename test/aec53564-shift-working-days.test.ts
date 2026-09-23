/**
 * aec53564 (r331) — THE WORKING DAYS ARE EDITABLE ON THE SHIFT FORM EXACTLY WHEN NOTHING ELSE IS DECIDING
 * THEM, and this file is the WRITE half of that sentence.
 *
 * The screen greys the seven day dropdowns when the shift's Schedule Group states a working week
 * (components/shift-time-fields.tsx, rendered in test/aec53564-shift-working-days.dom.test.tsx). A greyed
 * control is not a refusal: a disabled <select> simply submits nothing, so a stale tab, a form re-submitted
 * from history, the LEGACY `weeklyPattern` checkbox name that shift-actions.ts still decodes, or a
 * hand-made POST all still carry day fields. Before this round they were written — into three columns that
 * nothing reads, because every reader resolves the group first (core/week-pattern.ts `weekPatternFor`).
 *
 * ⚠️ AND THE OTHER HALF, WHICH IS WHY "IGNORE THE POST" IS NOT SPELLED "WRITE NOTHING". core/roster.ts
 * updateShift is a FULL-ROW OVERWRITE for weekly_pattern / half_pattern / off_pattern, so passing the empty
 * decode would CLEAR the shift's own week. That week is the FALLBACK: a group whose pattern is emptied
 * stops winning immediately and the shift's row is the only value left (measured on production 2026-09-23:
 * 2 of 8 shifts are living on it today). Every ignore case below therefore asserts the stored week is still
 * there afterwards, byte for byte — not merely that the posted one was not taken.
 *
 * Each refusal is paired with a POSITIVE CONTROL on the same shape of POST, so none of them can pass
 * because the decode broke.
 */
import { randomUUID } from 'node:crypto';
import { scheduleGroupSectionHref } from '../app/admin/attendance/schedule/sections';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  createAttendanceRule,
  ensureStandardRule,
  updateAttendanceRule,
  type AttendanceRuleInput,
} from '../core/attendance-rule';
import { createShift, listShiftsForTenant } from '../core/roster';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// The actions call getSession() (a request the harness has no equivalent of) — hand back the seeded admin
// ctx so their writes still run under RLS. Precedent: test/personnel-schedule-group-assignment.test.ts.
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/session', () => ({ getSession: async () => ADMIN }));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));

import { createShiftAction, updateShiftAction } from '../app/admin/attendance/shift-actions';

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

/** A shift whose own week is Mon–Wed, so any change to it is visible in one array. */
const shiftInput = (over: Record<string, unknown> = {}) => ({
  name: `S_${randomUUID().slice(0, 6)}`,
  code: `C_${randomUUID().slice(0, 6)}`,
  startTime: '09:00:00',
  endTime: '18:00:00',
  breakMinutes: 60,
  weeklyPattern: [1, 2, 3],
  halfPattern: [4],
  offPattern: [5],
  ...over,
});

/** The three stored arrays, read as the OWNER so RLS cannot answer 0 rows and look like a pass. */
const storedWeek = async (shiftId: string) => {
  const [row] = await owner.db
    .select({
      weeklyPattern: schema.shift.weeklyPattern,
      halfPattern: schema.shift.halfPattern,
      offPattern: schema.shift.offPattern,
      ruleId: schema.shift.ruleId,
    })
    .from(schema.shift)
    .where(eq(schema.shift.id, shiftId));
  return row;
};

/**
 * A POST the way the form makes one: every field the action reads, so the assertions below are about the
 * WEEK and not about a half-filled form being refused for some other reason.
 */
function postFor(
  shift: { id: string; name: string; code: string | null },
  opts: { ruleId?: string; dayKinds?: Record<number, string>; legacyWeekly?: number[] },
): FormData {
  const fd = new FormData();
  fd.set('shiftId', shift.id);
  fd.set('name', shift.name);
  fd.set('code', shift.code ?? '');
  fd.set('startTime', '09:00');
  fd.set('endTime', '18:00');
  fd.set('breakMinutes', '60');
  fd.set('attendanceRuleId', opts.ruleId ?? '');
  if (opts.dayKinds) for (const [d, k] of Object.entries(opts.dayKinds)) fd.set(`dayKind_${d}`, k);
  if (opts.legacyWeekly) for (const d of opts.legacyWeekly) fd.append('weeklyPattern', String(d));
  return fd;
}

/** Mon–Sat full, Sun rest — a week that is different from every fixture's, in all three arrays. */
const SIX_DAY: Record<number, string> = { 1: 'full', 2: 'full', 3: 'full', 4: 'full', 5: 'full', 6: 'full', 7: 'rest' };

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

// ── (b) NOTHING IS DECIDING ⇒ THE DAYS ARE STILL WHAT DECIDES, AND THEY ARE STORED ────────────────────
describe('(b) no Schedule Group states a week — the posted days ARE written', () => {
  it('a shift with no rule at all: the post lands', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a); // 0483 leaves its three arrays NULL on purpose — it must not win.
    const sh = await createShift(a, shiftInput());
    const row = (await listShiftsForTenant(a)).find((s) => s.id === sh.id)!;

    await expect(updateShiftAction(postFor(row, { dayKinds: SIX_DAY }))).rejects.toThrow('NEXT_REDIRECT');
    const after = await storedWeek(sh.id);
    expect(after.weeklyPattern, 'the operator edited the week and it is theirs to edit').toEqual([1, 2, 3, 4, 5, 6]);
    expect(after.halfPattern).toEqual([]);
    expect(after.offPattern).toEqual([]);
  });

  it('a shift IN a group that states no week: the group exists, and still the post lands', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    // A real Schedule Group with grace and overtime settings but NO working week — the shape every rule
    // written before migration 0483 has. It must not lock the row merely by existing.
    const weekless = await createAttendanceRule(a, ruleInput('A02 no week'));
    const sh = await createShift(a, shiftInput({ ruleId: weekless.id }));
    const row = (await listShiftsForTenant(a)).find((s) => s.id === sh.id)!;

    await expect(
      updateShiftAction(postFor(row, { ruleId: weekless.id, dayKinds: SIX_DAY })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect((await storedWeek(sh.id)).weeklyPattern).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ── (a) A GROUP STATES A WEEK ⇒ THE POSTED DAYS ARE IGNORED, AND THE STORED WEEK SURVIVES ─────────────
describe('(a) the Schedule Group states a week — the posted days are ignored', () => {
  it('the post is discarded and every one of the three arrays is left exactly as stored', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(
      a,
      ruleInput('Standard 5 Day', { weeklyPattern: [1, 2, 3, 4, 5], halfPattern: [], offPattern: [6] }),
    );
    const sh = await createShift(a, shiftInput({ ruleId: group.id }));
    const before = await storedWeek(sh.id);
    const row = (await listShiftsForTenant(a)).find((s) => s.id === sh.id)!;

    await expect(updateShiftAction(postFor(row, { ruleId: group.id, dayKinds: SIX_DAY }))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    const after = await storedWeek(sh.id);
    expect(after.weeklyPattern, 'the posted week is NOT written').toEqual(before.weeklyPattern);
    expect(after.halfPattern, 'and the half-day list is not quietly emptied either').toEqual(before.halfPattern);
    expect(after.offPattern).toEqual(before.offPattern);
    expect(after.weeklyPattern, 'the shift keeps its own fallback week — this is the value 2 live shifts run on').toEqual([1, 2, 3]);
    expect(after.halfPattern).toEqual([4]);
    expect(after.offPattern).toEqual([5]);
    // The rest of the save is untouched: this is an ignored FIELD, not a refused form.
    expect(LAST_REDIRECT, 'the save still succeeds').toBe('/admin/attendance');
  });

  it('it is the GROUP that decides, not the field being absent: empty the group and the same post lands', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('Standard 5 Day', { weeklyPattern: [1, 2, 3, 4, 5] }));
    const sh = await createShift(a, shiftInput({ ruleId: group.id }));
    const row = (await listShiftsForTenant(a)).find((s) => s.id === sh.id)!;

    await expect(updateShiftAction(postFor(row, { ruleId: group.id, dayKinds: SIX_DAY }))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect((await storedWeek(sh.id)).weeklyPattern, 'ignored while the group states a week').toEqual([1, 2, 3]);

    // Take the week off the group. Nothing else changes — not the shift, not the post.
    await updateAttendanceRule(a, {
      ruleId: group.id,
      ...ruleInput('Standard 5 Day', { weeklyPattern: [], halfPattern: [], offPattern: [] }),
    });
    await expect(updateShiftAction(postFor(row, { ruleId: group.id, dayKinds: SIX_DAY }))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(
      (await storedWeek(sh.id)).weeklyPattern,
      'the group stopped deciding, so the shift decides again — and the fallback it falls back to is the week that was preserved',
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('BLANK on the dropdown is the tenant Standard rule, and it is judged by the same rule', async () => {
    const a = adminCtx(b);
    const standard = await ensureStandardRule(a);
    const sh = await createShift(a, shiftInput());
    const row = (await listShiftsForTenant(a)).find((s) => s.id === sh.id)!;

    // Migration 0483 leaves Standard's three arrays NULL ON PURPOSE, because every shift with no rule_id
    // resolves it — so with a blank dropdown the shift is still what decides.
    await expect(updateShiftAction(postFor(row, { dayKinds: SIX_DAY }))).rejects.toThrow('NEXT_REDIRECT');
    expect((await storedWeek(sh.id)).weeklyPattern).toEqual([1, 2, 3, 4, 5, 6]);

    // Give Standard a week and the SAME blank post stops being written — proving the blank option really
    // resolves to Standard rather than to "no group", which is what core/attendance-rule.ts resolveRuleTx
    // does on every read.
    await updateAttendanceRule(a, {
      ruleId: standard.id,
      ...ruleInput('Standard', { weeklyPattern: [1, 2, 3, 4, 5] }),
    });
    await expect(
      updateShiftAction(postFor(row, { dayKinds: { 1: 'rest', 2: 'rest', 3: 'rest', 4: 'rest', 5: 'rest', 6: 'rest', 7: 'rest' } })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect((await storedWeek(sh.id)).weeklyPattern, 'unchanged from the previous save').toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ── (d) THE LEGACY FIELD NAME IS NOT A WAY ROUND IT ───────────────────────────────────────────────────
describe('(d) the legacy `weeklyPattern` field name is ignored on the same terms', () => {
  it('a legacy post is discarded when the group decides, and STILL WORKS when it does not', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('Standard 5 Day', { weeklyPattern: [1, 2, 3, 4, 5] }));
    const grouped = await createShift(a, shiftInput({ ruleId: group.id }));
    const ungrouped = await createShift(a, shiftInput());
    const rows = await listShiftsForTenant(a);

    // No dayKind_* fields at all — the exact shape shift-actions.ts falls back to for older callers.
    await expect(
      updateShiftAction(postFor(rows.find((s) => s.id === grouped.id)!, { ruleId: group.id, legacyWeekly: [6, 7] })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(
      (await storedWeek(grouped.id)).weeklyPattern,
      'the old field name reaches the database on exactly the same terms as the new one',
    ).toEqual([1, 2, 3]);

    // The positive control, and it is the one that makes the assertion above mean something: the legacy
    // decode is alive and writes when nothing is deciding.
    await expect(
      updateShiftAction(postFor(rows.find((s) => s.id === ungrouped.id)!, { legacyWeekly: [6, 7] })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect((await storedWeek(ungrouped.id)).weeklyPattern, 'the legacy path still writes').toEqual([6, 7]);
  });
});

// ── CREATE — the same rule, and the one place it cannot preserve anything ─────────────────────────────
describe('create: a NEW shift under a week-setting group declares no week of its own', () => {
  it('stores no week rather than the posted one, and the group still decides', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const group = await createAttendanceRule(a, ruleInput('Standard 5 Day', { weeklyPattern: [1, 2, 3, 4, 5] }));

    const fd = new FormData();
    fd.set('name', 'Brand New');
    fd.set('code', `C_${randomUUID().slice(0, 6)}`);
    fd.set('startTime', '09:00');
    fd.set('endTime', '18:00');
    fd.set('breakMinutes', '60');
    fd.set('attendanceRuleId', group.id);
    for (const [d, k] of Object.entries(SIX_DAY)) fd.set(`dayKind_${d}`, k);
    await expect(createShiftAction(fd)).rejects.toThrow('NEXT_REDIRECT');

    const created = (await listShiftsForTenant(a)).find((s) => s.name === 'Brand New')!;
    const week = await storedWeek(created.id);
    expect(week.ruleId, 'the group was still stored — only the days were ignored').toBe(group.id);
    expect(week.weeklyPattern, 'no week was invented for a shift that was never asked for one').toBeNull();
    expect(week.halfPattern).toEqual([]);
    expect(week.offPattern).toEqual([]);
  });

  it('…and the SAME create with no week-setting group stores the posted week', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const fd = new FormData();
    fd.set('name', 'Brand New Free');
    fd.set('code', `C_${randomUUID().slice(0, 6)}`);
    fd.set('startTime', '09:00');
    fd.set('endTime', '18:00');
    fd.set('breakMinutes', '60');
    for (const [d, k] of Object.entries(SIX_DAY)) fd.set(`dayKind_${d}`, k);
    await expect(createShiftAction(fd)).rejects.toThrow('NEXT_REDIRECT');

    const created = (await listShiftsForTenant(a)).find((s) => s.name === 'Brand New Free')!;
    expect((await storedWeek(created.id)).weeklyPattern).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

/**
 * aec53564 — THE LINK ITSELF, which until now nothing exercised.
 *
 * ⚠️ WHY THIS EXISTS. The DOM test asserts the rendered anchor's href, but it builds its fixture from a
 * STRING LITERAL (`test/aec53564-shift-working-days.dom.test.tsx`, the `href:` props). So the helper that
 * actually composes that URL on the server was covered by nothing: break
 * `scheduleGroupSectionHref` and every DOM case stays green, because the fixture never calls it.
 *
 * The shape is not cosmetic. `?section=` concatenated in FRONT of the query key is the r287 → r301 defect,
 * and r331 has now reproduced it twice more — once in 665de026's own mutation table. It is spelled once,
 * in `app/admin/attendance/schedule/sections.ts`, and this pins that spelling.
 */
describe('aec53564 · the Schedule Group link is built by the helper, not by hand', () => {
  const RULE = '0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

  it('rides the section as a query parameter AND as the fragment', () => {
    const href = scheduleGroupSectionHref(RULE, 'workingDay');
    expect(href, 'the query parameter').toContain('?section=workingDay');
    expect(href, 'and the fragment, because a fragment is never sent to the server').toContain('#section-workingDay');
  });

  it('never concatenates the section in front of the query key (r287 → r301)', () => {
    const href = scheduleGroupSectionHref(RULE, 'workingDay');
    // The defect spelling is `...?section=workingDay?toast=...` — a SECOND `?` rather than an `&`.
    expect(href.match(/\?/g) ?? [], 'exactly one "?" in the URL').toHaveLength(1);
    expect(href, 'the path ends at the rule id, not at a query fragment').not.toMatch(/\/[^/?#]*\?[^/?#]*\//);
  });

  it('points at the VIEW page, not the editor', () => {
    const href = scheduleGroupSectionHref(RULE, 'workingDay');
    expect(href.startsWith(`/admin/attendance/schedule/${RULE}?`), href).toBe(true);
    expect(href, 'a link beside a control you cannot change must not open an editor').not.toContain('/edit');
  });

  it('is what the rendered anchor uses — the DOM fixture and the helper agree', () => {
    // The literal the DOM test hard-codes for the grouped shift, rebuilt through the helper. If these
    // ever diverge the DOM test is asserting a URL the product does not produce.
    expect(scheduleGroupSectionHref('grp-0000-0000-0000-000000000001', 'workingDay')).toBe(
      '/admin/attendance/schedule/grp-0000-0000-0000-000000000001?section=workingDay#section-workingDay',
    );
  });
});
