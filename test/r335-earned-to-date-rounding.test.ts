/**
 * r335 (board 6af80f5d) — "EARNED TO DATE" IS SHOWN THROUGH THE LEAVE TYPE'S ROUNDING RULE.
 *
 * THE REPORT. Employee Balances printed the raw accrual running total in the Earned to Date column while
 * the Explain panel, one click away, already NAMED the rounding rule behind it: `derivation.earned.rounding`
 * has reported `policy.roundingMethod` — `custom_no_table` included — since r303. The rule was REPORTED and
 * never APPLIED. EMP-0004 / Annual Leave / as at 23-09-2026 read 11.18 under a custom table whose first band
 * maps the decimals 0.00–0.38 to 0.00, i.e. 11.00.
 *
 * HOW A RAW FIGURE SURVIVES AN ENGINE THAT ROUNDS AT SOURCE (b81d3c52). `accrueEarnedLeave` rounds the
 * CUMULATIVE every period and then tops up by `toGrant = earnedToDate − already`, and the `toGrant > 0`
 * guard never posts a NEGATIVE top-up — the forward-only contract written beside that call. Days credited
 * BEFORE a rounding table was configured are therefore never clawed back, and the cycle keeps its raw
 * running total for the rest of the year. §2 reproduces exactly that shape.
 *
 * ⚠️ WHAT THIS ITEM DELIBERATELY DID NOT DO, AND THE GUARD THAT KEEPS IT THAT WAY.
 * Revision 1 of the plan promised "one number everywhere", with the rounded figure flowing into the Balance
 * column too. That breaks a stated invariant: `currentYearEntitlement` is one of the six buckets that TILE
 * the ledger, `totalEntitlement = broughtForward + currentYearEntitlement + adjustments` is an identity
 * rather than an agreement (core/read.ts), and the balance is surfaced from the ledger and never re-derived
 * (components/leave/leave-balance-row.ts, 6574c6b4). So the rounding is applied to a DISPLAY field derived
 * beside the exact one, and §3 pins `totalEntitlement` byte-unchanged by the rounding rule — that assertion
 * is what fails the moment somebody rounds `cycleAccrual` at source.
 *
 * The consequence is stated openly rather than papered over: the reporter's row reads Earned to Date 11.00
 * beside Balance 6.18, and both are true.
 *
 * §1 the rule, applied by the kernel's own engine — band edges inclusive at both ends, a whole value never
 *    moved, No Rounding byte-identical, and `custom` with no table a no-op;
 * §2 the reporter's case end to end, from the ledger through the breakdown to the grid row;
 * §3 the invariant: the exact bucket, `totalEntitlement` and the reconciliation identity are untouched;
 * §4 the surfaces that must agree — the grid column, the employee's own card, the Explain panel;
 * §5 the new sub-line resolves in all six locales and carries the figure.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { displayEarnedToDateDays } from '../core/leave';
import type { RoundingBand } from '../core/leave-compute';
import { leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import { myLeaveDashboard } from '../core/my-leave';
import { deriveBalanceRow, type BreakdownInput } from '../components/leave/leave-balance-row';
import {
  ENTITLEMENT_PANEL_SECTIONS,
  RECONCILIATION_ADDENDS,
  reconciledBalance,
  type PanelData,
} from '../components/leave/entitlement-panel-config';
import type { EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';
import { formatDays } from '../lib/day-format';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * PRODUCTION'S OWN TABLE, measured on 2026-09-24 — THREE rows, not the four the ticket sketched. Both
 * shapes answer 11.00 for 11.18; this file asserts against the one the tenant actually stores, because a
 * fixture that "corrects" production is a fixture that stops describing it.
 */
const PRODUCTION_BANDS: RoundingBand[] = [
  { from: 0, to: 0.38, result: 0 },
  { from: 0.39, to: 0.68, result: 0.5 },
  { from: 0.69, to: 0.99, result: 1 },
];

/** The reporter's figures. Earned 11.18 with 5.00 taken leaves a real ledger balance of 6.18. */
const RAW_EARNED = 11.18;
const TAKEN = 5;
const ROUNDED_EARNED = 11;
const BALANCE = 6.18;

// No hardcoded future dates (CLAUDE.md §8): the reporter's shape is "a date inside the current leave year",
// so every date here is derived from the clock. The employee joined the PREVIOUS year, so nothing prorates
// and the Entitlement column is the band itself — which keeps this file about rounding and nothing else.
const TODAY = todayInKualaLumpur();
const YEAR = Number(TODAY.slice(0, 4));
const CYCLE_START = `${YEAR}-01-01`;
const HIRED_ON = `${YEAR - 1}-01-01`;

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

/** Rule columns on the ANNUAL type — since 9816a5ad step 2, where every RULE is read from. Written directly
 *  rather than through `setLeaveTypeRules` for the reason test/leave-entitlement-rounding.test.ts gives: the
 *  fixture is describing a STORED world for the engines to read. */
const setTypeRules = (rules: Partial<typeof schema.leaveType.$inferInsert>) =>
  owner.db.update(schema.leaveType).set(rules).where(eq(schema.leaveType.id, b.annualLeaveTypeId));

const accrualRows = (employmentId: string) =>
  owner.db
    .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
      ),
    );

const post = (employmentId: string, entryType: 'accrual' | 'debit', days: number, effectiveOn: string) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
  });

/**
 * THE PRODUCTION SHAPE, built the way production got there: an EARNED type (so the hire grant writes
 * nothing), a raw cumulative already on the ledger, and the rounding table configured AFTERWARDS. The
 * accrual sweep can never take those 0.18 days back — see the header — so the raw figure is what every
 * ledger-derived screen reads.
 */
async function reporterCase(opts: { rounding?: 'custom' | 'none'; bands?: RoundingBand[] | null } = {}) {
  await seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 20,
    validFrom: CYCLE_START,
  });
  await setTypeRules({ accrualMethod: 'earned_daily' });
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'EMP-0004', primaryEmail: `r335_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: HIRED_ON,
    gradeId: null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });
  // An earned type gets nothing from the hire grant (d58bfa3f measured it); assert rather than assume, so
  // the ledger below is provably only what this fixture posted.
  expect(await accrualRows(e.employmentId)).toEqual([]);
  await post(e.employmentId, 'accrual', RAW_EARNED, CYCLE_START);
  await post(e.employmentId, 'debit', -TAKEN, CYCLE_START);
  if (opts.rounding === 'custom') {
    await setTypeRules({ roundingMethod: 'custom', roundingBands: opts.bands === undefined ? PRODUCTION_BANDS : opts.bands });
  }
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: ['employee'] };
  return { ...e, ctx };
}

const breakdownFor = (employmentId: string) =>
  leaveEntitlementBreakdown(adminCtx(b), employmentId, b.annualLeaveTypeId, TODAY, 'en', { derivation: true });

// ── §1 the rule, applied by the kernel's own engine ───────────────────────────────────────────────────
describe('r335 §1 · displayEarnedToDateDays is applyRounding, not a sixth hand-written band walk', () => {
  const custom = (v: number, bands: unknown = PRODUCTION_BANDS) =>
    displayEarnedToDateDays(v, { method: 'custom', threshold: null, bands });

  it("the reporter's figure: 11.18 falls in the first band and is shown as 11.00", () => {
    expect(custom(RAW_EARNED)).toBe(ROUNDED_EARNED);
  });

  it('band edges are inclusive at BOTH ends — 0.38 lands in the first band, 0.39 in the second', () => {
    // The whole point of the reporter's table is where one band stops and the next starts. 0.38 → 0.00 and
    // 0.39 → 0.50 is the boundary a hand-written `<` would get wrong by exactly one hundredth.
    expect(custom(11.38)).toBe(11);
    expect(custom(11.39)).toBe(11.5);
    // …and the far ends of the other two rows, so "inclusive at both ends" is asserted, not sampled once.
    expect(custom(11.68)).toBe(11.5);
    expect(custom(11.69)).toBe(12);
    expect(custom(11.99)).toBe(12);
    expect(custom(11.01)).toBe(11);
  });

  it('a WHOLE value is never moved, however inflating the table looks', () => {
    // applyRoundingBands returns before any lookup when the decimal is 0 — without that guard a first band
    // of 0.00→0.38 ⇒ 0.00 would still be harmless, but one of 0.00→0.50 ⇒ 0.50 would hand half a day to
    // everybody whose figure came out exact.
    for (const whole of [0, 1, 11, 20]) expect(custom(whole)).toBe(whole);
    expect(displayEarnedToDateDays(11, { method: 'custom', bands: [{ from: 0, to: 0.99, result: 1 }] })).toBe(11);
  });

  it('NO ROUNDING is byte-identical to today, for every method value and none at all', () => {
    for (const method of ['none', null, undefined, 'nearest', 'half_up']) {
      expect(displayEarnedToDateDays(RAW_EARNED, { method: method as string | null | undefined })).toBe(RAW_EARNED);
    }
    expect(displayEarnedToDateDays(RAW_EARNED, null)).toBe(RAW_EARNED);
    expect(displayEarnedToDateDays(RAW_EARNED)).toBe(RAW_EARNED);
  });

  it("'custom' with NO table does not round — the `custom_no_table` state the panel already reports", () => {
    // core/read.ts reports this state to the Explain panel as `custom_no_table`. Refusing to round on a
    // table nobody could validate is the defensive contract applyRoundingBands already carries; this
    // asserts the display path inherits it rather than inventing a fallback.
    expect(custom(RAW_EARNED, null)).toBe(RAW_EARNED);
    // An ABSENT `bands` property, not the helper's default argument — this is the shape core/read.ts hands
    // over when `policy.roundingBands` is null.
    expect(displayEarnedToDateDays(RAW_EARNED, { method: 'custom' })).toBe(RAW_EARNED);
    expect(custom(RAW_EARNED, [])).toBe(RAW_EARNED);
    expect(custom(RAW_EARNED, 'not a table')).toBe(RAW_EARNED);
  });
});

// ── §2 the reporter's case, end to end ────────────────────────────────────────────────────────────────
describe("r335 §2 · the reporter's row: Earned to Date 11.00 with the Balance still 6.18", () => {
  it('the grid row shows the rounded figure and the EXACT balance in the SAME row', async () => {
    const e = await reporterCase({ rounding: 'custom' });
    const bd = await breakdownFor(e.employmentId);

    // The ledger is untouched and still holds the raw running total.
    expect(bd!.currentYearEntitlement).toBe(RAW_EARNED);
    expect(bd!.currentYearEntitlementRounded).toBe(ROUNDED_EARNED);
    expect(bd!.balance).toBe(BALANCE);

    const [bal] = (await leaveBalances(adminCtx(b), e.employmentId, 'en', { asOf: TODAY })).filter(
      (x) => x.leaveTypeId === b.annualLeaveTypeId,
    );
    const row = deriveBalanceRow({ ...bal, essView: {} }, bd as unknown as BreakdownInput);
    expect(row.ytdEntitled, 'Earned to Date').toBe(ROUNDED_EARNED);
    expect(row.balance, 'Balance stays exact — it is an identity, not an agreement').toBe(BALANCE);
    expect(row.taken).toBe(TAKEN);
    // The two figures in one row deliberately do NOT add up: 11.00 − 5.00 is 6.00 and the Balance is 6.18.
    // That is the decision this item made, stated as an assertion so nobody "fixes" it silently later.
    expect(row.ytdEntitled! - row.taken!).not.toBe(row.balance);
  });

  it('the panel REPORTS the rule and now a figure is actually put through it', async () => {
    const e = await reporterCase({ rounding: 'custom' });
    const bd = await breakdownFor(e.employmentId);
    // The asymmetry this item closed: `derivation.earned.rounding` has always named the rule.
    expect(bd!.derivation!.earned.rounding).toBe('custom');
    expect(bd!.currentYearEntitlementRounded).not.toBe(bd!.currentYearEntitlement);
  });

  it("with NO rounding rule the figure is byte-identical to today, on every surface", async () => {
    const e = await reporterCase();
    const bd = await breakdownFor(e.employmentId);
    expect(bd!.derivation!.earned.rounding).toBe('none');
    expect(bd!.currentYearEntitlementRounded).toBe(bd!.currentYearEntitlement);
    expect(bd!.currentYearEntitlementRounded).toBe(RAW_EARNED);
  });

  it("'custom' with a NULL table leaves the figure exactly as the ledger holds it", async () => {
    const e = await reporterCase({ rounding: 'custom', bands: null });
    const bd = await breakdownFor(e.employmentId);
    expect(bd!.derivation!.earned.rounding, 'the panel says so in as many words').toBe('custom_no_table');
    expect(bd!.currentYearEntitlementRounded).toBe(RAW_EARNED);
  });
});

// ── §3 the invariant — the regression guard for revision 1 ────────────────────────────────────────────
describe('r335 §3 · the ledger bucket, totalEntitlement and the reconciliation identity are UNTOUCHED', () => {
  it('totalEntitlement is byte-identical with the rounding rule on and off', async () => {
    // ⚠️ THIS IS THE GUARD THAT FAILS IF SOMEBODY ROUNDS `cycleAccrual` AT SOURCE. `totalEntitlement` is
    // built from the exact bucket; a rounded bucket would move it from 11.18 to 11.00 and the six-bucket
    // tiling would stop closing onto the real balance.
    const off = await breakdownFor((await reporterCase()).employmentId);
    await resetDb();
    b = await seedBase();
    const on = await breakdownFor((await reporterCase({ rounding: 'custom' })).employmentId);

    expect(on!.currentYearEntitlement).toBe(off!.currentYearEntitlement);
    expect(on!.totalEntitlement).toBe(off!.totalEntitlement);
    expect(on!.balance).toBe(off!.balance);
    expect(on!.totalAvailable).toBe(off!.totalAvailable);
    expect(on!.adjustments).toBe(off!.adjustments);
    // …and the rounded figure is the ONLY field that moved.
    expect(on!.currentYearEntitlementRounded).not.toBe(off!.currentYearEntitlementRounded);
  });

  it('Σ(addends · sign) still equals the balance, with the rounding rule in force', async () => {
    const e = await reporterCase({ rounding: 'custom' });
    const bd = await breakdownFor(e.employmentId);
    const data = bd as unknown as EntitlementBreakdownData;
    expect(reconciledBalance(data)).toBe(bd!.balance);
    expect(bd!.broughtForward + bd!.currentYearEntitlement + bd!.adjustments).toBe(bd!.totalEntitlement);
    // The rounded figure is NOT an addend, and must never become one.
    expect(RECONCILIATION_ADDENDS.map((a) => a.key)).not.toContain('currentYearEntitlementRounded');
  });
});

// ── §4 the surfaces that must agree ───────────────────────────────────────────────────────────────────
describe('r335 §4 · one person, one number: the grid, the employee card and the Explain panel', () => {
  it("the employee's own 'Earned so far' card shows what HR's grid shows", async () => {
    const e = await reporterCase({ rounding: 'custom' });
    const dash = await myLeaveDashboard(e.ctx, e.employmentId, { today: TODAY });
    const card = dash.cards.find((c) => c.leaveTypeId === b.annualLeaveTypeId)!;
    expect(card.earnedSoFar).toBe(ROUNDED_EARNED);
    // The card's own Balance is untouched and still exact, exactly as the grid's is.
    expect(card.balance).toBe(BALANCE);
  });

  const summaryField = (key: string) =>
    ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'summary')!.fields!.find((f) => f.key === key)!;

  it('the Explain panel carries BOTH figures: the exact one in the sum, the rounded one beside it', async () => {
    const e = await reporterCase({ rounding: 'custom' });
    const bd = await breakdownFor(e.employmentId);
    const data: PanelData = {
      breakdown: bd as unknown as EntitlementBreakdownData,
      summary: { available: bd!.totalAvailable },
    };
    const f = summaryField('ytdEntitled');
    // The ADDEND is the exact figure — otherwise the column contradicts the Total printed under it.
    expect(f.select!(data)).toBe(RAW_EARNED);
    expect(summaryField('total').select!(data)).toBe(RAW_EARNED);
    // …and the rounded figure is the labelled sub-line under it.
    expect(f.noteSelect!(data)).toBe(formatDays(ROUNDED_EARNED));
    expect(f.noteLabelKey).toBe('roundedTo');
  });

  it('the sub-line is ABSENT when rounding did not move the figure', async () => {
    const e = await reporterCase();
    const bd = await breakdownFor(e.employmentId);
    const data: PanelData = {
      breakdown: bd as unknown as EntitlementBreakdownData,
      summary: { available: bd!.totalAvailable },
    };
    expect(summaryField('ytdEntitled').noteSelect!(data)).toBeNull();
  });

  it('the rounded figure rides on the ytdEntitled ESS key — it never became a tenth switch', () => {
    // Two switches for one number would let a tenant show the rounded figure and hide the exact one. The
    // sub-line hides and shows with the figure it is about, so the admin checklist and the HR explanation
    // key set (core/leave-formula.ts) are untouched by this item.
    const f = summaryField('ytdEntitled');
    expect(f.essKey).toBe('ytdEntitled');
    expect(summaryField('ytdEntitled').key).toBe('ytdEntitled');
    const src = readFileSync(`${root}core/ess-view.ts`, 'utf8');
    expect(src).not.toMatch(/currentYearEntitlementRounded|roundedTo/);
  });

  it('nothing re-reads a rounding table outside the kernel', async () => {
    // The drift §1 of CLAUDE.md is about: the grid and the card PICK, they never resolve.
    for (const rel of ['components/leave/leave-balance-row.ts', 'core/my-leave.ts']) {
      expect(readFileSync(`${root}${rel}`, 'utf8'), rel).not.toMatch(/\bapplyRounding(Bands)?\(/);
    }
  });
});

// ── §5 the new string, in all six locales ─────────────────────────────────────────────────────────────
describe('r335 §5 · the rounded sub-line resolves in every locale and carries the figure', () => {
  for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const) {
    it(`${loc} has leave.breakdown.roundedTo with a {value} placeholder`, () => {
      const msg = JSON.parse(readFileSync(`${root}messages/${loc}.json`, 'utf8')).leave.breakdown.roundedTo;
      expect(typeof msg, loc).toBe('string');
      expect(msg, loc).toContain('{value}');
      // The panel passes an already-formatted day string; a message that asked for {date} would print the
      // expiry argument instead, so the placeholder name is part of the contract.
      expect(msg, loc).not.toContain('{date}');
    });
  }
});
