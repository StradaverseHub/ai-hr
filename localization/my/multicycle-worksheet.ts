/**
 * ADR-0024 §7 — THE ACCOUNTANT SIGN-OFF WORKSHEET, as a read-only replay over real payroll history.
 *
 * WHAT THIS IS FOR. ADR-0024 §5 gates changing live statutory aggregation on an accountant signing off
 * the §7 worksheet. Until now that worksheet was a single hand-written scenario in the ADR (RM5,000 +
 * RM10,000) whose figures come out IDENTICAL under both readings of the statute — so it cannot tell the
 * two apart and cannot answer the question the customer actually asked: *on my own data, how often does
 * this change anything, and by how much?* This module answers that question from the payslips that were
 * really written.
 *
 * IT WRITES NOTHING. No payslip is recomputed, no batch is touched, no row is inserted or updated. Every
 * figure below is either read off a stored payslip or computed in memory from one. A worksheet that could
 * move money would defeat its own purpose: it exists to be read BEFORE anything is switched on.
 *
 * THE THREE READINGS, per (company, month, employee) that had more than one run:
 *
 *   PAID   the sum of the statutory figures actually stored on that month's payslips. Ground truth —
 *          no model, no assumption, this is what the employee's payslips said and what was remitted.
 *   RUNS   the "each run on its own" reading: every run re-enters the EPF Third Schedule and the SOCSO/
 *          EIS bands from the bottom on its own slice of the month. This is the reading the customer
 *          feared, and it is the one that double-charges SOCSO/EIS.
 *   MONTH  the "statutory month is ONE computation" reading — `computeMonthlyRuns` (ADR-0024 §4): the
 *          cumulative month is recomputed after each run and the run's contribution is the increment.
 *
 * WHY ALL THREE, AND NOT JUST TWO. A replay of history has to reconstruct inputs, and a reconstruction
 * that is subtly wrong would show a difference that is not there. Carrying PAID alongside both models
 * turns that risk into a VISIBLE CLASSIFICATION rather than a silent error: if PAID matches MONTH the
 * month is already aggregated and nothing would change; if PAID matches RUNS the difference is real and
 * is the movement this worksheet is measuring; if PAID matches NEITHER the replay cannot explain that
 * month and it is reported as unexplained instead of being counted. Only the "matches RUNS" rows
 * contribute to the ringgit totals, so the headline figure is one the arithmetic can defend.
 *
 * WHAT IS EXCLUDED RATHER THAN CLAMPED. ADR-0024 §6 puts reversals out of scope and `computeMonthlyRuns`
 * clamps a negative delta at zero. A month containing a negative amount or a decreasing additional-
 * remuneration base would therefore be silently understated, so it is EXCLUDED with a reason instead.
 * Likewise a month whose inputs cannot be reconstructed (a payslip written before the charged bases were
 * recorded, a first run that is not the regular run, a hand-set statutory adjustment, a zakat/TP1 month
 * the incremental model cannot express) is FLAGGED with its reason and left out of the totals. The counts
 * of both are part of the answer.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../../db/client';
import {
  company,
  employeeStatutoryMy,
  employment,
  payPeriod,
  payrollBatch,
  payrollStatutoryAdjustment,
  payslip,
  person,
} from '../../db/schema';
import {
  childReliefAmountFor,
  epf,
  foldPriorSlipIntoAccumulators,
  openingAccumulatorsFromTp3,
  statutory,
  type EpfMode,
  type PcbAccumulators,
  type TaxProfile,
} from './payroll';
import { explainPcb } from '../../core/pcb-explain';
import { pricesChildReliefFromGrid } from '../../core/dependents';
import { computeMonthlyRuns, type MonthRunInput, type RunType } from './multicycle';
import { getActiveStatutoryMY } from './statutory-config';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from './statutory-tables';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The eight statutory figures the worksheet compares. Employer and employee legs are kept apart — they
 * are remitted on different lines of different returns and an accountant checks them separately.
 *
 * THE LIST IS THE KERNEL'S, NOT A SELECTION. It must be exactly the contribution fields the kernel
 * treats as multi-cycle deltas (core/payroll.ts `DELTA_KEYS`, less `pcbBonus`, which is a component OF
 * `pcb` and not a separate remittance). `socsoSkbbk` — Lindung 24 Jam, the EMPLOYEE-deducted leg that
 * rides the SOCSO bands — belongs here for that reason and not as a nicety: at RM5,001 it is RM37.85 a
 * month, LARGER than the RM25.25 SOCSO employee share beside it, it is charged twice under the per-run
 * reading and once under month-as-one, and core/payroll.ts subtracts it from net pay alongside the
 * other employee legs. Leaving it out understated the employee-side SOCSO family by ~60% on the very
 * document an accountant is being asked to sign.
 */
export const WORKSHEET_ITEMS = [
  'epfEmployee',
  'epfEmployer',
  'socsoEmployee',
  'socsoEmployer',
  'socsoSkbbk',
  'eisEmployee',
  'eisEmployer',
  'pcb',
] as const;
export type WorksheetItem = (typeof WORKSHEET_ITEMS)[number];
export type Figures = Record<WorksheetItem, number>;

const ZERO: Figures = { epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0, socsoEmployer: 0, socsoSkbbk: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0 };
const add = (a: Figures, b: Figures): Figures =>
  Object.fromEntries(WORKSHEET_ITEMS.map((k) => [k, round2(a[k] + b[k])])) as Figures;
const sub = (a: Figures, b: Figures): Figures =>
  Object.fromEntries(WORKSHEET_ITEMS.map((k) => [k, round2(a[k] - b[k])])) as Figures;
const isZero = (f: Figures) => WORKSHEET_ITEMS.every((k) => Math.abs(f[k]) < 0.005);

/**
 * Why an employee-month is not counted. Every one of these is a REFUSAL to guess, not a failure.
 *
 * A RUNTIME LIST, not a bare union, because the screen builds its label key as `reason.${reason}` and a
 * type alone cannot be enumerated by the guard that checks those keys exist in all six catalogs. Adding a
 * reason here without a message fails that guard rather than rendering the raw key on an accountant's
 * sign-off document.
 */
export const WORKSHEET_SKIP_REASONS = [
  /** A negative payslip amount — a reversal or clawback. ADR-0024 §6 puts these out of scope. */
  'negative_amount',
  /** The additional-remuneration base went DOWN between runs: a negative delta the model would clamp. */
  'negative_delta',
  /** A run in this month is marked as needing recalculation — its stored figures are known to be stale. */
  'needs_recalc',
  /** A payslip predates the charged-bases stamp, so what each agency was charged on is not recorded. */
  'bases_not_recorded',
  /**
   * run_seq 1 is not the regular run.
   *
   * ⚠️ r337 — THIS IS NO LONGER AN ODDITY, IT IS A SUPPORTED WORKFLOW. ADR-0024 §6's requirement that
   * the regular run lead the month was lifted for item 23e7dac3, so a customer may legitimately process
   * a bonus or an advance salary first. This worksheet still EXCLUDES such a month rather than
   * comparing it, and that is deliberate: `computeMonthlyRuns`, the model it replays history against,
   * is documented `runs[0] = regular` and was signed off that way, so a comparison of an out-of-order
   * month would be measuring this module's assumption rather than the customer's figures. The month is
   * reported with its reason and left out of the totals, which is the honest answer. Teaching the
   * replay the restating rule is a separate round; ADR-0085 §7 is where an out-of-order month's figures
   * are traced in the meantime.
   */
  'first_run_not_regular',
  /** A statutory figure on this month was set by hand, so no computation explains it. */
  'manual_statutory_adjustment',
  /** The EPF/SOCSO/PCB bases disagree by a pay-item carve-out, so one wage figure cannot serve all three. */
  'base_carve_outs',
  /** The runs of this month were charged on DIFFERENT normal wages — a mid-month change the model cannot express. */
  'inconsistent_run_bases',
  /** Zakat — deducted from salary OR claimed back through TP1 Section D — or a TP1 optional deduction
   *  rode this month; the run inputs alone do not reproduce its MTD. */
  'zakat_or_lp_present',
  /** No Malaysian statutory profile for this person, so the tax category and scheme eligibility are unknown. */
  'no_statutory_profile',
  /** Saved scheme provenance is missing, legacy flat incentive, malformed or differs between runs. */
  'tax_scheme_not_reconstructable',
] as const;
export type WorksheetSkipReason = (typeof WORKSHEET_SKIP_REASONS)[number];

/** How the paid figures relate to the two readings — the worksheet's self-check. Runtime list for the
 *  same reason as above: the screen keys its label off the value. */
export const WORKSHEET_VERDICTS = [
  /** Both readings give what was paid: this month cannot distinguish them, and nothing would change. */
  'agree',
  /** Paid matches the month-as-one reading already. Nothing would change. */
  'already_aggregated',
  /** Paid matches the per-run reading. THIS is a month the change would move. */
  'would_change',
  /** Paid matches neither reading. Reported, never counted. */
  'unexplained',
  /**
   * ── Item 70b14723 — THE EPF FIGURE WAS TYPED BY A PERSON, AND THE REPLAY REPRODUCES IT ──────────────
   *
   * This employee is on a MANUAL EPF AMOUNT (`employee_statutory_my.epf_mode = 'manual_amount'`), so their
   * month's EPF is a ringgit figure somebody entered on their record, not a Third Schedule reading. The
   * replay is told that figure — `statutoryOptsOf` carries it, exactly as it carries the elected rates —
   * so the month RECONCILES; without it every such employee-month matched neither reading and printed
   * `unexplained` with a fabricated ringgit difference, near the top of a document an accountant signs.
   *
   * IT IS ITS OWN VERDICT RATHER THAN `already_aggregated`, and that distinction is the point. Both mean
   * "nothing would change", but an accountant reading "Already computed as one month" is entitled to
   * conclude the CONTRIBUTION SCHEDULE produced the figure, and here it did not. A replay that silently
   * reproduces a number it was handed is not evidence that any statute was followed.
   *
   * IT NEVER MASKS `would_change` OR `unexplained`. It replaces only the two reconciling outcomes — see
   * the verdict expression in `compareEmployeeMonth` — so a month that really would move, or that the
   * replay really cannot explain, keeps saying so and keeps its place in the ringgit totals.
   */
  'manual_epf_amount',
] as const;
export type WorksheetVerdict = (typeof WORKSHEET_VERDICTS)[number];

export type WorksheetRunView = {
  runSeq: number;
  runType: RunType;
  /** Normal remuneration this run carried (the EPF wage base it was charged on). */
  normal: number;
  /** Additional remuneration (bonus / off-cycle) this run itself paid. */
  additional: number;
  /** Overtime riding the SOCSO/EIS/PCB base. */
  overtime: number;
  paid: Figures;
  perRun: Figures;
  monthAsOne: Figures;
};

export type WorksheetRow = {
  companyId: string;
  companyName: string;
  period: string;
  employmentId: string;
  employeeCode: string | null;
  employeeName: string;
  runCount: number;
  paid: Figures;
  perRun: Figures;
  monthAsOne: Figures;
  /** monthAsOne − paid: what the statutory figures would move by if the change were switched on. */
  difference: Figures;
  verdict: WorksheetVerdict;
  runs: WorksheetRunView[];
  /** The ruleset version the replay used, and the one the payslips were written under. */
  replayVersion: string;
  paidVersion: string | null;
};

export type WorksheetSkip = {
  companyId: string;
  companyName: string;
  period: string;
  employmentId: string;
  employeeCode: string | null;
  employeeName: string;
  reason: WorksheetSkipReason;
  /** True for the hard exclusions (§6 reversals), false for "we could not reconstruct this". */
  excluded: boolean;
};

/** A fixed, self-computing illustration of the arithmetic — so the page can show the working even for a
 *  customer whose own history has no multi-run month yet. The figures come from the live pack, never
 *  from a literal in the page, so they cannot drift away from the tables in force. */
export type WorksheetIllustration = {
  normalWage: number;
  secondRun: number;
  epfNormalOnly: { employee: number; employer: number };
  epfSecondRunAlone: { employee: number; employer: number };
  epfMonthCombined: { employee: number; employer: number };
  perRunTotal: { employee: number; employer: number };
  monthAsOneTotal: { employee: number; employer: number };
  version: string;
};

export type MultiCycleWorksheet = {
  /** Distinct (company, month) that had more than one payroll run. */
  periodsWithMultipleRuns: number;
  /** Employee-months inside those periods with a payslip in more than one run. */
  employeeMonthsExamined: number;
  employeeMonthsExcluded: number;
  employeeMonthsFlagged: number;
  employeeMonthsCompared: number;
  /** Of the compared months, how many each verdict. `wouldChange` is the number the customer asked for. */
  verdicts: Record<WorksheetVerdict, number>;
  /** Totals over the compared months (all verdicts). */
  totals: { paid: Figures; perRun: Figures; monthAsOne: Figures };
  /** Total ringgit movement, over the `would_change` months only. */
  movement: Figures;
  rows: WorksheetRow[];
  skips: WorksheetSkip[];
  /** Reason → count, so the page can say why months were left out without listing every one. */
  skipCounts: Record<string, number>;
  illustration: WorksheetIllustration;
  replayVersion: string;
  /** True when `rows` was capped for display; the totals above always cover everything. */
  truncated: boolean;
};

/** How many detail rows the page renders. The totals are never capped. */
const ROW_CAP = 200;

type StatBlob = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const figuresOf = (st: StatBlob): Figures =>
  Object.fromEntries(WORKSHEET_ITEMS.map((k) => [k, round2(num(st[k]))])) as Figures;

type Bases = { epf: number; epfAdditional: number; socsoEis: number; pcb: number };
function basesOf(st: StatBlob): Bases | null {
  const b = st.bases;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const r = b as Record<string, unknown>;
  if (r.epf === undefined || r.socsoEis === undefined || r.pcb === undefined) return null;
  return {
    epf: round2(num(r.epf)),
    epfAdditional: round2(num(r.epfAdditional)),
    socsoEis: round2(num(r.socsoEis)),
    pcb: round2(num(r.pcb)),
  };
}

type SlipRow = {
  companyId: string;
  companyName: string;
  period: string;
  batchId: string;
  runSeq: number;
  runType: RunType;
  needsRecalc: boolean;
  employmentId: string;
  employeeCode: string | null;
  employeeName: string;
  basic: number;
  allowance: number;
  overtime: number;
  bonus: number;
  gross: number;
  net: number;
  statutory: StatBlob;
};

type ProfileRow = {
  taxCategory: number;
  numChildren: number;
  childReliefMode: string;
  childReliefTable: unknown;
  disabledIndividual: boolean;
  disabledSpouse: boolean;
  isResident: boolean;
  taxResidency: string;
  socsoCategory: string;
  eisCategory: string;
  eisEligible: boolean;
  subjectToSocso: boolean;
  subjectToSkbbk: boolean;
  epfCitizenship: 'citizen' | 'pr' | 'non_citizen';
  /** The lawful EPF enum, taken from the PACK's own type rather than restated — item 70b14723 added a
   *  fourth label and a local copy of the list is how a replay silently models a manual employee as auto. */
  epfMode: EpfMode;
  epfEmployeeRate: number | null;
  epfEmployerRate: number | null;
  /** Item 70b14723 — the typed monthly EPF amounts (RM), null when that side keeps the rule. */
  epfEmployeeAmount: number | null;
  epfEmployerAmount: number | null;
  tp3Year: number | null;
  tp3Net: number | null;
  tp3Epf: number | null;
  tp3Pcb: number | null;
  tp3Zakat: number | null;
  dateOfBirth: string | null;
};

/**
 * The §7 worksheet over `companyIds`' payroll history.
 *
 * `year` narrows to one tax year ('2026'); omitted, every year on file is replayed. The PCB replay needs
 * the whole tax year regardless — the accumulators are derived from the year's earlier payslips exactly
 * as the kernel derives them (ADR-0014: the payslip history is the ledger, there is no stored balance).
 */
export async function multiCycleWorksheetMY(
  ctx: SessionContext,
  p: { companyIds: string[]; year?: string },
): Promise<MultiCycleWorksheet> {
  return withTenant(ctx, async (tx) => {
    const rules = await activeRules(tx);
    const empty = emptyWorksheet(rules);
    if (!p.companyIds.length) return empty;

    // 1. The (company, month) periods that had MORE THAN ONE run. Everything else is out of scope by
    //    definition: one run a month is what the system did before multi-cycle existed.
    const batches = await tx
      .select({
        companyId: payrollBatch.companyId,
        period: payrollBatch.payPeriod,
        payPeriodId: payrollBatch.payPeriodId,
        batchId: payrollBatch.id,
        runSeq: payrollBatch.runSeq,
        runType: payrollBatch.runType,
        status: payrollBatch.status,
        needsRecalcAt: payrollBatch.needsRecalcAt,
      })
      .from(payrollBatch)
      .innerJoin(payPeriod, eq(payPeriod.id, payrollBatch.payPeriodId))
      .where(
        p.year
          ? and(inArray(payrollBatch.companyId, p.companyIds), like(payrollBatch.payPeriod, `${p.year}-%`))
          : inArray(payrollBatch.companyId, p.companyIds),
      );
    const live = batches.filter((b) => b.status === 'processed' || b.status === 'closed');
    const byPeriod = new Map<string, typeof live>();
    for (const b of live) {
      const key = `${b.companyId}|${b.period}`;
      byPeriod.set(key, [...(byPeriod.get(key) ?? []), b]);
    }
    const multi = [...byPeriod.entries()].filter(([, bs]) => bs.length > 1);
    if (!multi.length) return empty;

    const batchIds = multi.flatMap(([, bs]) => bs.map((b) => b.batchId));
    const slips = await loadSlips(tx, batchIds);
    if (!slips.length) return { ...empty, periodsWithMultipleRuns: multi.length };

    // A hand-set statutory figure is not explained by any computation, so a month carrying one is
    // reported rather than compared.
    const adjusted = new Set(
      (
        await tx
          .select({ batchId: payrollStatutoryAdjustment.batchId, employmentId: payrollStatutoryAdjustment.employmentId })
          .from(payrollStatutoryAdjustment)
          .where(inArray(payrollStatutoryAdjustment.batchId, batchIds))
      ).map((a) => `${a.batchId}|${a.employmentId}`),
    );

    const employmentIds = [...new Set(slips.map((s) => s.employmentId))];
    const profiles = await loadProfiles(tx, employmentIds);
    const years = [...new Set(slips.map((s) => s.period.slice(0, 4)))];
    const priorAcc = await loadPriorAccumulators(tx, employmentIds, years, rules);

    // 2. Group into employee-months and replay each.
    const rows: WorksheetRow[] = [];
    const skips: WorksheetSkip[] = [];
    const groups = new Map<string, SlipRow[]>();
    for (const s of slips) {
      const key = `${s.companyId}|${s.period}|${s.employmentId}`;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    let examined = 0;
    for (const runs of groups.values()) {
      if (runs.length < 2) continue; // a single run this month — not a multi-cycle employee-month
      examined++;
      runs.sort((a, b) => a.runSeq - b.runSeq);
      const outcome = replayEmployeeMonth({
        runs,
        rules,
        profile: profiles.get(runs[0].employmentId),
        priorAcc: priorAcc.get(`${runs[0].employmentId}|${runs[0].period}`),
        adjusted,
      });
      if ('reason' in outcome) {
        const r = runs[0];
        skips.push({
          companyId: r.companyId,
          companyName: r.companyName,
          period: r.period,
          employmentId: r.employmentId,
          employeeCode: r.employeeCode,
          employeeName: r.employeeName,
          reason: outcome.reason,
          excluded: outcome.excluded,
        });
      } else {
        rows.push(outcome.row);
      }
    }

    // 3. Totals. Movement counts ONLY the months whose paid figures match the per-run reading — the
    //    months the change would actually move. A month already computed the aggregated way moves
    //    nothing, and an unexplained month is not evidence of anything.
    const verdicts: Record<WorksheetVerdict, number> = { agree: 0, already_aggregated: 0, would_change: 0, unexplained: 0, manual_epf_amount: 0 };
    let paid = ZERO;
    let perRun = ZERO;
    let monthAsOne = ZERO;
    let movement = ZERO;
    for (const r of rows) {
      verdicts[r.verdict]++;
      paid = add(paid, r.paid);
      perRun = add(perRun, r.perRun);
      monthAsOne = add(monthAsOne, r.monthAsOne);
      if (r.verdict === 'would_change') movement = add(movement, r.difference);
    }
    const skipCounts: Record<string, number> = {};
    for (const s of skips) skipCounts[s.reason] = (skipCounts[s.reason] ?? 0) + 1;

    // Differing months first — that is what the sign-off is looking at — then unexplained, then the rest.
    // …then unexplained, then the rest — item 70b14723's `manual_epf_amount` is one of "the rest": it is a
    // month that reconciles, so it does not belong above the ones that do not.
    const rank = (v: WorksheetVerdict) => (v === 'would_change' ? 0 : v === 'unexplained' ? 1 : 2);
    rows.sort(
      (a, b) =>
        rank(a.verdict) - rank(b.verdict) ||
        a.period.localeCompare(b.period) ||
        a.employeeName.localeCompare(b.employeeName),
    );

    return {
      periodsWithMultipleRuns: multi.length,
      employeeMonthsExamined: examined,
      employeeMonthsExcluded: skips.filter((s) => s.excluded).length,
      employeeMonthsFlagged: skips.filter((s) => !s.excluded).length,
      employeeMonthsCompared: rows.length,
      verdicts,
      totals: { paid, perRun, monthAsOne },
      movement,
      rows: rows.slice(0, ROW_CAP),
      skips: skips.slice(0, ROW_CAP),
      skipCounts,
      illustration: illustrationOf(rules),
      replayVersion: rules.version,
      truncated: rows.length > ROW_CAP || skips.length > ROW_CAP,
    };
  });
}

// ───────────────────────────────── the replay of one employee-month ─────────────────────────────────

type Replayed = { row: WorksheetRow } | { reason: WorksheetSkipReason; excluded: boolean };

function replayEmployeeMonth(p: {
  runs: SlipRow[];
  rules: StatutoryRuleset;
  profile: ProfileRow | undefined;
  priorAcc: PcbAccumulators | undefined;
  adjusted: Set<string>;
}): Replayed {
  const { runs, rules } = p;
  const first = runs[0];

  // ── Hard exclusions (ADR-0024 §6). A clamped month understates the difference, so it is not counted. ──
  for (const r of runs) {
    if (r.basic < 0 || r.allowance < 0 || r.overtime < 0 || r.bonus < 0 || r.gross < 0 || r.net < 0) {
      return { reason: 'negative_amount', excluded: true };
    }
    if (WORKSHEET_ITEMS.some((k) => num(r.statutory[k]) < 0)) return { reason: 'negative_amount', excluded: true };
    if (r.needsRecalc) return { reason: 'needs_recalc', excluded: true };
  }

  // ── Reconstructability. Each of these is a refusal to assume. ──
  if (runs.some((r) => p.adjusted.has(`${r.batchId}|${r.employmentId}`))) {
    return { reason: 'manual_statutory_adjustment', excluded: false };
  }
  if (first.runType !== 'regular') return { reason: 'first_run_not_regular', excluded: false };
  if (!p.profile) return { reason: 'no_statutory_profile', excluded: false };
  // r356 — `zakatRebateTp1` BELONGS IN THIS TEST AND WAS MISSING FROM IT. The month's TP1 Section D
  // zakat rebate offsets the month's MTD exactly as salary-deducted zakat does (spec rule 5, printed
  // p.19: the column is "Zakat AND DEPARTURE LEVY for current month"), but it is stamped SEPARATELY
  // because rule 15 keeps it off the payslip's zakat line. So a month whose only offset was a rebate has
  // `zakat` of 0, passed this test, and was then modelled with no offset at all — the very thing this
  // refusal exists to prevent. It has been reachable since r352 (72d1a390) introduced the stamp.
  if (runs.some((r) => num(r.statutory.zakat) !== 0 || num(r.statutory.zakatRebateTp1) !== 0 || num(r.statutory.lp) !== 0)) {
    return { reason: 'zakat_or_lp_present', excluded: false };
  }
  const bases = runs.map((r) => basesOf(r.statutory));
  if (bases.some((b) => b === null)) return { reason: 'bases_not_recorded', excluded: false };
  const b = bases as Bases[];
  // One wage figure has to serve EPF, SOCSO/EIS and PCB. When a pay-item carve-out makes the three
  // disagree there is no such figure, and inventing one would put a fabricated difference on a
  // worksheet an accountant is being asked to sign. (`bases.pcb` is the SOCSO/EIS base plus the
  // cumulative additional stream, so the identity below holds exactly when no carve-out is in play.)
  if (b.some((x) => Math.abs(round2(x.pcb - x.epfAdditional) - x.socsoEis) > 0.005)) {
    return { reason: 'base_carve_outs', excluded: false };
  }
  // Every run of the month stamps the SAME normal-wage and SOCSO/EIS bases (the kernel re-derives the
  // normal wage per run from compensation). When they differ, the month's normal remuneration changed
  // between runs — a mid-month increment or a scope change — and one monthly wage figure cannot stand
  // for both, so the month is reported instead of averaged.
  if (b.some((x) => Math.abs(x.epf - b[0].epf) > 0.005 || Math.abs(x.socsoEis - b[0].socsoEis) > 0.005)) {
    return { reason: 'inconsistent_run_bases', excluded: false };
  }

  // ── The month's inputs, read off the bases each agency was actually charged on. ──
  const normal = b[0].epf; //                            the month's normal remuneration (EPF wage base)
  const overtime = round2(Math.max(0, b[0].socsoEis - b[0].epf)); // overtime rides the SOCSO/EIS/PCB base
  // `bases.epfAdditional` is CUMULATIVE for the month on every run (core/payroll.ts stamps the cumulative
  // additional stream), so each run's own additional remuneration is the increment between consecutive runs.
  const ownAdditional: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const delta = round2(b[i].epfAdditional - (i === 0 ? 0 : b[i - 1].epfAdditional));
    if (delta < -0.005) return { reason: 'negative_delta', excluded: true };
    ownAdditional.push(Math.max(0, delta));
  }

  const profile = taxProfileOf(p.profile, rules);
  const opts = statutoryOptsOf(p.profile, first.period);
  // Today's profile or revoked approval cannot reinterpret paid history. The canonical recorded
  // reader validates incentive version, working and declaration provenance before replay is allowed.
  const recorded = runs.map(r => explainPcb(r.statutory, null));
  const schemes = recorded.map(x => x.kind === 'mtd'
    ? {scheme: x.calculationScheme ?? 'resident', declarationId: x.taxSchemeDeclarationId}
    : x.kind === 'flat' && x.nonResident && x.rate === 0.3
      ? {scheme: 'non_resident' as const, declarationId: undefined} : null);
  const saved = schemes[0];
  if (!saved || schemes.some(x => !x || x.scheme !== saved.scheme || x.declarationId !== saved.declarationId)) {
    return {reason: 'tax_scheme_not_reconstructable', excluded: false};
  }
  opts.calculationScheme = saved.scheme;
  opts.taxSchemeDeclarationId = saved.declarationId;
  const month = Number(first.period.slice(5, 7));
  const priorAcc = p.priorAcc;

  // ── Reading MONTH: the statutory month as ONE computation (ADR-0024 §4), through computeMonthlyRuns.
  // The regular run may itself have paid a bonus alongside salary; the incremental model expresses the
  // regular run as normal remuneration only, so that bonus is modelled as its own increment IMMEDIATELY
  // after it and the two are folded back together for the per-run view. The month's total is unaffected
  // either way (it depends only on the cumulative normal/additional/overtime), and the per-run view stays
  // 1:1 with the runs that were really written.
  const model: MonthRunInput[] = [];
  const foldInto: number[][] = [];
  for (let i = 0; i < runs.length; i++) {
    const mine: number[] = [];
    if (i === 0) {
      mine.push(model.push({ runType: 'regular', payment: normal, overtime }) - 1);
      if (ownAdditional[0] > 0) mine.push(model.push({ runType: 'adjustment', payment: ownAdditional[0] }) - 1);
    } else {
      mine.push(model.push({ runType: runs[i].runType, payment: ownAdditional[i] }) - 1);
    }
    foldInto.push(mine);
  }
  const modelled = computeMonthlyRuns({ month, profile, priorAcc, rules, opts, runs: model });
  const monthAsOnePerRun = foldInto.map((idx) =>
    idx.reduce((acc, j) => add(acc, figuresOf(modelled.runs[j] as unknown as StatBlob)), ZERO),
  );
  const monthAsOne = figuresOf(modelled.monthly as unknown as StatBlob);

  // ── Reading RUNS: every run computed on its own, re-entering the bands from the bottom.
  const perRunPerRun = runs.map((_r, i) => {
    const s =
      i === 0
        ? statutory(normal, profile, ownAdditional[0], overtime, { month, acc: priorAcc }, opts, rules)
        : statutory(ownAdditional[i], profile, 0, 0, { month, acc: priorAcc }, opts, rules);
    return figuresOf(s as unknown as StatBlob);
  });
  const perRun = perRunPerRun.reduce(add, ZERO);

  // ── Reading PAID: what the payslips say. No model at all.
  const paidPerRun = runs.map((r) => figuresOf(r.statutory));
  const paid = paidPerRun.reduce(add, ZERO);

  const matchesRuns = isZero(sub(perRun, paid));
  const matchesMonth = isZero(sub(monthAsOne, paid));
  // Item 70b14723 — a typed EPF amount refines the two RECONCILING outcomes and neither of the other two.
  // `would_change` is the figure the whole worksheet exists to count and `unexplained` is its honest
  // refusal; a manual amount is a statement about WHY the month reconciles, not a reason to stop counting.
  const epfTyped = opts.epfElection?.employeeAmount != null || opts.epfElection?.employerAmount != null;
  const verdict: WorksheetVerdict =
    matchesRuns && matchesMonth
      ? epfTyped
        ? 'manual_epf_amount'
        : 'agree'
      : matchesMonth
        ? epfTyped
          ? 'manual_epf_amount'
          : 'already_aggregated'
        : matchesRuns
          ? 'would_change'
          : 'unexplained';

  return {
    row: {
      companyId: first.companyId,
      companyName: first.companyName,
      period: first.period,
      employmentId: first.employmentId,
      employeeCode: first.employeeCode,
      employeeName: first.employeeName,
      runCount: runs.length,
      paid,
      perRun,
      monthAsOne,
      difference: sub(monthAsOne, paid),
      verdict,
      runs: runs.map((r, i) => ({
        runSeq: r.runSeq,
        runType: r.runType,
        normal: i === 0 ? normal : 0,
        additional: ownAdditional[i],
        overtime: i === 0 ? overtime : 0,
        paid: paidPerRun[i],
        perRun: perRunPerRun[i],
        monthAsOne: monthAsOnePerRun[i],
      })),
      replayVersion: rules.version,
      paidVersion: typeof first.statutory.version === 'string' ? first.statutory.version : null,
    },
  };
}

// ─────────────────────────────────────── input reconstruction ───────────────────────────────────────

function taxProfileOf(e: ProfileRow, rules: StatutoryRuleset): TaxProfile {
  return {
    category: (e.taxCategory ?? 1) as 1 | 2 | 3,
    children: e.numChildren ?? 0,
    disabled: e.disabledIndividual ?? false,
    disabledSpouse: e.disabledSpouse ?? false,
    childReliefAmount:
      // a5f21891 — 'auto' PRICES ITS GRID TOO, and all three gates widen together. The sync derives that
      // grid from the Family register (core/dependents.ts), so on 'auto' the categories decide the money
      // exactly as a keyed grid does on 'auto_table'. Widening one gate alone leaves the multicycle
      // worksheet printing a fabricated difference against the payslips it replays — which is what
      // test/child-relief-weighted-units-r343.test.ts (g) exists to catch.
      pricesChildReliefFromGrid(e)
        ? childReliefAmountFor(e.childReliefTable, rules.pcb.reliefs)
        : undefined,
  };
}

/**
 * Mirrors core/payroll.ts's derivation of the per-employee statutory options, term for term.
 *
 * THE AGE REFERENCE DATE IS THE PERIOD END, and that is load-bearing, not a detail. The kernel ages an
 * employee at `periodEnd` — the LAST day of the pay month (core/payroll.ts: `periodEnd` =
 * `${payPeriod}-${daysInMonth}`, read by its own `ageAt`). An employee whose 60th birthday falls on the
 * 29th, 30th or 31st is therefore 60 to the kernel and 59 to any replay that anchors earlier, and a
 * replay one year young models them on EPF Part A / SOCSO Category 1 / EIS-eligible figures against
 * payslips written on Part E / Category 2 / EIS-zero. That row would land in `rows` as `unexplained`
 * (it matches neither reading) and, because `unexplained` sorts second, print a fabricated ringgit
 * difference near the top of the sign-off document. Any change here must move with the kernel.
 */
function statutoryOptsOf(e: ProfileRow, period: string): NonNullable<Parameters<typeof statutory>[5]> {
  const age = ageAt(e.dateOfBirth, periodEndOf(period));
  const socsoCatSel = (e.socsoCategory ?? 'auto') as 'auto' | 'first' | 'second' | 'none';
  const eisCatSel = (e.eisCategory ?? 'auto') as 'auto' | 'none';
  const citizenship = e.epfCitizenship ?? 'citizen';
  const autoSocsoCategory = ((age != null && age >= 60) || citizenship === 'non_citizen' ? 2 : 1) as 1 | 2;
  return {
    socsoCategory: socsoCatSel === 'first' ? 1 : socsoCatSel === 'second' ? 2 : autoSocsoCategory,
    eisEligible:
      eisCatSel === 'none' ? false : (e.eisEligible ?? true) && (age == null || age < 60) && citizenship !== 'non_citizen',
    subjectToSocso: socsoCatSel === 'none' ? false : (e.subjectToSocso ?? true),
    subjectToSkbbk: e.subjectToSkbbk ?? true,
    resident: e.isResident ?? true,
    epfAge: age,
    epfCitizenship: citizenship,
    // Item 70b14723 — THE TYPED AMOUNTS TRAVEL WITH THE ELECTION. `localization/my/multicycle.ts` re-derives
    // every statutory figure from wages and never reads the payslip, so an amount left out here is an amount
    // the replay does not know about, and the month comes back matching neither reading. That is what made
    // this a surface rather than a nicety: the failure is silent and lands on a sign-off document.
    epfElection: {
      mode: e.epfMode ?? 'auto',
      employeeRate: e.epfEmployeeRate,
      employerRate: e.epfEmployerRate,
      employeeAmount: e.epfEmployeeAmount,
      employerAmount: e.epfEmployerAmount,
    },
  };
}

/** `YYYY-MM` → its LAST day, `YYYY-MM-DD`. `Date.UTC(y, m, 0)` is day zero of the month AFTER the
 *  1-based `m`, i.e. the last day of `m` itself — the same value core/payroll.ts builds with
 *  `daysInMonth(pYear, pMonth)`. A malformed period yields NaN, which `ageAt` reports as unknown age. */
function periodEndOf(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(dim).padStart(2, '0')}`;
}

function ageAt(dob: string | null, on: string): number | undefined {
  if (!dob) return undefined;
  const b = new Date(`${dob}T00:00:00Z`);
  const d = new Date(`${on}T00:00:00Z`);
  if (Number.isNaN(b.getTime()) || Number.isNaN(d.getTime())) return undefined;
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const m = d.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

// ─────────────────────────────────────────── loaders ───────────────────────────────────────────

async function activeRules(tx: Tx): Promise<StatutoryRuleset> {
  try {
    // ⚠️ `todayInKualaLumpur()`, never the UTC-instant form. This product runs at UTC+8, so a date taken
    // off the current instant in UTC names YESTERDAY between 00:00 and 08:00 MYT (item bb4f2265, guarded
    // by test/today-in-myt-drift.test.ts — which scans source WITHOUT stripping comments, so do not spell
    // the forbidden expression out here). It matters at this line specifically: this picks WHICH STATUTORY
    // RULESET the whole replay is priced with, so a worksheet generated before 8am on the day a new
    // ruleset takes effect would be built entirely on the superseded rates — on the very document an
    // accountant is being asked to sign.
    return await getActiveStatutoryMY(tx, { asOf: todayInKualaLumpur() });
  } catch {
    // A tenant with no ruleset row resolves the verified built-in — the same fallback the loader itself
    // makes. Reported through `replayVersion` so the page can name which tables the replay used.
    return DEFAULT_MY_STATUTORY;
  }
}

async function loadSlips(tx: Tx, batchIds: string[]): Promise<SlipRow[]> {
  const rows = await tx
    .select({
      companyId: payrollBatch.companyId,
      companyName: company.legalName,
      period: payrollBatch.payPeriod,
      batchId: payrollBatch.id,
      runSeq: payrollBatch.runSeq,
      runType: payrollBatch.runType,
      needsRecalcAt: payrollBatch.needsRecalcAt,
      employmentId: payslip.employmentId,
      employeeCode: employment.employeeCode,
      employeeName: person.fullName,
      basic: payslip.basicSalary,
      allowance: payslip.allowance,
      overtime: payslip.overtimePay,
      bonus: payslip.bonus,
      gross: payslip.grossPay,
      net: payslip.netPay,
      statutory: payslip.statutory,
    })
    .from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .innerJoin(company, eq(company.id, payrollBatch.companyId))
    .innerJoin(employment, eq(employment.id, payslip.employmentId))
    .innerJoin(person, eq(person.id, employment.personId))
    .where(inArray(payslip.batchId, batchIds));
  return rows.map((r) => ({
    companyId: r.companyId,
    companyName: r.companyName,
    period: r.period,
    batchId: r.batchId,
    runSeq: r.runSeq,
    runType: r.runType as RunType,
    needsRecalc: r.needsRecalcAt != null,
    employmentId: r.employmentId,
    employeeCode: r.employeeCode,
    employeeName: r.employeeName,
    basic: Number(r.basic),
    allowance: Number(r.allowance),
    overtime: Number(r.overtime),
    bonus: Number(r.bonus),
    gross: Number(r.gross),
    net: Number(r.net),
    statutory: (r.statutory ?? {}) as StatBlob,
  }));
}

async function loadProfiles(tx: Tx, employmentIds: string[]): Promise<Map<string, ProfileRow>> {
  const rows = await tx
    .select({
      employmentId: employment.id,
      dateOfBirth: person.dateOfBirth,
      taxCategory: employeeStatutoryMy.taxCategory,
      numChildren: employeeStatutoryMy.numChildren,
      childReliefMode: employeeStatutoryMy.childReliefMode,
      childReliefTable: employeeStatutoryMy.childReliefTable,
      disabledIndividual: employeeStatutoryMy.disabledIndividual,
      disabledSpouse: employeeStatutoryMy.disabledSpouse,
      isResident: employeeStatutoryMy.isResident,
      taxResidency: employeeStatutoryMy.taxResidency,
      socsoCategory: employeeStatutoryMy.socsoCategory,
      eisCategory: employeeStatutoryMy.eisCategory,
      eisEligible: employeeStatutoryMy.eisEligible,
      subjectToSocso: employeeStatutoryMy.subjectToSocso,
      subjectToSkbbk: employeeStatutoryMy.subjectToSkbbk,
      epfCitizenship: employeeStatutoryMy.epfCitizenship,
      epfMode: employeeStatutoryMy.epfMode,
      epfEmployeeRate: employeeStatutoryMy.epfEmployeeRate,
      epfEmployerRate: employeeStatutoryMy.epfEmployerRate,
      // Item 70b14723 — read, or the replay models a manual employee on the Third Schedule.
      epfEmployeeAmount: employeeStatutoryMy.epfEmployeeAmount,
      epfEmployerAmount: employeeStatutoryMy.epfEmployerAmount,
      tp3Year: employeeStatutoryMy.tp3Year,
      tp3Net: employeeStatutoryMy.tp3NetRemuneration,
      tp3Epf: employeeStatutoryMy.tp3EpfClaimed,
      tp3Pcb: employeeStatutoryMy.tp3PcbPaid,
      tp3Zakat: employeeStatutoryMy.tp3ZakatPaid,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .innerJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
    .where(inArray(employment.id, employmentIds));
  const out = new Map<string, ProfileRow>();
  for (const r of rows) {
    out.set(r.employmentId, {
      taxCategory: r.taxCategory,
      numChildren: r.numChildren,
      childReliefMode: r.childReliefMode,
      childReliefTable: r.childReliefTable,
      disabledIndividual: r.disabledIndividual,
      disabledSpouse: r.disabledSpouse,
      isResident: r.isResident,
      taxResidency: r.taxResidency,
      socsoCategory: r.socsoCategory,
      eisCategory: r.eisCategory,
      eisEligible: r.eisEligible,
      subjectToSocso: r.subjectToSocso,
      subjectToSkbbk: r.subjectToSkbbk,
      epfCitizenship: r.epfCitizenship,
      epfMode: r.epfMode,
      epfEmployeeRate: r.epfEmployeeRate == null ? null : Number(r.epfEmployeeRate),
      epfEmployerRate: r.epfEmployerRate == null ? null : Number(r.epfEmployerRate),
      epfEmployeeAmount: r.epfEmployeeAmount == null ? null : Number(r.epfEmployeeAmount),
      epfEmployerAmount: r.epfEmployerAmount == null ? null : Number(r.epfEmployerAmount),
      tp3Year: r.tp3Year,
      tp3Net: r.tp3Net == null ? null : Number(r.tp3Net),
      tp3Epf: r.tp3Epf == null ? null : Number(r.tp3Epf),
      tp3Pcb: r.tp3Pcb == null ? null : Number(r.tp3Pcb),
      tp3Zakat: r.tp3Zakat == null ? null : Number(r.tp3Zakat),
      dateOfBirth: r.dateOfBirth,
    });
  }
  return out;
}

/**
 * The PCB accumulators (∑(Y−K), K, X, Z, ∑LP) AT THE START OF each replayed month, keyed
 * `employmentId|YYYY-MM`, derived by replaying the tax year's EARLIER payslips exactly as
 * core/payroll.ts derives them (ADR-0014 — the payslip history is the ledger; there is no stored
 * accumulator to read). TP3 opening balances seed the year for a mid-year joiner, as the kernel does.
 *
 * Keyed per MONTH, not per year: the accumulator a March run reads is January + February, and a map
 * keyed by year would hand every month the same (empty) seed and silently mis-state every MTD figure.
 */
async function loadPriorAccumulators(
  tx: Tx,
  employmentIds: string[],
  years: string[],
  rules: StatutoryRuleset,
): Promise<Map<string, PcbAccumulators>> {
  const out = new Map<string, PcbAccumulators>();
  if (!employmentIds.length || !years.length) return out;
  const cap = rules.pcb.reliefs.epfReliefCap;
  const rows = await tx
    .select({
      employmentId: payslip.employmentId,
      period: payrollBatch.payPeriod,
      gross: payslip.grossPay,
      statutory: payslip.statutory,
      tp3Year: employeeStatutoryMy.tp3Year,
      tp3Net: employeeStatutoryMy.tp3NetRemuneration,
      tp3Epf: employeeStatutoryMy.tp3EpfClaimed,
      tp3Pcb: employeeStatutoryMy.tp3PcbPaid,
      tp3Zakat: employeeStatutoryMy.tp3ZakatPaid,
      // r356 — ∑LP was never SELECTED here, so the seed below could not have carried it even in
      // principle. Item 20837372 added the column and taught the kernel to seed from it; this replay
      // kept a hard 0.
      tp3Lp: employeeStatutoryMy.tp3Lp,
    })
    .from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .innerJoin(employment, eq(employment.id, payslip.employmentId))
    .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
    .where(inArray(payslip.employmentId, employmentIds));

  // (employment, tax year) → its months, each month → the slips written in it (a multi-run month has
  // several, and they all belong to the SAME monthly accumulator step).
  const byEmpYear = new Map<string, Map<string, typeof rows>>();
  const tp3 = new Map<string, { year: number | null; net: number; epf: number; pcb: number; zakat: number; lp: number }>();
  for (const r of rows) {
    const year = r.period.slice(0, 4);
    if (!years.includes(year)) continue;
    const ky = `${r.employmentId}|${year}`;
    const months = byEmpYear.get(ky) ?? new Map<string, typeof rows>();
    months.set(r.period, [...(months.get(r.period) ?? []), r]);
    byEmpYear.set(ky, months);
    if (!tp3.has(r.employmentId)) {
      tp3.set(r.employmentId, {
        year: r.tp3Year,
        net: Number(r.tp3Net ?? 0),
        epf: Number(r.tp3Epf ?? 0),
        pcb: Number(r.tp3Pcb ?? 0),
        zakat: Number(r.tp3Zakat ?? 0),
        // r356 — ∑LP was never even SELECTED here, so the worksheet could not have seeded it. Item
        // 20837372 added the column and fixed the kernel; this copy kept a hard 0.
        lp: Number(r.tp3Lp ?? 0),
      });
    }
  }

  for (const [ky, months] of byEmpYear) {
    const [employmentId, year] = ky.split('|');
    const seed = tp3.get(employmentId);
    const applies = seed?.year != null && String(seed.year) === year;
    // ══ r356 — THE SEED AND THE FOLD ARE THE KERNEL'S OWN, NOT A SECOND OPINION ABOUT THEM ══════════
    //
    // This function used to build both itself, and both had fallen behind core/payroll.ts:
    //   · the seed hardcoded `lpAccumulated: 0`, which is item 20837372's defect verbatim — ∑LP is the
    //     fourth variable a TP3 feeds and it is SUBTRACTED inside P, so a zero over-deducts a new joiner;
    //   · the fold added `payslip.gross_pay` to Σ(Y−K) where the kernel had moved to the stamped
    //     `bases.pcb` (r354), and summed `zakat` without `zakatRebateTp1` (r352).
    //
    // That matters MORE here than anywhere else: these accumulators feed `statutory(...)` below, and the
    // whole worksheet is the comparison between what that model produces and what the payslips actually
    // paid. A Σ(Y−K) that is too high by an employee's tax-exempt allowances puts the modelled PCB out,
    // both readings then fail to match what was paid, and a perfectly correct month is printed as
    // `unexplained` on a document an accountant is being asked to sign off.
    const acc: PcbAccumulators = openingAccumulatorsFromTp3(
      applies && seed ? { netRemuneration: seed.net, epfClaimed: seed.epf, pcbPaid: seed.pcb, zakatPaid: seed.zakat, lpAccumulated: seed.lp } : null,
      cap,
    );
    for (const period of [...months.keys()].sort()) {
      // Stamp BEFORE folding this month in: what a run in `period` reads is everything before it.
      out.set(`${employmentId}|${period}`, { ...acc });
      for (const slip of months.get(period) ?? []) {
        foldPriorSlipIntoAccumulators(acc, { gross: slip.gross, statutory: slip.statutory }, cap);
      }
    }
  }
  return out;
}

// ─────────────────────────────────────── the worked example ───────────────────────────────────────

/**
 * RM5,001 salary and a RM1,001 second run — the smallest pair that tells the two readings apart, and
 * deliberately NOT the ADR's RM5,000 + RM10,000, which lands on 1,650 under both and can therefore
 * prove nothing. Computed from the ruleset in force, never written down.
 */
function illustrationOf(rules: StatutoryRuleset): WorksheetIllustration {
  const normalWage = 5001;
  const secondRun = 1001;
  const a = epf(normalWage, 0, rules.epf);
  const b = epf(secondRun, 0, rules.epf);
  const combined = epf(normalWage, secondRun, rules.epf);
  return {
    normalWage,
    secondRun,
    epfNormalOnly: a,
    epfSecondRunAlone: b,
    epfMonthCombined: combined,
    perRunTotal: { employee: round2(a.employee + b.employee), employer: round2(a.employer + b.employer) },
    monthAsOneTotal: combined,
    version: rules.version,
  };
}

function emptyWorksheet(rules: StatutoryRuleset): MultiCycleWorksheet {
  return {
    periodsWithMultipleRuns: 0,
    employeeMonthsExamined: 0,
    employeeMonthsExcluded: 0,
    employeeMonthsFlagged: 0,
    employeeMonthsCompared: 0,
    verdicts: { agree: 0, already_aggregated: 0, would_change: 0, unexplained: 0, manual_epf_amount: 0 },
    totals: { paid: ZERO, perRun: ZERO, monthAsOne: ZERO },
    movement: ZERO,
    rows: [],
    skips: [],
    skipCounts: {},
    illustration: illustrationOf(rules),
    replayVersion: rules.version,
    truncated: false,
  };
}
