/**
 * a1d82340 STEP 3 — ONE payroll sequence, declared once.
 *
 * Before this file there were three orderings and they disagreed:
 *
 *   - the sidebar fly-out (packs/payroll/index.ts) ran  Guide → Payroll Process → Transactions →
 *     Transaction View → Reports → Settings, i.e. it opened with the FINISHED-runs workbench and
 *     closed with the settings you have to complete before you can run anything at all;
 *   - the Workflow Guide (app/payroll/guide/page.tsx, RETIRED by efe1d230 — see PAYROLL_NAV_PHASE) ran
 *     master data → transactions → validation → process → review → finalize, which is the order the
 *     work actually happens in;
 *   - the Process wizard (app/payroll/process/wizard.tsx) showed a five-stage rail of its own —
 *     Preparation → Validation → Process → Review → Finalize — whose stage names and stage COUNT
 *     matched neither of the other two, so "stage 2 of 5" in the wizard and "phase 3 of 6" in the
 *     guide named the same moment with different numbers.
 *
 * The approved plan's step 3 is "pick one sequence and make all three agree", navigation only. The
 * guide's sequence is the one picked: it is the only one that describes the work rather than the
 * screens, it is already written out in prose for the reporter, and its titles are already
 * translated in all six catalogs (`payroll.guide.phase{n}Title` / `phase{n}Desc`). So the phases
 * below carry the EXISTING i18n keys — this change adds no key to any catalog.
 *
 * DELIBERATELY CLIENT-SAFE: no db, no server-only import. The sidebar declaration
 * (packs/payroll/index.ts) and the wizard (a 'use client' component) both read it.
 */

export type PayrollPhaseKey = 'masterData' | 'transactions' | 'validation' | 'process' | 'review' | 'finalize';

export type PayrollPhase = {
  /** 1-based phase number, as shown to the operator ("Phase 4"). */
  readonly n: number;
  readonly key: PayrollPhaseKey;
  /** Key under the `payroll.guide` namespace — present in all six catalogs since 5db3ae48. */
  readonly titleKey: string;
  readonly descKey: string;
};

/** The canonical payroll sequence. Index + 1 === `n`. */
export const PAYROLL_PHASES: readonly PayrollPhase[] = [
  { n: 1, key: 'masterData', titleKey: 'phase1Title', descKey: 'phase1Desc' },
  { n: 2, key: 'transactions', titleKey: 'phase2Title', descKey: 'phase2Desc' },
  { n: 3, key: 'validation', titleKey: 'phase3Title', descKey: 'phase3Desc' },
  { n: 4, key: 'process', titleKey: 'phase4Title', descKey: 'phase4Desc' },
  { n: 5, key: 'review', titleKey: 'phase5Title', descKey: 'phase5Desc' },
  { n: 6, key: 'finalize', titleKey: 'phase6Title', descKey: 'phase6Desc' },
] as const;

/**
 * Where each payroll menu destination sits in the sequence above — the bridge that makes the SIDEBAR
 * agree with the guide instead of carrying an order of its own.
 *
 * Two entries are deliberately not phases, and both are given an explicit rank rather than being
 * left to sort by accident:
 *
 *   - `/payroll` (Payroll Process, the run workbench) is the module's HOME — rank 0, the row the
 *     fly-out opens on and focuses. See "efe1d230 — rank 0 moved" below for why it is no longer
 *     ranked by its phase.
 *   - `/payroll/reports` is statutory OUTPUT — the EPF/SOCSO/EIS/PCB submissions you file once the
 *     run is closed. It comes after the last phase (rank 7), which is where it already was
 *     relative to everything except Settings.
 *
 * efe1d230 — RANK 0 MOVED FROM THE GUIDE TO PAYROLL PROCESS, and this is a deliberate, approved
 * partial reversal of a1d82340's ordering, not drift. `/payroll/guide` held rank 0 because 1459e116
 * asked for "read the guide, then run the payroll". The reporter has since withdrawn that: the guide
 * is "a menu row nobody starts from", and the approved plan says in as many words that "Payroll
 * Process becomes the landing page when you open the Payroll module". The fly-out FOCUSES its first
 * child on open (components/nav-flyout.tsx `firstLinkRef`), so the first row IS the landing page —
 * the promise cannot be kept by any other means.
 *
 * What a1d82340 actually fixed is NOT undone by this. Its complaint was that Settings — the thing you
 * must complete before you can run anything — sat stranded at the END of the menu, after the
 * finished-runs workbench. Settings is now SECOND. The ordering guard in test/payroll-phase-order.ts
 * was updated to assert that invariant (preparation ahead of the review/output screens, Settings not
 * last) rather than the literal "setup before /payroll", which efe1d230 supersedes.
 *
 * `/payroll` is therefore no longer ranked by the phase where an operator enters it (4, "run the
 * calculation"); it is ranked as the module home. The phase 4/6 reading is preserved in this note so
 * a future re-rank knows what it is giving up.
 */
export const PAYROLL_NAV_PHASE: Readonly<Record<string, number>> = {
  '/payroll': 0,
  '/payroll/setup': 1,
  '/payroll/transactions': 2,
  // 6d72816e — staff loans are a payroll INPUT: a recurring deduction reserved onto a regular draft
  // run (ADR-0060, core/loans.ts). Same phase as the other transaction keying screens, so it lands
  // immediately after Transactions (`sort` is stable and the row sits there literally).
  '/admin/loans': 2,
  // 2ef69d1e — Back Pay is a payroll INPUT like the other transaction keying screens: it works out what
  // a backdated salary revision owes and posts it as one-off transactions on the current run. Same phase
  // as Transactions, so it lands between Transactions and Transaction View, which is where the approved
  // plan puts it.
  '/payroll/back-pay': 2,
  // ADR-0074 — the Control Tower is the REVIEW step that comes before looking at any one person: it
  // says who needs a human at all. Ranked with the review screens and written literally first among
  // them, so "what needs me?" precedes "show me this payslip". `sort` is stable.
  '/payroll/control-tower': 5,
  '/payroll/transaction-view': 5,
  // 169e3c24 — Individual Payslip is the same REVIEW step as Transaction View: check one person's pay
  // before it goes out. Same rank, and `sort` is stable, so it lands immediately after it (its literal
  // position in PAYROLL_ADMIN_NAV) rather than depending on a guessed splice point.
  '/payroll/individual-payslip': 5,
  // 2961a7ae — Statutory Adjustment is a CORRECTION to a processed run, so it sits with the review
  // screens (same rank as Individual Payslip, immediately after it by literal position): you look at the
  // result, and this is where you correct a figure on it before the month is closed and filed.
  '/payroll/statutory-adjustment': 5,
  '/payroll/reports': 7,
  // 956cec85 — filing comes AFTER the figures are reported: the last thing you do with a month.
  '/payroll/statutory-forms': 8,
};

/** Sort key for a payroll menu href. An href with no declared rank sorts last, never crashes. */
export function payrollNavRank(href: string): number {
  return PAYROLL_NAV_PHASE[href] ?? Number.MAX_SAFE_INTEGER;
}

/** 0-based index into PAYROLL_PHASES for a phase key. */
export function payrollPhaseIndex(key: PayrollPhaseKey): number {
  return PAYROLL_PHASES.findIndex((p) => p.key === key);
}
