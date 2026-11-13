/**
 * Feedback 3d2bc793 — "Enhance Shortcut Customization with Multiple Shortcut Slots and Ordering": the MAX_SHORTCUTS
 * cap in normalizeDashboardLayout, which every saved Home layout still passes through (core/dashboard-prefs.ts), its
 * mandatory carve-out, and its inertness for a catalog with no cardType.
 *
 * The old dashboard's row partition (partitionDashboardRows: top row, shortcuts row, pinned row) was retired with
 * the customizer that drew it (owner decision, 12 Nov 2026), and so were its specs here. The stored shape is still
 * { selected, order }. The pinned card below is a SYNTHETIC key, kept only so a selection naming it normalises.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DASHBOARD_CARDS,
  MAX_SHORTCUTS,
  normalizeDashboardLayout,
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

  it('a layout saved before this change (no shortcuts) normalises unchanged', () => {
    const saved = {
      selected: ['nextHoliday', 'leaveBalance', 'pendingTasks', PINNED, 'recentActivity'],
      order: ['nextHoliday', 'leaveBalance', 'pendingTasks', PINNED, 'recentActivity'],
    };
    const layout = normalizeDashboardLayout(saved, CATALOG);
    expect(layout.selected).toEqual(saved.selected);
    expect(layout.selected.filter((k) => SHORTCUT_KEYS.includes(k))).toEqual([]);
  });

  it('the default layout still shows no shortcuts (the 0213 seed is non-default-display)', () => {
    const layout = normalizeDashboardLayout(null, CATALOG);
    expect(layout.selected.filter((k) => SHORTCUT_KEYS.includes(k))).toEqual([]);
  });
});
