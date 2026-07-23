/**
 * Leave Details Side Panel (feedback 584edf44) — configurable Calculation-Breakdown-Display framework.
 *
 * DB-free / jsdom-free guard (the suite has no DOM runner). It proves the item's CORE property: the panel is
 * driven by a DECLARATIVE descriptor (entitlement-panel-config.ts) covering the reporter's sections in
 * order, each field either PICKING an already-computed value (no hardcoded formula) or — for a not-yet-mapped
 * label — carrying NO `select` so the panel renders a placeholder. Plus source guards that the inline expand
 * became a Radix right side-sheet, the ?asOf= form was preserved, ESS-view + visual behaviour survives, and
 * both call sites feed the new §1 summary / visual props.
 *
 * Sync Employee Leave View Configuration (feedback 11876072): the §5 Upcoming Leave section is REMOVED from
 * the panel (and its `upcomingApprovedLeave` toggle from core/ess-view.ts), and the admin ESS-view checklist
 * is now GROUPED by the panel's own sections via ESS_VIEW_CHECKLIST_GROUPS — the drift guards below assert
 * the grouping is derived from ENTITLEMENT_PANEL_SECTIONS and covers every configurable key exactly once.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_PANEL_SECTIONS,
  ESS_VIEW_CHECKLIST_GROUPS,
  deriveSummaryBalance,
  type PanelData,
} from '../components/leave/entitlement-panel-config';
import { ESS_VIEW_COMPONENT_KEYS } from '../core/ess-view';

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
  // §1 Balance (877f2f37) = (available 15 + carryForwardRemaining 3 + otherAdjustments 4) − taken 2 − forfeited 1 = 19.
  summary: { available: 15, taken: 2, pending: 1, ytdEntitled: 12, balance: 19 },
};

describe('entitlement-panel-config: sections in order (1dd4d827 removed §6, 11876072 removed §5)', () => {
  it('no longer declares the §6 transactions, §2 entitlement or §5 upcoming sections; calcBreakdown at order 2', () => {
    const keys = ENTITLEMENT_PANEL_SECTIONS.map((s) => s.key);
    // §6 Transaction History (1dd4d827), §2 Entitlement Breakdown (e503f284) and §5 Upcoming Leave (11876072)
    // are all removed; the remaining four descriptor entries keep their declared order values (array order is
    // unchanged: calcBreakdown was re-numbered from 7 to 2 in place).
    expect(keys).toEqual([
      'summary',
      'utilization',
      'adjustments',
      'calcBreakdown',
    ]);
    // e503f284: §2 "Entitlement Breakdown" is gone and §7 "Entitlement Calculation Breakdown" now sorts to
    // order 2 — immediately after the summary (order 1), the slot §2 used to hold.
    expect(keys).not.toContain('entitlement');
    const byKey = Object.fromEntries(ENTITLEMENT_PANEL_SECTIONS.map((s) => [s.key, s]));
    expect(byKey.calcBreakdown.order).toBe(2);
    const sorted = [...ENTITLEMENT_PANEL_SECTIONS].sort((a, b) => a.order - b.order).map((s) => s.key);
    expect(sorted).toEqual(['summary', 'calcBreakdown', 'utilization', 'adjustments']);
    // Universal removals: no leave type / ESS config can re-surface either — the descriptor entries are gone.
    expect(keys).not.toContain('transactions');
    expect(keys).not.toContain('upcoming');
  });

  it('11876072: the Upcoming Leave toggle is gone from the closed ess-view key list too', () => {
    // The §5 section AND its per-type toggle are removed together — a stored legacy `upcomingApprovedLeave`
    // entry is ignored on read (resolveEssView drops unknown keys; asserted in leave-ess-view-config.test.ts).
    expect(ESS_VIEW_COMPONENT_KEYS).not.toContain('upcomingApprovedLeave');
    // The remaining section-level gate is unchanged.
    const byKey = Object.fromEntries(ENTITLEMENT_PANEL_SECTIONS.map((s) => [s.key, s]));
    expect(byKey.calcBreakdown.essKey).toBe('entitlementCalcBreakdown');
    expect(byKey.transactions).toBeUndefined();
    expect(byKey.upcoming).toBeUndefined();
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

  it('§1 summary reads the balance-row figures (available/taken/pending/ytdEntitled) + picks Balance', () => {
    expect(field('summary', 'available').select!(DATA)).toBe(15);
    expect(field('summary', 'taken').select!(DATA)).toBe(2);
    expect(field('summary', 'pendingApproval').select!(DATA)).toBe(1);
    expect(field('summary', 'ytdEntitled').select!(DATA)).toBe(12);
    // Balance (877f2f37) is a declarative PICK of the precomputed d.summary.balance, not a hardcoded formula.
    expect(field('summary', 'balance').select!(DATA)).toBe(19);
  });

  it('§1 summary is reordered YTD Entitled → Taken → Pending → Available → Balance, each with a static tooltip', () => {
    const summary = ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'summary')!;
    expect(summary.fields!.map((f) => f.key)).toEqual(['ytdEntitled', 'taken', 'pendingApproval', 'available', 'balance']);
    // Every summary row carries a STATIC hover tooltip (no HR config); Balance is never ESS-gated (no essKey).
    expect(summary.fields!.every((f) => typeof f.tooltipKey === 'string')).toBe(true);
    expect(summary.fields!.find((f) => f.key === 'balance')!.essKey).toBeUndefined();
  });

  it('deriveSummaryBalance = (Available + Carry-Forward Remaining + Adjustments) − Taken − Forfeited', () => {
    expect(deriveSummaryBalance(15, 2, { carryForwardRemaining: 3, otherAdjustments: 4, forfeited: 1 })).toBe(19);
    // A missing breakdown ⇒ its parts are 0 (Balance falls back to Available − Taken).
    expect(deriveSummaryBalance(10, 4, null)).toBe(6);
  });

  it('the §7 calc-breakdown carries the engine figures §2 used to duplicate (e503f284 removed §2)', () => {
    // §2 "Entitlement Breakdown" is removed; its engine figures live on in §7 (currentYearEntitlement =
    // entitlement-to-date, carriedForward = brought-forward, plus carry-forward expiry + forfeited).
    expect(field('calcBreakdown', 'currentYearEntitlement').select!(DATA)).toBe(12);
    expect(field('calcBreakdown', 'carriedForward').select!(DATA)).toBe(5);
    expect(field('calcBreakdown', 'carryForwardExpiry').select!(DATA)).toBe('2026-03-31');
    expect(field('calcBreakdown', 'forfeited').select!(DATA)).toBe(1);
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
  it('§3 unplanned/overutilized are configured labels only (§2 removed, e503f284)', () => {
    const noSelect = (sk: string, fk: string) => {
      const s = ENTITLEMENT_PANEL_SECTIONS.find((x) => x.key === sk)!;
      return s.fields!.find((f) => f.key === fk)!.select;
    };
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
    // §1 static hover tooltips (877f2f37) — each summary row's tooltipKey must resolve in every locale.
    ...ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => (s.fields ?? []).flatMap((f) => (f.tooltipKey ? [f.tooltipKey] : []))),
    // Info-icon per component (b8b665ff) literals + §1 literals the panel renders directly.
    'explanationShow',
    'explanationHide',
    'explanationDescription',
    'explanationFormula',
    'explanationResult',
    'panelSubtitle',
    'close',
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

  it('feedback 1dd4d827: no longer renders a Transaction History table (renderer + dispatch removed)', () => {
    // Presentation-only removal — the ledger renderer and its dispatch branch are gone from the panel.
    expect(panel.includes('renderTransactions')).toBe(false);
    expect(panel).not.toMatch(/kind === 'transactions'/);
    // Ledger data on the breakdown type is untouched — the panel simply stops rendering it here.
    // (data.transactions still powers the /leave Leave History table.)
  });

  it('feedback 11876072: no longer renders an Upcoming Leave list (renderer + dispatch + prop removed)', () => {
    // Presentation-only removal — the §5 renderer, its dispatch branch and the `upcoming` prop are gone.
    expect(panel.includes('renderUpcoming')).toBe(false);
    expect(panel).not.toMatch(/kind === 'upcoming'/);
    expect(panel.includes('UpcomingLeaveItem')).toBe(false);
    // The adapter no longer threads an upcoming list either.
    expect(adapter.includes('upcoming')).toBe(false);
    // Approved-future requests are untouched data — the /leave history list still shows them.
  });

  it('EntitlementBreakdown adapter delegates to LeaveDetailsPanel + re-adds otherAdjustments', () => {
    expect(adapter.includes('LeaveDetailsPanel')).toBe(true);
    expect(adapter.includes('otherAdjustments')).toBe(true);
  });
});

describe('Leave Details panel: both call sites feed §1 summary / visual (upcoming removed, 11876072)', () => {
  // a7cbd895 (My Absence): the /me Leave tab (cards + secondary rows) moved to /leave, so the ESS call
  // site is now app/leave/page.tsx; the admin personnel page is unchanged.
  const PAGES = ['/app/leave/page.tsx', '/app/admin/personnel/[employmentId]/page.tsx'] as const;
  for (const p of PAGES) {
    const src = read(p);
    it(`${p} passes summary + visual to EntitlementBreakdown — and no upcoming list (11876072)`, () => {
      expect(src.includes('summary={{')).toBe(true);
      expect(src.includes('visual={{')).toBe(true);
      // 11876072: the §5 Upcoming Leave section is removed, so no call site builds or passes an upcoming prop.
      expect(src.includes('upcoming={')).toBe(false);
      expect(src.includes('upcoming:')).toBe(false);
    });
  }
});

describe('Admin ESS-view checklist mirrors the employee panel sections (feedback 11876072)', () => {
  it('ESS_VIEW_CHECKLIST_GROUPS covers every configurable key exactly once (drift guard)', () => {
    const flat = ESS_VIEW_CHECKLIST_GROUPS.flatMap((g) => g.keys);
    // Coverage: every key of the closed allow-list appears, and none appears twice — nothing orphaned,
    // nothing double-listed, whatever future edits do to ENTITLEMENT_PANEL_SECTIONS.
    expect([...flat].sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('groups derive from ENTITLEMENT_PANEL_SECTIONS: same sections, same order, orphans in a trailing Other', () => {
    const sectionKeys = [...ENTITLEMENT_PANEL_SECTIONS]
      .sort((a, b) => a.order - b.order)
      .filter((s) => s.essKey != null || (s.fields ?? []).some((f) => f.essKey != null))
      .map((s) => s.key);
    const groupKeys = ESS_VIEW_CHECKLIST_GROUPS.map((g) => g.key);
    expect(groupKeys).toEqual([...sectionKeys, 'other']);
    // Section groups reuse the panel's OWN heading key; only the orphan group has none (admin-side label).
    for (const g of ESS_VIEW_CHECKLIST_GROUPS) {
      if (g.key === 'other') expect(g.labelKey).toBeNull();
      else expect(g.labelKey).toBe(ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === g.key)!.labelKey);
    }
  });

  it('current grouping reads exactly like the panel: summary → calcBreakdown → utilization → adjustments → other', () => {
    expect(ESS_VIEW_CHECKLIST_GROUPS.map((g) => ({ key: g.key, keys: g.keys }))).toEqual([
      { key: 'summary', keys: ['ytdEntitled', 'taken', 'pendingApproval', 'available'] },
      { key: 'calcBreakdown', keys: ['entitlementCalcBreakdown'] },
      { key: 'utilization', keys: ['unplanned', 'overutilized'] },
      { key: 'adjustments', keys: ['adjustment'] },
      // Keys no panel section references (they gate other surfaces, e.g. the balance-table columns) are kept
      // configurable under "Other" so nothing is orphaned by the regrouping.
      {
        key: 'other',
        keys: ['entitlementToDate', 'broughtForward', 'expiredBroughtForward', 'carryForwardExpiry', 'forfeited', 'transactionHistory'],
      },
    ]);
  });

  it('the admin checklist renders the GROUPS (with panel headings), not the flat key list', () => {
    const src = read('/components/leave-type-panel.tsx');
    expect(src.includes('ESS_VIEW_CHECKLIST_GROUPS')).toBe(true);
    // The flat render over ESS_VIEW_COMPONENT_KEYS is gone from the checklist.
    expect(src.includes('ESS_VIEW_COMPONENT_KEYS')).toBe(false);
    // Headings reuse the employee panel's own section titles (leave.breakdown namespace) + the Other label.
    expect(src.includes("useTranslations('leave.breakdown')")).toBe(true);
    expect(src.includes("t('essView.groupOther')")).toBe(true);
    // The persistence contract is untouched: same marker + per-key checkbox names.
    expect(src.includes('name="essView"')).toBe(true);
    expect(src.includes('essView_${key}')).toBe(true);
  });
});
