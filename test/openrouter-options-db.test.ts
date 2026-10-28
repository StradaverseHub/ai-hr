/** Actual SQL/column-grant controls. UNRUN; requires coordinated options migration first. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);

describe('persisted provider options SQL boundary', () => {
  it('accepts normalized owner output and refuses unnormalized or privacy/endpoint extensions', async () => {
    const ctx = adminCtx(b), canonical = readOpenRouterOptions({ version: 1, routing: { allowedProviders: ['approved-a', 'approved-b'] } });
    for (const options of [canonical, { ...canonical, routing: { ...canonical.routing, sort: 'price', allowFallbacks: true } }]) {
      const [row] = await withTenant(ctx, tx => tx.execute<{ valid: boolean }>(sql`select app.ai_openrouter_options_valid(${JSON.stringify(options)}::jsonb) as valid`));
      expect(row.valid).toBe(true);
    }
    for (const value of [null, [], {}, { version: 1, routing: { allowedProviders: ['approved-a'] } },
      { ...canonical, version: 2 }, { ...canonical, baseURL: 'https://unapproved.example' },
      { ...canonical, routing: { ...canonical.routing, allowedProviders: ['approved-a', 'approved-a'] } },
      { ...canonical, routing: { ...canonical.routing, zdr: false } },
      { ...canonical, routing: { ...canonical.routing, data_collection: 'allow' } }]) {
      const [row] = await withTenant(ctx, tx => tx.execute<{ valid: boolean | null }>(sql`select app.ai_openrouter_options_valid(${JSON.stringify(value)}::jsonb) as valid`));
      expect(row.valid).not.toBe(true);
    }
  });
  it('requires explicit OpenRouter routing and empty options for existing direct providers', async () => {
    const ctx = adminCtx(b), options = readOpenRouterOptions({ version: 1, routing: { allowedProviders: ['approved-a'] } });
    const insert = (provider: string, value: unknown) => withTenant(ctx, tx => tx.execute(sql`
      insert into public.ai_provider_config (id,tenant_id,provider,model,api_key_ciphertext,key_last4,provider_options)
      values (${randomUUID()}::uuid,${b.tenantId}::uuid,${provider}::ai_provider,'fictional/model','fixture-not-a-key','none',${JSON.stringify(value)}::jsonb)`));
    await expect(insert('openrouter', {})).rejects.toThrow();
    await expect(insert('anthropic', options)).rejects.toThrow();
    await insert('openrouter', options); await insert('anthropic', {});
  });
  it('accepts only the optional :free native suffix while retaining routing/privacy guards; syntax is not eligibility',async()=>{
    const ctx=adminCtx(b),options=readOpenRouterOptions({version:1,routing:{allowedProviders:['fictional-endpoint']}});
    await withTenant(ctx,tx=>tx.execute(sql`insert into public.ai_provider_config(id,tenant_id,provider,model,api_key_ciphertext,key_last4,provider_options) values(${randomUUID()}::uuid,${b.tenantId}::uuid,'openrouter','fictional/model:free','fixture-not-a-key','none',${JSON.stringify(options)}::jsonb)`));
    const[row]=await withTenant(ctx,tx=>tx.execute<{model:string;is_active:boolean}>(sql`select model,is_active from public.ai_provider_config where tenant_id=${b.tenantId}::uuid and provider='openrouter'`));expect(row).toEqual({model:'fictional/model:free',is_active:false});
    for(const model of ['fictional/model:online','fictional/model:nitro','fictional/model:free:online','openrouter/free'])await expect(withTenant(ctx,tx=>tx.execute(sql`update public.ai_provider_config set model=${model} where tenant_id=${b.tenantId}::uuid and provider='openrouter'`))).rejects.toThrow();
    await expect(withTenant(ctx,tx=>tx.execute(sql`update public.ai_provider_config set provider_options=${JSON.stringify({...options,plugins:['web']})}::jsonb where tenant_id=${b.tenantId}::uuid and provider='openrouter'`))).rejects.toThrow();
  });
  it('adds only nonsecret column access and retains tenant scoping on privileged v2 resolution', async () => {
    const ctx = adminCtx(b);
    await withTenant(ctx, tx => tx.execute(sql`insert into public.ai_provider_config
      (id,tenant_id,provider,model,api_key_ciphertext,key_last4,is_active)
      values (${randomUUID()}::uuid,${b.tenantId}::uuid,'anthropic','fictional-model','fixture-not-a-key','none',true)`));
    const [resolved] = await withTenant(ctx, tx => tx.execute<{ provider: string; provider_options: unknown }>(sql`select provider,provider_options from app.ai_active_provider_config_v2()`));
    expect(resolved).toEqual({ provider: 'anthropic', provider_options: {} });
    await expect(withTenant(ctx, tx => tx.execute(sql`select api_key_ciphertext from public.ai_provider_config`))).rejects.toThrow();
    const [privileges] = await withTenant(ctx, tx => tx.execute<{ options: boolean; secret: boolean }>(sql`select
      has_column_privilege(current_user,'public.ai_provider_config','provider_options','SELECT') as options,
      has_column_privilege(current_user,'public.ai_provider_config','api_key_ciphertext','SELECT') as secret`));
    expect(privileges).toEqual({ options: true, secret: false });
    const other = await seedBase();
    const unrelated = await withTenant(adminCtx(other), tx => tx.execute(sql`select provider,provider_options from app.ai_active_provider_config_v2()`));
    expect(unrelated).toHaveLength(0);
  });
});
