/** Native configuration storage only: no provider transport, activation or synthetic support bindings. */
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {getAiConfigView,saveAiProviderConfig,removeAiProviderConfig} from '../core/ai-config';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {adminCtx,createAppUser,migrateTestDb,resetDb,seedBase,closeAll,owner,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-permissions-only-secret');await resetDb();b=await seedBase();});
afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
it('uses the same real group floor for live configuration and private candidate readers',async()=>{
 const userId=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
 const scoped={...adminCtx(b),userId,personId:null,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const query=sql`select app.organisation_settings_function_allowed('aiConfig','view',NULL) as view,app.organisation_settings_function_allowed('aiConfig','add',NULL) as add,app.organisation_settings_function_allowed('aiConfig','edit',NULL) as edit,app.organisation_settings_function_allowed('aiConfig','delete',NULL) as delete`;
 expect((await withTenant(scoped,tx=>tx.execute(query)))[0]).toEqual({view:false,add:false,edit:false,delete:false});
 expect((await withTenant(adminCtx(b),tx=>tx.execute(query)))[0]).toEqual({view:true,add:true,edit:true,delete:true});
 await expect(getAiConfigView(scoped)).rejects.toThrow();
 await expect(withTenant(scoped,tx=>tx.execute(sql`select * from app.ai_provider_candidate_view_v1()`))).rejects.toThrow();
});
it('retains native candidate save/edit/remove and audit without activating or admitting provider work',async()=>{
 const ctx=adminCtx(b),providerOptions=readOpenRouterOptions({version:1,routing:{allowedProviders:['fictional-route'],allowFallbacks:false,sort:'latency'}});
 await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/model',apiKey:'fictional-key-only',providerOptions});
 const before=await getAiConfigView(ctx);expect(before.providers.find(row=>row.provider==='openrouter')).toMatchObject({candidateSaved:true,hasStoredConfiguration:false,isActive:false});
 await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/updated',providerOptions});
 expect((await getAiConfigView(ctx)).providers.find(row=>row.provider==='openrouter')?.model).toBe('fictional/updated');
 await expect(withTenant(ctx,tx=>tx.execute(sql`select * from ai_provider_candidate`))).rejects.toThrow();
 await removeAiProviderConfig(ctx,{provider:'openrouter'});
 expect((await getAiConfigView(ctx)).providers.find(row=>row.provider==='openrouter')).toMatchObject({candidateSaved:false,isActive:false});
 const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId));
 expect(events.filter(row=>row.eventType==='ai-provider-config.candidate-saved')).toHaveLength(2);expect(events.some(row=>row.eventType==='ai-provider-config.candidate-removed')).toBe(true);
 expect(JSON.stringify(events)).not.toContain('fictional-key-only');expect(await owner.db.select().from(s.aiModelRun)).toEqual([]);
});
