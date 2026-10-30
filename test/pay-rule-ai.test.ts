/**
 * Payroll Setup — AI-assisted pay-rule drafting (core/pay-rule-ai.ts). Contract under test:
 *   - draft-only: a draft NEVER writes to any pay table (pay_component is untouched);
 *   - graceful degradation: with the gateway unconfigured the feature is OFF (PayRuleDraftError, no LLM call);
 *   - Closed intent: only a source-parsed rule kind reaches the gateway; parameters stay local;
 *   - one-shot: invalid model JSON ⇒ a SINGLE PayRuleDraftError (generateDraft called exactly once, no retry);
 *   - auditability: a valid draft appends pay-component.ai-rule-drafted with an { type: 'agent' } actor and a
 *     PII-free payload (provider/model/componentCode/ruleKind only — never the description).
 *
 * Mocks mirror test/performance-ai-draft.test.ts: lib/ai's generateDraft is stubbed (redactPII stays REAL via
 * importActual) and core/ai-config's resolveActiveAiConfig is stubbed — no SDK, no network, no real key.
 */
import { afterAll,afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ai', async (importActual) => {
  const actual = await importActual<typeof import('../lib/ai')>();
  return {
    ...actual, // keep redactPII real
    generateDraft: vi.fn(async () => JSON.stringify({ kind: 'percent_of' })),
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
import {setModule,entitledCtx} from './harness';
import {defaultModelFor} from '../lib/ai';
async function issuedFixtureConfig(...args:Parameters<typeof resolveActiveAiConfig>){return (await vi.importActual<typeof import('../core/ai-config')>('../core/ai-config')).resolveActiveAiConfig(...args);}
import { closeAll, eventTypesFor, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('Payroll Setup — AI-assisted pay-rule drafting', () => {
  let base: Base;
  let a: SessionContext;
  beforeAll(async () => {
    await migrateTestDb();
  });
  afterEach(()=>vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY','fictional-unit-transport-never-sent');for(const key of ['OPENAI_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId,'payroll','active');a = await entitledCtx(base);
    vi.mocked(generateDraft)
      .mockReset()
      .mockResolvedValue(JSON.stringify({ kind: 'percent_of' }));
    vi.mocked(resolveActiveAiConfig)
      .mockReset()
      .mockImplementation(issuedFixtureConfig);
  });
  afterAll(async () => {
    await closeAll();
  });

  it('drafts a valid rule from a closed intent with local parameters, writes nothing, and audits the generation', async () => {
    const res = await draftPayRule(a, {
      description: '10% of basic',
      componentCode: 'HOUSING',
      componentProrates: true,
    });
    expect(res.rule).toEqual({ kind: 'percent_of', base: 'basic', pct: 10 });
    expect(res.explanation).toBe('Prepared the requested rule from your supplied parameters. Review the native validation and values before saving.');

    // The gateway sees only the rule kind, with all human parameters retained locally.
    expect(generateDraft).toHaveBeenCalledTimes(1);
    const { prompt } = vi.mocked(generateDraft).mock.calls[0][1];
    expect(JSON.parse(prompt)).toEqual({requestedKind:'percent_of',componentProrates:true});
    expect(prompt).not.toContain('10');
    expect(prompt).not.toContain('jane@acme.test');
    expect(prompt).not.toContain('910101-01-1234');

    // Draft-only: no pay_component row was created.
    const comps = await owner.db.select().from(schema.payComponent);
    expect(comps).toHaveLength(0);

    // …but the generation is on the audit log, with an agent actor + PII-free payload.
    expect(await eventTypesFor(base.tenantId, base.tenantId)).toContain('pay-component.ai-rule-drafted');
    const payload = await latestEventPayload(base.tenantId, base.tenantId, 'pay-component.ai-rule-drafted');
    expect(payload).toMatchObject({ provider: 'anthropic', model: defaultModelFor('anthropic'), componentCode: 'HOUSING', ruleKind: 'percent_of' });
    expect(JSON.stringify(payload)).not.toContain('jane@acme.test');
  });

  it('keeps unstructured private descriptions unavailable before provider transport',async()=>{await expect(draftPayRule(a,{description:'Pay 10% of basic. Ask jane@acme.test (910101-01-1234) if unsure.'})).rejects.toMatchObject({name:'ProviderWorkloadUnavailableError'});expect(generateDraft).not.toHaveBeenCalled();});

  it('is OFF when no AI config resolves (PayRuleDraftError, no LLM call)', async () => {
    vi.mocked(resolveActiveAiConfig).mockResolvedValue(null);
    await expect(draftPayRule(a, { description: 'Pay 10% of basic.' })).rejects.toBeInstanceOf(PayRuleDraftError);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('one-shot: invalid model JSON ⇒ a single PayRuleDraftError, no second AI call', async () => {
    vi.mocked(generateDraft).mockResolvedValue('this is not json at all');
    await expect(draftPayRule(a, { description: '10% of basic' })).rejects.toBeInstanceOf(PayRuleDraftError);
    expect(generateDraft).toHaveBeenCalledTimes(1); // no retry / re-prompt
  });

  it('one-shot: a structurally-invalid rule from the model is rejected (no second call), nothing audited', async () => {
    vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({ rule: { kind: 'gross_of', base: 'gross', pct: 10 }, explanation: 'x' }));
    await expect(draftPayRule(a, { description: '10% of basic' })).rejects.toBeInstanceOf(PayRuleDraftError);
    expect(generateDraft).toHaveBeenCalledTimes(1);
    expect(await eventTypesFor(base.tenantId, base.tenantId)).not.toContain('pay-component.ai-rule-drafted');
  });

  it('proration conflict from the model is rejected against the editing component (per_day on a prorating component)', async () => {
    vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({kind:'per_day'}));
    await expect(draftPayRule(a, { description: 'per day: 50', componentProrates: true })).rejects.toBeInstanceOf(PayRuleDraftError);
  });
});
