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

/** Authored UNRUN; requires the coordinated concurrency draft migration, never applied inline.
 * Genuine resolver/governance/admission/settlement. Provider transport alone is mocked. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {resolveActiveAiConfig} from '../core/ai-config';
import {aiManagementView,clearUserAllowance,setAiAllowance} from '../core/ai-management';
import {generateDraft} from '../lib/ai';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,a:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{await resetDb();b=await seedBase();a={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};vi.stubEnv('OPENAI_API_KEY','fictional-concurrency-transport-only');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');});
const cap=(kind:'user'|'user_default'|'company',maxConcurrent:number|null)=>setAiAllowance(a,{kind,subjectId:kind==='user'?b.adminUserId:kind==='company'?b.companyId:null,dailyRequests:null,monthlyTokens:null,maxConcurrent,enabled:true});
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,b.tenantId));
async function call(){const cfg=await withTenant(a,tx=>resolveActiveAiConfig(tx,a,'pay_rule_draft'));if(!cfg)throw Error('Missing issued fixture configuration');return generateDraft(cfg,{system:'Synthetic local fixture.',prompt:'No HR data.',maxTokens:8});}
describe('actual pending reservation concurrency',()=>{
 it('refuses a second provider call while the first actual transport is in flight, then admits after settlement',async()=>{await cap('user',1);let release!:()=>void,arrive!:()=>void;const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>arrive=r);const adapter=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{arrive();await held;args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return 'synthetic';});const first=call();try{await Promise.race([entered,first.then(()=>{throw Error('Transport unexpectedly finished before the held interval');})]);await expect(call()).rejects.toMatchObject({reason:'concurrent_limit'});expect(adapter).toHaveBeenCalledOnce();expect((await runs()).filter(row=>row.state==='pending')).toHaveLength(1);}finally{release();await first;}await expect(call()).resolves.toBe('synthetic');expect(adapter).toHaveBeenCalledTimes(2);expect((await runs()).filter(row=>row.state==='completed')).toHaveLength(2);});
 it('counts an actual orphan reservation across month boundaries without TTL release',async()=>{await cap('user',1);const [pending]=await withTenant(a,tx=>tx.execute<{run_id:string}>(sql`select * from app.ai_admit('pay_rule_draft','draft','openai','fixture',100)`));await owner.db.update(schema.aiModelRun).set({startedAt:new Date('2020-01-01T00:00:00Z')}).where(eq(schema.aiModelRun.id,pending.run_id));const adapter=vi.spyOn(openaiAdapter,'generate');await expect(call()).rejects.toMatchObject({reason:'concurrent_limit'});expect(adapter).not.toHaveBeenCalled();expect((await runs()).find(row=>row.id===pending.run_id)).toMatchObject({state:'pending',actualTokens:null,finishedAt:null});await withTenant(a,tx=>tx.execute(sql`select app.ai_settle(${pending.run_id}::uuid,false,null)`));});
 it('individual policy replaces the default while company controls remain cumulative',async()=>{await cap('user_default',0);await cap('user',null);const adapter=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return 'synthetic';});await expect(call()).resolves.toBe('synthetic');await clearUserAllowance(a,b.adminUserId);await expect(call()).rejects.toMatchObject({reason:'concurrent_limit'});await cap('user',null);await cap('company',0);await expect(call()).rejects.toMatchObject({reason:'concurrent_limit'});expect(adapter).toHaveBeenCalledOnce();});
 it('canonical failed settlement frees execution concurrency while unknown token reservations remain held',async()=>{await cap('user',1);const adapter=vi.spyOn(openaiAdapter,'generate').mockRejectedValueOnce(new Error('Synthetic transport failure')).mockResolvedValue('synthetic');await expect(call()).rejects.toThrow();const failed=(await runs()).find(row=>row.state==='failed');expect(failed?.actualTokens).toBeNull();expect(failed?.reservedTokens).toBeGreaterThan(0);await expect(call()).resolves.toBe('synthetic');expect(adapter).toHaveBeenCalledTimes(2);expect((await runs()).find(row=>row.id===failed?.id)?.reservedTokens).toBe(failed?.reservedTokens);});
 it.each([-1,0.5,Infinity,1000001])('rejects invalid configured concurrency %s without a policy write',async value=>{await expect(cap('user',value)).rejects.toThrow();expect(await owner.db.select().from(schema.aiControlPolicy)).toEqual([]);});
 it('group administration shows actual reported zero separately from absent accounting and cannot see another tenant',async()=>{const reserve=async()=>{const [row]=await withTenant(a,tx=>tx.execute<{run_id:string}>(sql`select * from app.ai_admit('provider_evaluation','draft','openrouter','fictional/model',8)`));return row.run_id;};const zero=await reserve(),missing=await reserve();await withTenant(a,tx=>tx.execute(sql`select app.ai_settle_observed(${zero}::uuid,true,0,'reported',0,0,0,0,12.5)`));await withTenant(a,tx=>tx.execute(sql`select app.ai_settle_observed(${missing}::uuid,true,null,'missing',null,null,null,null,null)`));const view=await aiManagementView(a);expect(view.runs.find(row=>row.id===zero)).toMatchObject({reportedCredits:'0',roundTripMs:12.5,observationStatus:'reported'});expect(view.runs.find(row=>row.id===missing)).toMatchObject({reportedCredits:null,roundTripMs:null,observationStatus:'missing'});const other=await seedBase(),otherAdmin={...await entitledCtx(other),grants:[{role:'hr_admin',companyId:null}]};expect((await aiManagementView(otherAdmin)).runs).toEqual([]);});
});
