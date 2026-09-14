/**
 * Leave Balance workday-style summary table (feedback 483fa7c3).
 *
 * DB-free / jsdom-free (the suite has no DOM runner). Proves the item's CORE behaviour: the ten-column
 * Workday-style table is driven by two PURE helpers — deriveBalanceRow (the single source of truth for every
 * column, incl. the derived Overutilized / YTD Entitled and the ESS-view gating) and sortBalanceRows (click-
 * to-sort with nulls last). Plus i18n coverage for the new column headers/format across 6 locales, and source
 * guards that the table is a responsive DB-free client island and that /me composes it while PRESERVING the
 * R22 EntitlementBreakdown side-sheet + a single shared ?asOf= form.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deriveBalanceRow,
  sortBalanceRows,
  type BalanceInput,
  type BreakdownInput,
  type LeaveBalanceRow,
} from '../components/leave/leave-balance-row';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const baseBalance = (over: Partial<BalanceInput> = {}): BalanceInput => ({
  leaveTypeId: 'lt1',
  leaveType: 'Annual Leave',
  color: null,
  icon: null,
  code: 'AL',
  // Ledger-consistent (6574c6b4): balance 15 = entitlement 12 + carried 5 + adjustment 2 − taken 3 − forfeited 1.
  // Surfaced as the authoritative remaining figure (b.balance), GROSS of pending. `available` (= balance −
  // pending) is a separate ledger-net figure the pure helper passes through independently.
  balance: 15,
  available: 8.5,
  taken: 3,
  essView: {},
  ...over,
});

const baseBreakdown = (over: Partial<NonNullable<BreakdownInput>> = {}): BreakdownInput => ({
  monthlyAccruedToDate: 7,
  // r279: the full-year BAND, deliberately DISTINCT from currentYearEntitlement (20 vs 12) so a regression
  // that binds Full Entitlement to the accrued figure — the reporter's original request — fails loudly here.
  eligibleDays: 20,
  currentYearEntitlement: 12,
  carriedForward: 5,
  forfeited: 1,
  // 0315dac7: `otherAdjustments` commingles HR's configured grants with automatic system corrections; the
  // Adjustment column now shows `configAdjustments`, the same bucket the breakdown panel's Adjustment line
  // reads. Kept DISTINCT here (2 vs 6) so a regression back to the commingled figure fails loudly.
  otherAdjustments: 6,
  configAdjustments: 2,
  // 31e39d74: the default fixture describes a type whose entitlement HAS been generated (it has 12 days
  // of it), so `granted` is the only consistent value here. The other three states are exercised in
  // test/r196-entitlement-not-generated.test.ts.
  entitlementStatus: 'granted',
  ...over,
});

describe('deriveBalanceRow: the standardized balance columns map from existing figures (776cd1b5)', () => {
  it('maps every column from balances + breakdown; Accrued = available; Balance is computed', () => {
    const row = deriveBalanceRow(baseBalance(), baseBreakdown());
    expect(row.available).toBe(8.5); // shown as "Accrued"
    expect(row.taken).toBe(3);
    expect(row.broughtForward).toBe(5); // Carried Forward
    // 0315dac7: the Adjustment column is the CONFIG adjustment total (what HR entered on the Adjustment
    // step), NOT the commingled otherAdjustments — same figure the breakdown panel's Adjustment line shows.
    expect(row.adjustment).toBe(2);
    expect(row.adjustment).not.toBe(baseBreakdown()!.otherAdjustments);
    expect(row.overutilized).toBe(0); // available >= 0 ⇒ 0
    // r279 — EARNED TO DATE is currentYearEntitlement ALONE. This read 17 (12 + carriedForward 5) until the
    // column was renamed from "YTD Entitled": a column called Earned to Date that folds in last year's
    // leftovers misreports the year, and Brought Forward (5, asserted two lines above) is its own column.
    expect(row.ytdEntitled).toBe(12);
    // r279 — FULL ENTITLEMENT is the band off the breakdown, never the accrued figure and never a re-resolve.
    expect(row.fullEntitlement).toBe(20);
    expect(row.fullEntitlement).not.toBe(row.ytdEntitled);
    // Balance surfaces the authoritative ledger figure b.balance DIRECTLY (6574c6b4) — it is NOT re-derived from
    // the columns. Here b.balance is the ledger-consistent 15 (see fixture), so the row shows 15.
    expect(row.balance).toBe(15);
    expect(row.visual).toEqual({ color: null, icon: null, code: 'AL' });
  });

  it('dropped columns (entitlementToDate/expiredBroughtForward/unplanned) are gone from the row', () => {
    const row = deriveBalanceRow(baseBalance(), baseBreakdown()) as Record<string, unknown>;
    expect('entitlementToDate' in row).toBe(false);
    expect('expiredBroughtForward' in row).toBe(false);
    expect('unplanned' in row).toBe(false);
  });

  it('Overutilized is derived as max(0, -available) and no longer feeds Balance (6574c6b4)', () => {
    // A genuinely over-drawn ledger (balance −2.5). Overutilized still fires off Available (unchanged), but
    // Balance now surfaces b.balance directly — it is NOT reduced a second time by Overutilized (old double-count).
    const row = deriveBalanceRow(baseBalance({ balance: -2.5, available: -2.5 }), baseBreakdown());
    expect(row.overutilized).toBe(2.5);
    expect(row.available).toBe(-2.5);
    expect(row.balance).toBe(-2.5);
  });

  it('a type with NO breakdown loaded: breakdown columns null; Balance still surfaces b.balance (6574c6b4)', () => {
    const row = deriveBalanceRow(baseBalance(), null);
    expect(row.broughtForward).toBeNull();
    expect(row.adjustment).toBeNull();
    expect(row.ytdEntitled).toBeNull();
    expect(row.fullEntitlement).toBeNull(); // r279 — no breakdown ⇒ no band to claim; the cell renders "—".
    // ...but ledger-sourced Available / Taken still show, and Balance is the ledger figure regardless of breakdown.
    expect(row.available).toBe(8.5);
    expect(row.taken).toBe(3);
    expect(row.balance).toBe(15); // b.balance, independent of whether a breakdown loaded
  });

  it('Mei Ling regression (6574c6b4): balance 14, taken 28, no carry/adjustment/pending ⇒ Balance +14, Overutilized 0', () => {
    // The reported bug: the old formula collapsed to entitlement − 2*taken (42 − 2*28), turning a true +14 into
    // −14. Surfacing b.balance directly yields the correct +14, and the over-draw warning stays 0.
    const row = deriveBalanceRow(
      baseBalance({ balance: 14, available: 14, taken: 28 }),
      baseBreakdown({ currentYearEntitlement: 42, carriedForward: 0, otherAdjustments: 0, forfeited: 0 }),
    );
    expect(row.balance).toBe(14);
    expect(row.overutilized).toBe(0);
  });

  it('carry-forward invariance: changing carriedForward does NOT change Balance (guards the double-ADD half)', () => {
    const base = baseBalance({ balance: 15 });
    const a = deriveBalanceRow(base, baseBreakdown({ carriedForward: 5 }));
    const b = deriveBalanceRow(base, baseBreakdown({ carriedForward: 99 }));
    expect(a.balance).toBe(15);
    expect(b.balance).toBe(15);
    // …while the informational Carried Forward column still reflects the breakdown.
    expect(a.broughtForward).toBe(5);
    expect(b.broughtForward).toBe(99);
  });

  it('adjustment invariance: changing the adjustment total does NOT change Balance', () => {
    const base = baseBalance({ balance: 15 });
    const a = deriveBalanceRow(base, baseBreakdown({ configAdjustments: 2 }));
    const b = deriveBalanceRow(base, baseBreakdown({ configAdjustments: 40 }));
    expect(a.balance).toBe(15);
    expect(b.balance).toBe(15);
    expect(a.adjustment).toBe(2);
    expect(b.adjustment).toBe(40);
  });

  it('pending > 0: Balance is GROSS (b.balance), Available is net (balance − pending), Overutilized tracks Available', () => {
    // Ledger balance 3 with a 5-day pending request ⇒ available = 3 − 5 = −2 (over-drawn via pending). Balance
    // stays the gross ledger figure; the over-draw warning fires off Available, unchanged (semantic decision).
    const row = deriveBalanceRow(baseBalance({ balance: 3, available: -2, taken: 4 }), baseBreakdown());
    expect(row.balance).toBe(3); // gross ledger remaining
    expect(row.available).toBe(-2); // net = balance − pending
    expect(row.overutilized).toBe(2); // max(0, −available)
  });

  it('ESS view-config (65dec703) gates Available/Taken/Overutilized/Balance to null without leaking figures', () => {
    const gated = deriveBalanceRow(
      baseBalance({ available: -4, essView: { available: false, taken: false } }),
      baseBreakdown(),
    );
    expect(gated.available).toBeNull();
    expect(gated.taken).toBeNull();
    // Overutilized is the negation of Available, so it must hide with it; Balance contains both ⇒ hidden too.
    expect(gated.overutilized).toBeNull();
    expect(gated.balance).toBeNull();
    // Missing key ⇒ visible (backward compatible).
    const visible = deriveBalanceRow(baseBalance({ essView: {} }), baseBreakdown());
    expect(visible.available).toBe(8.5);
    expect(visible.taken).toBe(3);
  });
});

describe('sortBalanceRows: click-to-sort with nulls always last', () => {
  const mk = (leaveType: string, available: number | null): LeaveBalanceRow => ({
    ...deriveBalanceRow(baseBalance({ leaveTypeId: leaveType, leaveType, available: available ?? 0 }), null),
    available, // force the null we want to test
  });

  it('sorts by Leave Type ascending/descending (localeCompare)', () => {
    const rows = [mk('Sick', 1), mk('Annual', 2), mk('Maternity', 3)];
    expect(sortBalanceRows(rows, 'leaveType', 'asc').map((r) => r.leaveType)).toEqual(['Annual', 'Maternity', 'Sick']);
    expect(sortBalanceRows(rows, 'leaveType', 'desc').map((r) => r.leaveType)).toEqual(['Sick', 'Maternity', 'Annual']);
  });

  it('sorts a numeric column numerically and keeps nulls last in BOTH directions', () => {
    const rows = [mk('A', 5), mk('B', null), mk('C', 1), mk('D', 9)];
    expect(sortBalanceRows(rows, 'available', 'asc').map((r) => r.available)).toEqual([1, 5, 9, null]);
    expect(sortBalanceRows(rows, 'available', 'desc').map((r) => r.available)).toEqual([9, 5, 1, null]);
  });

  it('does not mutate the input array', () => {
    const rows = [mk('B', 2), mk('A', 1)];
    const before = rows.map((r) => r.leaveType);
    sortBalanceRows(rows, 'leaveType', 'asc');
    expect(rows.map((r) => r.leaveType)).toEqual(before);
  });
});

describe('Leave Balance table i18n: column headers + "Days" format resolve in all 6 locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const dicts = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(read(`/messages/${l}.json`)).me.leaveBalanceTable as Record<string, unknown>]),
  );
  // Standardized column set (776cd1b5): dropped keys removed; Accrued / Carried Forward / Balance added, plus a
  // tip.* tooltip per numeric column.
  const KEYS = [
    'colLeaveType',
    'colYtdEntitled',
    'colAccrued',
    'colCarriedForward',
    'colTaken',
    'colAdjustment',
    'colOverutilized',
    'colBalance',
    'daysValue',
    'sortBy',
    'asAtDate',
    'apply',
  ];
  const TIP_KEYS = ['ytdEntitled', 'accrued', 'carriedForward', 'taken', 'adjustment', 'overutilized', 'balance'];
  const REMOVED = ['colAvailable', 'colEntitlementToDate', 'colBroughtForward', 'colExpiredBroughtForward', 'colUnplanned'];
  for (const loc of LOCALES) {
    it(`${loc} resolves every leaveBalanceTable key + tooltip, and drops the removed keys`, () => {
      const missing = KEYS.filter((k) => dicts[loc][k] == null || dicts[loc][k] === '');
      expect(missing, `[${loc}] missing: ${missing.join(', ')}`).toEqual([]);
      const tips = (dicts[loc].tip ?? {}) as Record<string, unknown>;
      const missingTips = TIP_KEYS.filter((k) => tips[k] == null || tips[k] === '');
      expect(missingTips, `[${loc}] missing tips: ${missingTips.join(', ')}`).toEqual([]);
      // The now-unused labels are removed (plan: remove colEntitlementToDate/colExpiredBroughtForward/colUnplanned).
      expect(REMOVED.filter((k) => k in dicts[loc]), `[${loc}] stale keys`).toEqual([]);
    });
    it(`${loc} daysValue + sortBy carry their ICU placeholders`, () => {
      expect(String(dicts[loc].daysValue)).toContain('{value}');
      expect(String(dicts[loc].sortBy)).toContain('{column}');
    });
  }
});

describe('Leave Balance table source: responsive DB-free client island', () => {
  const cmp = read('/components/leave/leave-balance-table.tsx');

  it('is a client component that never imports a DB client / server action', () => {
    expect(cmp.startsWith("'use client'")).toBe(true);
    expect(cmp.includes("from '@/db")).toBe(false);
    expect(cmp.includes('drizzle')).toBe(false);
  });

  it('renders a horizontally-scrollable table with right-aligned tabular-nums numeric cells', () => {
    expect(cmp).toMatch(/overflow-x-auto/);
    expect(cmp).toMatch(/text-right/);
    expect(cmp).toMatch(/tabular-nums/);
  });

  it('declares the standardized numeric columns + the Leave Type column and click-to-sort headers (776cd1b5)', () => {
    for (const k of [
      'colYtdEntitled',
      'colAccrued',
      'colCarriedForward',
      'colTaken',
      'colAdjustment',
      'colOverutilized',
      'colBalance',
      'colLeaveType',
    ]) {
      expect(cmp).toContain(k);
    }
    // Dropped columns must not reappear in the table source.
    for (const k of ['colEntitlementToDate', 'colExpiredBroughtForward', 'colUnplanned']) {
      expect(cmp).not.toContain(k);
    }
    expect(cmp).toMatch(/onClick=\{\(\) => toggle\(/);
    expect(cmp).toMatch(/aria-sort=/);
  });

  // REPOINTED by 4a1abc4a, not weakened. The subject is unchanged — numeric cells must read "X.XX Days"
  // and an empty table must say noBalances — but the target moved: the local `n.toFixed(2)` is now the
  // shared `formatDays` from lib/day-format.ts, so that eleven leave surfaces cannot drift apart again.
  // The assertion is STRONGER than the one it replaces: it also forbids a private toFixed sneaking back in
  // beside the shared call, which is exactly how the drift started.
  it('formats numeric cells as "X.XX Days" via daysValue + the SHARED day formatter, and empty ⇒ noBalances', () => {
    expect(cmp).toMatch(/from '@\/lib\/day-format'/);
    expect(cmp).toMatch(/formatDays\(/);
    expect(cmp, 'day figures go through lib/day-format, never a local toFixed').not.toContain('toFixed(');
    expect(cmp).toMatch(/daysValue/);
    expect(cmp).toMatch(/noBalances/);
  });

  it('documents the read-only substrate skip', () => {
    expect(cmp.includes('substrate: read-only, no event')).toBe(true);
  });
});

// R37 e5a158d3: the detailed Workday-style balance table was RELOCATED from the /me Leave tab to the
// dedicated /leave page. These guards moved with it — /leave now composes it (preserving R22), and /me
// no longer renders it.
describe('Leave Balance table: /leave composes it while preserving R22 (panel + shared as-at form)', () => {
  const page = read('/app/leave/page.tsx');

  it('renders LeaveBalanceTable built from deriveBalanceRow', () => {
    expect(page).toMatch(/<LeaveBalanceTable/);
    expect(page).toMatch(/deriveBalanceRow\(b, bd \?\? null\)/);
  });

  it('keeps each row wired to the EntitlementBreakdown side-sheet as its detail (R22)', () => {
    expect(page).toMatch(/detail:/);
    expect(page).toMatch(/<EntitlementBreakdown/);
    expect(page.includes('applyEssConfig')).toBe(true);
  });

  it('lifts ONE shared ?asOf= GET form above the table (posts back to /leave)', () => {
    expect(page).toMatch(/method="GET"/);
    expect(page).toMatch(/name="asOf"/);
    expect(page).toMatch(/action="\/leave"/);
    expect(page).toMatch(/defaultValue=\{breakdownAsOf\}/);
  });

  it('scopes the balances to the VIEWER via per-employment leaveBalances (not the all-employee pivot)', () => {
    expect(page).toMatch(/leaveBalances\(session, me\.employmentId, locale\)/);
    expect(page.includes('leaveBalancesAll')).toBe(false);
  });
});

describe('Leave Balance table: /me NO LONGER renders the detailed table (relocated · R37 e5a158d3)', () => {
  const page = read('/app/me/page.tsx');

  it('does not compose LeaveBalanceTable anymore', () => {
    expect(page.includes('<LeaveBalanceTable')).toBe(false);
    expect(page.includes("from '@/components/leave/leave-balance-table'")).toBe(false);
  });
});
