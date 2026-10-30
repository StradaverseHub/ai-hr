/** WP14 baseline suites: fixed inputs, deterministic adjudication and the same state rule as the SQL owner (0694).
 * Source/unit checks only; no database or provider. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROMPT_HOLDOUTS } from '../lib/ai/module-agent-prompt-candidate';
import { HUMAN_PLAN_HOLDOUTS } from '../lib/ai/human-plan-holdouts';
import {
  PROVIDER_BASELINE_SUITES, PROVIDER_BASELINE_SUITE_IDS, PROVIDER_BASELINE_SUITE_DIGEST, PROVIDER_BASELINE_REQUEST_LIMIT,
  captureProviderBaselineProgress, initialProviderBaselineProgress, providerBaselineCasePassed, providerBaselineState,
} from '../lib/ai/provider-baseline-suites';

describe('provider change baseline suites', () => {
  it('re-uses every independent holdout once, with unique prompts and a stable digest', () => {
    expect(PROVIDER_BASELINE_SUITE_IDS).toEqual(['read_plan', 'human_plan']);
    expect(PROVIDER_BASELINE_SUITES.read_plan).toHaveLength(PROMPT_HOLDOUTS.length);
    expect(PROVIDER_BASELINE_SUITES.human_plan).toHaveLength(HUMAN_PLAN_HOLDOUTS.length);
    expect(PROMPT_HOLDOUTS.length).toBeGreaterThan(100); expect(HUMAN_PLAN_HOLDOUTS.length).toBe(12);
    const prompts = Object.values(PROVIDER_BASELINE_SUITES).flat().map(row => row.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(PROVIDER_BASELINE_SUITE_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(PROVIDER_BASELINE_REQUEST_LIMIT).toBeGreaterThan(0); expect(PROVIDER_BASELINE_REQUEST_LIMIT).toBeLessThanOrEqual(24);
    // Refusal cases are present in both suites: a model that plans every request as a read cannot pass.
    for (const id of PROVIDER_BASELINE_SUITE_IDS) expect(PROVIDER_BASELINE_SUITES[id].some(row => row.decision === 'refuse'), id).toBe(true);
  });
  it('passes only the exact expected decision and module set', () => {
    const read = PROVIDER_BASELINE_SUITES.read_plan.find(row => row.decision === 'read' && row.modules.length === 1)!;
    const refuse = PROVIDER_BASELINE_SUITES.read_plan.find(row => row.decision === 'refuse')!;
    expect(providerBaselineCasePassed(read, JSON.stringify({ decision: 'read', modules: [...read.modules] }))).toBe(true);
    expect(providerBaselineCasePassed(refuse, JSON.stringify({ decision: 'refuse', modules: [] }))).toBe(true);
    for (const text of [JSON.stringify({ decision: 'read', modules: [read.modules[0] === 'payroll' ? 'leave' : 'payroll'] }), JSON.stringify({ decision: 'refuse', modules: [] }),
      'I passed', JSON.stringify({ decision: 'read', modules: [...read.modules], note: 'extra' }), 42, null])
      expect(providerBaselineCasePassed(read, text)).toBe(false);
    expect(providerBaselineCasePassed(refuse, JSON.stringify({ decision: 'read', modules: ['payroll'] }))).toBe(false);
  });
  it('derives the run state the same way as the SQL owner and refuses malformed progress', () => {
    const start = initialProviderBaselineProgress();
    expect(start).toEqual({ read_plan: { total: PROMPT_HOLDOUTS.length, passed: 0, failed: 0, next: 0 }, human_plan: { total: 12, passed: 0, failed: 0, next: 0 } });
    expect(providerBaselineState(start)).toBe('evaluating');
    expect(providerBaselineState({ ...start, read_plan: { ...start.read_plan, next: 1, failed: 1 } })).toBe('failed');
    const done = { read_plan: { ...start.read_plan, passed: start.read_plan.total, next: start.read_plan.total }, human_plan: { total: 12, passed: 12, failed: 0, next: 12 } };
    expect(providerBaselineState(done)).toBe('passed');
    expect(captureProviderBaselineProgress(JSON.parse(JSON.stringify(done)))).toEqual(done);
    for (const bad of [null, [], {}, { read_plan: start.read_plan }, { ...start, extra: start.read_plan }, { ...start, read_plan: { ...start.read_plan, next: 1 } },
      { ...start, read_plan: { ...start.read_plan, next: start.read_plan.total + 1, passed: start.read_plan.total + 1 } }, { ...start, read_plan: { ...start.read_plan, passed: -1, failed: 1 } }])
      expect(() => captureProviderBaselineProgress(bad)).toThrow();
    const sql = readFileSync('db/migrations/0814_ai_provider_change_gate.sql', 'utf8');
    expect(sql).toContain("RETURN CASE WHEN failing THEN 'failed' WHEN complete THEN 'passed' ELSE 'evaluating' END;");
  });
});
