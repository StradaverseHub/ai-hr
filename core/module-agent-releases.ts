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
import { withAssistantReadTx, withAssistantJobReadsTx } from './assistant-read-session';
import { executeRoutingHoldout, type RoutingEvaluationReport } from './module-agent-evaluation-harness';
import { assistantSourceDigest } from '../lib/ai/assistant-disclosure';
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
type CandidateRow = { id: string; owner_user_id: string; author_user_id: string; module_code: string; version: number;
  configuration: unknown; candidate_digest: string; baseline_digest: string; source_digest: string;
  engine_digest: string; policy_digest: string; input_digest: string };
function binding(row: CandidateRow) {
  const configuration = captureTypedRouteCandidate(row.configuration);
  return { ownerUserId: row.owner_user_id, authorUserId: row.author_user_id, module: row.module_code,
    version: row.version, configuration, baselineDigest: row.baseline_digest, sourceDigest: row.source_digest,
    engineDigest: row.engine_digest, policyDigest: row.policy_digest, inputDigest: row.input_digest };
}
function assertCurrent(row: CandidateRow) {
  if (row.module_code !== 'assistant' || row.source_digest !== MODULE_AGENT_SOURCE_DIGEST || row.engine_digest !== ROUTING_ENGINE_DIGEST ||
    row.policy_digest !== ROUTING_POLICY_DIGEST || row.input_digest !== ROUTING_INPUT_DIGEST ||
    row.candidate_digest !== routingDigest(binding(row))) return fail();
  return captureTypedRouteCandidate(row.configuration);
}
async function candidateTx(tx: Tx, ctx: SessionContext, id: string, validate = true) {
  if (!uuid(id)) return fail();
  const [row] = await tx.execute<CandidateRow>(sql`select id,owner_user_id,author_user_id,module_code,version,configuration,
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
      version, configuration, candidate_digest: '', baseline_digest: baselineDigest, source_digest: MODULE_AGENT_SOURCE_DIGEST,
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
      if (candidate.author_user_id === current.userId) return fail();
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
    if(candidate.author_user_id===current.userId)return fail();
    const evaluations=Array.from(await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select id,evaluator_user_id,suite_digest,receipt
      from public.ai_agent_evaluation where tenant_id=${current.tenantId}::uuid and candidate_id=${candidate.id}::uuid order by evaluator_user_id`));
    const checked=evaluations.map(row=>verifiedEvaluation(row,candidate,current.tenantId));
    if(checked.length<2||checked.length>8||new Set(checked.map(row=>row.evaluatorId)).size!==checked.length)return fail();
    const [lock]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-release:' + current.tenantId + ':' + candidate.owner_user_id},0)) as owned`);
    if(lock?.owned!==true)return fail();
    const [prior]=await tx.execute<{present:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p where p.tenant_id=${current.tenantId}::uuid
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
/** Explicit metadata-writing job owner, not a read tool or provider admission. Whole job rolls back on failure. */
export async function runGovernedModuleReadPlan(ctx:SessionContext,proposed:unknown) {
  const current=capture(ctx),plan=captureTypedModulePlan(proposed);
  try{return await withTenant(current,async tx=>{
    const fresh=await guard(tx,current,false);
    const [promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;used_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.used_jobs,p.expires_at::text
      from public.ai_agent_promotion p where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.module_code='assistant'
      and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
      order by p.created_at desc,p.id desc limit 1 for update nowait`);
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
      const rows=[];for(const module of selected.modules)rows.push(await read.moduleWork(module));return rows;
    });
    if(activePromotion){const id=randomUUID(),receipt=seal('job',current.tenantId,id,{version:1,candidateDigest,
      promotionId:activePromotion.id,planDigest:routingDigest(plan),executedPlanDigest:routingDigest(selected),resultDigest:assistantSourceDigest(results)});
      await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,receipt)
        values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${activePromotion.id}::uuid,${receipt})`);}
    return {version:1 as const,candidateDigest,mode:activePromotion?'promoted':'baseline',results,effects:[]};
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
