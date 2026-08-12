/**
 * Re-run disclosure + payslip provenance (feedback 97a9b0ab) — PURE, no DB, no framework.
 *
 * WHAT THIS IS FOR. A payslip can be recomputed (selective reprocess) and come back with a DIFFERENT
 * statutory figure while its gross is untouched. That is not a defect: Malaysian PCB is CUMULATIVE
 * (LHDN MTD spec §D/§E — core/payroll.ts replays the year's prior slips to rebuild netRemuneration /
 * epfClaimed / pcbPaid / zakatPaid / lpAccumulated), so revising month N legitimately moves month N+1.
 * Until now nothing said so on screen, and the movement read as unexplainable.
 *
 * TWO DISTINGUISHABLE CAUSES, and they are separable in data:
 *   (a) RULESET VERSION — the slip's own `statutory.version` differs between the two computations.
 *   (b) PRIOR MONTHS RECOMPUTED — an earlier-month payslip for the same employment was itself
 *       recomputed AFTER this slip was last computed, so the cumulative accumulators it replays moved.
 * Both are reported when both apply. Neither is asserted as *the* cause of a specific ringgit.
 *
 * DELIBERATE HONESTY CONSTRAINT — READ BEFORE CHANGING THE WORDING. A ruleset version bump is NOT
 * automatically behavioural. Verified for this codebase: MY_STATUTORY_VERSION 2026.4 → 2026.5
 * (commit 7857ddc8) added the LHDN PCB pay-code classification tables (`pcbExemptions`) and changed
 * NO PCB band, no rate, no relief and no EPF/SOCSO/EIS figure; every effect is gated behind a pay
 * component carrying an explicit `pcbRemunerationType` / `epfBonus2012`, so an unclassified component
 * folds byte-identically. A version difference is therefore evidence that the rules DOCUMENT moved,
 * not proof that anyone's tax moved. `rulesetChanged` is reported as a fact to check, and the copy
 * that renders it must not claim it moved the figure. (2026.5 → 2026.6, item d64d0df4, is the same
 * shape: an optional `disabledIndividual` relief applied only to an explicitly flagged employee.)
 *
 * No DDL was needed for any of this: `statutory.version` has been stamped on every payslip since
 * 2026.0 (localization/my/payroll.ts sets `version: rules.version`), `payslip.version` already
 * increments on reprocess, and core/payroll.ts already writes the before/after pair into
 * payroll_employee_result_history.
 */

/** Round to cents the same way core/payroll.ts does, so a diff never fires on float dust. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The statutory MONEY lines a payslip actually reports. An ALLOWLIST, derived from the `st` object
 * core/payroll.ts stamps (core/payroll.ts ~:3274 `const st = {...}`) intersected with what the
 * payslip and the run's payslip list render — NOT a denylist over "every numeric key", because
 * `statutory` also carries breakdown/audit members (pcbMeta, exemptionUsed, componentVersions,
 * employerBorne, carryForward, …) whose movement is not a reportable line on its own.
 */
export const STATUTORY_LINE_KEYS = [
  'epfEmployee',
  'epfEmployer',
  'socsoEmployee',
  'socsoEmployer',
  'socsoSkbbk',
  'eisEmployee',
  'eisEmployer',
  'pcb',
  'cp38',
  'zakat',
  'lp',
  'hrdf',
] as const;

export type StatutoryLineKey = (typeof STATUTORY_LINE_KEYS)[number];

/**
 * Feedback 017d9c25 (r187) — THE WORKING BETWEEN the pay items and the answers.
 *
 * "Today you can see the pay items and you can see the answers, but not the working in between." These
 * are the amounts each agency was actually CHARGED ON, stamped by core/payroll.ts as `statutory.bases`
 * from the run that produced the slip. They are not money lines — they are the base each money line was
 * computed from — so they are deliberately NOT in STATUTORY_LINE_KEYS: a base moving is not a reportable
 * statutory movement, it is the explanation for one.
 *
 * ABSENT ON EVERY PAYSLIP WRITTEN BEFORE r187, which is why `payslipStatutoryBases` returns null rather
 * than a zero-filled object: "we do not know what this was charged on" and "it was charged on nothing"
 * are different statements, and a screen must not print the second when it means the first.
 */
export const STATUTORY_BASE_KEYS = ['epf', 'epfAdditional', 'socsoEis', 'pcb', 'hrdf'] as const;
export type StatutoryBaseKey = (typeof STATUTORY_BASE_KEYS)[number];
export type StatutoryBases = Record<StatutoryBaseKey, number>;

/** Read `statutory.bases` off a stored payslip blob. Null when the slip predates the stamp. Total. */
export function payslipStatutoryBases(statutory: unknown): StatutoryBases | null {
  const st = (statutory ?? {}) as Record<string, unknown>;
  const b = st.bases;
  if (!b || typeof b !== 'object') return null;
  const src = b as Record<string, unknown>;
  const out = {} as StatutoryBases;
  for (const k of STATUTORY_BASE_KEYS) out[k] = round2(Number(src[k] ?? 0));
  return out;
}

/** One statutory line that moved between two computations of the same payslip. */
export type StatutoryMove = {
  key: StatutoryLineKey;
  before: number;
  after: number;
  /** after − before, rounded to cents. Negative ⇒ the line went down. */
  delta: number;
};

/** Provenance already recorded in a payslip's `statutory` JSONB — no column, no migration. */
export type PayslipProvenance = {
  /** The statutory ruleset version that produced the figures (e.g. '2026.5'). Null on a slip that
   *  predates the stamp — treated as UNKNOWN, never as "changed". */
  rulesetVersion: string | null;
  /** Signed-pack provenance. Present only when the run resolved a signed statutory pack
   *  (`resolved.source === 'pack'`); null for a company computing from the built-in ruleset. */
  packVersion: string | null;
  signedKeyId: string | null;
};

/** A payslip snapshot as stored — either the live row or a `before`/`after` blob from result history. */
export type PayslipSnapshot = {
  grossPay?: unknown;
  netPay?: unknown;
  statutory?: unknown;
  version?: unknown;
};

/**
 * Why a statutory line moved. Both may apply at once; an empty list on a real movement means the
 * movement came from this payslip's OWN inputs (a relief/zakat/election edit), which is itself an
 * answer worth printing.
 */
export type RecomputeCause = 'ruleset_version' | 'prior_months_recomputed';

export type RecomputeDiff = {
  versionBefore: number | null;
  versionAfter: number | null;
  grossBefore: number;
  grossAfter: number;
  grossChanged: boolean;
  netBefore: number;
  netAfter: number;
  netChanged: boolean;
  /** Statutory lines that moved, in STATUTORY_LINE_KEYS order. Empty ⇒ nothing statutory moved. */
  moved: StatutoryMove[];
  before: PayslipProvenance;
  after: PayslipProvenance;
  /** True only when BOTH versions are known and they differ. Unknown-either-side ⇒ false. */
  rulesetChanged: boolean;
  /** True when either side's ruleset version was never stamped — the version cause is undecidable. */
  rulesetUnknown: boolean;
  causes: RecomputeCause[];
  /**
   * 017d9c25 — the amounts each agency was charged on, before and after. NULL on either side means that
   * computation predates the stamp, and the screen says nothing rather than printing zeroes.
   */
  basesBefore: StatutoryBases | null;
  basesAfter: StatutoryBases | null;
  /**
   * The movement worth explaining: a statutory line moved while gross did NOT. (A gross change
   * explains itself — different pay, different statutory.)
   */
  needsDisclosure: boolean;
};

/** Coerce a stored numeric (JSONB number or numeric-as-string) to a rounded number. */
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? round2(n) : 0;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Read the provenance already present in a payslip's `statutory` JSONB. Total — never throws. */
export function payslipProvenance(statutory: unknown): PayslipProvenance {
  const st = (statutory ?? {}) as Record<string, unknown>;
  return {
    rulesetVersion: str(st.version),
    packVersion: str(st.packVersion),
    signedKeyId: str(st.signedKeyId),
  };
}

/**
 * Diff two computations of the SAME payslip and name the causes.
 *
 * `priorMonthsRecomputed` is the caller's (a) evidence for cause (b): earlier-month payslips for this
 * employment that were themselves recomputed in the window between this slip's previous computation
 * and this one. The pure layer does not go looking for them — it only reports what it is handed.
 */
export function diffPayslipVersions(
  before: PayslipSnapshot | null | undefined,
  after: PayslipSnapshot | null | undefined,
  opts: { priorMonthsRecomputed?: boolean } = {},
): RecomputeDiff {
  const b = before ?? {};
  const a = after ?? {};
  const bStat = (b.statutory ?? {}) as Record<string, unknown>;
  const aStat = (a.statutory ?? {}) as Record<string, unknown>;

  const moved: StatutoryMove[] = [];
  for (const key of STATUTORY_LINE_KEYS) {
    // A key absent on one side reads as 0 — which is correct: `cp38` and `otConvert` are only stamped
    // when non-zero, so "absent → 5.00" IS a movement from nothing to something.
    const bv = num(bStat[key]);
    const av = num(aStat[key]);
    if (bv !== av) moved.push({ key, before: bv, after: av, delta: round2(av - bv) });
  }

  const bp = payslipProvenance(b.statutory);
  const ap = payslipProvenance(a.statutory);
  const rulesetUnknown = bp.rulesetVersion == null || ap.rulesetVersion == null;
  const rulesetChanged = !rulesetUnknown && bp.rulesetVersion !== ap.rulesetVersion;

  const causes: RecomputeCause[] = [];
  if (rulesetChanged) causes.push('ruleset_version');
  if (opts.priorMonthsRecomputed) causes.push('prior_months_recomputed');

  const grossBefore = num(b.grossPay);
  const grossAfter = num(a.grossPay);
  const netBefore = num(b.netPay);
  const netAfter = num(a.netPay);

  return {
    versionBefore: typeof b.version === 'number' ? b.version : null,
    versionAfter: typeof a.version === 'number' ? a.version : null,
    grossBefore,
    grossAfter,
    grossChanged: grossBefore !== grossAfter,
    netBefore,
    netAfter,
    netChanged: netBefore !== netAfter,
    moved,
    before: bp,
    after: ap,
    rulesetChanged,
    rulesetUnknown,
    causes,
    basesBefore: payslipStatutoryBases(b.statutory),
    basesAfter: payslipStatutoryBases(a.statutory),
    needsDisclosure: moved.length > 0 && grossBefore === grossAfter,
  };
}
