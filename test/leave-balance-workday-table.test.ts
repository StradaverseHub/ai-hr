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
} from '../components/leave/leave-balance-table';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const baseBalance = (over: Partial<BalanceInput> = {}): BalanceInput => ({
  leaveTypeId: 'lt1',
  leaveType: 'Annual Leave',
  color: null,
  icon: null,
  code: 'AL',
  available: 8.5,
  taken: 3,
  essView: {},
  ...over,
});

const baseBreakdown = (over: Partial<NonNullable<BreakdownInput>> = {}): BreakdownInput => ({
  monthlyAccruedToDate: 7,
  currentYearEntitlement: 12,
  carriedForward: 5,
  forfeited: 1,
  otherAdjustments: 2,
  ...over,
});

describe('deriveBalanceRow: the ten reporter columns map from existing figures', () => {
  it('maps every column from balances + breakdown (earned type uses accrued-to-date for Entitlement to Date)', () => {
    const row = deriveBalanceRow(baseBalance(), baseBreakdown());
    expect(row.available).toBe(8.5);
    expect(row.taken).toBe(3);
    expect(row.entitlementToDate).toBe(7); // monthlyAccruedToDate preferred
    expect(row.broughtForward).toBe(5); // carriedForward
    expect(row.expiredBroughtForward).toBe(1); // forfeited
    expect(row.unplanned).toBeNull(); // deferred in v1
    expect(row.adjustment).toBe(2); // otherAdjustments
    expect(row.overutilized).toBe(0); // available >= 0 ⇒ 0
    expect(row.ytdEntitled).toBe(17); // currentYearEntitlement(12) + carriedForward(5)
    expect(row.visual).toEqual({ color: null, icon: null, code: 'AL' });
  });

  it('grant-on-open type (monthlyAccruedToDate null) falls back to full current-year entitlement', () => {
    const row = deriveBalanceRow(baseBalance(), baseBreakdown({ monthlyAccruedToDate: null }));
    expect(row.entitlementToDate).toBe(12);
  });

  it('Overutilized is derived as max(0, -available) when the type is over-drawn', () => {
    const row = deriveBalanceRow(baseBalance({ available: -2.5 }), baseBreakdown());
    expect(row.overutilized).toBe(2.5);
    expect(row.available).toBe(-2.5);
  });

  it('a type with NO breakdown loaded shows "—" (null) for every breakdown-derived column', () => {
    const row = deriveBalanceRow(baseBalance(), null);
    expect(row.entitlementToDate).toBeNull();
    expect(row.broughtForward).toBeNull();
    expect(row.expiredBroughtForward).toBeNull();
    expect(row.adjustment).toBeNull();
    expect(row.ytdEntitled).toBeNull();
    // ...but ledger-sourced Available / Taken still show.
    expect(row.available).toBe(8.5);
    expect(row.taken).toBe(3);
  });

  it('ESS view-config (65dec703) gates Available/Taken/Overutilized to null without leaking the hidden number', () => {
    const gated = deriveBalanceRow(
      baseBalance({ available: -4, essView: { available: false, taken: false } }),
      baseBreakdown(),
    );
    expect(gated.available).toBeNull();
    expect(gated.taken).toBeNull();
    // Overutilized is the negation of Available, so it must hide with it.
    expect(gated.overutilized).toBeNull();
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
  const KEYS = [
    'colLeaveType',
    'colAvailable',
    'colTaken',
    'colEntitlementToDate',
    'colBroughtForward',
    'colExpiredBroughtForward',
    'colUnplanned',
    'colAdjustment',
    'colOverutilized',
    'colYtdEntitled',
    'daysValue',
    'sortBy',
    'asAtDate',
    'apply',
  ];
  for (const loc of LOCALES) {
    it(`${loc} resolves every leaveBalanceTable key`, () => {
      const missing = KEYS.filter((k) => dicts[loc][k] == null || dicts[loc][k] === '');
      expect(missing, `[${loc}] missing: ${missing.join(', ')}`).toEqual([]);
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

  it('declares the nine numeric columns + the Leave Type column and click-to-sort headers', () => {
    for (const k of [
      'colAvailable',
      'colTaken',
      'colEntitlementToDate',
      'colBroughtForward',
      'colExpiredBroughtForward',
      'colUnplanned',
      'colAdjustment',
      'colOverutilized',
      'colYtdEntitled',
      'colLeaveType',
    ]) {
      expect(cmp).toContain(k);
    }
    expect(cmp).toMatch(/onClick=\{\(\) => toggle\(/);
    expect(cmp).toMatch(/aria-sort=/);
  });

  it('formats numeric cells as "X.XX Days" via daysValue + toFixed(2), and empty ⇒ noBalances', () => {
    expect(cmp).toMatch(/toFixed\(2\)/);
    expect(cmp).toMatch(/daysValue/);
    expect(cmp).toMatch(/noBalances/);
  });

  it('documents the read-only substrate skip', () => {
    expect(cmp.includes('substrate: read-only, no event')).toBe(true);
  });
});

describe('Leave Balance table: /me composes it while preserving R22 (panel + shared as-at form)', () => {
  const page = read('/app/me/page.tsx');

  it('renders LeaveBalanceTable built from deriveBalanceRow', () => {
    expect(page).toMatch(/<LeaveBalanceTable/);
    expect(page).toMatch(/deriveBalanceRow\(b, bd \?\? null\)/);
  });

  it('keeps each row wired to the EntitlementBreakdown side-sheet as its detail (R22)', () => {
    expect(page).toMatch(/detail:/);
    expect(page).toMatch(/<EntitlementBreakdown/);
    expect(page.includes('applyEssConfig')).toBe(true);
  });

  it('lifts ONE shared ?asOf= GET form above the table (preserved, tab=leave carried)', () => {
    expect(page).toMatch(/method="GET"/);
    expect(page).toMatch(/name="asOf"/);
    expect(page).toMatch(/name="tab" value="leave"/);
    expect(page).toMatch(/defaultValue=\{breakdownAsOf\}/);
  });
});
