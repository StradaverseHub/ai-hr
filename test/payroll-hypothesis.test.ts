/**
 * ADR-0084 §2.6 — the hypothesis layer's PURE half. NO DATABASE and NO PROVIDER.
 *
 * The whole design rests on one claim: **a model may propose anything, and nothing it produced reaches a
 * screen until deterministic code has re-derived it.** That claim is only worth as much as this file —
 * `adjudicateHypothesis` is the code in question, and every one of its refusals is exercised below,
 * because a refusal nobody tests is a refusal nobody knows still works.
 *
 * Three of these cases guard something that would otherwise fail INVISIBLY on the screen rather than in
 * the suite: the severity ceiling, the claim→i18n-key map on the queue page, and the prompt's own list of
 * labels. All three are contracts BETWEEN two files, which AGENTS 17 says a unit test of either half
 * passes throughout — so they are asserted across both.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  FEATURE_KEYS,
  HYPOTHESIS_CLAIMS,
  MIN_COHORT,
  NOTHING_NOTABLE,
  Z_MATERIAL,
  adjudicateHypothesis,
  buildFeatures,
  hypothesisFinding,
  isMaterial,
  materialKeys,
  type FeatureKey,
  type FeatureVector,
} from '../core/payroll-hypothesis';
import { HYPOTHESIS_DETECTOR_ID, type DetectorContext, type PayslipFigures } from '../core/payroll-anomaly-detectors';
import en from '../messages/en.json';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const figures = (over: Partial<PayslipFigures> = {}): PayslipFigures => ({
  grossPay: 5000,
  netPay: 4200,
  basicSalary: 5000,
  allowance: 0,
  overtimePay: 0,
  bonus: 0,
  totalDeductions: 800,
  daysWorked: 31,
  statutory: { epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 215 },
  ...over,
});

const ctxOf = (id: string, current: Partial<PayslipFigures>, prior: Partial<PayslipFigures> | null): DetectorContext => ({
  employmentId: id,
  current: figures(current),
  prior: prior === null ? null : figures(prior),
  profile: {
    hasBankProfile: true,
    hasTaxProfile: true,
    paymentMethod: 'bank_transfer',
    hiredOn: '2020-01-01',
    terminatedOn: null,
    concurrentPaidEmploymentIds: [],
  },
  activity: { attendanceDays: 22, approvedLeaveDays: 0 },
  period: { start: '2026-08-01', end: '2026-08-31', calendarDays: 31 },
  caps: {},
  eventIds: [],
});

/** A run of `n` people who all moved by `movedPct`, plus whatever odd ones the caller adds. */
function run(n: number, movedPct: number, extra: DetectorContext[] = []): DetectorContext[] {
  const base = Array.from({ length: n }, (_, i) =>
    ctxOf(`peer-${i}`, { netPay: 4200 * (1 + movedPct / 100), grossPay: 5000 * (1 + movedPct / 100) }, { netPay: 4200, grossPay: 5000 }),
  );
  return [...base, ...extra];
}

/** The vector for one employment out of a built run. */
const vec = (contexts: DetectorContext[], id: string): FeatureVector => {
  const f = buildFeatures(contexts).get(id);
  if (!f) throw new Error(`no vector for ${id}`);
  return f;
};

describe('the feature vector is dimensionless and peer-relative', () => {
  it('carries no money: every feature is a percentage, a share or a z-score', () => {
    const f = vec(run(10, 4), 'peer-0');
    for (const key of FEATURE_KEYS) {
      const v = f.values[key];
      if (v === null) continue;
      // 4200 and 5000 are the fixture's ringgit figures. No feature may be equal to one.
      expect(Math.abs(v), key).toBeLessThan(1000);
    }
    expect(JSON.stringify(f)).not.toContain('4200');
  });

  it('a peer group that all moved together makes the one who did not the outlier', () => {
    // Everyone up 6%; one person flat. THE POINT OF THE WHOLE LAYER: `net-swing` wants 30% and is silent.
    const flat = ctxOf('odd', { netPay: 4200, grossPay: 5000 }, { netPay: 4200, grossPay: 5000 });
    const contexts = run(12, 6, [flat]);
    const odd = vec(contexts, 'odd');
    const peer = vec(contexts, 'peer-0');

    expect(odd.values.netChangePct).toBe(0);
    expect(peer.values.netChangePct).toBeCloseTo(6, 1);
    expect(Math.abs(odd.values.netChangePctZ!)).toBeGreaterThan(Z_MATERIAL);
    expect(peer.values.netChangePctZ).toBe(0);
    expect(odd.cohort.median.netChangePct).toBeCloseTo(6, 1);
  });

  it('falls back from MAD to sigma, which is the case a MAD-only version would silently miss', () => {
    // More than half the run is IDENTICAL, so the median absolute deviation is exactly zero — the normal
    // shape of "how much did your pay change" in an ordinary month.
    const mover = ctxOf('mover', { netPay: 4620, grossPay: 5500 }, { netPay: 4200, grossPay: 5000 });
    const contexts = run(12, 0, [mover]);
    expect(vec(contexts, 'peer-0').values.netChangePct).toBe(0);
    const z = vec(contexts, 'mover').values.netChangePctZ;
    expect(z, 'a MAD of zero must not produce a null z for everybody').not.toBeNull();
    expect(Math.abs(z!)).toBeGreaterThan(Z_MATERIAL);
  });

  it('a z-score alone is not enough — the absolute floor refuses a rounding difference', () => {
    // Everyone flat, one person up 0.5%. The z is enormous (nobody else moved at all) and the movement
    // is noise. Without the floor this layer would spend a provider call on every one of these.
    const tiny = ctxOf('tiny', { netPay: 4221, grossPay: 5025 }, { netPay: 4200, grossPay: 5000 });
    const contexts = run(12, 0, [tiny]);
    const f = vec(contexts, 'tiny');
    expect(Math.abs(f.values.netChangePctZ!)).toBeGreaterThan(Z_MATERIAL);
    expect(isMaterial(f, 'netChangePct'), 'a 0.5% move is below the absolute floor').toBe(false);
    expect(materialKeys(f)).not.toContain('netChangePctZ');
  });

  it('an ordinary member of an ordinary run is not a candidate at all', () => {
    expect(materialKeys(vec(run(14, 4), 'peer-3'))).toHaveLength(0);
  });
});

describe('adjudication re-derives every citation (§2.6)', () => {
  const contexts = () => {
    const flat = ctxOf('odd', { netPay: 4200, grossPay: 5000 }, { netPay: 4200, grossPay: 5000 });
    return run(12, 6, [flat]);
  };

  it('accepts a claim whose cited field really is material and whose condition really holds', () => {
    const f = vec(contexts(), 'odd');
    expect(adjudicateHypothesis({ claim: 'missed_increment', evidence: ['netChangePctZ'] }, f)).toEqual({ ok: true });
  });

  it('refuses a label that is not in the closed vocabulary', () => {
    const f = vec(contexts(), 'odd');
    const a = adjudicateHypothesis({ claim: 'salary_looks_wrong', evidence: ['netChangePctZ'] }, f);
    expect(a).toEqual({ ok: false, reason: 'unknown_claim' });
  });

  it('refuses a field the model was never given — the hallucinated citation', () => {
    const f = vec(contexts(), 'odd');
    const a = adjudicateHypothesis({ claim: 'missed_increment', evidence: ['bonusZ'] }, f);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toBe('unknown_evidence:bonusZ');
  });

  it('refuses a real field that is not admissible for the claim it was cited for', () => {
    const f = vec(contexts(), 'odd');
    const a = adjudicateHypothesis({ claim: 'deduction_outlier', evidence: ['netChangePctZ'] }, f);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toBe('inadmissible_evidence:netChangePctZ');
  });

  it('refuses a real, admissible field that is not actually unusual — the citation of noise', () => {
    const f = vec(contexts(), 'peer-0');
    const a = adjudicateHypothesis({ claim: 'out_of_step_with_peers', evidence: ['netChangePctZ'] }, f);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toBe('immaterial_evidence:netChangePctZ');
  });

  it("refuses `missed_increment` when the GROUP did not move — the claim's own condition", () => {
    // The odd one out moved DOWN while everybody else stayed put. The evidence is material and
    // admissible, so only the claim-specific condition can refuse this, and it must.
    const dropped = ctxOf('odd', { netPay: 3800, grossPay: 4500 }, { netPay: 4200, grossPay: 5000 });
    const f = vec(run(12, 0, [dropped]), 'odd');
    expect(isMaterial(f, 'netChangePctZ')).toBe(true);
    const a = adjudicateHypothesis({ claim: 'missed_increment', evidence: ['netChangePctZ'] }, f);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toBe('claim_unsupported:missed_increment');
    // …and the general claim over the same evidence IS accepted, which is what makes the two distinct.
    expect(adjudicateHypothesis({ claim: 'out_of_step_with_peers', evidence: ['netChangePctZ'] }, f)).toEqual({
      ok: true,
    });
  });

  it('refuses a claim with no citation, and one with more citations than a hypothesis can have', () => {
    const f = vec(contexts(), 'odd');
    expect(adjudicateHypothesis({ claim: 'missed_increment', evidence: [] }, f)).toEqual({
      ok: false,
      reason: 'evidence_count',
    });
    expect(
      adjudicateHypothesis(
        { claim: 'missed_increment', evidence: ['netChangePct', 'netChangePctZ', 'grossChangePct', 'grossChangePctZ'] },
        f,
      ),
    ).toEqual({ ok: false, reason: 'evidence_count' });
  });

  it('accepts `nothing_notable` — the answer the layer needs most — but not one that cites evidence', () => {
    const f = vec(contexts(), 'odd');
    expect(adjudicateHypothesis({ claim: NOTHING_NOTABLE, evidence: [] }, f)).toEqual({ ok: true });
    expect(adjudicateHypothesis({ claim: NOTHING_NOTABLE, evidence: ['netChangePctZ'] }, f)).toEqual({
      ok: false,
      reason: 'evidence_on_decline',
    });
  });
});

describe('the ceiling and the facts', () => {
  it('a hypothesis finding is ALWAYS review, and the source says so exactly once', () => {
    const flat = ctxOf('odd', { netPay: 4200, grossPay: 5000 }, { netPay: 4200, grossPay: 5000 });
    const f = vec(run(12, 6, [flat]), 'odd');
    for (const claim of HYPOTHESIS_CLAIMS) {
      expect(hypothesisFinding(claim, ['netChangePctZ'], f).severity, claim).toBe('review');
    }

    // ADR-0084 §2.2 — a model may never raise a `block`. Structural, not a parameter: there is one
    // severity literal in the whole file and it is not that one.
    const src = read('core/payroll-hypothesis.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/severity:\s*'block'/);
    expect([...code.matchAll(/severity:\s*'review'/g)]).toHaveLength(1);
  });

  it('the facts are OUR re-derived numbers plus the group middle, never anything the model sent', () => {
    const flat = ctxOf('odd', { netPay: 4200, grossPay: 5000 }, { netPay: 4200, grossPay: 5000 });
    const f = vec(run(12, 6, [flat]), 'odd');
    const finding = hypothesisFinding('missed_increment', ['netChangePct', 'netChangePctZ'], f);
    expect(finding.detectorId).toBe(HYPOTHESIS_DETECTOR_ID);
    expect(finding.facts.claim).toBe('missed_increment');
    expect(finding.facts.netChangePct).toBe(f.values.netChangePct);
    expect(finding.facts.netChangePctZ).toBe(f.values.netChangePctZ);
    expect(finding.facts.cohort_netChangePct).toBe(f.cohort.median.netChangePct);
    expect(finding.facts.cohortSize).toBe(13);
    // Provenance is empty rather than borrowed: a hypothesis is derived from the run, not from an event.
    expect(finding.sourceEventIds).toEqual([]);
  });

  it('suggestedAction is an i18n KEY in the same shape the eleven detectors use', () => {
    const flat = ctxOf('odd', { netPay: 4200, grossPay: 5000 }, { netPay: 4200, grossPay: 5000 });
    const f = vec(run(12, 6, [flat]), 'odd');
    for (const claim of HYPOTHESIS_CLAIMS) {
      const key = hypothesisFinding(claim, ['netChangePctZ'], f).suggestedAction;
      expect(key, claim).toMatch(/^anomaly\.action\.[A-Za-z]+$/);
      expect(
        (en.anomaly.action as Record<string, string>)[key.replace('anomaly.action.', '')],
        `messages/en.json ${key}`,
      ).toBeTruthy();
    }
  });
});

describe('the contracts between files that nothing else checks', () => {
  /**
   * AGENTS 6 / rule 17. The queue page maps a claim to a sentence BY HAND; a claim added to the union
   * without a line there renders a finding with no explanation, and one whose key is mistyped throws
   * MISSING_MESSAGE — a tsc-clean, suite-green, 200-returning crash.
   */
  it('every claim has a line on the queue page and a string behind it', () => {
    const page = read('app/payroll/[batchId]/anomalies/page.tsx');
    for (const claim of HYPOTHESIS_CLAIMS) {
      expect(page, `queue page has no copy for '${claim}'`).toContain(`${claim}: t('action.hypothesis`);
    }
  });

  /**
   * The prompt lists the labels the model may choose from. A claim added to the union but not to the
   * prompt can never be proposed (dead code); a label in the prompt but not in the union is rejected on
   * every single call as `unknown_claim`, which reads as a broken model rather than a stale prompt.
   */
  it('the prompt names exactly the closed vocabulary, in both directions', () => {
    const src = read('core/payroll-hypothesis.ts');
    const system = src.slice(src.indexOf('const SYSTEM = ['), src.indexOf("].join(' ');", src.indexOf('const SYSTEM = [')));
    for (const claim of [...HYPOTHESIS_CLAIMS, NOTHING_NOTABLE]) {
      expect(system, `the prompt never offers '${claim}'`).toContain(claim);
    }
    for (const label of [...system.matchAll(/^\s*'?\s{2}([a-z_]{6,})\s—/gm)].map((m) => m[1]!)) {
      expect([...HYPOTHESIS_CLAIMS, NOTHING_NOTABLE], `prompt offers '${label}', which is not a claim`).toContain(
        label,
      );
    }
  });

  it('the tenant switch is catalogued, and the call site passes the literal the drift guard can see', () => {
    const src = read('core/payroll-hypothesis.ts');
    expect(src).toContain("settingEnabled(ctx, 'payroll.anomaly_hypotheses_enabled')");
    const catalog = read('packs/catalog.ts');
    expect(catalog).toContain("key: 'payroll.anomaly_hypotheses_enabled'");
    expect(catalog).toContain("'payroll.anomaly_hypotheses_enabled': null");
  });

  it('a peer group has a minimum size, and it is big enough to mean something', () => {
    expect(MIN_COHORT).toBeGreaterThanOrEqual(8);
  });
});
