/**
 * SHARED LEAVE GROUP DISPLAY (feedback 46afcc48, revision 2).
 *
 * A shared leave group — several leave types drawing on one pooled annual allowance — was ENFORCEMENT ONLY
 * until this item. It refused applications past its ceiling (`enforceSharedLeaveGroupLimit`, core/leave.ts)
 * and appeared on no employee screen at all, so the reporter's six "Special Leave" types read as six
 * unrelated rows with nothing saying they share one pot.
 *
 * WHAT THIS FILE PROTECTS — three claims, each of which is a way the feature could ship wrong:
 *
 *   1. THE FIGURE IS NOT THE CEILING. `total_limit_days` caps what may be TAKEN; it never GRANTS anything.
 *      Drawing 10.00 for an employee whose six member types carry nine days between them would promise a
 *      day the group guard then refuses. The number is min(what is left under the ceiling, what the member
 *      types still hold) — measured on production as 9.00 against a 10.00 ceiling.
 *
 *   2. MEMBER VISIBILITY IS NOT AN INPUT TO ANYTHING. Hiding every member type changes NEITHER the pooled
 *      figure NOR the enforcement verdict. This is the reporter's central requirement (revision 2, after
 *      they contested a revision-1 plan in which the group folded its members in) and it is checked from
 *      BOTH ends: the read, and the refusal — because a defect that lives in the CONTRACT between a display
 *      and an engine is invisible to a unit test of either half.
 *
 *   3. EXISTING GROUPS ARE UNCHANGED ON SCREEN. The placement column defaults to Hidden, so approving this
 *      item draws nothing anywhere until HR chooses. A regression here puts a new balance on every
 *      employee's screen the morning after a release.
 *
 * ENFORCEMENT IS OUT OF SCOPE AND MUST STAY THAT WAY: this is a display request, and the ceiling, the
 * per-application cap and both refusals are unchanged. `test/combined-leave-limit.test.ts` and
 * `test/shared-leave-group-max-days.test.ts` own that behaviour; nothing here re-tests it except where it
 * is the subject of claim 2.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave, CombinedLeaveLimitExceededError } from '../core/leave';
import {
  createLeaveSharedGroup,
  updateLeaveSharedGroup,
  listLeaveSharedGroups,
  sharedLeaveGroupBalances,
} from '../core/leave-shared-group';
import {
  ESS_PLACEMENTS,
  SHARED_GROUP_DEFAULT_PLACEMENT,
  resolveSharedGroupPlacement,
  sharedGroupAvailableDays,
  sharedGroupCycleWindow,
} from '../lib/leave-groups';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// ── PURE: the arithmetic and the resolution, no database ───────────────────────────────────────────

describe('46afcc48 · sharedGroupAvailableDays — the SMALLER of two independent limits', () => {
  it('THE PRODUCTION SHAPE: a 10-day ceiling over types holding nine days shows NINE, not ten', () => {
    // Measured on production 2026-08-13: "Special Leave" carries total_limit_days 10.00 over six member
    // types, and for at least one employee those six carry 9.00 between them. Showing the ceiling would
    // invite an application enforceSharedLeaveGroupLimit refuses — the exact overpromise this item's plan
    // singles out. This is the case the whole function exists for.
    expect(sharedGroupAvailableDays({ totalLimitDays: 10, usedDays: 0, memberAvailableSum: 9 })).toBe(9);
  });

  it('the CEILING binds when the member types hold more than the pool allows', () => {
    // The other direction, and the reason a group exists at all: six types with 40 days between them may
    // still only take 10 of them.
    expect(sharedGroupAvailableDays({ totalLimitDays: 10, usedDays: 0, memberAvailableSum: 40 })).toBe(10);
  });

  it('days already committed come off the ceiling', () => {
    expect(sharedGroupAvailableDays({ totalLimitDays: 10, usedDays: 3, memberAvailableSum: 40 })).toBe(7);
  });

  it('neither term is clamped at zero — a pooled figure must not disagree with the rows it pools', () => {
    // A member type can legitimately sit below zero (a pending request against no balance), and the
    // per-type cards on the same screen print that negative. Clamping only the pool would make the group
    // contradict its own members.
    expect(sharedGroupAvailableDays({ totalLimitDays: 10, usedDays: 0, memberAvailableSum: -2 })).toBe(-2);
  });

  it('rounds to two decimals rather than leaking float noise into a day figure', () => {
    expect(sharedGroupAvailableDays({ totalLimitDays: 10, usedDays: 0.3, memberAvailableSum: 40 })).toBe(9.7);
    expect(sharedGroupAvailableDays({ totalLimitDays: 10, usedDays: 40, memberAvailableSum: 0.1 + 0.2 })).toBe(-30);
  });
});

describe('46afcc48 · resolveSharedGroupPlacement — all three are storable, and absence means Hidden', () => {
  it('honours each of the three placements a group can carry', () => {
    for (const pl of ESS_PLACEMENTS) expect(resolveSharedGroupPlacement(pl)).toBe(pl);
  });

  it("'hidden' IS a stored value here, unlike on a leave TYPE", () => {
    // leave_type expresses Hidden through visible_to_employee (7b11f1c1) and a DB CHECK forbids storing
    // 'hidden' in its placement column, so HR never faces two controls for one concept. A GROUP has no
    // such twin flag, so its column IS the single source of truth and admits all three. The difference is
    // deliberate; a future reader must not "harmonise" it away.
    expect(resolveSharedGroupPlacement('hidden')).toBe('hidden');
    const migration = read('../db/migrations/0438_leave_shared_group_ess_placement.sql');
    expect(migration).toContain("CHECK (ess_placement IN ('primary', 'secondary', 'hidden'))");
    expect(read('../db/migrations/0193_leave_type_ess_placement.sql')).toContain(
      "CHECK (ess_placement IN ('primary', 'secondary'))",
    );
  });

  it('an absent, blank or tampered value narrows to Hidden — never to a visible placement', () => {
    for (const bad of [null, undefined, '', 'PRIMARY', 'top', 'secondary ']) {
      expect(resolveSharedGroupPlacement(bad)).toBe('hidden');
    }
    expect(SHARED_GROUP_DEFAULT_PLACEMENT).toBe('hidden');
  });
});

describe('46afcc48 · sharedGroupCycleWindow — ONE definition of the group cycle', () => {
  it('is the calendar year of the application start', () => {
    expect(sharedGroupCycleWindow('2026-06-01')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(sharedGroupCycleWindow('2026-12-31')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('the ENGINE takes its window from the helper, so the figure and the refusal cannot drift', () => {
    // The window used to be spelled inline inside enforceSharedLeaveGroupLimit. Two spellings of "the
    // group's year" is how a number on screen stops matching the verdict behind it — the same class as the
    // six inlined copies of the shift span calculation recorded in HANDOFF.md.
    const leaveSrc = read('../core/leave.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const guard = leaveSrc.slice(leaveSrc.indexOf('async function enforceSharedLeaveGroupLimit('));
    const body = guard.slice(0, guard.indexOf('export function leaveYearWindow'));
    expect(body).toContain('sharedGroupCycleWindow(p.startDate)');
    expect(body, 'no second, hand-rolled calendar-year window').not.toMatch(/-01-01`|-12-31`/);
  });
});

// ── THE CONTRACT: enforcement may not see display state ────────────────────────────────────────────

describe('46afcc48 · the engine cannot see a placement or a visibility flag', () => {
  it('core/leave.ts reads neither ess_placement nor visible_to_employee, anywhere', () => {
    // This is claim 2 pinned at the source level, and it is what makes the behavioural test below more
    // than a coincidence: a display concept that never enters the enforcement module cannot move a verdict
    // no matter what the screen does with it. Comments stripped — this file's own prose names both columns.
    const leaveSrc = read('../core/leave.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(leaveSrc).not.toMatch(/visibleToEmployee|visible_to_employee/);
    expect(leaveSrc).not.toMatch(/essPlacement|ess_placement/);
  });
});

// ── DATABASE ───────────────────────────────────────────────────────────────────────────────────────

let b: Base;

const uniq = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;

/** Calendar-counted, negative-balance-allowed: one calendar day is one leave day and the submit-time
 *  balance gate never interferes with the pool figure under test. Mirrors combined-leave-limit.test.ts. */
async function leaveType(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('SGD'),
      name: uniq('Pooled'),
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function grant(employmentId: string, leaveTypeId: string, days: number): Promise<void> {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2020-01-01',
  });
}

/** Two member types holding 4 and 5 days — NINE between them, under a ten-day ceiling. The reporter's own
 *  shape, reduced to two types so the arithmetic is readable. */
async function fixture(grantA = 4, grantB = 5) {
  const ctx = adminCtx(b);
  const [ltA, ltB] = [await leaveType(), await leaveType()];
  const emp = await hireEmployee(ctx, {
    person: { fullName: 'Pooled', primaryEmail: `sgd_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  await grant(emp.employmentId, ltA, grantA);
  await grant(emp.employmentId, ltB, grantB);
  return { ctx, ltA, ltB, employmentId: emp.employmentId };
}

/** HR hides a leave type from employee self-service — the one hidden mechanism (7b11f1c1). */
async function hideFromEmployees(...leaveTypeIds: string[]): Promise<void> {
  for (const id of leaveTypeIds) {
    await owner.db
      .update(schema.leaveType)
      .set({ visibleToEmployee: false })
      .where(eq(schema.leaveType.id, id));
  }
}

// The whole cycle is in view, so `usedDays` (whole cycle) and the member sum (cut at asOf) measure the
// same requests — see the asymmetry note on sharedLeaveGroupBalances.
const AS_OF = '2026-12-31';
const TODAY = '2026-06-01';
const span3 = { startDate: '2026-06-01', endDate: '2026-06-03' } as const; // 3 calendar days

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

describe('46afcc48 · an existing group is drawn NOWHERE until HR chooses', () => {
  it('a new group defaults to Hidden and returns no card', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, { name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB] });
    const [row] = await listLeaveSharedGroups(ctx);
    expect(row.essPlacement).toBe('hidden');
    expect(await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF })).toEqual([]);
  });

  it('the column itself defaults to hidden, so a row written around the service is hidden too', async () => {
    // The service narrows an unrecognised value to Hidden; the DB DEFAULT is the second half of the same
    // promise, for an importer or a hand-written INSERT that never reaches the service at all.
    const { ctx, ltA, ltB } = await fixture();
    await owner.db
      .insert(schema.leaveSharedGroup)
      .values({ tenantId: b.tenantId, name: 'Raw', totalLimitDays: '10.00' });
    void ltA;
    void ltB;
    const rows = await listLeaveSharedGroups(ctx);
    expect(rows.map((r) => r.essPlacement)).toEqual(['hidden']);
  });
});

describe('46afcc48 · placing the group, and the figure it shows', () => {
  it('placed Primary, it returns ONE card at that placement', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    const g = await createLeaveSharedGroup(ctx, {
      name: 'Special Leave',
      totalLimitDays: 10,
      maxDaysPerApplication: 3,
      essPlacement: 'primary',
      leaveTypeIds: [ltA, ltB],
    });
    const cards = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: g.id,
      name: 'Special Leave',
      placement: 'primary',
      totalLimitDays: 10,
      maxDaysPerApplication: 3,
      usedDays: 0,
    });
  });

  it('THE FIGURE IS THE MEMBERS’ NINE, NOT THE CEILING’S TEN', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture(4, 5);
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave',
      totalLimitDays: 10,
      essPlacement: 'primary',
      leaveTypeIds: [ltA, ltB],
    });
    const [card] = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF });
    expect(card.available).toBe(9);
    expect(card.available, 'the raw ceiling would be an overpromise').not.toBe(card.totalLimitDays);
  });

  it('the CEILING binds when the member types hold more than the pool allows', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture(20, 20);
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave',
      totalLimitDays: 10,
      essPlacement: 'primary',
      leaveTypeIds: [ltA, ltB],
    });
    const [card] = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF });
    expect(card.available).toBe(10);
  });

  it('a pending request comes off BOTH the ceiling and its own type, and the smaller still wins', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture(4, 5);
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave',
      totalLimitDays: 10,
      essPlacement: 'primary',
      leaveTypeIds: [ltA, ltB],
    });
    await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3, today: TODAY });
    const [card] = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF });
    // Ceiling: 10 - 3 = 7. Members: (4 - 3) + 5 = 6. The members still bind.
    expect(card.usedDays).toBe(3);
    expect(card.available).toBe(6);
  });

  it('update moves the group between placements, and an unrecognised value narrows to Hidden', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    const g = await createLeaveSharedGroup(ctx, {
      name: 'Special Leave',
      totalLimitDays: 10,
      essPlacement: 'primary',
      leaveTypeIds: [ltA, ltB],
    });
    const move = (essPlacement: string) =>
      updateLeaveSharedGroup(ctx, {
        id: g.id,
        name: 'Special Leave',
        totalLimitDays: 10,
        essPlacement,
        leaveTypeIds: [ltA, ltB],
      });

    await move('secondary');
    expect((await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF }))[0].placement).toBe('secondary');

    await move('hidden');
    expect(await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF })).toEqual([]);

    // Neither a typo nor a tampered post may reveal a group to every employee.
    await move('TOP');
    expect((await listLeaveSharedGroups(ctx))[0].essPlacement).toBe('hidden');
  });
});

describe('46afcc48 · HIDING EVERY MEMBER CHANGES NEITHER THE POT NOR THE VERDICT', () => {
  it('the pooled figure is identical before and after every member type is hidden', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture(4, 5);
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave',
      totalLimitDays: 10,
      essPlacement: 'primary',
      leaveTypeIds: [ltA, ltB],
    });
    const before = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF });
    expect(before[0].available).toBe(9);

    await hideFromEmployees(ltA, ltB);

    const after = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: AS_OF });
    // Everything the employee reads about the pot is byte-identical — the figure, the ceiling, the cap and
    // the membership line. Naming only the visible half would describe a different pot.
    expect(after).toEqual(before);
    expect(after[0].available).toBe(9);
    expect(after[0].memberNames).toHaveLength(2);
  });

  it('enforceSharedLeaveGroupLimit gives the SAME verdict with every member hidden', async () => {
    // The other end of the same contract. A unit test of the read alone would pass while the engine
    // quietly started disagreeing with it, which is precisely how a display and an engine drift apart.
    const { ctx, ltA, ltB, employmentId } = await fixture(20, 20);
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave',
      totalLimitDays: 4,
      essPlacement: 'primary',
      leaveTypeIds: [ltA, ltB],
    });
    // A 3-day request fits under the 4-day ceiling; a second one does not.
    await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3, today: TODAY });
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: ltB,
        startDate: '2026-07-06',
        endDate: '2026-07-08',
        today: TODAY,
      }),
    ).rejects.toThrow(CombinedLeaveLimitExceededError);

    await hideFromEmployees(ltA, ltB);

    // Same refusal, same reason, over hidden types.
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: ltB,
        startDate: '2026-08-03',
        endDate: '2026-08-05',
        today: TODAY,
      }),
    ).rejects.toThrow(CombinedLeaveLimitExceededError);
    // …and what still fits, still fits: the pot never grew or shrank.
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: ltB,
        startDate: '2026-09-07',
        endDate: '2026-09-07',
        today: TODAY,
      }),
    ).resolves.toBeTruthy();
  });
});

// ── THE SCREEN ─────────────────────────────────────────────────────────────────────────────────────

describe('46afcc48 · the Leave tab draws the group at its placement', () => {
  const leavePage = read('../app/leave/page.tsx');
  const cardsCmp = read('../components/leave/shared-leave-group-cards.tsx');

  it('the page reads the placed groups and renders BOTH placements', () => {
    expect(leavePage).toContain("import { sharedLeaveGroupBalances } from '@/core/leave-shared-group'");
    expect(leavePage).toContain('sharedGroupsPrimary');
    expect(leavePage).toContain('sharedGroupsSecondary');
    // 46afcc48: PRIMARY groups no longer render in their own <SharedLeaveGroupCards> Card — they are passed
    // INTO <LeaveCards> as static tiles inside the "My Leave Balance" row. So only the SECONDARY site still
    // uses <SharedLeaveGroupCards> — one render site, not two. A group placed Secondary that only ever drew
    // Primary would be a setting the admin can choose and the screen ignores; the primary path is pinned by
    // the assertion below.
    //
    // UPDATED BY r302 (6c9802c9): "One My Leave page … the leave balance dashboard", with placement as ORDER
    // rather than location. Both placements now render as tiles inside the ONE dashboard grid — Primary groups
    // before Secondary ones — so the separate Secondary card is gone too. What this case defends is unchanged:
    // a group placed Secondary still draws (it is not silently dropped), and so does a Primary one.
    //
    // UPDATED BY r341 (8d3a7bff): a group whose pool a leave-type card already holds MERGES onto that card —
    // the reporter was reading two cards headed "Special Leave" as a duplicate. What this case defends is
    // still unchanged: a placed group is never silently dropped. When there is a card to merge onto, the
    // ceiling is on it (`pooledCeiling`, pinned in test/8d3a7bff-special-leave-one-card.dom.test.tsx); when
    // there is not — the seeded shape, no pooled type anywhere — the group keeps drawing its own tile, and
    // that tile is still built from BOTH placements in Primary-then-Secondary order.
    expect(leavePage.match(/<SharedLeaveGroupCards/g) ?? []).toHaveLength(0);
    expect(leavePage).toMatch(/<MyLeaveDashboard[^>]*sharedGroups=\{standaloneSharedGroups\}/s);
    expect(leavePage).toMatch(
      /standaloneSharedGroups = \[\.\.\.sharedGroupsPrimary, \.\.\.sharedGroupsSecondary\]\.filter/,
    );
    expect(read('../components/leave/my-leave-dashboard.tsx')).toContain('sharedGroups.map((g) =>');
  });

  it('it is SELF-SERVICE only — the read is suppressed for an HR admin, not merely the markup', () => {
    // 8ec63139: this route is an admin's employee-inquiry landing page and their own pooled balance does
    // not belong on it. Gating only the JSX would still pay for the query on every admin page load.
    expect(leavePage).toMatch(/ess && me \? await sharedLeaveGroupBalances\(/);
  });

  it('the card prints the pooled figure through the shared day formatter, never a private toFixed', () => {
    expect(cardsCmp).toContain("from '@/lib/day-format'");
    expect(cardsCmp).toContain('{formatDays(g.available)}');
    expect(cardsCmp, 'no second precision beside the shared formatter').not.toContain('toFixed(');
    // Server-safe: the page is an RSC and hands it pre-translated strings.
    expect(cardsCmp.trimStart().startsWith("'use client'")).toBe(false);
  });

  it('the ceiling is printed BESIDE the figure, never in place of it', () => {
    // `limitLabel` is the "of 10.00 shared days" context line. If it ever became the card's headline the
    // overpromise this whole item guards against would be back.
    expect(cardsCmp).toContain('{g.limitLabel}');
    expect(cardsCmp).not.toMatch(/formatDays\(g\.totalLimitDays\)|\{g\.totalLimitDays\}/);
  });

  it('every locale carries the employee strings and the admin placement control', () => {
    // A missing key returns 200 and renders its own key path on an employee-facing screen — tsc, the suite
    // and `next build` all pass over it (trap 6).
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`../messages/${loc}.json`));
      const g = m.me.sharedLeaveGroups;
      expect(g, `${loc} me.sharedLeaveGroups`).toBeTruthy();
      for (const k of ['heading', 'ofLimit', 'sharedAcross', 'maxPerApplication']) {
        expect(g[k], `${loc} me.sharedLeaveGroups.${k}`).toBeTruthy();
      }
      const admin = m.admin.leave.sharedGroup;
      expect(admin.placementLabel, `${loc} sharedGroup.placementLabel`).toBeTruthy();
      expect(admin.placementHelp, `${loc} sharedGroup.placementHelp`).toBeTruthy();
      for (const pl of ESS_PLACEMENTS) {
        expect(admin.placementOption?.[pl], `${loc} sharedGroup.placementOption.${pl}`).toBeTruthy();
      }
      // The three placements must stay DISTINCT in every locale: an admin shown the same word three times
      // cannot choose between them, and Hidden collapsing into Primary is the release-morning surprise.
      const opts = ESS_PLACEMENTS.map((pl) => admin.placementOption[pl]);
      expect(new Set(opts).size, `${loc} all three placement options must differ`).toBe(3);
    }
  });

  it('the admin control is a SELECT, and the update action reads it by VALUE', () => {
    // Trap 17: a field that is always submitted cannot be read by presence. A <select> always posts, so the
    // action must take its value and narrow it — `fd.get(k) != null` would read every save as a choice.
    const cfg = read('../components/leave-shared-group-config.tsx');
    expect(cfg).toContain('name="essPlacement"');
    expect(cfg.match(/name="essPlacement"/g) ?? [], 'create AND edit must both carry it').toHaveLength(2);
    const actions = read('../app/admin/actions.ts');
    expect(actions).toContain("essPlacement: String(fd.get('essPlacement') ?? '')");
    expect(actions.match(/essPlacement: String\(fd\.get\('essPlacement'\) \?\? ''\)/g) ?? []).toHaveLength(2);
  });
});
