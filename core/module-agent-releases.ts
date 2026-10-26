/** Trusted source owner for immutable governed routing evidence. Not mounted as a model tool.
 * Candidate kinds without an actual fixed evaluator are refused, not labelled evaluated.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { isGroupAdmin } from '../lib/authz-model';
import { encryptSecret, decryptSecret, isSecretStorable } from '../lib/ai/crypto';
import { AiGatewayError } from '../lib/ai/types';
import { MODULE_AGENT_SOURCE_DIGEST } from '../lib/ai/module-agent-source-manifest';
import { applyTypedRouteCandidate, captureTypedModulePlan, captureTypedRouteCandidate,
  ROUTING_ENGINE_DIGEST, ROUTING_POLICY_DIGEST, ROUTING_INPUT_DIGEST, ROUTING_SUITE_DIGEST, ROUTING_POLICY,
  routingDigest, type TypedRouteCandidate } from '../lib/ai/module-agent-routing';
import { assertAiPrincipalTx } from './ai-principal';
import { assertMayUseAssistant } from './assistant-grant';
import { assertAiActionUnpausedTx } from './ai-governance';
import { resolveEntitlementsTx } from './entitlements';
import { withAssistantReadTx, withAssistantJobReadsTx, type AssistantReadSession } from './assistant-read-session';
import { executeRoutingHoldout, type RoutingEvaluationReport } from './module-agent-evaluation-harness';
import { capturePromptPlanCandidate,adjudicatePromptReadPlan,promptCandidateSystem,PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT,PROMPT_SUITE_DIGEST,PROMPT_ENGINE_DIGEST,PROMPT_POLICY_DIGEST,PROMPT_INPUT_DIGEST } from '../lib/ai/module-agent-prompt-candidate';
import { resolveAiProviderSnapshotTx } from './ai-provider-snapshot';
import { governedAiConfig,withAiAdmissionCheck } from './ai-governance';
import { executePromptHoldout,type PromptHoldoutReport } from './module-agent-prompt-harness';
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
type CandidateRow = { id: string; owner_user_id: string; author_user_id: string; module_code: string; version: number; kind:'typed_route_priority_v1'|'read_plan_prompt_v1';
  configuration: unknown; candidate_digest: string; baseline_digest: string; source_digest: string;
  engine_digest: string; policy_digest: string; input_digest: string };
function binding(row: CandidateRow) {
  const configuration = row.kind==='read_plan_prompt_v1'?capturePromptPlanCandidate(row.configuration):captureTypedRouteCandidate(row.configuration);
  return { ownerUserId: row.owner_user_id, authorUserId: row.author_user_id, module: row.module_code,
    version: row.version, configuration, baselineDigest: row.baseline_digest, sourceDigest: row.source_digest,
    engineDigest: row.engine_digest, policyDigest: row.policy_digest, inputDigest: row.input_digest };
}
function assertCurrent(row: CandidateRow) {
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
  const [row] = await tx.execute<CandidateRow>(sql`select id,owner_user_id,author_user_id,module_code,version,kind,configuration,
    candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest from public.ai_agent_candidate
    where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  if (!row) return fail(); if (validate) assertCurrent(row); return row;
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
export async function createRoutingAgentCandidate(ctx: SessionContext, input: { version: number; configuration: unknown }) {
  const current = capture(ctx), configuration = captureTypedRouteCandidate(input.configuration), version = input.version;
  if (!exact(input, ['version','configuration']) || !Number.isSafeInteger(version) || version < 1) return fail();
  try { return await withTenant(current, async tx => {
    await guard(tx, current, true);
    const id = randomUUID();
    const row: CandidateRow = { id, owner_user_id: current.userId!, author_user_id: current.userId!, module_code: 'assistant',
      version, kind:'typed_route_priority_v1', configuration, candidate_digest: '', baseline_digest: baselineDigest, source_digest: MODULE_AGENT_SOURCE_DIGEST,
      engine_digest: ROUTING_ENGINE_DIGEST, policy_digest: ROUTING_POLICY_DIGEST, input_digest: ROUTING_INPUT_DIGEST };
    row.candidate_digest = routingDigest(binding(row));
    await tx.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,
      configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
      values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${current.userId}::uuid,'assistant',${version},'typed_route_priority_v1',
      ${JSON.stringify(configuration)}::jsonb,${row.candidate_digest},${baselineDigest},${MODULE_AGENT_SOURCE_DIGEST},${ROUTING_ENGINE_DIGEST},${ROUTING_POLICY_DIGEST},${ROUTING_INPUT_DIGEST})`);
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
    await guard(tx,current,true);const candidate=await candidateTx(tx,current,p.candidateId);
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
  try{await withTenant(current,async tx=>{await guard(tx,current,true,false);
    const [row]=await tx.execute<{id:string}>(sql`select id from public.ai_agent_promotion where id=${p.promotionId}::uuid and tenant_id=${current.tenantId}::uuid for update nowait`);
    if(!row)return fail();await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
      values(${current.tenantId}::uuid,${p.promotionId}::uuid,${current.userId}::uuid,${p.reason}) on conflict(promotion_id) do nothing`);
  });}catch{return fail();}
}
export const GOVERNED_JOB_RETENTION_DAYS=30;
type GovernedJobRow={id:string;user_id:string;promotion_id:string|null;request_nonce:string|null;requested_plan_digest:string|null;receipt:string;created_at:string;expires_at:string|null;fresh:boolean};
const jobProjection=sql`id,user_id,promotion_id,request_nonce,requested_plan_digest,receipt,created_at::text,expires_at::text,(expires_at>now()) as fresh`;
function verifiedGovernedJob(row:GovernedJobRow,ctx:SessionContext){
 if(!ctx.userId||row.user_id!==ctx.userId||!row.request_nonce||!row.expires_at||!row.fresh)return fail();
 const proof=open('governed-job-v2',ctx.tenantId,row.id,row.receipt);
 if(!exact(proof,['version','stage','tenantId','userId','commandNonce','mode','candidateDigest','promotionId','sourceDigest','engineDigest','policyDigest','requestedPlan','executedPlan','requestedPlanDigest','executedPlanDigest','resultDigest','createdAt','expiresAt','elapsedMs'])||
  proof.version!==2||proof.stage!=='completed'||proof.tenantId!==ctx.tenantId||proof.userId!==ctx.userId||proof.commandNonce!==row.request_nonce||
  proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||proof.engineDigest!==ROUTING_ENGINE_DIGEST||proof.policyDigest!==ROUTING_POLICY_DIGEST||
  proof.promotionId!==row.promotion_id||(proof.mode!=='baseline'&&proof.mode!=='promoted')||
  (proof.mode==='promoted')!==Boolean(row.promotion_id)||typeof proof.candidateDigest!=='string'||!/^[a-f0-9]{64}$/.test(proof.candidateDigest)||
  typeof proof.resultDigest!=='string'||!/^[a-f0-9]{64}$/.test(proof.resultDigest)||!Number.isSafeInteger(proof.elapsedMs)||Number(proof.elapsedMs)<0||
  new Date(String(proof.createdAt)).getTime()!==new Date(row.created_at).getTime()||new Date(String(proof.expiresAt)).getTime()!==new Date(row.expires_at).getTime())return fail();
 const requested=captureTypedModulePlan(proof.requestedPlan),executed=captureTypedModulePlan(proof.executedPlan);
 if(routingDigest(requested)!==row.requested_plan_digest||proof.requestedPlanDigest!==row.requested_plan_digest||routingDigest(executed)!==proof.executedPlanDigest||
  [...requested.modules].sort().join(',')!==[...executed.modules].sort().join(',')||
  new Date(row.expires_at).getTime()-new Date(row.created_at).getTime()>GOVERNED_JOB_RETENTION_DAYS*86400000)return fail();
 return {requested,executed,mode:proof.mode as 'baseline'|'promoted',candidateDigest:proof.candidateDigest,resultDigest:proof.resultDigest};
}
/** Read-only replay: old v1 receipts remain audit-only. Current canonical facts are loaded afresh;
 * the encrypted receipt nominates a bounded plan, never a stored HR fact or current permission.
 */
export async function reopenGovernedModuleReadJobTx(tx:Tx,ctx:SessionContext,id:string){
 const current=capture(ctx);if(!uuid(id))return fail();
 const [mode]=await tx.execute<{readonly:string}>(sql`select current_setting('transaction_read_only') as readonly`);if(mode?.readonly!=='on')return fail();
 const fresh=await guard(tx,current,false);
 const [row]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt
  where id=${id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);
 if(!row)return fail();const proof=verifiedGovernedJob(row,current);
 const results=await withAssistantReadTx(fresh,tx,async read=>{const rows:AgentReadResult[]=[];for(const module of proof.executed.modules)rows.push(await read.moduleWork(module));return rows;});
 return {jobId:row.id,mode:proof.mode,changedSinceRun:assistantSourceDigest(results)!==proof.resultDigest,results};
}
/** Explicit metadata-writing job owner, not a read tool or provider admission. Whole job rolls back on failure.
 * Every command caller supplies a retained nonce; no read or retry path invents a new command identity.
 */
export async function runGovernedModuleReadPlan(ctx:SessionContext,proposed:unknown,command:{nonce:string}) {
  const current=capture(ctx),plan=captureTypedModulePlan(proposed),nonce=command?.nonce,started=Date.now();
  if(!command||typeof nonce!=='string'||!uuid(nonce)||!exact(command,['nonce']))return fail();
  try{return await withTenant(current,async tx=>{
    const fresh=await guard(tx,current,false);
    const [owned]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-job:'+current.tenantId+':'+current.userId+':'+nonce},0)) as owned`);if(owned?.owned!==true)return fail();
    const [existing]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt
     where tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and request_nonce=${nonce}::uuid`);
    if(existing){const proof=verifiedGovernedJob(existing,current);if(routingDigest(plan)!==routingDigest(proof.requested))return fail();
     const results=await withAssistantJobReadsTx(fresh,tx,async read=>{const rows:AgentReadResult[]=[];for(const module of proof.executed.modules)rows.push(await read.moduleWork(module));return rows;});
     return {version:1 as const,jobId:existing.id,candidateDigest:proof.candidateDigest,mode:proof.mode,results,effects:[],replayed:true};}
    const [promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;used_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.used_jobs,p.expires_at::text
      from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='typed_route_priority_v1' where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.module_code='assistant'
      and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
      order by p.created_at desc,p.id desc limit 1 for update of p nowait`);
    let selected=plan,candidateDigest=baselineDigest;let activePromotion:typeof promotion|undefined=promotion;
    if(promotion){const candidate=await candidateTx(tx,current,promotion.candidate_id,false);
      let currentSource=true;try{assertCurrent(candidate);}catch{currentSource=false;}
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
     createdAt:clock.now,expiresAt:clock.expires,elapsedMs:Math.max(0,Date.now()-started)});
    await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,request_nonce,requested_plan_digest,expires_at,receipt)
      values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${activePromotion?.id??null}::uuid,${nonce}::uuid,${routingDigest(plan)},${clock.expires}::timestamptz,${receipt})`);
    return {version:1 as const,jobId:id,candidateDigest,mode,results,effects:[],replayed:false};
  });}catch{return fail();}
}

/** Administrative expiry/exhaustion receipts; no source data or impersonation is returned. */
export async function maintainModuleAgentReleases(ctx:SessionContext,limit=100){
 const current=capture(ctx);if(!Number.isSafeInteger(limit)||limit<1||limit>100)return fail();
 try{return await withTenant(current,async tx=>{await guard(tx,current,true,false);
  const rows=await tx.execute<{id:string;reason:'expired'|'exhausted'}>(sql`select p.id,case when p.expires_at<=now() then 'expired' else 'exhausted' end as reason
   from public.ai_agent_promotion p where p.tenant_id=${current.tenantId}::uuid and(p.expires_at<=now() or p.used_jobs>=p.max_jobs)
   and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
   order by p.created_at,p.id limit ${limit} for update skip locked`);
  for(const row of rows)await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
   values(${current.tenantId}::uuid,${row.id}::uuid,${current.userId}::uuid,${row.reason}) on conflict(promotion_id) do nothing`);
  return {retired:rows.length};
 });}catch{return fail();}
}

/** Explicit consent is for the fixed synthetic suite only; no caller-authored HR prompt is sent. */
export type AgentSyntheticConsent=Readonly<{synthetic:true;maxRequests:number;sourceDigest:string}>;
function captureSyntheticConsent(value:AgentSyntheticConsent,requests:number=PROMPT_HOLDOUT_REQUEST_LIMIT){
 if(!value||!exact(value,['synthetic','maxRequests','sourceDigest'])||value.synthetic!==true||
  value.maxRequests!==requests||value.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST)return fail();
 return Object.freeze({synthetic:true as const,maxRequests:value.maxRequests,sourceDigest:value.sourceDigest});
}
export async function createPromptAgentCandidate(ctx:SessionContext,input:{version:number;configuration:unknown}){
 const current=capture(ctx),configuration=capturePromptPlanCandidate(input.configuration),version=input.version;
 if(!exact(input,['version','configuration'])||!Number.isSafeInteger(version)||version<1)return fail();
 try{return await withTenant(current,async tx=>{
  await guard(tx,current,true);const id=randomUUID(),base=routingDigest(['no-model-plan-baseline-v1',PROMPT_ENGINE_DIGEST]);
  const row:CandidateRow={id,owner_user_id:current.userId!,author_user_id:current.userId!,module_code:'assistant',kind:'read_plan_prompt_v1',
   version,configuration,candidate_digest:'',baseline_digest:base,source_digest:MODULE_AGENT_SOURCE_DIGEST,
   engine_digest:PROMPT_ENGINE_DIGEST,policy_digest:PROMPT_POLICY_DIGEST,input_digest:PROMPT_INPUT_DIGEST};
  row.candidate_digest=routingDigest(binding(row));
  await tx.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,
   candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
   values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${current.userId}::uuid,'assistant',${version},'read_plan_prompt_v1',
   ${JSON.stringify(configuration)}::jsonb,${row.candidate_digest},${base},${MODULE_AGENT_SOURCE_DIGEST},${PROMPT_ENGINE_DIGEST},${PROMPT_POLICY_DIGEST},${PROMPT_INPUT_DIGEST})`);
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
    and evaluator_user_id=${current.userId}::uuid order by completed_at desc,id desc limit 1`);
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
  const fresh=await guard(tx,current,true);const candidate=await candidateTx(tx,current,p.candidateId);
  if(candidate.kind!=='read_plan_prompt_v1'||candidate.author_user_id===current.userId)return fail();
  const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();
  const rows=await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select distinct on(evaluator_user_id) id,evaluator_user_id,suite_digest,receipt
   from public.ai_agent_evaluation where tenant_id=${current.tenantId}::uuid and candidate_id=${candidate.id}::uuid
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
   const fresh=await guard(tx,current,true);await assertAiActionUnpausedTx(tx,fresh,'module_agent_evaluation');
   const [promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.expires_at::text
    from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='read_plan_prompt_v1'
    where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.expires_at>now() and p.used_jobs<p.max_jobs
    and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
    order by p.created_at desc,p.id desc limit 1 for update of p nowait`);
   if(!promotion)return fail();const candidate=await candidateTx(tx,current,promotion.candidate_id,false);
   const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();
   let confirmed=true;try{assertCurrent(candidate);const proof=open('prompt-promotion',current.tenantId,promotion.id,promotion.receipt);
    if(proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||
     proof.providerFingerprint!==snapshot.fingerprint||proof.maxJobs!==promotion.max_jobs||
     new Date(String(proof.expiresAt)).getTime()!==new Date(promotion.expires_at).getTime())confirmed=false;
   }catch{confirmed=false;}
   if(!confirmed){await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
    values(${current.tenantId}::uuid,${promotion.id}::uuid,${current.userId}::uuid,'source_changed') on conflict(promotion_id) do nothing`);return null;}
   const jobId=randomUUID();await tx.execute(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${promotion.id}::uuid and tenant_id=${current.tenantId}::uuid`);
   const pending=seal('prompt-job',current.tenantId,jobId,{version:1,stage:'reserved',candidateDigest:candidate.candidate_digest,
    promotionId:promotion.id,fixtureId:fixture.id,sourceDigest:MODULE_AGENT_SOURCE_DIGEST});
   await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,receipt)
    values(${jobId}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${promotion.id}::uuid,${pending})`);
   const cfg=withAiAdmissionCheck(governedAiConfig(fresh,snapshot,'module_agent_evaluation'),'module_agent_evaluation',async carrier=>{
    await guard(carrier,current,true);const again=await candidateTx(carrier,current,candidate.id);
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
   const fresh=await guard(tx,current,true,Boolean(accepted));
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
  const state=completedCases===PROMPT_HOLDOUTS.length&&!report.cases.some(row=>row.state==='unavailable')?'complete' as const:'incomplete' as const;
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
  from public.ai_agent_candidate c where c.tenant_id=${ctx.tenantId}::uuid order by c.created_at desc,c.id desc limit 20`);
 let providerFingerprint:string|null=null;try{providerFingerprint=(await resolveAiProviderSnapshotTx(tx,ctx))?.fingerprint??null;}catch{/* No current issued provider means progress is unknown, never0. */}
 const progress=new Map<string,PromptEvaluationProgress|null>();for(const row of rows){progress.set(row.id,row.kind==='read_plan_prompt_v1'&&!row.own&&providerFingerprint?await promptEvaluationProgressTx(tx,ctx,row.id,providerFingerprint):null);}
 const promotions=await tx.execute<{id:string;version:number;kind:string;used:number;maximum:number;expiresAt:string;retired:boolean}>(sql`select p.id,c.version,c.kind,
  p.used_jobs as used,p.max_jobs as maximum,p.expires_at::text as "expiresAt",exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id) as retired
  from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id
  where p.tenant_id=${ctx.tenantId}::uuid order by p.created_at desc,p.id desc limit 20`);
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
 return {sourceDigest:MODULE_AGENT_SOURCE_DIGEST,nextVersion:latest.version+1,lastTrial,
  candidates:rows.map(row=>({id:row.id,version:row.version,kind:row.kind,own:row.own,attempts:row.attempts,progress:progress.get(row.id)??null})),
  promotions:promotions.map(row=>({id:row.id,version:row.version,kind:row.kind,used:row.used,maximum:row.maximum,expiresAt:row.expiresAt,retired:row.retired}))};
}
