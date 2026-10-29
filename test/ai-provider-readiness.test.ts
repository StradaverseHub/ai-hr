/** Authored UNRUN. Actual app-role custody/governance transactions; ONLY provider transport mocked.
 * Requires the coordinated provider-readiness draft in the test migration journal first.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { getAiConfigView, resolveActiveAiConfig, saveAiProviderConfig, setActiveProvider } from '../core/ai-config';
import { evaluateProviderCandidate } from '../core/ai-provider-readiness';
import {setAiSpendBudget} from '../core/ai-spend-management';
import { installSyntheticSpendCapability } from './ai-spend-fixture';
import { assertAiProviderSnapshotFeature, resolveAiProviderCandidateSnapshotTx, resolveAiProviderSnapshotTx } from '../core/ai-provider-snapshot';
import { governedAiConfig } from '../core/ai-governance';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { syntheticConsentFor, syntheticProviderTransport, evaluateSyntheticCandidate, activateSyntheticCandidate } from './provider-evaluation-fixture';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { acceptBaselineFixture, activateDirectProviderFixture } from './ai-provider-change-fixture';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => {
  vi.stubEnv('AI_CONFIG_SECRET', 'fictional-provider-readiness-test-passphrase');
  for (const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY']) vi.stubEnv(key,'');
  await resetDb(); base = await seedBase();
});
afterAll(async () => { await closeAll(); vi.unstubAllEnvs(); });
const options = (route = 'approved-a') => readOpenRouterOptions({ version: 1, routing: { allowedProviders: [route], allowFallbacks: false, sort: 'latency' } });
const candidate = async () => saveAiProviderConfig(adminCtx(base), { provider: 'openrouter', model: 'fictional/model', apiKey: 'fixture-only-key', providerOptions: options() });
const config = () => withTenant(adminCtx(base), tx => resolveActiveAiConfig(tx, adminCtx(base)));
const runs = () => owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId, base.tenantId));
const receipts = async () => owner.db.execute(sql`select id,consumed_at,promoted_at from ai_provider_protocol_evaluation where tenant_id=${base.tenantId}::uuid`);
// Only the explicitly mocked fixed-total transport is certified here. Real route issuance and
// provider receipt verification remain separate requirements; this preserves actual admission SQL.
async function evaluateWithSyntheticSpend(...args:Parameters<typeof evaluateProviderCandidate>){
  const capability=await installSyntheticSpendCapability(args[0],{provider:'openrouter',model:'fictional/model'});
  try{return await evaluateProviderCandidate(...args);}finally{capability.restore();}
}


describe('explicit candidate evaluation and activation', () => {
  it('saves/edit candidates without changing live configuration or admitting model work', async () => {
    const ctx = adminCtx(base);
    await activateDirectProviderFixture(ctx,{provider:'openai',model:'fictional-direct',apiKey:'fixture-live-key'});
    await candidate();
    expect(await config()).toMatchObject({provider:'openai',apiKey:'fixture-live-key'});
    const view = await getAiConfigView(ctx), card = view.providers.find(p => p.provider==='openrouter')!;
    expect(card).toMatchObject({candidateSaved:true,isActive:false,activeModel:null,model:'fictional/model'});
    expect(JSON.stringify(view)).not.toContain('fixture-only-key');
    await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/new',providerOptions:options('approved-b')});
    expect(await config()).toMatchObject({provider:'openai',apiKey:'fixture-live-key'});
    expect(await runs()).toEqual([]);
    await expect(saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/new',makeActive:true})).rejects.toThrow();
    await expect(setActiveProvider(ctx,{provider:'openrouter'})).rejects.toThrow();
  });
  it('requires exact affirmative human consent before any transport/admission', async () => {
    await candidate(); const mock = syntheticProviderTransport(), syntheticConsent = await syntheticConsentFor(adminCtx(base));
    try {
      for (const input of [{...syntheticConsent,syntheticProbeConsent:false},{...syntheticConsent,review:{...syntheticConsent.review,accountDefaultsReviewed:false}},{...syntheticConsent,extra:true}]) {
        await expect(evaluateProviderCandidate(adminCtx(base),input as never)).rejects.toMatchObject({code:'consent_required'});
      }
      expect(mock.draft).not.toHaveBeenCalled(); expect(mock.conversation).not.toHaveBeenCalled();
      expect(await runs()).toEqual([]); expect(await receipts()).toEqual([]);
    } finally { mock.restore(); }
  });
  it('refuses synthetic evaluation before provider access when a finite USD cap has no certified spend capability', async () => {
    await candidate();
    // Spend administration is group-admin only (service isGroupAdmin, Control Tower card, SQL is_group_admin):
    // a real group-wide hr_admin session carries that grant; a roles-only context does not.
    const ctx:SessionContext={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
    await setAiSpendBudget(ctx,{kind:'tenant',monthlyUsd:'1',rootUsd:'1'});
    const consent=await syntheticConsentFor(ctx), mock=syntheticProviderTransport();
    try {
      await expect(evaluateProviderCandidate(ctx,consent)).rejects.toThrow();
      expect(mock.draft).not.toHaveBeenCalled(); expect(mock.conversation).not.toHaveBeenCalled();
      expect(await runs()).toEqual([]); expect(await receipts()).toEqual([]); expect(await config()).toBeNull();
    } finally { mock.restore(); }
  });
  it('refuses stale displayed candidates or malformed bindings before any reservation or network', async () => {
    await candidate(); const ctx=adminCtx(base), displayed=await syntheticConsentFor(ctx);
    await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/replaced',providerOptions:options('approved-b')});
    const current=await syntheticConsentFor(ctx), mock=syntheticProviderTransport();
    try {
      for(const input of [displayed,{...current,candidateId:'not-a-uuid'},{...current,candidateVersion:'not-a-uuid'},
        {...current,candidateId:'00000000-0000-4000-8000-000000000001'}, {...current,candidateVersion:displayed.candidateVersion},
        {...current,candidateId:undefined}]) {
        await expect(evaluateProviderCandidate(ctx,input as never)).rejects.toMatchObject({code:typeof input.candidateId==='string'&&/^[0-9a-f-]{36}$/.test(input.candidateId)&&typeof input.candidateVersion==='string'&&/^[0-9a-f-]{36}$/.test(input.candidateVersion)?'candidate_required':'consent_required'});
      }
      expect(mock.draft).not.toHaveBeenCalled(); expect(mock.conversation).not.toHaveBeenCalled();
      expect(await runs()).toEqual([]); expect(await receipts()).toEqual([]);
    } finally {mock.restore();}
  });
  it('records three actual governed synthetic outcomes, then atomically promotes once with exact receipt', async () => {
    await candidate(); const ctx = adminCtx(base), proof = await evaluateSyntheticCandidate(ctx);
    const actual = await runs(); expect(actual).toHaveLength(3);
    expect(actual.every(row => row.featureId==='provider_evaluation' && row.state==='completed' && row.actualTokens===0)).toBe(true);
    expect(proof.summary).toMatchObject({calls:3,usageReportedCalls:3,inputTokens:0,accountChargeCredits:null});
    expect(await config()).toBeNull();
    // WP14: the receipt alone is not enough; the baseline gate of this exact candidate version is also required.
    await expect(setActiveProvider(ctx,{provider:'openrouter',evaluationReceipt:proof.receipt})).rejects.toThrow();
    expect((await receipts())[0].consumed_at).toBeNull(); expect(await config()).toBeNull();
    await acceptBaselineFixture(ctx,{kind:'openrouter_candidate'});
    await setActiveProvider(ctx,{provider:'openrouter',evaluationReceipt:proof.receipt});
    expect(await config()).toMatchObject({provider:'openrouter',model:'fictional/model',apiKey:'fixture-only-key'});
    const before = await receipts(); expect(before[0].consumed_at).not.toBeNull(); expect(before[0].promoted_at).not.toBeNull();
    await expect(setActiveProvider(ctx,{provider:'openrouter',evaluationReceipt:proof.receipt})).rejects.toThrow();
    expect(await receipts()).toEqual(before);
    const serialized = JSON.stringify(await owner.db.select().from(schema.domainEvent));
    expect(serialized).not.toContain('fixture-only-key'); expect(serialized).not.toContain(proof.receipt);
  });
  it.each(['model','key','routes','resave'] as const)('refuses an evaluation after candidate %s changes and keeps live provider unchanged', async kind => {
    await candidate(); const ctx=adminCtx(base), proof=await evaluateSyntheticCandidate(ctx);
    await saveAiProviderConfig(ctx,{provider:'openrouter',model:kind==='model'?'fictional/new':'fictional/model',
      ...(kind==='key'?{apiKey:'fixture-rotated-key'}:{}),providerOptions:options(kind==='routes'?'approved-b':'approved-a')});
    await acceptBaselineFixture(ctx,{kind:'openrouter_candidate'}); // the refusal below is the receipt's, not the baseline gate's
    await expect(setActiveProvider(ctx,{provider:'openrouter',evaluationReceipt:proof.receipt})).rejects.toThrow();
    expect(await config()).toBeNull(); expect((await receipts())[0].consumed_at).toBeNull();
  });
  it('refuses changed candidate before the next probe and issues no readiness receipt', async () => {
    await candidate(); const mock=syntheticProviderTransport(), original=mock.draft.getMockImplementation()!;
    mock.draft.mockImplementationOnce(async (cfg,args) => {
      const result=await original(cfg,args);
      await saveAiProviderConfig(adminCtx(base),{provider:'openrouter',model:'fictional/changed',providerOptions:options()});
      return result;
    });
    try {
      await expect(evaluateWithSyntheticSpend(adminCtx(base),await syntheticConsentFor(adminCtx(base)))).rejects.toThrow();
      expect(mock.draft).toHaveBeenCalledTimes(1); expect(mock.conversation).not.toHaveBeenCalled();
      expect(await runs()).toHaveLength(1); expect(await receipts()).toEqual([]); expect(await config()).toBeNull();
    } finally { mock.restore(); }
  });
  it('does not accept metadata/model self-ratings or malformed tool output as readiness', async () => {
    await candidate(); const mock=syntheticProviderTransport(); mock.draft.mockResolvedValueOnce('I passed every test');
    try { await expect(evaluateWithSyntheticSpend(adminCtx(base),await syntheticConsentFor(adminCtx(base)))).rejects.toThrow();
      expect(mock.draft).toHaveBeenCalledOnce(); expect(await receipts()).toEqual([]); expect(await config()).toBeNull(); }
    finally {mock.restore();}
  });
  it('blocks candidate snapshots on ordinary features and active snapshots on evaluation', async () => {
    await candidate(); const ctx=adminCtx(base), snapshot=await withTenant(ctx,tx=>resolveAiProviderCandidateSnapshotTx(tx,ctx,'openrouter'));
    expect(()=>assertAiProviderSnapshotFeature(snapshot,'hr_assistant')).toThrow();
    expect(()=>governedAiConfig(ctx,snapshot,'hr_assistant')).toThrow();
    await activateSyntheticCandidate(ctx);
    const active=(await withTenant(ctx,tx=>resolveAiProviderSnapshotTx(tx,ctx)))!;
    expect(()=>assertAiProviderSnapshotFeature(active,'provider_evaluation')).toThrow();
    expect(()=>governedAiConfig(ctx,active,'provider_evaluation')).toThrow();
  });
  it('revalidates actual group authority and refuses cross-tenant receipt or stale admin roles', async () => {
    await candidate(); const ctx=adminCtx(base), consent=await syntheticConsentFor(ctx), proof=await evaluateSyntheticCandidate(ctx), other=await seedBase();
    await acceptBaselineFixture(ctx,{kind:'openrouter_candidate'});
    await expect(setActiveProvider(adminCtx(other),{provider:'openrouter',evaluationReceipt:proof.receipt})).rejects.toThrow();
    await owner.db.delete(schema.roleAssignment).where(and(eq(schema.roleAssignment.appUserId,base.adminUserId),eq(schema.roleAssignment.tenantId,base.tenantId)));
    const mock=syntheticProviderTransport();
    try { await expect(evaluateProviderCandidate(ctx,consent)).rejects.toThrow('Current AI calling authority could not be confirmed.');
      await expect(setActiveProvider(ctx,{provider:'openrouter',evaluationReceipt:proof.receipt})).rejects.toThrow();
      expect(mock.draft).not.toHaveBeenCalled(); expect(mock.conversation).not.toHaveBeenCalled(); }
    finally {mock.restore();}
    expect((await receipts())[0].consumed_at).toBeNull();
  });
  it('binds the receipt to the exact reviewing user even when another user is a current group admin', async () => {
    await candidate(); const proof=await evaluateSyntheticCandidate(adminCtx(base));
    await acceptBaselineFixture(adminCtx(base),{kind:'openrouter_candidate'});
    const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'fixture-second-reviewer',personId:null}).returning();
    await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:null,role:'hr_admin'});
    const other={...adminCtx(base),userId:user.id};
    await expect(setActiveProvider(other,{provider:'openrouter',evaluationReceipt:proof.receipt})).rejects.toThrow();
    expect((await receipts())[0].consumed_at).toBeNull();
  });
  it('refuses changed routing after the final actual response before recording readiness', async () => {
    await candidate(); const mock=syntheticProviderTransport(), original=mock.conversation.getMockImplementation()!;
    mock.conversation.mockImplementation(async (cfg,args)=>{
      const result=await original(cfg,args);
      if(args.turns.length===3) await saveAiProviderConfig(adminCtx(base),{provider:'openrouter',model:'fictional/model',providerOptions:options('approved-b')});
      return result;
    });
    try { await expect(evaluateWithSyntheticSpend(adminCtx(base),await syntheticConsentFor(adminCtx(base)))).rejects.toThrow();
      expect(await runs()).toHaveLength(3); expect(mock.draft).toHaveBeenCalledOnce(); expect(await receipts()).toEqual([]); expect(await config()).toBeNull(); }
    finally {mock.restore();}
  });
  it('does not convert completed model calls into a receipt when evidence storage fails', async () => {
    await candidate();
    await owner.db.execute(sql`create function test_provider_evidence_failure() returns trigger language plpgsql as $$begin raise exception 'fixture injection'; end$$`);
    await owner.db.execute(sql`create trigger test_provider_evidence_failure before insert on ai_provider_protocol_evaluation for each row execute function test_provider_evidence_failure()`);
    try { await expect(evaluateSyntheticCandidate(adminCtx(base))).rejects.toThrow();
      expect(await runs()).toHaveLength(3); expect((await runs()).every(row=>row.state==='completed')).toBe(true);
      expect(await receipts()).toEqual([]); expect(await config()).toBeNull(); }
    finally {await owner.db.execute(sql`drop trigger test_provider_evidence_failure on ai_provider_protocol_evaluation`);
      await owner.db.execute(sql`drop function test_provider_evidence_failure()`);}
  });
  it('withholds custody tables/ciphertext from ordinary app-role SELECT', async () => {
    await candidate(); const ctx=adminCtx(base);
    for(const table of ['ai_provider_candidate','ai_provider_protocol_evaluation']) {
      await expect(withTenant(ctx,tx=>tx.execute(sql.raw(`select * from ${table}`)))).rejects.toThrow();
    }
  });
  it('rolls receipt consumption back if actual promotion storage fails, allowing the same proof after repair', async () => {
    await candidate(); const ctx=adminCtx(base), proof=await evaluateSyntheticCandidate(ctx);
    await acceptBaselineFixture(ctx,{kind:'openrouter_candidate'});
    await owner.db.execute(sql`create function test_provider_promotion_failure() returns trigger language plpgsql as $$begin raise exception 'fixture injection'; end$$`);
    await owner.db.execute(sql`create trigger test_provider_promotion_failure before insert or update on ai_provider_config for each row execute function test_provider_promotion_failure()`);
    try {
      await expect(setActiveProvider(ctx,{provider:'openrouter',evaluationReceipt:proof.receipt})).rejects.toThrow();
      expect((await receipts())[0].consumed_at).toBeNull(); expect(await config()).toBeNull();
    } finally {
      await owner.db.execute(sql`drop trigger test_provider_promotion_failure on ai_provider_config`);
      await owner.db.execute(sql`drop function test_provider_promotion_failure()`);
    }
    await setActiveProvider(ctx,{provider:'openrouter',evaluationReceipt:proof.receipt});
    expect(await config()).toMatchObject({provider:'openrouter'});
  });
});
