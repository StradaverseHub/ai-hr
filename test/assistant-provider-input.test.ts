/** TEST ONLY: synthetic privacy-review seam for this legacy gateway-control suite. The new
 * disclosure assertion/consumption is isolated so the original protocol, capture, source, admission,
 * spend and accounting controls below are still exercised. Actual binding/transfer/revocation and
 * provider egress dispatch remain real. Dedicated provider-privacy-request, provider-data-review-gate
 * and ai-private-analysis suites exercise the real default-block/review policy separately. This
 * fixture grants no production review status and admits no real provider data. */
vi.mock('../lib/ai/provider-privacy-request', async importActual => {
  const actual = await importActual<typeof import('../lib/ai/provider-privacy-request')>();
  return { ...actual, assertProviderPrivacyRequest: () => {}, consumeProviderPrivacyRequest: () => {} };
});

/** Actual source/admission cases authored UNRUN. Only provider transport is mocked; no live calls. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import * as canonical from '../core/read';
import { hireEmployee } from '../core/org';
import { grantAssistant } from '../core/assistant-grant';
import { resolveActiveAiConfig } from '../core/ai-config';
import { withAiAdmissionCheck } from '../core/ai-governance';
import { bindAiSpendTaskTx } from '../core/ai-spend-task';
import { prepareAssistantConversation } from '../core/assistant-provider-input';
import { ASSISTANT_TOOLS, specsFor } from '../core/assistant-tools';
import { assistantSourceDigest } from '../lib/ai/assistant-disclosure';
import { serializeAgentReadResult } from '../lib/ai/agent-read-batch';
import { converse } from '../lib/ai';
import { openaiAdapter } from '../lib/ai/providers/openai';
import type { ConverseArgs, ConverseResult } from '../lib/ai/types';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'assistant', 'active');
  await grantAssistant(adminCtx(base), { appUserId: base.adminUserId });
  vi.stubEnv('OPENAI_API_KEY', 'fictional-source-test-never-sent');
  for (const key of ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) vi.stubEnv(key, '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(closeAll);
const result: ConverseResult = { text: 'Fictional response', stop: 'end', toolCalls: [], usageReported: true,
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } };
const runs = () => owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId, base.tenantId));
async function fixture(claims = false) {
  if (claims) await setModule(base.tenantId, 'claims', 'active');
  const ctx = await entitledCtx(base);
  const employee = await hireEmployee(adminCtx(base), { person: { fullName: 'Fictional Permitted Source', primaryEmail: `${randomUUID()}@fixture.test` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  const tool = ASSISTANT_TOOLS.find(tool => tool.spec.name === 'employee_profile')!;
  const input = { employment_id: employee.employmentId }, outcome = await tool.run(ctx, input);
  expect(outcome.ok).toBe(true);
  // The Assistant binds its native question spend root before any admission (core/assistant.ts).
  const configuration = await withTenant(ctx, async tx => {
    const resolved = await resolveActiveAiConfig(tx, ctx, 'hr_assistant');
    return resolved ? bindAiSpendTaskTx(tx, ctx, resolved, { kind: 'assistant_question' }) : null;
  });
  if (!configuration) throw Error('Actual fake-key fixture configuration missing');
  const args: ConverseArgs = { system: ['Fictional fixed system'], tools: specsFor(ctx), turns: [
    { role: 'user', content: 'Read this permitted profile.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: tool.spec.name, input }] },
    { role: 'tool', results: [{ id: 'c1', name: tool.spec.name, content: serializeAgentReadResult(outcome) }] },
  ] };
  const evidence = [{ name: tool.spec.name, input, digest: assistantSourceDigest(outcome) }];
  return { ctx, employee, tool, input, args, evidence, configuration,
    prepared: prepareAssistantConversation(ctx, configuration, args, evidence) };
}

describe('actual prepared Assistant provider input', () => {
  it('replays current canonical source in the admission transaction, then releases it before transport', async () => {
    const f = await fixture(), original = canonical.employeeDetail;
    let checked = false;
    vi.spyOn(canonical, 'employeeDetail').mockImplementation(async (...args) => {
      expect(args[3]).toBeDefined();
      const [mode] = await args[3]!.execute<{ readonly: string; run_count: number }>(sql`select current_setting('transaction_read_only') as readonly,
        (select count(*)::int from ai_model_run where tenant_id=${base.tenantId}::uuid) as run_count`);
      expect(mode).toMatchObject({ readonly: 'off', run_count: 0 }); checked = true;
      return original(...args);
    });
    const transport = vi.spyOn(openaiAdapter, 'converse').mockImplementation(async (_cfg, args) => {
      expect(checked).toBe(true); expect(JSON.stringify(args)).toContain('Fictional Permitted Source');
      expect((await runs())[0].state).toBe('pending');
      const [lock] = await owner.db.execute<{ held: boolean }>(sql`select exists(select 1 from pg_locks l
        where l.locktype='advisory' and l.granted and l.objsubid=1
        and l.database=(select oid from pg_database where datname=current_database())
        and ((l.classid::bigint << 32) | l.objid::bigint)=hashtextextended(${'access-configuration:' + base.tenantId},0)) as held`);
      expect(lock.held).toBe(false); return result;
    });
    await expect(converse(f.prepared.configuration, f.prepared.args)).resolves.toMatchObject({ text: result.text });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await runs())[0]).toMatchObject({ state: 'completed', actualTokens: 0 });
  });
  it('refuses changed canonical facts before reservation and permits a fresh exact preparation', async () => {
    const f = await fixture(), transport = vi.spyOn(openaiAdapter, 'converse').mockResolvedValue(result);
    await owner.db.update(schema.person).set({ fullName: 'Changed source facts' }).where(eq(schema.person.id, f.employee.personId));
    await expect(converse(f.prepared.configuration, f.prepared.args)).rejects.toThrow('source access');
    expect(transport).not.toHaveBeenCalled(); expect(await runs()).toEqual([]);
    const outcome = await f.tool.run(f.ctx, f.input); expect(JSON.stringify(outcome)).toContain('Changed source facts');
    if (f.args.turns[2].role !== 'tool') throw Error();
    f.args.turns[2].results[0].content = serializeAgentReadResult(outcome);
    const renewed = prepareAssistantConversation(f.ctx, f.configuration, f.args,
      [{ name: f.tool.spec.name, input: f.input, digest: assistantSourceDigest(outcome) }]);
    await expect(converse(renewed.configuration, renewed.args)).resolves.toMatchObject({ text: result.text });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('refuses a stale offered catalogue after actual module removal before any reservation', async () => {
    const f = await fixture(true), transport = vi.spyOn(openaiAdapter, 'converse').mockResolvedValue(result);
    expect(f.args.tools.some(tool => tool.name === 'my_claim_statuses')).toBe(true);
    await setModule(base.tenantId, 'claims', null);
    await expect(converse(f.prepared.configuration, f.prepared.args)).rejects.toThrow('source access');
    expect(transport).not.toHaveBeenCalled(); expect(await runs()).toEqual([]);
  });
  it('refuses a different outgoing transcript and never retargets retained prepared arguments', async () => {
    const f = await fixture(), transport = vi.spyOn(openaiAdapter, 'converse').mockImplementation(async (_cfg, args) => {
      expect(JSON.stringify(args)).not.toContain('RETARGETED_PRIVATE_SENTINEL'); return result;
    });
    if (f.args.turns[2].role !== 'tool') throw Error();
    f.args.turns[2].results[0].content = 'RETARGETED_PRIVATE_SENTINEL';
    await expect(converse(f.prepared.configuration, f.args)).rejects.toThrow('source access');
    expect(transport).not.toHaveBeenCalled(); expect(await runs()).toEqual([]);
    await expect(converse(f.prepared.configuration, f.prepared.args)).resolves.toMatchObject({ text: result.text });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('honors the owning exchange deadline before reserving or calling transport', async () => {
    const f = await fixture(), transport = vi.spyOn(openaiAdapter, 'converse').mockResolvedValue(result);
    const start = Date.now();
    const prepared = prepareAssistantConversation(f.ctx, f.configuration, f.args, f.evidence, start + 30_000);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start + 31_000);
    try { await expect(converse(prepared.configuration, prepared.args)).rejects.toThrow('source access'); }
    finally { clock.mockRestore(); }
    expect(transport).not.toHaveBeenCalled(); expect(await runs()).toEqual([]);
    await expect(converse(prepared.configuration, prepared.args)).resolves.toMatchObject({ text: result.text });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('refuses unrelated source evidence or substituted error bodies before admission', async () => {
    const f = await fixture();
    expect(() => prepareAssistantConversation(f.ctx, f.configuration, f.args, [{ ...f.evidence[0], digest: 'f'.repeat(64) }])).toThrow('source access');
    if (f.args.turns[2].role !== 'tool') throw Error();
    f.args.turns[2].results[0] = { id: 'c1', name: f.tool.spec.name, content: 'PRIVATE_RAW_DATABASE_ERROR', isError: true };
    expect(() => prepareAssistantConversation(f.ctx, f.configuration, f.args, [])).toThrow('source access');
    expect(await runs()).toEqual([]);
  });
  it('cannot remove an earlier extra check, change its feature or bind a copied config', async () => {
    const f = await fixture(), second = vi.fn(async () => {}), callback = vi.fn(async () => 'must not run');
    const first = withAiAdmissionCheck(f.configuration, 'hr_assistant', async () => { throw Error('PRIVATE_SQL_FAILURE'); });
    const chained = withAiAdmissionCheck(first, 'hr_assistant', second);
    await expect(chained.governance!.run({ operation: 'conversation', reservedTokens: 10 }, callback)).rejects.toThrow('source access');
    expect(second).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled(); expect(await runs()).toEqual([]);
    expect(() => withAiAdmissionCheck(f.configuration, 'pay_rule_draft', second)).toThrow('prepared AI request');
    expect(() => withAiAdmissionCheck({ ...f.configuration }, 'hr_assistant', second)).toThrow('prepared AI request');
  });
});
