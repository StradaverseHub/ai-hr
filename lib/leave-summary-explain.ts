/**
 * r303 (31492f74) — THE LEAVE SUMMARY, LINE BY LINE, IN SENTENCES HR CAN READ.
 *
 * HR opens Explain on Employee Leave Inquiry (and the Personnel record) and sees nine figures. Until this item
 * each carried the same static definition for every employee — what a line MEANS, never how THIS employee's
 * number was reached. This module turns the `derivation` that `leaveEntitlementBreakdown` (core/read.ts) builds
 * beside the figures into, per line, a list of steps `{ key, args }` the panel renders through next-intl.
 *
 * ═══ PURE, AND DELIBERATELY INCAPABLE OF RECOMPUTING ═══
 *
 * The same contract core/pcb-explain.ts and core/attendance-explain.ts state, for the same reason: a sentence
 * that could disagree with the figure beside it is worse than no sentence. Nothing here resolves a table, a
 * band, a rule or a date. Every amount it prints either IS a figure the server computed, or is one of the
 * itemised records the server pushed in the SAME branch that added it to that figure (core/read.ts). The only
 * arithmetic here is the SUM-GUARD below, and it never produces a printed figure: it only decides whether the
 * itemised list may be printed at all.
 *
 * ═══ THE SUM-GUARD ═══
 *
 * For every itemised line, `r2(Σ items) === figure` is checked before the list is emitted. By construction it
 * always holds (test/r303-leave-summary-explain.test.ts proves it on real engine-posted ledgers). If it ever
 * does not, the line says the records could not be itemised instead of printing a list that claims to add up
 * to a number it does not reach. Available Balance prints its formula only when `summary.available` equals the
 * breakdown's own `totalAvailable` and the column closes onto it; otherwise a sentence says why they differ.
 *
 * ═══ NO PROSE, NO FORMATTING ═══
 *
 * Steps carry an i18n key (under `leave.breakdown.explain`) and TYPED arguments — days, a signed day figure, a
 * date, user-authored text, a count, a select choice, a list of names. The panel turns those into strings, so
 * the day formatter stays the one shared formatter (lib/day-format.ts) and this module stays six-locale-neutral.
 *
 * ═══ STATUSES ARE READ, NEVER INFERRED ═══
 *
 * "No entitlement table applies", "no earning method is set" and the rest come from `entitlementStatus`, which
 * the breakdown already decides with the engine's own predicates (lib/entitlement-status.ts). This module
 * switches on that value; it never looks at a 0.00 and guesses why.
 *
 * DB-free and framework-free: imported by the client side-sheet (components/leave/LeaveDetailsPanel.tsx) and by
 * core/read.ts for the derivation's TYPE only.
 * Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */
import type { EntitlementStatus } from './entitlement-status';
import { otherContributors, type SharedLeaveBalanceInfo } from './shared-leave-balance';

// ── The derivation core/read.ts builds ──────────────────────────────────────────────────────────────────

/** Mirror of core/entitlement-template.ts `EntitlementWinReason` (restated so this client-safe module imports no
 *  server module; core/read.ts assigns one to the other, so tsc fails if they drift). */
export type ExplainWinReason = 'sole_candidate' | 'more_specific' | 'later_start' | 'later_created' | 'arbitrary';

export type LeaveSummaryDerivation = {
  /** Full Entitlement — who decided the days, and from what. */
  entitlement: {
    /** The winning entitlement table, or null when none applies (the status says which kind of none). */
    tableName: string | null;
    /** How the table was chosen: a benefit scheme rule matched, it is the leave type's only table, or it is the
     *  leave type's default table. Null ⇒ no table applies. */
    via: 'scheme' | 'sole_table' | 'default_table' | null;
    /** The matching benefit scheme rule's name (only for `via: 'scheme'`). */
    schemeName: string | null;
    /** Why that scheme beat the runner-up — the tie-break's own term (`winReasonFor`). */
    winReason: ExplainWinReason | null;
    hiredOn: string;
    /** Completed years of service at the START OF THE LEAVE YEAR — the value the band was resolved at. */
    serviceYears: number;
    /** The band the table resolved at that length of service; null ⇒ no band covers it. */
    band: { fromYears: number; toYears: number | null } | null;
    /** The SAME local the breakdown returns as `eligibleDays`. */
    days: number;
  };
  /** Earned to Date — the method, the year, the rounding, the join-year rule and every credit. */
  earned: {
    /** The resolved earning method; null ⇒ nothing resolved to read one from. */
    method: 'up_front' | 'earned_monthly' | 'earned_quarterly' | 'earned_daily' | null;
    leaveYear: 'calendar' | 'anniversary';
    /** The leave type's own Leave Year Type override, when set. */
    leaveYearOverride: 'a2a' | 'c2c' | 'a2c' | null;
    cycleEnd: string;
    /** The rounding the resolved policy carries; null ⇒ nothing resolved. `custom_no_table` ⇒ the custom method
     *  is selected but no valid table is saved, which rounds nothing. */
    rounding: 'none' | 'up' | 'down' | 'nearest_half' | 'custom' | 'custom_no_table' | null;
    /** Set when the employee joined inside this leave year: which of the engine's join-year rules applies. */
    joinYear: {
      hiredOn: string;
      rule: 'months_remaining' | 'a2c_up_front' | 'full' | 'earned_from';
      /** For `earned_from`: the date earning counts from (`earnedAccrualStart`). */
      earnedFrom: string | null;
    } | null;
    /** Every accrual-class row in [cycleStart, asOf], pushed in the branch that adds it to the figure. */
    credits: { effectiveOn: string; days: number; kind: 'grant' | 'leave_credit' | 'a2c_correction' }[];
  };
  /** Brought Forward — the carry rule on the leave type (the figure itself is `broughtForward`). */
  carry: { rule: 'not_recorded' | 'off' | 'on'; maxDays: number; percent: number | null };
  /** Adjustments — HR's own rows and the automatic corrections, separately. */
  adjustments: {
    manual: { effectiveOn: string; days: number; reason: string | null }[];
    system: { effectiveOn: string; days: number; kind: 'policy_recalc' | 'profile_recalc' | 'a2c_recalc' }[];
  };
  /** Taken — approved leave (debits tied to a leave application) and every other deduction, as positive days. */
  taken: {
    leaveDays: number;
    other: {
      effectiveOn: string;
      days: number;
      /** What the Leave Credit register says the deduction was, when it says anything. */
      kind: 'credit_expired' | 'credit_paid_out' | 'credit_reversed' | null;
      reason: string | null;
    }[];
  };
  /** Pending Approval — every request the figure counts, from the query that counts it. */
  pending: { startDate: string; endDate: string; days: number }[];
  /** Brought Forward Forfeited — every forfeit row, as positive days, with why. */
  forfeited: { effectiveOn: string; days: number; kind: 'carry_cap' | 'carry_expiry' | 'type_expiry' }[];
};

/** The figures the sentences explain — a structural subset of the breakdown (EntitlementBreakdownData). */
export type LeaveSummaryFigures = {
  leaveType: string;
  asOf: string;
  cycleStart: string;
  eligibleDays: number;
  entitlementStatus: EntitlementStatus;
  currentYearEntitlement: number;
  broughtForward: number;
  adjustments: number;
  totalEntitlement: number;
  takenThisCycle: number;
  pendingApproval: number;
  forfeitedThisCycle: number;
  carryForwardExpiryDate: string | null;
  balance: number;
  totalAvailable: number;
  derivation?: LeaveSummaryDerivation | null;
};

// ── The steps the panel renders ─────────────────────────────────────────────────────────────────────────

export type ExplainArg =
  | { days: number }
  | { signedDays: number }
  | { date: string }
  | { text: string }
  | { count: number }
  | { choice: string }
  | { list: string[] };

export type ExplainStep = {
  /** i18n key under `leave.breakdown.explain`. */
  key: LeaveSummaryExplainKey;
  args?: Record<string, ExplainArg>;
  /** One record of a list — the panel renders consecutive items as a list under the sentence before them. */
  item?: true;
};

/** The nine lines, keyed exactly as components/leave/entitlement-panel-config.ts keys its fields. */
export const LEAVE_SUMMARY_LINE_KEYS = [
  'eligible',
  'ytdEntitled',
  'broughtForward',
  'adjustment',
  'total',
  'taken',
  'pendingApproval',
  'forfeited',
  'available',
] as const;
export type LeaveSummaryLineKey = (typeof LEAVE_SUMMARY_LINE_KEYS)[number];

/**
 * EVERY key this module can emit. The catalogue test asserts each exists in all six locales, and the explain
 * test asserts no emitted key falls outside this list, so a new sentence cannot ship as a MISSING_MESSAGE.
 */
export const LEAVE_SUMMARY_EXPLAIN_KEYS = [
  'unavailable',
  'itemsDoNotAddUp',
  'addsUpTo',
  'poolFigures',
  // Full Entitlement
  'eligibleNoTable',
  'eligibleNoMatch',
  'eligibleNotRecorded',
  'eligibleViaScheme',
  'eligibleWin',
  'eligibleViaSole',
  'eligibleViaDefault',
  'eligibleService',
  'eligibleBand',
  'eligibleBandOpen',
  'eligibleNoBand',
  'eligibleFullYear',
  // Earned to Date
  'earnedMethod',
  'earnedLeaveYear',
  'earnedRounding',
  'joinMonthsRemaining',
  'joinA2cUpFront',
  'joinFull',
  'joinEarnedFrom',
  'earnedNotGenerated',
  'earnedNothingYet',
  'earnedStranded',
  'earnedZeroTable',
  'earnedMethodMissing',
  'earnedCappedAtZero',
  'earnedNoTable',
  'earnedNone',
  'earnedCreditsIntro',
  'creditItem',
  'earnedActualOnly',
  // Brought Forward
  'bfAmount',
  'bfNone',
  'bfOverdrawn',
  'carryNotRecorded',
  'carryOff',
  'carryMax',
  'carryPercent',
  'carryPercentMax',
  'carryExpires',
  'carryNoExpiry',
  'bfForfeitNote',
  // Adjustments
  'adjNone',
  'adjNoManual',
  'adjManualIntro',
  'adjManualItem',
  'adjManualItemNoReason',
  'adjSystemIntro',
  'adjSystemItem',
  // Total
  'totalFormula',
  // Taken
  'takenNone',
  'takenLeave',
  'takenOtherIntro',
  'takenOtherItem',
  'takenOtherItemReason',
  'takenOtherItemUnrecorded',
  'takenPool',
  // Pending Approval
  'pendingNone',
  'pendingIntro',
  'pendingItem',
  'pendingItemOneDay',
  'pendingOwnOnly',
  // Brought Forward Forfeited
  'forfeitNone',
  'forfeitItem',
  'forfeitCarryExpiry',
  // Available Balance
  'availableFormula',
  'availablePool',
  'availableDiffers',
] as const;
export type LeaveSummaryExplainKey = (typeof LEAVE_SUMMARY_EXPLAIN_KEYS)[number];

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: { days: number }[]) => xs.reduce((s, x) => r2(s + x.days), 0);

const days = (n: number): ExplainArg => ({ days: n });
const signed = (n: number): ExplainArg => ({ signedDays: n });
const date = (d: string): ExplainArg => ({ date: d });
const text = (s: string): ExplainArg => ({ text: s });
const choice = (s: string): ExplainArg => ({ choice: s });

/** The list is printed only when it reaches the figure exactly; otherwise one sentence says it could not be. */
function guarded(items: number, figure: number, steps: ExplainStep[]): ExplainStep[] {
  return r2(items) === r2(figure) ? steps : [{ key: 'itemsDoNotAddUp', args: { figure: days(figure) } }];
}

export function explainLeaveSummary(
  f: LeaveSummaryFigures,
  p: {
    /** The panel's Available Balance line (`PanelSummary.available`) — the one figure not taken from `f`. */
    available: number;
    /** The row's shared-pool descriptor, when its figures are a pool's (`balanceStoryTypeId`). */
    sharedBalance?: SharedLeaveBalanceInfo | null;
  },
): Record<LeaveSummaryLineKey, ExplainStep[]> {
  const d = f.derivation;
  if (!d) {
    return Object.fromEntries(LEAVE_SUMMARY_LINE_KEYS.map((k) => [k, [{ key: 'unavailable' }]])) as Record<
      LeaveSummaryLineKey,
      ExplainStep[]
    >;
  }
  const pool = p.sharedBalance ?? null;
  const status = f.entitlementStatus;

  // ── Full Entitlement ────────────────────────────────────────────────────────────────────────────────
  const eligible: ExplainStep[] = [];
  if (pool) {
    eligible.push({
      key: 'poolFigures',
      args: { source: text(pool.sourceLeaveTypeName), others: { list: otherContributors(pool, pool.sourceLeaveTypeName) } },
    });
  }
  if (status === 'no_entitlement_table') {
    eligible.push({ key: 'eligibleNoTable' });
  } else if (status === 'no_eligibility_match') {
    eligible.push({ key: 'eligibleNoMatch' });
  } else if (d.entitlement.via == null || d.entitlement.tableName == null) {
    eligible.push({ key: 'eligibleNotRecorded' });
  } else {
    const e = d.entitlement;
    const table = text(e.tableName!);
    const body: ExplainStep[] = [];
    if (e.via === 'scheme') {
      body.push({ key: 'eligibleViaScheme', args: { table, scheme: text(e.schemeName ?? '') } });
      if (e.winReason && e.winReason !== 'sole_candidate') {
        body.push({ key: 'eligibleWin', args: { reason: choice(e.winReason) } });
      }
    } else if (e.via === 'sole_table') {
      body.push({ key: 'eligibleViaSole', args: { table } });
    } else {
      body.push({ key: 'eligibleViaDefault', args: { table } });
    }
    body.push({
      key: 'eligibleService',
      args: { hiredOn: date(e.hiredOn), cycleStart: date(f.cycleStart), years: { count: e.serviceYears } },
    });
    if (e.band) {
      body.push(
        e.band.toYears == null
          ? { key: 'eligibleBandOpen', args: { from: { count: e.band.fromYears }, days: days(e.days) } }
          : { key: 'eligibleBand', args: { from: { count: e.band.fromYears }, to: { count: e.band.toYears }, days: days(e.days) } },
      );
    } else {
      body.push({ key: 'eligibleNoBand', args: { days: days(e.days) } });
    }
    body.push({ key: 'eligibleFullYear' });
    eligible.push(...guarded(e.days, f.eligibleDays, body));
  }

  // ── Earned to Date ──────────────────────────────────────────────────────────────────────────────────
  const ytd: ExplainStep[] = [];
  const earned = d.earned;
  if (earned.method && status !== 'earning_method_missing') {
    ytd.push({ key: 'earnedMethod', args: { method: choice(earned.method) } });
  }
  ytd.push({
    key: 'earnedLeaveYear',
    args: {
      start: date(f.cycleStart),
      end: date(earned.cycleEnd),
      kind: choice(earned.leaveYearOverride === 'a2c' ? 'a2c' : earned.leaveYear),
    },
  });
  if (earned.rounding) ytd.push({ key: 'earnedRounding', args: { method: choice(earned.rounding) } });
  if (earned.joinYear) {
    const j = earned.joinYear;
    if (j.rule === 'earned_from') {
      ytd.push({ key: 'joinEarnedFrom', args: { hiredOn: date(j.hiredOn), from: date(j.earnedFrom ?? j.hiredOn) } });
    } else {
      const key = j.rule === 'months_remaining' ? 'joinMonthsRemaining' : j.rule === 'a2c_up_front' ? 'joinA2cUpFront' : 'joinFull';
      ytd.push({ key, args: { hiredOn: date(j.hiredOn) } });
    }
  }
  const statusKey: Partial<Record<EntitlementStatus, LeaveSummaryExplainKey>> = {
    not_generated: 'earnedNotGenerated',
    earned_accrual: 'earnedNothingYet',
    earned_method_not_annual_leave: 'earnedStranded',
    zero_entitlement: 'earnedZeroTable',
    earning_method_missing: 'earnedMethodMissing',
    capped_by_max_balance: 'earnedCappedAtZero',
    no_entitlement_table: 'earnedNoTable',
    no_eligibility_match: 'earnedNoTable',
  };
  const sKey = statusKey[status];
  if (sKey) ytd.push({ key: sKey });
  if (earned.credits.length === 0) {
    // A status sentence already said why nothing is here; saying "nothing credited" again adds nothing. An empty
    // list is guarded like a full one: "nothing credited" beside a non-zero figure would be false.
    ytd.push(
      ...guarded(0, f.currentYearEntitlement, sKey ? [] : [{ key: 'earnedNone', args: { start: date(f.cycleStart), asOf: date(f.asOf) } }]),
    );
  } else {
    ytd.push(
      ...guarded(sum(earned.credits), f.currentYearEntitlement, [
        { key: 'earnedCreditsIntro', args: { start: date(f.cycleStart), asOf: date(f.asOf) } },
        ...earned.credits.map(
          (c): ExplainStep => ({ key: 'creditItem', args: { date: date(c.effectiveOn), days: signed(c.days), kind: choice(c.kind) }, item: true }),
        ),
        { key: 'addsUpTo', args: { total: days(f.currentYearEntitlement) } },
        { key: 'earnedActualOnly' },
      ]),
    );
  }

  // ── Brought Forward ─────────────────────────────────────────────────────────────────────────────────
  const bf: ExplainStep[] = [];
  const cycleStart = date(f.cycleStart);
  if (f.broughtForward > 0) bf.push({ key: 'bfAmount', args: { days: days(f.broughtForward), date: cycleStart } });
  else if (f.broughtForward < 0) bf.push({ key: 'bfOverdrawn', args: { days: days(f.broughtForward), date: cycleStart } });
  else bf.push({ key: 'bfNone', args: { date: cycleStart } });
  const carry = d.carry;
  if (carry.rule === 'not_recorded') {
    bf.push({ key: 'carryNotRecorded' });
  } else if (carry.rule === 'off') {
    bf.push({ key: 'carryOff' });
  } else {
    const pct = carry.percent != null && carry.percent > 0 ? carry.percent : null;
    if (pct != null && carry.maxDays > 0) {
      bf.push({ key: 'carryPercentMax', args: { percent: { count: pct }, max: days(carry.maxDays) } });
    } else if (pct != null) {
      bf.push({ key: 'carryPercent', args: { percent: { count: pct } } });
    } else {
      bf.push({ key: 'carryMax', args: { max: days(carry.maxDays) } });
    }
    bf.push(f.carryForwardExpiryDate ? { key: 'carryExpires', args: { date: date(f.carryForwardExpiryDate) } } : { key: 'carryNoExpiry' });
  }
  bf.push({ key: 'bfForfeitNote' });

  // ── Adjustments ─────────────────────────────────────────────────────────────────────────────────────
  const adj: ExplainStep[] = [];
  const { manual, system } = d.adjustments;
  if (manual.length === 0 && system.length === 0) {
    adj.push(...guarded(0, f.adjustments, [{ key: 'adjNone' }]));
  } else {
    const list: ExplainStep[] = [];
    if (manual.length === 0) {
      list.push({ key: 'adjNoManual' });
    } else {
      list.push({ key: 'adjManualIntro' });
      for (const m of manual) {
        list.push(
          m.reason && m.reason.trim() !== ''
            ? { key: 'adjManualItem', args: { date: date(m.effectiveOn), days: signed(m.days), reason: text(m.reason) }, item: true }
            : { key: 'adjManualItemNoReason', args: { date: date(m.effectiveOn), days: signed(m.days) }, item: true },
        );
      }
    }
    if (system.length > 0) {
      list.push({ key: 'adjSystemIntro' });
      for (const s of system) {
        list.push({ key: 'adjSystemItem', args: { date: date(s.effectiveOn), days: signed(s.days), kind: choice(s.kind) }, item: true });
      }
    }
    list.push({ key: 'addsUpTo', args: { total: days(f.adjustments) } });
    adj.push(...guarded(r2(sum(manual) + sum(system)), f.adjustments, list));
  }

  // ── Total ───────────────────────────────────────────────────────────────────────────────────────────
  const total = guarded(r2(f.broughtForward + f.currentYearEntitlement + f.adjustments), f.totalEntitlement, [
    {
      key: 'totalFormula',
      args: {
        bf: days(f.broughtForward),
        earned: days(f.currentYearEntitlement),
        adj: days(f.adjustments),
        total: days(f.totalEntitlement),
      },
    },
  ]);

  // ── Taken ───────────────────────────────────────────────────────────────────────────────────────────
  const taken: ExplainStep[] = [];
  const t = d.taken;
  const period = { start: date(f.cycleStart), asOf: date(f.asOf) };
  if (t.leaveDays === 0 && t.other.length === 0) {
    taken.push(...guarded(0, f.takenThisCycle, [{ key: 'takenNone', args: period }]));
  } else {
    const list: ExplainStep[] = [{ key: 'takenLeave', args: { days: days(t.leaveDays), ...period } }];
    if (t.other.length > 0) {
      list.push({ key: 'takenOtherIntro' });
      for (const o of t.other) {
        const base = { date: date(o.effectiveOn), days: days(o.days) };
        list.push(
          o.kind
            ? { key: 'takenOtherItem', args: { ...base, kind: choice(o.kind) }, item: true }
            : o.reason && o.reason.trim() !== ''
              ? { key: 'takenOtherItemReason', args: { ...base, reason: text(o.reason) }, item: true }
              : { key: 'takenOtherItemUnrecorded', args: base, item: true },
        );
      }
      list.push({ key: 'addsUpTo', args: { total: days(f.takenThisCycle) } });
    }
    taken.push(...guarded(r2(t.leaveDays + sum(t.other)), f.takenThisCycle, list));
  }
  if (pool) taken.push({ key: 'takenPool', args: { types: { list: pool.contributingLeaveTypes } } });

  // ── Pending Approval ────────────────────────────────────────────────────────────────────────────────
  const pending: ExplainStep[] = [];
  if (d.pending.length === 0) {
    pending.push(...guarded(0, f.pendingApproval, [{ key: 'pendingNone', args: { asOf: date(f.asOf) } }]));
  } else {
    pending.push(
      ...guarded(sum(d.pending), f.pendingApproval, [
        { key: 'pendingIntro', args: { asOf: date(f.asOf) } },
        ...d.pending.map(
          (r): ExplainStep =>
            r.startDate === r.endDate
              ? { key: 'pendingItemOneDay', args: { start: date(r.startDate), days: days(r.days) }, item: true }
              : { key: 'pendingItem', args: { start: date(r.startDate), end: date(r.endDate), days: days(r.days) }, item: true },
        ),
        { key: 'addsUpTo', args: { total: days(f.pendingApproval) } },
      ]),
    );
  }
  if (pool) pending.push({ key: 'pendingOwnOnly', args: { type: text(f.leaveType) } });

  // ── Brought Forward Forfeited ───────────────────────────────────────────────────────────────────────
  const forfeited: ExplainStep[] = [];
  if (d.forfeited.length === 0) {
    forfeited.push(...guarded(0, f.forfeitedThisCycle, [{ key: 'forfeitNone', args: period }]));
  } else {
    forfeited.push(
      ...guarded(sum(d.forfeited), f.forfeitedThisCycle, [
        ...d.forfeited.map(
          (x): ExplainStep => ({ key: 'forfeitItem', args: { date: date(x.effectiveOn), days: days(x.days), kind: choice(x.kind) }, item: true }),
        ),
        { key: 'addsUpTo', args: { total: days(f.forfeitedThisCycle) } },
      ]),
    );
  }
  if (f.carryForwardExpiryDate) forfeited.push({ key: 'forfeitCarryExpiry', args: { date: date(f.carryForwardExpiryDate) } });

  // ── Available Balance ───────────────────────────────────────────────────────────────────────────────
  const available: ExplainStep[] = [];
  const columnCloses =
    r2(f.totalEntitlement - f.takenThisCycle - f.pendingApproval - f.forfeitedThisCycle) === r2(f.totalAvailable);
  if (columnCloses && r2(p.available) === r2(f.totalAvailable)) {
    available.push({
      key: 'availableFormula',
      args: {
        total: days(f.totalEntitlement),
        taken: days(f.takenThisCycle),
        pending: days(f.pendingApproval),
        forfeited: days(f.forfeitedThisCycle),
        available: days(p.available),
      },
    });
  } else if (pool) {
    available.push({
      key: 'availablePool',
      args: {
        available: days(p.available),
        source: text(pool.sourceLeaveTypeName),
        balance: days(f.balance),
        types: { list: pool.contributingLeaveTypes },
        column: days(f.totalAvailable),
      },
    });
  } else {
    available.push({ key: 'availableDiffers', args: { available: days(p.available), column: days(f.totalAvailable) } });
  }

  return {
    eligible,
    ytdEntitled: ytd,
    broughtForward: bf,
    adjustment: adj,
    total,
    taken,
    pendingApproval: pending,
    forfeited,
    available,
  };
}
