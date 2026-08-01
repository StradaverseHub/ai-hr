/**
 * a1d82340 STEP 3 — ONE payroll sequence, declared once.
 *
 * Before this file there were three orderings and they disagreed:
 *
 *   - the sidebar fly-out (packs/payroll/index.ts) ran  Guide → Payroll Process → Transactions →
 *     Transaction View → Reports → Settings, i.e. it opened with the FINISHED-runs workbench and
 *     closed with the settings you have to complete before you can run anything at all;
 *   - the Workflow Guide (app/payroll/guide/page.tsx) ran  master data → transactions → validation →
 *     process → review → finalize, which is the order the work actually happens in;
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
 *   - `/payroll/guide` is the MAP of the sequence, not a step in it, so it stays first (rank 0).
 *     1459e116's approved ordering ("Workflow Guide before Payroll Process — read the guide, then
 *     run the payroll") is therefore preserved, not undone.
 *   - `/payroll/reports` is statutory OUTPUT — the EPF/SOCSO/EIS/PCB submissions you file once the
 *     run is closed. It comes after the last phase (rank 7), which is where it already was
 *     relative to everything except Settings.
 *
 * `/payroll` is ranked by the phase where an operator ENTERS it (4, "run the calculation"). It is
 * also where phase 6 finishes — the run listing and the Close action live there too — but a menu row
 * can only sit in one place and the earlier of the two phases is the one that gets you there.
 */
export const PAYROLL_NAV_PHASE: Readonly<Record<string, number>> = {
  '/payroll/guide': 0,
  '/payroll/setup': 1,
  '/payroll/transactions': 2,
  '/payroll': 4,
  '/payroll/transaction-view': 5,
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
