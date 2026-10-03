import {readSavedTaxCircumstance,taxCircumstanceOf,type SavedTaxCircumstance} from '../localization/my/tax-circumstance';
import { readPcbNonCash, type PcbNonCashSnapshot } from '../localization/noncash-benefits';
/**
 * Feedback 169e3c24 — explain a payslip's PCB (MTD) figure from what the payslip itself recorded.
 * Feedback 45df860a — …and now the WHOLE working, so the LHDN formula can be closed on screen.
 *
 * WHY THIS EXISTS. Every input to the LHDN computerised calculation was ALREADY being persisted:
 * `localization/my/payroll.ts` stamps `pcbMeta` — pcbMonth's own snapshot — onto every payslip's
 * statutory blob. Grepping `pcbMeta` across `app/` returned nothing but a comment. It was stored, and
 * displayed nowhere, so "why is my PCB this amount" could only be answered on a separate worksheet.
 *
 * PURE, AND DELIBERATELY INCAPABLE OF RECOMPUTING. This module reads; it does not calculate tax. A panel
 * that re-derived the figure could disagree with the figure it claims to explain, which is worse than no
 * panel. Everything here is either read straight out of the blob or added up from figures that came out
 * of it. 45df860a did NOT relax that: it widened what pcbMonth records so that less has to be derived,
 * which is the opposite move.
 *
 * TWO STORED SHAPES, AND TWO KINDS OF ABSENCE — one of which HAS a fallback and one of which must not:
 *
 *   1. FLAT RATE. A non-resident (30%) or a REP / Knowledge-Worker employee (15%) is taxed at a flat rate
 *      with no reliefs at all, and the blob carries `{ nonResident, flatRate, rate }`. There is no relief
 *      working to show and that is CORRECT, not a gap — so this returns a distinct shape and the screen
 *      says which rate was applied instead of rendering an empty relief table.
 *
 *   2. THE MTD SNAPSHOT. `{ month, n, ytdNet, epfClaimed, pcbPaid, P1, P2? }`, plus — from 169e3c24
 *      onward — `reliefs`, the relief legs as pcbMonth actually applied them, plus — from 45df860a
 *      onward — `trace`, the bracket (M, R, B), the EPF legs, the additional-remuneration legs and the
 *      year totals.
 *
 *   3. PRE-SNAPSHOT RELIEF FALLBACK. A payslip calculated before the relief legs were recorded has the
 *      first six keys and no `reliefs`. Its reliefs are then taken from the employee's CURRENT position,
 *      and `reliefSource` says so, because an employee who has since married or had a child would
 *      otherwise have a closed payslip explained with a relief position that did not exist when it was
 *      computed. The screen MUST surface `reliefSource`; a silent fallback is the failure mode this names.
 *
 *   4. PRE-TRACE — AND THERE IS NO FALLBACK, ON PURPOSE. A payslip calculated before 45df860a has no
 *      `trace`, and `trace` comes back NULL. It is NOT reconstructed from the figures that are present:
 *      solving M, R and B back out of a stored P is a SECOND calculation of the very thing this module
 *      exists to avoid recalculating, and it would silently disagree with the run for any month whose
 *      band table has since been overridden. Nor is it zero-filled: a table of RM 0.00 reads as "the
 *      bracket was zero", which is a false statement about someone's tax. The caller renders "not
 *      recorded for this run" and shows the legs it genuinely has.
 *
 *   5. A WORKING THAT IS COMPLETE, CORRECT, AND ABOUT A DIFFERENT NUMBER. This happens for TWO unrelated
 *      reasons, and both are read out through the same three members — `pcbSystem` is what the recorded
 *      working explains, `pcb` is what was deducted, `basis` says why they differ:
 *
 *        a. A HAND-SET PCB. An operator overrides the PCB line (2961a7ae): `statutory.pcb` becomes their
 *           figure and `pcbMeta` is left exactly as the engine wrote it, because no second calculation
 *           ran.
 *
 *        b. AN ADDITIONAL RUN. A bonus / off-cycle run deducts the INCREMENT of the cumulative month
 *           (ADR-0024): `deltaStat` (core/payroll.ts) rewrites `pcb` to `now − before` but carries
 *           `pcbMeta` through untouched, so the stored working — P, the bracket, both MTD legs — is the
 *           WHOLE month's while the deduction is the increase. `deltaStat` stamps `pcbMeta.delta` with
 *           the two figures it took the difference between, and that stamp is what is read here.
 *
 *      Either way the screen must say the deduction was set by hand / is this run's increase, rather than
 *      presenting a tidy LHDN formula as the explanation of an amount nobody computed.
 */

export type PcbReliefBreakdown = {
  individual: number;
  spouse: number;
  children: number;
  disabledIndividual: number;
  disabledSpouse: number;
  /** Optional-deduction / TP1 total (Σ LP) netted off P beside the reliefs. */
  lp: number;
  total: number;
};

/**
 * 45df860a — the rest of the LHDN working, as `pcbMonth` recorded it. Every member is READ, never
 * derived. The names are the spec's own symbols, because the screen prints the formula in those symbols
 * and a rename between the two is how a reader ends up checking the wrong figure.
 */
export type PcbCalculationScheme = 'resident' | 'rep' | 'knowledge_worker' | 'c_suite';

export type PcbTrace = {
  schemeVersion?: 1;
  T?: number;
  T2?: number;
  /** Table 1 row P₁ fell into (M, R) and the category-selected B column, and the annual tax it yields. */
  M: number;
  R: number;
  B: number;
  taxOnP1: number;
  /** s.48 category the B column came from, and the child COUNT behind the child-relief amount. */
  category: number;
  /**
   * NULL ON EVERY RUN STAMPED BEFORE r359, which introduced both fields — and that is the whole point
   * of the type. r362: they were read through `n()`, which turns `undefined` into 0, so a payslip from
   * before 2026-09-29 rendered `Q = RM0.00` beside a QC holding the real relief and a C still meaning
   * the old record count: three cells that visibly do not multiply, on the screen a payroll officer
   * uses to DEFEND a figure. The header on `trace` a few lines below already states the rule this
   * broke — "it does NOT back-derive the bracket and it does NOT render the legs as zeroes" — so the
   * fix is to let absence stay absent and let the worksheet say `notRecorded`, exactly as it already
   * does for a run with no trace at all.
   */
  childCount: number | null;
  /** Version 1 retains exact C and verifies it against the saved child deduction. */
  childCountVersion?: 1;
  childDeductionPerChild: number | null;
  childWorking: (PcbChildProfile & {
    rows: Array<{ category: string; sharePercent: number; children: number; units: number; amountRM: number }>;
    headCount: number;
    categoryUnits: Record<string, number>;
  }) | null;
  /** The remuneration legs of P. Y₂ = Y₁ by construction (the projection repeats the current month). */
  Y1: number;
  K1: number;
  Y2: number;
  K2: number;
  /** Additional-remuneration legs. All zero in a month that paid none — §D.2 does not run at all then. */
  Yt: number;
  Kt: number;
  K2t: number;
  /** Z, and the Σ LP / LP₁ split of the combined `reliefs.lp`. */
  Z: number;
  lpAccumulated: number;
  lpCurrent: number;
  /** This month's zakat via salary — the §E.5 offset. PCB is already net of it. */
  zakatCurrent: number;
  /** §D.2 Step 3 / Step 1[E]. NULL means the month paid no additional remuneration, which is a
   *  different statement from zero — the screen must not print "RM 0.00" for a step that never ran. */
  totalTaxYear: number | null;
  totalMtdYear: number | null;
  /** The two legs post §E.1 truncation and §E.2 5-sen round-up, BEFORE the §E.3 RM10 floor and the
   *  §E.5 zakat offset. This is the figure the substituted formula lands on. */
  mtdNormalCalc: number;
  mtdAdditionalCalc: number;
  /** The same two legs AFTER the §E.3 RM10 rule (A and E in the spec's tables), and the zakat left over
   *  once the normal leg absorbed what it could. The last line of the working —
   *  `max(0, A − Z₁) + max(0, E − leftover)` — is not writable without them, and a line that skips them
   *  prints an expression that does not evaluate to the PCB beside it. */
  mtdNormalFloored: number;
  mtdAdditionalFloored: number;
  zakatLeftover: number;
};

/**
 * 2961a7ae × ADR-0024 × 45df860a — WHY THE WORKING AND THE DEDUCTION ARE DIFFERENT NUMBERS.
 *
 * Two mechanisms open this gap, and neither rewrites `pcbMeta`, so in both cases every member of the
 * trace describes one figure while `statutory.pcb` is another:
 *
 *   · `applyStatutoryAdjustment` overwrites `statutory.pcb` with an operator's figure and records the
 *     before/after under `statutory.adjustment`. There is no second calculation to record because none
 *     ran, so the working still describes what the ENGINE produced.
 *
 *   · `deltaStat` turns an additional run's `pcb` into the month's INCREMENT while carrying `pcbMeta`
 *     through as the CUMULATIVE month, and stamps `pcbMeta.delta` with the pair it differenced. The
 *     working therefore describes the whole month; the payslip deducted the increase.
 *
 * A screen that did not notice either would present a complete, correct-looking LHDN working as the
 * explanation of an amount nobody computed — the exact failure this whole item exists to remove, wearing
 * a respectable formula. So the basis is read out and reported, the working is labelled as explaining
 * `pcbSystem`, and the screen says in plain words which figure is which.
 */
export type PcbBasis = {
  /** WHY the two figures differ — the screen's banner, labels and extra rows all turn on this.
   *   · 'manual'              an operator replaced the PCB line; the working is the engine's figure.
   *   · 'additionalRun'       this run deducted the month's increase; the working is the whole month.
   *   · 'additionalRunManual' both — an increment run whose PCB was then also set by hand. */
  kind: 'manual' | 'additionalRun' | 'additionalRunManual';
  /** What the recorded working explains: the engine's figure, or — on an additional run — the figure for
   *  the WHOLE month, because the whole month is what `pcbMeta` describes. Always `pcbSystem`. */
  system: number;
  /** What was actually deducted on this payslip (`statutory.pcb`). Always `pcb`. */
  applied: number;
  /** additionalRun* — the month's PCB WITHOUT this run's additional remuneration: what the month's
   *  earlier runs already carried, and what the increment was taken against. NULL for a plain override. */
  prior: number | null;
  /** additionalRun* — the increment the ENGINE computed for this run. Equal to `applied` unless the
   *  figure was afterwards set by hand, which is the only case worth printing it in. NULL otherwise. */
  engineRun: number | null;
  /** The operator's mandatory reason. '' when nothing was set by hand. */
  reason: string;
};

/** 45df860a — the flat-rate working: the remuneration the flat percentage was applied to. */
export type PcbFlatTrace = {
  remuneration: number;
  additional: number;
  rate: number;
};

/** Present on EVERY shape, because both gaps above are orthogonal to how the figure was computed and a
 *  screen must never explain one figure while displaying the other.
 *   · `pcb`       — what was DEDUCTED (`statutory.pcb`), override included.
 *   · `pcbSystem` — what the recorded working EXPLAINS. Identical to `pcb` on a plain regular run.
 *   · `basis`     — NULL when they are the same number; otherwise why they are not. */
export type PcbTaxSelectionProvenance = {
  taxSelectionId: string;
  taxSelectionVersion: number;
  taxSelectionSource: 'income_tax_resident';
};
type PcbFigures = { taxCircumstance?:SavedTaxCircumstance; pcb: number; pcbSystem: number; basis: PcbBasis | null; taxSelection?: PcbTaxSelectionProvenance; nonCash?: PcbNonCashSnapshot | null };

export type PcbExplanation =
  | ({kind:'not_subject'} & PcbFigures)
  | ({
      /** No PCB working was recorded on this payslip (imported history, or a run predating the stamp). */
      kind: 'unavailable';
    } & PcbFigures)
  | ({
      kind: 'flat';
      legacy?: boolean;
      /** 0.30 non-resident, 0.15 REP / Knowledge Worker. */
      rate: number;
      nonResident: boolean;
      /** NULL for a run predating 45df860a — "not recorded", never zero. */
      trace: PcbFlatTrace | null;
    } & PcbFigures)
  | ({
      kind: 'mtd';
      calculationScheme?: PcbCalculationScheme;
      /** Immutable employer-scoped approval used by this run; absent on legacy/normal snapshots. */
      taxSchemeDeclarationId?: string;
      /** 'snapshot' = this payslip's own relief working. 'current' = the employee's position TODAY. */
      reliefSource: 'snapshot' | 'current';
      /** Month of the tax year the calculation ran for, and the balance of months after it (LHDN `n`). */
      month: number;
      remainingMonths: number;
      /** Accumulators the month was computed against, all as stored. */
      ytdNetRemuneration: number;
      epfClaimedYtd: number;
      /** 4011903e — LHDN's Y, stamped by the engine. Undefined on a slip that predates the stamp. */
      ytdGross?: number;
      /** 4011903e — prior months that fell back to gross pay for want of a `bases.pcb` stamp. */
      ytdLegacyBaseSlips?: number;
      pcbPaidYtd: number;
      /** This month's employee EPF — the K₁ leg, capped inside pcbMonth against the annual relief cap. */
      epfThisMonth: number;
      /** Projected chargeable income: P₁ without additional remuneration, P₂ with it (null when none). */
      chargeableIncome: number;
      chargeableIncomeWithAdditional: number | null;
      reliefs: PcbReliefBreakdown;
      /** Zakat paid via salary this month. PCB is ALREADY net of it (LHDN §E.5) — never re-subtract. */
      zakat: number;
      /** The split the engine produced: normal-remuneration MTD and the additional-remuneration leg.
       *  Both are taken against `pcbSystem`, not against `pcb`: they belong to the calculation, and
       *  splitting a hand-set figure along the engine's proportions would invent a breakdown. On an
       *  additional run that means the CUMULATIVE month's legs, read from the same `delta` stamp
       *  `pcbSystem` comes from — pairing a cumulative total with an incremental leg would make the two
       *  disagree with each other as well as with the trace. */
      pcbNormal: number;
      pcbAdditional: number;
      /** NULL for a run predating 45df860a. The caller says "not recorded for this run"; it does NOT
       *  back-derive the bracket and it does NOT render the legs as zeroes. */
      trace: PcbTrace | null;
      /** Newly expanded normal working is unavailable when any required saved input is absent. */
      normalMtdWorkingRecorded?: boolean;
    } & PcbFigures);

/** Finite numbers must exist in the saved payload; normal working never adopts n() defaults. */
const hasRecordedNumbers = (raw: unknown, keys: readonly string[]): boolean => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return keys.every(key => typeof record[key] === 'number' && Number.isFinite(record[key]));
};

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

type FlatMeta = { nonResident?: unknown; flatRate?: unknown; rate?: unknown; trace?: unknown; delta?: unknown };
type SnapshotMeta = {
  /** 4011903e — Y and its fallback count, as the engine stamped them. Both optional: a payslip
   *  written before this item carries neither, and the Y row says so rather than guessing. */
  ytdGross?: unknown;
  ytdLegacyBaseSlips?: unknown;
  month?: unknown;
  n?: unknown;
  ytdNet?: unknown;
  epfClaimed?: unknown;
  pcbPaid?: unknown;
  P1?: unknown;
  P2?: unknown;
  reliefs?: Partial<PcbReliefBreakdown>;
  trace?: unknown;
  delta?: unknown;
};

/** `deltaStat`'s stamp: the cumulative month the working describes, and the pair it was differenced
 *  against. Shaped exactly as core/payroll.ts writes it. */
type PcbDelta = { cumulative: number; prior: number; cumulativeBonus: number };

/**
 * Read a stored MTD trace, or NULL.
 *
 * THE GATE IS PRESENCE, NOT TRUTHINESS, and that is the whole point of the function. `n()` above turns
 * `undefined` into 0, so a blob carrying `trace: {}` — or a trace half-written by some future change —
 * would otherwise coerce into a complete-looking table of zeroes and RM 0.00 brackets. Those are claims
 * about someone's tax, so the bar to return a trace at all is that the members no partial write could
 * plausibly supply are present: the bracket rate, its floor, the MTD the formula landed on, and the
 * post-RM10 leg the last line of the working is written from. That last one is on the gate rather than
 * merely read, because a trace missing it produces a printable `max(0, 0.00 − …)` beside a non-zero PCB —
 * a working that contradicts its own answer, which is worse than an honest "not recorded".
 */
const recordedChildNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function readChildWorking(raw: unknown, childCount: number | null, q: number | null, category: unknown, exactCounts = false): PcbTrace['childWorking'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  if (w.table != null && (typeof w.table !== 'object' || Array.isArray(w.table))) return null;
  if (typeof w.disabledIndividual !== 'boolean' || typeof w.disabledSpouse !== 'boolean') return null;
  if (!w.categoryUnits || typeof w.categoryUnits !== 'object' || Array.isArray(w.categoryUnits) ||
      !Object.values(w.categoryUnits).every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
  if ((w.mode !== 'manual' && w.mode !== 'auto_table') || !Array.isArray(w.rows) ||
      typeof w.headCount !== 'number' || !Number.isFinite(w.headCount) || w.headCount < 0) return null;
  if (!w.rows.every((row) => row && typeof row === 'object' &&
      typeof row.category === 'string' && [100, 50].includes(row.sharePercent) &&
      ['children', 'units', 'amountRM'].every((key) => typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0))) return null;
  // Validate recorded provenance; never rebuild missing claims from today's employee profile.
  if (childCount == null || q == null) return null;
  const working = w as unknown as NonNullable<PcbTrace['childWorking']>;
  const close = exactCounts
    ? (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 16
    : (a: number, b: number) => Math.abs(a - b) < 0.005000001;
  if (exactCounts && !Number.isSafeInteger(working.headCount)) return null;
  if (working.mode === 'manual') {
    return working.table == null && working.rows.length === 0 && Object.keys(working.categoryUnits).length === 0 &&
      (close(working.headCount, childCount) || category === 1 && childCount === 0) ? working : null;
  }
  if (!working.table) return null;
  const keys = new Set(PCB_CHILD_CATEGORIES.map(category => category.key));
  if (Object.keys(working.table).some(key => !keys.has(key)) ||
      Object.keys(working.categoryUnits).some(key => !keys.has(key))) return null;
  let headCount = 0;
  let units = 0;
  let claims = 0;
  for (const key of keys) {
    const cell = working.table[key];
    if (cell != null && (typeof cell !== 'object' || Array.isArray(cell))) return null;
    const categoryRows = working.rows.filter(row => row.category === key);
    let categoryUnits = 0;
    for (const [share, field] of [[100, 'full'], [50, 'half']] as const) {
      const count = cell?.[field] ?? 0;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
      const rows = categoryRows.filter(row => row.sharePercent === share);
      if (count === 0 ? rows.length !== 0 : rows.length !== 1 || rows[0].children !== count) return null;
      if (rows.length) {
        if (!close(rows[0].amountRM, rows[0].units * q)) return null;
        categoryUnits += rows[0].units;
        claims += rows.length;
      }
      headCount += count;
    }
    // An omitted zero category is sparse storage; an omitted claimed category is incomplete provenance.
    const recorded = working.categoryUnits[key];
    if (categoryRows.length ? recorded == null || !close(recorded, categoryUnits) : recorded != null && recorded !== 0) return null;
    units += categoryUnits;
  }
  return claims === working.rows.length && close(headCount, working.headCount) && close(units, childCount)
    ? working : null;
}

function readTrace(raw: unknown, savedChildRelief?: unknown): PcbTrace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (t.M === undefined || t.R === undefined || t.mtdNormalCalc === undefined) return null;
  if (t.mtdNormalFloored === undefined) return null;
  const exactCounts = t.childCountVersion === 1;
  const unsupportedCountVersion = t.childCountVersion !== undefined && !exactCounts;
  const childDeductionPerChild = unsupportedCountVersion ? null : recordedChildNumber(t.childDeductionPerChild);
  let childCount = childDeductionPerChild == null ? null : recordedChildNumber(t.childCount);
  // Check the ACTUAL immutable snapshot, before relief parsing/current-relief fallback can turn absence
  // into a printable zero. Money is rounded to cents by payroll; C itself has no monetary rounding.
  if (exactCounts) {
    const recordedRelief = recordedChildNumber(savedChildRelief);
    if (childCount == null || childDeductionPerChild == null || recordedRelief == null ||
        Math.abs(r2(childCount * childDeductionPerChild) - recordedRelief) > 0.0000001) childCount = null;
  }
  const childWorking = readChildWorking(t.childWorking, childCount, childDeductionPerChild, t.category, exactCounts);
  // A recorded new declaration that fails its exact contribution check cannot certify C either.
  // An absent declaration still leaves independently verified Q/C available without inventing rows.
  if (exactCounts && t.childWorking !== undefined && childWorking === null) childCount = null;
  return {
    ...(t.schemeVersion === 1 ? { schemeVersion: 1 as const } : {}),
    ...(hasRecordedNumbers(t, ['T']) ? {T: t.T as number} : {}),
    ...(hasRecordedNumbers(t, ['T2']) ? {T2: t.T2 as number} : {}),
    M: n(t.M),
    R: n(t.R),
    B: n(t.B),
    taxOnP1: n(t.taxOnP1),
    category: n(t.category),
    // NOT `n()` — see the field's own note. `n(undefined)` is 0, and 0 is a lie here.
    childCount,
    ...(exactCounts ? { childCountVersion: 1 as const } : {}),
    childDeductionPerChild,
    childWorking: childCount == null ? null : childWorking,
    Y1: n(t.Y1),
    K1: n(t.K1),
    Y2: n(t.Y2),
    K2: n(t.K2),
    Yt: n(t.Yt),
    Kt: n(t.Kt),
    K2t: n(t.K2t),
    Z: n(t.Z),
    lpAccumulated: n(t.lpAccumulated),
    lpCurrent: n(t.lpCurrent),
    zakatCurrent: n(t.zakatCurrent),
    // Absent ⇒ null ⇒ "this month had no additional remuneration", NOT "the year total was zero".
    totalTaxYear: t.totalTaxYear === undefined ? null : n(t.totalTaxYear),
    totalMtdYear: t.totalMtdYear === undefined ? null : n(t.totalMtdYear),
    mtdNormalCalc: n(t.mtdNormalCalc),
    mtdAdditionalCalc: n(t.mtdAdditionalCalc),
    mtdNormalFloored: n(t.mtdNormalFloored),
    mtdAdditionalFloored: n(t.mtdAdditionalFloored),
    zakatLeftover: n(t.zakatLeftover),
  };
}

/**
 * The hand-set-PCB stamp, or NULL. Gated on the `pcb` LINE specifically: an override of EPF or SOCSO
 * leaves `statutory.pcb` exactly as the engine computed it (`applyStatutoryAdjustment` deliberately does
 * not cascade), so the tax working still explains the deducted figure and there is nothing to warn about.
 */
function readOverride(raw: unknown): { system: number; applied: number; reason: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stamp = raw as { reason?: unknown; lines?: unknown };
  const lines = stamp.lines;
  if (!lines || typeof lines !== 'object' || Array.isArray(lines)) return null;
  const line = (lines as Record<string, unknown>).pcb;
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  const l = line as { system?: unknown; applied?: unknown };
  if (l.system === undefined || l.applied === undefined) return null;
  return {
    system: n(l.system),
    applied: n(l.applied),
    reason: typeof stamp.reason === 'string' ? stamp.reason : '',
  };
}

/**
 * The additional-run stamp, or NULL — gated on PRESENCE for the same reason `readTrace` is. `n()` turns
 * `undefined` into 0, so a half-written stamp would otherwise claim the whole month's PCB was RM 0.00
 * and hand the screen a banner asserting that as fact. Both figures the difference was taken between
 * must be there, or this is not a delta stamp and the payslip is read as an ordinary one.
 */
function readDelta(raw: unknown): PcbDelta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (d.cumulative === undefined || d.prior === undefined) return null;
  return { cumulative: n(d.cumulative), prior: n(d.prior), cumulativeBonus: n(d.cumulativeBonus) };
}

/** The flat-rate twin of `readTrace`, gated the same way: the rate the percentage came from. */
function readFlatTrace(raw: unknown): PcbFlatTrace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (t.remuneration === undefined) return null;
  return { remuneration: n(t.remuneration), additional: n(t.additional), rate: n(t.rate) };
}

/**
 * @param statutory the payslip's stored statutory blob.
 * @param currentReliefs the employee's relief position TODAY, used ONLY when the payslip predates the
 *        stored relief working. Pass null when it cannot be resolved; the panel then reports the total
 *        it can still read (P already has the reliefs netted off) rather than inventing legs.
 */
export function explainPcb(
  statutory: unknown,
  currentReliefs: PcbReliefBreakdown | null,
): PcbExplanation {
  const st = (statutory ?? {}) as Record<string, unknown>;
  const pcb = n(st.pcb);
  const meta = st.pcbMeta;
  const metaObj = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
  // The three figures every shape carries. `pcbSystem` is what the recorded working explains; `pcb` is
  // what left the employee's pay. They differ when the PCB line was set by hand, when this is an
  // additional run whose deduction is the month's increase — or, unhappily but legally, both.
  //
  // THE DELTA WINS THE `system` SEAT WHEN BOTH ARE PRESENT, and it has to: `pcbMeta` is the cumulative
  // month either way, so the cumulative figure is the only one the working on screen actually lands on.
  // The engine's own figure for this run is not lost — it is `engineRun`, printed as its own row.
  const manual = readOverride(st.adjustment);
  const delta = readDelta(metaObj?.delta);
  // A DELTA WITH A ZERO BASELINE HAS NOTHING TO DECLARE. `prior` is the month WITHOUT this run, so when
  // it is zero the increment IS the month and the working already explains the deduction. Raising the
  // banner anyway would train readers to ignore it on the payslips where it matters — the same reason an
  // adjustment to a NON-PCB line raises none. The stamp is still read for the normal/additional split
  // below, because that side is about which month the legs belong to, not about a gap.
  const gap = delta && r2(delta.prior) !== 0 ? delta : null;
  const pcbSystem = gap ? gap.cumulative : manual ? manual.system : pcb;
  const basis: PcbBasis | null =
    gap && manual
      ? { kind: 'additionalRunManual', system: pcbSystem, applied: pcb, prior: gap.prior, engineRun: manual.system, reason: manual.reason }
      : gap
        ? { kind: 'additionalRun', system: pcbSystem, applied: pcb, prior: gap.prior, engineRun: pcb, reason: '' }
        : manual
          ? { kind: 'manual', system: pcbSystem, applied: pcb, prior: null, engineRun: null, reason: manual.reason }
          : null;
  const figures: PcbFigures = { pcb, pcbSystem, basis };
  if (!metaObj) return { kind: 'unavailable', ...figures };

  if(Object.hasOwn(metaObj,'taxCircumstance')){
    const saved=readSavedTaxCircumstance(metaObj.taxCircumstance);
    if(!saved)return {kind:'unavailable',...figures};
    figures.taxCircumstance=saved;
    if(!saved.applicable){
      if(metaObj.notSubjectToIncomeTax!==true || pcb!==0 || n(st.pcbBonus)!==0 || pcbSystem!==0 ||
        manual && (manual.system!==0 || manual.applied!==0) ||
        delta && (delta.cumulative!==0 || delta.cumulativeBonus!==0))return {kind:'unavailable',...figures};
      return {kind:'not_subject',...figures,nonCash:readPcbNonCash(st.pcbNonCash)};
    }
    if(metaObj.notSubjectToIncomeTax===true)return {kind:'unavailable',...figures};
  }
  const nonCash = readPcbNonCash(st.pcbNonCash);
  const savedTrace = metaObj.trace as Record<string, unknown> | null;
  const savedNormal = savedTrace?.Y1 ?? savedTrace?.remuneration;
  const benefitNormal = nonCash ? nonCash.cashNormal + nonCash.cumulative.bik + nonCash.cumulative.vola : NaN;
  figures.nonCash = nonCash && typeof savedNormal === 'number' && Number.isFinite(savedNormal) &&
    Number.isSafeInteger(Math.round(savedNormal * 100)) && Math.abs(savedNormal * 100 - Math.round(savedNormal * 100)) < 0.000001 &&
    Number.isSafeInteger(Math.round(benefitNormal * 100)) && Math.round(benefitNormal * 100) === Math.round(savedNormal * 100)
      ? nonCash : null;

  // Read the immutable scheme before legacy rate keys. Never infer a category from today's profile.
  const selectionFields = ['taxSelectionId', 'taxSelectionVersion', 'taxSelectionSource'] as const;
  const hasSelection = selectionFields.some(key => Object.hasOwn(metaObj, key));
  if (hasSelection && (typeof metaObj.taxSelectionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metaObj.taxSelectionId) ||
      !Number.isSafeInteger(metaObj.taxSelectionVersion) || (metaObj.taxSelectionVersion as number) < 1 ||
      metaObj.taxSelectionSource !== 'income_tax_resident')) return {kind: 'unavailable', ...figures};
  if (hasSelection) Object.assign(figures, {taxSelection: {
    taxSelectionId: metaObj.taxSelectionId as string,
    taxSelectionVersion: metaObj.taxSelectionVersion as number,
    taxSelectionSource: 'income_tax_resident' as const,
  }});
  const scheme = metaObj.calculationScheme;
  const knownSchemes = ['resident', 'rep', 'knowledge_worker', 'c_suite', 'non_resident'];
  if ((hasSelection && scheme === undefined) || scheme !== undefined && !knownSchemes.includes(scheme as string)) return {kind: 'unavailable', ...figures};
  const incentive = scheme === 'rep' || scheme === 'knowledge_worker' || scheme === 'c_suite';
  if (incentive) {
    const raw = metaObj.trace as Record<string, unknown> | null;
    const reliefs = metaObj.reliefs;
    const common = ['M', 'R', 'B', 'taxOnP1', 'category', 'Y1', 'K1', 'Y2', 'K2', 'Yt', 'Kt', 'K2t',
      'Z', 'lpAccumulated', 'lpCurrent', 'zakatCurrent', 'mtdNormalCalc', 'mtdAdditionalCalc',
      'mtdNormalFloored', 'mtdAdditionalFloored', 'zakatLeftover'];
    if ((!hasSelection && (typeof metaObj.taxSchemeDeclarationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metaObj.taxSchemeDeclarationId))) ||
        !raw || raw.schemeVersion !== 1 || !hasRecordedNumbers(raw, common) ||
        !hasRecordedNumbers(metaObj, ['month', 'n', 'ytdNet', 'epfClaimed', 'pcbPaid', 'P1']) ||
        !hasRecordedNumbers(reliefs, ['individual', 'spouse', 'children', 'disabledIndividual', 'disabledSpouse', 'total', 'lp']) ||
        !hasRecordedNumbers(st, ['pcb', 'pcbBonus', 'zakat', 'epfEmployee']) ||
        !Number.isInteger(metaObj.month) || (metaObj.month as number) < 1 || (metaObj.month as number) > 12 ||
        !Number.isInteger(metaObj.n) || metaObj.n !== 12 - (metaObj.month as number) ||
        ![1, 2, 3].includes(raw.category as number) || (raw.Yt as number) < 0 ||
        ((raw.Yt as number) > 0) !== Object.hasOwn(metaObj, 'P2') ||
        raw.R !== 0.15 || raw.M !== 0 ||
        (scheme === 'c_suite' ? raw.B !== 0 || Object.hasOwn(raw, 'T') || Object.hasOwn(raw, 'T2')
          : hasRecordedNumbers(raw, ['T']) && raw.B !== -(raw.T as number)) ||
        (scheme !== 'c_suite' && (!hasRecordedNumbers(raw, ['T']) || (raw.T as number) < 0)) ||
        (Object.hasOwn(metaObj, 'P2') && (!hasRecordedNumbers(metaObj, ['P2']) ||
          !hasRecordedNumbers(raw, ['totalTaxYear', 'totalMtdYear']) ||
          (scheme !== 'c_suite' && (!hasRecordedNumbers(raw, ['T2']) || (raw.T2 as number) < 0))))) {
      return {kind: 'unavailable', ...figures};
    }
  }
  if (scheme === 'non_resident' && (!hasRecordedNumbers(metaObj, ['flatRate']) || metaObj.flatRate !== 0.3)) return {kind: 'unavailable', ...figures};
  const flat = metaObj as FlatMeta;
  if (scheme === 'non_resident' || (scheme === undefined && (flat.flatRate != null || flat.rate != null))) {
    const rate = n(flat.flatRate ?? flat.rate);
    return {
      kind: 'flat',
      legacy: scheme === undefined,
      rate,
      nonResident: scheme === 'non_resident' || flat.nonResident === true,
      trace: readFlatTrace(flat.trace),
      ...figures,
    };
  }

  const m = metaObj as SnapshotMeta;
  // A newly recorded identity and its recorded mathematical category must agree. Never
  // assure an identity from one stamp while the worksheet explains a different category.
  if(figures.taxCircumstance && (metaObj.trace as {category?:unknown}|null)?.category!==figures.taxCircumstance.category){
    const {taxCircumstance:untrustedIdentity,...unavailableFigures}=figures;
    return {kind:'unavailable',...unavailableFigures};
  }
  if (m.P1 === undefined) return { kind: 'unavailable', ...figures };

  const stored = m.reliefs;
  const reliefSource: 'snapshot' | 'current' = stored ? 'snapshot' : 'current';
  const zero: PcbReliefBreakdown = {
    individual: 0, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 0,
  };
  const reliefs: PcbReliefBreakdown = stored
    ? {
        individual: n(stored.individual),
        spouse: n(stored.spouse),
        children: n(stored.children),
        disabledIndividual: n(stored.disabledIndividual),
        disabledSpouse: n(stored.disabledSpouse),
        // `lp` was stamped separately on the blob long before the relief legs were; prefer the snapshot's
        // own copy and fall back to the blob's, so a slip carrying only the latter still shows it.
        lp: stored.lp !== undefined ? n(stored.lp) : n(st.lp),
        total: n(stored.total),
      }
    : (currentReliefs ?? { ...zero, lp: n(st.lp) });

  // `pcbBonus` is the additional-remuneration leg the engine reported. The normal leg is the remainder,
  // derived by subtraction rather than recomputed — the two must sum to the figure the ENGINE produced
  // (`pcbSystem`), which is the figure this working explains and is `pcb` itself on a plain regular run.
  //
  // ON AN ADDITIONAL RUN THE BLOB'S `pcbBonus` IS ALSO A DELTA (it is a DELTA_KEY), so pairing it with a
  // cumulative `pcbSystem` produced a normal leg of RM 0.00 sitting beside a trace that plainly showed
  // one. The cumulative leg comes out of the same stamp the cumulative total does, so both sides of the
  // split describe the same month.
  const pcbAdditional = Math.min(delta ? delta.cumulativeBonus : n(st.pcbBonus), figures.pcbSystem);
  return {
    kind: 'mtd',
    ...(scheme !== undefined ? {calculationScheme: scheme as PcbCalculationScheme} : {}),
    ...(incentive && !hasSelection ? {taxSchemeDeclarationId: metaObj.taxSchemeDeclarationId as string} : {}),
    reliefSource,
    month: n(m.month),
    remainingMonths: n(m.n),
    ytdNetRemuneration: n(m.ytdNet),
    epfClaimedYtd: n(m.epfClaimed),
    // 4011903e — Y as the ENGINE STAMPED IT, or undefined on a slip written before this item. Never
    // defaulted to a number: an absent Y must stay absent so the row can say so, and the one thing this
    // row must never print is a figure reconstructed on the reader's behalf.
    ytdGross: m.ytdGross == null ? undefined : n(m.ytdGross),
    ytdLegacyBaseSlips: m.ytdLegacyBaseSlips == null ? undefined : n(m.ytdLegacyBaseSlips),
    pcbPaidYtd: n(m.pcbPaid),
    epfThisMonth: n(st.epfEmployee),
    chargeableIncome: n(m.P1),
    chargeableIncomeWithAdditional: m.P2 === undefined ? null : n(m.P2),
    reliefs,
    zakat: n(st.zakat),
    pcbNormal: r2(figures.pcbSystem - pcbAdditional),
    pcbAdditional: r2(pcbAdditional),
    trace: readTrace(m.trace, stored?.children),
    normalMtdWorkingRecorded: hasRecordedNumbers(m, ['P1', 'n', 'pcbPaid'])
      && hasRecordedNumbers(m.trace, ['M', 'R', 'B', 'Z', 'zakatCurrent', 'mtdNormalCalc', 'mtdNormalFloored'])
      && hasRecordedNumbers(st, ['pcb'])
      && (m.delta !== undefined ? hasRecordedNumbers(m.delta, ['cumulative', 'prior', 'cumulativeBonus']) : hasRecordedNumbers(st, ['pcbBonus']))
      && ((st.adjustment as {lines?: {pcb?: unknown}} | null)?.lines?.pcb === undefined || hasRecordedNumbers((st.adjustment as {lines?: {pcb?: unknown}}).lines?.pcb, ['system', 'applied'])),
    ...figures,
  };
}

// ═══════════════════════════════ 7f251381 — LHDN's own worksheet order ═══════════════════════════════

/**
 * Feedback 7f251381 — THE SAME RECORDED FIGURES, LAID OUT AS LHDN LAYS THEM OUT.
 *
 * WHY A SECOND LAYOUT IS NOT A SECOND ANSWER. `explainPcb` above already returns every figure the tax
 * working used, and `app/payroll/pcb-detail/pcb-detail-view.tsx` already explains them in an order that
 * reads well. The reporter's problem is not that the figures are wrong or missing — it is that they are in
 * OUR arrangement, so their sheet and ours cannot be laid side by side and read down. This function
 * re-orders what `explainPcb` returned into LHDN's worksheet sequence, under LHDN's symbols, so a
 * disagreement lands on a ROW rather than on a total.
 *
 * IT DERIVES NOTHING, AND THAT IS THE WHOLE DISCIPLINE. Every `amount` below is a member of the
 * explanation (or of the Form TP3 seed) read straight through — no sum, no difference, no re-rounding, no
 * fallback arithmetic. `test/7f251381-pcb-lhdn-worksheet.test.ts` asserts it field by field AND sweeps
 * every emitted amount against the set of numbers actually present in the inputs, so an arithmetic
 * expression introduced here fails even where a hand-written assertion has not been written for that row.
 *
 * THREE THINGS THE SHEET MUST SAY RATHER THAN DRAW:
 *
 *   1. LHDN's Y IS A GROSS ACCUMULATED FIGURE AND WE DO NOT STORE ONE. The engine keeps Σ(Y − K) — the
 *      accumulated remuneration ALREADY net of EPF — and K separately; the gross Y is never persisted.
 *      Y therefore gets a labelled row saying it is not recorded separately, with Σ(Y − K) and K beneath
 *      it, instead of Σ(Y − K) + K printed under Y's symbol. That addition would be correct arithmetic
 *      and still a number this system never wrote down, which is exactly the class of figure this whole
 *      screen exists to stop printing.
 *
 *   2. AN ABSENT TRACE IS "NOT RECORDED", NEVER ZERO. A run predating 45df860a has no `trace`, and every
 *      row fed from it carries `notRecorded`. A sheet of RM 0.00 in LHDN's shape is more convincing and
 *      more wrong than our own layout was — it looks like a completed worksheet.
 *
 *   3. A FLAT-RATE PAYEE HAS NO WORKSHEET AT ALL. See `flatWorksheet` below.
 */

/**
 * The previous-employment figures a Form TP3 declares for the payslip's tax year — item 1bb09a73's
 * output, read for display.
 *
 * WHY IT IS AN INPUT RATHER THAN PART OF THE SNAPSHOT. `pcbMonth` is handed the ALREADY-COMBINED
 * accumulators (Σ(Y − K), K, X, Z each include the seed), so the payslip's own stamp cannot separate the
 * previous employer's share from this employer's months — and this item may not change what a payslip
 * records. The four figures therefore come from the same columns `core/payroll.ts` seeds the replay from
 * (`employee_statutory_my.tp3_*`), read at display time by `previousEmploymentForPayslip`, and the screen
 * says so: they are the employee's CURRENT declaration, not a stamp taken at the moment of the run. Same
 * posture, and the same reason, as `reliefSource: 'current'`.
 */
export type PcbPreviousEmployment = {
  /** `employee_statutory_my.tp3_year`, or null when nothing is declared for this employee at all. */
  declaredYear: number | null;
  /** `declaredYear === the payslip's tax year` — the exact gate `core/payroll.ts` seeds on
   *  (`tp3Applies = e.tp3Year === pYear`). False ⇒ the run seeded all four accumulators with zero. */
  applies: boolean;
  /** LHDN ∑(Y − K) from the TP3: C1 + Σ max(C2ₖ − limitₖ, 0) − C3 (r350 — C1 holds only the TAXABLE
   *  items, so the exempt boxes are not subtracted and only their over-limit excess is added). */
  netRemuneration: number;
  /** C3 — EPF claimed in the previous employment, as declared. NOT clamped to the annual relief cap
   *  here: the cap is applied by the engine and its effect is visible on the K row, and clamping a
   *  declared figure for display would print a number the form does not carry. */
  epfClaimed: number;
  /** C5 — MTD already paid by the previous employer. Part of LHDN's X. */
  pcbPaid: number;
  /** C4(i) — zakat paid through the previous employment. Part of LHDN's Z. C4(ii) is the religious-travel
   *  levy, which is a RELIEF and is deliberately not summed in (item 1bb09a73). */
  zakatPaid: number;
  /** ∑D1…D17 — the reliefs already claimed through the previous employment. Part of LHDN's ∑LP (item
   *  20837372). Until migration 0488 there was no column and this figure did not exist anywhere the run
   *  could read; a worksheet that showed the other four and not this one would be describing a
   *  calculation the reader cannot reconcile, which is the whole purpose of this section. */
  lp: number;
};

/** What a worksheet row prints. A missing figure is a KIND, never a zero and never a blank. */
export type PcbWorksheetValue =
  | { kind: 'money'; amount: number }
  | { kind: 'rate'; rate: number }
  | { kind: 'count'; count: number }
  | { kind: 'text'; text: string }
  /** A caption key instead of a figure — "none declared", "does not apply to this run". */
  | { kind: 'caption'; caption: string }
  /** The run predates 45df860a and never wrote this leg down. */
  | { kind: 'notRecorded' }
  /** Real, used, and never persisted apart from the figure it was netted into (LHDN's Y). */
  | { kind: 'notSeparatelyRecorded' }
  /** §D.2 in a month that paid no additional remuneration — the step did not run, which is a different
   *  statement from a result of zero. */
  | { kind: 'didNotRun' };

export type PcbWorksheetRow = {
  /** LHDN's own symbol. Language-neutral and NEVER translated — the symbol is the thing the two sheets
   *  are matched on. Empty for a line LHDN's sheet gives no symbol to. */
  symbol: string;
  /** Key under `payroll.pcbDetail`. Captions ARE translated; the symbol beside them is not. */
  caption: string;
  value: PcbWorksheetValue;
  /** The previous-employment lines. The reporter's case turns on exactly these four, so they are flagged
   *  rather than merely ordered — the screen marks them and the test can find them without an index. */
  previousEmployment?: true;
};

export type PcbWorksheetSection = {
  heading: string;
  rows: PcbWorksheetRow[];
  /** An optional sentence under the section — a key, resolved by the screen. */
  note?: string;
};

export type PcbWorksheet = {
  /** 'mtd' — the computerised-calculation worksheet. 'flat' — there is NO such worksheet for this payee
   *  and the sheet says so. 'unavailable' — nothing was recorded; the screen's own unavailable card
   *  already carries that sentence and this adds no empty sheet beside it. */
  shape: 'mtd' | 'flat' | 'unavailable';
  sections: PcbWorksheetSection[];
  /** The sentence stating what this sheet is, and what it is not. Always present for a rendered shape. */
  note: string;
};

const money = (amount: number): PcbWorksheetValue => ({ kind: 'money', amount });
/** A trace-fed row: the figure when the run recorded one, the honest absence when it did not. */
const fromTrace = (t: PcbTrace | null, pick: (t: PcbTrace) => number): PcbWorksheetValue =>
  t ? { kind: 'money', amount: pick(t) } : { kind: 'notRecorded' };

/**
 * THE FLAT-RATE DECISION, STATED RATHER THAN DRAWN AS EMPTY ROWS.
 *
 * A non-resident (30%) or REP / Knowledge-Worker (15%) payee is not computed through LHDN's computerised
 * calculation at all: `localization/my/payroll.ts` returns from the flat branch BEFORE `pcbMonth` is
 * called and never reads the accumulators, so there is no P, no M/R/B bracket row, no D/S/Q relief, no Z
 * and no X — and no previous-employment seed either, because the seed only ever reaches `pcbMonth`.
 *
 * Drawing those symbols with "not recorded" beside them would be a lie of a particular kind: it says the
 * figures exist for this employee and were merely not saved. They do not exist. The sheet therefore shows
 * the three lines that DO exist — the remuneration the percentage was applied to, the additional
 * remuneration, and the rate — and states in one sentence that LHDN publishes no worksheet to compare a
 * flat deduction against, so there is nothing to lay side by side. That is the answer, not a gap.
 */
function flatWorksheet(x: Extract<PcbExplanation, { kind: 'flat' }>): PcbWorksheet {
  const t = x.trace;
  const rows: PcbWorksheetRow[] = [
    { symbol: 'Y', caption: 'worksheetFlatY', value: t ? money(t.remuneration) : { kind: 'notRecorded' } },
    { symbol: 'Yt', caption: 'worksheetFlatYt', value: t ? money(t.additional) : { kind: 'notRecorded' } },
    // NO SYMBOL, AND DELIBERATELY NOT 'R'. R is the rate of the TAX-TABLE BRACKET P fell into, and a
    // flat-rate payee has no bracket and no P. Borrowing the symbol would invite a reader to match this
    // line against R on a computerised-calculation sheet that describes a different mechanism entirely.
    { symbol: '', caption: 'worksheetFlatRate', value: { kind: 'rate', rate: x.rate } },
  ];
  return {
    shape: 'flat',
    sections: [
      { heading: 'worksheetFlatHeading', rows },
      { heading: 'worksheetResultHeading', rows: resultRows(x) },
    ],
    note: 'worksheetFlatNote',
  };
}

/**
 * The last rows of every sheet: what the working lands on, and — only when they are different numbers —
 * what the payslip actually deducted.
 *
 * The caption on the first row turns on `basis` for the reason the whole screen turns on it: on an
 * additional run or a hand-set PCB the working explains a figure the payslip does not contain, and a
 * sheet whose final line is captioned "deducted" beside the month's total is the failure this item's
 * own screen was built to remove. The deduction gets its OWN labelled row, never the quiet answer.
 */
function resultRows(x: PcbExplanation): PcbWorksheetRow[] {
  const rows: PcbWorksheetRow[] = [
    { symbol: '', caption: x.basis ? 'worksheetMtdSystem' : 'worksheetMtd', value: money(x.pcbSystem) },
  ];
  if (x.basis) rows.push({ symbol: '', caption: 'worksheetMtdDeducted', value: money(x.pcb) });
  return rows;
}

/**
 * The previous-employment section. ALWAYS four money rows, and always a figure — RM 0.00 where nothing is
 * declared, never a blank. §8: an absent box asserts nothing, where 0.00 asserts the money does not
 * exist, and "does this employee have previous-employment income in this tax year" is precisely the
 * question the reporter's case turned on. A blank there is how it went unnoticed.
 *
 * NO SYMBOL ON THESE FOUR, ON PURPOSE. LHDN's sheet has no separate line for a previous employer: the
 * figures are folded into Y, K, X and Z, which is exactly why the reporter could not see them. The
 * captions name the line each one feeds; inventing a symbol LHDN does not use would defeat the matching
 * the rest of the sheet exists for.
 */
function previousSection(p: PcbPreviousEmployment | null): PcbWorksheetSection {
  const rows: PcbWorksheetRow[] = [
    {
      symbol: '',
      caption: 'worksheetPrevYear',
      value:
        p && p.declaredYear !== null ? { kind: 'text', text: String(p.declaredYear) } : { kind: 'caption', caption: 'worksheetPrevNone' },
    },
    {
      symbol: '',
      caption: 'worksheetPrevApplies',
      value: { kind: 'caption', caption: p?.applies ? 'worksheetPrevAppliesYes' : 'worksheetPrevAppliesNo' },
    },
    { symbol: '', caption: 'worksheetPrevNet', value: money(p?.netRemuneration ?? 0), previousEmployment: true },
    { symbol: '', caption: 'worksheetPrevEpf', value: money(p?.epfClaimed ?? 0), previousEmployment: true },
    { symbol: '', caption: 'worksheetPrevPcb', value: money(p?.pcbPaid ?? 0), previousEmployment: true },
    { symbol: '', caption: 'worksheetPrevZakat', value: money(p?.zakatPaid ?? 0), previousEmployment: true },
    // ∑LP from the previous employment (item 20837372). It sits under the ΣLP row further down, which
    // is the COMBINED figure the formula consumed; this row is the part of it that came in on the TP3,
    // which is what "System must show cumulative ... for the purpose of audit" (specification printed
    // page 28) needs a reader to be able to separate out.
    { symbol: '', caption: 'worksheetPrevLp', value: money(p?.lp ?? 0), previousEmployment: true },
  ];
  return { heading: 'worksheetPreviousHeading', rows, note: 'worksheetPreviousNote' };
}

/**
 * @param x  what `explainPcb` read off the payslip.
 * @param previous the employee's Form TP3 declaration for this payslip's tax year, or null when it could
 *        not be resolved (an unscoped or missing read). Null is NOT the same as "nothing declared": the
 *        section still renders, still shows 0.00, and `worksheetPrevAppliesNo` still says the run seeded
 *        nothing — which is what a null resolves to and what the reader needs to be told.
 */
export function pcbWorksheet(x: PcbExplanation, previous: PcbPreviousEmployment | null): PcbWorksheet {
  // Nothing was recorded at all. The screen's own "unavailable" card already says that in full sentences,
  // so an LHDN-shaped sheet with every line reading "not recorded" is added beside it — which would be a
  // worksheet asserting that this employee HAS a computerised calculation that merely went unsaved. The
  // note reuses that card's existing caption rather than minting a second wording of the same fact.
  if (x.kind === 'not_subject') return {shape:'unavailable',sections:[],note:'taxCategoryNoneExplanation'};
  if (x.kind === 'unavailable') return { shape: 'unavailable', sections: [], note: 'unavailable' };
  if (x.kind === 'flat') return flatWorksheet(x);

  const t = x.trace;
  const income: PcbWorksheetRow[] = [
    // ⚠️ 4011903e — Y IS WRITTEN DOWN NOW, AND THE OLD SENTENCE HERE IS WHY THIS ROW EXISTED AT ALL.
    // It used to read: "LHDN's Y is the GROSS accumulated remuneration for the year. We store Σ(Y − K)
    // and K; the gross is never written down." That was true and it was the right call — Σ(Y−K) + K is
    // arithmetically exactly Y, and printing it would have been a figure this system never produced.
    // The engine now accumulates Y itself, from the same list and the same per-month figure as Σ(Y−K)
    // (core/payroll.ts, `grossRemuneration`), so the row prints what was stamped.
    // THE OLD BEHAVIOUR IS NOT DELETED, IT IS THE FALLBACK: a payslip written before this item carries no
    // `ytdGross`, and for it the row still says the figure is not recorded separately. It must never be
    // reconstructed for those — that is the case the guard in 7f251381 still refuses.
    {
      symbol: 'Y',
      caption: 'worksheetY',
      value: x.ytdGross == null ? { kind: 'notSeparatelyRecorded' } : money(x.ytdGross),
    },
    { symbol: 'Σ(Y−K)', caption: 'worksheetSumYK', value: money(x.ytdNetRemuneration) },
    { symbol: 'K', caption: 'worksheetK', value: money(x.epfClaimedYtd) },
    { symbol: 'Y1', caption: 'worksheetY1', value: fromTrace(t, (v) => v.Y1) },
    { symbol: 'K1', caption: 'worksheetK1', value: fromTrace(t, (v) => v.K1) },
    { symbol: 'Y2', caption: 'worksheetY2', value: fromTrace(t, (v) => v.Y2) },
    { symbol: 'K2', caption: 'worksheetK2', value: fromTrace(t, (v) => v.K2) },
    { symbol: 'n', caption: 'worksheetN', value: { kind: 'count', count: x.remainingMonths } },
  ];
  const additional: PcbWorksheetRow[] = [
    { symbol: 'Yt', caption: 'worksheetYt', value: fromTrace(t, (v) => v.Yt) },
    { symbol: 'Kt', caption: 'worksheetKt', value: fromTrace(t, (v) => v.Kt) },
    { symbol: 'K2t', caption: 'worksheetK2t', value: fromTrace(t, (v) => v.K2t) },
  ];
  const reliefs: PcbWorksheetRow[] = [
    { symbol: 'D', caption: 'worksheetD', value: money(x.reliefs.individual) },
    { symbol: 'S', caption: 'worksheetS', value: money(x.reliefs.spouse) },
    { symbol: 'Du', caption: 'worksheetDu', value: money(x.reliefs.disabledIndividual) },
    { symbol: 'Su', caption: 'worksheetSu', value: money(x.reliefs.disabledSpouse) },
    // ⚠️ r359 fda53352 — Q AND C NOW MEAN WHAT THE SPECIFICATION SAYS THEY MEAN. Q printed
    // `reliefs.children`, the RM TOTAL, and C printed the count of child records; printed p.10 defines
    // "Q  Deduction for qualifying children" and "C  Number of qualifying children" with the formula
    // carrying Q x C, so the slip's own two letters did not multiply to the relief beside them. The
    // product is printed too, because a reader checking the arithmetic should not have to do it.
    // r362 — the guard is on the FIELD, not on the trace. A run stamped before r359 has a trace and no
    // Q or C in it; keying off `t` alone printed RM0.00 and a count of 0 for every one of them.
    {
      symbol: 'Q',
      caption: 'worksheetQ',
      value: t && t.childDeductionPerChild != null ? money(t.childDeductionPerChild) : { kind: 'notRecorded' },
    },
    {
      symbol: 'C',
      caption: 'worksheetC',
      value: t && t.childCount != null ? { kind: 'count', count: t.childCount } : { kind: 'notRecorded' },
    },
    { symbol: 'QC', caption: 'worksheetQc', value: money(x.reliefs.children) },
    { symbol: 'ΣLP', caption: 'worksheetLpAccumulated', value: fromTrace(t, (v) => v.lpAccumulated) },
    { symbol: 'LP1', caption: 'worksheetLpCurrent', value: fromTrace(t, (v) => v.lpCurrent) },
  ];
  const bracket: PcbWorksheetRow[] = [
    { symbol: 'P', caption: 'worksheetP', value: money(x.chargeableIncome) },
    {
      symbol: 'P2',
      caption: 'worksheetP2',
      // NULL means §D.2 never ran — this month paid no additional remuneration. Not "the answer was zero".
      value:
        x.chargeableIncomeWithAdditional === null ? { kind: 'didNotRun' } : money(x.chargeableIncomeWithAdditional),
    },
    ...(!x.calculationScheme || x.calculationScheme === 'resident' ? [{ symbol: 'M', caption: 'worksheetM', value: fromTrace(t, (v) => v.M) }] : []),
    { symbol: 'R', caption: 'worksheetR', value: t ? { kind: 'rate', rate: t.R } : { kind: 'notRecorded' } },
    ...(!x.calculationScheme || x.calculationScheme === 'resident' ? [{ symbol: 'B', caption: 'worksheetB', value: fromTrace(t, (v) => v.B) }] : x.calculationScheme === 'c_suite' ? [] : [{symbol: 'T', caption: 'schemeRebate', value: t?.T == null ? {kind: 'notRecorded' as const} : money(t.T)}]),
    { symbol: '', caption: 'worksheetTaxOnP', value: fromTrace(t, (v) => v.taxOnP1) },
  ];
  const result: PcbWorksheetRow[] = [
    { symbol: 'Z', caption: 'worksheetZ', value: fromTrace(t, (v) => v.Z) },
    { symbol: 'X', caption: 'worksheetX', value: money(x.pcbPaidYtd) },
    // Z₁ is stamped on the blob independently of the trace (`statutory.zakat`), so an old run still has
    // a real figure here rather than an absence — the same fallback the existing screen already makes.
    { symbol: 'Z1', caption: 'worksheetZ1', value: t ? money(t.zakatCurrent) : money(x.zakat) },
    { symbol: 'A', caption: 'worksheetA', value: fromTrace(t, (v) => v.mtdNormalFloored) },
    { symbol: 'E', caption: 'worksheetE', value: fromTrace(t, (v) => v.mtdAdditionalFloored) },
    ...resultRows(x),
  ];

  return {
    shape: 'mtd',
    sections: [
      previousSection(previous),
      { heading: 'worksheetIncomeHeading', rows: income, note: 'worksheetIncomeNote' },
      { heading: 'worksheetAdditionalHeading', rows: additional },
      { heading: 'worksheetReliefHeading', rows: reliefs },
      { heading: 'worksheetBracketHeading', rows: bracket },
      { heading: 'worksheetResultHeading', rows: result },
    ],
    note: 'worksheetNote',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// ad7bc503 — THE REPORTER'S LHDN CALCULATION SLIP: SECTIONS 2, 4, 5, 6, 7 AND 8
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT WAS ALREADY THERE, AND WHAT WAS NOT. The reporter asked for ten sections and opened with
// "displaying only a summary PCB amount". That premise is wrong and the approved plan says so: sections
// 3, 9 and 10 have been on this screen since 7f251381 — `pcbWorksheet` above emits the entire symbol
// block of the reference's page 6 — and section 1 needed extra FIELDS, not a new section. What was
// genuinely missing is the DETAIL SITTING BEHIND THE TOTALS: the children grid behind Q, the itemised
// seventeen-line relief schedules behind ΣLP and LP1, the component split behind Y1 and Yt, and the
// rebate lines behind Z1. That is what this section of the file builds.
//
// ⚠️ IT IS THE SAME DISCIPLINE AS `pcbWorksheet`, ENFORCED BY THE SAME TEST. Everything below RE-SHAPES
// figures the caller already read; not one of them is summed, differenced or re-scaled here. The source
// guard in test/7f251381-pcb-lhdn-worksheet.test.ts slices this file from its own marker to the end and
// refuses '+', '*', 'Math.', rounding and formatting outright, which is why there is not an operator in
// any builder below. The caption keys deliberately carry a `slip` prefix rather than `worksheet`, so that
// test's caption sweep still describes exactly the rows 7f251381 owns.
//
// ⚠️ AND THE ABSENCE RULE IS THE WHOLE POINT OF THE ITEM (CLAUDE.md §8). The reference prints 0.00 down
// every unclaimed line because the employee filed the form and the answer genuinely was nothing. Our
// records are frequently not in that position: no declaration was captured at all. So:
//
//   · nothing was ever recorded for this line          → `notRecorded`
//   · the money is real and was used, but only ever    → `notSeparatelyRecorded`
//     persisted combined with other money
//   · the step never ran                               → `didNotRun`
//
// Printing 0.00 across seventeen lines would state, on a tax document, that the employee claimed nothing
// in each category. We cannot stand behind that, so we do not print it. This is the ONE place the page
// deliberately reads differently from the reporter's attachment, and the plan promises it in writing.

/**
 * One line of the slip. Two figure columns because that is what the agency's own relief schedule has
 * (CURRENT and ACCUMULATED); a section with one column simply leaves `second` off every row.
 */
export type PcbSlipRow = {
  /** The form's own line marker — 'C1', 'a', 'D1', 'Q', 'Y1'. Language-neutral and NEVER translated, for
   *  the reason `PcbWorksheetRow.symbol` is not: it is what the two sheets are matched on. */
  line: string;
  /** A message key. `ns` names WHICH catalogue resolves it, because the seventeen relief lines are
   *  already written, in all six locales, under `taxRelief` — and a second transcription of the agency's
   *  own wording is a second thing to keep in step with the form. */
  caption: string;
  ns: 'pcbDetail' | 'taxRelief';
  first: PcbWorksheetValue;
  second?: PcbWorksheetValue;
  /** A THIRD figure column, for the one section that has one: the children grid's per-category weighting
   *  (`thirdColumn`). Absent ⇒ this section has no such column. */
  third?: PcbWorksheetValue;
  /** The ANNUAL LIMIT (RM) column the agency's schedule prints. `null` ⇒ the form prints no figure
   *  (ADR-0008); absent ⇒ this section has no such column. */
  limit?: number | null;
  /** A lettered sub-line, indented under its numbered item. */
  sub?: true;
};

export type PcbSlipSection = {
  /** Both surfaces prepend the same stored normal-MTD formula working. */
  normalMtdWorking?: true;
  /** A key under `payroll.pcbDetail`. */
  heading: string;
  /** Column headings, as keys. `secondColumn` absent ⇒ a one-column section. */
  firstColumn: string;
  secondColumn?: string;
  thirdColumn?: string;
  limitColumn?: string;
  rows: PcbSlipRow[];
  note?: string;
};

/**
 * The five LHDN s.48 child categories, in the order `employee_statutory_my.child_relief_table` keys them
 * and the order the personnel grid shows them. Exported so a test can assert the row count the form is
 * ruled for without restating the taxonomy.
 *
 * ⚠️ `qc` IS THE SPEC'S QUALIFYING-CHILDREN WEIGHTING, AND IT IS THE ONE STATUTORY INTEGER THIS FILE
 * CARRIES. The approved plan promises the reader "the weighting each category carries", and LHDN's own
 * specification (printed p.27 table plus its footnote) states it as a number of children rather than as
 * ringgit: a child studying at diploma level onwards is "considered with 4 children", a disabled child
 * likewise 4, a disabled child studying 8, and an under-18 or pre-university child 1.
 *
 * `localization/my/statutory-tables.ts` `childByCategory` carries the SAME fact as money — it says so in
 * its own header: "Every value below is the spec's qualifying-children count × the RM2,000 per-child
 * relief", and deliberately "no QC integer is carried". A country pack must not be imported from core/,
 * so the integer is declared here and the equivalence `qc × 2,000 === childByCategory[key]` is asserted by
 * test/ad7bc503-pcb-slip.test.ts — the same device test/child-relief-figures-04b88724.test.ts uses for the
 * pack's own figures, so an edit to either side fails loudly instead of drifting.
 *
 * This reference weighting is not an employee claim. The counted-as column now reads the actual
 * recorded contributions from payroll, including zero and shared claims. Q/C retain their run values.
 */
export const PCB_CHILD_CATEGORIES: readonly {
  readonly key: string;
  readonly caption: string;
  readonly qc: number;
}[] = [
  { key: 'under_18', caption: 'slipChildUnder18', qc: 1 },
  { key: 'study_preu', caption: 'slipChildStudyPreu', qc: 1 },
  { key: 'study_tertiary', caption: 'slipChildStudyTertiary', qc: 4 },
  { key: 'disabled', caption: 'slipChildDisabled', qc: 4 },
  { key: 'disabled_study', caption: 'slipChildDisabledStudy', qc: 8 },
];

/** The employee's stored child / disability tax position, exactly as the column set holds it. */
export type PcbChildProfile = {
  /** `child_relief_mode`. The grid is authoritative ONLY in 'auto_table'; see `pcbChildSection`. */
  mode: string | null;
  /** `child_relief_table` — `{ <category>: { full, half } }`, or null when none was ever keyed. */
  table: Record<string, { full?: unknown; half?: unknown } | undefined> | null;
  disabledIndividual: boolean | null;
  disabledSpouse: boolean | null;
};

/**
 * r372 — HOW MANY CHILDREN ARE ON RECORD, AND WHICH RECORD THAT IS.
 *
 * ⚠️ THIS IS NOT C, AND THE WHOLE POINT OF THE ROW IS THAT IT CANNOT BE READ AS C. LHDN's specification
 * (printed p.10) defines "C  Number of qualifying children", and printed p.27 decides C under the heading
 * "Relief to be given AS IF THE EMPLOYEE HAS THIS NUMBER OF CHILDREN" — 1 for a child under 18, 4 for one
 * in tertiary study, 4 for a disabled child, 8 for a disabled child in tertiary study. So the agency's own
 * C is a WEIGHTED figure: two children can be a C of 9, which is exactly what the reporter's specimen
 * prints. r359 put the weighted figure where a form meant the head count, on the EA, and the reporter
 * caught it; r364 fixed the EA and left this surface's Q and C alone because they were already right.
 *
 * Both numbers are legitimate HERE and both belong in sequence 2, which is the section the agency titles
 * "Category of number of children / qualification rate" — a count and a rate. They are therefore two rows
 * under two captions that say which is which, and the caption names the RECORD the count came from,
 * because "2 children" from a per-category grid and "2 children" keyed as a single total are different
 * statements about what HR entered.
 *
 * COUNTED IN THE READ LAYER, never here: summing the grid is arithmetic, and core/pcb-explain.ts holds
 * none (test/7f251381-pcb-lhdn-worksheet.test.ts refuses an operator below its marker). The sum is where
 * the other sum on this surface is — `priorRemuneration` in app/payroll/pcb-detail/slip-data.ts.
 */
export type PcbChildHeadCount = {
  count: number;
  /** `grid` — the five categories added up. `keyed` — `employee_statutory_my.num_children`. */
  source: 'grid' | 'keyed';
};

/** A stored whole number, or the honest absence. NEVER a zero standing in for a missing box. */
/** A category the admin was shown and left empty. See `pcbChildSection` for why that is a count, not an
 *  absence, and `SLIP_NIL` for the same decision on the relief schedule. */
const SLIP_NIL_COUNT: PcbWorksheetValue = { kind: 'count', count: 0 };

const slipCount = (v: unknown): PcbWorksheetValue =>
  typeof v === 'number' && Number.isFinite(v) ? { kind: 'count', count: v } : { kind: 'notRecorded' };

/** A stored ringgit figure, or the honest absence. */
const slipMoney = (v: unknown): PcbWorksheetValue =>
  typeof v === 'number' && Number.isFinite(v) ? { kind: 'money', amount: v } : { kind: 'notRecorded' };

/** A recorded boolean. `null` is NOT false: the row is absent, so nothing is asserted either way. */
const slipYesNo = (v: boolean | null | undefined): PcbWorksheetValue =>
  v == null ? { kind: 'notRecorded' } : { kind: 'caption', caption: v ? 'slipYes' : 'slipNo' };

/**
 * REPORTER SECTION 2 — CATEGORY OF NUMBER OF CHILDREN / QUALIFICATION RATE.
 *
 * The five s.48 categories with the count claimed at the FULL rate and the count claimed at the HALF
 * rate (LHDN: 100% to one parent, or 50% each where the parents split the claim), then the count and the
 * relief the calculation actually used, then the two disability indicators.
 *
 * ⚠️ THE GRID IS ONLY THE ANSWER IN 'auto_table' MODE. A 'manual' employee has a single keyed
 * `num_children` and NO per-category split — the split was never recorded, and drawing five zero rows
 * would assert that HR entered zero in each. In manual mode every category row therefore reads
 * `notRecorded` and the note says the split was not captured, while C and Q keep their real figures
 * because those are what the engine used.
 *
 * Q AND C COME FROM THE PAYSLIP'S OWN STAMP, not from the grid, and are passed in rather than derived
 * here: the grid is today's position and the stamp is what the run applied. Recomputing the relief from
 * the grid would be a second calculation of the very figure this screen exists to explain.
 */
export function pcbChildSection(
  p: PcbChildProfile | null,
  reliefChildren: PcbWorksheetValue,
  childCount: PcbWorksheetValue,
  /** r359 — Q, the deduction for ONE qualifying child. See the Q/C note on the worksheet rows. */
  childDeductionPerChild: PcbWorksheetValue,
  /** r372 — the HEAD COUNT, which is not C. NULL ⇒ no count was ever recorded; see `PcbChildHeadCount`. */
  headCount: PcbChildHeadCount | null,
  working: PcbTrace['childWorking'] = null,
): PcbSlipSection {
  const grid = p != null && p.mode === 'auto_table' ? p.table : null;
  const rows: PcbSlipRow[] = PCB_CHILD_CATEGORIES.map((c) => {
    // ⚠️ A KEYED GRID IS SPARSE, EXACTLY AS A STORED DECLARATION IS, AND FOR THE SAME REASON.
    // `normaliseChildReliefTable` ends with `if (full === 0 && half === 0) continue`, so a category the
    // admin was shown and left at zero is simply ABSENT from the stored map. Reading that as "not
    // recorded" printed the same contradiction the relief schedule had: a grid with two categories filled
    // showed the other three as unknown, beside a C and a Q that had counted all five. Found by the §8
    // render check, on the page as rendered. So: the GRID's presence decides for every category in it —
    // present ⇒ the admin answered all five and an absent cell is the zero they left; absent ⇒ nothing is
    // asserted about any of them, which is the `table == null` case and a different sentence.
    const cell = grid ? grid[c.key] : undefined;
    return {
    line: '',
    caption: c.caption,
    ns: 'pcbDetail' as const,
    first: grid ? (cell == null ? SLIP_NIL_COUNT : slipCount(cell.full)) : ({ kind: 'notRecorded' } as PcbWorksheetValue),
    second: grid ? (cell == null ? SLIP_NIL_COUNT : slipCount(cell.half)) : ({ kind: 'notRecorded' } as PcbWorksheetValue),
    // Read the category total recorded by payroll; the worksheet performs no arithmetic.
    third: working?.mode === 'auto_table'
      ? { kind: 'count', count: working.categoryUnits[c.key] ?? 0 }
      : { kind: 'notRecorded' },
    };
  });
  // r372 — THE HEAD COUNT FIRST, BESIDE C AND NEVER INSTEAD OF IT. It sits above C so a reader meets the
  // plain number of children before the weighted one, and its caption names which record it was read from.
  // Absent ⇒ nothing was recorded, which is not a family of nobody: see `PcbChildHeadCount`.
  rows.push({
    line: '',
    caption: headCount != null && headCount.source === 'grid' ? 'slipChildOnRecordGrid' : 'slipChildOnRecordKeyed',
    ns: 'pcbDetail',
    first:
      headCount == null
        ? ({ kind: 'notRecorded' } as PcbWorksheetValue)
        : ({ kind: 'count', count: headCount.count } as PcbWorksheetValue),
  });
  // r359 — the same correction as the worksheet: Q is the per-child deduction, C is the weighted number
  // of qualifying children, and the product is the relief that was applied. Q used to print the total.
  rows.push({ line: 'C', caption: 'slipChildCount', ns: 'pcbDetail', first: childCount });
  rows.push({ line: 'Q', caption: 'slipChildRelief', ns: 'pcbDetail', first: childDeductionPerChild });
  rows.push({ line: 'QC', caption: 'slipChildReliefTotal', ns: 'pcbDetail', first: reliefChildren });
  rows.push({ line: '', caption: 'slipDisabledIndividual', ns: 'pcbDetail', first: slipYesNo(p?.disabledIndividual) });
  rows.push({ line: '', caption: 'slipDisabledSpouse', ns: 'pcbDetail', first: slipYesNo(p?.disabledSpouse) });
  return {
    heading: 'slipChildHeading',
    firstColumn: 'slipColFullRate',
    secondColumn: 'slipColHalfRate',
    thirdColumn: 'slipColWeighting',
    rows,
    // ⚠️ THE NOTE IS CHOSEN FROM THE STORED MODE, NOT FROM WHETHER THE GRID RESOLVED. Those are different
    // questions and there are FOUR answers, not two. `slipChildNoteManual` says "this employee's children
    // are recorded as a single total rather than split across the five categories" — a specific factual
    // claim about what HR keyed. Reaching it from `grid == null` put that sentence on two states it is
    // false for, on a document that may be handed to an auditor:
    //   · mode IS 'auto_table' but `child_relief_table` is null — nobody has ever keyed the grid, which
    //     core/child-relief-review.ts:18 documents as a real and reviewable state, and which
    //     `normaliseChildReliefTable` also produces from an all-zero grid;
    //   · there is no `employee_statutory_my` row at all — a non-Malaysian hire, an incomplete onboarding.
    // Each now says what is actually true of it, and only 'manual' claims a manual total.
    // A stored mode this build does not know is treated as the absent row it is indistinguishable from:
    // the sentence must not claim a manual total for a mode nobody here can read.
    note:
      p != null && p.mode === 'auto_table'
        ? grid
          ? 'slipChildNoteTable'
          : 'slipChildNoteTableEmpty'
        : p != null && p.mode === 'manual'
          ? 'slipChildNoteManual'
          : 'slipChildNoteNoProfile',
  };
}

// ── Sections 5 and 6: the component split behind Y1 and Yt ─────────────────────────────────────────
//
// Cash presentation columns do not identify the tax agency's cash component split. Versioned noncash
// snapshots record BIK/VOLA separately; their saved entered/exempt/taxable decisions are read below.
// Missing legacy benefit provenance stays unavailable and is never priced from today's catalogue.

/** The agency's own remuneration lines for the current month (reference page 3). */
const SLIP_CURRENT_COMPONENTS: readonly string[] = [
  'slipCompGrossSalary',
  'slipCompFeesCommission',
  'slipCompTipsAwards',
  'slipCompBenefitsInKind',
  'slipCompLivingAccommodation',
];

/** …and its additional-remuneration lines (reference page 3, lower block). */
const SLIP_ADDITIONAL_COMPONENTS: readonly string[] = [
  'slipAddBonus',
  'slipAddArrears',
  'slipAddCommission',
  'slipAddGratuity',
  'slipAddCompensation',
  'slipAddDirectorFee',
  'slipAddTaxBorne',
  'slipAddOther',
];

const slipComponentRows = (captions: readonly string[]): PcbSlipRow[] =>
  captions.map((caption) => ({
    line: '',
    caption,
    ns: 'pcbDetail' as const,
    first: { kind: 'notSeparatelyRecorded' } as PcbWorksheetValue,
  }));

function recordedBenefitRows(benefits: PcbNonCashSnapshot): PcbSlipRow[] {
  return (['bik','vola'] as const).flatMap(kind => [
    {line:'',caption:kind==='bik'?'slipCompBenefitsInKind':'slipCompLivingAccommodation',ns:'pcbDetail' as const,first:slipMoney(benefits.current[kind].taxable)},
    {line:'',caption:kind==='bik'?'slipBikEntered':'slipVolaEntered',ns:'pcbDetail' as const,first:slipMoney(benefits.current[kind].entered)},
    {line:'',caption:kind==='bik'?'slipBikExempt':'slipVolaExempt',ns:'pcbDetail' as const,first:slipMoney(benefits.current[kind].exempt)},
  ]);
}
function accumulatedBenefitRows(benefits?: PcbNonCashSnapshot | null): PcbSlipRow[] {
  return (['bik','vola'] as const).map(kind => ({line:'',caption:kind==='bik'?'slipAccBik':'slipAccVola',ns:'pcbDetail' as const,
    first:benefits?.accumulated.complete ? slipMoney(benefits.accumulated[kind]) : SLIP_ABSENT}));
}

/**
 * REPORTER SECTION 5 — CURRENT MONTH'S REMUNERATION.
 *
 * @param y1 Y1 as the run stamped it — the combined normal remuneration PCB was charged on.
 * @param k1 K1 — this month's employee EPF, the leg netted off Y1.
 */
export function pcbCurrentRemunerationSection(y1: PcbWorksheetValue, k1: PcbWorksheetValue, benefits?: PcbNonCashSnapshot | null): PcbSlipSection {
  const rows: PcbSlipRow[] = [{ line: 'Y1', caption: 'slipCurrentTotal', ns: 'pcbDetail', first: y1 }];
  for (const r of slipComponentRows(SLIP_CURRENT_COMPONENTS.filter(caption => caption !== 'slipCompBenefitsInKind' && caption !== 'slipCompLivingAccommodation'))) rows.push(r);
  if (benefits) rows.push(...recordedBenefitRows(benefits));
  else for (const caption of ['slipCompBenefitsInKind','slipCompLivingAccommodation']) rows.push({line:'',caption,ns:'pcbDetail',first:SLIP_ABSENT});
  rows.push({ line: 'K1', caption: 'slipCurrentEpf', ns: 'pcbDetail', first: k1 });
  return { heading: 'slipCurrentHeading', firstColumn: 'slipColAmount', rows, note: 'slipCurrentNote' };
}

/**
 * REPORTER SECTION 6 — ADDITIONAL REMUNERATION FOR THE CURRENT MONTH.
 *
 * The section renders even in a month that paid none, because the reporter asked for the section rather
 * than for it to disappear — but Yt is then the engine's own stored zero, which IS a recorded figure,
 * and the §D.2 rows that genuinely did not run are already captioned that way on the worksheet above.
 */
export function pcbAdditionalRemunerationSection(
  yt: PcbWorksheetValue,
  kt: PcbWorksheetValue,
): PcbSlipSection {
  const rows: PcbSlipRow[] = [{ line: 'Yt', caption: 'slipAdditionalTotal', ns: 'pcbDetail', first: yt }];
  for (const r of slipComponentRows(SLIP_ADDITIONAL_COMPONENTS)) rows.push(r);
  rows.push({ line: 'Kt', caption: 'slipAdditionalEpf', ns: 'pcbDetail', first: kt });
  return { heading: 'slipAdditionalRemHeading', firstColumn: 'slipColAmount', rows, note: 'slipAdditionalRemNote' };
}

// ── Sections 4, 7 and 8: the seventeen-line relief schedule, itemised ──────────────────────────────

/** One lettered sub-line of the agency's schedule, structurally as the pack declares it. */
export type PcbSlipCatalogueSub = {
  readonly code: string;
  readonly limit: number | null;
};

/** One numbered line of the agency's schedule (C1–C17, D1), structurally as the pack declares it. */
export type PcbSlipCatalogueItem = {
  readonly code: string;
  readonly limit: number | null;
  readonly subItems: readonly PcbSlipCatalogueSub[];
  readonly perSubLimit?: boolean;
};

/** Per-item, and per lettered sub-line, exactly the shape `tp1_relief.categories.items` and TP3's
 *  `sectionD` both use — which is why one reader serves both sides (`Tp1ItemAmounts`). */
export type PcbSlipAmounts = {
  items: Record<string, { amount?: unknown; subItems?: Record<string, unknown> } | undefined>;
  subItems?: Record<string, Record<string, unknown> | undefined>;
};

/**
 * WHAT IS KNOWN ABOUT ONE SIDE OF THE SCHEDULE.
 *
 *   · null           nothing was read at all — no declaration, no form. Every line `notRecorded`.
 *   · attributed:false  money exists and was used, but the row is a LEGACY eight-key or scalar-only
 *                    declaration that carries NO C1–C17 attribution. `core/tax-relief.ts` states in as
 *                    many words that there is no honest way to split it, so every line reads
 *                    `notSeparatelyRecorded` and the total row carries the real figure.
 *   · attributed:true   the per-line figures are real.
 */
export type PcbSlipSide = {
  attributed: boolean;
  amounts: PcbSlipAmounts | null;
  /** The authoritative roll-up for this side, whether or not it is attributed. */
  total: unknown;
};

const SLIP_ABSENT: PcbWorksheetValue = { kind: 'notRecorded' };
const SLIP_COMBINED: PcbWorksheetValue = { kind: 'notSeparatelyRecorded' };
/** A box the declaration COVERED and left empty. See `slipSubValue` for why that is a figure and not an
 *  absence, and why it is the only zero this file will print. */
const SLIP_NIL: PcbWorksheetValue = { kind: 'money', amount: 0 };
/** r361 — this row's figure belongs in the section's OTHER column. The cell is ruled empty with the same
 *  dash the view already prints for the mirror case, so it asserts nothing at all — it is not an absence
 *  and it is certainly not a zero. */
const SLIP_NO_COLUMN: PcbWorksheetValue = { kind: 'caption', caption: 'slipNoColumn' };

/** One numbered line's own stored entry, as the two writers persist it. */
type SlipEntry = NonNullable<PcbSlipAmounts['items'][string]>;

/**
 * ⚠️ THE NUMBERED LINE DECIDES FOR ITS WHOLE FAMILY, AND THIS IS THE CONTRACT THE ITEM TURNS ON.
 *
 * A stored declaration is DENSE over the numbered lines and SPARSE over the lettered ones. Both writers —
 * `core/tp3.ts` `readGroup` and `core/tax-relief.ts` `validateCatalogueCategories.readGroup` — walk the
 * whole catalogue and write `out[def.code] = subItems ? { amount, subItems } : { amount }` for EVERY def,
 * with `validateAmount(undefined) === 0`, while a sub-line is written only `if (v > 0)`. So for any
 * actually-filed form, C9 is present carrying 0 and C9(a) is simply not there.
 *
 * Reading those two absences differently is how this screen came to make two incompatible statements about
 * the same money: C4 printing RM 1,200 while C4(b) read "nothing was recorded", when C4's amount IS the
 * server's own sum of C4(a)…(d) and therefore says C4(b) was read and was empty. `slipPdfProvenance` tells
 * the reader in as many words that a line stating nothing was recorded is one NO DECLARATION WAS CAPTURED
 * FOR — so printing it inside a captured declaration is a false sentence on a tax document.
 *
 * Hence: the presence of the NUMBERED entry decides for the numbered line and every lettered line under
 * it. Present ⇒ this form covered the line, so an empty box is the declared nil the reporter's own
 * reference prints as 0.00. Absent ⇒ this side says nothing about the line at all, and neither do we.
 */
const slipLineEntry = (side: PcbSlipSide | null, code: string): SlipEntry | undefined =>
  side != null && side.attributed && side.amounts != null ? side.amounts.items[code] : undefined;

/** WHY a side shows no figure for a line: it holds nothing about it, or holds the money only combined. */
const slipLineAbsence = (side: PcbSlipSide | null): PcbWorksheetValue =>
  side != null && !side.attributed ? SLIP_COMBINED : SLIP_ABSENT;

/** A NUMBERED line's figure. The stored amount is the server's own roll-up of the line's boxes. */
function slipItemValue(side: PcbSlipSide | null, code: string): PcbWorksheetValue {
  const entry = slipLineEntry(side, code);
  return entry == null ? slipLineAbsence(side) : slipMoney(entry.amount);
}

/** A LETTERED sub-line's figure. Its numbered parent decides whether the line was declared at all. */
function slipSubValue(side: PcbSlipSide | null, code: string, sub: string): PcbWorksheetValue {
  const entry = slipLineEntry(side, code);
  if (entry == null) return slipLineAbsence(side);
  const stored = (entry.subItems ?? {})[sub];
  return stored == null ? SLIP_NIL : slipMoney(stored);
}

/**
 * The agency's relief schedule rendered once, over whichever sides the caller resolved.
 *
 * ONE BUILDER FOR THREE OF THE REPORTER'S SECTIONS, on purpose. Sections 4, 7 and 8 are the SAME
 * seventeen-line taxonomy read for three different questions — what a previous employer already
 * deducted, what this month's declaration claims, and which rebate lines were declared. Three copies of
 * the C1–C17 row list is three things to keep in step with the form, and `localization/my/statutory-
 * tables.ts` refuses a second transcription of this taxonomy for exactly that reason.
 */
export function pcbReliefScheduleSection(p: {
  heading: string;
  firstColumn: string;
  secondColumn?: string;
  note?: string;
  catalogue: readonly PcbSlipCatalogueItem[];
  /** Which catalogue the line captions live in — `taxRelief.items.*` or `taxRelief.rebates.*`. */
  captionGroup: 'items' | 'rebates';
  first: PcbSlipSide | null;
  second?: PcbSlipSide | null;
  /** The roll-up row's caption, or absent for a section the form gives no total line. */
  totalCaption?: string;
}): PcbSlipSection {
  const rows: PcbSlipRow[] = [];
  for (const def of p.catalogue) {
    rows.push({
      line: def.code.toUpperCase(),
      caption: `${p.captionGroup}.${def.code}.label`,
      ns: 'taxRelief',
      limit: def.perSubLimit ? null : def.limit,
      first: slipItemValue(p.first, def.code),
      second: p.secondColumn ? slipItemValue(p.second ?? null, def.code) : undefined,
    });
    for (const sub of def.subItems) {
      rows.push({
        line: sub.code,
        caption: `${p.captionGroup}.${def.code}.sub.${sub.code}`,
        ns: 'taxRelief',
        sub: true,
        limit: sub.limit,
        first: slipSubValue(p.first, def.code, sub.code),
        second: p.secondColumn ? slipSubValue(p.second ?? null, def.code, sub.code) : undefined,
      });
    }
  }
  if (p.totalCaption) {
    rows.push({
      line: '',
      caption: p.totalCaption,
      ns: 'pcbDetail',
      first: p.first ? slipMoney(p.first.total) : SLIP_ABSENT,
      second: p.secondColumn ? (p.second ? slipMoney(p.second.total) : SLIP_ABSENT) : undefined,
    });
  }
  return {
    heading: p.heading,
    firstColumn: p.firstColumn,
    secondColumn: p.secondColumn,
    limitColumn: 'slipColLimit',
    rows,
    note: p.note,
  };
}

/**
 * r361 / bf3c9712 — THE YEAR'S PRIOR PAYSLIPS, ITEMISED BY THE PAYSLIP'S OWN COMPONENT COLUMNS.
 *
 * The agency's page 1 prints the accumulated block as an itemised list and then a set of accumulator
 * totals. WE HOLD THOSE TWO THINGS ON DIFFERENT MEASURES, and the block says so rather than implying
 * they reconcile:
 *
 *   · THE ITEMISATION is what the employee was PAID, summed off the four money columns of this tax
 *     year's payslips before the payroll month being explained (`app/payroll/pcb-detail/slip-data.ts`,
 *     the same shape `localization/my/reports.ts` eaStatement uses for the EA's Part B).
 *   · THE TOTALS (Y, K, Σ(Y−K), X, Z) are the ACCUMULATORS the run itself was computed against, read
 *     off the payslip's own stamp. Y accumulates `bases.pcb` — the figure PCB is CHARGED on — which
 *     differs from what was paid by every exempt ringgit and every unpaid-leave deduction
 *     (`localization/my/payroll.ts` foldPriorSlipIntoAccumulators, spec rule 9). They are also seeded
 *     by the Form TP3, so they carry the previous employer's money and the itemisation cannot.
 *
 * Taking the totals from the trace rather than re-summing them here is the whole point: the block and
 * the working above it read the SAME numbers, so they cannot disagree about what the year holds. The
 * note states both gaps in words; it is the only thing that makes the column pair honest.
 */
export type PcbAccumulatedRemuneration = {
  /** Σ `basic_salary` and `overtime_pay` over the year's payslips BEFORE this payroll month. */
  grossSalary: number;
  /** Σ `allowance` over the same slips. */
  allowances: number;
  /** Σ `bonus` — the Yt additional-remuneration stream — over the same slips. */
  additional: number;
};

/**
 * REPORTER SECTION 3 (official page 1) — ACCUMULATED REMUNERATION / MTD / REBATE / OTHER DEDUCTIONS FOR
 * THE PREVIOUS MONTHS OF THE CURRENT YEAR.
 *
 * ⚠️ THREE LINES DELIBERATELY DO NOT CARRY A FIGURE, AND EACH SAYS A DIFFERENT THING.
 *
 *   · FEES / COMMISSION reads "recorded only in combination". There is no such payroll column: a
 *     director's fee or a commission is configured as a pay item and lands inside `allowance` or
 *     `bonus`. Splitting it out here would be a figure this system never wrote down.
 *   · THE DEPARTURE LEVY likewise. Z is the spec's own combined column — rule 5 heads it "zakat AND
 *     departure levy" and `foldPriorSlipIntoAccumulators` accumulates `zakat` together with the TP1
 *     rebate that carries the levy — so no separate accumulated levy figure exists to print. The
 *     zakat row is captioned as the combined figure it is, and the levy row says so.
 *   · Y reads "recorded only in combination" on a payslip written before the engine stamped it
 *     (4011903e), exactly as the worksheet's own Y row does. It is never reconstructed.
 *
 * BIK and VOLA come from this attempt's immutable accumulated benefit snapshot. Incomplete or missing
 * historical benefit evidence is unavailable. A genuine saved zero remains displayable as zero.
 */
export function pcbAccumulatedRemunerationSection(
  x: Extract<PcbExplanation, { kind: 'mtd' }>,
  paid: PcbAccumulatedRemuneration | null,
): PcbSlipSection {
  const t = x.trace;
  const rows: PcbSlipRow[] = [
    { line: '', caption: 'slipAccGrossSalary', ns: 'pcbDetail', first: slipMoney(paid?.grossSalary) },
    { line: '', caption: 'slipAccFeesCommission', ns: 'pcbDetail', first: SLIP_COMBINED },
    { line: '', caption: 'slipAccTipsAllowances', ns: 'pcbDetail', first: slipMoney(paid?.allowances) },
    ...accumulatedBenefitRows(x.nonCash),
    { line: '', caption: 'slipAccAdditional', ns: 'pcbDetail', first: slipMoney(paid?.additional) },
    {
      line: 'Y',
      caption: 'slipAccGross',
      ns: 'pcbDetail',
      first: SLIP_NO_COLUMN,
      second: x.ytdGross == null ? SLIP_COMBINED : slipMoney(x.ytdGross),
    },
    { line: 'K', caption: 'slipAccEpf', ns: 'pcbDetail', first: slipMoney(x.epfClaimedYtd) },
    {
      line: 'Σ(Y−K)',
      caption: 'slipAccNet',
      ns: 'pcbDetail',
      first: SLIP_NO_COLUMN,
      second: slipMoney(x.ytdNetRemuneration),
    },
    {
      line: 'X',
      caption: 'slipAccMtd',
      ns: 'pcbDetail',
      first: SLIP_NO_COLUMN,
      second: slipMoney(x.pcbPaidYtd),
    },
    {
      line: 'Z',
      caption: 'slipAccZakat',
      ns: 'pcbDetail',
      first: SLIP_NO_COLUMN,
      second: t ? slipMoney(t.Z) : SLIP_ABSENT,
    },
    { line: '', caption: 'slipAccLevy', ns: 'pcbDetail', first: SLIP_NO_COLUMN, second: SLIP_COMBINED },
  ];
  return {
    heading: 'slipAccHeading',
    firstColumn: 'slipColAmount',
    secondColumn: 'slipColTotal',
    rows,
    // The accumulator totals are the run's own; the itemisation is this employer's payslips only. Which
    // is which, and why the two columns need not add up, is the note's whole job.
    note: paid ? 'slipAccNote' : 'slipAccNoteUnread',
  };
}

/**
 * ad7bc503 — THE REPORTER'S SECTIONS 2, 4, 5, 6, 7 AND 8, IN THEIR OWN ORDER, ASSEMBLED ONCE.
 *
 * Sections 1, 3, 9 and 10 are NOT here: 1 is the identification block at the top of the screen, and 3, 9
 * and 10 are `pcbWorksheet` above, which has emitted them since 7f251381. Rebuilding them would be the
 * second display of one calculation this whole screen was created to remove.
 *
 * A flat-rate payee has no resident relief schedules. Newly recorded noncash benefits still have
 * meaningful current/accumulated rows and share this same screen/download section owner. Legacy flat
 * histories without that provenance retain their existing layout.
 */
export function pcbSlipSections(
  x: PcbExplanation,
  p: {
    profile: PcbChildProfile | null;
    /** r372 — how many children are on record, and from which record. See `PcbChildHeadCount`. */
    childHeadCount?: PcbChildHeadCount | null;
    catalogue: readonly PcbSlipCatalogueItem[];
    rebateCatalogue: readonly PcbSlipCatalogueItem[];
    currentDeduction: PcbSlipSide | null;
    accumulatedDeduction: PcbSlipSide | null;
    previousDeduction: PcbSlipSide | null;
    currentRebate: PcbSlipSide | null;
    accumulatedRebate: PcbSlipSide | null;
    /** r361 — the year's prior payslips, itemised. NULL ⇒ they were not read (or could not be), which
     *  is a DIFFERENT statement from a year with nothing in it and the section's note says which. */
    accumulatedRemuneration?: PcbAccumulatedRemuneration | null;
  },
): PcbSlipSection[] {
  if (x.kind === 'flat' && x.nonCash) return [
    {heading:'slipAccHeading',firstColumn:'slipColAmount',rows:accumulatedBenefitRows(x.nonCash),note:'slipAccNote'},
    {heading:'slipCurrentHeading',firstColumn:'slipColAmount',rows:recordedBenefitRows(x.nonCash),note:'slipCurrentNote'},
  ];
  if (x.kind !== 'mtd') return [];
  const t = x.trace;
  return [
    // 2 — the children grid behind Q.
    pcbChildSection(
      t?.childWorking ?? null,
      slipMoney(x.reliefs.children),
      // r362 — guarded on the FIELD, not the trace, for the same reason as the worksheet's Q and C
      // rows: a run stamped before r359 has a trace with neither, and SLIP_ABSENT is the truthful cell.
      t && t.childCount != null ? { kind: 'count', count: t.childCount } : SLIP_ABSENT,
      t && t.childDeductionPerChild != null ? slipMoney(t.childDeductionPerChild) : SLIP_ABSENT,
      t?.childWorking ? { count: t.childWorking.headCount, source: t.childWorking.mode === 'auto_table' ? 'grid' : 'keyed' } : null,
      t?.childWorking ?? null,
    ),
    // 3 — r361: the accumulated remuneration block, which the official prints on page 1 immediately
    // under the child grid and above the accumulated deductions.
    // ⚠️ r372 — THE ORDER OF THIS ARRAY IS NO LONGER WHAT A SURFACE RENDERS. `pcbDetailLayout` places
    // every one of these sections BY ITS HEADING and gives it the reporter's number, so reordering this
    // return value cannot renumber a tax document and cannot move a section on one surface only. The
    // numbers in these comments are the reporter's sequences, which is what they always meant.
    pcbAccumulatedRemunerationSection(x, p.accumulatedRemuneration ?? null),
    // 4 — what a previous employer already deducted, itemised. The ACCUMULATED side of the reporter's
    // section 4: TP3 Section D, keyed exactly as `tp1_relief.categories.items` is.
    pcbReliefScheduleSection({
      heading: 'slipPrevDeductionHeading',
      firstColumn: 'slipColAccumulated',
      note: 'slipPrevDeductionNote',
      catalogue: p.catalogue,
      captionGroup: 'items',
      first: p.previousDeduction,
    }),
    // 5 and 6 — the component split payroll does not persist. See the block above `SLIP_CURRENT_COMPONENTS`.
    pcbCurrentRemunerationSection(fromTrace(t, (v) => v.Y1), t ? slipMoney(t.K1) : slipMoney(x.epfThisMonth), x.nonCash),
    pcbAdditionalRemunerationSection(fromTrace(t, (v) => v.Yt), fromTrace(t, (v) => v.Kt)),
    // 7 — this month's declaration, itemised, beside the year it accumulates into.
    pcbReliefScheduleSection({
      heading: 'slipCurrentDeductionHeading',
      firstColumn: 'slipColCurrent',
      secondColumn: 'slipColAccumulated',
      note: 'slipCurrentDeductionNote',
      catalogue: p.catalogue,
      captionGroup: 'items',
      first: p.currentDeduction,
      second: p.accumulatedDeduction,
      totalCaption: 'slipDeductionTotal',
    }),
    // 8 — the rebate lines, plus the zakat the payroll itself deducted. Z1 IS on the worksheet above as a
    // symbol; it is repeated here because the reporter's section 8 asks what rebate applied this month and
    // an answer that omitted the zakat actually taken would be the wrong answer.
    pcbRebateSection(
      p.rebateCatalogue,
      p.currentRebate,
      p.accumulatedRebate,
      t ? slipMoney(t.zakatCurrent) : slipMoney(x.zakat),
    ),
  ];
}

/**
 * REPORTER SECTION 8 — REBATE INFORMATION FOR THE CURRENT MONTH.
 *
 * The agency's Section D rebate lines (zakat OTHER than through salary, and the Umrah / religious-travel
 * levy) and then the zakat the payroll DID deduct through salary.
 *
 * ⚠️ THOSE ARE NOT THE SAME MONEY AND THE FORM SAYS SO — D1(a) is expressly zakat "other than that paid
 * through monthly salary deductions", and that exclusion is the whole point of the line: it is what stops
 * one payment being counted twice against a person who also has a payroll zakat deduction. So the two sit
 * on separate rows under separate captions, and nothing here adds them together.
 */
function pcbRebateSection(
  catalogue: readonly PcbSlipCatalogueItem[],
  current: PcbSlipSide | null,
  accumulated: PcbSlipSide | null,
  zakatViaSalary: PcbWorksheetValue,
): PcbSlipSection {
  const base = pcbReliefScheduleSection({
    heading: 'slipRebateHeading',
    firstColumn: 'slipColCurrent',
    secondColumn: 'slipColAccumulated',
    note: 'slipRebateNote',
    catalogue,
    captionGroup: 'rebates',
    first: current,
    second: accumulated,
  });
  base.rows.push({ line: 'Z1', caption: 'slipRebateZakatSalary', ns: 'pcbDetail', limit: null, first: zakatViaSalary });
  return base;
}

/**
 * ad7bc503 — THE CAPTIONS THAT TURN ON `basis`, DECIDED ONCE FOR THE SCREEN AND THE DOCUMENT.
 *
 * WHY THIS IS IN core/ AND NOT IN THE COMPONENT ANY MORE. `explanation.basis` is the sentence a reader
 * needs before reading a single figure: the working below lands on a number their payslip may not contain,
 * because it was replaced by hand or because the run deducted only the month's increase. The view has said
 * so in a banner since 45df860a; the DOWNLOADED document did not, and a document that omits it is exactly
 * what the view's own comment warns about — "a competent-looking derivation of an amount nobody deducted".
 *
 * Adding it to the document by re-deriving the captions there would have been a second copy of a decision
 * with eight branches, so the decision moved here and both surfaces read it. Nothing is computed: every
 * value below is a message key or a figure already on `basis`.
 */
export function pcbBasisLabels(basis: PcbBasis | null): {
  banner: string;
  bannerHeading: string;
  bannerSystem: string;
  bannerApplied: string;
  netSystem: string;
  netDeducted: string;
  finalSystem: string;
  finalDeducted: string;
  note: string;
} {
  /** An additional run's working describes the WHOLE MONTH, so every line that lands on `pcbSystem` has
   *  to be captioned as the month rather than as "what the system calculated" — on an off-cycle run those
   *  are not the same sentence, and the reader is looking at a figure their payslip does not contain. */
  const wholeMonth = basis != null && basis.prior != null;
  return {
    banner:
      basis?.kind === 'manual'
        ? 'overrideBanner'
        : basis?.kind === 'additionalRun'
          ? 'deltaBanner'
          : 'deltaOverrideBanner',
    bannerHeading:
      basis?.kind === 'manual'
        ? 'overrideHeading'
        : basis?.kind === 'additionalRun'
          ? 'deltaHeading'
          : 'deltaOverrideHeading',
    bannerSystem: wholeMonth ? 'deltaMonthTotal' : 'overrideSystem',
    bannerApplied: basis?.kind === 'additionalRun' ? 'deltaApplied' : 'overrideApplied',
    netSystem: wholeMonth ? 'netMtdMonth' : 'netMtdSystem',
    netDeducted: basis?.kind === 'additionalRun' ? 'netMtdRun' : 'netMtdDeducted',
    finalSystem: wholeMonth ? 'finalPcbMonth' : 'finalPcbSystem',
    finalDeducted: basis?.kind === 'additionalRun' ? 'finalPcbRun' : 'finalPcbDeducted',
    note:
      basis?.kind === 'manual'
        ? 'overrideNote'
        : basis?.kind === 'additionalRun'
          ? 'deltaNote'
          : 'deltaOverrideNote',
  };
}

/**
 * THE SAME BANNER AS A SECTION, so the downloaded document can carry it beside the identification block.
 *
 * `null` when the working explains exactly what was deducted — which is the ordinary case, and a block
 * saying "these agree" would be noise on every normal payslip. The reason line is printed only where a
 * human was asked for one: an additional run has no operator and no reason, and `notRecorded` there would
 * report a missing answer to a question nobody was asked.
 */
export function pcbBasisSection(x: PcbExplanation): PcbSlipSection | null {
  const basis = x.basis;
  if (basis == null) return null;
  const L = pcbBasisLabels(basis);
  const rows: PcbSlipRow[] = [
    { line: '', caption: L.bannerSystem, ns: 'pcbDetail', first: money(basis.system) },
  ];
  if (basis.prior != null) {
    rows.push({ line: '', caption: 'deltaPrior', ns: 'pcbDetail', first: money(basis.prior) });
  }
  // The engine's own increment is worth a line only when it is NOT what was deducted — i.e. when an
  // increment run was then also set by hand, and there are three figures to keep apart.
  if (basis.kind === 'additionalRunManual' && basis.engineRun != null) {
    rows.push({ line: '', caption: 'deltaEngineRun', ns: 'pcbDetail', first: money(basis.engineRun) });
  }
  rows.push({ line: '', caption: L.bannerApplied, ns: 'pcbDetail', first: money(basis.applied) });
  if (basis.kind !== 'additionalRun') {
    rows.push({
      line: '',
      caption: 'overrideReason',
      ns: 'pcbDetail',
      first: basis.reason ? { kind: 'text', text: basis.reason } : SLIP_ABSENT,
    });
  }
  return { heading: L.bannerHeading, firstColumn: 'slipColAmount', rows, note: L.banner };
}

// ═══════════════════ r361 / bf3c9712 — THE OFFICIAL'S TWO NUMBERED STEPS, AND ITS RESULTS ═══════════════════
//
// The agency's own slip closes with three bands, in this order (official pages 6 and 7):
//
//     MTD CALCULATION
//       1.  MTD excess of annual year net remuneration excluding additional remuneration :
//             … every letter, then "Current Month's MTD = …" and "Net MTD = Current Month's MTD − (zakat)"
//       2.  MTD must be deducted :
//             MTD = …
//     CALCULATION RESULTS
//             Net MTD / MTD additional remuneration / MTD for the month to be deducted, then two notes.
//
// OUR PAGE CARRIED THE WORKING AND NONE OF THE THREE BANDS, so a reader holding the agency's slip ran
// out of our page one band early and could not find the line the two documents were supposed to meet on.
//
// ⚠️ THE REPETITION IS THE AGENCY'S, NOT OURS. Net MTD appears under step 1 and again under the results;
// the deducted figure appears under step 2 and again under the results. That is how the slip is printed
// and reproducing it is the entire request ("the sequence on our page matches the sequence on theirs").
// Every one of those cells is the SAME stored figure read twice, never a second derivation of it, so the
// repetition cannot become a disagreement.
//
// ⚠️ AND THE LAST LINE IS THE STAMP. `x.pcb` is `statutory.pcb` — what the payslip actually deducted,
// already truncated, already rounded up to the nearest 5 sen and already RM10-floored by the engine
// (`localization/my/payroll.ts` §E.1–E.3). Nothing here re-applies any of that: a figure this file
// produced could differ from the payslip by a sen, and a statutory explanation that differs from the
// deduction it explains is worse than no explanation. Where the working does NOT explain the deduction
// (a hand-set PCB, or an additional run that deducted only the month's increase) the two figures get
// two separately captioned rows through `pcbBasisLabels`, exactly as every other block on this screen
// does — the deduction is never the quiet answer to a working that did not produce it.

/**
 * Official page 6, item 1 — the step the whole working above belongs to, landing on the two figures the
 * agency prints under it.
 *
 * `Net MTD` is `pcbNormal`: the normal-remuneration leg of the figure the engine produced, already net
 * of this month's zakat through §E.5's cascade. It is READ (`explainPcb` splits `pcbSystem` against the
 * engine's own stamped additional leg) and not the subtraction the agency's line describes.
 */
export function pcbMtdStep1Section(x: Extract<PcbExplanation, { kind: 'mtd' }>): PcbSlipSection {
  const t = x.normalMtdWorkingRecorded === false ? null : x.trace;
  return {
    heading: 'slipStep1Heading',
    normalMtdWorking: true,
    firstColumn: 'slipColTotal',
    rows: [
      { line: 'P', caption: 'worksheetP', ns: 'pcbDetail', first: t ? slipMoney(x.chargeableIncome) : SLIP_ABSENT },
      ...(!x.calculationScheme || x.calculationScheme === 'resident' ? [{ line: 'M', caption: 'bracketM', ns: 'pcbDetail' as const, first: t ? slipMoney(t.M) : SLIP_ABSENT }] : []),
      { line: 'R', caption: 'bracketR', ns: 'pcbDetail', first: t ? {kind: 'rate', rate: t.R} : SLIP_ABSENT },
      ...(!x.calculationScheme || x.calculationScheme === 'resident' ? [{ line: 'B', caption: 'bracketB', ns: 'pcbDetail' as const, first: t ? slipMoney(t.B) : SLIP_ABSENT }] : x.calculationScheme === 'c_suite' ? [] : [{line: 'T', caption: 'schemeRebate', ns: 'pcbDetail' as const, first: t?.T == null ? SLIP_ABSENT : slipMoney(t.T)}]),
      { line: 'Z', caption: 'worksheetZ', ns: 'pcbDetail', first: t ? slipMoney(t.Z) : SLIP_ABSENT },
      { line: 'X', caption: 'worksheetX', ns: 'pcbDetail', first: t ? slipMoney(x.pcbPaidYtd) : SLIP_ABSENT },
      { line: 'n', caption: 'worksheetN', ns: 'pcbDetail', first: t ? {kind: 'count', count: x.remainingMonths} : SLIP_ABSENT },
      { line: '1', caption: 'slipStep1CurrentMtd', ns: 'pcbDetail', first: t ? slipMoney(t.mtdNormalCalc) : SLIP_ABSENT },
      { line: 'Z1', caption: 'slipStep1CurrentRebate', ns: 'pcbDetail', first: t ? slipMoney(t.zakatCurrent) : SLIP_ABSENT },
      { line: 'A', caption: 'worksheetA', ns: 'pcbDetail', first: t ? slipMoney(t.mtdNormalFloored) : SLIP_ABSENT },
      { line: '', caption: 'slipStep1NetMtd', ns: 'pcbDetail', first: t ? slipMoney(x.pcbNormal) : SLIP_ABSENT },
    ],
    note: 'slipStep1Note',
  };
}

/** Official page 6, item 2 — "MTD must be deducted". One line, and it is the payslip's own figure. */
export function pcbMtdStep2Section(x: Extract<PcbExplanation, { kind: 'mtd' }>): PcbSlipSection {
  const L = pcbBasisLabels(x.basis);
  const rows: PcbSlipRow[] = [];
  if (x.basis) rows.push({ line: '', caption: L.finalSystem, ns: 'pcbDetail', first: slipMoney(x.pcbSystem) });
  rows.push({
    line: '2',
    caption: x.basis ? L.finalDeducted : 'slipStep2Mtd',
    ns: 'pcbDetail',
    first: slipMoney(x.pcb),
  });
  return {
    heading: 'slipStep2Heading',
    firstColumn: 'slipColTotal',
    rows,
    note: x.basis ? L.note : 'slipStep2Note',
  };
}

/**
 * Official page 7 — CALCULATION RESULTS.
 *
 * The three figures the agency highlights, then the two figures its two closing notes are about. The
 * notes themselves are prose and live in `slipResultNote`: every caption in this namespace is resolved
 * with a bare `t()` and a stray brace throws at render, so nothing here interpolates.
 *
 *   · `slipResultProjected` is the agency's "MTD from <this month> to DECEMBER is RM x if there are no
 *     changes to the salary, deductions and rebates" — its figure is the current month's MTD, which is
 *     `mtdNormalCalc` and is already on this page. Printed rather than left in the sentence because the
 *     sentence cannot carry an argument.
 *   · `slipResultAnnualTax` is its "Total MTD / Annual Tax RM x" — the tax the bracket yields on P,
 *     `taxOnP1`, which the engine stored and which the specification's own worked example prints at the
 *     foot of page 6.
 *
 * Both are ABSENT rather than zero on a run that recorded no trace, like every other trace-fed row.
 */
export function pcbCalculationResultsSection(x: Extract<PcbExplanation, { kind: 'mtd' }>): PcbSlipSection {
  const t = x.trace;
  const L = pcbBasisLabels(x.basis);
  const rows: PcbSlipRow[] = [
    { line: '', caption: 'slipResultNetMtd', ns: 'pcbDetail', first: slipMoney(x.pcbNormal) },
    { line: '', caption: 'slipResultAdditional', ns: 'pcbDetail', first: slipMoney(x.pcbAdditional) },
  ];
  if (x.basis) rows.push({ line: '', caption: L.finalSystem, ns: 'pcbDetail', first: slipMoney(x.pcbSystem) });
  rows.push({
    line: '',
    caption: x.basis ? L.finalDeducted : 'slipResultFinal',
    ns: 'pcbDetail',
    first: slipMoney(x.pcb),
  });
  rows.push({
    line: '',
    caption: 'slipResultProjected',
    ns: 'pcbDetail',
    first: t ? slipMoney(t.mtdNormalCalc) : SLIP_ABSENT,
  });
  rows.push({
    line: '',
    caption: 'slipResultAnnualTax',
    ns: 'pcbDetail',
    first: t ? slipMoney(t.taxOnP1) : SLIP_ABSENT,
  });
  return { heading: 'slipResultHeading', firstColumn: 'slipColTotal', rows, note: 'slipResultNote' };
}

/**
 * The closing trio, in the official's order.
 *
 * ONE LIST, TWO SURFACES. The screen and the downloaded document both reach these through
 * `pcbDetailLayout`, so neither can carry a band the other does not and neither can put them in a
 * different order — the identical device, and the identical reason, as `pcbFormulaBlocks` for the
 * substituted expressions. r372 — the agency prints its two numbered items UNDER its "MTD CALCULATION"
 * heading, so the layout places them as the closing steps of the reporter's sequence 9, and CALCULATION
 * RESULTS as his sequence 10.
 *
 * Empty for a flat-rate payee and for a payslip with no recorded working: there is no monthly MTD
 * calculation to number the steps of, and three bands of "not recorded" would assert that one exists
 * and merely went unsaved. `flatWorksheet` and the screen's own unavailable card already say what is
 * true for those two, in sentences.
 */
export function pcbClosingSections(x: PcbExplanation): PcbSlipSection[] {
  if (x.kind !== 'mtd') return [];
  return [pcbMtdStep1Section(x), pcbMtdStep2Section(x), pcbCalculationResultsSection(x)];
}

/**
 * ad7bc503 — THE TWO STATIC CAPTION MAPS THIS SURFACE RESOLVES, IN ONE PLACE.
 *
 * They were private to `app/payroll/pcb-detail/pcb-detail-view.tsx`, and that is why the DOWNLOADED
 * document carried neither the payroll cycle nor the marital tax status the reporter's section 1 asks for:
 * the only copy of each map was inside a React component. They are mappings from a stored value to a
 * message key — the same kind of thing as every caption on the worksheet above — so they live here and both
 * surfaces read one copy.
 *
 * ⚠️ EXHAUSTIVE AND STATIC-KEYED, on purpose. A computed `t()` key is invisible to the i18n coverage scan,
 * so every value is a literal and every literal is pinned in all six catalogues by test/pcb-detail.test.ts.
 */
export const CYCLE_LABEL: Record<string, 'cycleRegular' | 'cycleOffCycle' | 'cycleBonus' | 'cycleAdjustment'> = {
  regular: 'cycleRegular',
  off_cycle: 'cycleOffCycle',
  bonus: 'cycleBonus',
  adjustment: 'cycleAdjustment',
};

/** The s.48 tax category, which IS the marital tax status: 1 single, 2 married with a spouse not working,
 *  3 married with a spouse working. One stored fact, printed under both of the agency's headings. */
export const CATEGORY_LABEL: Record<number, 'category1' | 'category2' | 'category3'> = {
  1: 'category1',
  2: 'category2',
  3: 'category3',
};

// ═════════════════ r372 — ONE ORDERED SECTION LIST, AND BOTH SURFACES ITERATE IT ═════════════════
//
// WHAT WAS WRONG, AND IT WAS NOT A MISSING SECTION. Every FIGURE on this surface already had one source:
// `page.tsx` and `pcbDetailModel` in app/payroll/pcb-detail/shared.ts call `explainPcb`, `pcbWorksheet`,
// `pcbSlipSections` and `pcbClosingSections` with identical arguments over one payslip's own stamp. The
// LAYOUT did not. The screen's order was hand-placed JSX in `pcb-detail-view.tsx`; the document's was
// imperative `sections.push` in shared.ts — TWO independent orderings of one document. They had already
// drifted: five whole sections the screen carried were absent from the paper, three headings were emitted
// twice there, and the payroll month printed as "2026-06" on one and "June 2026" on the other. The
// reporter's criteria 19, 20 and 21 were false, and no test could see it, because each surface was
// asserted against its own expectations.
//
// SO THE ORDER ITSELF BECOMES PART OF THE MODEL. `pcbDetailLayout` is the single ordered list of what this
// document contains, in what order, under which number. Both surfaces iterate it and neither owns an order
// of its own, so a section added, moved or renumbered moves on BOTH or compiles on NEITHER: `slot` is a
// closed union and each surface switches over it exhaustively. That is the anti-drift device this file
// already uses for `pcbClosingSections` and `pcbFormulaBlocks`, applied to the thing that was still
// written out twice.
//
// ⚠️ IT DECIDES NOTHING ABOUT A FIGURE. There is no arithmetic here and no value: an entry carries a
// number, a heading key, a band and either a `PcbSlipSection` already built above or the name of a body
// the surface paints. The guard in test/7f251381-pcb-lhdn-worksheet.test.ts that refuses an operator
// anywhere below its marker covers this block too.

/**
 * Where an entry sits in the document.
 *
 *   · `banner`   — said BEFORE any working, and outside the numbered run: which figure this document is
 *                  about when the working does not explain the deduction, and whether a working exists.
 *   · `sequence` — one of the reporter's ten numbered sequences.
 *   · `step`     — a step of sequence 9. The first of a run carries the sub-number; a continuation
 *                  carries none, because the agency's own step covers more of our boxes than one.
 *   · `card`     — a state rather than a section: no working recorded, or a flat-rate payee.
 *   · `appendix` — present for reference, deliberately NOT in the numbered run.
 *   · `footer`   — where these figures came from. Also not numbered.
 */
export type PcbDetailBand = 'banner' | 'sequence' | 'step' | 'card' | 'appendix' | 'footer';

/**
 * A body neither surface can build from a `PcbSlipSection`: identification rows, a banner, a formula
 * block. The union is CLOSED and both surfaces switch over it exhaustively, which is what makes "a
 * section cannot reach one surface and not the other" a compile error rather than a review note.
 */
export type PcbDetailBodySlot =
  | 'identification'
  | 'basisBanner'
  | 'traceBanner'
  | 'unavailableCard'
  | 'flatCard'
  | 'mtdBand'
  | 'mtdCategory'
  | 'mtdReliefs'
  | 'mtdK2'
  | 'mtdP'
  | 'mtdFormula'
  | 'mtdBracket'
  | 'mtdPrior'
  | 'mtdFloor'
  | 'mtdNet'
  | 'mtdSummary'
  | 'mtdYear'
  | 'mtdAdditional'
  | 'mtdSteps'
  | 'lhdnWorksheet'
  | 'source';

/** One section of the document, in its place. `label` is the printed number, or null where none is. */
export type PcbDetailEntry =
  | { kind: 'body'; slot: PcbDetailBodySlot; label: string | null; band: PcbDetailBand; heading: string }
  | { kind: 'section'; label: string | null; band: PcbDetailBand; heading: string; section: PcbSlipSection };

/**
 * The reporter's sequences 2 to 8, keyed by the heading the builder above gives each one.
 *
 * BY HEADING AND NOT BY INDEX, deliberately. `pcbSlipSections` returns them in this order today; reading
 * them positionally would mean a reordering there silently renumbering a tax document. A section whose
 * heading is not on this list is still rendered — unnumbered, after the eight — because dropping one
 * would be the worse failure.
 */
const PCB_SEQUENCE_OF_SECTION: readonly (readonly [string, string])[] = [
  ['slipChildHeading', '2'],
  ['slipAccHeading', '3'],
  ['slipPrevDeductionHeading', '4'],
  ['slipCurrentHeading', '5'],
  ['slipAdditionalRemHeading', '6'],
  ['slipCurrentDeductionHeading', '7'],
  ['slipRebateHeading', '8'],
];

/**
 * SEQUENCE 9, IN THE ORDER THE SPECIFICATION SETS ITS OWN STEPS OUT, not in the order this screen grew.
 *
 * The specification's worked examples (printed pp. 44-46) run: [A] category, then [B] chargeable income
 * for the year — inside which it says "Firstly determine value K2" and only then substitutes P — then [C]
 * the monthly deduction with M, R and B read off Table 1, then [D] the net deduction, then [E] the year's
 * total, then Steps 2 to 5 for additional remuneration. The reporter's own 9.1 to 9.9 is that sequence,
 * and this list is it.
 *
 * ⚠️ NINE NUMBERS OVER MORE THAN NINE BOXES. The agency's [C] covers four of ours — the formula, the
 * Table 1 row it read M, R and B from, the accumulators Z and X it subtracts, and §E's floors — and its
 * [D] covers two. A continuation therefore carries `label: null` and keeps its own heading: repeating
 * "9.5" over four consecutive cards would defeat the one thing the numbering is for, which is being able
 * to point at a step.
 *
 * ⚠️ AND THE ORDER OF THE FOURTEEN CHANGED, WHICH IS THE REQUEST. Tax relief and the remuneration legs
 * used to sit BELOW the P formula that consumes them, and the calculation summary above everything. The
 * figures are untouched; only where they are read has moved.
 */
const PCB_MTD_STEPS: readonly {
  readonly label: string | null;
  readonly slot: PcbDetailBodySlot;
  readonly heading: string;
}[] = [
  { label: '9.1', slot: 'mtdCategory', heading: 'stepAHeading' },
  { label: '9.2', slot: 'mtdReliefs', heading: 'reliefsHeading' },
  { label: '9.3', slot: 'mtdK2', heading: 'k2Heading' },
  { label: '9.4', slot: 'mtdP', heading: 'pHeading' },
  { label: '9.5', slot: 'mtdFormula', heading: 'formulaHeading' },
  { label: null, slot: 'mtdBracket', heading: 'bracketHeading' },
  { label: null, slot: 'mtdPrior', heading: 'priorHeading' },
  { label: null, slot: 'mtdFloor', heading: 'floorHeading' },
  { label: '9.6', slot: 'mtdNet', heading: 'netHeading' },
  { label: null, slot: 'mtdSummary', heading: 'summaryHeading' },
  { label: '9.7', slot: 'mtdYear', heading: 'yearHeading' },
  { label: '9.8', slot: 'mtdAdditional', heading: 'additionalHeading' },
  { label: '9.9', slot: 'mtdSteps', heading: 'stepsHeading' },
];

/**
 * The closing trio's place. The agency's own two numbered items are the LAST steps of sequence 9 — they
 * are printed under its "MTD CALCULATION" heading on the slip — and CALCULATION RESULTS is the reporter's
 * sequence 10, which is where the whole document lands.
 */
const PCB_CLOSING_PLACE: Readonly<Record<string, { readonly label: string | null; readonly band: PcbDetailBand }>> = {
  slipStep1Heading: { label: null, band: 'step' },
  slipStep2Heading: { label: null, band: 'step' },
  slipResultHeading: { label: '10', band: 'sequence' },
};

/**
 * THE ORDER OF THE WHOLE DOCUMENT, ONCE.
 *
 * @param p the model both surfaces already hold: what `explainPcb` read, LHDN's worksheet, the reporter's
 *          detail sections and the agency's closing trio. Nothing is read or computed here.
 */
export function pcbDetailLayout(p: {
  explanation: PcbExplanation;
  worksheet: PcbWorksheet | null;
  slip: readonly PcbSlipSection[];
  closing: readonly PcbSlipSection[];
}): PcbDetailEntry[] {
  const x = p.explanation;
  const out: PcbDetailEntry[] = [];
  const body = (slot: PcbDetailBodySlot, label: string | null, band: PcbDetailBand, heading: string) => {
    out.push({ kind: 'body', slot, label, band, heading });
  };

  // The two sentences a reader needs BEFORE a single figure, above the numbered run on both surfaces.
  if (x.basis != null) body('basisBanner', null, 'banner', pcbBasisLabels(x.basis).bannerHeading);
  if (x.kind === 'mtd' && x.trace == null) body('traceBanner', null, 'banner', 'traceNotRecordedHeading');

  body('identification', '1', 'sequence', 'identificationHeading');

  const pending = new Map<string, PcbSlipSection>();
  for (const sec of p.slip) pending.set(sec.heading, sec);
  for (const [heading, label] of PCB_SEQUENCE_OF_SECTION) {
    const sec = pending.get(heading);
    if (sec === undefined) continue;
    pending.delete(heading);
    out.push({ kind: 'section', label, band: 'sequence', heading, section: sec });
  }
  for (const sec of pending.values()) {
    out.push({ kind: 'section', label: null, band: 'card', heading: sec.heading, section: sec });
  }

  if (x.kind === 'unavailable'||x.kind==='not_subject') body('unavailableCard', null, 'card', 'summaryHeading');
  if (x.kind === 'flat') body('flatCard', null, 'card', 'flatHeading');
  if (x.kind === 'mtd') {
    body('mtdBand', '9', 'sequence', 'mtdCalculationHeading');
    for (const s of PCB_MTD_STEPS) body(s.slot, s.label, 'step', s.heading);
  }

  for (const sec of p.closing) {
    const place = PCB_CLOSING_PLACE[sec.heading];
    out.push({
      kind: 'section',
      label: place === undefined ? null : place.label,
      band: place === undefined ? 'card' : place.band,
      heading: sec.heading,
      section: sec,
    });
  }

  // LHDN's own worksheet order: the same recorded figures again, which is why it is an APPENDIX and no
  // longer positions 2 to 8 of the numbered run. It duplicated every figure shown below it and pushed the
  // reporter's sequence 2 down to eighth place on the page.
  if (p.worksheet != null && p.worksheet.shape !== 'unavailable') {
    body('lhdnWorksheet', null, 'appendix', p.worksheet.shape === 'flat' ? 'worksheetFlatHeading' : 'worksheetHeading');
  }
  body('source', null, 'footer', 'sourceHeading');
  return out;
}

/** Only the recorded attempt can identify a historical circumstance. Never today's person profile. */
export function pcbTaxCategoryIdentity(x:PcbExplanation){
 const saved=x.taxCircumstance;
 if(saved){const resolved=taxCircumstanceOf(saved.key,saved.category??1);return {category:saved.category,labelKey:resolved.labelKey,applicable:saved.applicable};}
 const raw=x.kind==='mtd'?x.trace?.category??null:null;
 const category=raw!==null&&[1,2,3].includes(raw)?raw:null;
 return {category,labelKey:category===null?null:taxCircumstanceOf(null,category).labelKey,applicable:true};
}
