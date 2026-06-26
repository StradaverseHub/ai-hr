/**
 * Payroll Setup — AI-assisted pay-rule drafting (core/pay-rule-ai.ts). Contract under test:
 *   - draft-only: a draft NEVER writes to any pay table (pay_component is untouched);
 *   - graceful degradation: with the gateway unconfigured the feature is OFF (PayRuleDraftError, no LLM call);
 *   - PII redaction: emails / IC numbers in the description are scrubbed before they reach the gateway;
 *   - one-shot: invalid model JSON ⇒ a SINGLE PayRuleDraftError (generateDraft called exactly once, no retry);
 *   - auditability: a valid draft appends pay-component.ai-rule-drafted with an { type: 'agent' } actor and a
 *     PII-free payload (provider/model/componentCode/ruleKind only — never the description).
 *
 * Mocks mirror test/performance-ai-draft.test.ts: lib/ai's generateDraft is stubbed (redactPII stays REAL via
 * importActual) and core/ai-config's resolveActiveAiConfig is stubbed — no SDK, no network, no real key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ai', async (importActual) => {
  const actual = await importActual<typeof import('../lib/ai')>();
  return {
    ...actual, // keep redactPII real
    generateDraft: vi.fn(async () => JSON.stringify({ rule: { kind: 'percent_of', base: 'basic', pct: 10 }, explanation: 'Ten percent of basic salary.' })),
  };
});

vi.mock('../core/ai-config', async (importActual) => {
  const actual = await importActual<typeof import('../core/ai-config')>();
  return {
    ...actual,
    resolveActiveAiConfig: vi.fn(async () => ({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-test' })),
  };
});

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { generateDraft } from '../lib/ai';
import { resolveActiveAiConfig } from '../core/ai-config';
import { draftPayRule, PayRuleDraftError } from '../core/pay-rule-ai';
import { adminCtx, closeAll, eventTypesFor, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('Payroll Setup — AI-assisted pay-rule drafting', () => {
  let base: Base;
  let a: SessionContext;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    a = adminCtx(base);
    vi.mocked(generateDraft)
      .mockReset()
      .mockResolvedValue(JSON.stringify({ rule: { kind: 'percent_of', base: 'basic', pct: 10 }, explanation: 'Ten percent of basic salary.' }));
    vi.mocked(resolveActiveAiConfig)
      .mockReset()
      .mockResolvedValue({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-test' });
  });
  afterAll(async () => {
    await closeAll();
  });

  it('drafts a valid rule from a redacted description, writes nothing, and audits the generation', async () => {
    const res = await draftPayRule(a, {
      description: 'Pay 10% of basic. Ask jane@acme.test (910101-01-1234) if unsure.',
      componentCode: 'HOUSING',
      componentProrates: true,
    });
    expect(res.rule).toEqual({ kind: 'percent_of', base: 'basic', pct: 10 });
    expect(res.explanation).toBe('Ten percent of basic salary.');

    // The gateway saw redacted free text — NOT the raw PII.
    expect(generateDraft).toHaveBeenCalledTimes(1);
    const { prompt } = vi.mocked(generateDraft).mock.calls[0][1];
    expect(prompt).toContain('[email]');
    expect(prompt).toContain('[id]');
    expect(prompt).not.toContain('jane@acme.test');
    expect(prompt).not.toContain('910101-01-1234');

    // Draft-only: no pay_component row was created.
    const comps = await owner.db.select().from(schema.payComponent);
    expect(comps).toHaveLength(0);

    // …but the generation is on the audit log, with an agent actor + PII-free payload.
    expect(await eventTypesFor(base.tenantId, base.tenantId)).toContain('pay-component.ai-rule-drafted');
    const payload = await latestEventPayload(base.tenantId, base.tenantId, 'pay-component.ai-rule-drafted');
    expect(payload).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8', componentCode: 'HOUSING', ruleKind: 'percent_of' });
    expect(JSON.stringify(payload)).not.toContain('jane@acme.test');
  });

  it('is OFF when no AI config resolves (PayRuleDraftError, no LLM call)', async () => {
    vi.mocked(resolveActiveAiConfig).mockResolvedValue(null);
    await expect(draftPayRule(a, { description: 'Pay 10% of basic.' })).rejects.toBeInstanceOf(PayRuleDraftError);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('one-shot: invalid model JSON ⇒ a single PayRuleDraftError, no second AI call', async () => {
    vi.mocked(generateDraft).mockResolvedValue('this is not json at all');
    await expect(draftPayRule(a, { description: 'something' })).rejects.toBeInstanceOf(PayRuleDraftError);
    expect(generateDraft).toHaveBeenCalledTimes(1); // no retry / re-prompt
  });

  it('one-shot: a structurally-invalid rule from the model is rejected (no second call), nothing audited', async () => {
    vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({ rule: { kind: 'gross_of', base: 'gross', pct: 10 }, explanation: 'x' }));
    await expect(draftPayRule(a, { description: 'percent of gross' })).rejects.toBeInstanceOf(PayRuleDraftError);
    expect(generateDraft).toHaveBeenCalledTimes(1);
    expect(await eventTypesFor(base.tenantId, base.tenantId)).not.toContain('pay-component.ai-rule-drafted');
  });

  it('proration conflict from the model is rejected against the editing component (per_day on a prorating component)', async () => {
    vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({ rule: { kind: 'per_day', rate: 50 }, explanation: 'RM50 per day' }));
    await expect(draftPayRule(a, { description: 'RM50 per day', componentProrates: true })).rejects.toBeInstanceOf(PayRuleDraftError);
  });
});
