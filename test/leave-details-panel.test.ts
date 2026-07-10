/**
 * Leave Details Side Panel (feedback 584edf44) — configurable Calculation-Breakdown-Display framework.
 *
 * DB-free / jsdom-free guard (the suite has no DOM runner). It proves the item's CORE property: the panel is
 * driven by a DECLARATIVE descriptor (entitlement-panel-config.ts) covering the reporter's seven sections in
 * order, each field either PICKING an already-computed value (no hardcoded formula) or — for a not-yet-mapped
 * label — carrying NO `select` so the panel renders a placeholder. Plus source guards that the inline expand
 * became a Radix right side-sheet, the ?asOf= form was preserved, ESS-view + visual behaviour survives, and
 * both call sites feed the new §1 summary / §5 upcoming / visual props.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_PANEL_SECTIONS,
  type PanelData,
} from '../components/leave/entitlement-panel-config';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

// A synthetic, fully-populated envelope — every field's `select` is a pure pick over this (no formula).
const DATA: PanelData = {
  breakdown: {
    leaveTypeId: 'lt1',
    leaveType: 'Annual Leave',
    asOf: '2026-02-15',
    cycleStart: '2026-01-01',
    currentYearEntitlement: 12,
    monthlyAccruedToDate: 2,
    carriedForward: 5,
    carryForwardRemaining: 3,
    carryForwardExpiryDate: '2026-03-31',
    forfeited: 1,
    otherAdjustments: 4,
    totalAvailable: 17,
    transactions: [{ effectiveOn: '2026-01-01', entryType: 'accrual', days: 12, sourceRequestId: null }],
    essView: {},
  },
  summary: { available: 15, taken: 2, pending: 1, ytdEntitled: 12 },
  upcoming: [{ startDate: '2026-06-01', endDate: '2026-06-03', days: 3, durationType: 'full_day' }],
};

describe('entitlement-panel-config: the seven sections in order', () => {
  it('declares exactly the reporter’s 7 sections with strictly ascending order 1..7', () => {
    const orders = ENTITLEMENT_PANEL_SECTIONS.map((s) => s.order);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const keys = ENTITLEMENT_PANEL_SECTIONS.map((s) => s.key);
    expect(keys).toEqual([
      'summary',
      'entitlement',
      'utilization',
      'adjustments',
      'upcoming',
      'transactions',
      'calcBreakdown',
    ]);
  });

  it('maps the §5 upcoming and §6 transactions sections to their special render kinds', () => {
    const byKey = Object.fromEntries(ENTITLEMENT_PANEL_SECTIONS.map((s) => [s.key, s]));
    expect(byKey.upcoming.kind).toBe('upcoming');
    expect(byKey.transactions.kind).toBe('transactions');
    // Every section carries an ess-view gating key (the closed allow-list from core/ess-view.ts).
    expect(byKey.upcoming.essKey).toBe('upcomingApprovedLeave');
    expect(byKey.transactions.essKey).toBe('transactionHistory');
    expect(byKey.calcBreakdown.essKey).toBe('entitlementCalcBreakdown');
  });

  it('a future breakdown line is one descriptor entry (fields carry key + labelKey, no JSX)', () => {
    for (const s of ENTITLEMENT_PANEL_SECTIONS) {
      for (const f of s.fields ?? []) {
        expect(typeof f.key).toBe('string');
        expect(typeof f.labelKey).toBe('string');
      }
    }
  });
});

describe('entitlement-panel-config: fields PICK existing values (no hardcoded formula)', () => {
  const field = (sectionKey: string, fieldKey: string) => {
    const s = ENTITLEMENT_PANEL_SECTIONS.find((x) => x.key === sectionKey)!;
    return s.fields!.find((f) => f.key === fieldKey)!;
  };

  it('§1 summary reads the balance-row figures (available/taken/pending/ytdEntitled)', () => {
    expect(field('summary', 'available').select!(DATA)).toBe(15);
    expect(field('summary', 'taken').select!(DATA)).toBe(2);
    expect(field('summary', 'pendingApproval').select!(DATA)).toBe(1);
    expect(field('summary', 'ytdEntitled').select!(DATA)).toBe(12);
  });

  it('§2 entitlement reads engine figures (entitlement-to-date/BF/expiry/forfeited)', () => {
    expect(field('entitlement', 'entitlementToDate').select!(DATA)).toBe(12);
    expect(field('entitlement', 'broughtForward').select!(DATA)).toBe(5);
    expect(field('entitlement', 'carryForwardExpiry').select!(DATA)).toBe('2026-03-31');
    expect(field('entitlement', 'forfeited').select!(DATA)).toBe(1);
  });

  it('§4 adjustments reads otherAdjustments — the field re-added to the mirror type', () => {
    expect(field('adjustments', 'adjustment').select!(DATA)).toBe(4);
  });

  it('§7 calc-breakdown surfaces the engine values verbatim, incl. total available', () => {
    expect(field('calcBreakdown', 'currentYearEntitlement').select!(DATA)).toBe(12);
    expect(field('calcBreakdown', 'carryForwardRemaining').select!(DATA)).toBe(3);
    expect(field('calcBreakdown', 'totalAvailable').select!(DATA)).toBe(17);
    // monthlyAccrued is omitWhenNull so a grant-on-open type hides the row rather than showing a placeholder.
    expect(field('calcBreakdown', 'monthlyAccrued').omitWhenNull).toBe(true);
  });
});

describe('entitlement-panel-config: not-yet-mapped labels carry NO select (placeholder path)', () => {
  it('§2 expired-brought-forward + §3 unplanned/overutilized are configured labels only', () => {
    const noSelect = (sk: string, fk: string) => {
      const s = ENTITLEMENT_PANEL_SECTIONS.find((x) => x.key === sk)!;
      return s.fields!.find((f) => f.key === fk)!.select;
    };
    expect(noSelect('entitlement', 'expiredBroughtForward')).toBeUndefined();
    expect(noSelect('utilization', 'unplanned')).toBeUndefined();
    expect(noSelect('utilization', 'overutilized')).toBeUndefined();
    // …yet they still carry an ess key so HR can show/hide them and a future enhancement wires the value.
    const util = ENTITLEMENT_PANEL_SECTIONS.find((x) => x.key === 'utilization')!;
    expect(util.fields!.map((f) => f.essKey)).toEqual(['unplanned', 'overutilized']);
  });
});

describe('Leave Details panel i18n: every descriptor label resolves in all 6 locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const dicts = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(read(`/messages/${l}.json`)).leave.breakdown as Record<string, unknown>]),
  );
  const getPath = (o: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);

  const labelKeys = [
    ...ENTITLEMENT_PANEL_SECTIONS.map((s) => s.labelKey),
    ...ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => (s.fields ?? []).map((f) => f.labelKey)),
    // Literal keys the panel renders directly.
    'panelSubtitle',
    'close',
    'noUpcoming',
    'daysCount',
    'colBalanceChange',
    'noExpiry',
    'viewBreakdown',
  ];

  for (const loc of LOCALES) {
    it(`${loc} resolves every section/field label + panel literal`, () => {
      const missing = labelKeys.filter((k) => getPath(dicts[loc], k) == null || getPath(dicts[loc], k) === '');
      expect(missing, `[${loc}] missing: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('Leave Details panel: the inline expand became a Radix right side-sheet', () => {
  const panel = read('/components/leave/LeaveDetailsPanel.tsx');
  const adapter = read('/components/leave/EntitlementBreakdown.tsx');

  it('panel is a DB-free client island using the app Dialog primitive', () => {
    expect(panel.startsWith("'use client'")).toBe(true);
    expect(panel).toMatch(/@radix-ui\/react-dialog/);
    expect(panel.includes('import') && panel.includes('client')).toBe(true);
    // DB-free: no drizzle/server-action import.
    expect(panel.includes("from '@/db")).toBe(false);
  });

  it('Dialog.Content is styled as a fixed right side-sheet (max-w-md, bg-popover, border-l)', () => {
    expect(panel).toMatch(/fixed inset-y-0 right-0/);
    expect(panel).toMatch(/max-w-md/);
    expect(panel).toMatch(/bg-popover/);
    expect(panel).toMatch(/border-l/);
    // Mobile responsive: full width down to max-w-md.
    expect(panel).toMatch(/w-full/);
  });

  it('preserves the ?asOf= GET form INSIDE the panel', () => {
    expect(panel).toMatch(/method="GET"/);
    expect(panel).toMatch(/name="asOf"/);
    expect(panel.includes('action={action}')).toBe(true);
  });

  it('honours ESS view-config gating + shows the per-type visual icon', () => {
    expect(panel.includes('applyEssConfig')).toBe(true);
    expect(panel.includes('essView')).toBe(true);
    expect(panel.includes('leaveVisual')).toBe(true);
  });

  it('substrate: documents the read-only no-event skip', () => {
    expect(panel.includes('substrate: read-only, no event')).toBe(true);
    expect(adapter.includes('substrate: read-only, no event')).toBe(true);
  });

  it('EntitlementBreakdown adapter delegates to LeaveDetailsPanel + re-adds otherAdjustments', () => {
    expect(adapter.includes('LeaveDetailsPanel')).toBe(true);
    expect(adapter.includes('otherAdjustments')).toBe(true);
  });
});

describe('Leave Details panel: both call sites feed §1 summary / §5 upcoming / visual', () => {
  const PAGES = ['/app/me/page.tsx', '/app/admin/personnel/[employmentId]/page.tsx'] as const;
  for (const p of PAGES) {
    const src = read(p);
    it(`${p} passes summary + upcoming + visual to EntitlementBreakdown`, () => {
      expect(src.includes('summary={{')).toBe(true);
      expect(src.includes('upcoming={')).toBe(true);
      expect(src.includes('visual={{')).toBe(true);
    });
    it(`${p} derives §5 upcoming as approved + future for this type`, () => {
      expect(src).toMatch(/status === 'approved'/);
      expect(src).toMatch(/startDate > today/);
    });
  }
});
