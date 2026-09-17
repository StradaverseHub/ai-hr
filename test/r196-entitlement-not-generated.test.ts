/**
 * 31e39d74 / r196 — "CONFIGURED BUT NOT YET GENERATED" IS NOW A VALUE, NOT A SILENCE.
 *
 * The reporter configured entitlement tables for Medical and Hospitalization Leave and saw 0.00 on My
 * Leave. r193 (`a9d0a94a`) fixed the ENGINE that produced the zero — tables read from the date they apply,
 * mid-year joiners visited, a sole table applied without a rule — and this file guards the other half they
 * asked for in their own words:
 *
 *   "If a separate Generate Entitlement / Run Accrual action is required, the system should clearly
 *    indicate that the entitlement is configured but not yet generated, rather than silently showing 0.00."
 *
 * ── WHAT MAKES THIS HARD, AND WHAT THESE CASES ARE REALLY PINNING ────────────────────────────────────
 * The state CANNOT be read off the ledger, and the two ways of getting that wrong are opposite:
 *
 *   • `openLeaveYear` SKIPS a pair whose composed entitlement is <= 0 (`no_entitlement`) and writes NO row.
 *     So "no accrual rows" does not mean "never generated".
 *   • the `accrual_unconfigured` path DOES write a row — a 0.00 accrual, deliberately, because that row is
 *     openLeaveYear's own idempotency marker AND the expiry sweep's "year was opened" marker. So
 *     "currentYearEntitlement === 0" does not mean "never generated" either.
 *
 * ⚠️ AND THE ONE THAT GOT THROUGH REVIEW AND IS NOW THE MOST IMPORTANT CASE IN THIS FILE. The first cut
 * asked THREE questions (a table in force · the earning-method marker · an accrual row) and read "no row"
 * as "not generated". `openLeaveYear` has FIVE branches that write no row, and only ONE of them is
 * answered by pressing Generate Entitlement:
 *
 *     earned_method (6302) · no_entitlement (6306) · frozen (6271) · pack_blocked (6252) · granted (6377)
 *
 * The FIRST of those is the ordinary shape of the commonest leave type in the product: an ANNUAL type with
 * an entitlement table and an `earned_*` method is logged `earned_method` and skipped by every year-open
 * there will ever be — its days come from `accrueEarnedLeave`. So from cycle rollover until the first
 * monthly accrual landed, every surface captioned it "Not yet generated" and told the employee to press a
 * button that would skip their type. A REMEDY THAT CANNOT FIRE IS WORSE THAN THE SILENT 0.00 IT REPLACED.
 * `an earned type is never told to press Generate Entitlement` below is that case, end to end, and it is
 * the reason `resolveEntitlementStatus` now mirrors the engine's branches instead of guessing from a row.
 *
 * Hence five inputs, and hence the cases below that would pass under a naive rule and fail under another:
 *   – `earning method missing, AFTER a generation run` — a 0.00 accrual row exists and the type must STILL
 *     say "earning method not set", not "generated". A sum-based test cannot tell these apart.
 *   – `a table that resolves no band` — a real table applies, so 0.00 is NOT "not configured"; and a
 *     year-open will skip it as `no_entitlement` every time, so it is NOT "not generated" either.
 *
 * ── AND WHY `earning_method_missing` OUTRANKS `not_generated` ────────────────────────────────────────
 * Both are true of Hospitalization Leave on the reporter's account. Saying "not generated yet" sends them
 * to press Generate Entitlement, which writes a 0.00 row and returns them to a silent zero. The earning
 * method is the thing they can fix, so it is the thing they are told. That precedence is asserted directly
 * (`earning method missing outranks…`) because it is a decision, not an accident of the if-order.
 *
 * The plan is explicit that the earning method is the reporter's own DATA state: this surfaces it and
 * changes nothing. Nothing in this file, and nothing it exercises, writes a leave-type setting.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, openLeaveYear } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  retireEligibilityRule,
} from '../core/entitlement-template';
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  ENTITLEMENT_STATUS_TIP_KEY,
  entitlementStatusNeedsNotice,
  resolveEntitlementStatus,
  type EntitlementStatus,
} from '../lib/entitlement-status';
import { deriveBalanceRow, type BalanceInput, type BreakdownInput } from '../components/leave/leave-balance-row';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Record<string, never>;

const ALL_STATUSES: EntitlementStatus[] = [
  'granted',
  'not_generated',
  'earned_accrual',
  // r299 (3de1453a) — an earned method on a type that is not Annual Leave: no engine adds its days, so it may
  // not read as `earned_accrual`. Pinned both ways in test/r299-earned-accrual-annual-only.test.ts §6.
  'earned_method_not_annual_leave',
  'zero_entitlement',
  'earning_method_missing',
  // r209 — see the `no table in force` case below for why the one `not_configured` became three states.
  'no_entitlement_table',
  'no_eligibility_match',
  'capped_by_max_balance',
  'not_configured',
];

/** The one state where "Run Generate Entitlement" is a REMEDY rather than a red herring. Everything else
 *  that shows a caption must be reachable WITHOUT that instruction — asserted against the catalogues at the
 *  bottom of this file, because copy is the whole deliverable of this half of the item. */
const REMEDY_STATUS: EntitlementStatus = 'not_generated';

/** The engine's own defaults for a healthy lump-grant type: a table applies, a method is chosen, the band
 *  resolves real days. Each case below overrides exactly the fact it is about. */
const facts = (over: Partial<Parameters<typeof resolveEntitlementStatus>[0]> = {}) => ({
  hasTemplateInForce: true,
  // r209 — a table resolved for this employee, so of course the type has tables. The two are only ever
  // different when `hasTemplateInForce` is FALSE, which is the case the split below is about.
  leaveTypeHasTemplates: true,
  maxBalanceDays: null as number | null,
  accrualUnconfigured: false,
  earnedMethod: false,
  // r299 — false is every Annual Leave and every non-earned type, i.e. every case below that predates r299.
  earnedMethodNotAnnualLeave: false,
  entitlementDays: 14,
  hasAccrualRowInCycle: false,
  ...over,
});

// ── The pure derivation ─────────────────────────────────────────────────────────────────────────────

describe('resolveEntitlementStatus: the engine’s own branches, in the engine’s own order', () => {
  /**
   * ⚠️ r209 REVISED THIS CASE — THE ORIGINAL ASSERTED `not_configured` FOR BOTH HALVES OF A SPLIT.
   *
   * The pinned decision was "no table in force ⇒ not_configured, whatever every other fact says", and the
   * "whatever every other fact says" half is UNCHANGED and still asserted below: nothing about the earning
   * method, the ledger, the method family or the day count can outrank an unresolved table.
   *
   * What was wrong is the ANSWER, and it cost a tenant six days. `hasTemplateInForce: false` covers two
   * situations that call for opposite actions — the leave type has no day table (write one), and the leave
   * type has six and no eligibility rule reaches this employee (fix the rule). Production, 2026-08-19: ONE
   * `entitlement_eligibility_rule` tenant-wide, `valid_to = 2026-08-13`. From the 14th every employee took
   * this branch, resolved to `not_configured`, and `not_configured` is SILENT — so six correct Medical
   * tables sat unreachable behind a 0.00 nobody could explain.
   */
  it('no table resolved ⇒ WHICH kind of nothing, whatever every other fact says', () => {
    for (const accrualUnconfigured of [false, true]) {
      for (const hasAccrualRowInCycle of [false, true]) {
        for (const earnedMethod of [false, true]) {
          // r299 — a STRANDED earned method cannot outrank an unresolved table either.
          for (const earnedMethodNotAnnualLeave of earnedMethod ? [false, true] : [false]) {
            for (const entitlementDays of [0, 14]) {
              const base = { hasTemplateInForce: false, accrualUnconfigured, hasAccrualRowInCycle, earnedMethod, earnedMethodNotAnnualLeave, entitlementDays };
              const label = `${accrualUnconfigured}/${hasAccrualRowInCycle}/${earnedMethod}/${earnedMethodNotAnnualLeave}/${entitlementDays}`;
              // The leave type has NO table at all: 0.00 is arithmetically true and the missing piece is the
              // day table.
              expect(
                resolveEntitlementStatus(facts({ ...base, leaveTypeHasTemplates: false })),
                label,
              ).toBe('no_entitlement_table');
              // The tables EXIST and none of them reaches this employee. THE PRODUCTION STATE.
              expect(
                resolveEntitlementStatus(facts({ ...base, leaveTypeHasTemplates: true })),
                label,
              ).toBe('no_eligibility_match');
            }
          }
        }
      }
    }
  });

  /**
   * r209 — A MAXIMUM BALANCE OF 0 IS NOT A SILENT `granted`, AND THE ORDER IS THE WHOLE ASSERTION.
   *
   * The six Special Leave types on the reporter's account carry bands of `{days: 3, maxBalanceDays: 0}`.
   * `openLeaveYear` grants the 3, `applyMaxBalance` clamps it to 0.00, AND THE ACCRUAL ROW IS STILL
   * WRITTEN — so `hasAccrualRowInCycle` is true and the honest-looking branch below would answer
   * "generated" over a figure of 0.00. That is the silent zero this whole item is about, reached from a
   * completely different direction than the missing rule.
   *
   * The cap's MEANING is untouched: `bandMaxBalance` treats any finite number >= 0 as a real cap and this
   * only reports it.
   */
  it('a cap of 0 over a table that grants days outranks granted — the clamp is announced, not applied silently', () => {
    for (const hasAccrualRowInCycle of [false, true]) {
      expect(
        resolveEntitlementStatus(facts({ maxBalanceDays: 0, entitlementDays: 3, hasAccrualRowInCycle })),
        `row=${hasAccrualRowInCycle}`,
      ).toBe('capped_by_max_balance');
    }
    // …but a table that grants NOTHING is a statement about the day table, and that is the more useful
    // answer: fixing the cap would still leave 0 days to be capped.
    expect(resolveEntitlementStatus(facts({ maxBalanceDays: 0, entitlementDays: 0 }))).toBe('zero_entitlement');
    // A REAL cap is not a fault. Only zero zeroes the type.
    expect(resolveEntitlementStatus(facts({ maxBalanceDays: 14, hasAccrualRowInCycle: true }))).toBe('granted');
    expect(resolveEntitlementStatus(facts({ maxBalanceDays: null, hasAccrualRowInCycle: true }))).toBe('granted');
    // And the earning method still outranks it: a type with no method grants nothing for the cap to clamp.
    expect(
      resolveEntitlementStatus(facts({ maxBalanceDays: 0, entitlementDays: 3, accrualUnconfigured: true })),
    ).toBe('earning_method_missing');
  });

  it('a table, a LUMP method, real days and no accrual row ⇒ not_generated — the reporter’s case', () => {
    expect(resolveEntitlementStatus(facts())).toBe('not_generated');
  });

  it('a table and an accrual row ⇒ granted', () => {
    expect(resolveEntitlementStatus(facts({ hasAccrualRowInCycle: true }))).toBe('granted');
  });

  it('an EARNED method with no row ⇒ earned_accrual, never not_generated', () => {
    // ⚠️ THE REGRESSION THIS CASE EXISTS FOR. core/leave.ts:6302 logs `earned_method` and `continue`s —
    // no ledger row, ever, from a year-open. Calling that "not generated" told the user to press a button
    // whose very next act is to skip their leave type. The days come from accrueEarnedLeave instead, so
    // the honest caption is "nothing accrued yet", and it offers no button at all.
    expect(resolveEntitlementStatus(facts({ earnedMethod: true }))).toBe('earned_accrual');
    // It holds at zero days too: the engine tests `isEarnedMethod` BEFORE `days <= 0`, so earned wins.
    expect(resolveEntitlementStatus(facts({ earnedMethod: true, entitlementDays: 0 }))).toBe('earned_accrual');
    // Once the accrual sweep has posted something, the figure IS the answer and the caption goes away.
    expect(resolveEntitlementStatus(facts({ earnedMethod: true, hasAccrualRowInCycle: true }))).toBe('granted');
  });

  it('a table that resolves 0 days ⇒ zero_entitlement, never not_generated', () => {
    // core/leave.ts:6306 — `days <= 0` skips as `no_entitlement` and writes no row. A run repeats the skip
    // for as long as the table's service bands leave this employee uncovered, so the remedy is the TABLE.
    expect(resolveEntitlementStatus(facts({ entitlementDays: 0 }))).toBe('zero_entitlement');
    expect(resolveEntitlementStatus(facts({ entitlementDays: -1 }))).toBe('zero_entitlement');
  });

  it('earning method missing outranks EVERY state below it, including granted and earned_accrual', () => {
    // Before a run: telling HR "not generated" sends them to press Generate, which grants 0.00 and returns
    // them here. After a run: a 0.00 accrual row exists, and calling that "granted" is the silent zero the
    // item is about. One answer covers both, and it is the one HR can act on. The precedence over
    // `earned_accrual` mirrors accrueEarnedLeave's own gate (core/leave.ts:6910), which drops an
    // unconfigured type before it ever asks what its method column says.
    for (const hasAccrualRowInCycle of [false, true]) {
      for (const earnedMethod of [false, true]) {
        // r299 — …and a STRANDED earned method: the not-configured gate reads first and ignores the method.
        for (const earnedMethodNotAnnualLeave of earnedMethod ? [false, true] : [false]) {
          for (const entitlementDays of [0, 14]) {
            expect(
              resolveEntitlementStatus(
                facts({ accrualUnconfigured: true, hasAccrualRowInCycle, earnedMethod, earnedMethodNotAnnualLeave, entitlementDays }),
              ),
              `row=${hasAccrualRowInCycle}/earned=${earnedMethod}/stranded=${earnedMethodNotAnnualLeave}/days=${entitlementDays}`,
            ).toBe('earning_method_missing');
          }
        }
      }
    }
  });

  it('exactly one state offers a remedy; every other announced state explains instead', () => {
    // ⚠️ r209 GREW THIS LIST BY THREE, and the half of the original reasoning that survives is stated at
    // the bottom of this case rather than deleted with the line it justified.
    expect(ALL_STATUSES.filter(entitlementStatusNeedsNotice)).toEqual([
      'not_generated',
      'earned_accrual',
      'earned_method_not_annual_leave',
      'zero_entitlement',
      'earning_method_missing',
      'no_entitlement_table',
      'no_eligibility_match',
      'capped_by_max_balance',
    ]);
    // `granted` needs no caption — unchanged.
    expect(entitlementStatusNeedsNotice('granted')).toBe(false);
    // `not_configured` STAYS SILENT, but it no longer means what it meant when that was decided. The old
    // reasoning was "announcing it on every type a tenant never wrote a table for would bury the four that
    // matter" — and it was ALSO the answer for "the tables exist and no rule reaches you", which is a
    // defect, not a blank. That half is now `no_eligibility_match` and is announced; the "never wrote a
    // table" half is `no_entitlement_table` and is announced too, because it is a one-line answer to the
    // reporter's actual question. What is left under this name is a row with no breakdown AT ALL, which
    // has nothing to explain — and `resolveEntitlementStatus` never returns it.
    expect(entitlementStatusNeedsNotice('not_configured')).toBe(false);
    for (const f of [true, false]) {
      expect(resolveEntitlementStatus(facts({ leaveTypeHasTemplates: f }))).not.toBe('not_configured');
      expect(resolveEntitlementStatus(facts({ hasTemplateInForce: false, leaveTypeHasTemplates: f }))).not.toBe(
        'not_configured',
      );
    }
  });

  it('every status has a label; every announced status has an explanation', () => {
    for (const s of ALL_STATUSES) expect(ENTITLEMENT_STATUS_LABEL_KEY[s], s).toBeTruthy();
    // Exhaustive BOTH WAYS: an announced state with no tip renders a bare amber word with no explanation,
    // and a tip on a silent state is a string nothing can ever show.
    expect(Object.keys(ENTITLEMENT_STATUS_TIP_KEY).sort()).toEqual(
      ALL_STATUSES.filter(entitlementStatusNeedsNotice).sort(),
    );
  });
});

// ── The pure row derivation both balance grids share ────────────────────────────────────────────────

const balanceInput = (over: Partial<BalanceInput> = {}): BalanceInput => ({
  leaveTypeId: 'lt1',
  leaveType: 'Hospitalization Leave',
  color: null,
  icon: null,
  code: 'HOSP',
  balance: 0,
  available: 0,
  taken: 0,
  essView: {},
  ...over,
});

const breakdownInput = (status: EntitlementStatus): BreakdownInput => ({
  monthlyAccruedToDate: null,
  // r279 — this fixture describes a type with NO days resolved at all, so its full-year band is 0 too. That
  // is the honest reading for fifteen of the sixteen live leave types, and the grid prints it as 0.00.
  eligibleDays: 0,
  currentYearEntitlement: 0,
  carriedForward: 0,
  forfeited: 0,
  otherAdjustments: 0,
  configAdjustments: 0,
  entitlementStatus: status,
});

describe('deriveBalanceRow carries the status to every grid that shows a 0.00', () => {
  it('picks the server’s status through unchanged — it is never re-derived from the figures', () => {
    for (const s of ALL_STATUSES) {
      expect(deriveBalanceRow(balanceInput(), breakdownInput(s)).entitlementStatus, s).toBe(s);
    }
  });

  it('no breakdown loaded ⇒ not_configured, so no screen claims a table it never saw', () => {
    expect(deriveBalanceRow(balanceInput(), null).entitlementStatus).toBe('not_configured');
    expect(deriveBalanceRow(balanceInput(), null).ytdEntitled).toBeNull();
  });

  it('survives ESS hiding — the REASON for a zero is not one of the figures HR can hide', () => {
    // A tenant that hides Available/Taken from self-service still owes the employee an explanation for a
    // 0.00 entitlement. Blanking the caption with the figures would recreate the silence exactly.
    const row = deriveBalanceRow(
      balanceInput({ essView: { available: false, taken: false } }),
      breakdownInput('not_generated'),
    );
    expect(row.available).toBeNull();
    expect(row.taken).toBeNull();
    expect(row.entitlementStatus).toBe('not_generated');
  });
});

// ── End to end, against a real ledger ───────────────────────────────────────────────────────────────

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

/** A leave type whose code is NOT a standing code, so no statutory floor masks the table's decision.
 *  `unconfigured` stamps bc36c768's marker exactly as migration 0376 did on the reporter's account.
 *  `accrualMethod` is how the EARNED shape is built — the ordinary Annual Leave configuration, and the one
 *  the first cut of this feature mis-captioned. */
async function customLeaveType(
  code: string,
  name: string,
  opts: { unconfigured?: boolean; accrualMethod?: string } = {},
): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name,
      paid: true,
      accrualMethod: opts.accrualMethod ?? null,
      accrualUnconfigured: opts.unconfigured ? new Date('2026-01-01T00:00:00Z') : null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** One entitlement table for a type and NO eligibility rule — the reporter's Hospitalization shape, which
 *  r193's fault-3 fix made resolvable (exactly one table in force, nothing to choose between). */
const table = (leaveTypeId: string, days: number, validFrom: string, name: string) =>
  createEntitlementTemplate(adminCtx(b), {
    leaveTypeId,
    name,
    serviceBands: [{ fromYears: 0, toYears: null, days }],
    validFrom,
  });

/** Hired with NO hire grant, so the only entitlement that can reach the ledger is a year-open. */
const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'R196', primaryEmail: `r196_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });

const ASOF = '2026-12-31';

describe('31e39d74: the breakdown says WHY a leave type reads 0.00', () => {
  it('a table written in August, before Generate Entitlement is run ⇒ not_generated, and it names the table', async () => {
    const typeId = await customLeaveType('MED196', 'Medical Leave');
    await table(typeId, 14, '2026-08-01', 'Medical — all staff');
    const emp = await hire('2024-03-01');

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd).not.toBeNull();
    // The defect as reported: the figure IS zero. What changes is that the zero now carries a reason.
    expect(bd!.currentYearEntitlement).toBe(0);
    expect(bd!.entitlementStatus).toBe('not_generated');
    expect(bd!.entitlementTemplateName).toBe('Medical — all staff');
    // And it is not merely "nothing configured" — the table resolved, which is what makes 0.00 wrong.
    expect(bd!.eligibleDays).toBe(14);
  });

  it('running the year-open flips it to granted', async () => {
    const typeId = await customLeaveType('MED196', 'Medical Leave');
    await table(typeId, 14, '2026-08-01', 'Medical — all staff');
    const emp = await hire('2024-03-01');

    await openLeaveYear(adminCtx(b), { year: 2026 });

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.currentYearEntitlement).toBe(14);
    expect(bd!.entitlementStatus).toBe('granted');
  });

  it('a leave type with no table at all now SAYS SO — r209 replaced this case’s silence', async () => {
    // ⚠️ WHAT THIS CASE USED TO ASSERT, KEPT SO THE REVERSAL IS READABLE: `not_configured`, and
    // `entitlementStatusNeedsNotice(...) === false`, on the argument that "announcing this one on every
    // unconfigured type would bury the two that matter". r209 reversed it, because the reporter's question
    // was literally "why does this leave type show 0.00" and "no entitlement table has been set up" is a
    // one-line answer to it. The state also has its own name now, which is the load-bearing half.
    const typeId = await customLeaveType('UNCONF196', 'Unconfigured Leave');
    const emp = await hire('2024-03-01');

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.entitlementStatus).toBe('no_entitlement_table');
    expect(bd!.entitlementTemplateName).toBeNull();
    expect(entitlementStatusNeedsNotice(bd!.entitlementStatus)).toBe(true);
  });

  /**
   * ⚠️ THE PRODUCTION FAULT, END TO END, AND THE ONE THIS WORKSTREAM EXISTS FOR.
   *
   * Measured 2026-08-19: one `entitlement_eligibility_rule` tenant-wide, pointing at the PERMANENT Medical
   * table, `valid_to = 2026-08-13`. Two tables in force, so r193's sole-table fallback correctly does NOT
   * apply — several tables genuinely need a rule to choose between them. From 14 August nothing resolved
   * for anybody, and the screen said exactly what it says for a leave type nobody ever configured: nothing.
   */
  it('tables exist and the only eligibility rule has EXPIRED ⇒ no_eligibility_match, not silence', async () => {
    const typeId = await customLeaveType('MEDEXP209', 'Medical Leave');
    const permanent = await table(typeId, 14, '2026-01-01', 'Medical — permanent');
    await table(typeId, 18, '2026-01-01', 'Medical — contract');
    const emp = await hire('2024-03-01');

    // While the rule is in force the employee resolves to the table it names.
    const rule = await createEligibilityRule(adminCtx(b), {
      name: 'PERMANENT',
      templateLineageId: permanent.lineageId,
      criteria: {},
      validFrom: '2026-01-01',
    });
    const live = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, '2026-08-10');
    expect(live!.entitlementStatus).not.toBe('no_eligibility_match');
    expect(live!.entitlementTemplateName).toBe('Medical — permanent');

    // …and the day it ends, the same employee, the same tables, resolve to nothing.
    await retireEligibilityRule(adminCtx(b), { lineageId: rule.lineageId, validTo: '2026-08-13' });
    const after = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(after!.entitlementTemplateName).toBeNull();
    expect(after!.eligibleDays).toBe(0);
    // THE ASSERTION THE WHOLE ITEM TURNS ON. Before r209 this was `not_configured`, which is silent — the
    // two tables might as well not have existed, and nothing anywhere said the rule had lapsed.
    expect(after!.entitlementStatus).toBe('no_eligibility_match');
    expect(entitlementStatusNeedsNotice(after!.entitlementStatus)).toBe(true);
  });

  /**
   * ⚠️ THE SECOND EXIT, AND IT IS THE ONE PRODUCTION TAKES. `buildTemplateEntitlementResolver` captures
   * `hasTemplatesFor` before any short-circuit and returns it through `emptyWith(...)` at BOTH exits — and
   * only the first (`ruleRows.length === 0`, the expired-rule case above) was pinned. Reverting the second
   * to a bare `return empty;` left the whole r209 + r196 suite green, which means the fact the entire item
   * rests on had no guard on the path its own comment names as the production one.
   *
   * REACHING IT NEEDS TWO THINGS AND NOTHING ELSE: two or more tables in force (so r193's sole-table
   * fallback correctly does not apply) and every rule in force narrowing to a population this employee is
   * not in — plan 70ac09ef's open case, an employee on a grade the six grade-keyed Medical rules do not
   * name. `matchedByEmp` is then EMPTY while `templates` holds both tables.
   *
   * A regression here tells HR "No entitlement table for this leave type — create one" while two tables sit
   * in the database and the RULE is the thing to fix: the exact wrong instruction r209 exists to stop.
   */
  it('a rule in force that reaches NOBODY ⇒ no_eligibility_match, not "no entitlement table"', async () => {
    const typeId = await customLeaveType('MEDGRD209', 'Medical Leave');
    const permanent = await table(typeId, 14, '2026-01-01', 'Medical — permanent');
    await table(typeId, 18, '2026-01-01', 'Medical — contract');
    const [grade] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'EXEC209', name: 'Executive', rank: 1 })
      .returning({ id: schema.jobGrade.id });
    // In force, valid, and pointing at a table in force — so the rule list is NOT empty and the first exit
    // is not the one taken. It simply names a grade this employee is not on.
    await createEligibilityRule(adminCtx(b), {
      name: 'Executive only',
      templateLineageId: permanent.lineageId,
      criteria: { gradeIds: [grade.id] },
      validFrom: '2026-01-01',
    });
    const emp = await hire('2024-03-01');

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.entitlementTemplateName).toBeNull();
    expect(bd!.eligibleDays).toBe(0);
    // THE ASSERTION. `no_entitlement_table` here would be a lie about a type with two of them.
    expect(bd!.entitlementStatus).toBe('no_eligibility_match');
    expect(entitlementStatusNeedsNotice(bd!.entitlementStatus)).toBe(true);
  });

  /**
   * r209 — THE OTHER SILENT ZERO: a Maximum Balance of 0 over a table that grants days.
   *
   * The six Special Leave types on the reporter's account are `{days: 3, maxBalanceDays: 0}`. The year-open
   * grants 3, `applyMaxBalance` clamps it to 0.00, and the accrual ROW IS STILL WRITTEN — so every
   * row-counting reading of the ledger says "generated" over a figure of zero. The cap's meaning is
   * untouched here; only the silence is.
   */
  it('a table granting 3 days under a Maximum Balance of 0 reads capped_by_max_balance, not granted', async () => {
    const typeId = await customLeaveType('SPEC209', 'Marriage Leave');
    await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'Marriage — all staff',
      serviceBands: [{ fromYears: 0, toYears: null, days: 3, carryForwardDays: 0, maxBalanceDays: 0 }],
      validFrom: '2026-01-01',
    });
    const emp = await hire('2024-03-01');

    await openLeaveYear(adminCtx(b), { year: 2026 });

    // The clamp really happened: the row exists and it is worth nothing.
    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.eligibleDays).toBe(3);
    expect(bd!.currentYearEntitlement).toBe(0);
    expect(bd!.entitlementStatus).toBe('capped_by_max_balance');
    expect(entitlementStatusNeedsNotice(bd!.entitlementStatus)).toBe(true);
  });

  it('an earned type is NEVER told to press Generate Entitlement — the run skips it, forever', async () => {
    // ⚠️ THE REGRESSION CASE. This is the ORDINARY Annual Leave shape: an entitlement table plus an
    // `earned_monthly` method. `openLeaveYear` logs `earned_method` (core/leave.ts:6302) and writes no
    // ledger row — not "not yet", but NEVER: the days are accrueEarnedLeave's business. The first cut read
    // "table in force + no accrual row" as "not generated" and captioned every employee's Annual Leave with
    // an instruction that would skip their type. The assertions below are, in order: the caption is the
    // earned one · running the remedy really does nothing · the accrual sweep is what moves it.
    // The SEEDED ANNUAL type, not a custom one, and that is load-bearing: `accrueEarnedLeave` sweeps only
    // Annual Leave (`isEarnedAccrualType` since r299 — role first, the code ANNUAL for an unclassified row),
    // so an unclassified made-up code would sit at `earned_accrual` forever and the last leg of this case
    // would prove nothing. This is the reporter's real shape.
    const typeId = b.annualLeaveTypeId;
    await owner.db
      .update(schema.leaveType)
      .set({ accrualMethod: 'earned_monthly' })
      .where(eq(schema.leaveType.id, typeId));
    await table(typeId, 12, '2026-01-01', 'Annual — all staff');
    const emp = await hire('2024-03-01');

    const before = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, '2026-03-31');
    expect(before!.entitlementStatus).toBe('earned_accrual');
    // Not the old answer, and this is the assertion the fix exists for.
    expect(before!.entitlementStatus).not.toBe('not_generated');
    expect(before!.entitlementTemplateName).toBe('Annual — all staff');
    // The table IS configured and DOES resolve — so this is not `not_configured` either.
    expect(before!.eligibleDays).toBe(12);

    // PRESS THE BUTTON THE OLD CAPTION POINTED AT. It grants nothing, which is exactly why pointing at it
    // was wrong: the ledger is untouched and the caption must not change.
    const res = await openLeaveYear(adminCtx(b), { year: 2026, leaveTypeIds: [typeId] });
    expect(
      res.rows.filter((r) => r.leaveTypeId === typeId && r.employmentId === emp.employmentId).map((r) => r.outcome),
    ).toEqual(['earned_method']);
    const afterRun = await owner.db
      .select({ entryType: schema.leaveLedger.entryType })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.leaveTypeId, typeId));
    expect(afterRun).toEqual([]);
    const stillEarned = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, '2026-03-31');
    expect(stillEarned!.entitlementStatus).toBe('earned_accrual');

    // The sweep that DOES move it. Once days have accrued the figure is the answer and the caption goes.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-31', leaveTypeIds: [typeId] });
    const accrued = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, '2026-03-31');
    expect(accrued!.currentYearEntitlement).toBeGreaterThan(0);
    expect(accrued!.entitlementStatus).toBe('granted');
    expect(entitlementStatusNeedsNotice(accrued!.entitlementStatus)).toBe(false);
  });

  it('a table whose bands cover nobody at this service length ⇒ zero_entitlement, not not_generated', async () => {
    // core/leave.ts:6306 — composed days of 0 are skipped as `no_entitlement` with no ledger row, on this
    // run and on every future one. The remedy is the TABLE's service bands, so the caption names those
    // rather than a sweep that will keep skipping.
    const typeId = await customLeaveType('MAR196', 'Marriage Leave');
    // Bands must start at 0 and be contiguous (validateServiceBands), so a "band gap" is expressed the way
    // HR actually expresses it: a leading band worth nothing until the service threshold is reached.
    await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'Marriage — five years’ service',
      serviceBands: [
        { fromYears: 0, toYears: 5, days: 0 },
        { fromYears: 5, toYears: null, days: 3 },
      ],
      validFrom: '2026-01-01',
    });
    const emp = await hire('2025-06-01'); // ~0.6 years at the cycle start — inside the 0-day band

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.entitlementTemplateName).toBe('Marriage — five years’ service');
    expect(bd!.eligibleDays).toBe(0);
    expect(bd!.entitlementStatus).toBe('zero_entitlement');

    // And the run really does skip it, which is what makes "not generated" the wrong word.
    const res = await openLeaveYear(adminCtx(b), { year: 2026, leaveTypeIds: [typeId] });
    expect(
      res.rows.filter((r) => r.leaveTypeId === typeId && r.employmentId === emp.employmentId).map((r) => r.outcome),
    ).toEqual(['no_entitlement']);
    const after = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(after!.entitlementStatus).toBe('zero_entitlement');
  });

  it('the Hospitalization shape: a table, no earning method — said BEFORE and AFTER a generation run', async () => {
    // THE CASE THE ITEM EXISTS FOR. On the reporter's account Hospitalization has exactly one table and no
    // earning method, so a year-open writes a 0.00 accrual row (it is the idempotency marker) and every
    // sum-based reading of the ledger reports "granted 0.00" — the silent zero, one layer deeper.
    const typeId = await customLeaveType('HOSP196', 'Hospitalization Leave', { unconfigured: true });
    await table(typeId, 60, '2026-01-01', 'Hospitalization — all staff');
    const emp = await hire('2024-03-01');

    const before = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(before!.entitlementStatus).toBe('earning_method_missing');

    await openLeaveYear(adminCtx(b), { year: 2026 });

    // The 0.00 marker row really is there — this is what would fool a sum-based or row-count-only test.
    const ledger = await owner.db
      .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.leaveTypeId, typeId));
    expect(ledger.filter((r) => r.entryType === 'accrual').map((r) => Number(r.days))).toEqual([0]);

    const after = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(after!.currentYearEntitlement).toBe(0);
    expect(after!.entitlementStatus).toBe('earning_method_missing');
    // Surfaced, never fixed: the marker is exactly as HR left it (the plan's explicit instruction).
    const [lt] = await owner.db
      .select({ marker: schema.leaveType.accrualUnconfigured })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, typeId));
    expect(lt.marker).not.toBeNull();
  });

  it('a mid-year joiner reads not_generated too — they are in the leave year (r193 fault 2)', async () => {
    const typeId = await customLeaveType('MED196', 'Medical Leave');
    await table(typeId, 14, '2026-01-01', 'Medical — all staff');
    const emp = await hire('2026-05-04');

    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(bd!.entitlementStatus).toBe('not_generated');

    await openLeaveYear(adminCtx(b), { year: 2026 });
    const after = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    expect(after!.entitlementStatus).toBe('granted');
  });

  it('the status is dated at asOf, so a table is never claimed for a period it did not cover', async () => {
    // ⚠️ THIS CASE FAILED FIRST TIME ROUND AND THE CODE WAS RIGHT. The obvious expectation — "before the
    // run it says not_generated, at every date" — is wrong and would be a NEW false alarm: as at 31 July a
    // table dated 1 August is not in force, nothing was owed, and 0.00 is the correct and complete answer.
    // Announcing "configured but not yet generated" for a period the table never covered would send HR
    // chasing an entitlement that did not exist then. The status is resolved through the SAME dated
    // template resolver every other figure in this breakdown uses, which is what makes that fall out.
    const typeId = await customLeaveType('MED196', 'Medical Leave');
    await table(typeId, 14, '2026-08-01', 'Medical — all staff');
    const emp = await hire('2024-03-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const july = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, '2026-07-31');
    const december = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, typeId, ASOF);
    // r209: the status is DATED, and so is the split. As at 31 July this leave type had no entitlement
    // table IN FORCE — the one that exists starts on 1 August — so the answer is `no_entitlement_table`,
    // not "the tables exist and no rule reaches you". Still not "not generated yet", which is the mistake
    // this case was written to prevent.
    expect(july!.entitlementStatus).toBe('no_entitlement_table');
    expect(july!.entitlementTemplateName).toBeNull();
    expect(december!.entitlementStatus).toBe('granted');
    expect(december!.entitlementTemplateName).toBe('Medical — all staff');
  });
});

// ── The surfaces the reporter listed ────────────────────────────────────────────────────────────────

describe('31e39d74: every surface that shows the figure also shows the reason', () => {
  it('My Leave’s balance grid captions the YTD Entitled cell without displacing the figure', () => {
    const src = read('components/leave/leave-balance-table.tsx');
    expect(src).toContain('entitlementStatusNeedsNotice(r.entitlementStatus)');
    expect(src).toContain('ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]');
    expect(src).toContain('ENTITLEMENT_STATUS_TIP_KEY[r.entitlementStatus]');
    // The number stays: an ungenerated type with a carry-in still has REAL figures on the row and replacing
    // one with the caption would be a second wrong reading.
    // ⚠️ r279 CORRECTED THE ARITHMETIC THIS COMMENT DESCRIBED: the cell is currentYearEntitlement ALONE now
    // (the carry has its own column), and the label under which it renders is "Earned to Date".
    expect(src).toContain('{fmt(r.ytdEntitled)}');
  });

  it('Employee Balances captions the same cell, in the same column count', () => {
    const src = read('app/leave/employee-balances/page.tsx');
    expect(src).toContain('entitlementStatusNeedsNotice(r.entitlementStatus)');
    expect(src).toContain('{num(r.ytdEntitled)}');
    // ⚠️ THIRTEEN SINCE r279, AND THE CLAIM THIS PINS IS UNCHANGED: the header row and the empty-state
    // colSpan must agree, whatever the count is. 1ff969ed added the Explanation column and r279 added the
    // Full Entitlement figure, so the number moved twice and this assertion moved with it (AGENTS 18 — a
    // guard that pins the arrangement being replaced gets UPDATED, never deleted).
    expect(src).toContain('colSpan={13}');
  });

  it('the export carries it as a column, so the file cannot disagree with the screen', () => {
    const src = read('app/leave/employee-balances/export/route.ts');
    expect(src).toContain("tInq('colEntitlementStatus')");
    expect(src).toContain('tMe(ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus])');
    // Header and cell must move together — a column added to one list only silently shifts every figure.
    const columns = src.slice(src.indexOf('columns: ['), src.indexOf('rows: rows.map'));
    const cells = src.slice(src.indexOf('rows: rows.map'));
    expect(columns.includes('colEntitlementStatus')).toBe(true);
    expect(cells.includes('ENTITLEMENT_STATUS_LABEL_KEY')).toBe(true);
  });

  it('the balance breakdown panel states it in full, above the column of figures', () => {
    const src = read('components/leave/LeaveDetailsPanel.tsx');
    expect(src).toContain('entitlementStatusNeedsNotice(data.entitlementStatus)');
    expect(src).toContain("statusNotGeneratedTitle");
    expect(src).toContain("statusEarningMethodMissingTitle");
    expect(src).toContain("t('statusEntitlementTable', { name: data.entitlementTemplateName })");
    // It is NOT a descriptor field: ENTITLEMENT_PANEL_SECTIONS is the reconciliation column, and every
    // entry in it is a signed addend that must close onto Available Balance. A status is not an addend.
    expect(read('components/leave/entitlement-panel-config.ts')).not.toContain('entitlementStatus');
  });

  it('the HR-side personnel record captions it too — an em dash is not an answer either', () => {
    const src = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(src).toContain('entitlementStatusNeedsNotice(st)');
    expect(src).toContain('ENTITLEMENT_STATUS_LABEL_KEY[st]');
  });

  it('the derivation is DB-free and framework-free, so server and client share one definition', () => {
    const src = read('lib/entitlement-status.ts');
    expect(src).not.toContain('drizzle-orm');
    expect(src).not.toContain("from 'react'");
    expect(src).not.toContain('use client');
    expect(src).not.toContain('@/db');
  });

  it('the panel has copy for EVERY announced state — none of them borrows another’s remedy', () => {
    // The map is `Partial<Record<…>>`, so a status added to the union without copy here is a TypeScript
    // success and a runtime crash on `PANEL_STATUS_COPY[status]!.title`. This is the check that catches it.
    const src = read('components/leave/LeaveDetailsPanel.tsx');
    const map = src.slice(src.indexOf('const PANEL_STATUS_COPY'), src.indexOf('export function LeaveDetailsPanel'));
    for (const s of ALL_STATUSES.filter(entitlementStatusNeedsNotice)) {
      expect(map, `panel copy for ${s}`).toContain(`${s}: { title:`);
    }
    // And the silent two must NOT be in it — an entry nothing can render is a claim the panel never makes.
    for (const s of ALL_STATUSES.filter((x) => !entitlementStatusNeedsNotice(x))) {
      expect(map, `panel copy for ${s}`).not.toContain(`${s}: { title:`);
    }
  });

  it('only ONE state’s English copy sends the reader to Generate Entitlement', () => {
    // THE FINDING, AS AN ASSERTION ABOUT WORDS. `earned_accrual` and `zero_entitlement` are states where a
    // year-open skips the type, so their copy must say what actually moves the figure, and `not_generated`
    // — the one state where the button IS the answer — must also disclose the two no-row branches this
    // derivation cannot see (frozen for encashment, country pack inactive), rather than promising a fix.
    const bal = (msgs('en') as unknown as { me: { leaveBalanceTable: Record<string, string> } }).me
      .leaveBalanceTable;
    expect(REMEDY_STATUS).toBe('not_generated');
    expect(bal[ENTITLEMENT_STATUS_TIP_KEY[REMEDY_STATUS]!]).toContain('Run Generate Entitlement');
    expect(bal[ENTITLEMENT_STATUS_TIP_KEY[REMEDY_STATUS]!]).toContain('frozen');
    expect(bal[ENTITLEMENT_STATUS_TIP_KEY[REMEDY_STATUS]!]).toContain('country pack');
    // Neither of the two skip states may be phrased as an instruction to run it.
    // r301 (e5018593) — Generate Entitlement now ADDS what an earned Annual Leave type has earned so far, so the
    // copy no longer says it does not grant it; it still must not read as the one instruction to run it.
    expect(bal.statusEarnedAccrualTip).toContain('nothing has been posted for this leave year yet');
    expect(bal.statusEarnedAccrualTip).not.toContain('Run Generate Entitlement');
    expect(bal.statusZeroEntitlementTip).toContain('will not change the figure');
    expect(bal.statusZeroEntitlementTip).not.toContain('Run Generate Entitlement');
    // r299 — the stranded state skips the year-open too, and nothing else adds its days either.
    expect(bal.statusEarnedMethodNotAnnualLeaveTip).not.toContain('Run Generate Entitlement');
  });

  it('ships every string in all six locales', () => {
    const balanceKeys = [
      'statusGenerated',
      'statusNotGenerated',
      'statusEarnedAccrual',
      'statusZeroEntitlement',
      'statusEarningMethodMissing',
      'statusNotConfigured',
      'statusNotGeneratedTip',
      'statusEarnedAccrualTip',
      'statusZeroEntitlementTip',
      'statusEarningMethodMissingTip',
      'statusEarnedMethodNotAnnualLeave',
      'statusEarnedMethodNotAnnualLeaveTip',
    ];
    const breakdownKeys = [
      'statusNotGeneratedTitle',
      'statusNotGeneratedBody',
      'statusEarnedAccrualTitle',
      'statusEarnedAccrualBody',
      'statusZeroEntitlementTitle',
      'statusZeroEntitlementBody',
      'statusEarningMethodMissingTitle',
      'statusEarningMethodMissingBody',
      'statusEarnedMethodNotAnnualLeaveTitle',
      'statusEarnedMethodNotAnnualLeaveBody',
      'statusEntitlementTable',
    ];
    for (const loc of LOCALES) {
      const m = msgs(loc) as unknown as {
        me: { leaveBalanceTable: Record<string, string> };
        leave: { breakdown: Record<string, string>; inquiry: Record<string, string> };
      };
      for (const k of balanceKeys) expect(m.me.leaveBalanceTable?.[k], `${loc} me.leaveBalanceTable.${k}`).toBeTruthy();
      for (const k of breakdownKeys) expect(m.leave.breakdown?.[k], `${loc} leave.breakdown.${k}`).toBeTruthy();
      expect(m.leave.inquiry?.colEntitlementStatus, `${loc} leave.inquiry.colEntitlementStatus`).toBeTruthy();
      // Every status the code can produce must have a label to print in that locale.
      for (const s of ALL_STATUSES) {
        expect(m.me.leaveBalanceTable?.[ENTITLEMENT_STATUS_LABEL_KEY[s]], `${loc} label for ${s}`).toBeTruthy();
      }
      expect(m.leave.breakdown.statusEntitlementTable).toContain('{name}');
    }
  });
});
