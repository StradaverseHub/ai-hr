/**
 * Feedback 3d2bc793 — "Enhance Shortcut Customization with Multiple Shortcut Slots and Ordering".
 *
 * Shortcut-typed cards gather into their OWN row of mini cards between the top row and the pinned row:
 * up to MAX_SHORTCUTS of them, in an order the employee sets. Membership is DERIVED from the card's
 * HR-configured cardType (like the pin rule), never persisted — the stored shape is still
 * { selected, order }.
 *
 * Pure specs only (no DB): the back-compat guarantee that partitionDashboardRows called the old way is
 * byte-for-byte the old split; the shortcut row's composition and order; the MAX_SHORTCUTS cap in
 * normalizeDashboardLayout, its mandatory carve-out, and its inertness for a catalog with no cardType; and
 * that a layout saved before this change (no shortcut selected) normalises and partitions identically.
 *
 * a00c4f64 note: these specs used the Leave Calendar as the pinned card, because it was the only member of
 * FIXED_ROW_KEYS. The calendar became its own screen and that list is now empty, so the pinned card here is
 * a SYNTHETIC key passed explicitly to `partitionDashboardRows`. That is the honest shape: what this file
 * tests is the shortcut row's interaction with A pinned row, not which key production happens to pin —
 * FIXED_ROW_KEYS itself is pinned (as empty) in test/dashboard-fixed-row.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DASHBOARD_CARDS,
  MAX_FIRST_ROW,
  MAX_SHORTCUTS,
  normalizeDashboardLayout,
  partitionDashboardRows,
  type DashboardCardChoice,
} from '../lib/dashboard-layout';

/** The five shortcut cards migration 0213 seeds for every tenant, in their seeded display order. */
const SHORTCUT_KEYS = ['applyLeave', 'submitClaim', 'viewPayslip', 'updateProfile', 'myApplications'];

/** The stand-in for a full-width pinned card (see the header note on a00c4f64). */
const PINNED = 'pinnedCard';

/** The employee catalog as the app really supplies it: the builtin cards + the 0213 shortcut cards + the
 *  synthetic pinned card, so a selection naming it normalises rather than being dropped as unknown. */
const CATALOG: DashboardCardChoice[] = [
  ...BUILTIN_DASHBOARD_CARDS,
  { cardKey: PINNED, cardType: 'information' as const, employeeSelectable: true, defaultDisplay: false, mandatory: false, displayOrder: 7 },
  ...SHORTCUT_KEYS.map((cardKey, i) => ({
    cardKey,
    cardType: 'shortcut' as const,
    employeeSelectable: true,
    defaultDisplay: false,
    mandatory: false,
    displayOrder: 8 + i,
  })),
];

/** Partition with the production shortcut rule (cardType === 'shortcut') over an explicit pinned set. */
const partition = (selected: string[], cards: DashboardCardChoice[] = CATALOG) => {
  const shortcuts = new Set(cards.filter((c) => c.cardType === 'shortcut').map((c) => c.cardKey));
  return partitionDashboardRows(
    { selected, order: selected },
    selected.filter((k) => k === PINNED),
    selected.filter((k) => shortcuts.has(k)),
  );
};

describe('partitionDashboardRows — the Shortcuts row (3d2bc793)', () => {
  it('called WITHOUT the shortcut argument, reproduces the pre-change three-way split exactly', () => {
    // The back-compat contract: every caller that has not opted in sees the 2806443b behaviour untouched.
    const selected = ['leaveBalance', 'applyLeave', 'nextHoliday', PINNED, 'submitClaim'];
    const rows = partitionDashboardRows({ selected, order: selected }, [PINNED]);
    expect(rows.row1).toEqual(['leaveBalance', 'applyLeave', 'nextHoliday', 'submitClaim']);
    expect(rows.row2).toEqual([PINNED]);
    expect(rows.row3).toEqual([]);
    expect(rows.shortcuts).toEqual([]);
  });

  it('lifts shortcut cards into their own row, in the order the layout holds them', () => {
    const rows = partition([
      'leaveBalance',
      'submitClaim',
      'nextHoliday',
      'pendingTasks',
      PINNED,
      'applyLeave',
      'upcomingEvents',
      'recentActivity',
    ]);
    expect(rows.shortcuts).toEqual(['submitClaim', 'applyLeave']);
    expect(rows.row2).toEqual([PINNED]);
    // The remaining cards keep their relative order and fill the top row from the front — a shortcut no
    // longer eats a top-row slot.
    expect(rows.row1).toEqual(['leaveBalance', 'nextHoliday', 'pendingTasks', 'upcomingEvents']);
    expect(rows.row3).toEqual(['recentActivity']);
  });

  it('reordering the shortcut row leaves every other row identical', () => {
    const before = partition(['leaveBalance', 'applyLeave', 'submitClaim', PINNED, 'nextHoliday']);
    const after = partition(['leaveBalance', 'submitClaim', 'applyLeave', PINNED, 'nextHoliday']);
    expect(before.shortcuts).toEqual(['applyLeave', 'submitClaim']);
    expect(after.shortcuts).toEqual(['submitClaim', 'applyLeave']);
    expect(after.row1).toEqual(before.row1);
    expect(after.row2).toEqual(before.row2);
    expect(after.row3).toEqual(before.row3);
  });

  it("an 'action' card (Pending Tasks) is NOT a shortcut — it keeps its top-row slot", () => {
    const rows = partition(['pendingTasks', 'leaveBalance', 'applyLeave']);
    expect(rows.row1).toEqual(['pendingTasks', 'leaveBalance']);
    expect(rows.shortcuts).toEqual(['applyLeave']);
  });

  it('a full top row plus a full shortcut row keeps both at their own caps', () => {
    const rows = partition([
      'leaveBalance',
      'nextHoliday',
      'pendingTasks',
      'upcomingEvents',
      'recentlyJoined',
      ...SHORTCUT_KEYS.slice(0, MAX_SHORTCUTS),
    ]);
    expect(rows.row1.length).toBe(MAX_FIRST_ROW);
    expect(rows.shortcuts.length).toBe(MAX_SHORTCUTS);
    expect(rows.row3).toEqual(['recentlyJoined']);
  });
});

describe('normalizeDashboardLayout — the MAX_SHORTCUTS cap (3d2bc793)', () => {
  it('shows at most MAX_SHORTCUTS shortcuts, keeping the first ones the employee arranged', () => {
    const selected = ['leaveBalance', ...SHORTCUT_KEYS]; // five shortcuts — one over the cap
    const layout = normalizeDashboardLayout({ selected, order: selected }, CATALOG);
    const kept = layout.selected.filter((k) => SHORTCUT_KEYS.includes(k));
    expect(kept).toEqual(SHORTCUT_KEYS.slice(0, MAX_SHORTCUTS));
    expect(layout.selected).toContain('leaveBalance'); // non-shortcut cards are untouched by the cap
    // The surplus card keeps its slot in `order`, so removing one and re-adding it restores its position.
    expect(layout.order).toContain('myApplications');
  });

  it('a MANDATORY shortcut is exempt — "mandatory cards can never be removed" still wins', () => {
    const cards = CATALOG.map((c) =>
      c.cardKey === 'myApplications' ? { ...c, mandatory: true, defaultDisplay: true } : c,
    );
    const selected = ['leaveBalance', ...SHORTCUT_KEYS];
    const layout = normalizeDashboardLayout({ selected, order: selected }, cards);
    expect(layout.selected).toContain('myApplications');
  });

  it('is inert for a catalog that does not model cardType', () => {
    const untyped: DashboardCardChoice[] = CATALOG.map((c) => {
      const copy = { ...c };
      delete copy.cardType;
      return copy;
    });
    const selected = ['leaveBalance', ...SHORTCUT_KEYS];
    const layout = normalizeDashboardLayout({ selected, order: selected }, untyped);
    // All five survive — with no cardType there are no shortcuts to count against the cap.
    expect(layout.selected.filter((k) => SHORTCUT_KEYS.includes(k))).toEqual(SHORTCUT_KEYS);
  });

  it('a layout saved before this change (no shortcuts) normalises and partitions unchanged', () => {
    const saved = {
      selected: ['nextHoliday', 'leaveBalance', 'pendingTasks', PINNED, 'recentActivity'],
      order: ['nextHoliday', 'leaveBalance', 'pendingTasks', PINNED, 'recentActivity'],
    };
    const layout = normalizeDashboardLayout(saved, CATALOG);
    expect(layout.selected).toEqual(saved.selected);
    const rows = partition(layout.selected);
    expect(rows.shortcuts).toEqual([]);
    expect(rows.row1).toEqual(['nextHoliday', 'leaveBalance', 'pendingTasks', 'recentActivity']);
    expect(rows.row2).toEqual([PINNED]);
    expect(rows.row3).toEqual([]);
  });

  it('the default layout still shows no shortcuts (the 0213 seed is non-default-display)', () => {
    const layout = normalizeDashboardLayout(null, CATALOG);
    expect(layout.selected.filter((k) => SHORTCUT_KEYS.includes(k))).toEqual([]);
    expect(partition(layout.selected).shortcuts).toEqual([]);
  });
});
