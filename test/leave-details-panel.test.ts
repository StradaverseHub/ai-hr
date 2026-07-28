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
  RECONCILIATION_ADDENDS,
  reconciledBalance,
  type PanelData,
} from '../components/leave/entitlement-panel-config';
import { ESS_VIEW_COMPONENT_KEYS } from '../core/ess-view';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

// A synthetic, fully-populated envelope — every field's `select` is a pure pick over this (no formula).
//
// The 0315dac7 ledger-partition figures are deliberately chosen so each new bucket is DISTINCT from the legacy
// derived figure it replaced (broughtForward 5 vs carriedForward 4, forfeitedThisCycle 3 vs forfeited 1,
// configAdjustments 4 vs the commingled otherAdjustments 5) — otherwise a repointed line would pass by
// coincidence. They also satisfy the reconciliation identity:
//   5 (brought forward) + 12 (entitled) + 4 (config) + 1 (system) − 3 (forfeited) − 2 (taken) = 17 = balance
//   17 (balance) − 1 (pending) = 16 = totalAvailable
const DATA: PanelData = {
  breakdown: {
    leaveTypeId: 'lt1',
    leaveType: 'Annual Leave',
    asOf: '2026-02-15',
    cycleStart: '2026-01-01',
    currentYearEntitlement: 12,
    monthlyAccruedToDate: 2,
    carriedForward: 4,
    carryForwardRemaining: 3,
    carryForwardExpiryDate: '2026-03-31',
    forfeited: 1,
    // Commingled legacy figure = config 4 + system 1. Still fed to the balance TABLE's Adjustment column;
    // the panel's Adjustment line no longer reads it.
    otherAdjustments: 5,
    balance: 17,
    pendingApproval: 1,
    broughtForward: 5,
    configAdjustments: 4,
    systemAdjustments: 1,
    forfeitedThisCycle: 3,
    takenThisCycle: 2,
    configAdjustmentItems: [
      { effectiveOn: '2026-02-01', days: 3, reason: 'CNY 2026' },
      { effectiveOn: '2026-02-10', days: 1, reason: null },
    ],
    totalAvailable: 16,
    transactions: [
      { effectiveOn: '2026-01-01', entryType: 'accrual', days: 12, sourceRequestId: null, reason: null },
    ],
    essView: {},
  },
  // §1 Balance (6574c6b4): the authoritative ledger remaining (b.balance), passed straight into summary.balance
  // by the call site — no longer re-derived here. 17 is this fixture's ledger figure; the field just picks it.
  summary: { available: 15, taken: 2, pending: 1, ytdEntitled: 12, balance: 17 },
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
      // 0315dac7: the consolidated "how this adds up" reconciliation block.
      'reconciliation',
    ]);
    // e503f284: §2 "Entitlement Breakdown" is gone and §7 "Entitlement Calculation Breakdown" now sorts to
    // order 2 — immediately after the summary (order 1), the slot §2 used to hold.
    expect(keys).not.toContain('entitlement');
    const byKey = Object.fromEntries(ENTITLEMENT_PANEL_SECTIONS.map((s) => [s.key, s]));
    expect(byKey.calcBreakdown.order).toBe(2);
    const sorted = [...ENTITLEMENT_PANEL_SECTIONS].sort((a, b) => a.order - b.order).map((s) => s.key);
    // The reconciliation block sorts LAST — it is the summing-up of everything above it.
    expect(sorted).toEqual(['summary', 'calcBreakdown', 'utilization', 'adjustments', 'reconciliation']);
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
    expect(field('summary', 'balance').select!(DATA)).toBe(17);
  });

  it('§1 summary is reordered YTD Entitled → Taken → Pending → Available → Balance, each with a static tooltip', () => {
    const summary = ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'summary')!;
    expect(summary.fields!.map((f) => f.key)).toEqual(['ytdEntitled', 'taken', 'pendingApproval', 'available', 'balance']);
    // Every summary row carries a STATIC hover tooltip (no HR config); Balance is never ESS-gated (no essKey).
    expect(summary.fields!.every((f) => typeof f.tooltipKey === 'string')).toBe(true);
    expect(summary.fields!.find((f) => f.key === 'balance')!.essKey).toBeUndefined();
  });

  it('§1 Balance is a plain pick of d.summary.balance — the call site passes b.balance directly (6574c6b4)', () => {
    // deriveSummaryBalance is DELETED: the old panel formula double-subtracted forfeited and re-added carry/
    // adjustments over the ledger sum. The ledger remaining (b.balance) is now passed straight into
    // summary.balance, so the panel and the balance table always show the same authoritative figure.
    const balanceField = ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'summary')!.fields!.find((f) => f.key === 'balance')!;
    expect(balanceField.select!(DATA)).toBe(DATA.summary.balance);
    // Mei Ling regression: a true +14 flows through untouched (no re-derivation).
    expect(balanceField.select!({ ...DATA, summary: { ...DATA.summary, balance: 14 } })).toBe(14);
  });

  it('the §7 calc-breakdown carries the engine figures §2 used to duplicate (e503f284 removed §2)', () => {
    // §2 "Entitlement Breakdown" is removed; its engine figures live on in §7 (currentYearEntitlement =
    // entitlement-to-date, carriedForward = brought-forward, plus carry-forward expiry + forfeited).
    expect(field('calcBreakdown', 'currentYearEntitlement').select!(DATA)).toBe(12);
    expect(field('calcBreakdown', 'carryForwardExpiry').select!(DATA)).toBe('2026-03-31');
  });

  it('0315dac7: §7 Carried forward / Forfeited read the LEDGER buckets, not the derived carry arithmetic', () => {
    // Carried forward now shows broughtForward (the raw signed balance that crossed the boundary, 5), NOT the
    // post-cap derived `carriedForward` (4) — one carried number, and the one the reconciliation sums.
    expect(field('calcBreakdown', 'carriedForward').select!(DATA)).toBe(DATA.breakdown.broughtForward);
    expect(field('calcBreakdown', 'carriedForward').select!(DATA)).not.toBe(DATA.breakdown.carriedForward);
    // Forfeited now sums the ACTUAL forfeit ledger rows (3), not the derived cap-excess (1) that
    // double-subtracted whenever a year-open cap or maxBalanceDays clamp fired.
    expect(field('calcBreakdown', 'forfeited').select!(DATA)).toBe(DATA.breakdown.forfeitedThisCycle);
    expect(field('calcBreakdown', 'forfeited').select!(DATA)).not.toBe(DATA.breakdown.forfeited);
    // The annual-carry DETAIL lines are untouched — they stay as the carry-specific explanation.
    expect(field('calcBreakdown', 'carryForwardRemaining').select!(DATA)).toBe(3);
  });

  it('0315dac7 ask 1: §4 Adjustment = configAdjustments (the Adjustment config), system corrections split out', () => {
    // The Adjustment line ties to Leave Config → Entitlement → Adjustment ONLY. The commingled
    // otherAdjustments (5 = config 4 + system 1) is no longer what the employee sees on this line.
    expect(field('adjustments', 'adjustment').select!(DATA)).toBe(DATA.breakdown.configAdjustments);
    expect(field('adjustments', 'adjustment').select!(DATA)).not.toBe(DATA.breakdown.otherAdjustments);
    // The automatic corrections get their own labelled line rather than hiding inside "Adjustment".
    expect(field('adjustments', 'systemCorrection').select!(DATA)).toBe(DATA.breakdown.systemAdjustments);
    // Both hide together behind HR's single Adjustment toggle.
    expect(field('adjustments', 'adjustment').essKey).toBe('adjustment');
    expect(field('adjustments', 'systemCorrection').essKey).toBe('adjustment');
  });

  it('0315dac7: §4 itemises each CONFIG adjustment with its own reason + day count, and they sum to the line', () => {
    const section = ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'adjustments')!;
    const items = section.itemsSelect!(DATA);
    expect(items.map((i) => ({ label: i.label, value: i.value, note: i.note }))).toEqual([
      { label: 'CNY 2026', value: 3, note: '2026-02-01' },
      // A row with no typed reason keeps its days and lets the panel render its own fallback copy.
      { label: null, value: 1, note: '2026-02-10' },
    ]);
    // The itemisation must account for the whole Adjustment figure — otherwise it explains nothing.
    expect(items.reduce((s, i) => s + i.value, 0)).toBe(DATA.breakdown.configAdjustments);
    // Config rows ONLY — system corrections are machine-posted and stay a single summarised line, and this
    // is deliberately NOT a revival of the removed §6 generic transaction table.
    expect(items.length).toBe(DATA.breakdown.configAdjustmentItems.length);
    expect(section.itemsEssKey).toBe('adjustment');
  });

  it('§7 calc-breakdown surfaces the engine values verbatim, incl. total available', () => {
    expect(field('calcBreakdown', 'currentYearEntitlement').select!(DATA)).toBe(12);
    expect(field('calcBreakdown', 'carryForwardRemaining').select!(DATA)).toBe(3);
    expect(field('calcBreakdown', 'totalAvailable').select!(DATA)).toBe(16);
    // monthlyAccrued is omitWhenNull so a grant-on-open type hides the row rather than showing a placeholder.
    expect(field('calcBreakdown', 'monthlyAccrued').omitWhenNull).toBe(true);
  });
});

describe('0315dac7 ask 3: the consolidated "how this adds up" reconciliation block', () => {
  const recon = () => ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'reconciliation')!;

  it('co-locates all six addends with = Balance and − Pending = Available, in that reading order', () => {
    // The reporter could not follow the Balance because the addends were SCATTERED across §1/§4/§7. Every
    // part of the sum now appears together, in the order it is added.
    expect(recon().fields!.map((f) => f.key)).toEqual([
      'reconBroughtForward',
      'reconEntitled',
      'reconConfigAdjustments',
      'reconSystemAdjustments',
      'reconForfeited',
      'reconTaken',
      'reconBalance',
      'reconPending',
      'reconAvailable',
    ]);
    // A caption spells the formula out in words above the lines.
    expect(recon().captionKey).toBe('reconcile.caption');
  });

  it('every line is a plain PICK of a precomputed bucket, and the lines ADD UP to the Balance shown', () => {
    const v = (k: string) => recon().fields!.find((f) => f.key === k)!.select!(DATA) as number;
    expect(v('reconBroughtForward')).toBe(5);
    expect(v('reconEntitled')).toBe(12);
    expect(v('reconConfigAdjustments')).toBe(4);
    expect(v('reconSystemAdjustments')).toBe(1);
    expect(v('reconForfeited')).toBe(3);
    expect(v('reconTaken')).toBe(2);
    // The whole point: what the user reads off the block equals the Balance line it ends on.
    expect(v('reconBroughtForward') + v('reconEntitled') + v('reconConfigAdjustments') + v('reconSystemAdjustments') - v('reconForfeited') - v('reconTaken')).toBe(v('reconBalance'));
    expect(v('reconBalance') - v('reconPending')).toBe(v('reconAvailable'));
    // …and the exported identity helper (shared with the server-side reconciliation test) agrees.
    expect(reconciledBalance(DATA.breakdown)).toBe(DATA.breakdown.balance);
  });

  it('the rendered addends and RECONCILIATION_ADDENDS cannot drift apart', () => {
    // A line added to the block without a matching addend (or vice-versa) would silently stop the block
    // adding up. Assert the two lists describe the same six buckets.
    const rendered = recon()
      .fields!.filter((f) => f.key.startsWith('recon') && !['reconBalance', 'reconPending', 'reconAvailable'].includes(f.key))
      .map((f) => f.select!(DATA) as number);
    const declared = RECONCILIATION_ADDENDS.map((a) => DATA.breakdown[a.key] as number);
    expect(rendered).toEqual(declared);
    expect(RECONCILIATION_ADDENDS.filter((a) => a.sign === -1).map((a) => a.key)).toEqual([
      'forfeitedThisCycle',
      'takenThisCycle',
    ]);
  });

  it('is never ESS-gated — a half-hidden transparency block would show a sum that does not add up', () => {
    expect(recon().essKey).toBeUndefined();
    expect(recon().fields!.every((f) => f.essKey === undefined)).toBe(true);
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
    // 0315dac7: a section caption (the reconciliation formula in words) must resolve everywhere too.
    ...ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => (s.captionKey ? [s.captionKey] : [])),
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
    // 0315dac7: the fallback copy for an itemised config adjustment that carries no typed reason.
    'adjustmentNoReason',
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

  it('0315dac7: the mirror type carries the whole ledger partition (else the panel silently loses lines)', () => {
    // The adapter's structural mirror is what the RSC's breakdown object is assigned to. A bucket missing
    // here would compile fine on the server and render nothing in the block.
    for (const k of [
      'balance',
      'pendingApproval',
      'broughtForward',
      'configAdjustments',
      'systemAdjustments',
      'forfeitedThisCycle',
      'takenThisCycle',
      'configAdjustmentItems',
    ]) {
      expect(adapter.includes(`${k}:`), `mirror type missing ${k}`).toBe(true);
    }
  });

  it('0315dac7: the panel renders the section caption and the itemised config adjustments', () => {
    expect(panel.includes('section.captionKey')).toBe(true);
    expect(panel.includes('itemsSelect')).toBe(true);
    expect(panel.includes('itemsEssKey')).toBe(true);
    // The itemised reason is USER data, rendered verbatim; only the empty-reason fallback is translated.
    expect(panel.includes("t('adjustmentNoReason')")).toBe(true);
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
    // No trailing 'other' since feedback 1f6fd6d8: the keys that used to land there either gated nothing at
    // all (removed from the allow-list) or now carry the §7 field they name. The bucket itself stays in the
    // builder — it is what would make a FUTURE orphan visible instead of unreachable — but it is empty, and
    // the builder drops empty groups.
    expect(groupKeys).toEqual(sectionKeys);
    // Section groups reuse the panel's OWN heading key; only the orphan group has none (admin-side label).
    for (const g of ESS_VIEW_CHECKLIST_GROUPS) {
      if (g.key === 'other') expect(g.labelKey).toBeNull();
      else expect(g.labelKey).toBe(ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === g.key)!.labelKey);
    }
  });

  it('current grouping reads exactly like the panel: summary → calcBreakdown → utilization → adjustments', () => {
    // Feedback 1f6fd6d8. The six keys that used to sit in a trailing "Other" bucket were the reporter's
    // complaint made concrete: a configuration list that no longer described the summary. Three of them
    // (entitlementToDate, expiredBroughtForward, transactionHistory) gated rows that had already been removed
    // from the product and left the allow-list; the other three now hang off the §7 rows they name, so the
    // checklist is the panel's list in the panel's order, with nothing left over.
    expect(ESS_VIEW_CHECKLIST_GROUPS.map((g) => ({ key: g.key, keys: g.keys }))).toEqual([
      { key: 'summary', keys: ['ytdEntitled', 'taken', 'pendingApproval', 'available'] },
      {
        key: 'calcBreakdown',
        keys: ['entitlementCalcBreakdown', 'broughtForward', 'carryForwardExpiry', 'forfeited'],
      },
      { key: 'utilization', keys: ['unplanned', 'overutilized'] },
      { key: 'adjustments', keys: ['adjustment'] },
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
