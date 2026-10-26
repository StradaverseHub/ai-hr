import {SpecialistCandidate,executeCanonicalSpecialist,specialistNativeContractDigest,SPECIALIST_ENGINE_DIGEST,SPECIALIST_POLICY_DIGEST,SPECIALIST_POLICY,type SpecialistAssessment} from '../lib/ai/module-specialists';
import {specialistInputDigest,specialistSuiteDigest,SPECIALIST_HOLDOUTS} from '../lib/ai/module-specialist-holdouts';
import {executeSpecialistHoldout,type SpecialistEvaluationReport} from './module-specialist-harness';
import {AGENT_MODULE_CODES,isAgentModuleCode,type AgentModuleCode} from '../lib/ai/module-agents';
/** Trusted source owner for immutable governed module-behavior evidence. Not mounted as a model tool.
 * Candidate kinds without an actual fixed evaluator are refused, not labelled evaluated.
 */
import { randomUUID,createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { isGroupAdmin } from '../lib/authz-model';
import { encryptSecret, decryptSecret, isSecretStorable } from '../lib/ai/crypto';
import { AiGatewayError } from '../lib/ai/types';
import { MODULE_AGENT_SOURCE_DIGEST } from '../lib/ai/module-agent-source-manifest';
import { applyTypedRouteCandidate, captureTypedModulePlan, captureTypedRouteCandidate,
  ROUTING_ENGINE_DIGEST, ROUTING_POLICY_DIGEST, ROUTING_INPUT_DIGEST, ROUTING_SUITE_DIGEST, ROUTING_POLICY,
  routingDigest, type TypedRouteCandidate } from '../lib/ai/module-agent-routing';
import { assertAiPrincipalTx,isAiPrincipalCurrentTx } from './ai-principal';
import { assertMayUseAssistant } from './assistant-grant';
import { assertAiActionUnpausedTx } from './ai-governance';
import { resolveEntitlementsTx,assertModuleEnabled } from './entitlements';
import { withAssistantReadTx, withAssistantJobReadsTx, type AssistantReadSession } from './assistant-read-session';
import { executeRoutingHoldout, type RoutingEvaluationReport } from './module-agent-evaluation-harness';
import { capturePromptPlanCandidate,adjudicatePromptReadPlan,promptCandidateSystem,PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT,PROMPT_SUITE_DIGEST,PROMPT_ENGINE_DIGEST,PROMPT_POLICY_DIGEST,PROMPT_INPUT_DIGEST } from '../lib/ai/module-agent-prompt-candidate';
import { resolveAiProviderSnapshotTx } from './ai-provider-snapshot';
import { governedAiConfig,withAiAdmissionCheck,withAiAdmissionLifecycle } from './ai-governance';
import { executePromptHoldout,type PromptHoldoutReport } from './module-agent-prompt-harness';
import {draftInputDigest} from '../lib/ai/draft-input';
import {HUMAN_PLAN_HOLDOUTS,HUMAN_PLAN_SUITE_DIGEST,humanQuestionPrompt} from '../lib/ai/human-plan-holdouts';
import { generateDraft } from '../lib/ai';
import { assistantSourceDigest } from '../lib/ai/assistant-disclosure';
type AgentReadResult=Awaited<ReturnType<AssistantReadSession['moduleWork']>>;
const baselineDigest = routingDigest(['direct-module-order-v1', ROUTING_ENGINE_DIGEST]);
const fail = (): never => { throw new AiGatewayError('Agent review could not be confirmed.'); };
const uuid = (value: string) => /^[a-f0-9-]{36}$/i.test(value);
const capture = (ctx: SessionContext) => ({ ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) });
const exact = (row: object, keys: string[]) => Object.keys(row).sort().join(',') === [...keys].sort().join(',');
async function guard(tx: Tx, ctx: SessionContext, admin: boolean, admission = true) {
  await assertAiPrincipalTx(tx, ctx);
  if (admin) {
    const [current] = await tx.execute<{ allowed: boolean }>(sql`select app.is_group_admin() as allowed`);
    if (!isGroupAdmin(ctx) || current?.allowed !== true) return fail();
  }
  const fresh = { ...ctx, entitlements: await resolveEntitlementsTx(tx, ctx.tenantId) };
  if (admission) { await assertMayUseAssistant(fresh, tx); await assertAiActionUnpausedTx(tx, fresh, 'hr_assistant'); }
  return fresh;
}
type CandidateRow = { id: string; owner_user_id: string; author_user_id: string; module_code: string; version: number; kind:'typed_route_priority_v1'|'read_plan_prompt_v1'|'canonical_specialist_v1';
  configuration: unknown; candidate_digest: string; baseline_digest: string; source_digest: string;
  engine_digest: string; policy_digest: string; input_digest: string;signal_refs:unknown;signal_receipt:string|null };
function binding(row: CandidateRow) {
  const configuration = row.kind==='canonical_specialist_v1'?SpecialistCandidate.parse(row.configuration):row.kind==='read_plan_prompt_v1'?capturePromptPlanCandidate(row.configuration):captureTypedRouteCandidate(row.configuration);
  return { ownerUserId: row.owner_user_id, authorUserId: row.author_user_id, module: row.module_code,
    version: row.version, configuration, baselineDigest: row.baseline_digest, sourceDigest: row.source_digest,
    engineDigest: row.engine_digest, policyDigest: row.policy_digest, inputDigest: row.input_digest,signalDigest:routingDigest(captureSignalRefs(row.signal_refs)) };
}
function assertCurrent(row: CandidateRow) {
  if(row.kind==='canonical_specialist_v1'){const configuration=SpecialistCandidate.parse(row.configuration);if(row.module_code!==configuration.module||row.source_digest!==MODULE_AGENT_SOURCE_DIGEST||row.engine_digest!==specialistModuleEngineDigest(configuration.module)||row.policy_digest!==SPECIALIST_POLICY_DIGEST||row.input_digest!==specialistInputDigest(configuration.module)||row.baseline_digest!==specialistBaselineDigest(configuration.module)||row.candidate_digest!==routingDigest(binding(row)))return fail();return configuration;}
 const prompt=row.kind==='read_plan_prompt_v1';
  const configuration=prompt?capturePromptPlanCandidate(row.configuration):captureTypedRouteCandidate(row.configuration);
  if (row.module_code !== 'assistant' || configuration.kind!==row.kind || row.source_digest !== MODULE_AGENT_SOURCE_DIGEST ||
    row.engine_digest !== (prompt?PROMPT_ENGINE_DIGEST:ROUTING_ENGINE_DIGEST) ||
    row.policy_digest !== (prompt?PROMPT_POLICY_DIGEST:ROUTING_POLICY_DIGEST) || row.input_digest !== (prompt?PROMPT_INPUT_DIGEST:ROUTING_INPUT_DIGEST) ||
    row.candidate_digest !== routingDigest(binding(row))) return fail();
  return configuration;
}
async function candidateTx(tx: Tx, ctx: SessionContext, id: string, validate = true) {
  if (!uuid(id)) return fail();
  const [row] = await tx.execute<CandidateRow>(sql`select c.id,c.owner_user_id,c.author_user_id,c.module_code,c.version,c.kind,c.configuration,
    c.candidate_digest,c.baseline_digest,c.source_digest,c.engine_digest,c.policy_digest,c.input_digest,p.refs as signal_refs,p.receipt as signal_receipt from public.ai_agent_candidate c
    left join public.ai_agent_candidate_provenance p on p.candidate_id=c.id and p.tenant_id=c.tenant_id
    where c.id=${id}::uuid and c.tenant_id=${ctx.tenantId}::uuid`);
  if (!row) return fail(); if (validate){assertCurrent(row);await assertCandidateSignalsTx(tx,ctx,row);} return row;
}
const aad = (kind: string, tenant: string, id: string) => JSON.stringify(['ai-hr.module-agent.v1',kind,tenant,id]);
function seal(kind: string, tenant: string, id: string, value: unknown) {
  if (!isSecretStorable()) return fail();
  return encryptSecret(JSON.stringify(value), aad(kind, tenant, id));
}
function open(kind: string, tenant: string, id: string, token: string): Record<string, unknown> {
  try {
    if (!isSecretStorable() || typeof token !== 'string' || token.length > 65536) return fail();
    const value: unknown = JSON.parse(decryptSecret(token, aad(kind,tenant,id)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  } catch { return fail(); }
}
type SignalRef=Readonly<{id:string;jobId:string;receiptDigest:string;jobReceiptDigest:string}>;
const rawReceiptDigest=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
export const GOVERNED_JOB_FEEDBACK_OUTCOMES=['helpful','needs_correction','incorrect'] as const;
function captureSignalIds(value:unknown):readonly string[]{
 if(value===undefined)return Object.freeze([]);if(!Array.isArray(value)||value.length>10||value.some(id=>typeof id!=='string'||!uuid(id)))return fail();
 const ids=value.map(id=>String(id).toLowerCase());if(new Set(ids).size!==ids.length)return fail();return Object.freeze(ids.sort());
}
function captureSignalRefs(value:unknown):readonly SignalRef[]{
 if(!Array.isArray(value)||value.length>10)return fail();const refs:SignalRef[]=[];
 for(const item of value){if(!item||typeof item!=='object'||Array.isArray(item)||!exact(item,['id','jobId','receiptDigest','jobReceiptDigest'])||typeof item.id!=='string'||!uuid(item.id)||typeof item.jobId!=='string'||!uuid(item.jobId)||
  typeof item.receiptDigest!=='string'||!/^[a-f0-9]{64}$/.test(item.receiptDigest)||typeof item.jobReceiptDigest!=='string'||!/^[a-f0-9]{64}$/.test(item.jobReceiptDigest))return fail();
  refs.push(Object.freeze({id:item.id.toLowerCase(),jobId:item.jobId.toLowerCase(),receiptDigest:item.receiptDigest,jobReceiptDigest:item.jobReceiptDigest}));}
 if(new Set(refs.map(row=>row.id)).size!==refs.length)return fail();return Object.freeze(refs.sort((a,b)=>a.id.localeCompare(b.id)));
}
/** Unified typed/prompt owner interval: active execution shares it; publication/rollback owns it. */
async function agentReleaseIntervalTx(tx:Tx,ctx:SessionContext,ownerId:string,exclusive=true,required=true){
 const key='agent-release:'+ctx.tenantId+':'+ownerId;const [row]=await tx.execute<{owned:boolean}>(exclusive?
  sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as owned`:sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) as owned`);
 if(row?.owned!==true&&required)return fail();return row?.owned===true;
}
class AgentSignalBusy extends Error{}
async function signalIntervalTx(tx:Tx,ctx:SessionContext,ownerId:string,exclusive=false){
 const key='agent-signals:'+ctx.tenantId+':'+ownerId;const [row]=await tx.execute<{owned:boolean}>(exclusive?
  sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as owned`:sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) as owned`);if(row?.owned!==true)throw new AgentSignalBusy('Agent review could not be confirmed.');
}
async function assertCandidateSignalsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow){
 await signalIntervalTx(tx,ctx,candidate.owner_user_id);const refs=captureSignalRefs(candidate.signal_refs);
 if(!candidate.signal_receipt)return fail();const proof=open('candidate-signals',ctx.tenantId,candidate.id,candidate.signal_receipt);
 if(!exact(proof,['version','candidateDigest','ownerId','sourceDigest','refs'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||proof.ownerId!==candidate.owner_user_id||
  proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||routingDigest(captureSignalRefs(proof.refs))!==routingDigest(refs))return fail();
 const [current]=await tx.execute<{allowed:boolean}>(sql`select app.agent_candidate_signals_current(${candidate.id}::uuid) as allowed`);if(current?.allowed!==true)return fail();return refs.length;
}
async function persistCandidateSignalsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow){
 const refs=captureSignalRefs(candidate.signal_refs),receipt=seal('candidate-signals',ctx.tenantId,candidate.id,{version:1,candidateDigest:candidate.candidate_digest,ownerId:candidate.owner_user_id,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,refs});
 await tx.execute(sql`insert into public.ai_agent_candidate_provenance(candidate_id,tenant_id,owner_user_id,refs,receipt)
  values(${candidate.id}::uuid,${ctx.tenantId}::uuid,${candidate.owner_user_id}::uuid,${JSON.stringify(refs)}::jsonb,${receipt})`);
}
async function ownSignalRefsTx(tx:Tx,ctx:SessionContext,ids:readonly string[]){
 await signalIntervalTx(tx,ctx,ctx.userId!);const refs:SignalRef[]=[];
 for(const id of ids){const [feedback]=await tx.execute<{id:string;job_id:string;receipt:string;outcome:string;created_at:string;expires_at:string;fresh:boolean}>(sql`select id,job_id,receipt,outcome,created_at::text,expires_at::text,(expires_at>now()) as fresh
   from public.ai_agent_job_feedback where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);if(!feedback?.fresh)return fail();
  const [job]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where id=${feedback.job_id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);if(!job)return fail();
  const completed=verifiedGovernedJob(job,ctx),proof=open('job-feedback',ctx.tenantId,feedback.id,feedback.receipt);
  if(!exact(proof,['version','userId','jobId','jobReceiptDigest','candidateDigest','resultDigest','sourceDigest','outcome','consented','createdAt','expiresAt'])||proof.version!==1||proof.userId!==ctx.userId||proof.jobId!==job.id||
   proof.jobReceiptDigest!==rawReceiptDigest(job.receipt)||proof.candidateDigest!==completed.candidateDigest||proof.resultDigest!==completed.resultDigest||proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||proof.outcome!==feedback.outcome||proof.consented!==true||
   new Date(String(proof.createdAt)).getTime()!==new Date(feedback.created_at).getTime()||new Date(String(proof.expiresAt)).getTime()!==new Date(feedback.expires_at).getTime())return fail();
  refs.push(Object.freeze({id:feedback.id,jobId:job.id,receiptDigest:rawReceiptDigest(feedback.receipt),jobReceiptDigest:rawReceiptDigest(job.receipt)}));
 }
 return captureSignalRefs(refs);
}

export async function createRoutingAgentCandidate(ctx: SessionContext, input: { version: number; configuration: unknown;signalIds?:readonly string[] }) {
  const current = capture(ctx), configuration = captureTypedRouteCandidate(input.configuration), version = input.version,signalIds=captureSignalIds(input.signalIds);
  if (!exact(input, input.signalIds===undefined?['version','configuration']:['version','configuration','signalIds']) || !Number.isSafeInteger(version) || version < 1) return fail();
  try { return await withTenant(current, async tx => {
    await guard(tx, current, true);
    const id = randomUUID(),signal_refs=await ownSignalRefsTx(tx,current,signalIds);
    const row: CandidateRow = { id, owner_user_id: current.userId!, author_user_id: current.userId!, module_code: 'assistant',
      version, kind:'typed_route_priority_v1', configuration, candidate_digest: '', baseline_digest: baselineDigest, source_digest: MODULE_AGENT_SOURCE_DIGEST,
      engine_digest: ROUTING_ENGINE_DIGEST, policy_digest: ROUTING_POLICY_DIGEST, input_digest: ROUTING_INPUT_DIGEST,signal_refs,signal_receipt:null };
    row.candidate_digest = routingDigest(binding(row));
    await tx.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,
      configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
      values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${current.userId}::uuid,'assistant',${version},'typed_route_priority_v1',
      ${JSON.stringify(configuration)}::jsonb,${row.candidate_digest},${baselineDigest},${MODULE_AGENT_SOURCE_DIGEST},${ROUTING_ENGINE_DIGEST},${ROUTING_POLICY_DIGEST},${ROUTING_INPUT_DIGEST})`);
    await persistCandidateSignalsTx(tx,current,row);
    return { candidateId: id, candidateDigest: row.candidate_digest, state: 'unevaluated' as const };
  }); } catch { return fail(); }
}
/** Only this owner can issue an in-process evaluation proof, and only after executing the fixed suite. */
const issued = new WeakMap<object, { candidate: CandidateRow; evaluatorId: string; report: RoutingEvaluationReport; id: string }>();
export async function evaluateRoutingAgentCandidate(ctx: SessionContext, candidateId: string) {
  const current = capture(ctx), id = String(candidateId);
  try {
    const evidence = await withTenant(current, async tx => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`); const fresh = await guard(tx,current,true);
      const candidate = await candidateTx(tx,current,id);
      if (candidate.kind!=='typed_route_priority_v1'||candidate.author_user_id === current.userId) return fail();
      const report = await withAssistantReadTx(fresh,tx,read => executeRoutingHoldout(candidate.configuration,read));
      const proof = Object.freeze({}); issued.set(proof,{ candidate,evaluatorId:current.userId!,report,id:randomUUID() });
      return proof;
    });
    return await withTenant(current,async tx => {
      await guard(tx,current,true); const proof = issued.get(evidence); if (!proof) return fail();
      issued.delete(evidence); const candidate = await candidateTx(tx,current,id);
      if (candidate.candidate_digest !== proof.candidate.candidate_digest || proof.evaluatorId !== current.userId) return fail();
      const receipt = seal('evaluation',current.tenantId,proof.id,{ version:1, candidateDigest:candidate.candidate_digest,
        binding:binding(candidate), evaluatorId:proof.evaluatorId, report:proof.report });
      await tx.execute(sql`insert into public.ai_agent_evaluation(id,tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt)
        values(${proof.id}::uuid,${current.tenantId}::uuid,${id}::uuid,${current.userId}::uuid,${ROUTING_SUITE_DIGEST},${receipt})`);
      return { evaluationId:proof.id,coverage:proof.report.coverage,securityFailures:proof.report.securityFailures,
        qualityFailures:proof.report.qualityFailures,state:proof.report.securityFailures===0&&proof.report.qualityFailures===0?'passed-contract':'failed-contract' };
    });
  } catch { return fail(); }
}
function verifiedEvaluation(row: { id: string; evaluator_user_id: string; suite_digest: string; receipt: string }, candidate: CandidateRow, tenant: string) {
  const proof = open('evaluation',tenant,row.id,row.receipt);
  if (!exact(proof,['version','candidateDigest','binding','evaluatorId','report']) || proof.version!==1 ||
    proof.candidateDigest!==candidate.candidate_digest || routingDigest(proof.binding)!==routingDigest(binding(candidate)) ||
    proof.evaluatorId!==row.evaluator_user_id || row.evaluator_user_id===candidate.author_user_id || row.suite_digest!==ROUTING_SUITE_DIGEST) return fail();
  const report = proof.report as RoutingEvaluationReport;
  if (!report || report.version!==1 || report.suiteDigest!==ROUTING_SUITE_DIGEST || report.inputDigest!==ROUTING_INPUT_DIGEST ||
    report.coverage!=='typed-routing-contract-only' || report.securityFailures!==0 || report.qualityFailures!==0 || report.ownSubjects<1 ||
    !Array.isArray(report.cases) || report.cases.length!==28 || report.cases.some(row=>row.passed!==true)) return fail();
  return { id:row.id,evaluatorId:row.evaluator_user_id,receiptDigest:routingDigest(row.receipt) };
}
export async function promoteRoutingAgentCandidate(ctx: SessionContext,input:{candidateId:string;maxJobs:number;hours:number}) {
  const current=capture(ctx),p={candidateId:input.candidateId,maxJobs:input.maxJobs,hours:input.hours};
  if(!exact(input,['candidateId','maxJobs','hours'])||!Number.isSafeInteger(p.maxJobs)||p.maxJobs<1||p.maxJobs>ROUTING_POLICY.maxJobs||
    !Number.isSafeInteger(p.hours)||p.hours<1||p.hours>ROUTING_POLICY.maxHours)return fail();
  try{return await withTenant(current,async tx=>{
    await guard(tx,current,true);const nominated=await candidateTx(tx,current,p.candidateId,false);await agentReleaseIntervalTx(tx,current,nominated.owner_user_id);const candidate=await candidateTx(tx,current,p.candidateId);if(candidate.owner_user_id!==nominated.owner_user_id)return fail();
    if(candidate.kind!=='typed_route_priority_v1'||candidate.author_user_id===current.userId)return fail();
    const evaluations=Array.from(await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select distinct on(evaluator_user_id) id,evaluator_user_id,suite_digest,receipt
      from public.ai_agent_evaluation where tenant_id=${current.tenantId}::uuid and candidate_id=${candidate.id}::uuid order by evaluator_user_id`));
    const checked=evaluations.map(row=>verifiedEvaluation(row,candidate,current.tenantId));
    if(checked.length<2||checked.length>8||new Set(checked.map(row=>row.evaluatorId)).size!==checked.length)return fail();
    const [lock]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-release:' + current.tenantId + ':' + candidate.owner_user_id},0)) as owned`);
    if(lock?.owned!==true)return fail();
    const [prior]=await tx.execute<{present:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='typed_route_priority_v1' where p.tenant_id=${current.tenantId}::uuid
      and p.owner_user_id=${candidate.owner_user_id}::uuid and p.module_code='assistant' and p.expires_at>now() and p.used_jobs<p.max_jobs
      and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)) as present`);
    if(prior?.present)return fail();
    const id=randomUUID();const [clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,(now()+make_interval(hours=>${p.hours}))::text as expires`);
    const receipt=seal('promotion',current.tenantId,id,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),
      approverId:current.userId,evaluations:checked,maxJobs:p.maxJobs,createdAt:clock.now,expiresAt:clock.expires});
    await tx.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,expires_at)
      values(${id}::uuid,${current.tenantId}::uuid,${candidate.id}::uuid,${candidate.owner_user_id}::uuid,'assistant',${current.userId}::uuid,${receipt},${p.maxJobs},${clock.expires}::timestamptz)`);
    return {promotionId:id,candidateDigest:candidate.candidate_digest,coverage:'typed-routing-contract-only',maxJobs:p.maxJobs,expiresAt:clock.expires};
  });}catch{return fail();}
}
export async function rollbackRoutingAgent(ctx:SessionContext,input:{promotionId:string;reason:'human'|'security_regression'|'quality_regression'}) {
 const current=capture(ctx),p={...input};if(!exact(p,['promotionId','reason'])||!uuid(p.promotionId)||!['human','security_regression','quality_regression'].includes(p.reason))return fail();
 try{await withTenant(current,async tx=>{
  // A running canonical reader owns Access before its shared release interval. Refuse contention
  // before the principal guard's blocking reentrant acquisition; never wait behind an active job.
  const [access]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+current.tenantId},0)) as owned`);if(access?.owned!==true)return fail();
  await guard(tx,current,true,false);
  const [nominated]=await tx.execute<{id:string;owner_user_id:string}>(sql`select id,owner_user_id from public.ai_agent_promotion where id=${p.promotionId}::uuid and tenant_id=${current.tenantId}::uuid`);if(!nominated)return fail();
  await agentReleaseIntervalTx(tx,current,nominated.owner_user_id);
  const [fresh]=await tx.execute<{id:string}>(sql`select id from public.ai_agent_promotion where id=${p.promotionId}::uuid and tenant_id=${current.tenantId}::uuid and owner_user_id=${nominated.owner_user_id}::uuid`);if(!fresh)return fail();
  await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
   values(${current.tenantId}::uuid,${p.promotionId}::uuid,${current.userId}::uuid,${p.reason}) on conflict(promotion_id) do nothing`);
 });}catch{return fail();}
}

export const GOVERNED_JOB_RETENTION_DAYS=30;
type GovernedJobRow={id:string;user_id:string;promotion_id:string|null;request_nonce:string|null;requested_plan_digest:string|null;receipt:string;created_at:string;expires_at:string|null;fresh:boolean};
const jobProjection=sql`id,user_id,promotion_id,request_nonce,requested_plan_digest,receipt,created_at::text,expires_at::text,(expires_at>now()) as fresh`;
function verifiedGovernedJob(row:GovernedJobRow,ctx:SessionContext){
 if(!ctx.userId||row.user_id!==ctx.userId||!row.request_nonce||!row.expires_at||!row.fresh)return fail();
 const proof=open('governed-job-v2',ctx.tenantId,row.id,row.receipt),specialist=proof.specialist===undefined?undefined:captureSpecialistJobBinding(proof.specialist);
 if(!exact(proof,['version','stage','tenantId','userId','commandNonce','mode','candidateDigest','promotionId','sourceDigest','engineDigest','policyDigest','requestedPlan','executedPlan','requestedPlanDigest','executedPlanDigest','resultDigest','createdAt','expiresAt','elapsedMs',...(proof.planning===undefined?[]:['planning']),...(proof.specialist===undefined?[]:['specialist'])])||
  proof.version!==2||proof.stage!=='completed'||proof.tenantId!==ctx.tenantId||proof.userId!==ctx.userId||proof.commandNonce!==row.request_nonce||
  proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||proof.engineDigest!==(specialist===undefined?ROUTING_ENGINE_DIGEST:specialistModuleEngineDigest(specialist.configuration.module))||proof.policyDigest!==(proof.specialist===undefined?ROUTING_POLICY_DIGEST:SPECIALIST_POLICY_DIGEST)||
  proof.promotionId!==row.promotion_id||(proof.mode!=='baseline'&&proof.mode!=='promoted')||
  (proof.mode==='promoted')!==Boolean(row.promotion_id)||typeof proof.candidateDigest!=='string'||!/^[a-f0-9]{64}$/.test(proof.candidateDigest)||
  typeof proof.resultDigest!=='string'||!/^[a-f0-9]{64}$/.test(proof.resultDigest)||!Number.isSafeInteger(proof.elapsedMs)||Number(proof.elapsedMs)<0||
  new Date(String(proof.createdAt)).getTime()!==new Date(row.created_at).getTime()||new Date(String(proof.expiresAt)).getTime()!==new Date(row.expires_at).getTime())return fail();
 const requested=captureTypedModulePlan(proof.requestedPlan),executed=captureTypedModulePlan(proof.executedPlan);
 if(routingDigest(requested)!==row.requested_plan_digest||proof.requestedPlanDigest!==row.requested_plan_digest||routingDigest(executed)!==proof.executedPlanDigest||
  [...requested.modules].sort().join(',')!==[...executed.modules].sort().join(',')||
  new Date(row.expires_at).getTime()-new Date(row.created_at).getTime()>GOVERNED_JOB_RETENTION_DAYS*86400000)return fail();
 const planning=proof.planning===undefined?undefined:capturePlanningBinding(proof.planning);if(specialist&&(planning||requested.modules.length!==1||requested.modules[0]!==specialist.configuration.module||executed.modules[0]!==specialist.configuration.module||(proof.mode==='promoted')!==(specialist.assessmentDigest!==null)||proof.mode==='baseline'&&proof.candidateDigest!==specialistBaselineDigest(specialist.configuration.module)))return fail();
 return {requested,executed,mode:proof.mode as 'baseline'|'promoted',candidateDigest:proof.candidateDigest,resultDigest:proof.resultDigest,planning,specialist};
}
async function assertGovernedJobCandidateTx(tx:Tx,ctx:SessionContext,job:GovernedJobRow,completed:ReturnType<typeof verifiedGovernedJob>){
 if(completed.planning)await currentPlanningBindingTx(tx,ctx,completed.planning);
 if(!job.promotion_id)return;const [promotion]=await tx.execute<{candidate_id:string}>(sql`select candidate_id from public.ai_agent_promotion where id=${job.promotion_id}::uuid and tenant_id=${ctx.tenantId}::uuid and owner_user_id=${ctx.userId}::uuid`);
 if(!promotion)return fail();const candidate=await candidateTx(tx,ctx,promotion.candidate_id);if(candidate.candidate_digest!==completed.candidateDigest||completed.specialist&&(candidate.kind!=='canonical_specialist_v1'||candidate.module_code!==completed.specialist.configuration.module||routingDigest(candidate.configuration)!==routingDigest(completed.specialist.configuration)))return fail();
}
/** Human opinion only, independently tied to an actual completed command and unchanged current facts. */
export async function recordOwnGovernedJobFeedback(ctx:SessionContext,input:{jobId:string;outcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number];consented:true}){
 const current=capture(ctx),p={jobId:input.jobId,outcome:input.outcome,consented:input.consented};
 if(!exact(input,['jobId','outcome','consented'])||!uuid(p.jobId)||!GOVERNED_JOB_FEEDBACK_OUTCOMES.includes(p.outcome)||p.consented!==true)return fail();
 try{return await withTenant(current,async tx=>{const fresh=await guard(tx,current,false);await signalIntervalTx(tx,current,current.userId!,true);
  const [job]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where id=${p.jobId}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);if(!job)return fail();
  const completed=verifiedGovernedJob(job,current);await assertGovernedJobCandidateTx(tx,current,job,completed);
  const results=await withAssistantJobReadsTx(fresh,tx,async read=>{const rows:AgentReadResult[]=[];for(const module of completed.executed.modules)rows.push(await read.moduleWork(module));return rows;});
  if(assistantSourceDigest(results)!==completed.resultDigest)return fail();if(completed.specialist&&completed.specialist.assessmentDigest!==null&&routingDigest(executeCanonicalSpecialist(completed.specialist.configuration,results[0]))!==completed.specialist.assessmentDigest)return fail();
  const [previous]=await tx.execute<{id:string;outcome:string;receipt:string}>(sql`select id,outcome,receipt from public.ai_agent_job_feedback where job_id=${job.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid for update nowait`);
  if(previous?.outcome===p.outcome){await ownSignalRefsTx(tx,current,[previous.id]);return {feedbackId:previous.id};}
  const id=previous?.id??randomUUID();const [clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,least(${job.expires_at}::timestamptz,now()+interval '720 hours')::text as expires`);
  const receipt=seal('job-feedback',current.tenantId,id,{version:1,userId:current.userId,jobId:job.id,jobReceiptDigest:rawReceiptDigest(job.receipt),candidateDigest:completed.candidateDigest,resultDigest:completed.resultDigest,
   sourceDigest:MODULE_AGENT_SOURCE_DIGEST,outcome:p.outcome,consented:true,createdAt:clock.now,expiresAt:clock.expires});
  if(previous)await tx.execute(sql`update public.ai_agent_job_feedback set outcome=${p.outcome},receipt=${receipt},created_at=${clock.now}::timestamptz,expires_at=${clock.expires}::timestamptz where id=${id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);
  else await tx.execute(sql`insert into public.ai_agent_job_feedback(id,tenant_id,user_id,job_id,outcome,consented,receipt,created_at,expires_at) values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${job.id}::uuid,${p.outcome},true,${receipt},${clock.now}::timestamptz,${clock.expires}::timestamptz)`);
  return {feedbackId:id};
 });}catch{return fail();}
}
/** Own erasure remains available after Assistant grant/module removal; no model or service identity. */
export async function eraseOwnGovernedJobFeedback(ctx:SessionContext){const current=capture(ctx);try{return await withTenant(current,async tx=>{
 await assertAiPrincipalTx(tx,current);if(!current.userId)return fail();await signalIntervalTx(tx,current,current.userId,true);
 const rows=await tx.execute<{id:string}>(sql`delete from public.ai_agent_job_feedback where tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid returning id`);return {erased:rows.length};
 });}catch{return fail();}}

/** Read-only replay: old v1 receipts remain audit-only. Current canonical facts are loaded afresh;
 * the encrypted receipt nominates a bounded plan, never a stored HR fact or current permission.
 */
export async function reopenGovernedModuleReadJobTx(tx:Tx,ctx:SessionContext,id:string){
 const current=capture(ctx);if(!uuid(id))return fail();
 const [mode]=await tx.execute<{readonly:string}>(sql`select current_setting('transaction_read_only') as readonly`);if(mode?.readonly!=='on')return fail();
 const fresh=await guard(tx,current,false);
 const [row]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt
  where id=${id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);
 if(!row)return fail();const proof=verifiedGovernedJob(row,current);await assertGovernedJobCandidateTx(tx,current,row,proof);
 const results=await withAssistantReadTx(fresh,tx,async read=>{const rows:AgentReadResult[]=[];for(const module of proof.executed.modules)rows.push(await read.moduleWork(module));return rows;});
 const [feedback]=await tx.execute<{id:string;outcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number]}>(sql`select id,outcome from public.ai_agent_job_feedback where job_id=${row.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and expires_at>now()`);
 let feedbackOutcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number]|null=null;
 if(feedback){try{await ownSignalRefsTx(tx,current,[feedback.id]);feedbackOutcome=feedback.outcome;}catch(error){if(error instanceof AgentSignalBusy)throw error;}}
 const specialist=proof.specialist?await currentSpecialistJobAssessmentTx(tx,current,row,proof,results):null;return {jobId:row.id,mode:proof.mode,changedSinceRun:assistantSourceDigest(results)!==proof.resultDigest,results,feedbackOutcome,...(proof.specialist?{specialist}:{})};
}
/** Explicit metadata-writing job owner, not a read tool or provider admission. Whole job rolls back on failure.
 * Every command caller supplies a retained nonce; no read or retry path invents a new command identity.
 */
export async function runGovernedModuleReadPlan(ctx:SessionContext,proposed:unknown,command:{nonce:string;proposalId?:string}) {
  const current=capture(ctx),plan=captureTypedModulePlan(proposed),nonce=command?.nonce,proposalId=command?.proposalId,started=Date.now();
  if(!command||typeof nonce!=='string'||!uuid(nonce)||!exact(command,proposalId===undefined?['nonce']:['nonce','proposalId'])||(proposalId!==undefined&&!uuid(proposalId)))return fail();
  try{return await withTenant(current,async tx=>{
    const fresh=await guard(tx,current,false);await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!);
    const [owned]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-job:'+current.tenantId+':'+current.userId+':'+nonce},0)) as owned`);if(owned?.owned!==true)return fail();
    const reviewed=proposalId?await checkedOwnPlanProposalTx(tx,current,proposalId,plan):null;
    const [existing]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt
     where tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and request_nonce=${nonce}::uuid`);
    if(existing){const proof=verifiedGovernedJob(existing,current);if(proof.specialist)return fail();if((reviewed?.row.consumed_job_id??null)!==(proposalId?existing.id:null)||proof.planning?.proposalId!==(proposalId??undefined))return fail();if(routingDigest(plan)!==routingDigest(proof.requested))return fail();await assertGovernedJobCandidateTx(tx,current,existing,proof);
     const results=await withAssistantJobReadsTx(fresh,tx,async read=>{const rows:AgentReadResult[]=[];for(const module of proof.executed.modules)rows.push(await read.moduleWork(module));return rows;});
     return {version:1 as const,jobId:existing.id,candidateDigest:proof.candidateDigest,mode:proof.mode,results,effects:[],replayed:true};}
    if(reviewed?.row.consumed_job_id)return fail();
    const [promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;used_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.used_jobs,p.expires_at::text
      from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='typed_route_priority_v1' where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.module_code='assistant'
      and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
      order by p.created_at desc,p.id desc limit 1 for update of p nowait`);
    let selected=plan,candidateDigest=baselineDigest;let activePromotion:typeof promotion|undefined=promotion;
    if(promotion){const candidate=await candidateTx(tx,current,promotion.candidate_id,false);
      let currentSource=true;try{assertCurrent(candidate);await assertCandidateSignalsTx(tx,current,candidate);}catch(error){if(error instanceof AgentSignalBusy)throw error;currentSource=false;}
      if(!currentSource){
        await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
          values(${current.tenantId}::uuid,${promotion.id}::uuid,${current.userId}::uuid,'source_changed') on conflict(promotion_id) do nothing`);
        activePromotion=undefined;
      }
    }
    if(activePromotion){const candidate=await candidateTx(tx,current,activePromotion.candidate_id);const proof=open('promotion',current.tenantId,activePromotion.id,activePromotion.receipt);
      if(proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||
        proof.maxJobs!==activePromotion.max_jobs||new Date(String(proof.expiresAt)).getTime()!==new Date(activePromotion.expires_at).getTime())return fail();
      selected=applyTypedRouteCandidate(candidate.configuration,plan);candidateDigest=candidate.candidate_digest;
      await tx.execute(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${activePromotion.id}::uuid and tenant_id=${current.tenantId}::uuid`);
    }
    const results=await withAssistantJobReadsTx(fresh,tx,async read=>{
      const rows:AgentReadResult[]=[];for(const module of selected.modules)rows.push(await read.moduleWork(module));return rows;
    });
    const id=randomUUID();const [clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,(now()+make_interval(secs=>${GOVERNED_JOB_RETENTION_DAYS*86400}))::text as expires`);
    const mode=activePromotion?'promoted' as const:'baseline' as const;
    const receipt=seal('governed-job-v2',current.tenantId,id,{version:2,stage:'completed',tenantId:current.tenantId,userId:current.userId,commandNonce:nonce,
     mode,candidateDigest,promotionId:activePromotion?.id??null,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,engineDigest:ROUTING_ENGINE_DIGEST,policyDigest:ROUTING_POLICY_DIGEST,
     requestedPlan:plan,executedPlan:selected,requestedPlanDigest:routingDigest(plan),executedPlanDigest:routingDigest(selected),resultDigest:assistantSourceDigest(results),
     createdAt:clock.now,expiresAt:clock.expires,elapsedMs:Math.max(0,Date.now()-started),...(reviewed?{planning:reviewed.binding}:{})});
    await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,request_nonce,requested_plan_digest,expires_at,receipt)
      values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${activePromotion?.id??null}::uuid,${nonce}::uuid,${routingDigest(plan)},${clock.expires}::timestamptz,${receipt})`);
    if(reviewed){const linked=await tx.execute<{id:string}>(sql`update public.ai_agent_plan_proposal set consumed_job_id=${id}::uuid where id=${reviewed.row.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and consumed_job_id is null returning id`);if(linked.length!==1||linked[0].id!==reviewed.row.id)return fail();}
    return {version:1 as const,jobId:id,candidateDigest,mode,results,effects:[],replayed:false};
  });}catch{return fail();}
}

/** Administrative expiry/exhaustion receipts; no source data or impersonation is returned. */
export async function maintainModuleAgentReleases(ctx:SessionContext,limit=100){
 const current=capture(ctx);if(!Number.isSafeInteger(limit)||limit<1||limit>100)return fail();
 try{return await withTenant(current,async tx=>{await guard(tx,current,true,false);
  const rows=await tx.execute<{id:string;owner_user_id:string}>(sql`select p.id,p.owner_user_id from public.ai_agent_promotion p
   where p.tenant_id=${current.tenantId}::uuid and(p.expires_at<=now() or (p.used_jobs>=p.max_jobs and exists(select 1 from public.ai_agent_candidate c where c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind in('typed_route_priority_v1','canonical_specialist_v1'))))
   and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
   order by p.owner_user_id,p.created_at,p.id limit ${limit}`);
  let retired=0;
  for(const row of rows){if(!await agentReleaseIntervalTx(tx,current,row.owner_user_id,true,false))continue;
   const [fresh]=await tx.execute<{id:string;reason:'expired'|'exhausted'}>(sql`select p.id,case when p.expires_at<=now() then 'expired' else 'exhausted' end as reason from public.ai_agent_promotion p
    where p.id=${row.id}::uuid and p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${row.owner_user_id}::uuid and(p.expires_at<=now() or (p.used_jobs>=p.max_jobs and exists(select 1 from public.ai_agent_candidate c where c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind in('typed_route_priority_v1','canonical_specialist_v1'))))
    and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)`);
   if(!fresh)continue;const inserted=await tx.execute<{id:string}>(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
    values(${current.tenantId}::uuid,${fresh.id}::uuid,${current.userId}::uuid,${fresh.reason}) on conflict(promotion_id) do nothing returning id`);retired+=inserted.length;
  }
  return {retired};
 });}catch{return fail();}
}

/** Explicit consent is for the fixed synthetic suite only; no caller-authored HR prompt is sent. */
export type AgentSyntheticConsent=Readonly<{synthetic:true;maxRequests:number;sourceDigest:string}>;
function captureSyntheticConsent(value:AgentSyntheticConsent,requests:number=PROMPT_HOLDOUT_REQUEST_LIMIT){
 if(!value||!exact(value,['synthetic','maxRequests','sourceDigest'])||value.synthetic!==true||
  value.maxRequests!==requests||value.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST)return fail();
 return Object.freeze({synthetic:true as const,maxRequests:value.maxRequests,sourceDigest:value.sourceDigest});
}
export async function createPromptAgentCandidate(ctx:SessionContext,input:{version:number;configuration:unknown;signalIds?:readonly string[]}){
 const current=capture(ctx),configuration=capturePromptPlanCandidate(input.configuration),version=input.version,signalIds=captureSignalIds(input.signalIds);
 if(!exact(input,input.signalIds===undefined?['version','configuration']:['version','configuration','signalIds'])||!Number.isSafeInteger(version)||version<1)return fail();
 try{return await withTenant(current,async tx=>{
  await guard(tx,current,true);const id=randomUUID(),base=routingDigest(['no-model-plan-baseline-v1',PROMPT_ENGINE_DIGEST]);
  const signal_refs=await ownSignalRefsTx(tx,current,signalIds);
  const row:CandidateRow={id,owner_user_id:current.userId!,author_user_id:current.userId!,module_code:'assistant',kind:'read_plan_prompt_v1',
   version,configuration,candidate_digest:'',baseline_digest:base,source_digest:MODULE_AGENT_SOURCE_DIGEST,
   engine_digest:PROMPT_ENGINE_DIGEST,policy_digest:PROMPT_POLICY_DIGEST,input_digest:PROMPT_INPUT_DIGEST,signal_refs,signal_receipt:null};
  row.candidate_digest=routingDigest(binding(row));
  await tx.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,
   candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
   values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${current.userId}::uuid,'assistant',${version},'read_plan_prompt_v1',
   ${JSON.stringify(configuration)}::jsonb,${row.candidate_digest},${base},${MODULE_AGENT_SOURCE_DIGEST},${PROMPT_ENGINE_DIGEST},${PROMPT_POLICY_DIGEST},${PROMPT_INPUT_DIGEST})`);
  await persistCandidateSignalsTx(tx,current,row);
  return {candidateId:id,candidateDigest:row.candidate_digest,state:'unevaluated' as const};
 });}catch{return fail();}
}
function authenticatedPromptReport(row:{id:string;evaluator_user_id:string;suite_digest:string;receipt:string},candidate:CandidateRow,tenant:string,providerFingerprint:string){
 const proof=open('prompt-evaluation',tenant,row.id,row.receipt);
 if(!exact(proof,['version','candidateDigest','binding','evaluatorId','providerFingerprint','report'])||proof.version!==1||
  proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||
  proof.evaluatorId!==row.evaluator_user_id||row.suite_digest!==PROMPT_SUITE_DIGEST||proof.providerFingerprint!==providerFingerprint)return fail();
 const report=proof.report as PromptHoldoutReport;
 if(!report||report.version!==1||report.suiteDigest!==PROMPT_SUITE_DIGEST||report.inputDigest!==PROMPT_INPUT_DIGEST||
  report.coverage!=='model-to-typed-read-plan-only'||!Array.isArray(report.cases)||report.cases.length>PROMPT_HOLDOUTS.length)return fail();
 const unique=new Set<string>();for(const row of report.cases){if(unique.has(row.id)||!PROMPT_HOLDOUTS.some(f=>f.id===row.id)||
  !['passed','failed','unavailable'].includes(row.state)||(row.state==='passed'&&(!row.outputDigest||!/^[a-f0-9]{64}$/.test(row.outputDigest))))return fail();unique.add(row.id);}
 return report;
}
const issuedPrompt=new WeakMap<object,{candidate:CandidateRow;evaluatorId:string;providerFingerprint:string;report:PromptHoldoutReport;id:string}>();
export async function evaluatePromptAgentCandidate(ctx:SessionContext,input:{candidateId:string;consent:AgentSyntheticConsent}){
 const current=capture(ctx),candidateId=input.candidateId;captureSyntheticConsent(input.consent);
 if(!exact(input,['candidateId','consent']))return fail();
 try{
  const prepared=await withTenant(current,async tx=>{
   await tx.execute(sql`SET TRANSACTION READ ONLY`);const fresh=await guard(tx,current,true);
   await assertAiActionUnpausedTx(tx,fresh,'module_agent_evaluation');
   const candidate=await candidateTx(tx,current,candidateId);if(candidate.kind!=='read_plan_prompt_v1'||candidate.author_user_id===current.userId)return fail();
   const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();
   const cfg=withAiAdmissionCheck(governedAiConfig(fresh,snapshot,'module_agent_evaluation'),'module_agent_evaluation',async carrier=>{
    await guard(carrier,current,true);const again=await candidateTx(carrier,current,candidateId);
    if(again.candidate_digest!==candidate.candidate_digest||again.author_user_id===current.userId)return fail();
   });
   const [previous]=await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select id,evaluator_user_id,suite_digest,receipt
    from public.ai_agent_evaluation where tenant_id=${current.tenantId}::uuid and candidate_id=${candidateId}::uuid
    and evaluator_user_id=${current.userId}::uuid and suite_digest=${PROMPT_SUITE_DIGEST} order by completed_at desc,id desc limit 1`);
   let retained:PromptHoldoutReport|undefined;
   if(previous)try{retained=authenticatedPromptReport(previous,candidate,current.tenantId,snapshot.fingerprint);}catch{/* Changed binding is not reusable passing evidence. */}
   return {candidate,cfg,providerFingerprint:snapshot.fingerprint,retained};
  });
  // No transaction is held over provider access. Only fixed suite inputs and checked-in prompt text leave.
  const report=await executePromptHoldout(prepared.candidate.configuration,prepared.cfg,prepared.retained);
  const evidence=Object.freeze({});issuedPrompt.set(evidence,{candidate:prepared.candidate,evaluatorId:current.userId!,
   providerFingerprint:prepared.providerFingerprint,report,id:randomUUID()});
  return await withTenant(current,async tx=>{
   await guard(tx,current,true,false);const proof=issuedPrompt.get(evidence);if(!proof)return fail();issuedPrompt.delete(evidence);
   const candidate=await candidateTx(tx,current,candidateId);if(proof.evaluatorId!==current.userId||candidate.candidate_digest!==proof.candidate.candidate_digest)return fail();
   const receipt=seal('prompt-evaluation',current.tenantId,proof.id,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),
    evaluatorId:proof.evaluatorId,providerFingerprint:proof.providerFingerprint,report:proof.report});
   await tx.execute(sql`insert into public.ai_agent_evaluation(id,tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt)
    values(${proof.id}::uuid,${current.tenantId}::uuid,${candidateId}::uuid,${current.userId}::uuid,${PROMPT_SUITE_DIGEST},${receipt})`);
   return {evaluationId:proof.id,coverage:report.coverage,state:report.state,attemptedRequests:report.attemptedRequests,
    completedRequests:report.completedRequests,completedCases:report.completedCases,totalCases:PROMPT_HOLDOUTS.length,retainedPasses:report.retainedPasses,retainedFailures:report.retainedFailures,securityFailures:report.securityFailures,qualityFailures:report.qualityFailures};
  });
 }catch{return fail();}
}
export async function promotePromptAgentCandidate(ctx:SessionContext,input:{candidateId:string;maxJobs:number;hours:number}){
 const current=capture(ctx),p={...input};if(!exact(p,['candidateId','maxJobs','hours'])||!Number.isSafeInteger(p.maxJobs)||p.maxJobs<1||p.maxJobs>100||
  !Number.isSafeInteger(p.hours)||p.hours<1||p.hours>24)return fail();
 try{return await withTenant(current,async tx=>{
  const fresh=await guard(tx,current,true);const nominated=await candidateTx(tx,current,p.candidateId,false);await agentReleaseIntervalTx(tx,current,nominated.owner_user_id);const candidate=await candidateTx(tx,current,p.candidateId);if(candidate.owner_user_id!==nominated.owner_user_id)return fail();
  if(candidate.kind!=='read_plan_prompt_v1'||candidate.author_user_id===current.userId)return fail();
  const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();
  const rows=await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select distinct on(evaluator_user_id) id,evaluator_user_id,suite_digest,receipt
   from public.ai_agent_evaluation where tenant_id=${current.tenantId}::uuid and candidate_id=${candidate.id}::uuid and suite_digest=${PROMPT_SUITE_DIGEST}
   order by evaluator_user_id,completed_at desc,id desc`);
  if(rows.length<2||rows.length>8||new Set(rows.map(row=>row.evaluator_user_id)).size!==rows.length)return fail();
  const checked=rows.map(row=>{const report=authenticatedPromptReport(row,candidate,current.tenantId,snapshot.fingerprint);
   if(row.evaluator_user_id===candidate.author_user_id||report.state!=='complete'||report.securityFailures!==0||report.qualityFailures!==0||
    report.completedCases!==PROMPT_HOLDOUTS.length||report.cases.length!==PROMPT_HOLDOUTS.length||report.cases.some(row=>row.state!=='passed'))return fail();
   return {id:row.id,evaluatorId:row.evaluator_user_id,receiptDigest:routingDigest(row.receipt)};
  });
  const [lock]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'prompt-agent-release:'+current.tenantId+':'+candidate.owner_user_id},0)) as owned`);if(lock?.owned!==true)return fail();
  const [prior]=await tx.execute<{present:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id
   where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${candidate.owner_user_id}::uuid and c.kind='read_plan_prompt_v1' and p.expires_at>now() and p.used_jobs<p.max_jobs
   and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)) as present`);if(prior?.present)return fail();
  const id=randomUUID();const [clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,(now()+make_interval(hours=>${p.hours}))::text as expires`);
  const receipt=seal('prompt-promotion',current.tenantId,id,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),
   approverId:current.userId,evaluations:checked,providerFingerprint:snapshot.fingerprint,maxJobs:p.maxJobs,createdAt:clock.now,expiresAt:clock.expires});
  await tx.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,expires_at)
   values(${id}::uuid,${current.tenantId}::uuid,${candidate.id}::uuid,${candidate.owner_user_id}::uuid,'assistant',${current.userId}::uuid,${receipt},${p.maxJobs},${clock.expires}::timestamptz)`);
  return {promotionId:id,coverage:'model-to-typed-read-plan-only',maxJobs:p.maxJobs,expiresAt:clock.expires};
 });}catch{return fail();}
}

/** Consented synthetic try-out is the first bounded consumer of promoted prompt behavior.
 * This does not enable free-form production HR transfer. Human input chooses only a fixed fixture.
 */
export async function runPromptPlannedSyntheticJob(ctx:SessionContext,input:{fixtureId:string;consent:AgentSyntheticConsent}){
 const current=capture(ctx),fixtureId=input.fixtureId;captureSyntheticConsent(input.consent,1);
 if(!exact(input,['fixtureId','consent']))return fail();const fixture=PROMPT_HOLDOUTS.find(row=>row.id===fixtureId);if(!fixture)return fail();
 try{
  const prepared=await withTenant(current,async tx=>{
   const fresh=await guard(tx,current,true);await assertAiActionUnpausedTx(tx,fresh,'module_agent_evaluation');await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!);
   const [promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.expires_at::text
    from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='read_plan_prompt_v1'
    where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.expires_at>now() and p.used_jobs<p.max_jobs
    and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
    order by p.created_at desc,p.id desc limit 1 for update of p nowait`);
   if(!promotion)return fail();const candidate=await candidateTx(tx,current,promotion.candidate_id,false);
   const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();
   let confirmed=true;try{assertCurrent(candidate);await assertCandidateSignalsTx(tx,current,candidate);const proof=open('prompt-promotion',current.tenantId,promotion.id,promotion.receipt);
    if(proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||
     proof.providerFingerprint!==snapshot.fingerprint||proof.maxJobs!==promotion.max_jobs||
     new Date(String(proof.expiresAt)).getTime()!==new Date(promotion.expires_at).getTime())confirmed=false;
   }catch(error){if(error instanceof AgentSignalBusy)throw error;confirmed=false;}
   if(!confirmed){await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
    values(${current.tenantId}::uuid,${promotion.id}::uuid,${current.userId}::uuid,'source_changed') on conflict(promotion_id) do nothing`);return null;}
   const jobId=randomUUID();await tx.execute(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${promotion.id}::uuid and tenant_id=${current.tenantId}::uuid`);
   const pending=seal('prompt-job',current.tenantId,jobId,{version:1,stage:'reserved',candidateDigest:candidate.candidate_digest,
    promotionId:promotion.id,fixtureId:fixture.id,sourceDigest:MODULE_AGENT_SOURCE_DIGEST});
   await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,receipt)
    values(${jobId}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${promotion.id}::uuid,${pending})`);
   const cfg=withAiAdmissionCheck(governedAiConfig(fresh,snapshot,'module_agent_evaluation'),'module_agent_evaluation',async carrier=>{
    await guard(carrier,current,true);await agentReleaseIntervalTx(carrier,current,current.userId!,false);await signalIntervalTx(carrier,current,current.userId!);const again=await candidateTx(carrier,current,candidate.id);
    const [allowed]=await carrier.execute<{allowed:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p
     where p.id=${promotion.id}::uuid and p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.expires_at>now()
     and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)) as allowed`);
    if(again.candidate_digest!==candidate.candidate_digest||allowed?.allowed!==true)return fail();
   });
   return {candidate,promotionId:promotion.id,jobId,cfg,providerFingerprint:snapshot.fingerprint};
  });
  if(!prepared)return fail();const started=Date.now();
  const text=await generateDraft(prepared.cfg,Object.freeze({system:promptCandidateSystem(prepared.candidate.configuration),prompt:fixture.question,maxTokens:384,timeoutMs:15000}));
  let plan:ReturnType<typeof adjudicatePromptReadPlan>|undefined;
  try{plan=adjudicatePromptReadPlan(text);}catch{/* No malformed proposal can reach the canonical engines. */}
  const accepted=plan&&plan.decision===fixture.decision&&[...plan.modules].sort().join(',')===[...fixture.modules].sort().join(',');
  const completed=await withTenant(current,async tx=>{
   const fresh=await guard(tx,current,true,Boolean(accepted));await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!);
   const candidate=await candidateTx(tx,current,prepared.candidate.id);
   const [active]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p where p.id=${prepared.promotionId}::uuid
    and p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.expires_at>now()
    and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)) as allowed`);
   if(candidate.candidate_digest!==prepared.candidate.candidate_digest||active?.allowed!==true)return fail();
   const results:AgentReadResult[]=[];
   if(accepted&&plan?.decision==='read'){
    const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot||snapshot.fingerprint!==prepared.providerFingerprint)return fail();
    results.push(...await withAssistantJobReadsTx(fresh,tx,async read=>{const rows:AgentReadResult[]=[];for(const module of plan!.modules)rows.push(await read.moduleWork(module));return rows;}));
   }
   if(!accepted)await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
    values(${current.tenantId}::uuid,${prepared.promotionId}::uuid,${current.userId}::uuid,${fixture.security?'security_regression':'quality_regression'}) on conflict(promotion_id) do nothing`);
   const id=randomUUID(),receipt=seal('prompt-job',current.tenantId,id,{version:1,stage:accepted?'completed':'refused',jobId:prepared.jobId,
    candidateDigest:candidate.candidate_digest,fixtureId:fixture.id,outputDigest:routingDigest(text),resultDigest:assistantSourceDigest(results),elapsedMs:Math.max(0,Date.now()-started)});
   await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,receipt)
    values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${prepared.promotionId}::uuid,${receipt})`);
   return {accepted:Boolean(accepted),decision:plan?.decision??'refuse',results,effects:[]};
  });
  if(!completed.accepted)return fail();return completed;
 }catch{return fail();}
}

async function ownSignalChoicesTx(tx:Tx,ctx:SessionContext){
 const rows=await tx.execute<{id:string;outcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number];createdAt:string}>(sql`select id,outcome,created_at::text as "createdAt" from public.ai_agent_job_feedback
  where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and expires_at>now() order by created_at desc,id desc limit 10`);
 const choices:{id:string;outcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number];createdAt:string}[]=[];
 for(const row of rows){try{await ownSignalRefsTx(tx,ctx,[row.id]);choices.push({id:row.id,outcome:row.outcome,createdAt:row.createdAt});}catch(error){if(error instanceof AgentSignalBusy)throw error;/* Unknown/corrupt/retired evidence is not an advertised signal. */}}
 return choices;
}

type PromptEvaluationProgress=Readonly<{completedCases:number;totalCases:number;state:'complete'|'incomplete';retainedFailures:number;knownFailures:number}>;
/** Current evaluator progress only. Authentication and current source/provider binding precede counts. */
async function promptEvaluationProgressTx(tx:Tx,ctx:SessionContext,id:string,providerFingerprint:string):Promise<PromptEvaluationProgress|null>{
 try{const candidate=await candidateTx(tx,ctx,id);if(candidate.kind!=='read_plan_prompt_v1'||candidate.author_user_id===ctx.userId)return null;
  const [row]=await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select id,evaluator_user_id,suite_digest,receipt from public.ai_agent_evaluation
   where tenant_id=${ctx.tenantId}::uuid and candidate_id=${id}::uuid and evaluator_user_id=${ctx.userId}::uuid and suite_digest=${PROMPT_SUITE_DIGEST}
   order by completed_at desc,id desc limit 1`);if(!row)return null;
  const report=authenticatedPromptReport(row,candidate,ctx.tenantId,providerFingerprint);
  if(report.cases.some(row=>row.state!=='unavailable'&&(!row.outputDigest||!/^[a-f0-9]{64}$/.test(row.outputDigest))))return null;
  const completedCases=report.cases.filter(row=>row.state==='passed'||row.state==='failed').length;
  const knownFailures=report.cases.filter(row=>row.state==='failed').length,retainedFailures=report.cases.filter(row=>row.state==='failed'&&row.retained===true).length;
  if(!Number.isSafeInteger(report.unavailableAttempts)||report.unavailableAttempts<0||report.unavailableAttempts>report.attemptedRequests||
   !Number.isSafeInteger(report.attemptedRequests)||report.attemptedRequests<0||report.attemptedRequests>PROMPT_HOLDOUT_REQUEST_LIMIT)return null;
  const state=completedCases===PROMPT_HOLDOUTS.length&&report.unavailableAttempts===0&&!report.cases.some(row=>row.state==='unavailable')?'complete' as const:'incomplete' as const;
  if(report.completedCases!==completedCases||report.state!==state||report.retainedFailures!==retainedFailures)return null;
  return Object.freeze({completedCases,totalCases:PROMPT_HOLDOUTS.length,state,retainedFailures,knownFailures});
 }catch{return null;}
}

/** Minimal management metadata in the caller's already-owned workspace read carrier. */
export async function agentReviewWorkspaceTx(tx:Tx,ctx:SessionContext){
 await assertAiPrincipalTx(tx,ctx);if(!isGroupAdmin(ctx))return null;
 const [role]=await tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`);if(role?.allowed!==true)return null;
 const rows=await tx.execute<{id:string;version:number;kind:string;own:boolean;attempts:number}>(sql`select c.id,c.version,c.kind,c.owner_user_id=app.current_user_id() as own,
  (select count(*)::int from public.ai_agent_evaluation e where e.candidate_id=c.id and e.tenant_id=c.tenant_id) as attempts
  from public.ai_agent_candidate c where c.tenant_id=${ctx.tenantId}::uuid and c.kind in('typed_route_priority_v1','read_plan_prompt_v1') order by c.created_at desc,c.id desc limit 20`);
 let providerFingerprint:string|null=null;try{providerFingerprint=(await resolveAiProviderSnapshotTx(tx,ctx))?.fingerprint??null;}catch{/* No current issued provider means progress is unknown, never0. */}
 const verifiedSignalCount=new Map<string,number|null>();for(const row of rows){try{const candidate=await candidateTx(tx,ctx,row.id);verifiedSignalCount.set(row.id,captureSignalRefs(candidate.signal_refs).length);}catch{verifiedSignalCount.set(row.id,null);}}
 const ownSignalChoices=await ownSignalChoicesTx(tx,ctx);
 const progress=new Map<string,PromptEvaluationProgress|null>();for(const row of rows){progress.set(row.id,row.kind==='read_plan_prompt_v1'&&!row.own&&providerFingerprint?await promptEvaluationProgressTx(tx,ctx,row.id,providerFingerprint):null);}
 const promotions=await tx.execute<{id:string;version:number;kind:string;used:number;maximum:number;expiresAt:string;retired:boolean}>(sql`select p.id,c.version,c.kind,
  p.used_jobs as used,p.max_jobs as maximum,p.expires_at::text as "expiresAt",exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id) as retired
  from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id
  where p.tenant_id=${ctx.tenantId}::uuid and c.kind in('typed_route_priority_v1','read_plan_prompt_v1') order by p.created_at desc,p.id desc limit 20`);
 const [latest]=await tx.execute<{version:number}>(sql`select coalesce(max(version),0)::int as version from public.ai_agent_candidate
  where tenant_id=${ctx.tenantId}::uuid and owner_user_id=${ctx.userId}::uuid and module_code='assistant'`);
 let lastTrial:{state:'pending'|'completed'|'refused'|'unavailable';fixtureId:string|null}|null=null;
 const [job]=await tx.execute<{id:string;receipt:string;candidate_id:string}>(sql`select j.id,j.receipt,p.candidate_id
  from public.ai_agent_job_receipt j join public.ai_agent_promotion p on p.id=j.promotion_id and p.tenant_id=j.tenant_id
  join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id
  where j.tenant_id=${ctx.tenantId}::uuid and j.user_id=${ctx.userId}::uuid and c.kind='read_plan_prompt_v1'
  order by j.created_at desc,j.id desc limit 1`);
 if(job){try{const candidate=await candidateTx(tx,ctx,job.candidate_id),proof=open('prompt-job',ctx.tenantId,job.id,job.receipt);
  if(proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||!PROMPT_HOLDOUTS.some(row=>row.id===proof.fixtureId))throw Error();
  lastTrial={state:proof.stage==='reserved'?'pending':proof.stage==='completed'?'completed':proof.stage==='refused'?'refused':'unavailable',fixtureId:String(proof.fixtureId)};
 }catch{lastTrial={state:'unavailable',fixtureId:null};}}
 return {sourceDigest:MODULE_AGENT_SOURCE_DIGEST,nextVersion:latest.version+1,lastTrial,ownSignalChoices,
  candidates:rows.map(row=>({id:row.id,version:row.version,kind:row.kind,own:row.own,attempts:row.attempts,progress:progress.get(row.id)??null,verifiedSignalCount:verifiedSignalCount.get(row.id)??null})),
  promotions:promotions.map(row=>({id:row.id,version:row.version,kind:row.kind,used:row.used,maximum:row.maximum,expiresAt:row.expiresAt,retired:row.retired}))};
}

/** Human-question planning is separate from synthetic evaluation and never retrieves HR records.
 * A proposal nominates labels only; a second explicit human command owns all canonical reads.
 */
export const MODULE_PLAN_PROPOSAL_TTL_SECONDS=900;
const questionLocales=['en','ms','zh','ta','th','vi'] as const;
type QuestionLocale=typeof questionLocales[number];
type PlanningBinding=Readonly<{proposalId:string;candidateId:string;candidateDigest:string;promotionId:string;providerFingerprint:string;sourceDigest:string;engineDigest:string;policyDigest:string;suiteDigest:string;humanSuiteDigest:string}>;
type PlanProposalRow={id:string;user_id:string;request_nonce:string;promotion_id:string;state:'reserved'|'ready'|'refused'|'failed';receipt:string;created_at:string;expires_at:string;fresh:boolean;consumed_job_id:string|null};
const proposalProjection=sql`id,user_id,request_nonce,promotion_id,state,receipt,created_at::text,expires_at::text,expires_at>now() as fresh,consumed_job_id`;
function capturePlanningBinding(input:unknown):PlanningBinding{
 if(!input||typeof input!=='object'||Array.isArray(input)||!exact(input,['proposalId','candidateId','candidateDigest','promotionId','providerFingerprint','sourceDigest','engineDigest','policyDigest','suiteDigest','humanSuiteDigest']))return fail();
 const row=input as Record<string,unknown>;
 for(const field of ['proposalId','candidateId','promotionId'])if(typeof row[field]!=='string'||!uuid(row[field] as string))return fail();
 for(const field of ['candidateDigest','sourceDigest','engineDigest','policyDigest','suiteDigest','humanSuiteDigest'])if(typeof row[field]!=='string'||!/^[a-f0-9]{64}$/.test(row[field] as string))return fail();
 if(typeof row.providerFingerprint!=='string'||!row.providerFingerprint||row.providerFingerprint.length>1024||row.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||row.engineDigest!==PROMPT_ENGINE_DIGEST||row.policyDigest!==PROMPT_POLICY_DIGEST||row.suiteDigest!==PROMPT_SUITE_DIGEST||row.humanSuiteDigest!==HUMAN_PLAN_SUITE_DIGEST)return fail();
 return Object.freeze(row) as PlanningBinding;
}
/** Historical sealed binding nominates; fresh issued provider and actual principal remain authority. */
async function currentPlanningBindingTx(tx:Tx,ctx:SessionContext,binding:PlanningBinding){
 const fresh=await guard(tx,ctx,false);await assertAiActionUnpausedTx(tx,fresh,'module_agent_planning');
 await agentReleaseIntervalTx(tx,ctx,ctx.userId!,false);await signalIntervalTx(tx,ctx,ctx.userId!);
 const candidate=await candidateTx(tx,ctx,binding.candidateId);
 if(candidate.owner_user_id!==ctx.userId||candidate.kind!=='read_plan_prompt_v1'||candidate.candidate_digest!==binding.candidateDigest)return fail();
 const [promotion]=await tx.execute<{receipt:string;max_jobs:number;expires_at:string}>(sql`select receipt,max_jobs,expires_at::text from public.ai_agent_promotion p where p.id=${binding.promotionId}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.owner_user_id=${ctx.userId}::uuid and p.candidate_id=${candidate.id}::uuid and p.expires_at>now() and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)`);
 if(!promotion)return fail();const proof=open('prompt-promotion',ctx.tenantId,binding.promotionId,promotion.receipt);
 const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);
 if(!snapshot||snapshot.fingerprint!==binding.providerFingerprint||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(bindingOfCandidate(candidate))||proof.providerFingerprint!==snapshot.fingerprint||proof.maxJobs!==promotion.max_jobs||new Date(String(proof.expiresAt)).getTime()!==new Date(promotion.expires_at).getTime())return fail();
 await assertHumanPlanEvaluationsTx(tx,ctx,candidate,snapshot.fingerprint);
 return {fresh,candidate,snapshot};
}
// Avoid shadowing the existing candidate binding owner with historical proposal bindings.
const bindingOfCandidate=binding;
function openProposal(row:PlanProposalRow,ctx:SessionContext){
 if(!ctx.userId||row.user_id!==ctx.userId||!row.fresh)return fail();const proof=open('human-plan',ctx.tenantId,row.id,row.receipt);
 if(proof.version!==1||proof.userId!==ctx.userId||proof.nonce!==row.request_nonce||proof.state!==row.state||typeof proof.questionDigest!=='string'||!/^[a-f0-9]{64}$/.test(proof.questionDigest)||
  !questionLocales.includes(proof.locale as QuestionLocale)||new Date(String(proof.createdAt)).getTime()!==new Date(row.created_at).getTime()||new Date(String(proof.expiresAt)).getTime()!==new Date(row.expires_at).getTime()||
  new Date(row.expires_at).getTime()-new Date(row.created_at).getTime()>MODULE_PLAN_PROPOSAL_TTL_SECONDS*1000)return fail();
 const checked=capturePlanningBinding(proof.binding);if(checked.proposalId!==row.id||checked.promotionId!==row.promotion_id)return fail();
 return {proof,binding:checked};
}
async function proposalNonceTx(tx:Tx,ctx:SessionContext,nonce:string){
 const [owned]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-plan:'+ctx.tenantId+':'+ctx.userId+':'+nonce},0)) as owned`);if(owned?.owned!==true)return fail();
}
async function checkedOwnPlanProposalTx(tx:Tx,ctx:SessionContext,id:string,plan:ReturnType<typeof captureTypedModulePlan>){
 if(!uuid(id))return fail();const [row]=await tx.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);if(!row)return fail();
 await proposalNonceTx(tx,ctx,row.request_nonce);const opened=openProposal(row,ctx);await currentPlanningBindingTx(tx,ctx,opened.binding);
 if(row.state!=='ready'||routingDigest(captureTypedModulePlan(opened.proof.plan))!==routingDigest(plan))return fail();return {row,binding:opened.binding};
}
export type OwnModulePlanView=Readonly<{state:'ready';proposalId:string;modules:ReturnType<typeof captureTypedModulePlan>['modules'];consumedJobId:string|null;expiresAt:string}|{state:'reserved'|'refused'|'failed';proposalId:string;expiresAt:string}>;
/** GET reopening never consumes quota, writes metadata, calls a provider or reads canonical HR facts. */
export async function reopenOwnModulePlanTx(tx:Tx,ctx:SessionContext,id:string):Promise<OwnModulePlanView>{
 const current=capture(ctx);if(!uuid(id))return fail();const [mode]=await tx.execute<{readonly:string}>(sql`select current_setting('transaction_read_only') as readonly`);if(mode?.readonly!=='on')return fail();
 await guard(tx,current,false);const [row]=await tx.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where id=${id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);if(!row)return fail();
 const opened=openProposal(row,current);await currentPlanningBindingTx(tx,current,opened.binding);
 if(row.state==='ready')return Object.freeze({state:'ready',proposalId:row.id,modules:captureTypedModulePlan(opened.proof.plan).modules,consumedJobId:row.consumed_job_id,expiresAt:row.expires_at});
 return Object.freeze({state:row.state,proposalId:row.id,expiresAt:row.expires_at});
}
/** Server-issued request identity. Issuance is read-only and consumes no model or job allowance.
 * The browser receives only AEAD bytes; posted timestamps/nonces never authorize a new request.
 */
export async function issueOwnModulePlanPermitTx(tx:Tx,ctx:SessionContext,ttlSeconds=MODULE_PLAN_PROPOSAL_TTL_SECONDS):Promise<string>{
 const current=capture(ctx);if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>MODULE_PLAN_PROPOSAL_TTL_SECONDS)return fail();const [mode]=await tx.execute<{readonly:string}>(sql`select current_setting('transaction_read_only') as readonly`);if(mode?.readonly!=='on')return fail();
 const fresh=await guard(tx,current,false);await assertAiActionUnpausedTx(tx,fresh,'module_agent_planning');
 const [clock]=await tx.execute<{issued:string;expires:string}>(sql`select now()::text as issued,(now()+make_interval(secs=>${ttlSeconds}))::text as expires`);
 return seal('human-plan-permit',current.tenantId,current.userId!,{version:1,tenantId:current.tenantId,userId:current.userId,nonce:randomUUID(),sourceDigest:MODULE_AGENT_SOURCE_DIGEST,engineDigest:PROMPT_ENGINE_DIGEST,policyDigest:PROMPT_POLICY_DIGEST,issuedAt:clock.issued,expiresAt:clock.expires});
}
function openPlanPermit(ctx:SessionContext,permit:string){
 if(!ctx.userId||typeof permit!=='string'||permit.length>8192)return fail();const proof=open('human-plan-permit',ctx.tenantId,ctx.userId,permit);
 if(!exact(proof,['version','tenantId','userId','nonce','sourceDigest','engineDigest','policyDigest','issuedAt','expiresAt'])||proof.version!==1||proof.tenantId!==ctx.tenantId||proof.userId!==ctx.userId||typeof proof.nonce!=='string'||!uuid(proof.nonce)||proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||proof.engineDigest!==PROMPT_ENGINE_DIGEST||proof.policyDigest!==PROMPT_POLICY_DIGEST||typeof proof.issuedAt!=='string'||typeof proof.expiresAt!=='string')return fail();
 const issued=Date.parse(proof.issuedAt),expires=Date.parse(proof.expiresAt);if(!Number.isFinite(issued)||!Number.isFinite(expires)||expires<=issued||expires-issued>MODULE_PLAN_PROPOSAL_TTL_SECONDS*1000)return fail();
 return {nonce:proof.nonce,issuedAt:proof.issuedAt,expiresAt:proof.expiresAt};
}
async function currentPlanPermitTx(tx:Tx,permit:ReturnType<typeof openPlanPermit>){
 const [clock]=await tx.execute<{valid:boolean}>(sql`select ${permit.issuedAt}::timestamptz<=clock_timestamp() and ${permit.expiresAt}::timestamptz>clock_timestamp() as valid`);if(clock?.valid!==true)return fail();
}
/** No question or provider text is persisted. Even request digests remain inside authenticated ciphertext. */
export async function proposeOwnModuleReadPlan(ctx:SessionContext,input:{permit:string;question:string;locale:string;consent:{questionOnly:true;oneRequest:true;sourceDigest:string}}):Promise<{state:'chooser'}|{state:'replayed'|'completed';proposalId:string}>{
 const current=capture(ctx),token=input.permit,question=input.question,locale=input.locale,consent=input.consent?{...input.consent}:null;
 if(!exact(input,['permit','question','locale','consent'])||typeof question!=='string'||!question.trim()||Buffer.byteLength(question,'utf8')>2000||!questionLocales.includes(locale as QuestionLocale)||!consent||!exact(consent,['questionOnly','oneRequest','sourceDigest'])||consent.questionOnly!==true||consent.oneRequest!==true||consent.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST)return fail();
 const permit=openPlanPermit(current,token),nonce=permit.nonce,questionDigest=routingDigest([current.tenantId,current.userId,nonce,locale,question]),started=Date.now();
 try{
  const prepared=await withTenant(current,async tx=>{
   const fresh=await guard(tx,current,false);await currentPlanPermitTx(tx,permit);await assertAiActionUnpausedTx(tx,fresh,'module_agent_planning');await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!);await proposalNonceTx(tx,current,nonce);
   const [existing]=await tx.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and request_nonce=${nonce}::uuid`);
   if(existing){const prior=openProposal(existing,current);await currentPlanningBindingTx(tx,current,prior.binding);if(prior.proof.questionDigest!==questionDigest||prior.proof.locale!==locale||!Number.isSafeInteger(prior.proof.duplicateReplays)||Number(prior.proof.duplicateReplays)<0)return fail();await tx.execute(sql`update public.ai_agent_plan_proposal set receipt=${seal('human-plan',current.tenantId,existing.id,{...prior.proof,duplicateReplays:Number(prior.proof.duplicateReplays)+1})} where id=${existing.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);return {replayed:true as const,id:existing.id};}
   const [promotion]=await tx.execute<{id:string;candidate_id:string}>(sql`select p.id,p.candidate_id from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='read_plan_prompt_v1' where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id) order by p.created_at desc,p.id desc limit 1 for update of p nowait`);
   if(!promotion)return {unavailable:true as const};
   const candidate=await candidateTx(tx,current,promotion.candidate_id),snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();const id=randomUUID();
   const bound=capturePlanningBinding({proposalId:id,candidateId:candidate.id,candidateDigest:candidate.candidate_digest,promotionId:promotion.id,providerFingerprint:snapshot.fingerprint,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,engineDigest:PROMPT_ENGINE_DIGEST,policyDigest:PROMPT_POLICY_DIGEST,suiteDigest:PROMPT_SUITE_DIGEST,humanSuiteDigest:HUMAN_PLAN_SUITE_DIGEST});
   await currentPlanningBindingTx(tx,current,bound);await currentPlanPermitTx(tx,permit);
   const [clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,${permit.expiresAt}::timestamptz::text as expires`);
   const proof={version:1,userId:current.userId,nonce,state:'reserved',questionDigest,locale,binding:bound,createdAt:clock.now,expiresAt:clock.expires,runId:null,tokens:null,cost:null,elapsedMs:null,outcome:'pending',duplicateReplays:0};
   await tx.execute(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${promotion.id}::uuid and tenant_id=${current.tenantId}::uuid`);
   await tx.execute(sql`insert into public.ai_agent_plan_proposal(id,tenant_id,user_id,request_nonce,promotion_id,state,receipt,created_at,expires_at) values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${nonce}::uuid,${promotion.id}::uuid,'reserved',${seal('human-plan',current.tenantId,id,proof)},${clock.now}::timestamptz,${clock.expires}::timestamptz)`);
   return {replayed:false as const,id,candidate,bound};
  });
  if('unavailable' in prepared)return {state:'chooser' as const};const proposalId=prepared.id;if(typeof proposalId!=='string')return fail();if(prepared.replayed)return {state:'replayed' as const,proposalId};
  const outbound=Object.freeze({system:promptCandidateSystem(prepared.candidate.configuration),prompt:humanQuestionPrompt(question,locale),maxTokens:384,timeoutMs:15000}),expectedInputDigest=draftInputDigest(outbound);
  // Fresh provider configuration is issued only after durable reservation. No transaction spans network.
  const cfg=await withTenant(current,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);const checked=await currentPlanningBindingTx(tx,current,prepared.bound);
   const admitted=withAiAdmissionCheck(governedAiConfig(checked.fresh,checked.snapshot,'module_agent_planning'),'module_agent_planning',async carrier=>{
    await currentPlanPermitTx(carrier,permit);await currentPlanningBindingTx(carrier,current,prepared.bound);await proposalNonceTx(carrier,current,nonce);const [row]=await carrier.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where id=${prepared.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);if(!row||openProposal(row,current).proof.state!=='reserved')return fail();
   });
   return withAiAdmissionLifecycle(admitted,'module_agent_planning',{
    admitted:async(carrier,event)=>{
     await currentPlanPermitTx(carrier,permit);await currentPlanningBindingTx(carrier,current,prepared.bound);await proposalNonceTx(carrier,current,nonce);
     const [row]=await carrier.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where id=${prepared.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);
     if(!row||event.request.operation!=='draft'||event.request.inputDigest!==expectedInputDigest)return fail();const {proof}=openProposal(row,current);if(row.state!=='reserved'||proof.runId!==null)return fail();
     await carrier.execute(sql`update public.ai_agent_plan_proposal set receipt=${seal('human-plan',current.tenantId,row.id,{...proof,runId:event.runId})} where id=${row.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);
    },
    settled:async(carrier,event)=>{
     // Settlement remains honest even if authority was revoked after admission or personal custody erased.
     if(!await isAiPrincipalCurrentTx(carrier,current))return;
     await proposalNonceTx(carrier,current,nonce);
     const [row]=await carrier.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where id=${prepared.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);if(!row)return;
     const proof=open('human-plan',current.tenantId,row.id,row.receipt);if(proof.userId!==current.userId||proof.nonce!==nonce||proof.runId!==event.runId||row.state!=='reserved')return fail();
     await carrier.execute(sql`update public.ai_agent_plan_proposal set receipt=${seal('human-plan',current.tenantId,row.id,{...proof,tokens:event.actualTokens,cost:event.accounting.openrouterAccountCostCredits,costUnit:event.accounting.openrouterAccountCostCredits===null?null:'openrouter-account-credit',accounting:event.accounting,settled:event.succeeded})} where id=${row.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);
    },
   });
  });
  let text:string|undefined;try{text=await generateDraft(cfg,outbound);}catch{/* Reserved request is terminally failed; it is never automatically sent again. */}
  let plan:ReturnType<typeof adjudicatePromptReadPlan>|undefined;try{if(text!==undefined)plan=adjudicatePromptReadPlan(text);}catch{/* Malformed prose never becomes a plan. */}
  await withTenant(current,async tx=>{await currentPlanPermitTx(tx,permit);await currentPlanningBindingTx(tx,current,prepared.bound);await proposalNonceTx(tx,current,nonce);
   const [row]=await tx.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where id=${prepared.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);if(!row||row.state!=='reserved')return fail();const {proof}=openProposal(row,current);
   const state=text===undefined||proof.settled!==true||typeof proof.runId!=='string'?'failed':plan?.decision==='read'?'ready':'refused';
   await tx.execute(sql`update public.ai_agent_plan_proposal set state=${state},receipt=${seal('human-plan',current.tenantId,row.id,{...proof,state,plan:state==='ready'?{version:1,modules:plan!.modules}:null,outputDigest:text===undefined?null:routingDigest(text),elapsedMs:Math.max(0,Date.now()-started),outcome:state})} where id=${row.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);
  });return {state:'completed' as const,proposalId};
 }catch{return fail();}
}
/** Personal proposal erasure survives Assistant grant loss; no raw question or other user's data read. */
export async function eraseOwnModulePlanProposals(ctx:SessionContext){const current=capture(ctx);try{return await withTenant(current,async tx=>{
 await assertAiPrincipalTx(tx,current);if(!current.userId)return fail();await agentReleaseIntervalTx(tx,current,current.userId);const rows=await tx.execute<{id:string}>(sql`delete from public.ai_agent_plan_proposal where tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid returning id`);return {erased:rows.length};
 });}catch{return fail();}}

function checkedHumanEvaluation(row:{id:string;evaluator_user_id:string;receipt:string},candidate:CandidateRow,ctx:SessionContext,fingerprint:string){
 const proof=open('human-plan-evaluation',ctx.tenantId,row.id,row.receipt);
 if(proof.version!==1||proof.suiteDigest!==HUMAN_PLAN_SUITE_DIGEST||proof.candidateDigest!==candidate.candidate_digest||proof.evaluatorId!==row.evaluator_user_id||proof.providerFingerprint!==fingerprint||routingDigest(proof.binding)!==routingDigest(binding(candidate))||!Array.isArray(proof.cases)||proof.cases.length>HUMAN_PLAN_HOLDOUTS.length)return fail();
 const seen=new Set<string>();for(const item of proof.cases){if(!item||typeof item.id!=='string'||seen.has(item.id)||!HUMAN_PLAN_HOLDOUTS.some(f=>f.id===item.id)||!['passed','failed','unavailable'].includes(item.state)||item.state!=='unavailable'&&(typeof item.outputDigest!=='string'||!/^[a-f0-9]{64}$/.test(item.outputDigest)))return fail();seen.add(item.id);}return {...proof,state:proof.state,cases:proof.cases};
}
async function assertHumanPlanEvaluationsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow,fingerprint:string){
 // Group-admin-only evaluation RLS is unchanged. Learned candidates are never lent to other owners.
 const rows=await tx.execute<{id:string;evaluator_user_id:string;receipt:string}>(sql`select distinct on(evaluator_user_id) id,evaluator_user_id,receipt from public.ai_agent_evaluation where tenant_id=${ctx.tenantId}::uuid and candidate_id=${candidate.id}::uuid and suite_digest=${HUMAN_PLAN_SUITE_DIGEST} order by evaluator_user_id,completed_at desc,id desc`);
 if(rows.length<2||rows.length>8)return fail();for(const row of rows){if(row.evaluator_user_id===candidate.author_user_id)return fail();const proof=checkedHumanEvaluation(row,candidate,ctx,fingerprint);if(proof.state!=='complete'||proof.cases.length!==HUMAN_PLAN_HOLDOUTS.length||proof.cases.some((item:{state:string})=>item.state!=='passed'))return fail();}
}
/** Additional synthetic-only consent, independent from permission to send a human question. */
export async function evaluateHumanQuestionPlannerCandidate(ctx:SessionContext,input:{candidateId:string;consent:AgentSyntheticConsent}){
 const current=capture(ctx),candidateId=input.candidateId;captureSyntheticConsent(input.consent,HUMAN_PLAN_HOLDOUTS.length);if(!exact(input,['candidateId','consent']))return fail();
 try{const prepared=await withTenant(current,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);const fresh=await guard(tx,current,true);await assertAiActionUnpausedTx(tx,fresh,'module_agent_evaluation');const candidate=await candidateTx(tx,current,candidateId);if(candidate.kind!=='read_plan_prompt_v1'||candidate.author_user_id===current.userId)return fail();
  const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();
  const cfg=withAiAdmissionCheck(governedAiConfig(fresh,snapshot,'module_agent_evaluation'),'module_agent_evaluation',async carrier=>{await guard(carrier,current,true);const again=await candidateTx(carrier,current,candidateId);if(again.candidate_digest!==candidate.candidate_digest||again.author_user_id===current.userId)return fail();});
  const [prior]=await tx.execute<{id:string;evaluator_user_id:string;receipt:string}>(sql`select id,evaluator_user_id,receipt from public.ai_agent_evaluation where tenant_id=${current.tenantId}::uuid and candidate_id=${candidateId}::uuid and evaluator_user_id=${current.userId}::uuid and suite_digest=${HUMAN_PLAN_SUITE_DIGEST} order by completed_at desc,id desc limit 1`);
  let retained:Record<string,unknown>|null=null;try{if(prior)retained=checkedHumanEvaluation(prior,candidate,current,snapshot.fingerprint);}catch{/* Changed provenance is genuinely unrun input. */}
  return {candidate,cfg,fingerprint:snapshot.fingerprint,retained};
 });
 const cases:{id:string;state:'passed'|'failed'|'unavailable';outputDigest?:string;retained?:boolean}[]=[];let attempted=0,unavailable=0;
 const priorCases=Array.isArray(prepared.retained?.cases)?prepared.retained.cases:[];
 for(const fixture of HUMAN_PLAN_HOLDOUTS){const prior=priorCases.find(row=>row.id===fixture.id&&row.state==='passed');if(prior){cases.push({...prior,retained:true});continue;}attempted++;
  let text:string;try{text=await generateDraft(prepared.cfg,{system:promptCandidateSystem(prepared.candidate.configuration),prompt:humanQuestionPrompt(fixture.question,fixture.locale),maxTokens:384,timeoutMs:15000});}catch{unavailable++;const failed=priorCases.find(row=>row.id===fixture.id&&row.state==='failed');cases.push(failed?{...failed,retained:true}:{id:fixture.id,state:'unavailable'});continue;}
  let passed=false;try{const plan=adjudicatePromptReadPlan(text);passed=plan.decision===fixture.decision&&[...plan.modules].sort().join(',')===[...fixture.modules].sort().join(',');}catch{/* Typed refusal is not an invented success. */}
  cases.push({id:fixture.id,state:passed?'passed':'failed',outputDigest:routingDigest(text)});
 }
 const state=unavailable?'incomplete':'complete';return await withTenant(current,async tx=>{await guard(tx,current,true,false);const candidate=await candidateTx(tx,current,candidateId);const snapshot=await resolveAiProviderSnapshotTx(tx,current);if(candidate.candidate_digest!==prepared.candidate.candidate_digest||snapshot?.fingerprint!==prepared.fingerprint)return fail();
  const id=randomUUID(),receipt=seal('human-plan-evaluation',current.tenantId,id,{version:1,suiteDigest:HUMAN_PLAN_SUITE_DIGEST,candidateDigest:candidate.candidate_digest,binding:binding(candidate),evaluatorId:current.userId,providerFingerprint:prepared.fingerprint,state,cases});
  await tx.execute(sql`insert into public.ai_agent_evaluation(id,tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt) values(${id}::uuid,${current.tenantId}::uuid,${candidateId}::uuid,${current.userId}::uuid,${HUMAN_PLAN_SUITE_DIGEST},${receipt})`);
  return {state,attempted,completedCases:cases.filter(row=>row.state!=='unavailable').length,totalCases:HUMAN_PLAN_HOLDOUTS.length,knownFailures:cases.filter(row=>row.state==='failed').length,retainedPasses:cases.filter(row=>row.retained).length};
 });}catch{return fail();}
}

// ── Closed per-module canonical specialist lifecycle. No provider/model, raw learning or HR effect. ──
function specialistBaselineDigest(module:AgentModuleCode){return routingDigest(['canonical-module-facts-baseline-v1',module,MODULE_AGENT_SOURCE_DIGEST,specialistNativeContractDigest(module)]);}
function specialistModuleEngineDigest(module:AgentModuleCode){return routingDigest([SPECIALIST_ENGINE_DIGEST,specialistNativeContractDigest(module)]);}
type SpecialistJobBinding=Readonly<{configuration:SpecialistCandidate;nativeContractDigest:string;suiteDigest:string;assessmentDigest:string|null}>;
function captureSpecialistJobBinding(value:unknown):SpecialistJobBinding{
 if(!value||typeof value!=='object'||Array.isArray(value)||!exact(value,['configuration','nativeContractDigest','suiteDigest','assessmentDigest']))return fail();const row=value as Record<string,unknown>,configuration=SpecialistCandidate.parse(row.configuration);
 if(row.nativeContractDigest!==specialistNativeContractDigest(configuration.module)||row.suiteDigest!==specialistSuiteDigest(configuration.module)||row.assessmentDigest!==null&&(typeof row.assessmentDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.assessmentDigest)))return fail();
 return Object.freeze({configuration,nativeContractDigest:row.nativeContractDigest as string,suiteDigest:row.suiteDigest as string,assessmentDigest:row.assessmentDigest as string|null});
}
export async function createCanonicalSpecialistCandidate(ctx:SessionContext,input:{module:AgentModuleCode;version:number;signalIds?:readonly string[]}){
 const current=capture(ctx),module=input.module,version=input.version,signalIds=captureSignalIds(input.signalIds);if(!exact(input,input.signalIds===undefined?['module','version']:['module','version','signalIds'])||!isAgentModuleCode(module)||!Number.isSafeInteger(version)||version<1)return fail();
 try{return await withTenant(current,async tx=>{const fresh=await guard(tx,current,true);assertModuleEnabled(fresh,module);const configuration=SpecialistCandidate.parse({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'}),refs=await ownSpecialistSignalRefsTx(tx,current,signalIds,module),id=randomUUID();
 const row:CandidateRow={id,owner_user_id:current.userId!,author_user_id:current.userId!,module_code:module,version,kind:'canonical_specialist_v1',configuration,candidate_digest:'',baseline_digest:specialistBaselineDigest(module),source_digest:MODULE_AGENT_SOURCE_DIGEST,engine_digest:specialistModuleEngineDigest(module),policy_digest:SPECIALIST_POLICY_DIGEST,input_digest:specialistInputDigest(module),signal_refs:refs,signal_receipt:null};row.candidate_digest=routingDigest(binding(row));
 await tx.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest) values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${current.userId}::uuid,${module},${version},'canonical_specialist_v1',${JSON.stringify(configuration)}::jsonb,${row.candidate_digest},${row.baseline_digest},${row.source_digest},${row.engine_digest},${row.policy_digest},${row.input_digest})`);await persistCandidateSignalsTx(tx,current,row);return{candidateId:id,candidateDigest:row.candidate_digest,state:'unevaluated' as const};});}catch{return fail();}
}
const specialistIssued=new WeakMap<object,{candidate:CandidateRow;evaluatorId:string;id:string;report:SpecialistEvaluationReport}>();
export async function evaluateCanonicalSpecialistCandidate(ctx:SessionContext,candidateId:string){
 const current=capture(ctx),id=candidateId;if(typeof id!=='string'||!uuid(id))return fail();try{const evidence=await withTenant(current,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);const fresh=await guard(tx,current,true),candidate=await candidateTx(tx,current,id);if(candidate.kind!=='canonical_specialist_v1'||candidate.author_user_id===current.userId)return fail();const configuration=SpecialistCandidate.parse(candidate.configuration);assertModuleEnabled(fresh,configuration.module);const report=await withAssistantReadTx(fresh,tx,read=>executeSpecialistHoldout(configuration,read)),proof=Object.freeze({});specialistIssued.set(proof,{candidate,evaluatorId:current.userId!,id:randomUUID(),report});return proof;});
 return await withTenant(current,async tx=>{const fresh=await guard(tx,current,true);const issued=specialistIssued.get(evidence);if(!issued)return fail();specialistIssued.delete(evidence);const candidate=await candidateTx(tx,current,id);if(candidate.kind!=='canonical_specialist_v1'||candidate.candidate_digest!==issued.candidate.candidate_digest||issued.evaluatorId!==current.userId)return fail();assertModuleEnabled(fresh,SpecialistCandidate.parse(candidate.configuration).module);const receipt=seal('specialist-evaluation',current.tenantId,issued.id,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),evaluatorId:issued.evaluatorId,report:issued.report});await tx.execute(sql`insert into public.ai_agent_evaluation(id,tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt) values(${issued.id}::uuid,${current.tenantId}::uuid,${id}::uuid,${current.userId}::uuid,${issued.report.suiteDigest},${receipt})`);return{evaluationId:issued.id,module:issued.report.module,coverage:issued.report.coverage,state:issued.report.state,securityFailures:issued.report.securityFailures,qualityFailures:issued.report.qualityFailures,nativeEvidence:issued.report.nativeEvidence};});}catch{return fail();}
}
function specialistExpectedCaseIds(module:AgentModuleCode){return [...SPECIALIST_HOLDOUTS.filter(row=>row.module===module).map(row=>row.id),...['foreign-module','foreign-scope','wrong-capability','posted-subject','self-rating','effect-request','unpermitted-fields-not-learned'].map(id=>module+':'+id),...(module==='leave'?['leave:poisoned-withheld-refused']:module==='claims'?['claims:poisoned-payment-refused']:[]),module+':fresh-native-facts-preserved',module+':nonempty-business-evidence'].sort();}
function checkedSpecialistEvaluation(row:{id:string;evaluator_user_id:string;suite_digest:string;receipt:string},candidate:CandidateRow,tenant:string){
 const configuration=SpecialistCandidate.parse(candidate.configuration),module=configuration.module,proof=open('specialist-evaluation',tenant,row.id,row.receipt);if(!exact(proof,['version','candidateDigest','binding','evaluatorId','report'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||proof.evaluatorId!==row.evaluator_user_id||row.evaluator_user_id===candidate.author_user_id||routingDigest(proof.binding)!==routingDigest(binding(candidate))||row.suite_digest!==specialistSuiteDigest(module))return fail();const report=proof.report as SpecialistEvaluationReport;
 if(!report||!exact(report,['version','module','coverage','suiteDigest','inputDigest','nativeContractDigest','engineDigest','policyDigest','state','securityFailures','qualityFailures','nativeEvidence','cases'])||report.version!==1||report.module!==module||report.coverage!=='canonical_domain_guidance_only'||report.suiteDigest!==specialistSuiteDigest(module)||report.inputDigest!==specialistInputDigest(module)||report.nativeContractDigest!==specialistNativeContractDigest(module)||report.engineDigest!==SPECIALIST_ENGINE_DIGEST||report.policyDigest!==SPECIALIST_POLICY_DIGEST||!['complete','incomplete'].includes(report.state)||!['present','missing'].includes(report.nativeEvidence)||!Array.isArray(report.cases)||routingDigest(report.cases.map(item=>item.id).sort())!==routingDigest(specialistExpectedCaseIds(module))||new Set(report.cases.map(item=>item.id)).size!==report.cases.length||report.cases.some(item=>!exact(item,['id','passed','category'])||typeof item.passed!=='boolean'||!['quality','security','native'].includes(item.category))||report.securityFailures!==report.cases.filter(item=>item.category==='security'&&!item.passed).length||report.qualityFailures!==report.cases.filter(item=>item.category!=='security'&&!item.passed).length)return fail();
 return {evaluationId:row.id,evaluatorId:row.evaluator_user_id,report};
}
async function specialistEvaluationsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow){const module=SpecialistCandidate.parse(candidate.configuration).module,rows=await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select distinct on(evaluator_user_id) id,evaluator_user_id,suite_digest,receipt from public.ai_agent_evaluation where tenant_id=${ctx.tenantId}::uuid and candidate_id=${candidate.id}::uuid and suite_digest=${specialistSuiteDigest(module)} order by evaluator_user_id,completed_at desc,id desc`);return Array.from(rows).map(row=>checkedSpecialistEvaluation(row,candidate,ctx.tenantId));}
export async function promoteCanonicalSpecialistCandidate(ctx:SessionContext,input:{candidateId:string;maxJobs:number;hours:number}){
 const current=capture(ctx),p={candidateId:input.candidateId,maxJobs:input.maxJobs,hours:input.hours};if(!exact(input,['candidateId','maxJobs','hours'])||typeof p.candidateId!=='string'||!uuid(p.candidateId)||!Number.isInteger(p.maxJobs)||p.maxJobs<1||p.maxJobs>SPECIALIST_POLICY.maxJobs||!Number.isInteger(p.hours)||p.hours<1||p.hours>SPECIALIST_POLICY.maxHours)return fail();
 try{return await withTenant(current,async tx=>{const fresh=await guard(tx,current,true),nomination=await candidateTx(tx,current,p.candidateId,false);await agentReleaseIntervalTx(tx,current,nomination.owner_user_id);const candidate=await candidateTx(tx,current,p.candidateId);if(candidate.kind!=='canonical_specialist_v1'||candidate.owner_user_id!==nomination.owner_user_id||candidate.author_user_id===current.userId)return fail();const module=SpecialistCandidate.parse(candidate.configuration).module;assertModuleEnabled(fresh,module);const evaluations=await specialistEvaluationsTx(tx,current,candidate);if(evaluations.length<2||evaluations.length>8||evaluations.some(row=>row.report.state!=='complete'||row.report.nativeEvidence!=='present'||row.report.securityFailures!==0||row.report.qualityFailures!==0||row.report.cases.some(item=>!item.passed)))return fail();
 const [prior]=await tx.execute<{present:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='canonical_specialist_v1' where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${candidate.owner_user_id}::uuid and p.module_code=${module} and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id)) as present`);if(prior?.present)return fail();const id=randomUUID(),[clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,(now()+make_interval(hours=>${p.hours}))::text as expires`),receipt=seal('specialist-promotion',current.tenantId,id,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),approverId:current.userId,evaluations:evaluations.map(row=>({evaluationId:row.evaluationId,evaluatorId:row.evaluatorId})),maxJobs:p.maxJobs,createdAt:clock.now,expiresAt:clock.expires});
 await tx.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,expires_at) values(${id}::uuid,${current.tenantId}::uuid,${candidate.id}::uuid,${candidate.owner_user_id}::uuid,${module},${current.userId}::uuid,${receipt},${p.maxJobs},${clock.expires}::timestamptz)`);return{promotionId:id,module,coverage:'canonical_domain_guidance_only' as const,maxJobs:p.maxJobs,expiresAt:clock.expires};});}catch{return fail();}
}
function checkedSpecialistPromotion(candidate:CandidateRow,promotion:{id:string;receipt:string;max_jobs:number;expires_at:string},tenant:string){const proof=open('specialist-promotion',tenant,promotion.id,promotion.receipt);if(!exact(proof,['version','candidateDigest','binding','approverId','evaluations','maxJobs','createdAt','expiresAt'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||proof.maxJobs!==promotion.max_jobs||new Date(String(proof.expiresAt)).getTime()!==new Date(promotion.expires_at).getTime()||typeof proof.approverId!=='string'||proof.approverId===candidate.author_user_id||!Array.isArray(proof.evaluations)||proof.evaluations.length<2||proof.evaluations.length>8||new Set(proof.evaluations.map(row=>row.evaluatorId)).size!==proof.evaluations.length)return fail();return proof;}
async function currentSpecialistJobAssessmentTx(tx:Tx,ctx:SessionContext,job:GovernedJobRow,completed:ReturnType<typeof verifiedGovernedJob>,results:AgentReadResult[]):Promise<SpecialistAssessment|null>{
 if(!completed.specialist||!job.promotion_id)return null;const [promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.expires_at::text from public.ai_agent_promotion p where p.id=${job.promotion_id}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.owner_user_id=${ctx.userId}::uuid and p.module_code=${completed.specialist.configuration.module} and p.expires_at>now() and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id)`);if(!promotion)return null;const candidate=await candidateTx(tx,ctx,promotion.candidate_id);if(candidate.kind!=='canonical_specialist_v1'||candidate.candidate_digest!==completed.candidateDigest)return fail();checkedSpecialistPromotion(candidate,promotion,ctx.tenantId);return executeCanonicalSpecialist(completed.specialist.configuration,results[0]);
}
/** Explicit one-module human command. Source facts and permit increment share one canonical Tx. */
export async function runGovernedSpecialistJob(ctx:SessionContext,input:{module:AgentModuleCode},command:{nonce:string}){
 const current=capture(ctx),module=input.module,nonce=command?.nonce,started=Date.now();if(!exact(input,['module'])||!isAgentModuleCode(module)||!command||!exact(command,['nonce'])||typeof nonce!=='string'||!uuid(nonce))return fail();const plan=captureTypedModulePlan({version:1,modules:[module]});
 try{return await withTenant(current,async tx=>{const fresh=await guard(tx,current,false);assertModuleEnabled(fresh,module);await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!);const [owned]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-job:'+current.tenantId+':'+current.userId+':'+nonce},0)) as owned`);if(owned?.owned!==true)return fail();const [existing]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and request_nonce=${nonce}::uuid`);
 if(existing){const completed=verifiedGovernedJob(existing,current);if(!completed.specialist||completed.specialist.configuration.module!==module)return fail();await assertGovernedJobCandidateTx(tx,current,existing,completed);const results=await withAssistantJobReadsTx(fresh,tx,async read=>[await read.moduleWork(module)]),specialist=await currentSpecialistJobAssessmentTx(tx,current,existing,completed,results);return{version:1 as const,jobId:existing.id,mode:completed.mode,results,specialist,effects:[],replayed:true};}
 const [promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.expires_at::text from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='canonical_specialist_v1' where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.module_code=${module} and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id) order by p.created_at desc,p.id desc limit 1 for update of p nowait`);
 let selected:CandidateRow|undefined;if(promotion){const candidate=await candidateTx(tx,current,promotion.candidate_id,false);let valid=true;try{assertCurrent(candidate);await assertCandidateSignalsTx(tx,current,candidate);}catch(error){if(!(error instanceof AiGatewayError)&&!(error instanceof Error&&error.name==='ZodError'))throw error;valid=false;}if(!valid)await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason) values(${current.tenantId}::uuid,${promotion.id}::uuid,${current.userId}::uuid,'source_changed') on conflict(promotion_id) do nothing`);else{if(candidate.kind!=='canonical_specialist_v1'||candidate.module_code!==module)return fail();checkedSpecialistPromotion(candidate,promotion,current.tenantId);selected=candidate;}}
 const configuration=selected?SpecialistCandidate.parse(selected.configuration):SpecialistCandidate.parse({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'}),results=await withAssistantJobReadsTx(fresh,tx,async read=>[await read.moduleWork(module)]);let specialist:SpecialistAssessment|null=null;if(selected){try{specialist=executeCanonicalSpecialist(configuration,results[0]);}catch{await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason) values(${current.tenantId}::uuid,${promotion.id}::uuid,${current.userId}::uuid,'quality_regression') on conflict(promotion_id) do nothing`);selected=undefined;}}
 if(selected)await tx.execute(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${promotion.id}::uuid and tenant_id=${current.tenantId}::uuid`);
 const id=randomUUID(),[clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,(now()+make_interval(secs=>${GOVERNED_JOB_RETENTION_DAYS*86400}))::text as expires`),mode=selected?'promoted' as const:'baseline' as const,candidateDigest=selected?.candidate_digest??specialistBaselineDigest(module),specialistProof=captureSpecialistJobBinding({configuration,nativeContractDigest:specialistNativeContractDigest(module),suiteDigest:specialistSuiteDigest(module),assessmentDigest:specialist?routingDigest(specialist):null});
 const receipt=seal('governed-job-v2',current.tenantId,id,{version:2,stage:'completed',tenantId:current.tenantId,userId:current.userId,commandNonce:nonce,mode,candidateDigest,promotionId:selected?promotion.id:null,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,engineDigest:specialistModuleEngineDigest(module),policyDigest:SPECIALIST_POLICY_DIGEST,requestedPlan:plan,executedPlan:plan,requestedPlanDigest:routingDigest(plan),executedPlanDigest:routingDigest(plan),resultDigest:assistantSourceDigest(results),createdAt:clock.now,expiresAt:clock.expires,elapsedMs:Math.max(0,Date.now()-started),specialist:specialistProof});
 await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,request_nonce,requested_plan_digest,expires_at,receipt) values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${selected?promotion.id:null}::uuid,${nonce}::uuid,${routingDigest(plan)},${clock.expires}::timestamptz,${receipt})`);return{version:1 as const,jobId:id,mode,results,specialist,effects:[],replayed:false};});}catch{return fail();}
}
export async function specialistReviewWorkspaceTx(tx:Tx,ctx:SessionContext){const current=capture(ctx);await assertAiPrincipalTx(tx,current);if(!isGroupAdmin(current))return null;const [admin]=await tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`);if(admin?.allowed!==true)return null;const fresh={...current,entitlements:await resolveEntitlementsTx(tx,current.tenantId)};
 const versions=await tx.execute<{module:string;version:number}>(sql`select module_code as module,max(version)::int as version from public.ai_agent_candidate where tenant_id=${current.tenantId}::uuid and owner_user_id=${current.userId}::uuid group by module_code`),modules=AGENT_MODULE_CODES.filter(module=>{try{assertModuleEnabled(fresh,module);return true;}catch{return false;}}).map(module=>({module,nextVersion:(versions.find(row=>row.module===module)?.version??0)+1}));
 const rows=await tx.execute<{id:string;module:AgentModuleCode;version:number;own:boolean}>(sql`select id,module_code as module,version,owner_user_id=app.current_user_id() as own from public.ai_agent_candidate where tenant_id=${current.tenantId}::uuid and kind='canonical_specialist_v1' order by created_at desc,id desc limit 40`),candidates:{id:string;module:AgentModuleCode;version:number;own:boolean;evaluations:number|null;passingEvaluators:number|null;incompleteEvaluators:number|null}[]=[];
 for(const row of rows){if(!isAgentModuleCode(row.module))continue;let evaluations:number|null=null,passingEvaluators:number|null=null,incompleteEvaluators:number|null=null;try{const candidate=await candidateTx(tx,current,row.id),checked=await specialistEvaluationsTx(tx,current,candidate);evaluations=checked.length;passingEvaluators=checked.filter(e=>e.report.state==='complete'&&e.report.securityFailures===0&&e.report.qualityFailures===0&&e.report.cases.every(item=>item.passed)).length;incompleteEvaluators=checked.filter(e=>e.report.state==='incomplete').length;}catch(error){if(!(error instanceof AiGatewayError)&&!(error instanceof Error&&error.name==='ZodError'))throw error;}candidates.push({...row,evaluations,passingEvaluators,incompleteEvaluators});}
 const promotions=await tx.execute<{id:string;module:AgentModuleCode;version:number;used:number;maximum:number;expiresAt:string;retired:boolean}>(sql`select p.id,p.module_code as module,c.version,p.used_jobs as used,p.max_jobs as maximum,p.expires_at::text as "expiresAt",exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id) as retired from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='canonical_specialist_v1' where p.tenant_id=${current.tenantId}::uuid order by p.created_at desc,p.id desc limit 40`);const signals=await ownSpecialistSignalChoicesTx(tx,current);return{modules,candidates,promotions:Array.from(promotions),ownSignalChoices:signals.choices,signalChoicesTruncated:signals.truncated};
}

/** A per-module candidate may use only explicit own feedback from a verified job of THAT module.
 * Ratings remain opinions, never independent domain truth or a source of new HR values. */
async function ownSpecialistSignalRefsTx(tx:Tx,ctx:SessionContext,ids:readonly string[],module:AgentModuleCode){
 const refs=await ownSignalRefsTx(tx,ctx,ids);for(const ref of refs){const [job]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where id=${ref.jobId}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);if(!job)return fail();const completed=verifiedGovernedJob(job,ctx);if(completed.specialist?.configuration.module!==module)return fail();}return refs;
}
async function ownSpecialistSignalChoicesTx(tx:Tx,ctx:SessionContext){
 const rows=await tx.execute<{id:string;outcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number];createdAt:string}>(sql`select id,outcome,created_at::text as "createdAt" from public.ai_agent_job_feedback where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and expires_at>now() order by created_at desc,id desc limit 31`),choices:{id:string;module:AgentModuleCode;outcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number];createdAt:string}[]=[];
 for(const row of Array.from(rows).slice(0,30)){try{const [ref]=await ownSignalRefsTx(tx,ctx,[row.id]),[job]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where id=${ref.jobId}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);if(!job)continue;const completed=verifiedGovernedJob(job,ctx);if(!completed.specialist)continue;choices.push({...row,module:completed.specialist.configuration.module});}catch(error){if(!(error instanceof AiGatewayError)&&!(error instanceof Error&&error.name==='ZodError'))throw error;/* Pure authenticity refusals remain unknown; SQL/storage failure aborts the whole owner. */}}
 return{choices:choices.slice(0,10),truncated:rows.length>30||choices.length>10};
}
