/**
 * ADR-0084 §2.6 / §3 item 3 — JUDGMENT-GRADE DETECTION. The first place in this product where a model
 * can CREATE a payroll finding rather than explain one somebody else created.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * The eleven detectors in `payroll-anomaly-detectors.ts` are binary presence checks and one threshold.
 * They can only see what somebody thought to write down, and they are silent on the thing an experienced
 * payroll officer notices in a second: *this one does not look like the others*. Everybody on the run
 * moved up 4% and this person moved down 2% — no rule fires, because `net-swing` wants 30%. The overtime
 * share doubled without crossing zero, so `component-appeared` cannot see it. Those are the misses this
 * layer is for, and they are exactly the FALSE NEGATIVES ADR-0076 §5 says govern how much autonomy this
 * system is ever granted — a rate that today has only a human route and therefore no numerator.
 *
 * **So this layer runs over the employees the deterministic detectors AUTO-CLEARED.** It is the machine
 * performing its own false-negative check, unattended, every night.
 *
 * ═══ THE DIVISION OF LABOUR, AND THE OBJECTION IT HAS TO SURVIVE ═══
 *
 * Deterministic code computes the features, decides who is statistically unusual, re-derives every
 * citation, and writes the finding. The model does one thing: **given a shape, say which of five named
 * explanations it fits, or say it fits none.** That is classification into a closed union plus extraction
 * of field names — `core/pay-rule-ai.ts`'s shape exactly, and for its reasons.
 *
 * ⚠️ **THE FAIR OBJECTION IS "YOUR PREDICATES ARE DETERMINISTIC, SO WHY IS A MODEL HERE AT ALL?"** and it
 * deserves a straight answer rather than a hand-wave. Each claim's predicate is a NECESSARY condition,
 * never a sufficient one. On a real run several of them hold at once for most candidates — a person whose
 * pay moved oddly usually also has an odd deduction share, because the second is arithmetic on the first.
 * A rule firing on "any necessary condition holds" would flag nearly every candidate and would be worse
 * than the eleven it joins. The model's contribution is the part no predicate here expresses: **which
 * explanation the whole vector supports, and — the majority answer — that none of them does.**
 * `nothing_notable` is the output this layer needs most, and a rule cannot produce it.
 *
 * And it is not asserted, it is MEASURED. Every proposal lands in `agent_proposal`; if the model accepts
 * everything, the agreement rate collapses the moment operators start resolving, and this type never
 * earns autonomy (ADR-0084 §2.8). That is the deal the ledger exists to enforce.
 *
 * ═══ WHAT LEAVES THE TENANT ═══
 *
 * Percentages and z-scores. **No ringgit figure, no name, no identifier, no date** — in line with the
 * PDPA posture `report-ai.ts` documents (*schema out, never data*) and stricter than the narrator, which
 * at least sends the numbers that triggered a finding. A share-of-gross and a z-score do not reconstruct
 * a salary.
 *
 * ═══ THE CEILING, WHICH IS STRUCTURAL AND NOT A SETTING ═══
 *
 * `severity: 'review'`, a literal, once, in this file. ADR-0084 §2.2's first corollary is that a model may
 * never raise a `block`, because blocking a payroll run is a derived decision (`resolveDisposition`) and
 * not a scored one. There is no parameter, no config row and no claim that changes that.
 *
 * ═══ AND IT LEARNS, IN THE ONE CHEAP WAY AVAILABLE TODAY ═══
 *
 * The nightly sweep supersedes and rewrites every verdict, so without a memory this layer would re-ask a
 * provider the same question about the same unchanged figures every night forever. `input_digest` already
 * defines when two questions are the same question, so the ledger doubles as the cache — and once it is a
 * cache, one more line makes it a memory: **a hypothesis a human resolved as `false_positive` is never
 * raised again on identical figures.** That is §2.4's learn half, made operational for the price of a
 * WHERE clause.
 */
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { generateDraft } from '../lib/ai';
import { digestOf, recordProposal, type Adjudication } from './agent-proposal';
import { resolveActiveAiConfig } from './ai-config';
import { settingEnabled } from './entitlements';
import { loadBatchContexts } from './payroll-anomaly';
import { HYPOTHESIS_DETECTOR_ID, type DetectorContext, type Finding, type PayslipFigures } from './payroll-anomaly-detectors';

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The closed vocabularies
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The FEATURES. Every one is dimensionless — a percentage, a share, or a robust z-score against the rest
 * of the run. A `*Z` key is the peer-group half of its base key; the base key is the person's own shape.
 */
export const FEATURE_KEYS = [
  'netChangePct',
  'grossChangePct',
  'otShareOfGrossPct',
  'allowanceShareOfGrossPct',
  'deductionShareOfGrossPct',
  'statutoryShareOfGrossPct',
  'netChangePctZ',
  'grossChangePctZ',
  'otShareOfGrossPctZ',
  'allowanceShareOfGrossPctZ',
  'deductionShareOfGrossPctZ',
  'statutoryShareOfGrossPctZ',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** The base feature each z-score is computed from. A base key is material only if its z-score is. */
const Z_OF: Record<string, FeatureKey> = {
  netChangePct: 'netChangePctZ',
  grossChangePct: 'grossChangePctZ',
  otShareOfGrossPct: 'otShareOfGrossPctZ',
  allowanceShareOfGrossPct: 'allowanceShareOfGrossPctZ',
  deductionShareOfGrossPct: 'deductionShareOfGrossPctZ',
  statutoryShareOfGrossPct: 'statutoryShareOfGrossPctZ',
};
const BASE_OF: Record<string, FeatureKey> = Object.fromEntries(
  Object.entries(Z_OF).map(([base, z]) => [z, base as FeatureKey]),
) as Record<string, FeatureKey>;

/**
 * The CLAIMS. Five explanations plus a decline, and the decline is the one the layer needs most.
 *
 * Each is something the eleven detectors provably cannot see: every one of them lives INSIDE
 * `net-swing`'s threshold, or turns on a share rather than a presence, or is about the group rather than
 * the person.
 */
export const HYPOTHESIS_CLAIMS = [
  /** The group moved up together and this person did not. An increment that missed somebody. */
  'missed_increment',
  /** This person's pay moved in a way the group did not — either direction, below net-swing's 30%. */
  'out_of_step_with_peers',
  /** Overtime or allowance is a very different share of pay than the group's, without crossing zero. */
  'component_drift',
  /** Deductions are a very different share of pay than the group's. A mis-keyed recurring deduction. */
  'deduction_outlier',
  /** Statutory contributions are a very different share than the group's — often a wrong category. */
  'statutory_category_doubt',
] as const;
export type HypothesisClaim = (typeof HYPOTHESIS_CLAIMS)[number];

/** Not a claim: the model saying the figures are ordinary. Valid output, and the expected majority. */
export const NOTHING_NOTABLE = 'nothing_notable';

/**
 * Which features may be cited FOR WHICH CLAIM, and the extra condition each claim carries beyond "one of
 * its features is material". Both halves are re-derived at adjudication; neither is taken on trust.
 */
const CLAIM_RULES: Record<
  HypothesisClaim,
  { admissible: readonly FeatureKey[]; extra?: (f: FeatureVector) => boolean }
> = {
  missed_increment: {
    admissible: ['netChangePct', 'netChangePctZ', 'grossChangePct', 'grossChangePctZ'],
    // The GROUP must actually have moved up, and this person must be below it. Without this the claim is
    // indistinguishable from `out_of_step_with_peers` and would be picked by name rather than by shape.
    extra: (f) =>
      f.cohort.median.netChangePct !== null &&
      f.cohort.median.netChangePct >= 1 &&
      f.values.netChangePct !== null &&
      f.values.netChangePct < f.cohort.median.netChangePct,
  },
  out_of_step_with_peers: {
    admissible: ['netChangePct', 'netChangePctZ', 'grossChangePct', 'grossChangePctZ'],
  },
  component_drift: {
    admissible: [
      'otShareOfGrossPct',
      'otShareOfGrossPctZ',
      'allowanceShareOfGrossPct',
      'allowanceShareOfGrossPctZ',
    ],
  },
  deduction_outlier: {
    admissible: ['deductionShareOfGrossPct', 'deductionShareOfGrossPctZ'],
  },
  statutory_category_doubt: {
    admissible: ['statutoryShareOfGrossPct', 'statutoryShareOfGrossPctZ'],
  },
};

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The feature vector — PURE, no I/O, no clock, exactly like the detectors
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

export type FeatureVector = {
  values: Record<FeatureKey, number | null>;
  cohort: {
    size: number;
    /**
     * The group's middle for each BASE feature — the thing a person is unusual RELATIVE TO. It is what
     * `missed_increment` pivots on, what the absolute floor measures a deviation from, and the only
     * cohort figure the model is shown.
     */
    median: Record<FeatureKey, number | null>;
  };
};

/** A z-score below this cannot be cited, whatever the model says about it. */
export const Z_MATERIAL = 1.5;

/**
 * ⚠️ **THE ABSOLUTE FLOOR IS AS LOAD-BEARING AS THE Z-SCORE, AND ONLY ONE OF THEM IS OBVIOUS.**
 *
 * In an ordinary month most employees' pay does not move AT ALL, so the spread of `netChangePct` across a
 * run is near zero and anybody who moved half a percent scores a colossal z. Without a floor this layer
 * would spend a provider call on every rounding difference on the run and call it an outlier. The floor
 * is in the feature's own unit: percentage points.
 */
const ABS_FLOOR: Record<FeatureKey, number> = {
  netChangePct: 2,
  grossChangePct: 2,
  otShareOfGrossPct: 2,
  allowanceShareOfGrossPct: 2,
  deductionShareOfGrossPct: 2,
  statutoryShareOfGrossPct: 1,
  netChangePctZ: 2,
  grossChangePctZ: 2,
  otShareOfGrossPctZ: 2,
  allowanceShareOfGrossPctZ: 2,
  deductionShareOfGrossPctZ: 2,
  statutoryShareOfGrossPctZ: 1,
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Robust first, ordinary second, null last — and the fallback is the point.
 *
 * A median-absolute-deviation z is the right statistic for payroll: a handful of directors inflate σ
 * until nothing else looks unusual. But MAD is ZERO whenever more than half the run has the identical
 * value, which for "how much did your pay change" is the NORMAL case — so a MAD-only implementation
 * would silently produce no candidates on exactly the runs this layer is for. Falling back to σ handles
 * that: when almost everybody is identical, σ is small and the few who moved score high, which is the
 * correct reading of "everyone stayed put and this one did not".
 */
function zScores(xs: (number | null)[]): { z: (number | null)[]; median: number | null } {
  const present = xs.filter((x): x is number => x !== null);
  if (present.length < 4) return { z: xs.map(() => null), median: median(present) };
  const med = median(present)!;
  const mad = median(present.map((x) => Math.abs(x - med)))!;
  const scale =
    mad > 0
      ? 1.4826 * mad
      : Math.sqrt(present.reduce((a, x) => a + (x - med) ** 2, 0) / present.length);
  if (!(scale > 0)) return { z: xs.map(() => null), median: med };
  return { z: xs.map((x) => (x === null ? null : round1((x - med) / scale))), median: med };
}

const shareOfGross = (f: PayslipFigures, part: number): number | null =>
  f.grossPay > 0 ? round1((part / f.grossPay) * 100) : null;

const changePct = (now: number, before: number | undefined): number | null =>
  before === undefined || before === 0 ? null : round1(((now - before) / Math.abs(before)) * 100);

const statutoryTotal = (f: PayslipFigures) =>
  Object.values(f.statutory).reduce((a, v) => a + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);

/** The person's own shape. Peer-relative keys are filled in by `buildFeatures`, which sees the run. */
function ownShape(ctx: DetectorContext): Record<FeatureKey, number | null> {
  const c = ctx.current;
  const p = ctx.prior;
  return {
    netChangePct: changePct(c.netPay, p?.netPay),
    grossChangePct: changePct(c.grossPay, p?.grossPay),
    otShareOfGrossPct: shareOfGross(c, c.overtimePay),
    allowanceShareOfGrossPct: shareOfGross(c, c.allowance),
    deductionShareOfGrossPct: shareOfGross(c, c.totalDeductions),
    statutoryShareOfGrossPct: shareOfGross(c, statutoryTotal(c)),
    netChangePctZ: null,
    grossChangePctZ: null,
    otShareOfGrossPctZ: null,
    allowanceShareOfGrossPctZ: null,
    deductionShareOfGrossPctZ: null,
    statutoryShareOfGrossPctZ: null,
  };
}

/** PURE. The whole run in, one vector per employee out. Testable against literal contexts, no database. */
export function buildFeatures(contexts: readonly DetectorContext[]): Map<string, FeatureVector> {
  const own = contexts.map(ownShape);
  const zs: Partial<Record<FeatureKey, (number | null)[]>> = {};
  const medians = Object.fromEntries(FEATURE_KEYS.map((k) => [k, null])) as Record<FeatureKey, number | null>;
  for (const [base, z] of Object.entries(Z_OF)) {
    const r = zScores(own.map((o) => o[base as FeatureKey]));
    zs[z] = r.z;
    medians[base as FeatureKey] = r.median;
    // A z-score's own middle is zero by construction. Stated rather than left undefined, because the
    // absolute floor below reads a median for whichever key it is handed.
    medians[z] = 0;
  }
  const cohort = { size: contexts.length, median: medians };
  const out = new Map<string, FeatureVector>();
  contexts.forEach((ctx, i) => {
    const values = { ...own[i] };
    for (const z of Object.values(Z_OF)) values[z] = zs[z]![i];
    out.set(ctx.employmentId, { values, cohort });
  });
  return out;
}

/**
 * May this feature be cited at all? A z-score must clear `Z_MATERIAL`; a base feature is material exactly
 * when its own z-score is — the peer comparison is what makes a share notable, not its size.
 *
 * BOTH halves must hold: the z AND the absolute floor in the feature's own unit. See `ABS_FLOOR`.
 */
export function isMaterial(f: FeatureVector, key: FeatureKey): boolean {
  const zKey = BASE_OF[key] ? key : Z_OF[key];
  const z = f.values[zKey];
  if (z === null || Math.abs(z) < Z_MATERIAL) return false;
  const base = BASE_OF[zKey];
  const value = f.values[base];
  const mid = f.cohort.median[base];
  if (value === null || mid === null) return false;
  // The floor is on the DEVIATION FROM THE GROUP, never on the raw value. An overtime share of 0% is
  // remarkable when the group sits at 15% and unremarkable when the group sits at 0.2%, and only the
  // deviation form says so. Same key, same unit, both directions.
  return Math.abs(value - mid) >= ABS_FLOOR[base];
}

/** Every feature this person could legitimately be asked about. Empty ⇒ not a candidate at all. */
export const materialKeys = (f: FeatureVector): FeatureKey[] => FEATURE_KEYS.filter((k) => isMaterial(f, k));

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The adjudicator (ADR-0084 §2.4)
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

export type HypothesisProposal = { claim: string; evidence: string[] };

/** At most three citations. A "hypothesis" resting on six fields is a summary, not a hypothesis. */
const MAX_EVIDENCE = 3;

/**
 * ADR-0084 §2.6 — **deterministic code re-derives every `evidenceRef`; a hypothesis that cannot be
 * re-derived is discarded and never becomes a finding.**
 *
 * Five refusals, each named separately, because an adjudication-pass rate that cannot say WHICH check
 * refused the output tells you the model is failing without telling you at what (0452's CHECK requires a
 * reason for exactly this reason).
 */
export function adjudicateHypothesis(p: HypothesisProposal, f: FeatureVector): Adjudication {
  if (p.claim === NOTHING_NOTABLE) {
    // A decline that cites evidence is not a decline; it is a model that did not follow the contract.
    return p.evidence.length === 0 ? { ok: true } : { ok: false, reason: 'evidence_on_decline' };
  }
  if (!(HYPOTHESIS_CLAIMS as readonly string[]).includes(p.claim)) {
    return { ok: false, reason: 'unknown_claim' };
  }
  const rule = CLAIM_RULES[p.claim as HypothesisClaim];
  if (p.evidence.length === 0 || p.evidence.length > MAX_EVIDENCE) {
    return { ok: false, reason: 'evidence_count' };
  }
  for (const key of p.evidence) {
    if (!(FEATURE_KEYS as readonly string[]).includes(key)) return { ok: false, reason: `unknown_evidence:${key}` };
    if (!rule.admissible.includes(key as FeatureKey)) return { ok: false, reason: `inadmissible_evidence:${key}` };
    // THE RE-DERIVATION. The value the citation rests on is recomputed here from the run, never read
    // back from the model's output — there is no number in the model's output to read back.
    if (!isMaterial(f, key as FeatureKey)) return { ok: false, reason: `immaterial_evidence:${key}` };
  }
  if (rule.extra && !rule.extra(f)) return { ok: false, reason: `claim_unsupported:${p.claim}` };
  return { ok: true };
}

/**
 * Claim → the i18n key under `anomaly.action`, written out rather than derived from the claim name.
 *
 * The eleven detectors all use `anomaly.action.<camelCase>` and this matches them, so a future surface
 * that renders `suggestedAction` needs no special case for a hypothesis. It is a literal map because the
 * key is a contract with six JSON files: derived from the claim name, renaming a claim would silently
 * point at a key that does not exist, and a missing message is a crash rather than a blank
 * (AGENTS 6). `test/payroll-hypothesis.test.ts` pins every entry against `messages/en.json`.
 */
const ACTION_KEY: Record<HypothesisClaim, string> = {
  missed_increment: 'hypothesisMissedIncrement',
  out_of_step_with_peers: 'hypothesisOutOfStepWithPeers',
  component_drift: 'hypothesisComponentDrift',
  deduction_outlier: 'hypothesisDeductionOutlier',
  statutory_category_doubt: 'hypothesisStatutoryCategoryDoubt',
};

/**
 * The finding an accepted hypothesis becomes.
 *
 * ⚠️ **`severity` IS THE LITERAL `'review'` AND THIS IS THE ONLY PLACE IT IS WRITTEN.** ADR-0084 §2.2:
 * a model may never raise a `block`. There is no branch here, no parameter and no claim that changes it.
 *
 * The facts are the RE-DERIVED values of the cited features, not anything the model sent back — so the
 * numbers on the operator's screen are ours, and `narrationIsFaithful` can still check any prose written
 * about this finding later without being handed the model's own arithmetic to check itself against.
 */
export function hypothesisFinding(
  claim: HypothesisClaim,
  evidence: readonly FeatureKey[],
  f: FeatureVector,
): Finding {
  // ⚠️ FILTERED, not trusted. On the cache path this is handed an evidence list read back out of the
  // ledger's jsonb WITHOUT re-adjudication (an identical digest is identical features, so the answer
  // cannot differ) — so an unknown key would index `f.values` to `undefined` and put an undefined into a
  // facts blob typed as string|number. Unreachable today; a change to FEATURE_KEYS is what would reach it.
  const cited = evidence.filter((k) => (FEATURE_KEYS as readonly string[]).includes(k));
  const facts: Record<string, string | number> = { claim, cohortSize: f.cohort.size };
  for (const key of cited) {
    const v = f.values[key];
    if (v !== null && v !== undefined) facts[key] = v;
  }
  // The group's middle for each cited base feature, so the operator sees what "unusual" was measured
  // against without having to re-run anything.
  for (const key of cited) {
    const base = BASE_OF[key] ?? key;
    const mid = f.cohort.median[base];
    if (mid !== null && mid !== undefined && !(`cohort_${base}` in facts)) facts[`cohort_${base}`] = mid;
  }
  return {
    detectorId: HYPOTHESIS_DETECTOR_ID,
    severity: 'review',
    facts,
    sourceEventIds: [],
    suggestedAction: `anomaly.action.${ACTION_KEY[claim]}`,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The run — I/O, the provider call, and the ledger
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The tenant switch, and it defaults OFF for the same reason the nudge agent's does: **there is no
 * button here.** This layer spends the tenant's own provider budget (ADR-0023, BYOK) on a schedule that
 * nobody triggered, and it puts rows in their exceptions queue that a model chose to put there. Both are
 * things a customer opts into, not things a purchased module arrives doing.
 *
 * ⚠️ EXPORTED SO TESTS AND DOCS CAN NAME IT — but `settingEnabled` below is passed the STRING LITERAL,
 * not this constant, and that duplication is deliberate. `test/module-catalog-drift.test.ts` scans call
 * sites for a literal key; a call through a variable is invisible to it, which would hide an uncatalogued
 * key — and an uncatalogued key is a 500, not a disabled feature (`getSetting` throws a bare Error).
 */
export const HYPOTHESIS_SETTING_KEY = 'payroll.anomaly_hypotheses_enabled';

/**
 * Below this many payslips there is no peer group, only noise, and the honest answer is to run nothing.
 *
 * `DataRequirement.cohortMinSize` in the detector layer exists to say exactly this, and a statistical
 * check that quietly returns "no findings" on a run too small to support it is indistinguishable from
 * one that checked and found nothing — the failure ADR-0076's `requires` declaration was written against.
 * So a run below this reports `cohortTooSmall` rather than a clean pass.
 */
export const MIN_COHORT = 8;

/** Blast radius, per batch per pass. It REFUSES rather than truncating silently: `cappedOut` says so. */
export const MAX_HYPOTHESES_PER_RUN = 25;

/**
 * How long an answer about an identical set of figures stays good.
 *
 * This is the window in which `input_digest` is treated as identity. Longer than a pay cycle on purpose —
 * the nightly sweep re-asks about the SAME processed run every night until it is closed, and paying a
 * provider forty times for forty identical questions is the cost failure ADR-0084 §5 warns about.
 */
export const HYPOTHESIS_CACHE_DAYS = 45;

/** One label and up to three field names. There is no prose in the output, so there is none to bound. */
const MAX_TOKENS = 80;

const SYSTEM = [
  'You review ONE employee’s payroll month, given only percentages and z-scores against the colleagues',
  'paid on the same run. You never see money, names, dates or identifiers.',
  'Choose exactly ONE label from this fixed list:',
  '  missed_increment — the group’s pay moved up together and this person’s did not.',
  '  out_of_step_with_peers — this person’s pay moved in a way the group did not.',
  '  component_drift — overtime or allowance is a very different share of pay than the group’s.',
  '  deduction_outlier — deductions are a very different share of pay than the group’s.',
  '  statutory_category_doubt — statutory contributions are a very different share than the group’s,',
  '    which can mean the wrong contribution category.',
  '  nothing_notable — these figures are ordinary. THIS IS THE CORRECT ANSWER MOST OF THE TIME; choose a',
  '    label only when one of the five plainly fits.',
  'Then cite the field names that led you there, copied EXACTLY from the fields you were given, at most',
  'three. Cite nothing at all for nothing_notable.',
  'Respond with ONLY one minified JSON object: {"claim":"<label>","evidence":["<fieldName>",...]}',
  'No markdown, no code fences, no explanation, no numbers.',
].join(' ');

/** What the model is shown. Non-null features only, each with the group’s middle beside it. */
function featuresAsText(f: FeatureVector): string {
  const lines = [`colleagues on this run: ${f.cohort.size}`];
  for (const key of FEATURE_KEYS) {
    const v = f.values[key];
    if (v === null) continue;
    const mid = BASE_OF[key] ? null : f.cohort.median[key];
    lines.push(mid === null || mid === undefined ? `${key}: ${v}` : `${key}: ${v} (group ${mid})`);
  }
  return lines.join('\n');
}

/** Best-effort extraction of the one JSON object, tolerating fences and stray prose. */
function parseProposal(text: string): HypothesisProposal | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as { claim?: unknown; evidence?: unknown };
    if (typeof o?.claim !== 'string') return null;
    const evidence = Array.isArray(o.evidence)
      ? o.evidence.filter((x): x is string => typeof x === 'string')
      : typeof o.evidence === 'string'
        ? [o.evidence]
        : [];
    return { claim: o.claim.trim(), evidence };
  } catch {
    return null;
  }
}

export type HypothesisRun = {
  /** The tenant has not switched this on. Everything else is zero and nothing was spent. */
  disabled: boolean;
  /** No AI provider configured, and nothing left to answer from the ledger. */
  notConfigured: boolean;
  /** Fewer than MIN_COHORT payslips: no peer group, so nothing ran. Not a clean pass. */
  cohortTooSmall: boolean;
  /** Auto-cleared, unresolved employees with at least one material feature. */
  candidates: number;
  /** Provider calls actually made. */
  asked: number;
  /** Answered from an earlier identical proposal instead of a provider call. */
  cached: number;
  /** Hypotheses that survived adjudication and became a `review` finding. */
  raised: number;
  /** The model said the figures were ordinary. A valid, accepted, and expected answer. */
  declined: number;
  /** Output that failed adjudication and was discarded silently. */
  rejected: number;
  /** Not re-raised: a human already resolved this exact shape as a false positive. */
  suppressed: number;
  /** The run stopped at MAX_HYPOTHESES_PER_RUN with candidates left. */
  cappedOut: boolean;
};

const EMPTY: HypothesisRun = {
  disabled: false,
  notConfigured: false,
  cohortTooSmall: false,
  candidates: 0,
  asked: 0,
  cached: 0,
  raised: 0,
  declined: 0,
  rejected: 0,
  suppressed: 0,
  cappedOut: false,
};

/**
 * One batch's hypothesis pass. Idempotent, and safe to run repeatedly.
 *
 * ⚠️ **CANDIDATES ARE THE AUTO-CLEARED, AND ONLY THE AUTO-CLEARED.** Three reasons, and the third is the
 * one that matters most:
 *
 *  1. An employee the rules already flagged is already going to a human. A hypothesis on top of that
 *     adds noise to a row somebody is about to read anyway, and spends a call to do it.
 *  2. It makes the human's verdict ATTRIBUTABLE. A resolution is recorded per VERDICT, not per finding,
 *     so on a verdict carrying both a rule finding and a hypothesis, "not a real problem" says nothing
 *     about which one was wrong. Here the hypothesis is the only finding on the row by construction, so
 *     `agent_proposal.decision` means what §2.3 says it means.
 *  3. It is the machine performing its own FALSE-NEGATIVE check — the rate ADR-0076 §5 says governs
 *     autonomy and which has never had anything but a human route to a numerator.
 *
 * Nothing here can change a figure, and nothing here can produce a `block`.
 */
export async function proposeHypotheses(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<HypothesisRun> {
  // The literal, not HYPOTHESIS_SETTING_KEY — see that constant's note.
  if (!settingEnabled(ctx, 'payroll.anomaly_hypotheses_enabled')) return { ...EMPTY, disabled: true };

  const contexts = await loadBatchContexts(ctx, { batchId: p.batchId });
  if (!contexts) throw new Error('batch not found');
  if (contexts.length < MIN_COHORT) return { ...EMPTY, cohortTooSmall: true };

  const features = buildFeatures(contexts);

  const verdicts = await withTenant(ctx, (tx) =>
    tx
      .select({
        id: schema.payrollAnomalyVerdict.id,
        employmentId: schema.payrollAnomalyVerdict.employmentId,
      })
      .from(schema.payrollAnomalyVerdict)
      .where(
        and(
          eq(schema.payrollAnomalyVerdict.batchId, p.batchId),
          eq(schema.payrollAnomalyVerdict.disposition, 'auto_clear'),
          isNull(schema.payrollAnomalyVerdict.supersededAt),
          isNull(schema.payrollAnomalyVerdict.resolvedAt),
        ),
      ),
  );

  // WORST FIRST, so the blast-radius cap keeps the most unusual rather than the alphabetically luckiest.
  const candidates = verdicts
    .map((v) => ({ ...v, f: features.get(v.employmentId) }))
    .filter((c): c is { id: string; employmentId: string; f: FeatureVector } => c.f !== undefined)
    .map((c) => ({ ...c, keys: materialKeys(c.f) }))
    .filter((c) => c.keys.length > 0)
    .map((c) => ({
      ...c,
      peak: Math.max(...c.keys.map((k) => Math.abs(c.f.values[BASE_OF[k] ? k : Z_OF[k]] ?? 0))),
    }))
    .sort((a, b) => b.peak - a.peak);

  const out: HypothesisRun = { ...EMPTY, candidates: candidates.length };
  if (candidates.length === 0) return out;

  const cutoff = new Date(Date.now() - HYPOTHESIS_CACHE_DAYS * 24 * 60 * 60 * 1000);
  // Resolved lazily and ONCE: a pass whose every candidate is answered from the ledger must not need a
  // provider at all, which is what makes the nightly re-ask free after the first night.
  let cfg: Awaited<ReturnType<typeof resolveActiveAiConfig>> | null = null;
  let cfgResolved = false;

  const writes: { verdictId: string; finding: Finding; proposalId: string | null }[] = [];

  // ⚠️ ONE COUNTER, INCREMENTED ONCE PER CANDIDATE. The outcome counters below overlap deliberately —
  // a cache hit that becomes a finding is both `cached` and a write — so summing them to decide the cap
  // would trip it at roughly half the intended number and report `cappedOut` on a run that had not
  // reached it. The cap is about how many PEOPLE this pass may look at, which is exactly this.
  let looked = 0;

  for (const c of candidates) {
    if (looked >= MAX_HYPOTHESES_PER_RUN) {
      out.cappedOut = true;
      break;
    }
    looked++;
    // The SAME object is hashed for the cache lookup and handed to `recordProposal`, so the identity the
    // ledger records and the identity this reads back cannot drift apart.
    const facts = { employmentId: c.employmentId, values: c.f.values, cohort: c.f.cohort };
    const digest = digestOf(facts);

    const [prior] = await withTenant(ctx, (tx) =>
      tx
        .select({
          id: schema.agentProposal.id,
          proposal: schema.agentProposal.proposal,
          adjudication: schema.agentProposal.adjudication,
          decision: schema.agentProposal.decision,
        })
        .from(schema.agentProposal)
        .where(
          and(
            eq(schema.agentProposal.proposalType, 'anomaly_hypothesis'),
            eq(schema.agentProposal.inputDigest, digest),
            gte(schema.agentProposal.proposedAt, cutoff),
          ),
        )
        .orderBy(desc(schema.agentProposal.proposedAt))
        .limit(1),
    );

    if (prior) {
      out.cached++;
      // ⚠️ THE LEARNING LINE. A human looked at this exact shape and said it was not a real problem.
      // Raising it again every night would be the system arguing with an operator who has already
      // answered — and it is the cheapest form of §2.4's learn half that exists today.
      if (prior.decision === 'declined') {
        out.suppressed++;
        continue;
      }
      if (prior.adjudication !== 'accepted') continue;
      const cachedClaim = (prior.proposal as { claim?: unknown })?.claim;
      const cachedEvidence = ((prior.proposal as { evidence?: unknown })?.evidence ?? []) as FeatureKey[];
      if (typeof cachedClaim !== 'string' || cachedClaim === NOTHING_NOTABLE) {
        out.declined++;
        continue;
      }
      // No re-adjudication: an identical digest IS identical features, so re-deriving would recompute
      // the same answer from the same numbers. The link points at the ORIGINAL proposal, not a copy.
      writes.push({
        verdictId: c.id,
        finding: hypothesisFinding(cachedClaim as HypothesisClaim, cachedEvidence, c.f),
        proposalId: prior.id,
      });
      continue;
    }

    if (!cfgResolved) {
      cfg = await withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx)).catch(() => null);
      cfgResolved = true;
    }
    // NOT an error, and nothing is recorded: a tenant with no provider proposed nothing, and counting
    // that as a model failure would drag the adjudication-pass rate down measuring the wrong thing.
    if (!cfg) {
      out.notConfigured = true;
      break;
    }

    let raw = '';
    try {
      raw = await generateDraft(cfg, {
        system: SYSTEM,
        prompt: featuresAsText(c.f),
        maxTokens: MAX_TOKENS,
      });
    } catch {
      // Provider down, timed out, refused. Nothing proposed, nothing recorded; the next pass re-asks.
      continue;
    }
    out.asked++;

    const parsed = parseProposal(raw);
    const adjudication: Adjudication = parsed
      ? adjudicateHypothesis(parsed, c.f)
      : { ok: false, reason: 'unparseable_output' };

    const proposalId = await recordProposal(ctx, {
      type: 'anomaly_hypothesis',
      subject: { type: 'employment', id: c.employmentId },
      facts,
      // Kept whatever the verdict: an output that cited a field it was never given is exactly what you
      // want to read back when asking why the pass rate fell after a model upgrade.
      proposal: { claim: parsed?.claim ?? null, evidence: parsed?.evidence ?? [] },
      adjudication,
      provider: cfg.provider,
      model: cfg.model,
    });

    if (!adjudication.ok) {
      // DISCARDED SILENTLY (§2.2). No screen ever says "the model suggested something we could not
      // verify" — that hands the checking to the reader, which is the one thing this harness prevents.
      out.rejected++;
      continue;
    }
    if (parsed!.claim === NOTHING_NOTABLE) {
      out.declined++;
      continue;
    }
    writes.push({
      verdictId: c.id,
      finding: hypothesisFinding(parsed!.claim as HypothesisClaim, parsed!.evidence as FeatureKey[], c.f),
      proposalId,
    });
  }

  if (writes.length > 0) {
    await withTenant(ctx, async (tx) => {
      await tx.insert(schema.payrollAnomalyFinding).values(
        writes.map((w) => ({
          tenantId: ctx.tenantId,
          verdictId: w.verdictId,
          detectorId: w.finding.detectorId,
          severity: w.finding.severity,
          facts: w.finding.facts,
          sourceEventIds: w.finding.sourceEventIds,
          suggestedAction: w.finding.suggestedAction,
          proposalId: w.proposalId,
        })),
      );
      // The verdict has to move with its findings: `resolveDisposition` says any `review` finding makes
      // the verdict a `review`, and a row left at `auto_clear` while carrying one would be invisible on
      // the queue (which splits on disposition) as well as internally inconsistent.
      await tx
        .update(schema.payrollAnomalyVerdict)
        .set({ disposition: 'review' })
        .where(
          inArray(
            schema.payrollAnomalyVerdict.id,
            writes.map((w) => w.verdictId),
          ),
        );
    });
    out.raised = writes.length;
  }

  return out;
}
