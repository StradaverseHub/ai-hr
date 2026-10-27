/** Real config/RLS controls authored UNRUN; requires coordinated options migration. No provider calls. */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { getAiConfigView, resolveActiveAiConfig, saveAiProviderConfig, setActiveProvider } from '../core/ai-config';
import { activateSyntheticCandidate } from './provider-evaluation-fixture';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b:Base;
beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-local-options-test-passphrase');await migrateTestDb();});
beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
const options=()=>readOpenRouterOptions({version:1,routing:{allowedProviders:['approved-a','approved-b'],allowFallbacks:false,sort:'latency'}});
const key='fixture-openrouter-key-XYZ9';
describe('tenant OpenRouter configuration ownership',()=>{
 it('stores a write-only tenant key and explicit routes, stays inactive until requested, and resolves the frozen v2 config',async()=>{
  const ctx=adminCtx(b);await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/model',apiKey:key,providerOptions:options()});
  const view=await getAiConfigView(ctx), row=view.providers.find(p=>p.provider==='openrouter');
  expect(row).toMatchObject({configured:true,isActive:false,keyLast4:'XYZ9',providerOptions:options()});expect(JSON.stringify(view)).not.toContain(key);
  await expect(setActiveProvider(ctx,{provider:'openrouter'})).rejects.toThrow();
  await activateSyntheticCandidate(ctx);
  const resolved=await withTenant(ctx,tx=>resolveActiveAiConfig(tx,ctx));expect(resolved?.provider).toBe('openrouter');expect(resolved?.apiKey).toBe(key);expect(resolved?.providerOptions).toEqual(options());
  const other=await seedBase();const foreign=await withTenant(adminCtx(other),tx=>tx.execute(sql`select provider from app.ai_active_provider_config_v2()`));expect(foreign).toHaveLength(0);
 });
 it('saves narrow :free syntax as an inactive unevaluated candidate without asserting live route capability',async()=>{
  const ctx=adminCtx(b);await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/model:free',apiKey:key,providerOptions:options()});
  const before=await getAiConfigView(ctx);expect(before.providers.find(p=>p.provider==='openrouter')).toMatchObject({configured:true,isActive:false});
  await expect(setActiveProvider(ctx,{provider:'openrouter'})).rejects.toThrow();
  for(const model of ['fictional/model:online','fictional/model:nitro','fictional/model:free:online','openrouter/free'])await expect(saveAiProviderConfig(ctx,{provider:'openrouter',model})).rejects.toThrow();
  expect(await getAiConfigView(ctx)).toEqual(before);expect(await withTenant(ctx,tx=>tx.execute(sql`select id from public.ai_provider_config where tenant_id=${b.tenantId}::uuid and provider='openrouter' and is_active`))).toHaveLength(0);
 });
 it('preserves the existing key/routes on model-only saves and refuses malformed routing without a write/event',async()=>{
  const ctx=adminCtx(b);await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/model',apiKey:key,providerOptions:options()});
  await activateSyntheticCandidate(ctx);
  await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/new-model'});
  await activateSyntheticCandidate(ctx);
  const before=await getAiConfigView(ctx), events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,b.tenantId)).orderBy(schema.domainEvent.id);
  await expect(saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/new-model',providerOptions:{version:2,routing:options().routing}})).rejects.toThrow();
  await expect(saveAiProviderConfig(ctx,{provider:'openrouter',model:'openrouter/auto'})).rejects.toThrow();
  expect(await getAiConfigView(ctx)).toEqual(before);
  expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,b.tenantId)).orderBy(schema.domainEvent.id)).toEqual(events);
  const resolved=await withTenant(ctx,tx=>resolveActiveAiConfig(tx,ctx));expect(resolved?.apiKey).toBe(key);expect(resolved?.providerOptions).toEqual(options());
  expect(JSON.stringify(events)).not.toContain(key);expect(JSON.stringify(events)).not.toContain('api_key_ciphertext');
 });
 it('refuses stale revoked group authority and company-scoped HR authority despite posted/retained admin roles',async()=>{
  const ctx=adminCtx(b);await owner.db.delete(schema.roleAssignment).where(and(eq(schema.roleAssignment.tenantId,b.tenantId),eq(schema.roleAssignment.appUserId,b.adminUserId)));
  const command={provider:'openrouter',model:'fictional/model',apiKey:key,providerOptions:options()};
  await expect(saveAiProviderConfig(ctx,command)).rejects.toThrow();
  await expect(withTenant(ctx,tx=>resolveActiveAiConfig(tx,ctx))).rejects.toThrow();
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'fixture-'+randomUUID(),personId:null}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,companyId:b.companyId,role:'hr_admin'});
  const scoped:SessionContext={tenantId:b.tenantId,userId:user.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  await expect(saveAiProviderConfig(scoped,command)).rejects.toThrow();await expect(getAiConfigView(scoped)).rejects.toThrow();
  await expect(withTenant(scoped,tx=>tx.insert(schema.aiProviderConfig).values({tenantId:b.tenantId,provider:'openrouter',model:'fictional/model',apiKeyCiphertext:'fixture-cipher',keyLast4:'none',providerOptions:options()}))).rejects.toThrow();
  expect(await withTenant(scoped,tx=>tx.select({id:schema.aiProviderConfig.id}).from(schema.aiProviderConfig))).toHaveLength(0);
 });
});
