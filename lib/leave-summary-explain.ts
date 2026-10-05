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
 * r355 (4c63b37e): Available Balance carries a SECOND decomposition beside that one — Balance − Pending
 * Approval − Pending Share, the row as Employee Balances now prints it — under the same discipline. It is
 * emitted as the literal subtraction only when the three terms reach `summary.available` exactly, and never on
 * a pooled BORROWER's row, whose own Balance and Pending Approval are 0.00 while the figures handed in here are
 * the pool's: there a sentence states the pooled answer instead. Nothing is recomputed for it — Pending Share
 * is the sum of the contributions core/read.ts itemised beside the column they add up to.
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
import { otherContributors, poolBadges, type SharedLeaveBalanceInfo } from './shared-leave-balance';

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
    /** Every EARNED-TO-DATE row in [cycleStart, asOf] (core/leave.ts `isEarnedToDateRow`), pushed in the branch
     *  that adds it to the figure. r389 (62a1bec1): `policy_recalc` / `profile_recalc` are the automatic
     *  entitlement recalculations the engines granted, listed here with their date because that is the figure
     *  they make up — they used to be listed under Adjustments, beside a grid that counted them nowhere. */
    credits: {
      effectiveOn: string;
      days: number;
      kind: 'grant' | 'leave_credit' | 'a2c_correction' | 'policy_recalc' | 'profile_recalc';
    }[];
  };
  /** Brought Forward — the carry rule on the leave type (the figure itself is `broughtForward`). */
  carry: { rule: 'not_recorded' | 'off' | 'on'; maxDays: number; percent: number | null };
  /** Adjustments — HR's own rows and the automatic corrections, separately. */
  adjustments: {
    manual: { effectiveOn: string; days: number; reason: string | null }[];
    /** r389 (62a1bec1): automatic corrections only — the Anniversary-to-Calendar correction, the reversal of a
     *  grant the employee was not eligible for, and a policy / profile recalculation ONLY where that a2c
     *  correction superseded it (an unsuperseded one is an Earned to Date credit above). */
    system: {
      effectiveOn: string;
      days: number;
      kind: 'policy_recalc' | 'profile_recalc' | 'a2c_recalc' | 'ineligible_grant_reversal';
    }[];
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
  /** 845903a3 (r313) — the Entitlement figure's working. Optional: several callers build these figures by
   *  hand for one sentence and have no proration to explain, and a missing block simply emits nothing. */
  entitlement?: {
    prorated: boolean;
    annualEntitlementDays: number;
    eligibleCalendarDays: number | null;
    daysInLeaveYear: number | null;
    unroundedEntitlementDays: number;
    displayEntitlementDays: number;
    roundingApplied: boolean;
  };
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
  // 2a57a007 (r340) — a BORROWER's own two figures, stated on the two lines they belong to. See
  // `entitlementFromPool` in explainLeaveSummary for why this is said rather than computed.
  'pooledOwnEntitlement',
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
  // 845903a3 (r313) — the proration working, for an employee who joined part way through the leave year.
  'entitlementProrated',
  'entitlementRounded',
  'entitlementNotRounded',
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
  'earnedNothingYetWithCredits',
  'earnedZeroTableWithCredits',
  'earnedMethodMissingWithCredits',
  'earnedNoTableWithCredits',
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
  // 2a57a007 — the Share column, decomposed by the leave type each day was filed under.
  'sharedTakenIntro',
  'sharedTakenItem',
  // Pending Approval
  'pendingNone',
  'pendingIntro',
  'pendingItem',
  'pendingItemOneDay',
  'pendingOwnOnly',
  // 2a57a007 — the Pending Share column, decomposed the same way.
  'sharedPendingIntro',
  'sharedPendingItem',
  // Brought Forward Forfeited
  'forfeitNone',
  'forfeitItem',
  'forfeitCarryExpiry',
  // Available Balance
  'availableFormula',
  'availablePool',
  'availableDiffers',
  // r355 (4c63b37e) — THE SECOND DECOMPOSITION OF THE SAME FIGURE, and it JOINS the three above rather than
  // replacing them. `availableFormula` spells Available Balance out of TOTAL (Total − Taken − Pending −
  // Forfeited); the reporter asked for it spelled out of BALANCE (Balance − Pending Approval − Pending Share),
  // which is the row he is reading on Employee Balances now that the figure has a column there. Both are true
  // of the same number and the first is pinned, so both are printed. The three-way branch is the same one
  // above it, for the same reason: the literal subtraction does not close on a pooled BORROWER's row.
  'availableFromBalance',
  'availableFromBalancePool',
  'availableFromBalanceDiffers',
] as const;
export type LeaveSummaryExplainKey = (typeof LEAVE_SUMMARY_EXPLAIN_KEYS)[number];

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: { days: number }[]) => xs.reduce((s, x) => r2(s + x.days), 0);

const days = (n: number): ExplainArg => ({ days: n });
const signed = (n: number): ExplainArg => ({ signedDays: n });
const date = (d: string): ExplainArg => ({ date: d });
const text = (s: string): ExplainArg => ({ text: s });
const choice = (s: string): ExplainArg => ({ choice: s });

/**
 * 2a57a007 — one pooled column, itemised by the leave type that moved the days. Pure: every figure printed
 * is a `contributions` entry core/read.ts already computed beside the column it adds up to, and the total
 * sentence reuses `addsUpTo` rather than inventing a second way to say the same thing.
 */
function sharedBreakdown(
  pool: SharedLeaveBalanceInfo | null,
  which: 'share' | 'pendingShare',
  intro: LeaveSummaryExplainKey,
  item: LeaveSummaryExplainKey,
): ExplainStep[] {
  const moved = poolBadges(pool, which);
  if (moved.length === 0) return [];
  return [
    { key: intro },
    ...moved.map((c): ExplainStep => ({ key: item, args: { type: text(c.leaveType), days: days(c[which]) }, item: true })),
    { key: 'addsUpTo', args: { total: days(r2(moved.reduce((n, c) => n + c[which], 0))) } },
  ];
}

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
    /**
     * 2a57a007 (r340) — THE POOL A BORROWER'S DAYS COME FROM, set ONLY on a borrower's row (the pool's own row
     * and every unpooled type pass null/nothing). `sharedBalance` alone cannot tell the two apart: both halves
     * of a pool carry the same descriptor, and the figures handed in are the POOL's on both.
     *
     * It adds ONE SENTENCE to each of the two lines that are statements about the leave TYPE rather than about
     * the ledger — Full Entitlement and Earned to Date — saying that this type's own figures are nothing and
     * that the working which follows is the pool's. The grid and the export already print those 0.00s
     * (app/leave/employee-balances/rows.ts); this is how the panel stops contradicting them.
     *
     * ⚠️ IT DOES NOT TOUCH A FIGURE, AND THEREFORE NOT THE SUM-GUARD EITHER. The guards below keep comparing
     * the POOL's itemised records against the POOL's own figures, which is the comparison that holds by
     * construction. Substituting 0.00 for the figures here is what would make a guard fire on a panel where
     * nothing is wrong — and a guard made to fire, or made quiet, is worse than the contradiction it replaced.
     */
    entitlementFromPool?: string | null;
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
  /**
   * 2a57a007 (r340) — the borrower's own fact, FIRST on both lines it is about, because it is what the reader
   * came for: the grid cell beside the button reads 0.00, and this says why and whose figures follow.
   */
  const borrowed = p.entitlementFromPool ?? null;
  const ownEntitlementIsNothing: ExplainStep[] = borrowed
    ? [{ key: 'pooledOwnEntitlement', args: { source: text(borrowed) } }]
    : [];

  // ── Full Entitlement ────────────────────────────────────────────────────────────────────────────────
  const eligible: ExplainStep[] = [...ownEntitlementIsNothing];
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

  /**
   * 845903a3 (r313) — HOW THE ENTITLEMENT FIGURE WAS REACHED, which the reporter asked for by name
   * ("provide an explanation/audit trail for how ENTITLEMENT was calculated").
   *
   * Appended AFTER the band working above, because it reads as a continuation of it: the band sentences
   * explain where the year's allowance came from, and these explain what was then done to it for THIS
   * employee. Emitted only when proration actually applied — for everybody else the allowance IS the
   * entitlement and a sentence saying so would be noise on every other row.
   */
  const ent = f.entitlement;
  if (ent?.prorated) {
    eligible.push({
      key: 'entitlementProrated',
      args: {
        annual: days(ent.annualEntitlementDays),
        eligibleDays: { count: ent.eligibleCalendarDays ?? 0 },
        yearDays: { count: ent.daysInLeaveYear ?? 365 },
        unrounded: days(ent.unroundedEntitlementDays),
      },
    });
    eligible.push(
      ent.roundingApplied
        ? { key: 'entitlementRounded', args: { unrounded: days(ent.unroundedEntitlementDays), final: days(ent.displayEntitlementDays) } }
        : { key: 'entitlementNotRounded', args: { final: days(ent.displayEntitlementDays) } },
    );
  }

  // ── Earned to Date ──────────────────────────────────────────────────────────────────────────────────
  const ytd: ExplainStep[] = [...ownEntitlementIsNothing];
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
  // r303 hand-fix (verification defect 1) — a status sentence must never say "nothing is credited" above a list of
  // credits (a Replacement Leave with Leave Credits; a year granted before its eligibility rule expired). Where
  // credits exist, the same status is stated without that claim.
  const withCredits: Partial<Record<LeaveSummaryExplainKey, LeaveSummaryExplainKey>> = {
    earnedNothingYet: 'earnedNothingYetWithCredits',
    earnedZeroTable: 'earnedZeroTableWithCredits',
    earnedMethodMissing: 'earnedMethodMissingWithCredits',
    earnedNoTable: 'earnedNoTableWithCredits',
  };
  const sKey0 = statusKey[status];
  const sKey = sKey0 && earned.credits.length > 0 ? (withCredits[sKey0] ?? sKey0) : sKey0;
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
  /**
   * 2a57a007 — THE SHARE COLUMN, BY LEAVE TYPE. `takenPool` above names the types that share the balance;
   * it does not say how many days each of them took, which is the whole of what the grid's Share figure is
   * a sum of. The list is the SAME `contributions` the badge beside the figure and the export's source
   * column read (core/read.ts builds it in the pass that computes the figure), so the panel cannot itemise
   * a total the grid does not show. Zero-day borrowers are already dropped by `poolBadges`; a pool that lent
   * nothing out emits nothing at all rather than a heading over an empty list.
   */
  for (const step of sharedBreakdown(pool, 'share', 'sharedTakenIntro', 'sharedTakenItem')) taken.push(step);

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
  // 2a57a007 — and the Pending Share column, the same way, from the same list.
  for (const step of sharedBreakdown(pool, 'pendingShare', 'sharedPendingIntro', 'sharedPendingItem')) pending.push(step);

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
  /**
   * r355 (4c63b37e) — AND THE SAME FIGURE OUT OF THE COLUMNS THE READER IS LOOKING AT, which is what the
   * reporter asked for when Available Balance gained a column on Employee Balances.
   *
   * The block above decomposes from TOTAL; this one decomposes from BALANCE — Balance − Pending Approval −
   * Pending Share — which is the grid row read left to right. Both are true of the same number, so this is
   * APPENDED rather than substituted (the block above is pinned by test/r303-leave-summary-explain.test.ts and
   * is the arithmetic the reconciliation partition guarantees).
   *
   * ⚠️ PENDING SHARE IS NOT A SCALAR ON `LeaveSummaryFigures`, AND IS NOT PLUMBED AS ONE. It is the sum of the
   * contributions core/read.ts already itemised beside the column they add up to — the very list
   * `sharedBreakdown` above prints on the Pending Approval line — so the figure printed here is the figure
   * printed there by construction, and 0.00 for a type in no pool, which is the honest 0.00 the grid's own
   * Pending Share column shows for it.
   *
   * ⚠️ THE BORROWER BRANCH IS NOT OPTIONAL, AND `borrowed` IS THE ONLY THING THAT CAN SPOT IT. The figures
   * handed in for a borrower's row are the POOL's (`balanceStoryTypeId`, app/leave/employee-balances/rows.ts),
   * so the subtraction closes numerically — on figures the row itself does not show. The grid row for that
   * borrower reads Balance 0.00 and Pending Approval 0.00, because the days and the pending both belong to the
   * pool; printing "7.00 balance − 1.00 pending approval" under a row that says 0.00 twice is exactly the
   * cross-surface contradiction 2a57a007 was raised about. `p.entitlementFromPool` is set ONLY on a borrower's
   * row (both halves of a pool carry the same `sharedBalance`, so that cannot tell them apart), so it is what
   * this branches on, and the sentence states the pooled answer instead of a formula that is not the reader's.
   */
  const pendingShareMoved = poolBadges(pool, 'pendingShare');
  const pendingShareTotal = r2(pendingShareMoved.reduce((n, c) => n + c.pendingShare, 0));
  if (borrowed) {
    available.push({
      key: 'availableFromBalancePool',
      args: { available: days(p.available), source: text(borrowed) },
    });
  } else if (r2(f.balance - f.pendingApproval - pendingShareTotal) === r2(p.available)) {
    available.push({
      key: 'availableFromBalance',
      args: {
        balance: days(f.balance),
        pending: days(f.pendingApproval),
        pendingShare: days(pendingShareTotal),
        available: days(p.available),
      },
    });
  } else {
    available.push({
      key: 'availableFromBalanceDiffers',
      args: {
        available: days(p.available),
        balance: days(f.balance),
        pending: days(f.pendingApproval),
        pendingShare: days(pendingShareTotal),
      },
    });
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
