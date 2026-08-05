/**
 * fef49b9a — THE SPLIT WAS ALWAYS STORED AND NEVER SHOWN.
 *
 * The engine already charges what the balance covers and records the shortfall in
 * `leave_request.unpaid_days` on the SAME row, and payroll already deducts from it. Nothing here changes
 * any of that. What was missing is that every screen rendered the total under the original leave type, so
 * four days Annual + one day Unpaid read as five days Annual. Five production requests are in that state.
 *
 * This file pins the derivation and, more importantly, the two properties that make it safe to put on
 * four screens at once:
 *
 *   ① AN UNSPLIT REQUEST RENDERS EXACTLY ONE ROW. That is the overwhelming majority of leave, and it must
 *      be indistinguishable from what shipped before. A "breakdown" appearing on ordinary leave would be
 *      a regression dressed as a feature.
 *   ② A SPLIT ALWAYS SUMS BACK TO THE ORIGINAL DAY COUNT. A breakdown that does not add up is worse than
 *      no breakdown — an employee would reasonably read it as days having gone missing.
 *
 * The four surfaces call ONE function. There is deliberately no per-screen arithmetic to test, because
 * four copies of `days - unpaidDays` is the defect this item exists to fix.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isLeaveSplit, leaveDisplaySplit } from '../lib/leave-split';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const split = (days: unknown, unpaidDays: unknown, unpaidTypeName?: string | null) =>
  leaveDisplaySplit({
    leaveTypeName: 'Annual Leave',
    days: days as number,
    unpaidDays: unpaidDays as number,
    unpaidTypeName,
    unpaidFallbackLabel: 'Unpaid Leave',
  });

describe('an unsplit request is untouched', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['zero as a string (numeric columns arrive as strings)', '0.00'],
  ])('renders ONE row when unpaidDays is %s', (_label, unpaid) => {
    const rows = split(5, unpaid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ label: 'Annual Leave', days: 5, unpaid: false });
    expect(isLeaveSplit(5, unpaid)).toBe(false);
  });

  it('renders ONE row when the whole request is unpaid', () => {
    // A fully-unpaid request is already recorded under an unpaid leave TYPE. A second row claiming
    // "0 days paid" would be an artefact of this function rather than a fact about the leave.
    expect(split(3, 3)).toHaveLength(1);
    expect(split(3, 4)).toHaveLength(1); // and a nonsensical stored value never invents a negative row
  });
});

describe('a split request', () => {
  it('renders the paid and unpaid portions, summing to the original', () => {
    const rows = split(5, 1);
    expect(rows).toEqual([
      { label: 'Annual Leave', days: 4, unpaid: false },
      { label: 'Unpaid Leave', days: 1, unpaid: true },
    ]);
    expect(rows.reduce((n, r) => n + r.days, 0)).toBe(5);
    expect(isLeaveSplit(5, 1)).toBe(true);
  });

  it('sums back to the original for every half-day and fractional combination', () => {
    // Half days and hourly leave both produce fractional day counts, and floating-point subtraction is
    // exactly where a breakdown stops adding up (4.5 - 0.1 = 4.3999999999999995 without rounding).
    for (const [days, unpaid] of [
      [5, 0.5],
      [4.5, 1.5],
      [1, 0.5],
      [3.25, 0.75],
      [10, 9.99],
      [0.5, 0.25],
    ] as const) {
      const rows = leaveDisplaySplit({
        leaveTypeName: 'Annual Leave',
        days,
        unpaidDays: unpaid,
        unpaidFallbackLabel: 'Unpaid Leave',
      });
      expect(rows, `${days}/${unpaid} must split`).toHaveLength(2);
      const total = Math.round(rows.reduce((n, r) => n + r.days, 0) * 100) / 100;
      expect(total, `${days} days split as ${unpaid} unpaid must still total ${days}`).toBe(days);
    }
  });

  it('accepts the string shapes a numeric column arrives as', () => {
    expect(split('5.00', '1.00')).toEqual([
      { label: 'Annual Leave', days: 4, unpaid: false },
      { label: 'Unpaid Leave', days: 1, unpaid: true },
    ]);
  });

  it("names the unpaid portion from the tenant's own leave type when there is one", () => {
    expect(split(5, 1, 'Leave Without Pay')[1].label).toBe('Leave Without Pay');
    // …and falls back to the translated label when the tenant has no such type.
    expect(split(5, 1, null)[1].label).toBe('Unpaid Leave');
    expect(split(5, 1, '')[1].label).toBe('Unpaid Leave');
  });
});

describe('all four surfaces read the one derivation', () => {
  // The point of the item is that they cannot disagree. If a screen starts computing its own subtraction
  // this fails, which is the only way to keep that property once four files are involved.
  it.each([
    ['My Leave History (+ the detail popup)', '/app/leave/page.tsx'],
    ["the Line Manager's Approval Items", '/app/approvals/page.tsx'],
    ['the HR Admin Employee Leave Record', '/app/leave/employee-records/page.tsx'],
  ])('%s calls leaveDisplaySplit', (_name, rel) => {
    expect(read(rel)).toContain('leaveDisplaySplit');
  });

  it('no surface does its own paid/unpaid subtraction', () => {
    for (const rel of [
      '/app/leave/page.tsx',
      '/app/approvals/page.tsx',
      '/app/leave/employee-records/page.tsx',
      '/components/leave/leave-history-cards.tsx',
      '/components/leave/leave-request-cells.tsx',
    ]) {
      const src = read(rel);
      expect(src, `${rel} must not subtract unpaid days itself`).not.toMatch(/days\s*-\s*unpaidDays/);
      expect(src, `${rel} must not subtract unpaid days itself`).not.toMatch(
        /Number\(\s*r\.days\s*\)\s*-\s*Number\(\s*r\.unpaidDays/,
      );
    }
  });

  it('the split rides the SHARED leave-request projection, so no surface needs its own query', () => {
    const readSrc = read('/core/read.ts');
    const selection = readSrc.slice(
      readSrc.indexOf('const leaveRequestSelection'),
      readSrc.indexOf('const leaveRequestSelection') + 4000,
    );
    expect(selection).toContain('unpaidDays: leaveRequest.unpaidDays');
  });
});

describe('the Emergency Leave decomposition is a DIFFERENT mechanism and must not be merged in', () => {
  it('keeps its parent_group_id child rows, which already render separately', () => {
    // EL genuinely creates ANNUAL + UNPAID CHILD ROWS under a shared parentGroupId. This item's split is
    // one row carrying unpaid_days. Merging them would double-render EL: once as two child rows and again
    // as a breakdown on each child.
    const leave = read('/core/leave.ts');
    expect(leave).toContain('parentGroupId');
    // An EL child is itself fully paid or fully unpaid, so it never produces a breakdown row.
    expect(split(2, 2)).toHaveLength(1);
    expect(split(2, 0)).toHaveLength(1);
  });
});
