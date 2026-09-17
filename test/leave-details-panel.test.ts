/**
 * Leave Details Side Panel (feedback 584edf44) — configurable Calculation-Breakdown-Display framework,
 * REBUILT to the reporter's Leave Balance Summary by feedback 1f6fd6d8.
 *
 * DB-free / jsdom-free guard (the suite has no DOM runner). It proves two things:
 *
 *   1. The panel is still driven by a DECLARATIVE descriptor (entitlement-panel-config.ts) — every row PICKS
 *      an already-computed value, no formula is hardcoded, and the layout the reporter specified (order,
 *      signs, dividing rules, emphasised results, the expiry sub-line) is declared as data rather than as
 *      JSX. That property is what makes a future line one entry instead of a redesign.
 *
 *   2. THE COLUMN ADDS UP, and it adds up onto the authoritative Available Balance. This is the substance of
 *      the item: Total = Eligible-independent sums of the ledger partition, and
 *      Total − Taken − Pending − Forfeited = Available. Asserted here on a fixture that satisfies the
 *      server's reconciliation identity, so a descriptor edit that quietly repoints a row at a different
 *      bucket fails rather than merely looks different.
 *
 * Also pinned: the four removed sections cannot come back, and the admin checklist is DERIVED from this
 * descriptor (ed17a4f9's synchronisation requirement) so the configuration screen and the summary cannot
 * drift apart.
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
import { LEAVE_SUMMARY_EXPLAIN_KEYS } from '../lib/leave-summary-explain';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

// A synthetic, fully-populated envelope — every field's `select` is a pure pick over this (no formula).
//
// The figures satisfy the server's reconciliation identity, and each bucket is deliberately DISTINCT from
// the legacy derived figure it replaced (broughtForward 5 vs carriedForward 4, forfeitedThisCycle 3 vs
// forfeited 1) so a mis-pointed row cannot pass by coincidence:
//   5 (brought forward) + 12 (entitled) + 4 (config) + 1 (system) − 3 (forfeited) − 2 (taken) = 17 = balance
//   17 (balance) − 1 (pending) = 16 = totalAvailable
// and the two 1f6fd6d8 roll-ups over the same buckets:
//   adjustments      = 4 + 1                 = 5
//   totalEntitlement = 5 + 12 + 5            = 22
// Eligible (20) is deliberately NOT equal to the granted-to-date 12: a full-year entitlement that is only
// partly granted is the ordinary case, and conflating the two is the exact mistake the deviation avoids.
const DATA: PanelData = {
  breakdown: {
    leaveTypeId: 'lt1',
    leaveType: 'Annual Leave',
    asOf: '2026-02-15',
    cycleStart: '2026-01-01',
    eligibleDays: 20,
    // 31e39d74: this fixture's type has 12 granted days, so its state is `granted` and the panel shows no
    // notice — which keeps every existing case below asserting the SUMMARY COLUMN and nothing else.
    entitlementStatus: 'granted',
    entitlementTemplateName: 'Executive Annual Leave',
    currentYearEntitlement: 12,
    monthlyAccruedToDate: 2,
    carriedForward: 4,
    carryForwardRemaining: 3,
    carryForwardExpiryDate: '2026-03-31',
    forfeited: 1,
    otherAdjustments: 5,
    balance: 17,
    pendingApproval: 1,
    broughtForward: 5,
    configAdjustments: 4,
    systemAdjustments: 1,
    forfeitedThisCycle: 3,
    takenThisCycle: 2,
    configAdjustmentItems: [],
    adjustments: 5,
    totalEntitlement: 22,
    totalAvailable: 16,
    transactions: [
      { effectiveOn: '2026-01-01', entryType: 'accrual', days: 12, sourceRequestId: null, reason: null },
    ],
    essView: {},
  },
  // The authoritative bookable figure from leaveBalances — the ONE line not taken from the breakdown.
  summary: { available: 16 },
};

const summary = () => ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'summary')!;
const field = (fieldKey: string) => summary().fields!.find((f) => f.key === fieldKey)!;
const value = (fieldKey: string) => field(fieldKey).select!(DATA) as number;

describe('1f6fd6d8: the panel is ONE Leave Summary column in the reporter’s order', () => {
  it('declares exactly one section, and the four overlapping ones cannot come back', () => {
    expect(ENTITLEMENT_PANEL_SECTIONS.map((s) => s.key)).toEqual(['summary']);
    // Each of these was its own section before the redesign. The descriptor entry is GONE, so no leave type
    // and no stored ESS config can re-surface any of them.
    for (const gone of ['utilization', 'adjustments', 'calcBreakdown', 'reconciliation', 'entitlement', 'transactions', 'upcoming']) {
      expect(ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === gone), `${gone} must be removed`).toBeUndefined();
    }
  });

  it('lists the nine rows the reporter specified, in their order', () => {
    expect(summary().fields!.map((f) => f.key)).toEqual([
      'eligible',
      'ytdEntitled',
      'broughtForward',
      'adjustment',
      'total',
      'taken',
      'pendingApproval',
      'forfeited',
      'available',
    ]);
  });

  it('every row is configurable and carries a static tooltip (nothing shows without a switch)', () => {
    for (const f of summary().fields!) {
      expect(typeof f.key).toBe('string');
      expect(typeof f.labelKey).toBe('string');
      expect(f.essKey, `${f.key} must be ESS-configurable`).toBeTruthy();
      expect(typeof f.tooltipKey, `${f.key} needs a static tooltip`).toBe('string');
    }
  });

  it('declares the LAYOUT as data: signed addends, two rules, two emphasised results, the expiry note', () => {
    // The reporter supplied a layout, not just a list. Declaring it here rather than in JSX is what keeps a
    // future line a one-entry change.
    expect(summary().fields!.filter((f) => f.sign === '+').map((f) => f.key)).toEqual(['broughtForward', 'adjustment']);
    expect(summary().fields!.filter((f) => f.sign === '-').map((f) => f.key)).toEqual(['taken', 'pendingApproval', 'forfeited']);
    // A rule above each subtotal, and only there.
    expect(summary().fields!.filter((f) => f.ruleBefore).map((f) => f.key)).toEqual(['total', 'available']);
    expect(summary().fields!.filter((f) => f.emphasis === 'result').map((f) => f.key)).toEqual(['total', 'available']);
    // Brought Forward Forfeited carries the expiry date as its own sub-line, not as a separate row.
    expect(field('forfeited').noteSelect!(DATA)).toBe('2026-03-31');
    expect(field('forfeited').noteLabelKey).toBe('expiresOn');
    // …and no OTHER row does, so the date appears exactly once, beside the figure it explains.
    expect(summary().fields!.filter((f) => f.noteSelect).map((f) => f.key)).toEqual(['forfeited']);
  });
});

describe('1f6fd6d8: every row PICKS a precomputed figure (no hardcoded formula)', () => {
  it('reads the ledger partition, not the derived carry arithmetic', () => {
    expect(value('eligible')).toBe(20);
    expect(value('ytdEntitled')).toBe(12);
    expect(value('broughtForward')).toBe(5);
    expect(value('adjustment')).toBe(5);
    expect(value('total')).toBe(22);
    expect(value('taken')).toBe(2);
    expect(value('pendingApproval')).toBe(1);
    expect(value('forfeited')).toBe(3);
    expect(value('available')).toBe(16);
    // Brought Forward is the RAW signed figure that crossed the boundary (5), never the post-cap derived
    // `carriedForward` (4) — one carried number, and the one the identity sums.
    expect(value('broughtForward')).not.toBe(DATA.breakdown.carriedForward);
    // Forfeited sums the ACTUAL forfeit ledger rows (3), not the derived cap-excess (1) which
    // double-subtracted whenever a year-open cap or maxBalanceDays clamp fired.
    expect(value('forfeited')).not.toBe(DATA.breakdown.forfeited);
    // Adjustments is the ONE line: config + system, not the commingled legacy otherAdjustments.
    expect(value('adjustment')).toBe(DATA.breakdown.configAdjustments + DATA.breakdown.systemAdjustments);
  });

  it('THE COLUMN ADDS UP — Total, then down to the Available Balance the rest of the system shows', () => {
    // This is the item. Reading the panel top to bottom must arrive at the last line.
    expect(value('broughtForward') + value('ytdEntitled') + value('adjustment')).toBe(value('total'));
    expect(value('total') - value('taken') - value('pendingApproval') - value('forfeited')).toBe(value('available'));
    // …and the last line is the AUTHORITATIVE figure from leaveBalances, not one this screen worked out.
    // If it were recomputed from the lines above, this screen and the leave-apply popup could diverge —
    // which the reporter called out in the strongest terms.
    expect(field('available').select!(DATA)).toBe(DATA.summary.available);
    expect(field('available').select!({ ...DATA, summary: { available: 99 } })).toBe(99);
  });

  it('the arithmetic holds because the server buckets tile the ledger (the identity, not an agreement)', () => {
    expect(reconciledBalance(DATA.breakdown)).toBe(DATA.breakdown.balance);
    expect(DATA.breakdown.balance - DATA.breakdown.pendingApproval).toBe(DATA.breakdown.totalAvailable);
    // The two roll-ups the summary reads are sums of exactly those buckets.
    const addends = Object.fromEntries(RECONCILIATION_ADDENDS.map((a) => [a.key, a.sign]));
    expect(addends.forfeitedThisCycle).toBe(-1);
    expect(addends.takenThisCycle).toBe(-1);
    expect(DATA.breakdown.adjustments).toBe(DATA.breakdown.configAdjustments + DATA.breakdown.systemAdjustments);
    expect(DATA.breakdown.totalEntitlement).toBe(
      DATA.breakdown.broughtForward + DATA.breakdown.currentYearEntitlement + DATA.breakdown.adjustments,
    );
  });

  it('THE RECORDED DEVIATION: YTD Entitled is the granted-to-date LEDGER figure, not a prorated projection', () => {
    // The reporter's formula was Eligible × (elapsed ÷ year). For the ten up-front-granted policies the full
    // grant is already in the ledger on day one, so a part-year share would stop the column reaching
    // Available Balance. Rendering the ledger figure keeps the column closed for BOTH earning methods.
    // Guard: YTD Entitled must never be derived from Eligible.
    //
    // r279 — THIS ASSERTION WAS NEVER WRONG; THE NAME IT WAS WRITTEN UNDER WAS. The reporter asked for the
    // grid's "YTD Entitled" column to be renamed "Full Entitlement". These two lines are the proof that it
    // could not be: the figure is `currentYearEntitlement` and is provably NOT `eligibleDays`, so the new
    // name would have put an accrued-to-date number (12.50 against a band of 18.00 on employment 02617b4a,
    // 17.00 against 24.00 on 99e97e85) under a full-year heading. The rename was done the other way round —
    // the grid column is now "Earned to Date" and a new Full Entitlement column binds to `eligibleDays`, the
    // very field the first assertion below forbids this one from reading. Keep both assertions: they are now
    // ALSO the guard that the grid's two columns can never collapse into one number.
    // See components/leave/leave-balance-row.ts and test/r279-earned-and-full-entitlement.test.ts.
    expect(value('ytdEntitled')).toBe(DATA.breakdown.currentYearEntitlement);
    expect(value('ytdEntitled')).not.toBe(DATA.breakdown.eligibleDays);
    // Changing Eligible alone must move NOTHING else on the column — proof there is no projection wired in.
    const richer: PanelData = { ...DATA, breakdown: { ...DATA.breakdown, eligibleDays: 200 } };
    expect(field('ytdEntitled').select!(richer)).toBe(12);
    expect(field('total').select!(richer)).toBe(22);
    expect(field('available').select!(richer)).toBe(16);
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
    ...ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => (s.captionKey ? [s.captionKey] : [])),
    ...ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => (s.fields ?? []).map((f) => f.labelKey)),
    ...ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => (s.fields ?? []).flatMap((f) => (f.tooltipKey ? [f.tooltipKey] : []))),
    // 1f6fd6d8: the expiry sub-line under Brought Forward Forfeited.
    ...ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => (s.fields ?? []).flatMap((f) => (f.noteLabelKey ? [f.noteLabelKey] : []))),
    // Literals the panel renders directly.
    'explanationShow',
    'explanationHide',
    'explanationDescription',
    'explanationFormula',
    'panelSubtitle',
    'close',
    'noExpiry',
    'viewBreakdown',
    'adjustmentNoReason',
    'asAtDate',
    'apply',
    // r303 (31492f74): every sentence HR's mounts can print under a line (lib/leave-summary-explain.ts).
    ...LEAVE_SUMMARY_EXPLAIN_KEYS.map((k) => `explain.${k}`),
  ];

  for (const loc of LOCALES) {
    it(`${loc} resolves every section/field label + panel literal`, () => {
      const missing = labelKeys.filter((k) => getPath(dicts[loc], k) == null || getPath(dicts[loc], k) === '');
      expect(missing, `[${loc}] missing: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('the removed sections’ i18n keys are gone from EVERY locale, not just English', () => {
    // A leftover label is how a removed row quietly comes back. Sweep all six.
    for (const loc of LOCALES) {
      const b = dicts[loc] as Record<string, unknown>;
      expect(Object.keys(b.section as object), `[${loc}] section`).toEqual(['summary']);
      for (const gone of ['reconcile', 'currentYearEntitlement', 'monthlyAccrued', 'carriedForward', 'carryForwardRemaining', 'totalAvailable', 'explanationResult']) {
        expect(b[gone], `[${loc}] leave.breakdown.${gone} should be removed`).toBeUndefined();
      }
    }
  });
});

describe('Leave Details panel: the inline expand is still a Radix right side-sheet', () => {
  const panel = read('/components/leave/LeaveDetailsPanel.tsx');
  const adapter = read('/components/leave/EntitlementBreakdown.tsx');

  it('panel is a DB-free client island using the app Dialog primitive', () => {
    expect(panel.startsWith("'use client'")).toBe(true);
    expect(panel).toMatch(/@radix-ui\/react-dialog/);
    expect(panel.includes("from '@/db")).toBe(false);
  });

  it('Dialog.Content is styled as a fixed right side-sheet (max-w-md, bg-popover, border-l)', () => {
    expect(panel).toMatch(/fixed inset-y-0 right-0/);
    expect(panel).toMatch(/max-w-md/);
    expect(panel).toMatch(/bg-popover/);
    expect(panel).toMatch(/border-l/);
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

  it('renders the layout FROM the descriptor rather than hardcoding the reporter’s design', () => {
    // If any of these move into JSX conditionals keyed off a field NAME, the framework property is lost.
    for (const prop of ['f.sign', 'f.ruleBefore', 'f.emphasis', 'f.noteSelect', 'f.noteLabelKey']) {
      expect(panel.includes(prop), `panel must render ${prop} from the descriptor`).toBe(true);
    }
  });

  it('ed17a4f9: the panel no longer renders a Result line (that field is removed)', () => {
    expect(panel.includes('explanationResult')).toBe(false);
    expect(panel.includes('explanation!.result')).toBe(false);
  });

  it('the mirror type carries every figure the summary reads (else the panel silently loses lines)', () => {
    // The adapter's structural mirror is what the RSC's breakdown object is assigned to. A field missing
    // here would compile fine on the server and render nothing.
    // r303 (31492f74): `derivation` — the working HR's per-line sentences are rendered from.
    for (const k of ['eligibleDays', 'adjustments', 'totalEntitlement', 'broughtForward', 'forfeitedThisCycle', 'takenThisCycle', 'pendingApproval', 'carryForwardExpiryDate', 'derivation?']) {
      expect(adapter.includes(`${k}:`), `mirror type missing ${k}`).toBe(true);
    }
  });
});

describe('Leave Details panel: both call sites feed the trimmed §1 summary + visual', () => {
  // UPDATED BY r302 (6c9802c9): the employee's side-sheet is opened by the My Leave dashboard island now (the
  // page no longer renders a breakdown itself), so the call site moved from app/leave/page.tsx to it. The
  // same three facts are asserted at the new site.
  const PAGES = ['/components/leave/my-leave-dashboard.tsx', '/app/admin/personnel/[employmentId]/page.tsx'] as const;
  for (const p of PAGES) {
    const src = read(p);
    it(`${p} passes summary + visual to the breakdown panel`, () => {
      expect(src.includes('summary={{')).toBe(true);
      expect(src.includes('visual={{')).toBe(true);
      expect(src.includes('upcoming={')).toBe(false);
    });
  }

  // 11876072 removed the panel's §5 "Upcoming Approved Leave", and the pins above (no `upcoming=` prop; no
  // 'upcoming' section descriptor) keep the PANEL that way. r302 (6c9802c9) REVERSES that removal at the
  // reporter's request — but as a section of the PAGE, not a line in the panel: "Upcoming Leave lists approved
  // and pending leave from today onwards". Pinned here beside the no-upcoming pins so the two decisions are
  // read together: the page has an Upcoming Leave section; the panel still has no upcoming list.
  it('r302: /leave renders an Upcoming Leave section of its own, fed by the approved+pending read', () => {
    const page = read('/app/leave/page.tsx');
    expect(page).toContain('<UpcomingLeave rows={upcoming} locale={locale} />');
    expect(page).toContain('myUpcomingLeave(session, historyEmploymentIds, today)');
    expect(read('/core/my-leave.ts')).toContain("statuses: ['pending', 'approved'],");
    // …and the panel takes no upcoming prop (comments recording the 11876072 removal are allowed).
    expect(read('/components/leave/LeaveDetailsPanel.tsx')).not.toMatch(/\bupcoming\??:\s/);
  });

  it('r303: only the HR call site switches the per-line sentences on; the employee dashboard never does', () => {
    expect(read('/components/leave/my-leave-dashboard.tsx')).not.toContain('hrExplanation');
    expect(read('/app/admin/personnel/[employmentId]/page.tsx')).toContain('hrExplanation={{ sharedBalance: b.sharedBalance ?? null }}');
    expect(read('/app/leave/employee-balances/page.tsx')).toContain('hrExplanation={r.hrExplanation}');
  });

  it('1f6fd6d8: no call site still feeds the four figures the summary stopped taking from leaveBalances', () => {
    // PanelSummary is down to `available`. A call site still passing taken/pending/ytdEntitled/balance would
    // be a type error today, but this pins the INTENT: those figures now come from the breakdown, whose
    // buckets are what make the column close.
    for (const p of PAGES) {
      expect(read(p).includes('ytdEntitled: b.accrued'), `${p} still feeds the old summary shape`).toBe(false);
    }
  });
});

describe('ed17a4f9: the admin checklist is DERIVED from the panel, so the two cannot drift', () => {
  it('ESS_VIEW_CHECKLIST_GROUPS covers every configurable key exactly once (drift guard)', () => {
    const flat = ESS_VIEW_CHECKLIST_GROUPS.flatMap((g) => g.keys);
    expect([...flat].sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('is ONE group — the Leave Summary — listing the nine items in the summary’s own display order', () => {
    // The reporter's synchronisation requirement, stated as code: the configuration screen offers exactly
    // the lines the summary renders, in the order it renders them, and nothing else.
    expect(ESS_VIEW_CHECKLIST_GROUPS.map((g) => ({ key: g.key, keys: g.keys }))).toEqual([
      {
        key: 'summary',
        keys: ['eligible', 'ytdEntitled', 'broughtForward', 'adjustment', 'total', 'taken', 'pendingApproval', 'forfeited', 'available'],
      },
    ]);
    expect(ESS_VIEW_CHECKLIST_GROUPS[0].keys).toEqual(summary().fields!.map((f) => f.essKey));
    // No trailing "Other" group: nothing gates a surface outside the panel any more. The bucket stays in the
    // builder (it is what would make a FUTURE orphan visible) but it is empty and dropped.
    expect(ESS_VIEW_CHECKLIST_GROUPS.some((g) => g.key === 'other')).toBe(false);
  });

  it('groups reuse the panel’s OWN heading key, never an admin-side copy of it', () => {
    for (const g of ESS_VIEW_CHECKLIST_GROUPS) {
      expect(g.labelKey).toBe(ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === g.key)!.labelKey);
    }
  });

  it('the admin checklist renders the GROUPS, not the flat key list', () => {
    const src = ['/app/admin/leave-config/types/page.tsx', '/app/admin/leave-config/types/leave-type-tabs.tsx', '/app/admin/leave-config/types/leave-type-sub-forms.tsx']
      .map((f) => read(f))
      .join('\n');
    expect(src.includes('ESS_VIEW_CHECKLIST_GROUPS')).toBe(true);
    expect(src.includes('ESS_VIEW_COMPONENT_KEYS')).toBe(false);
    expect(src.includes("useTranslations('leave.breakdown')")).toBe(true);
    // The persistence contract is untouched: same marker + per-key checkbox names.
    expect(src.includes('name="essView"')).toBe(true);
    expect(src.includes('essView_${key}')).toBe(true);
    // ed17a4f9: the seven legacy calc-breakdown sub-editors are gone with their section.
    expect(src.includes('LEAVE_FORMULA_COMPONENT_KEYS')).toBe(false);
    expect(src.includes('entitlementCalcBreakdown')).toBe(false);
  });
});
