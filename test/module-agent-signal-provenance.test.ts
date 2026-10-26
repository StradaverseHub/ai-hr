/** Actual closed human signals and opaque independent provenance. Authored UNRUN; no provider. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {loadAiWorkspace} from '../core/ai-workspace';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {createRoutingAgentCandidate,evaluateRoutingAgentCandidate,promoteRoutingAgentCandidate,runGovernedModuleReadPlan,
 recordOwnGovernedJobFeedback,eraseOwnGovernedJobFeedback} from '../core/module-agent-releases';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-signal-provenance-secret');for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function actors(){const admin=adminCtx(base);const make=async(name:string,role:'hr_admin'|'employee'='hr_admin')=>{const person=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,person.personId,role);await grantAssistant(admin,{appUserId:userId});return {...await entitledCtx(base,[role]),userId,personId:person.personId,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext;};return {admin,author:await make('Signal author'),reviewer:await make('Signal reviewer'),second:await make('Second signal reviewer'),outsider:await make('Unrelated employee','employee')};}
const configuration=()=>({kind:'typed_route_priority_v1',priority:[...AGENT_MODULE_CODES].reverse()});
const plan={version:1,modules:['employees','ess']};
async function signalsCurrent(ctx:SessionContext,id:string){return withTenant(ctx,async tx=>{const [row]=await tx.execute<{allowed:boolean}>(sql`select app.agent_candidate_signals_current(${id}::uuid) as allowed`);return row.allowed;});}
async function candidateWithSignal(){const a=await actors(),job=await runGovernedModuleReadPlan(a.author,plan,{nonce:randomUUID()}),feedback=await recordOwnGovernedJobFeedback(a.author,{jobId:job.jobId,outcome:'needs_correction',consented:true});
 const candidate=await createRoutingAgentCandidate(a.author,{version:1,configuration:configuration(),signalIds:[feedback.feedbackId]});return {...a,job,feedback,candidate};}
describe('human opinions nominate candidates but never become evaluator truth',()=>{
 it('binds exact completed job/source hashes and permits only own feedback, with opaque reviewer count',async()=>{
  const a=await candidateWithSignal();expect(await signalsCurrent(a.reviewer,a.candidate.candidateId)).toBe(true);
  expect(await signalsCurrent(a.outsider,a.candidate.candidateId)).toBe(false);expect(await signalsCurrent(a.outsider,randomUUID())).toBe(false);
  expect(await signalsCurrent({...a.outsider,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},a.candidate.candidateId)).toBe(false);
  const other=await withTenant(a.reviewer,tx=>tx.execute(sql`select id,outcome,receipt from public.ai_agent_job_feedback where user_id=${a.author.userId}::uuid`));expect(other).toHaveLength(0);
  const reopened=await loadAiWorkspace(a.author,{includeHistory:false,includeGovernance:false,governedJobId:a.job.jobId});expect(reopened.governedJob).toMatchObject({state:'ready',feedbackOutcome:'needs_correction'});
  const author=await loadAiWorkspace(a.author,{includeHistory:false}),reviewer=await loadAiWorkspace(a.reviewer,{includeHistory:false});
  expect(author.agentReview?.ownSignalChoices).toMatchObject([{id:a.feedback.feedbackId,outcome:'needs_correction'}]);expect(reviewer.agentReview?.ownSignalChoices).toEqual([]);
  expect(reviewer.agentReview?.candidates.find(row=>row.id===a.candidate.candidateId)?.verifiedSignalCount).toBe(1);
  expect(JSON.stringify(reviewer.agentReview)).not.toContain('needs_correction');expect(JSON.stringify(reviewer.agentReview)).not.toContain(a.job.jobId);
  await expect(createRoutingAgentCandidate(a.reviewer,{version:1,configuration:configuration(),signalIds:[a.feedback.feedbackId]})).rejects.toThrow('Agent review could not be confirmed.');
 });
 it('the narrow custody BOOL accepts only exact current visible refs and returns false without an app principal before cross-table SQL',async()=>{const a=await candidateWithSignal();const visible=(ctx:SessionContext,kind:string|null,id:string|null,tenant=base.tenantId,subject=a.author.userId!)=>withTenant(ctx,async tx=>{const [row]=await tx.execute<{allowed:boolean}>(sql`select app.agent_signal_custody_visible(${kind},${id}::uuid,${tenant}::uuid,${subject}::uuid) as allowed`);return row.allowed;});
  expect(await visible(a.reviewer,'job',a.job.jobId)).toBe(true);expect(await visible(a.reviewer,'feedback',a.feedback.feedbackId)).toBe(true);expect(await visible(a.author,'job',a.job.jobId)).toBe(true);expect(await visible(a.outsider,'job',a.job.jobId)).toBe(false);expect(await visible(a.reviewer,'arbitrary-kind',a.job.jobId)).toBe(false);expect(await visible(a.reviewer,null,a.job.jobId)).toBe(false);expect(await visible(a.reviewer,'job',null)).toBe(false);expect(await visible(a.reviewer,'job',randomUUID())).toBe(false);expect(await visible(a.reviewer,'job',a.job.jobId,randomUUID())).toBe(false);expect(await visible(a.reviewer,'job',a.job.jobId,base.tenantId,a.reviewer.userId!)).toBe(false);
  const [physical]=await owner.db.execute<{principal:string|null;tenant:string|null;allowed:boolean}>(sql`select app.current_user_id()::text as principal,app.current_tenant_id()::text as tenant,app.agent_signal_custody_visible('job',${a.job.jobId}::uuid,${base.tenantId}::uuid,${a.author.userId}::uuid) as allowed`);expect(physical).toEqual({principal:null,tenant:null,allowed:false});
  const [definition]=await owner.db.execute<{body:string}>(sql`select pg_get_functiondef('app.agent_signal_custody_visible(text,uuid,uuid,uuid)'::regprocedure) as body`);expect(definition.body).toContain('SECURITY DEFINER');expect(definition.body).toContain('row_security');expect(definition.body).not.toMatch(/(?:from|join)\s+public\.ai_agent_job_(?:receipt|feedback)/i);
  // Direct administrator custody SELECT stays own-only; BOOL scope is not raw feedback authority.
  expect(await withTenant(a.reviewer,tx=>tx.execute(sql`select id,outcome,receipt from public.ai_agent_job_feedback where user_id=${a.author.userId}::uuid`))).toHaveLength(0);expect(await signalsCurrent(a.reviewer,a.candidate.candidateId)).toBe(true);
 });
 it('has authentic empty provenance without describing it as feedback-derived',async()=>{
  const a=await actors(),candidate=await createRoutingAgentCandidate(a.author,{version:1,configuration:configuration()});
  const view=await loadAiWorkspace(a.reviewer,{includeHistory:false});expect(view.agentReview?.candidates.find(row=>row.id===candidate.candidateId)?.verifiedSignalCount).toBe(0);
  expect(await signalsCurrent(a.reviewer,candidate.candidateId)).toBe(true);
 });
 it('cannot promote a version from a helpful rating or posted model self-score instead of real independent evaluations',async()=>{
  const a=await candidateWithSignal();await expect(promoteRoutingAgentCandidate(a.reviewer,{candidateId:a.candidate.candidateId,maxJobs:2,hours:1})).rejects.toThrow();
  await expect(evaluateRoutingAgentCandidate(a.author,a.candidate.candidateId)).rejects.toThrow();
  const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_evaluation`);expect(row.n).toBe(0);
  await evaluateRoutingAgentCandidate(a.reviewer,a.candidate.candidateId);await evaluateRoutingAgentCandidate(a.second,a.candidate.candidateId);
  const promotion=await promoteRoutingAgentCandidate(a.reviewer,{candidateId:a.candidate.candidateId,maxJobs:2,hours:1});expect(promotion.promotionId).toBeTruthy();
 });
 it('invalidates a candidate on an actual opinion revision and restores the baseline before another promoted use',async()=>{
  const a=await candidateWithSignal();await evaluateRoutingAgentCandidate(a.reviewer,a.candidate.candidateId);await evaluateRoutingAgentCandidate(a.second,a.candidate.candidateId);await promoteRoutingAgentCandidate(a.reviewer,{candidateId:a.candidate.candidateId,maxJobs:2,hours:1});
  const changed=await recordOwnGovernedJobFeedback(a.author,{jobId:a.job.jobId,outcome:'helpful',consented:true});expect(changed.feedbackId).toBe(a.feedback.feedbackId);expect(await signalsCurrent(a.reviewer,a.candidate.candidateId)).toBe(false);
  await expect(evaluateRoutingAgentCandidate(a.reviewer,a.candidate.candidateId)).rejects.toThrow();
  const next=await runGovernedModuleReadPlan(a.author,plan,{nonce:randomUUID()});expect(next.mode).toBe('baseline');
  const [row]=await owner.db.execute<{reason:string;used:number}>(sql`select r.reason,p.used_jobs as used from public.ai_agent_rollback r join public.ai_agent_promotion p on p.id=r.promotion_id limit 1`);expect(row).toEqual({reason:'source_changed',used:0});
 });
 it('permits own erasure after a grant is revoked, retires referenced evidence and never erases another user opinions',async()=>{
  const a=await candidateWithSignal(),otherJob=await runGovernedModuleReadPlan(a.reviewer,plan,{nonce:randomUUID()});await recordOwnGovernedJobFeedback(a.reviewer,{jobId:otherJob.jobId,outcome:'helpful',consented:true});
  await revokeAssistant(a.admin,{appUserId:a.author.userId!});expect(await eraseOwnGovernedJobFeedback(a.author)).toEqual({erased:1});expect(await signalsCurrent(a.reviewer,a.candidate.candidateId)).toBe(false);
  const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_job_feedback where user_id=${a.reviewer.userId}::uuid`);expect(row.n).toBe(1);
  await expect(recordOwnGovernedJobFeedback(a.author,{jobId:a.job.jobId,outcome:'incorrect',consented:true})).rejects.toThrow();
 });
 it('refuses unknown/cross-owner jobs, no consent, private fact drift and overbroad signal lists before recording or proposing',async()=>{
  const a=await actors(),job=await runGovernedModuleReadPlan(a.author,plan,{nonce:randomUUID()});
  await expect(recordOwnGovernedJobFeedback(a.reviewer,{jobId:job.jobId,outcome:'helpful',consented:true})).rejects.toThrow();
  await expect(recordOwnGovernedJobFeedback(a.author,{jobId:job.jobId,outcome:'helpful',consented:false} as never)).rejects.toThrow();
  await owner.db.execute(sql`update public.employment set employee_code='CHANGED-AFTER-JOB' where person_id=${a.author.personId}::uuid`);
  await expect(recordOwnGovernedJobFeedback(a.author,{jobId:job.jobId,outcome:'helpful',consented:true})).rejects.toThrow();
  const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_job_feedback`);expect(row.n).toBe(0);
  await expect(createRoutingAgentCandidate(a.author,{version:1,configuration:configuration(),signalIds:Array.from({length:11},()=>randomUUID())})).rejects.toThrow();
 });
 it('the BOOL definer independently rejects expired/tampered refs and an unprivileged SQL caller cannot rewrite provenance',async()=>{
  const a=await candidateWithSignal();await expect(withTenant(a.author,tx=>tx.execute(sql`update public.ai_agent_candidate_provenance set refs='[]'::jsonb where candidate_id=${a.candidate.candidateId}::uuid`))).rejects.toThrow();
  const created=new Date(Date.now()-30*86400000).toISOString(),expires=new Date(Date.now()-60000).toISOString();
  await owner.db.execute(sql`update public.ai_agent_job_feedback set created_at=${created}::timestamptz,expires_at=${expires}::timestamptz where id=${a.feedback.feedbackId}::uuid`);
  expect(await signalsCurrent(a.reviewer,a.candidate.candidateId)).toBe(false);await expect(evaluateRoutingAgentCandidate(a.reviewer,a.candidate.candidateId)).rejects.toThrow();
 });
});
