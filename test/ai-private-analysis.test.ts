/** Actual app-role source replay/admission/settlement, synthetic facts and mocked adapter only.
 * An explicit simulated technical review isolates custody tests; real pending-review refusal is
 * separately covered by provider-data-review-gate.test.ts. No actual specialist approval is claimed. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
const review=vi.hoisted(()=>({approved:true}));
vi.mock('../lib/ai/provider-data-reviews',()=>({assertProviderDataContractReviewed(){if(!review.approved)throw Error('Review pending');}}));
import {withTenant,type SessionContext} from '../db/client';
import {aiProviderConfig} from '../db/schema';
import {resolveActiveAiConfig} from '../core/ai-config';
import {preparePrivateAiAnalysis,generatePrivateAiAnalysis,withAiAdmissionCheck,withAiAdmissionLifecycle} from '../core/ai-governance';
import {generateDraft} from '../lib/ai';
import {encryptSecret} from '../lib/ai/crypto';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;const ctx=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const source=()=>({version:1,domain:'payroll',window:'calendar_month',cohorts:[{cohort:'cohort_a',population:100,metrics:[{metric:'payroll_cost',support:100,changeBand:'increase_5_to_10_percent',drivers:[{code:'recorded_headcount_change',relationship:'recorded_contributor'}],slices:[{category:'base_pay',people:80,changeBand:'increase_up_to_5_percent'}]}]}]});
beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-privacy-secret-01234567890123456789');await migrateTestDb();});
beforeEach(async()=>{await resetDb();b=await seedBase();review.approved=true;});afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
async function configuration(){await owner.db.insert(aiProviderConfig).values({tenantId:b.tenantId,provider:'anthropic',model:'fictional-model',apiKeyCiphertext:encryptSecret('fictional-no-network-key',b.tenantId),keyLast4:'-key',isActive:true});return(await withTenant(ctx(),tx=>resolveActiveAiConfig(tx,ctx(),'report_insight')))!;}
it('replays native sources in actual admission, preserves previous checks/lifecycle and binds only minimized bytes',async()=>{
 let reads=0;const calls:string[]=[];let cfg=await configuration();
 cfg=withAiAdmissionCheck(cfg,'report_insight',async()=>{calls.push('prior-check');});
 const prepared=await preparePrivateAiAnalysis(cfg,async(_tx,current)=>{expect(current.tenantId).toBe(b.tenantId);reads++;return source();});
 cfg=withAiAdmissionLifecycle(prepared.configuration,'report_insight',{async admitted(){calls.push('admitted');},async settled(_tx,event){calls.push('settled');expect(event.actualTokens).toBe(7);}});
 const adapter=vi.spyOn(anthropicAdapter,'generate').mockImplementation(async(_cfg,args)=>{expect(args.prompt).toContain('increase_5_to_10_percent');expect(args.prompt).toContain('100_to_249');expect(args.prompt).not.toContain(b.tenantId);expect(args.system).not.toContain(b.adminUserId);args.onUsage?.({inputTokens:4,outputTokens:3,cachedInputTokens:0});return 'Synthetic protected comparison';});
 try{await expect(generateDraft(cfg,prepared.args)).resolves.toBe('Synthetic protected comparison');expect(reads).toBe(2);expect(calls).toEqual(['prior-check','admitted','settled']);await expect(generateDraft(cfg,prepared.args)).rejects.toThrow();expect(adapter).toHaveBeenCalledOnce();}finally{adapter.mockRestore();prepared.dispose();}
});
it('refuses changed sources and cancelled prepared requests without admissions or adapter calls',async()=>{
 const cfg=await configuration();let current=source();const prepared=await preparePrivateAiAnalysis(cfg,async()=>current);
 current=source();current.cohorts[0].metrics[0].changeBand='unchanged';const adapter=vi.spyOn(anthropicAdapter,'generate');
 try{await expect(generateDraft(prepared.configuration,prepared.args)).rejects.toThrow();prepared.dispose();await expect(generateDraft(prepared.configuration,prepared.args)).rejects.toThrow();expect(adapter).not.toHaveBeenCalled();const rows=await withTenant(ctx(),tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from ai_model_run`));expect(rows[0].n).toBe(0);}finally{adapter.mockRestore();}
});
it('preserves actual charged usage and failed settlement when the provider rejects output',async()=>{
 const cfg=await configuration(),adapter=vi.spyOn(anthropicAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:8,outputTokens:2,cachedInputTokens:0});throw Error('Synthetic output refusal');});
 try{await expect(generatePrivateAiAnalysis(cfg,async()=>source())).rejects.toThrow('Synthetic output refusal');const rows=await withTenant(ctx(),tx=>tx.execute<{state:string;actual_tokens:number}>(sql`select state,actual_tokens from ai_model_run`));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'failed',actual_tokens:10});}finally{adapter.mockRestore();}
});
it('keeps a pending specialist review blocking before any reservation even after a valid local projection',async()=>{
 const cfg=await configuration();review.approved=false;const adapter=vi.spyOn(anthropicAdapter,'generate');
 try{await expect(generatePrivateAiAnalysis(cfg,async()=>source())).rejects.toThrow('Review pending');expect(adapter).not.toHaveBeenCalled();const rows=await withTenant(ctx(),tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from ai_model_run`));expect(rows[0].n).toBe(0);}finally{adapter.mockRestore();}
});
it('rejects copied configs and preserves added native refusal checks',async()=>{
 const cfg=await configuration();await expect(preparePrivateAiAnalysis({...cfg},async()=>source())).rejects.toThrow();
 const prepared=await preparePrivateAiAnalysis(cfg,async()=>source());const guarded=withAiAdmissionCheck(prepared.configuration,'report_insight',async()=>{throw Error('Synthetic native refusal');});
 const adapter=vi.spyOn(anthropicAdapter,'generate');try{await expect(generateDraft(guarded,prepared.args)).rejects.toThrow();expect(adapter).not.toHaveBeenCalled();}finally{adapter.mockRestore();prepared.dispose();}
});
