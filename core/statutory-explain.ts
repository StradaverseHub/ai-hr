/**
 * Feedback 6b4ca488 part 2 — the working behind EPF, SOCSO, EIS, SKBBK, HRDF and PCB.
 *
 * THE GAP. app/payroll/pcb-detail (item 45df860a) explains ONE of the six: it reads the payslip's own
 * persisted `pcbMeta`, so an old slip explains itself with the rules that were true when it ran. For the
 * other five you could see the amount and nothing else — no wage the contribution was charged on, no
 * rate, no split between what came off take-home and what the employer funded. This module is the same
 * idea for all six, and it copies pcb-explain.ts's posture deliberately, including its refusals.
 *
 * ══ THE ONE RULE THIS FILE EXISTS TO ENFORCE ══
 *
 * READ THE PERSISTED WORKING. NEVER RECOMPUTE. Every figure below comes off the payslip's own
 * `statutory` blob — the amounts the run wrote, and the wage bases (`statutory.bases`) it recorded them
 * against. Nothing here consults today's EPF table, today's PERKESO schedule, today's HRDF rate or the
 * employee's current statutory flags, and this module takes NO SessionContext so it cannot start:
 * an explanation that disagrees with the payslip printed beside it is the worst possible outcome, and
 * a screen that recomputes will produce one the first time a rate changes.
 *
 * WHY THERE IS A "RATE" AT ALL, given nothing stamps one. The rates were never persisted — only the
 * bases and the resulting amounts were. So the rate reported here is the EFFECTIVE rate this run
 * applied, `amount ÷ base`, derived from the two numbers the run itself wrote down. That is still
 * reading the working rather than recomputing it: it is arithmetic ON the recorded figures, and it is
 * algebraically incapable of disagreeing with the amount beside it, which a table lookup is not.
 * `ruleKind` says which kind of rule produced the amount, so the screen never presents a contribution
 * SCHEDULE lookup as if it were a percentage — see the note on `ruleKind` below. TWO CASES REPORT NO RATE
 * AT ALL and the next two sections are why: an additional run, and a figure somebody typed.
 *
 * …AND WHY THERE IS NO RATE ON AN ADDITIONAL RUN. `amount ÷ base` is only a rate when the two terms
 * describe the same money, and on a bonus / off-cycle / adjustment run they do NOT. The AMOUNTS such a
 * run stamps are INCREMENTS — `deltaStat` (core/payroll.ts:412) re-runs the month with and without this
 * run's additional remuneration and keeps the difference — while the BASES it stamps are the CUMULATIVE
 * month (core/payroll.ts:4890, "on an additional run that is the cumulative month"). Dividing one by the
 * other yields a percentage that is not any statutory rate and never was: RM5,000 basic already run,
 * then a RM10,000 bonus, gives 1,100 ÷ 15,000 = 7.33%, an EPF rate that does not exist. So on an
 * additional run BOTH effective rates are NULL, exactly as they are when the base was never recorded —
 * "we cannot derive a rate from these two figures" and "the rate was 7.33%" are different statements,
 * and only the first is true. This is the same trap `deltaStat`'s own comment documents for PCB.
 *
 * ══ …AND WHY THERE IS NO RATE ON A FIGURE SOMEBODY TYPED (208beb8b) ══
 *
 * `applyStatutoryAdjustment` (core/payroll.ts) lets an operator set any of NINE statutory lines to an
 * exact figure, and stamps `{system, applied}` per line plus ONE mandatory reason under
 * `statutory.adjustment`. Until 208beb8b this module never read that stamp. A hand-set EPF of RM500 on a
 * recorded base of RM3,000 was therefore reported as `ruleKind: 'schedule'` with an effective employee
 * rate of 16.67%, and the screen captioned it as the KWSP THIRD SCHEDULE band lookup. All three
 * statements were false at once: there is no such rate, the schedule did not produce that amount, and
 * nothing said a person had decided it — on the one screen whose whole job is to be trusted about where
 * a number came from. `amount ÷ base` is a rate only when the rule really divided that way; a typed
 * amount stops the equation evaluating. So a hand-set line reports `ruleKind: 'manual'` and BOTH
 * effective rates NULL, exactly as an additional run does. The HRD Corp levy is the loudest case rather
 * than a special one: it is the only item whose working is printed as a multiplication, so a typed levy
 * printed `wage × percentage = an amount that is not their product`.
 *
 * 70b14723 — AND A SECOND WAY IN, WITH THE SAME CONSEQUENCE. A standing Manual EPF category does to the
 * KWSP Third Schedule exactly what a per-run adjustment does: RM500 against a recorded base of RM3,000 is
 * not 16.67% of anything and the schedule did not produce it. So the EPF item reports `ruleKind: 'manual'`
 * and both rates null there too, off `statutory.epfManual` instead of `statutory.adjustment`. Note what this
 * does NOT change: a manual EMPLOYER amount alone still nulls the employee rate as well, under the same
 * blunt rule and the same recorded reversal below.
 *
 * DELIBERATE, WITH ITS REVERSAL WRITTEN IN. When only ONE leg was typed, nulling both rates suppresses
 * the untouched leg's genuinely-derived rate, which loses a true statement. It is chosen anyway: one
 * item telling two stories — "KWSP Third Schedule, 13.00%" on one line and "entered by hand" on the line
 * above it — invites the reader to trust the quotient on the half that still has one, which is exactly
 * the habit this screen exists to break. THE REVERSAL, if that is later judged too blunt: keep `ruleKind`
 * at the rule that produced the untouched leg, add a per-LEG manual flag, and suppress only the typed
 * leg's rate. Recorded here rather than in a commit message because the alternative is defensible.
 *
 * ══ ONE ANSWER TO "WHERE DID THIS FIGURE COME FROM?" — THE SEAM, AND WHO EXTENDS IT ══
 *
 * `statutoryProvenance(statutory, key)` IS that answer and the only place that decides it. The
 * explanation carries what it returns on every item (`provenance`) and once for the payslip
 * (`setByHand`); the screen, its amber banner and the Excel export all read those two and never re-read
 * `statutory.adjustment` for themselves.
 *
 * ⚠️ THE SECOND SOURCE HAS LANDED (70b14723), AND IT CAME IN THROUGH HERE — which is the evidence that the
 * seam was the right shape rather than a hope. `manual_amount` is a STANDING per-employee EPF figure typed
 * on the employee's record (`employee_statutory_my.epf_employee_amount` / `epf_employer_amount`), stamped by
 * the kernel as `statutory.epfManual` and read by `readEpfManualProvenance` below. The whole extension was
 * one member of `StatutoryProvenanceSource`, one arm of this function, and per-source wording on the one
 * banner. No second banner, no second label set, no second suppression rule: `isSetByHand` already made
 * every call site recognise it, `ruleKind: 'manual'` already suppressed both rates, and the Excel export
 * already carried the disclosure. A THIRD source should be the same size of change; if it is not, the seam
 * has been worked around rather than extended.
 *
 * THE ONE THING THAT DID CHANGE SHAPE: `StatutorySetByHand.reason` became `notes`, one entry per source.
 * Two sources can sit on one payslip, each with its own operator's words, and a single reason field
 * silently attaches one decision's justification to the other.
 *
 * ══ WHAT AN OLD PAYSLIP GETS ══
 *
 * `statutory.bases` is stamped only from r187 onward and is present on a MINORITY of payslips (61 of
 * 121 production rows carried nothing at the time item 0253dc7c measured it). Those rows report
 * `base: null` and `workingNotRecorded: true`, and the screen SAYS SO. They are never filled in from
 * gross pay, from the payslip's wage columns, or from anything else:
 *   - EPF excludes overtime and SOCSO/EIS do not, so no single earnings figure is any of the bases;
 *   - each base is already net of the per-item statutory ticks and of ticked deductions;
 *   - and a wage base is exactly the number a reader has come to this screen to trust.
 * "We did not record what this was charged on" and "it was charged on nothing" are different
 * statements, and the second must never be printed when the first is meant.
 */
import { payslipProvenance, payslipStatutoryBases, type StatutoryBases } from './payslip-recompute';
import { payslipEmployerBorne, type EmployerBorneView } from './payslip-employer-borne';

/** The six the request names, in the order the screen lists them. */
export const STATUTORY_EXPLAIN_KEYS = ['epf', 'socso', 'skbbk', 'eis', 'hrdf', 'pcb'] as const;
export type StatutoryExplainKey = (typeof STATUTORY_EXPLAIN_KEYS)[number];

/**
 * WHICH KIND OF RULE produced the amount. The screen needs this because presenting all six the same way
 * would be a lie about three of them:
 *
 *   'rate'     — a percentage of the wage (the HRD Corp levy, and nothing else). `base × rate = amount`
 *                is the actual working, so showing the rate as a multiplication is truthful.
 *   'schedule' — a CONTRIBUTION SCHEDULE lookup: the amount is the figure the band the wage falls in
 *                prescribes, NOT the product of the wage and a percentage, and the two disagree by
 *                cents for almost every wage. Two different schedules land here:
 *                  · SOCSO, EIS and SKBBK — PERKESO's contribution schedule.
 *                  · EPF — the KWSP THIRD SCHEDULE (localization/my/statutory-tables.ts:200, applied at
 *                    localization/my/payroll.ts:126 `bandFor(partA, wage)`). EPF was first classified
 *                    'rate' here and that was wrong: for every monthly wage up to RM20,000 — which is
 *                    very nearly all of them — the kernel does a BAND LOOKUP, exactly as it does for
 *                    PERKESO, and the band amount is the rate applied to the band's UPPER limit rounded
 *                    UP to the next ringgit. Wage 2,990 pays 330 (the 3,000 band), not 11% × 2,990 =
 *                    328.90, so "Percentage of wage" mislabelled the largest deduction on the payslip
 *                    and printed a multiplication that does not evaluate. Above RM20,000 the schedule
 *                    ends and the percentage applies — still rounded up to the ringgit, so the printed
 *                    product would not evaluate there either.
 *                `effectiveEmployeeRate` is still reported for all of these, but as a check figure the
 *                screen must caption as effective — never as "the rate".
 *   'mtd'      — LHDN's computerised MTD calculation (PCB). Reliefs, accumulators and a schedule; not
 *                expressible as a rate at all. The whole working already lives at /payroll/pcb-detail
 *                off the same payslip's `pcbMeta`, and this module deliberately does NOT reimplement it
 *                — one PCB display, which is exactly what 45df860a's plan settled.
 *   'manual'   — NO RULE PRODUCED THIS AMOUNT (208beb8b). A person typed it, so there is nothing to name:
 *                not the KWSP Third Schedule, not PERKESO's, not a percentage of the wage. It takes the seat
 *                the produced rule would have had precisely so every surface that prints a rule name prints
 *                this instead, and so both effective rates go null with it.
 *                TWO WAYS TO GET HERE SINCE 70b14723, and the rule name is deliberately the SAME for both:
 *                Payroll › Statutory Adjustment (one run) and the employee's own Manual EPF category (every
 *                run). "No rule produced this amount" is equally true of each, and a second rule label would
 *                be a distinction the WORKING does not have. WHO decided it — and why — is `provenance`'s
 *                job, and the banner's wording follows that instead.
 *                PCB IS THE ONE EXCEPTION AND KEEPS 'mtd': it has no rate to suppress here, its own
 *                screen already discloses the override in full, and the link across is the product's one
 *                MTD display. A hand-set PCB is still flagged — through `provenance` and the banner.
 */
export type StatutoryRuleKind = 'rate' | 'schedule' | 'mtd' | 'manual';

/**
 * WHERE A FIGURE CAME FROM. A union rather than a boolean because 70b14723 adds a second source and the
 * screen must be able to say WHICH — "a payroll officer typed it" and "the employee's EPF category says
 * so" are different sentences, and only one of them names an adjustment with a reason attached.
 *   · 'computed'            — the run's own rule produced it. The overwhelming majority.
 *   · 'statutoryAdjustment' — Payroll › Statutory Adjustment, `applyStatutoryAdjustment`'s stamp.
 *   · 'epfManualAmount'    — 70b14723: the EMPLOYEE'S OWN EPF CATEGORY says so. A standing per-employee
 *                             ringgit figure (`employee_statutory_my.epf_employee_amount` /
 *                             `epf_employer_amount`, mode 'manual_amount'), read live by every run and
 *                             stamped on the payslip as `statutory.epfManual`. EPF ONLY — no other item has
 *                             such an election, which is why the arm below is gated on the key.
 *
 * WHEN BOTH ARE TRUE OF ONE PAYSLIP, 'statutoryAdjustment' WINS AND THAT IS NOT A PREFERENCE. A per-run
 * adjustment is applied AFTER the kernel's `stComputed` (core/payroll.ts `applyStatutoryAdjustment`), so it
 * IS the figure the payslip carries; its own `system` leg happens to record the standing amount it
 * replaced, which is the honest account of that payslip. Reporting the election instead would name a figure
 * that is not on the slip.
 */
export type StatutoryProvenanceSource = 'computed' | 'statutoryAdjustment' | 'epfManualAmount';

/** One leg of one item, as the run's stamp recorded it: what the engine produced, and what was used. */
export type StatutoryManualLeg = {
  /** What THIS RUN's engine computed before the figure was replaced — read off the stamp, never re-run. */
  system: number;
  /** What the payslip actually carries, i.e. the figure that was typed. */
  applied: number;
};

/**
 * The answer `statutoryProvenance` returns, and the only shape any surface reads it through.
 * `employee` / `employer` are NULL for a leg nobody touched — including on an item whose OTHER leg was
 * typed, so a screen can say which half a person decided.
 */
export type StatutoryProvenance = {
  source: StatutoryProvenanceSource;
  employee: StatutoryManualLeg | null;
  employer: StatutoryManualLeg | null;
  /** The operator's mandatory reason, one per adjustment. '' when nothing was set by hand. */
  reason: string;
};

/**
 * The payslip-level answer the banner needs: WHICH items a person decided, and WHY — per SOURCE.
 *
 * 70b14723 — `notes` REPLACED a single `reason: string`, because a second source made that field capable of
 * a quiet misattribution: with a hand-set SOCSO line and a standing manual EPF amount on one payslip, the
 * banner printed the first item's reason under one heading and left a reader to attach it to both. One entry
 * per distinct source, in `STATUTORY_EXPLAIN_KEYS` order, each carrying the reason recorded for THAT source
 * — so the screen and the export say "a payroll officer typed it, because X" and "the employee's EPF
 * category says so, because Y" as the two different sentences they are.
 */
export type StatutorySetByHand = {
  /** In `STATUTORY_EXPLAIN_KEYS` order, so the banner lists them the way the screen lists them. */
  keys: StatutoryExplainKey[];
  /** One per distinct non-'computed' source on this payslip, in the order the items appear. */
  notes: { source: StatutoryProvenanceSource; reason: string }[];
};

/**
 * ONE PREDICATE, so a third source added to the union is automatically "a person decided this" everywhere
 * instead of in the places somebody remembered to update.
 */
export const isSetByHand = (p: StatutoryProvenance): boolean => p.source !== 'computed';

export type StatutoryItemExplanation = {
  key: StatutoryExplainKey;
  ruleKind: StatutoryRuleKind;
  /**
   * The wage this agency was ACTUALLY charged on, as the run recorded it. NULL means the run predates
   * the `statutory.bases` stamp — never 0, and never substituted from gross. See the header.
   */
  base: number | null;
  /**
   * EPF only, and null for everything else: the additional (bonus / off-cycle) stream, which EPF charges
   * separately from the normal wage. Kept as its own field rather than folded into `base` because the
   * two streams can carry different rates and the reader is entitled to see both terms.
   */
  additionalBase: number | null;
  /**
   * `base + additionalBase` — THE ONE FIGURE every surface calls "the statutory wage", and the reason it
   * is derived here rather than at each call site. EPF is the only item with two streams, so a summary
   * column adding them, a working line adding them and an export column NOT adding them is a drift
   * nobody would notice until an auditor did: the table would say 5,000 while the working line beside it
   * charged 5,100 for the same 561. Null exactly when `base` is null, so an unrecorded working stays
   * unrecorded.
   */
  totalBase: number | null;
  /** The FULL employee share as computed and as FILED. An employer-bears election never reduces this. */
  employeeReported: number;
  /** What genuinely came off take-home: `employeeReported` less the part the employer funded. */
  employeeTakeHome: number;
  /** The part of the employee share the employer funded on their behalf. 0 on every other payslip. */
  employerBorne: number;
  /** The employer's own share. 0 for the employee-only items (SKBBK, PCB). */
  employer: number;
  /**
   * `employeeReported ÷ (base + additionalBase)`, i.e. the rate this run effectively applied. NULL when
   * the base was not recorded or is zero — a rate over an unknown or zero wage is not a number, and
   * printing 0% would read as "this employee is exempt", which is a different statement. ALSO null on
   * every additional run, where the amount is an increment and the base is the cumulative month, so the
   * quotient is not a rate at all — see the header.
   */
  effectiveEmployeeRate: number | null;
  /** Likewise for the employer share. */
  effectiveEmployerRate: number | null;
  /** True when this run recorded no wage base for this item. The screen must say so in place of the base. */
  workingNotRecorded: boolean;
  /**
   * 208beb8b — WHERE THIS ITEM'S FIGURES CAME FROM, straight from `statutoryProvenance`. `source:
   * 'computed'` with both legs null is the ordinary case. When a leg is present the screen prints the
   * system figure beside the applied one and prints NO rate for the item; see the header for why both
   * rates go, not just the typed leg's.
   */
  provenance: StatutoryProvenance;
};

export type StatutoryExplanation = {
  items: StatutoryItemExplanation[];
  /**
   * The headline flag: this payslip carries no `statutory.bases` object at all, so EVERY item's working
   * is unavailable. Distinct from a per-item `workingNotRecorded` so the screen can lead with one honest
   * banner instead of repeating the same caveat six times.
   */
  basesNotRecorded: boolean;
  /**
   * An additional (bonus / off-cycle / adjustment) run stamps the bases of the CUMULATIVE MONTH, not of
   * the money that run alone paid — A0006's 2026-01 bonus payslip is all zeros yet stamps an EPF base of
   * 5,100. Without this flag the screen would appear to charge a wage the slip beside it does not show.
   * Since r337 a REGULAR run that landed after a bonus run does the same thing (it restates the month),
   * so this is no longer the same question as "is the run type non-regular" — see `carriesDeltaStamp`.
   *
   * The SAME flag means the AMOUNTS are increments (`deltaStat`), which is why it also suppresses every
   * effective rate: the two terms come from different quantities and their quotient is not a rate. The
   * screen's banner must say BOTH halves — a banner that discloses only the cumulative wage leaves a
   * reader to assume the amount beside it belongs to that wage.
   */
  basesCoverWholeMonth: boolean;
  /**
   * 208beb8b — THE HAND-SET BANNER'S WHOLE INPUT. NULL when every figure on this payslip came out of a
   * rule; otherwise the items a person decided and the reason they recorded. One reason, not one per
   * line, because `applyStatutoryAdjustment` stamps one for the whole adjustment.
   *
   * Orthogonal to `basesCoverWholeMonth` and both can be set at once — an additional run whose line was
   * then also typed. The two banners are rendered side by side and each says only its own half, which is
   * the posture pcb-explain's 'additionalRunManual' already takes for the tax screen.
   */
  setByHand: StatutorySetByHand | null;
  /** The statutory ruleset version stamped by the run, when it recorded one. */
  rulesetVersion: string | null;
  /** The employer-borne view this explanation was built from, for the screen's disclosure line. */
  employerBorne: EmployerBorneView;
  totals: {
    employeeReported: number;
    employeeTakeHome: number;
    employerBorne: number;
    employer: number;
  };
};

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

/** `amount ÷ base`, or null when the base is unknown or zero. Never 0 — see the field doc. */
function effectiveRate(amount: number, base: number | null): number | null {
  if (base == null || base <= 0) return null;
  return amount / base;
}

type Blob = {
  epfEmployee?: unknown;
  epfEmployer?: unknown;
  socsoEmployee?: unknown;
  socsoEmployer?: unknown;
  socsoSkbbk?: unknown;
  eisEmployee?: unknown;
  eisEmployer?: unknown;
  hrdf?: unknown;
  pcb?: unknown;
  pcbMeta?: unknown;
  /** `applyStatutoryAdjustment`'s stamp — read ONLY through `statutoryProvenance`. */
  adjustment?: unknown;
  /** 70b14723 — the kernel's standing-manual-EPF stamp (`epfManualStamp`, core/payroll.ts). Read ONLY
   *  through `statutoryProvenance`, for the same reason and under the same guard as `adjustment`. */
  epfManual?: unknown;
};

/**
 * r337 — DID THIS PAYSLIP'S FIGURES COME OUT OF `deltaStat`? Read off the PAYSLIP, not off the run type.
 *
 * `runType !== 'regular'` used to be the whole test, and it was exact while the regular run was always
 * run_seq 1. Item 23e7dac3 (ADR-0085 §5 step 5) lets a bonus or off-cycle run open the month, and the
 * regular run then RESTATES it — so a run whose `runType` is 'regular' can now carry increments against
 * a cumulative base, which is precisely the state this module's banner exists to disclose. Left on the
 * run type alone, the screen would print a cumulative wage beside an incremental amount and call it a
 * month's figure: the exact mislead documented above, on the one run an operator is least expecting it.
 *
 * The signal is `pcbMeta.delta`, which `deltaStat` stamps and nothing else writes — so the payslip says
 * for itself how it was computed, rather than a caller having to remember to say. Presence is the gate,
 * with the three members `deltaStat` always writes together, so a half-written blob is not read as one.
 * For a run that never went through `deltaStat` this is absent and the answer is the old one exactly.
 */
function carriesDeltaStamp(st: Blob): boolean {
  const meta = st.pcbMeta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const d = (meta as { delta?: unknown }).delta;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const o = d as Record<string, unknown>;
  return ['cumulative', 'prior', 'cumulativeBonus'].every((k) => typeof o[k] === 'number');
}

/**
 * 208beb8b — THE NINE OVERRIDABLE LINES, MAPPED ONTO THE SIX ITEMS THIS SCREEN EXPLAINS.
 *
 * The line names are `STATUTORY_ADJUSTMENT_LINES` (core/payroll.ts). They are written out as LITERALS
 * here rather than imported, because this module must not reach the payroll kernel at all — that fence is
 * what makes it structurally incapable of recomputing, and test/statutory-explain.test.ts asserts the
 * import list. The price is that the two lists could drift, so the same test imports BOTH and asserts this
 * map covers exactly the nine, once. Nine lines, six items: SKBBK has no employer leg in the engine and
 * the HRD Corp levy no employee one, so those two sides are `null` — a fact, not a gap.
 */
const ADJUSTMENT_LINES: Record<StatutoryExplainKey, { employee: string | null; employer: string | null }> = {
  epf: { employee: 'epfEmployee', employer: 'epfEmployer' },
  socso: { employee: 'socsoEmployee', employer: 'socsoEmployer' },
  skbbk: { employee: 'socsoSkbbk', employer: null },
  eis: { employee: 'eisEmployee', employer: 'eisEmployer' },
  hrdf: { employee: null, employer: 'hrdf' },
  pcb: { employee: 'pcb', employer: null },
};

/**
 * ONE STAMPED LINE, or NULL — gated on PRESENCE of both figures, the way `readOverride` and `readDelta`
 * are in pcb-explain.ts and for the same reason: `n()` turns `undefined` into 0, so a half-written stamp
 * would otherwise hand the screen a banner asserting AS FACT that the system had calculated RM 0.00.
 * "This line was not set by hand" and "the system calculated nothing" are different statements.
 */
function readAdjustedLine(lines: Record<string, unknown>, line: string | null): StatutoryManualLeg | null {
  if (!line) return null;
  const raw = lines[line];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const l = raw as { system?: unknown; applied?: unknown };
  if (l.system === undefined || l.applied === undefined) return null;
  return { system: r2(n(l.system)), applied: r2(n(l.applied)) };
}

/**
 * ══ THE SEAM. WHERE DID THIS ITEM'S FIGURES COME FROM? ══
 *
 * The ONE function that answers it, for one payslip and one of the six items. Read the header's "ONE
 * ANSWER" section before extending it: the screen, its banner and the Excel export all consume what this
 * returns (through `StatutoryItemExplanation.provenance` and `StatutoryExplanation.setByHand`) and none of
 * them reads `statutory.adjustment` for itself. Item 70b14723 (Manual EPF categories) adds its source
 * HERE — a new member of `StatutoryProvenanceSource` and a new arm below — and every surface follows.
 *
 * Pure, total and shape-defensive: `statutory` is plain jsonb with no validator and this runs on a
 * payslip screen, so anything unexpected degrades to 'computed' rather than throwing.
 *
 * @param statutory the payslip's OWN blob, exactly as stored.
 * @param key       which of the six items to answer for.
 */
export function statutoryProvenance(statutory: unknown, key: StatutoryExplainKey): StatutoryProvenance {
  const none: StatutoryProvenance = { source: 'computed', employee: null, employer: null, reason: '' };
  const st = (statutory ?? {}) as Blob;
  const adjustment = readAdjustmentProvenance(st, key);
  // ORDER IS THE ANSWER, NOT A PREFERENCE: `applyStatutoryAdjustment` runs after the kernel composed
  // `stComputed`, so where both a per-run adjustment and a standing manual amount exist, the adjustment IS
  // the figure on the payslip — and its own `system` leg already records the standing amount it replaced.
  // See the note on `StatutoryProvenanceSource`.
  if (adjustment) return adjustment;
  return readEpfManualProvenance(st, key) ?? none;
}

/** `applyStatutoryAdjustment`'s stamp, or null when it says nothing about this item. */
function readAdjustmentProvenance(st: Blob, key: StatutoryExplainKey): StatutoryProvenance | null {
  const stamp = st.adjustment;
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) return null;
  const lines = (stamp as { lines?: unknown }).lines;
  if (!lines || typeof lines !== 'object' || Array.isArray(lines)) return null;
  const map = ADJUSTMENT_LINES[key];
  const employee = readAdjustedLine(lines as Record<string, unknown>, map.employee);
  const employer = readAdjustedLine(lines as Record<string, unknown>, map.employer);
  // A stamp naming only OTHER lines says nothing about this item. `applyStatutoryAdjustment` deliberately
  // does not cascade, so an EPF override leaves SOCSO exactly as the schedule produced it and SOCSO must
  // go on saying so — a banner on every line of the payslip would train readers to ignore it.
  if (!employee && !employer) return null;
  const reason = (stamp as { reason?: unknown }).reason;
  return {
    source: 'statutoryAdjustment',
    employee,
    employer,
    reason: typeof reason === 'string' ? reason : '',
  };
}

/**
 * 70b14723 — THE STANDING PER-EMPLOYEE EPF AMOUNT's stamp (`statutory.epfManual`), or null.
 *
 * EPF AND NOTHING ELSE, gated on the key rather than on a map: `employee_statutory_my` carries a manual
 * amount for EPF alone and no other agency has such an election, so a SOCSO item must go on reporting the
 * PERKESO schedule even on a payslip whose EPF was typed. Returning the same shape as the adjustment arm is
 * the whole point of the seam — `isSetByHand`, the rule label, the suppressed rates, the amber banner and
 * the Excel export all follow with no second implementation and no second decision.
 *
 * Shape-defensive in exactly the way `readAdjustedLine` is, and for the same reason: `{system, applied}` is
 * gated on the PRESENCE of both numbers, so a half-written stamp cannot hand the screen a banner asserting
 * as fact that the system had calculated RM 0.00. "This side was not typed" and "the rule produced nothing"
 * are different statements. A side the operator left blank has no member here at all, because that side is
 * still the schedule's and saying otherwise would suppress a rate that is genuinely derivable.
 */
function readEpfManualProvenance(st: Blob, key: StatutoryExplainKey): StatutoryProvenance | null {
  if (key !== 'epf') return null;
  const stamp = st.epfManual;
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) return null;
  const o = stamp as Record<string, unknown>;
  const employee = readAdjustedLine(o, 'employee');
  const employer = readAdjustedLine(o, 'employer');
  if (!employee && !employer) return null;
  const reason = o.reason;
  return { source: 'epfManualAmount', employee, employer, reason: typeof reason === 'string' ? reason : '' };
}

/**
 * Build the six-item explanation from ONE payslip's stored statutory blob.
 *
 * Pure, total and defensive about shape — a `statutory` blob is plain jsonb with no validator, so every
 * field is read through `n()` and a missing or garbage `bases` degrades to "not recorded" rather than
 * throwing on a payslip screen.
 *
 * @param statutory the payslip's OWN blob, exactly as stored. Not today's configuration.
 * @param runType   the run's cycle. Anything other than 'regular' is an additional run, whose bases
 *                  describe the cumulative month (`isAdditionalRun`, core/payroll.ts:3700).
 */
export function explainStatutory(statutory: unknown, runType: string): StatutoryExplanation {
  const st = (statutory ?? {}) as Blob;
  const bases: StatutoryBases | null = payslipStatutoryBases(statutory);
  const eb = payslipEmployerBorne(statutory);
  const socsoEisBase = bases ? bases.socsoEis : null;
  // `isAdditionalRun` in core/payroll.ts, OR a regular run that restated the month (r337 — see
  // `carriesDeltaStamp`). Either way the amounts are increments against a cumulative base, which is the
  // one thing the banner has to say; the two arms are OR-ed rather than replaced so every payslip
  // written before r337 is read exactly as it was.
  const amountsAreIncremental = runType !== 'regular' || carriesDeltaStamp(st);

  // EPF is charged on TWO streams and the reader must see both terms, so the rate is taken over their
  // sum — that is the wage the recorded employee share was actually produced from.
  const epfBase = bases ? bases.epf : null;
  const epfAdditional = bases ? bases.epfAdditional : null;
  const epfTotalBase = epfBase == null ? null : r2(epfBase + (epfAdditional ?? 0));

  const item = (
    key: StatutoryExplainKey,
    ruleKind: StatutoryRuleKind,
    base: number | null,
    employeeReported: number,
    employer: number,
    borne: number,
    additionalBase: number | null = null,
    rateBase: number | null = base,
  ): StatutoryItemExplanation => {
    // 208beb8b — read ONCE, here, through the seam. Everything below that depends on "did a person decide
    // this?" reads this one answer, so the rule label, the suppressed rates and the banner cannot disagree.
    const provenance = statutoryProvenance(statutory, key);
    const manual = isSetByHand(provenance);
    // NO RATE IS DERIVABLE, and for two independent reasons that can both hold at once: an increment over a
    // cumulative wage is not a rate, and neither is a typed amount over the wage the rule would have used.
    // Both legs go when EITHER was typed — the header records that choice and its reversal.
    const noRate = amountsAreIncremental || manual;
    return {
    key,
    // PCB keeps the rule that produced its working, because that working is on its own screen and is
    // still a true account of `system`; every other item's rule name would be a false attribution.
    ruleKind: manual && key !== 'pcb' ? 'manual' : ruleKind,
    base,
    additionalBase,
    totalBase: base == null ? null : r2(base + (additionalBase ?? 0)),
    employeeReported: r2(employeeReported),
    // Mirrors payslipEmployerBorne's own clamp: the borne amount IS the employee share by construction,
    // but a hand-edited blob must not be able to print a negative deduction on an explanation screen.
    employeeTakeHome: Math.max(0, r2(employeeReported - borne)),
    employerBorne: r2(borne),
    employer: r2(employer),
    // An increment over a cumulative wage is not a rate, and nor is a hand-set amount over any wage — see
    // the header. Null rather than a number nobody can act on, so the screen has one "no rate is
    // derivable" path instead of two stories.
    effectiveEmployeeRate: noRate ? null : effectiveRate(employeeReported, rateBase),
    effectiveEmployerRate: noRate ? null : effectiveRate(employer, rateBase),
    workingNotRecorded: base == null,
    provenance,
    };
  };

  const items: StatutoryItemExplanation[] = [
    // EPF is a SCHEDULE item, not a rate one: the normal monthly wage is looked up in the KWSP Third
    // Schedule band table for every wage up to RM20,000. See the `ruleKind` note above for why the
    // first cut's 'rate' was wrong and what it printed.
    item('epf', 'schedule', epfBase, n(st.epfEmployee), n(st.epfEmployer), eb.borne.epf, epfAdditional, epfTotalBase),
    item('socso', 'schedule', socsoEisBase, n(st.socsoEmployee), n(st.socsoEmployer), eb.borne.socso),
    // SKBBK (Lindung 24 Jam) is an employee-side leg of the same PERKESO schedule, gated independently of
    // SOCSO (item 5a461b99). Employer share 0 — it has none, which is why 0 here is a fact and not a gap.
    item('skbbk', 'schedule', socsoEisBase, n(st.socsoSkbbk), 0, eb.borne.skbbk),
    item('eis', 'schedule', socsoEisBase, n(st.eisEmployee), n(st.eisEmployer), eb.borne.eis),
    // HRD Corp levy: employer-only, so employeeReported 0 and nothing can be borne on the employee's
    // behalf. Zero on a company whose HRDF status is 'not_registered', which is most of them.
    item('hrdf', 'rate', bases ? bases.hrdf : null, 0, n(st.hrdf), 0),
    // PCB carries `tax` in the employer-borne map, not `pcb`. The MTD working itself is NOT rebuilt here
    // — /payroll/pcb-detail already renders it from this same payslip's `pcbMeta`, and a second display
    // of one calculation is exactly what 45df860a's plan refused.
    item('pcb', 'mtd', bases ? bases.pcb : null, n(st.pcb), 0, eb.borne.tax),
  ];

  const sum = (f: (i: StatutoryItemExplanation) => number) => r2(items.reduce((a, i) => a + f(i), 0));

  // The banner's input, derived from the items rather than by reading the stamp a second time. Order is
  // `STATUTORY_EXPLAIN_KEYS` order because `items` is, so the banner lists them as the screen does.
  const handSet = items.filter((i) => isSetByHand(i.provenance));

  return {
    items,
    basesNotRecorded: bases == null,
    basesCoverWholeMonth: amountsAreIncremental,
    setByHand:
      handSet.length === 0
        ? null
        : {
            keys: handSet.map((i) => i.key),
            // ONE NOTE PER DISTINCT SOURCE, first occurrence wins the reason — 70b14723. A payslip can carry
            // a per-run adjustment AND a standing manual EPF amount at once, and each carries its own
            // operator's words; collapsing them to one string is how a reason gets attached to the decision
            // that did not produce it. `keys` stays the flat item list the banner heads itself with.
            notes: handSet.reduce<StatutorySetByHand['notes']>((acc, i) => {
              if (!acc.some((n) => n.source === i.provenance.source))
                acc.push({ source: i.provenance.source, reason: i.provenance.reason });
              return acc;
            }, []),
          },
    // Read through the kernel's OWN accessor rather than a second copy of `st.version` — two readers of
    // one stamp is how a screen starts reporting a different ruleset from the reprocess diff.
    rulesetVersion: payslipProvenance(statutory).rulesetVersion,
    employerBorne: eb,
    totals: {
      employeeReported: sum((i) => i.employeeReported),
      employeeTakeHome: sum((i) => i.employeeTakeHome),
      employerBorne: sum((i) => i.employerBorne),
      employer: sum((i) => i.employer),
    },
  };
}
