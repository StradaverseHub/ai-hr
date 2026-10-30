import * as governance from '../core/ai-governance';
import {generatePrivatePayrollComparisonAnalysis} from '../core/ai-payroll-comparison-analysis';
import {payrollComparisonSpec} from '../core/report-payroll-comparison';
/** Actual app-role source replay/admission/settlement, synthetic facts and mocked adapter only.
 * An explicit simulated technical review isolates custody tests; real pending-review refusal is
 * separately covered by provider-data-review-gate.test.ts. No actual specialist approval is claimed. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
const review=vi.hoisted(()=>({approved:true}));
vi.mock('../lib/ai/provider-data-reviews',()=>({providerDataReviewStatus(){return review.approved?'approved':'pending';},assertProviderDataContractReviewed(){if(!review.approved)throw Error('Review pending');}}));
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
 try{await expect(generatePrivateAiAnalysis(cfg,async()=>source())).rejects.toThrow('Synthetic output refusal');const rows=await withTenant(ctx(),tx=>tx.execute<{state:string;actual_tokens:number}>(sql`select state,actual_tokens::int as actual_tokens from ai_model_run`));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'failed',actual_tokens:10});}finally{adapter.mockRestore();}
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

it('retains completed inference usage when later deterministic analysis validation rejects model prose',async()=>{
 const cfg=await configuration(),adapter=vi.spyOn(anthropicAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:8,outputTokens:2,cachedInputTokens:0});return 'Invented Person received 999999 and a rating of 5';});
 try{await expect(generatePrivateAiAnalysis(cfg,async()=>source())).rejects.toThrow('protected analysis could not be verified');const rows=await withTenant(ctx(),tx=>tx.execute<{state:string;actual_tokens:number}>(sql`select state,actual_tokens::int as actual_tokens from ai_model_run`));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'completed',actual_tokens:10});}finally{adapter.mockRestore();}
});

it('returns a locally verified natural explanation after a complete private analysis',async()=>{
 const cfg=await configuration(),adapter=vi.spyOn(anthropicAdapter,'generate').mockResolvedValue(JSON.stringify({observations:[{cohort:'cohort_a',metric:'payroll_cost'}],comparisons:[]}));
 try{await expect(generatePrivateAiAnalysis(cfg,async()=>source())).resolves.toBe('Cohort A: payroll cost rose by 5–10% compared with the previous period.');}finally{adapter.mockRestore();}
});

it('issues payroll native analysis configuration in actual read-committed app-role transactions',async()=>{
 await configuration();const flow=vi.spyOn(governance,'generatePrivateAiAnalysis').mockImplementation(async cfg=>{expect(cfg.governance).toBeDefined();return 'Native source callback ready';});
 try{await expect(generatePrivatePayrollComparisonAnalysis(ctx(),payrollComparisonSpec(),[b.companyId],{})).resolves.toBe('Native source callback ready');expect(flow).toHaveBeenCalledOnce();}finally{flow.mockRestore();}
});


it('keeps observer hooks observational and preserves unknown charge after transport failure',async()=>{
 const cfg=await configuration();let hookArgs=-1;const observed:string[]=[];
 const wrapped=governance.withAiRunObserver(cfg,{beforeCall(...args:unknown[]){hookArgs=args.length;observed.push('before');},settled(){observed.push('settled');}});
 const prepared=await governance.preparePrivateAiTask(wrapped,'aggregate_snapshot_analysis_v1',async()=>({version:1,domain:'claims',window:'current_snapshot',cohorts:[{cohort:'cohort_a',population:40,metrics:[{metric:'pending_claim_share',support:40,numeratorPeople:10,slices:[]}]}]}));
 const adapter=vi.spyOn(anthropicAdapter,'generate').mockRejectedValue(Error('Synthetic lost transport receipt'));
 try{if(prepared.operation!=='draft')throw Error('Wrong fixture operation');await expect(generateDraft(prepared.configuration,prepared.args)).rejects.toThrow('Synthetic lost transport receipt');expect(hookArgs).toBe(0);expect(observed).toEqual(['before','settled']);const rows=await withTenant(ctx(),tx=>tx.execute<{state:string;actual_tokens:number|null}>(sql`select state,actual_tokens::int as actual_tokens from ai_model_run`));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'failed',actual_tokens:null});}finally{adapter.mockRestore();prepared.dispose();}
});
it('rechecks full snapshot sources even when projected bands remain identical and retains prior refusal checks',async()=>{
 const cfg=await configuration();let numerator=10,reads=0;
 const prepared=await governance.preparePrivateAiTask(cfg,'aggregate_snapshot_analysis_v1',async()=>{reads++;return {version:1,domain:'claims',window:'current_snapshot',cohorts:[{cohort:'cohort_a',population:100,metrics:[{metric:'pending_claim_share',support:100,numeratorPeople:numerator,slices:[]}]}]};});
 numerator=11;const adapter=vi.spyOn(anthropicAdapter,'generate');try{if(prepared.operation!=='draft')throw Error('Wrong fixture operation');await expect(generateDraft(prepared.configuration,prepared.args)).rejects.toThrow();expect(reads).toBe(2);expect(adapter).not.toHaveBeenCalled();}finally{adapter.mockRestore();prepared.dispose();}
});
it('checks every composed hook return and retains canonical settlement on invalid async hooks',async()=>{
 const cfg=await configuration(),calls:string[]=[];
 const wrapped=governance.withAiRunObserver(governance.withAiRunObserver(cfg,{beforeCall(){calls.push('first');}}),{beforeCall:(()=>Promise.resolve()) as unknown as ()=>void,settled(){calls.push('settled');}});
 const prepared=await preparePrivateAiAnalysis(wrapped,async()=>source()),adapter=vi.spyOn(anthropicAdapter,'generate');try{await expect(generateDraft(prepared.configuration,prepared.args)).rejects.toThrow('observation');expect(calls).toEqual(['first','settled']);expect(adapter).not.toHaveBeenCalled();}finally{adapter.mockRestore();prepared.dispose();}
});
