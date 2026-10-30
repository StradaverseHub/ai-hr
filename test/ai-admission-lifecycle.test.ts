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

/** Authored UNRUN: actual app-role admission/settlement hooks, fictional adapter; no provider API. */
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {aiModelRun,aiProviderConfig} from '../db/schema';
import {resolveActiveAiConfig} from '../core/ai-config';
import {withAiAdmissionCheck,withAiAdmissionLifecycle} from '../core/ai-governance';
import {encryptSecret} from '../lib/ai/crypto';
import {generateDraft} from '../lib/ai';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;const ctx=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-lifecycle-secret-01234567890123456789');await migrateTestDb();});beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
async function config(){await owner.db.insert(aiProviderConfig).values({tenantId:b.tenantId,provider:'openrouter',model:'fictional/model',providerOptions:readOpenRouterOptions({version:1,routing:{allowedProviders:['approved-a']}}) as unknown as Record<string,unknown>,apiKeyCiphertext:encryptSecret('fictional-lifecycle-key',b.tenantId),keyLast4:'-key',isActive:true});return(await withTenant(ctx(),tx=>resolveActiveAiConfig(tx,ctx(),'pay_rule_draft')))!;}
it('composes source checks/hooks and exposes only the actual own pending run inside its admission transaction, then exact settlement',async()=>{
 const calls:string[]=[],base=await config();let runId='';
 let cfg=withAiAdmissionLifecycle(base,'pay_rule_draft',{async admitted(tx,event){calls.push('first');runId=event.runId;const [r]=await tx.execute<{state:string;user_id:string}>(sql`select state,user_id from ai_model_run where id=${event.runId}::uuid`);expect(r).toMatchObject({state:'pending',user_id:b.adminUserId});expect(event.request.operation).toBe('draft');},async settled(tx,event){calls.push('settled');const [r]=await tx.execute<{state:string}>(sql`select state from ai_model_run where id=${event.runId}::uuid`);expect(r.state).toBe('completed');expect(event.actualTokens).toBeNull();expect(event.accounting.openrouterAccountCostCredits).toBeNull();}});
 cfg=withAiAdmissionCheck(cfg,'pay_rule_draft',async()=>{calls.push('check');});cfg=withAiAdmissionLifecycle(cfg,'pay_rule_draft',{async admitted(){calls.push('second');}});
 const spy=vi.spyOn(openrouterAdapter,'generate').mockResolvedValue('Synthetic response');try{await expect(generateDraft(cfg,{system:'Synthetic',prompt:'Synthetic'})).resolves.toBe('Synthetic response');}finally{spy.mockRestore();}expect(calls).toEqual(['check','first','second','settled']);expect((await owner.db.select().from(aiModelRun).where(eq(aiModelRun.id,runId)))[0].state).toBe('completed');
});
it('rolls back failed claim and admission together before any provider call',async()=>{const base=await config(),spy=vi.spyOn(openrouterAdapter,'generate');const cfg=withAiAdmissionLifecycle(base,'pay_rule_draft',{async admitted(){throw Error('fictional durable claim refusal');}});try{await expect(generateDraft(cfg,{system:'Synthetic',prompt:'Synthetic'})).rejects.toThrow();expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}expect(await owner.db.select().from(aiModelRun).where(eq(aiModelRun.tenantId,b.tenantId))).toHaveLength(0);});
it('keeps reservation pending when durable settled callback fails, without automatic resend',async()=>{const base=await config(),spy=vi.spyOn(openrouterAdapter,'generate').mockResolvedValue('Synthetic response');const cfg=withAiAdmissionLifecycle(base,'pay_rule_draft',{async settled(){throw Error('fictional durable settlement refusal');}});try{await expect(generateDraft(cfg,{system:'Synthetic',prompt:'Synthetic'})).rejects.toThrow('reservation remains held');expect(spy).toHaveBeenCalledTimes(1);}finally{spy.mockRestore();}const rows=await owner.db.select().from(aiModelRun).where(eq(aiModelRun.tenantId,b.tenantId));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'pending',actualTokens:null,finishedAt:null,providerObservationStatus:null});});
it('refuses copied configs and wrong-feature hooks rather than allowing client callback provenance',async()=>{const cfg=await config();expect(()=>withAiAdmissionLifecycle({...cfg},'pay_rule_draft',{})).toThrow();expect(()=>withAiAdmissionLifecycle(cfg,'hr_assistant',{})).toThrow();});
