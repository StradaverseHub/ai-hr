/**
 * aec53564 (r331) → r429 (f6819e19) · D1 — THE SHIFT FORM NO LONGER EDITS THE WEEK AT ALL.
 *
 * REWRITTEN for r429. The r331 item made the Mon–Sun row editable "exactly when nothing else is
 * deciding" — greyed when the Schedule Group states a week, live otherwise. r429 retires the row from the
 * Shift page entirely (D1 of the approved plan): which days are worked is now set ONLY on the Schedule
 * Group's own "Working Days" section. So the write-side question this file pinned — "which of the posted
 * day fields counts?" — no longer has an answer to test, because the form never posts one.
 *
 * What replaces it: core/roster.ts normalizeShiftInput now treats weeklyPattern / halfPattern / offPattern
 * as UNDEFINED-MEANS-PRESERVE (the same contract otRule / ruleId already used), and
 * app/admin/attendance/shift-actions.ts never sets any of the three keys at all — so every save through the
 * real action preserves whatever the shift already had. This file pins exactly that, end to end through
 * `updateShiftAction` / `createShiftAction`, plus the direct-service contract both actions rely on.
 */
import { randomUUID } from 'node:crypto';
import { scheduleGroupSectionHref } from '../app/admin/attendance/schedule/sections';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createShift, updateShift, type ShiftInput } from '../core/roster';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

/** A shift whose own week is Mon–Wed, so any change to it is visible in one array. */
const shiftInput = (over: Partial<ShiftInput> = {}): ShiftInput => ({
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

/** A POST the way the REAL form makes one now: no day field, no `attendanceRuleId` — the two controls
 *  D1/D2 retired. Every other field shiftFields() reads is present, so a failure here is about the week
 *  or the group, not about an unrelated refusal. */
function postFor(shift: { id: string; name: string; code: string | null }): FormData {
  const fd = new FormData();
  fd.set('shiftId', shift.id);
  fd.set('name', shift.name);
  fd.set('code', shift.code ?? '');
  fd.set('startTime', '09:00');
  fd.set('endTime', '18:00');
  fd.set('breakMinutes', '60');
  return fd;
}

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

describe('D1 — updateShiftAction never posts a day field, so every save PRESERVES the stored week', () => {
  it('end to end through the real action: the week survives a save that changes an unrelated field', async () => {
    const a = adminCtx(b);
    const sh = await createShift(a, shiftInput());
    const row = (await owner.db.select().from(schema.shift).where(eq(schema.shift.id, sh.id)))[0];
    const fd = postFor({ id: sh.id, name: row.name, code: row.code });
    fd.set('description', 'changed the description, nothing else');

    await expect(updateShiftAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    const after = await storedWeek(sh.id);
    expect(after.weeklyPattern, 'the shift form never posts a day field any more — the week is preserved').toEqual([1, 2, 3]);
    expect(after.halfPattern).toEqual([4]);
    expect(after.offPattern).toEqual([5]);
    expect(LAST_REDIRECT, 'the save still succeeds').toBe('/admin/attendance');
    const [stored] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, sh.id));
    expect(stored.description).toBe('changed the description, nothing else');
  });

  it('the group is preserved too — the action never posts `attendanceRuleId` any more (D2)', async () => {
    const a = adminCtx(b);
    const sh = await createShift(a, shiftInput({ ruleId: null }));
    await owner.db.update(schema.shift).set({ ruleId: null }).where(eq(schema.shift.id, sh.id));
    const row = (await owner.db.select().from(schema.shift).where(eq(schema.shift.id, sh.id)))[0];

    await expect(updateShiftAction(postFor({ id: sh.id, name: row.name, code: row.code }))).rejects.toThrow('NEXT_REDIRECT');
    expect((await storedWeek(sh.id)).ruleId, 'ruleId is not posted, so it is preserved (null stays null)').toBeNull();
  });
});

describe('D1 — create stores NO week of its own, even when the week fields are simply absent', () => {
  it('createShiftAction never posts a day field either, so a new shift declares no week', async () => {
    const a = adminCtx(b);
    const fd = new FormData();
    fd.set('name', 'Brand New');
    fd.set('code', `C_${randomUUID().slice(0, 6)}`);
    fd.set('startTime', '09:00');
    fd.set('endTime', '18:00');
    fd.set('breakMinutes', '60');
    await expect(createShiftAction(fd)).rejects.toThrow('NEXT_REDIRECT');

    const [created] = await owner.db.select().from(schema.shift).where(eq(schema.shift.name, 'Brand New'));
    expect(created.weeklyPattern, 'no week was invented for a shift the form never asked one of').toBeNull();
    expect(created.halfPattern).toEqual([]);
    expect(created.offPattern).toEqual([]);
    expect(created.ruleId, 'no group was invented either — a blank picker always meant Standard').toBeNull();
  });
});

describe('D1/D2/D4 — the SERVICE contract every caller (the form, a script, a test) now relies on', () => {
  it('createShift: omitting weeklyPattern/halfPattern/offPattern stores NO_WEEK (null/[]/[])', async () => {
    const a = adminCtx(b);
    const sh = await createShift(a, { name: `NW_${randomUUID().slice(0, 6)}`, code: `NW_${randomUUID().slice(0, 6)}`, startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60 });
    const row = await storedWeek(sh.id);
    expect(row.weeklyPattern).toBeNull();
    expect(row.halfPattern).toEqual([]);
    expect(row.offPattern).toEqual([]);
  });

  it('updateShift: omitting all three preserves the stored week byte for byte', async () => {
    const a = adminCtx(b);
    const sh = await createShift(a, shiftInput());
    const row = (await owner.db.select().from(schema.shift).where(eq(schema.shift.id, sh.id)))[0];
    await updateShift(a, {
      shiftId: sh.id,
      name: row.name,
      code: row.code!,
      startTime: row.startTime,
      endTime: row.endTime,
      breakMinutes: row.breakMinutes,
      // weeklyPattern / halfPattern / offPattern deliberately OMITTED.
    });
    const after = await storedWeek(sh.id);
    expect(after.weeklyPattern).toEqual([1, 2, 3]);
    expect(after.halfPattern).toEqual([4]);
    expect(after.offPattern).toEqual([5]);
  });

  it('updateShift: posting one of the three still validates and stores all three together', async () => {
    const a = adminCtx(b);
    const sh = await createShift(a, shiftInput());
    const row = (await owner.db.select().from(schema.shift).where(eq(schema.shift.id, sh.id)))[0];
    await updateShift(a, {
      shiftId: sh.id,
      name: row.name,
      code: row.code!,
      startTime: row.startTime,
      endTime: row.endTime,
      breakMinutes: row.breakMinutes,
      weeklyPattern: [6, 7], // explicit — halfPattern/offPattern absent ⇒ treated as empty, as before
    });
    const after = await storedWeek(sh.id);
    expect(after.weeklyPattern).toEqual([6, 7]);
    expect(after.halfPattern).toEqual([]);
    expect(after.offPattern).toEqual([]);
  });

  it('updateShift: omitting ruleId preserves the stored group (D2)', async () => {
    const a = adminCtx(b);
    const group = randomUUID();
    const sh = await createShift(a, shiftInput());
    // Stamp a ruleId directly (bypassing FK for the sake of a cheap id — use a real rule instead).
    const [rule] = await owner.db
      .insert(schema.attendanceRule)
      .values({ tenantId: b.tenantId, name: `G_${group.slice(0, 8)}`, isDefault: false, status: 'active' })
      .returning({ id: schema.attendanceRule.id });
    await owner.db.update(schema.shift).set({ ruleId: rule.id }).where(eq(schema.shift.id, sh.id));
    const row = (await owner.db.select().from(schema.shift).where(eq(schema.shift.id, sh.id)))[0];

    await updateShift(a, {
      shiftId: sh.id,
      name: row.name,
      code: row.code!,
      startTime: row.startTime,
      endTime: row.endTime,
      breakMinutes: row.breakMinutes,
      // ruleId OMITTED.
    });
    expect((await storedWeek(sh.id)).ruleId).toBe(rule.id);
  });
});

/**
 * aec53564 — THE LINK ITSELF, unchanged by r429: the Shift form's READ-ONLY Schedule Group line
 * (app/admin/attendance/shift-form.tsx) still links to the group's "Working Days" section with this exact
 * helper, so the shape pinned here is still what the product produces.
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
    expect(href.match(/\?/g) ?? [], 'exactly one "?" in the URL').toHaveLength(1);
    expect(href, 'the path ends at the rule id, not at a query fragment').not.toMatch(/\/[^/?#]*\?[^/?#]*\//);
  });

  it('points at the VIEW page, not the editor', () => {
    const href = scheduleGroupSectionHref(RULE, 'workingDay');
    expect(href.startsWith(`/admin/attendance/schedule/${RULE}?`), href).toBe(true);
    expect(href, 'a link beside a control you cannot change must not open an editor').not.toContain('/edit');
  });

  it('is the literal URL this round’s read-only preview renders', () => {
    expect(scheduleGroupSectionHref('grp-0000-0000-0000-000000000001', 'workingDay')).toBe(
      '/admin/attendance/schedule/grp-0000-0000-0000-000000000001?section=workingDay#section-workingDay',
    );
  });
});
