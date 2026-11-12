/** Background AI Formula Generator (core/pay-formula-ai-job.ts, migration 5130). Actual database authority and row
 * security; the provider transport is synthetic (no real AI provider is called). */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as configuration from '../core/ai-config';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {AiAllowanceError} from '../lib/ai';
import {AiPrivacyGateError} from '../lib/ai/provider-privacy-error';
import {draftPayFormula,payFormulaDraftFailureReason,PayFormulaDraftFailure,PAY_FORMULA_BACKGROUND_TIMEOUT_MS} from '../core/pay-formula-ai';
import {discardPayFormulaDraftJob,payFormulaDraftJobReadSql,readPayFormulaDraftJob,startPayFormulaDraftJob} from '../core/pay-formula-ai-job';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
const fixture=vi.hoisted(()=>({reviewed:true}));
vi.mock('../lib/ai/provider-data-reviews',async original=>{
 const actual=await original<typeof import('../lib/ai/provider-data-reviews')>();
 return {...actual,assertProviderDataContractReviewed:(contract:string,digest:string)=>{
  if(contract==='authored_pay_formula_v2'&&fixture.reviewed)return;
  return actual.assertProviderDataContractReviewed(contract,digest);
 }};
});
const realSetTimeout=globalThis.setTimeout;
const draft={source:'Return {#Basic}',explanation:'A fictional background draft',questions:[],unsupported:[]};
const input={requirement:'Return basic pay for this fictional calculation',disclosureAccepted:true};
const zero={inputTokens:0,outputTokens:0,cachedInputTokens:0};
let base:Base,ctx:SessionContext;
type Work=()=>Promise<void>;
/** Captures the scheduled background unit instead of next/server `after`, so the test decides when it runs. */
function scheduler(){const queued:Work[]=[];return{schedule:(work:Work)=>{queued.push(work);},queued,async run(){const work=queued.splice(0);for(const unit of work)await unit();}};}
/** A synthetic provider that answers after `ms` unless the gateway aborts it first. */
function provider(ms:number,reply=JSON.stringify(draft),wait:(fn:()=>void,ms:number)=>unknown=realSetTimeout){
 vi.mocked(openaiAdapter.generate).mockImplementation(async(_cfg,args)=>{
  await new Promise<void>((resolve,reject)=>{
   const timer=wait(resolve,ms) as ReturnType<typeof setTimeout>;
   args.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('fixture provider aborted'));},{once:true});
  });
  args.onUsage?.(zero);return reply;
 });
}
async function counts(){const result:Record<string,number>={};for(const table of ['pay_formula','pay_formula_revision','pay_formula_test','pay_formula_event','payroll_batch','payslip']){const [r]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from ${sql.identifier(table)}`);result[table]=r.n;}return result;}
async function lastRun(){const [r]=await owner.db.execute<{state:string;feature_id:string}>(sql`select state,feature_id from ai_model_run where tenant_id=${base.tenantId}::uuid order by started_at desc limit 1`);return r;}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');ctx=await entitledCtx(base);fixture.reviewed=true;
 vi.stubEnv('OPENAI_API_KEY','fictional-formula-transport');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 vi.spyOn(configuration,'resolveActiveAiConfig');vi.spyOn(openaiAdapter,'generate');provider(0);
});

describe('background formula generation',()=>{
 it('returns before the provider runs, then records the governed draft for the author only',async()=>{
  const queue=scheduler(),before=await counts();
  const started=await startPayFormulaDraftJob(ctx,input,queue.schedule);
  expect(started).toMatchObject({outcome:'started',job:{state:'running',reason:null,result:null,timeoutSeconds:PAY_FORMULA_BACKGROUND_TIMEOUT_MS/1000}});
  expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(queue.queued).toHaveLength(1);
  expect(await readPayFormulaDraftJob(ctx)).toMatchObject({id:started.job.id,state:'running'});
  // The same request while it runs resumes it and schedules nothing new.
  expect(await startPayFormulaDraftJob(ctx,input,queue.schedule)).toMatchObject({outcome:'resumed',job:{id:started.job.id}});expect(queue.queued).toHaveLength(1);
  await queue.run();
  const done=await readPayFormulaDraftJob(ctx);
  expect(done).toMatchObject({id:started.job.id,state:'succeeded',reason:null,result:{source:'Return {#Basic}',valid:true}});
  expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(vi.mocked(openaiAdapter.generate).mock.calls[0][1].timeoutMs).toBe(PAY_FORMULA_BACKGROUND_TIMEOUT_MS);
  expect(await lastRun()).toMatchObject({state:'completed',feature_id:'pay_rule_draft'});
  // Drafts never save, activate or apply themselves.
  expect(await counts()).toEqual(before);
  // No requirement text is stored: only its digest.
  const [row]=await owner.db.execute<{text:string}>(sql`select row_to_json(j)::text as text from pay_formula_ai_draft_job j`);
  expect(row.text).not.toContain(input.requirement);
  await discardPayFormulaDraftJob(ctx);expect(await readPayFormulaDraftJob(ctx)).toBeNull();
 });

 it('refuses a second, different request of the same login while one is running (one provider call per login)',async()=>{
  const queue=scheduler();const first=await startPayFormulaDraftJob(ctx,input,queue.schedule);
  const other=await startPayFormulaDraftJob(ctx,{...input,requirement:'A different fictional calculation'},queue.schedule);
  expect(other).toMatchObject({outcome:'busy',job:{id:first.job.id,state:'running'}});expect(queue.queued).toHaveLength(1);
  // A running draft cannot be discarded; it finishes and is then replaceable.
  await discardPayFormulaDraftJob(ctx);expect(await readPayFormulaDraftJob(ctx)).toMatchObject({state:'running'});
  await queue.run();
  expect(await startPayFormulaDraftJob(ctx,{...input,requirement:'A different fictional calculation'},queue.schedule)).toMatchObject({outcome:'started'});
 });

 // Explicit timeout: the synthetic provider waits 30 s of scaled time (300 ms real); see the comment below.
 it('lets a provider slower than the 22 s request cap finish within the background budget, and keeps the request path at 22 s',async()=>{
  // Only the gateway's transport deadlines (22 s request path, 90 s background) run 100x faster, so the provider's
  // 300 ms reply stands for 30 s: beyond the request cap and within the background budget. All other timers are real.
  vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:(...args:unknown[])=>void,ms?:number,...rest:unknown[])=>
   realSetTimeout(fn,ms===22_000||ms===PAY_FORMULA_BACKGROUND_TIMEOUT_MS?ms/100:ms,...rest)) as unknown as typeof setTimeout);
  provider(300);
  await expect(draftPayFormula(ctx,input)).rejects.toThrow();
  expect(vi.mocked(openaiAdapter.generate).mock.calls[0][1].timeoutMs).toBe(22_000);
  const queue=scheduler();const started=await startPayFormulaDraftJob(ctx,input,queue.schedule);await queue.run();
  expect(vi.mocked(openaiAdapter.generate).mock.calls[1][1].timeoutMs).toBe(PAY_FORMULA_BACKGROUND_TIMEOUT_MS);
  expect(await readPayFormulaDraftJob(ctx)).toMatchObject({id:started.job.id,state:'succeeded',result:{source:'Return {#Basic}'}});
 },30_000);

 it('ends with the specific timeout reason when the budget is exceeded, and settles the model run',async()=>{
  provider(60_000);
  const queue=scheduler();const started=await startPayFormulaDraftJob(ctx,input,queue.schedule,1000);
  expect(started.job.timeoutSeconds).toBe(1);await queue.run();
  expect(await readPayFormulaDraftJob(ctx)).toMatchObject({id:started.job.id,state:'failed',reason:'timeout',timeoutSeconds:1,result:null});
  expect(await lastRun()).toMatchObject({state:'failed'});
 },20_000);

 it('ends with invalid_draft when the reply fails the formula checks, and with unavailable when no AI is configured',async()=>{
  provider(0,JSON.stringify({source:'Return {#PayItem}("INVENTED")',explanation:'Invented reference',questions:[],unsupported:[]}));
  let queue=scheduler();await startPayFormulaDraftJob(ctx,input,queue.schedule);await queue.run();
  expect(await readPayFormulaDraftJob(ctx)).toMatchObject({state:'failed',reason:'invalid_draft',result:null});
  vi.mocked(configuration.resolveActiveAiConfig).mockResolvedValueOnce(null);
  queue=scheduler();await startPayFormulaDraftJob(ctx,input,queue.schedule);await queue.run();
  expect(await readPayFormulaDraftJob(ctx)).toMatchObject({state:'failed',reason:'unavailable'});
 });

 it('maps every refusal to one closed, plain reason',()=>{
  expect(payFormulaDraftFailureReason(new AiAllowanceError('paused'))).toBe('paused');
  expect(payFormulaDraftFailureReason(new AiAllowanceError('daily_limit'))).toBe('daily_limit');
  expect(payFormulaDraftFailureReason(new AiPrivacyGateError())).toBe('review_required');
  expect(payFormulaDraftFailureReason(new PayFormulaDraftFailure('timeout'))).toBe('timeout');
  expect(payFormulaDraftFailureReason(new Error('PRIVATE provider payload'))).toBe('failed');
 });

 it('reports a run that outlived its deadline as interrupted and lets a new start replace it',async()=>{
  const queue=scheduler();const started=await startPayFormulaDraftJob(ctx,input,queue.schedule);
  await owner.db.execute(sql`update pay_formula_ai_draft_job set started_at=now()-interval '4 minutes',deadline_at=now()-interval '1 second'`);
  expect(await readPayFormulaDraftJob(ctx)).toMatchObject({id:started.job.id,state:'failed',reason:'interrupted'});
  const again=await startPayFormulaDraftJob(ctx,input,queue.schedule);expect(again.outcome).toBe('started');expect(again.job.id).not.toBe(started.job.id);
  // The stale unit finds its generation replaced and writes nothing.
  await queue.queued[0]();expect(await readPayFormulaDraftJob(ctx)).toMatchObject({id:again.job.id,state:'running'});
 });

 it('isolates the result to the requesting login and tenant, refuses non-authors and purges expired rows',async()=>{
  const queue=scheduler();await startPayFormulaDraftJob(ctx,input,queue.schedule);await queue.run();
  const colleague={...ctx,userId:await createAppUser(base.tenantId,null,'hr_admin')};
  expect(await readPayFormulaDraftJob(colleague)).toBeNull();
  const other=await seedBase();const outsider=await entitledCtx(other);
  expect(await readPayFormulaDraftJob(outsider)).toBeNull();
  expect(await readPayFormulaDraftJob({...outsider,userId:ctx.userId}).catch(()=>null)).toBeNull();
  const [visible]=await withTenant(colleague,tx=>tx.execute<{n:number}>(sql`select count(*)::int n from pay_formula_ai_draft_job`));expect(visible.n).toBe(0);
  // A colleague's start and discard never touch the author's running or finished row.
  await discardPayFormulaDraftJob(colleague);expect(await readPayFormulaDraftJob(ctx)).toMatchObject({state:'succeeded'});
  const employee={...ctx,userId:await createAppUser(base.tenantId,null,'employee'),roles:['employee']};
  await expect(startPayFormulaDraftJob(employee,input,scheduler().schedule)).rejects.toThrow();
  const [rows]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from pay_formula_ai_draft_job`);expect(rows.n).toBe(1);
  // Expired: unreadable at once, then removed by the next start anywhere in the tenant.
  await owner.db.execute(sql`update pay_formula_ai_draft_job set expires_at=now()`);
  expect(await readPayFormulaDraftJob(ctx)).toBeNull();
  await startPayFormulaDraftJob(colleague,input,scheduler().schedule);
  const [left]=await owner.db.execute<{user_id:string}>(sql`select user_id from pay_formula_ai_draft_job`);expect(left.user_id).toBe(colleague.userId);
 });

 it('polls with one primary-key point read',async()=>{
  const [pk]=await owner.db.execute<{columns:string}>(sql`select string_agg(a.attname,',' order by k.ord) as columns from pg_index i
   cross join lateral unnest(i.indkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
   where i.indrelid='public.pay_formula_ai_draft_job'::regclass and i.indisprimary`);
  expect(pk.columns).toBe('tenant_id,user_id');
  const plan=await withTenant(ctx,async tx=>{await tx.execute(sql`set local enable_seqscan=off`);return tx.execute<{'QUERY PLAN':unknown}>(sql`explain (format json) ${payFormulaDraftJobReadSql(ctx)}`);});
  const text=JSON.stringify(plan);
  expect(text).toContain('pay_formula_ai_draft_job_pkey');expect(text).not.toContain('Seq Scan');expect(text).not.toContain('"Node Type":"Sort"');
 });
});
