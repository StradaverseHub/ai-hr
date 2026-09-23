/**
 * 07ebd04d (r331) — WHAT MIGRATION 0483 DOES TO EACH OF THE SIX SHIFTS AND EACH OF THE FIVE PEOPLE.
 *
 * This item changes which days people work, so the migration is not asserted from its comments: the file
 * itself is READ OFF DISK, its two data blocks are executed against the production SHAPE (the six shifts
 * and five employments scripts/report-schedule-group-split.ts measured on 2026-09-23), and the rows that
 * come out are compared row by row. If someone edits the SQL, this test runs the edited SQL.
 *
 * The ALTER statements are NOT re-run here — the test database already has them, because `migrateTestDb`
 * applied the whole journal including 0483. Only the two DO blocks are executed, and they are written to
 * be data-driven precisely so that they can be.
 *
 * WHAT IS PINNED, and why each one is money:
 *   · every new group is created WITH its working week in the same statement (a group with a NULL pattern
 *     books every working day as a rest day for everyone in it — rest-day overtime on ordinary work);
 *   · every calculation column AND every overtime band is copied from the group the shifts are leaving (a
 *     new group with default OT bands silently re-prices every shift moved into it);
 *   · the tenant's is_default "Standard" rule keeps NULL patterns and keeps is_default (it is what every
 *     shift with no rule_id resolves — a week on it would be imposed on every ungrouped shift);
 *   · NOBODY IS LEFT IN THE EMPTIED GROUP. An employment still in a group that holds no shifts has its
 *     next shift assignment refused by core/roster.ts assertShiftsAllowedForEmploymentsTx;
 *   · not one shift's own weekly/half/off arrays are edited;
 *   · the engine reads the SAME working week before and after, because each group carries exactly the week
 *     its own shifts already had.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createAttendanceRule } from '../core/attendance-rule';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const MIGRATION = readFileSync(root + 'db/migrations/0483_schedule_group_working_week.sql', 'utf8');

/** The migration's DATA half: everything after the last DDL statement, split on drizzle's breakpoint. */
const dataBlocks = (): string[] =>
  MIGRATION.split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.includes('DO $$'));

const runMigrationData = async () => {
  const blocks = dataBlocks();
  // Non-vacuity of the harness itself: if the file ever stops containing the two blocks, this test would
  // silently assert nothing at all.
  expect(blocks).toHaveLength(2);
  for (const b of blocks) await owner.db.execute(sql.raw(b));
};

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

type Ids = { standard: string; a02: string; shifts: Record<string, string>; arjun: string; others: string[] };

/**
 * THE PRODUCTION SHAPE, as measured. Two Schedule Groups; "Standard" is the tenant default and holds five
 * shifts across three working weeks; "A02" holds one shift with one week. Five employments: four in NO
 * group, and Arjun Kumar in group "Standard" itself.
 */
async function seedProductionShape(): Promise<Ids> {
  const t = b.tenantId;
  const [standard] = await owner.db
    .insert(schema.attendanceRule)
    .values({
      tenantId: t,
      name: 'Standard',
      description: 'Default attendance calculation rule.',
      isDefault: true,
      status: 'active',
      // Deliberately NON-default values on every calculation column: a copy that quietly wrote the column
      // DEFAULT instead of the source's value would pass against zeroes.
      lateGracePeriodMinutes: 15,
      lateAfterMinutes: 10,
      lateDeductMinutes: 30,
      includeGraceInLateness: true,
      earlyGracePeriodMinutes: 5,
      earlyAfterMinutes: 7,
      earlyDeductMinutes: 20,
      includeGraceInEarlyOut: true,
      applyToEarlyOt: true,
    })
    .returning({ id: schema.attendanceRule.id });
  await owner.db.insert(schema.attendanceRuleOtRow).values([
    { tenantId: t, ruleId: standard.id, fromMinutes: 1, toMinutes: 59, ratePattern: 'flat', rate: '1.50', phRate: '3.00', roundingMode: 'none', roundToMinutes: null, sortOrder: 0 },
    { tenantId: t, ruleId: standard.id, fromMinutes: 60, toMinutes: 0, ratePattern: 'flat', rate: '2.00', phRate: null, roundingMode: 'down', roundToMinutes: 60, sortOrder: 1 },
  ]);
  const [a02] = await owner.db
    .insert(schema.attendanceRule)
    .values({ tenantId: t, name: 'A02', isDefault: false, status: 'active', lateGracePeriodMinutes: 0 })
    .returning({ id: schema.attendanceRule.id });

  const mk = async (code: string, ruleId: string, weekly: number[], half: number[], off: number[]) => {
    const [row] = await owner.db
      .insert(schema.shift)
      .values({
        tenantId: t,
        companyId: null,
        name: code,
        code,
        startTime: '08:00',
        endTime: '17:00',
        breakMinutes: 60,
        weeklyPattern: weekly,
        halfPattern: half,
        offPattern: off,
        ruleId,
      })
      .returning({ id: schema.shift.id });
    return row.id;
  };
  const shifts: Record<string, string> = {
    AM01: await mk('AM01', standard.id, [1, 2, 3, 4, 5], [], []),
    AM03: await mk('AM03', standard.id, [1, 2, 3, 4, 5], [], []),
    SF01: await mk('SF01', standard.id, [1, 2, 3, 4, 5], [], []),
    AM02: await mk('AM02', standard.id, [1, 2, 3, 4, 5], [6], []),
    MB28: await mk('MB28', standard.id, [1, 2, 3, 4, 5], [], [6]),
    AM4: await mk('AM4', a02.id, [1, 2, 3, 4, 5], [], []),
  };

  const a = adminCtx(b);
  const hire = async (name: string) => {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `sg_${randomUUID()}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    return e.employmentId;
  };
  const attach = async (employmentId: string, shiftId: string) => {
    await owner.db.insert(schema.employmentShiftArrangement).values({
      tenantId: t,
      employmentId,
      shiftType: 'fixed',
      shiftId,
      validFrom: '2026-01-01',
    });
    await owner.db.update(schema.employment).set({ defaultShiftId: shiftId, shiftType: 'fixed' }).where(eq(schema.employment.id, employmentId));
  };

  const aaron = await hire('AARON AZIZ');
  const lsl = await hire('LSL');
  const arjun = await hire('Arjun Kumar');
  const c = await hire('MB28 Person C');
  const d = await hire('MB28 Person D');
  await attach(aaron, shifts.AM01);
  await attach(lsl, shifts.AM03);
  await attach(arjun, shifts.SF01);
  await attach(c, shifts.MB28);
  await attach(d, shifts.MB28);
  // ⚠️ The ONE employment that is in a Schedule Group of its own, and it is the group being emptied.
  await owner.db.update(schema.employment).set({ attendanceRuleId: standard.id }).where(eq(schema.employment.id, arjun));

  return { standard: standard.id, a02: a02.id, shifts, arjun, others: [aaron, lsl, c, d] };
}

const ruleByName = async (tenantId: string, name: string) => {
  const [r] = await owner.db
    .select()
    .from(schema.attendanceRule)
    .where(and(eq(schema.attendanceRule.tenantId, tenantId), eq(schema.attendanceRule.name, name)));
  return r;
};
const shiftRuleOf = async (shiftId: string) => {
  const [s] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, shiftId));
  return s;
};

describe('migration 0483 — the "Standard" Schedule Group splits into three', () => {
  it('creates exactly the three approved groups, each carrying the week its own shifts already have', async () => {
    const ids = await seedProductionShape();
    await runMigrationData();

    const five = await ruleByName(b.tenantId, 'Standard 5 Day');
    const fiveHalf = await ruleByName(b.tenantId, 'Standard 5.5 Day');
    const satOff = await ruleByName(b.tenantId, 'Standard 5 Day + Saturday Off');
    for (const r of [five, fiveHalf, satOff]) expect(r).toBeTruthy();

    expect({ w: five.weeklyPattern, h: five.halfPattern, o: five.offPattern }).toEqual({ w: [1, 2, 3, 4, 5], h: [], o: [] });
    expect({ w: fiveHalf.weeklyPattern, h: fiveHalf.halfPattern, o: fiveHalf.offPattern }).toEqual({ w: [1, 2, 3, 4, 5], h: [6], o: [] });
    expect({ w: satOff.weeklyPattern, h: satOff.halfPattern, o: satOff.offPattern }).toEqual({ w: [1, 2, 3, 4, 5], h: [], o: [6] });
    // None of the three may become a second tenant default.
    for (const r of [five, fiveHalf, satOff]) expect(r.isDefault).toBe(false);
    // 0483 must not have created a fourth group nobody asked for.
    const all = await owner.db.select({ name: schema.attendanceRule.name }).from(schema.attendanceRule).where(eq(schema.attendanceRule.tenantId, b.tenantId));
    expect(all.map((r) => r.name).sort()).toEqual(
      ['A02', 'Standard', 'Standard 5 Day', 'Standard 5 Day + Saturday Off', 'Standard 5.5 Day'].sort(),
    );
    expect(ids.standard).toBeTruthy();
  });

  it('moves each of the six shifts into the group that matches the week it already had, and edits no shift week', async () => {
    const ids = await seedProductionShape();
    const before = await owner.db.select().from(schema.shift).where(eq(schema.shift.tenantId, b.tenantId));
    await runMigrationData();

    const five = await ruleByName(b.tenantId, 'Standard 5 Day');
    const fiveHalf = await ruleByName(b.tenantId, 'Standard 5.5 Day');
    const satOff = await ruleByName(b.tenantId, 'Standard 5 Day + Saturday Off');

    expect((await shiftRuleOf(ids.shifts.AM01)).ruleId).toBe(five.id);
    expect((await shiftRuleOf(ids.shifts.AM03)).ruleId).toBe(five.id);
    expect((await shiftRuleOf(ids.shifts.SF01)).ruleId).toBe(five.id);
    expect((await shiftRuleOf(ids.shifts.AM02)).ruleId).toBe(fiveHalf.id);
    expect((await shiftRuleOf(ids.shifts.MB28)).ruleId).toBe(satOff.id);
    // A02 needed no split and keeps its group.
    expect((await shiftRuleOf(ids.shifts.AM4)).ruleId).toBe(ids.a02);

    // NOT ONE SHIFT'S WORKING WEEK IS EDITED — the plan's promise, asserted on every row.
    const after = await owner.db.select().from(schema.shift).where(eq(schema.shift.tenantId, b.tenantId));
    const week = (rows: typeof after) =>
      rows
        .map((s) => `${s.code}:${JSON.stringify(s.weeklyPattern)}|${JSON.stringify(s.halfPattern)}|${JSON.stringify(s.offPattern)}`)
        .sort();
    expect(week(after)).toEqual(week(before));
  });

  it('copies every calculation column and every overtime band onto each new group', async () => {
    await seedProductionShape();
    const src = await ruleByName(b.tenantId, 'Standard');
    await runMigrationData();

    for (const name of ['Standard 5 Day', 'Standard 5.5 Day', 'Standard 5 Day + Saturday Off']) {
      const r = await ruleByName(b.tenantId, name);
      // Every column the time engine reads. A group created with defaults would re-price its shifts.
      expect({
        lateGracePeriodMinutes: r.lateGracePeriodMinutes,
        lateAfterMinutes: r.lateAfterMinutes,
        lateDeductMinutes: r.lateDeductMinutes,
        includeGraceInLateness: r.includeGraceInLateness,
        earlyGracePeriodMinutes: r.earlyGracePeriodMinutes,
        earlyAfterMinutes: r.earlyAfterMinutes,
        earlyDeductMinutes: r.earlyDeductMinutes,
        includeGraceInEarlyOut: r.includeGraceInEarlyOut,
        applyToEarlyOt: r.applyToEarlyOt,
        applyDeductions: r.applyDeductions,
        deductionsEffectiveFrom: r.deductionsEffectiveFrom,
        status: r.status,
      }).toEqual({
        lateGracePeriodMinutes: src.lateGracePeriodMinutes,
        lateAfterMinutes: src.lateAfterMinutes,
        lateDeductMinutes: src.lateDeductMinutes,
        includeGraceInLateness: src.includeGraceInLateness,
        earlyGracePeriodMinutes: src.earlyGracePeriodMinutes,
        earlyAfterMinutes: src.earlyAfterMinutes,
        earlyDeductMinutes: src.earlyDeductMinutes,
        includeGraceInEarlyOut: src.includeGraceInEarlyOut,
        applyToEarlyOt: src.applyToEarlyOt,
        applyDeductions: src.applyDeductions,
        deductionsEffectiveFrom: src.deductionsEffectiveFrom,
        status: src.status,
      });
      const bands = await owner.db
        .select()
        .from(schema.attendanceRuleOtRow)
        .where(eq(schema.attendanceRuleOtRow.ruleId, r.id))
        .orderBy(schema.attendanceRuleOtRow.sortOrder);
      expect(
        bands.map((x) => [x.fromMinutes, x.toMinutes, x.ratePattern, x.rate, x.phRate, x.roundingMode, x.roundToMinutes]),
      ).toEqual([
        [1, 59, 'flat', '1.50', '3.00', 'none', null],
        [60, 0, 'flat', '2.00', null, 'down', 60],
      ]);
    }
  });

  it('moves Arjun Kumar with his shift and leaves NOBODY in the emptied group', async () => {
    const ids = await seedProductionShape();
    await runMigrationData();

    const five = await ruleByName(b.tenantId, 'Standard 5 Day');
    const [arjun] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, ids.arjun));
    // He is on SF01, which went to "Standard 5 Day"; his group must have gone with it or his next shift
    // assignment would be refused by assertShiftsAllowedForEmploymentsTx.
    expect(arjun.attendanceRuleId).toBe(five.id);

    // The four who were in no group are STILL in no group — nothing about them changes.
    for (const id of ids.others) {
      const [e] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id));
      expect(e.attendanceRuleId).toBeNull();
    }

    const stillInStandard = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(eq(schema.employment.attendanceRuleId, ids.standard));
    expect(stillInStandard).toEqual([]);
  });

  it('keeps the tenant default rule as the default, holding no shifts and NO working week', async () => {
    const ids = await seedProductionShape();
    await runMigrationData();

    const std = await ruleByName(b.tenantId, 'Standard');
    expect(std.isDefault).toBe(true);
    // ⚠️ The load-bearing one: it is what every shift with no rule_id resolves. A week here would be
    // imposed on every ungrouped shift in the tenant.
    expect(std.weeklyPattern).toBeNull();
    expect(std.halfPattern).toEqual([]);
    expect(std.offPattern).toEqual([]);
    const held = await owner.db.select({ id: schema.shift.id }).from(schema.shift).where(eq(schema.shift.ruleId, ids.standard));
    expect(held).toEqual([]);
  });

  it('gives the already-consistent group A02 its own shift’s week, and never a week with no working day', async () => {
    const ids = await seedProductionShape();
    await runMigrationData();
    const a02 = await ruleByName(b.tenantId, 'A02');
    expect({ w: a02.weeklyPattern, h: a02.halfPattern, o: a02.offPattern }).toEqual({ w: [1, 2, 3, 4, 5], h: [], o: [] });
    expect(ids.a02).toBe(a02.id);
  });

  it('follows employment.default_shift_id when the person has no live arrangement row at all', async () => {
    const ids = await seedProductionShape();
    // A sixth employment in the emptied group, reachable ONLY through the profile backup shift — the leg
    // the first version of the split report missed entirely, and the one that decides four of five people.
    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Backup Shift Only', primaryEmail: `sg_${randomUUID()}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await owner.db
      .update(schema.employment)
      .set({ defaultShiftId: ids.shifts.MB28, shiftType: 'fixed', attendanceRuleId: ids.standard })
      .where(eq(schema.employment.id, e.employmentId));

    await runMigrationData();

    const satOff = await ruleByName(b.tenantId, 'Standard 5 Day + Saturday Off');
    const [row] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, e.employmentId));
    expect(row.attendanceRuleId).toBe(satOff.id);
  });

  it('REFUSES rather than strands: a fourth working week in the group aborts the whole split', async () => {
    const ids = await seedProductionShape();
    // A shift whose week is not one of the three the reporter named and approved.
    await owner.db.insert(schema.shift).values({
      tenantId: b.tenantId,
      name: 'NIGHT6',
      code: 'NIGHT6',
      startTime: '20:00',
      endTime: '23:00',
      breakMinutes: 0,
      weeklyPattern: [1, 2, 3],
      halfPattern: [],
      offPattern: [],
      ruleId: ids.standard,
    });
    await expect(runMigrationData()).rejects.toThrow(/not one of the three the reporter approved/i);
    // Nothing moved: the exception rolled the whole block back.
    expect((await shiftRuleOf(ids.shifts.AM01)).ruleId).toBe(ids.standard);
    expect(await ruleByName(b.tenantId, 'Standard 5 Day')).toBeUndefined();
  });

  it('does nothing at all to a group that holds ONE working week', async () => {
    const t = b.tenantId;
    const [only] = await owner.db
      .insert(schema.attendanceRule)
      .values({ tenantId: t, name: 'Standard', isDefault: true, status: 'active', lateGracePeriodMinutes: 0 })
      .returning({ id: schema.attendanceRule.id });
    await owner.db.insert(schema.shift).values({
      tenantId: t, name: 'ONE', code: 'ONE', startTime: '09:00', endTime: '18:00', breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5], halfPattern: [], offPattern: [], ruleId: only.id,
    });
    await runMigrationData();
    const names = await owner.db.select({ name: schema.attendanceRule.name }).from(schema.attendanceRule).where(eq(schema.attendanceRule.tenantId, t));
    expect(names.map((n) => n.name)).toEqual(['Standard']);
    // ⚠️ AND THE TENANT DEFAULT IS STILL PATTERN-LESS even though its one shift's week is consistent.
    // The second block skips the is_default rule by an explicit predicate: it is what every shift with no
    // rule_id resolves, so a week on it would be imposed on shifts that never joined a group.
    const after = await ruleByName(t, 'Standard');
    expect(after.weeklyPattern).toBeNull();
    expect(after.halfPattern).toEqual([]);
  });
});

describe('07ebd04d — the write side refuses a Schedule Group that declares a week it cannot walk', () => {
  const baseInput = {
    name: `G ${randomUUID().slice(0, 8)}`,
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
  };

  it('refuses a group whose week is all OFF days — the row that would rest-day everyone in it', async () => {
    const a = adminCtx(b);
    // `createAttendanceRule` validates BEFORE it opens a transaction, so the refusal is a SYNCHRONOUS
    // throw; wrapping it is what turns it into the rejection `.rejects` needs.
    await expect(
      (async () => createAttendanceRule(a, { ...baseInput, weeklyPattern: [], halfPattern: [], offPattern: [1, 2, 3, 4, 5, 6] }))(),
    ).rejects.toThrow(/no working day/i);
  });

  it('refuses a week whose lists overlap — the 0429 disjointness invariant, moved with the columns', async () => {
    const a = adminCtx(b);
    await expect(
      (async () => createAttendanceRule(a, { ...baseInput, weeklyPattern: [1, 2, 3, 4, 5], halfPattern: [5], offPattern: [] }))(),
    ).rejects.toThrow(/exactly one list/i);
  });

  it('refuses a weekday outside 1–7', async () => {
    const a = adminCtx(b);
    await expect((async () => createAttendanceRule(a, { ...baseInput, weeklyPattern: [0, 1] }))()).rejects.toThrow(/weekdays 1–7/i);
  });

  it('accepts an ALL-HALF week (it is walkable) and stores it sorted and deduplicated', async () => {
    const a = adminCtx(b);
    const { id } = await createAttendanceRule(a, { ...baseInput, weeklyPattern: [], halfPattern: [3, 1, 1, 2], offPattern: [] });
    const [r] = await owner.db.select().from(schema.attendanceRule).where(eq(schema.attendanceRule.id, id));
    expect(r.weeklyPattern).toBeNull();
    expect(r.halfPattern).toEqual([1, 2, 3]);
  });

  it('accepts a group that declares NO week at all — the state every rule before 0483 is in', async () => {
    const a = adminCtx(b);
    const { id } = await createAttendanceRule(a, { ...baseInput });
    const [r] = await owner.db.select().from(schema.attendanceRule).where(eq(schema.attendanceRule.id, id));
    expect(r.weeklyPattern).toBeNull();
    expect(r.halfPattern).toEqual([]);
    expect(r.offPattern).toEqual([]);
  });
});
