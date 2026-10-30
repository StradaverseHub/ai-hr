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

/** Authored UNRUN: real app-role accounting/locks with a fictional adapter, never a provider API. */
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {aiModelRun,aiProviderConfig,roleAssignment} from '../db/schema';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {isAiPrincipalCurrentTx} from '../core/ai-principal';
import {resolveActiveAiConfig} from '../core/ai-config';
import {withAiAdmissionLifecycle} from '../core/ai-governance';
import {generateDraft} from '../lib/ai';
import {encryptSecret} from '../lib/ai/crypto';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
const ctx=():SessionContext=>({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]});
beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-settlement-ownership-secret-0123456789');await migrateTestDb();});
beforeEach(async()=>{await resetDb();base=await seedBase();});afterAll(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await closeAll();});
async function config(){
 await owner.db.insert(aiProviderConfig).values({tenantId:base.tenantId,provider:'openrouter',model:'fictional/settlement-model',providerOptions:readOpenRouterOptions({version:1,routing:{allowedProviders:['approved-a']}}) as unknown as Record<string,unknown>,apiKeyCiphertext:encryptSecret('fictional-settlement-key',base.tenantId),keyLast4:'-key',isActive:true});
 return(await withTenant(ctx(),tx=>resolveActiveAiConfig(tx,ctx(),'pay_rule_draft')))!;
}
function terminal(args:{onUsage?:((usage:{inputTokens:number;outputTokens:number;cachedInputTokens:number})=>void);onObservation?:((value:import('../lib/ai/types').AiRunObservation)=>void)}){
 const usage={inputTokens:3,outputTokens:2,cachedInputTokens:0};args.onUsage?.(usage);args.onObservation?.({version:1,provider:'openrouter',accountCostUnit:'openrouter_account_credits',usage,accountCostCredits:0.02,elapsedMs:2});
}
async function waitingOnAccess(){
 for(let attempt=0;attempt<300;attempt++){
  const [row]=await owner.db.execute<{waiting:boolean}>(sql`with wanted as(select hashtextextended(${'access-configuration:'+base.tenantId},0) as key)
   select exists(select 1 from pg_locks l cross join wanted w where l.locktype='advisory' and not l.granted
    and l.database=(select oid from pg_database where datname=current_database()) and l.objsubid=1
    and l.classid::bigint=((w.key>>32)&4294967295::bigint) and l.objid::bigint=(w.key&4294967295::bigint)) as waiting`);
  if(row.waiting)return true;await new Promise<void>(resolve=>setTimeout(resolve,10));
 }return false;
}
it('waits for Access without holding ai-control, then settles once after the interval releases',async()=>{
 const cfg=await config();let providerEntered!:()=>void,releaseProvider!:()=>void,accessEntered!:()=>void,releaseAccess!:()=>void;
 const entered=new Promise<void>(resolve=>{providerEntered=resolve;}),resumeProvider=new Promise<void>(resolve=>{releaseProvider=resolve;}),held=new Promise<void>(resolve=>{accessEntered=resolve;}),resumeAccess=new Promise<void>(resolve=>{releaseAccess=resolve;});
 const spy=vi.spyOn(openrouterAdapter,'generate').mockImplementation(async(_configuration,args)=>{providerEntered();await resumeProvider;terminal(args);return 'Fictional response';});
 const pending=generateDraft(cfg,{system:'Synthetic only',prompt:'Synthetic request'});
 const outcome=pending.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
 let holder:Promise<void>|undefined,probe!:()=>Promise<boolean>;
 try{
  await Promise.race([entered,outcome.then(()=>{throw Error('The fictional provider was not reached.');})]);
  holder=withTenant(ctx(),async tx=>{await lockAccessConfigurationTx(tx,base.tenantId);probe=async()=>{const [row]=await tx.execute<{available:boolean}>(sql`select pg_try_advisory_xact_lock(hashtext('ai-control'),hashtext(${base.tenantId}::text)) as available`);return row.available;};accessEntered();await resumeAccess;});
  await Promise.race([held,holder.then(()=>{throw Error('The held interval was not reached.');})]);releaseProvider();
  expect(await waitingOnAccess()).toBe(true);expect(await probe()).toBe(true);
 }finally{releaseProvider();releaseAccess();await holder;await outcome;spy.mockRestore();}
 expect(await outcome).toEqual({ok:true,value:'Fictional response'});
 const rows=await owner.db.select().from(aiModelRun).where(eq(aiModelRun.tenantId,base.tenantId));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'completed',actualTokens:5,openrouterAccountCostCredits:'0.02'});
});
it('keeps actual billing when the admitted identity snapshot loses its roles, without projecting private metadata',async()=>{
 const captured=ctx(),issued=await config();let current:boolean|undefined;
 const cfg=withAiAdmissionLifecycle(issued,'pay_rule_draft',{async settled(tx){current=await isAiPrincipalCurrentTx(tx,captured);if(!current)return;throw Error('Stale authority must not project private metadata.');}});
 const spy=vi.spyOn(openrouterAdapter,'generate').mockImplementation(async(_configuration,args)=>{
  // Owner fixture simulates a concurrent role change, not a canonical role-edit authorization test.
  await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,base.adminUserId));
  await withTenant({...captured,roles:[],grants:[]},async tx=>{expect(await isAiPrincipalCurrentTx(tx,{...captured,roles:[],grants:[]})).toBe(true);});
  terminal(args);return 'Synthetic response';
 });
 try{await expect(generateDraft(cfg,{system:'Synthetic only',prompt:'Synthetic request'})).resolves.toBe('Synthetic response');}finally{spy.mockRestore();}
 expect(current).toBe(false);const rows=await owner.db.select().from(aiModelRun).where(eq(aiModelRun.tenantId,base.tenantId));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'completed',actualTokens:5,providerObservationStatus:'reported',openrouterAccountCostCredits:'0.02'});
});
it('propagates an actual principal-query SQL failure and rolls settlement back instead of treating it as a soft refusal',async()=>{
 const issued=await config();const cfg=withAiAdmissionLifecycle(issued,'pay_rule_draft',{async settled(tx){if(!await isAiPrincipalCurrentTx(tx,{...ctx(),userId:'not-a-uuid'}))return;}});
 const spy=vi.spyOn(openrouterAdapter,'generate').mockImplementation(async(_configuration,args)=>{terminal(args);return 'Synthetic response';});
 try{await expect(generateDraft(cfg,{system:'Synthetic only',prompt:'Synthetic request'})).rejects.toThrow('reservation remains held');}finally{spy.mockRestore();}
 const rows=await owner.db.select().from(aiModelRun).where(eq(aiModelRun.tenantId,base.tenantId));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'pending',actualTokens:null,finishedAt:null,providerObservationStatus:null});
});
