import {ASSISTANT_PRIVATE_CONTRACT,resolvePrivateAssistantIntent,resolvePrivateAssistantProposal,capturePrivateAssistantTask,adjudicatePrivateAssistantReadPlan} from '../lib/ai/provider-assistant-policy';
import {assistantReadableModules} from './assistant-readable-modules';
import {ASSISTANT_CONVERSATION_LIMITS} from './assistant-clarification';
import type {ResolvedAiConfig,GenerateArgs} from '../lib/ai/types';
import {captureAssistantConversationCandidate,assistantConversationCandidateSystem,nextAssistantConversationArms,ASSISTANT_CONVERSATION_BASELINE,ASSISTANT_CONVERSATION_ENGINE_DIGEST,ASSISTANT_CONVERSATION_POLICY_DIGEST,compareAssistantConversationArms,scoreAssistantConversationTrial,type ConversationArm,type ConversationCaseResult,type AssistantConversationCandidate} from '../lib/ai/assistant-conversation-candidate';
import {ASSISTANT_CONVERSATION_HOLDOUTS,ASSISTANT_CONVERSATION_INPUT_DIGEST,ASSISTANT_CONVERSATION_SUITE_DIGEST} from '../lib/ai/assistant-conversation-holdouts';
import {executeAssistantConversationHoldout} from './assistant-conversation-harness';
import type {NativeOutcomeServerContext} from './assistant-actions/completed-outcome-readers';
import {captureNativeCandidateSignals,captureNativeCandidateSignalIds,type NativeCandidateSignal} from '../lib/ai/module-native-signals';
import {nominateOwnNativeOutcomeJobTx,readVerifiedNativeOutcomeAssociationTx,ownNativeCandidateSignalChoicesTx,bindNativeOutcomeJobRecheckTx} from './module-native-outcome-references';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
import {specialistFollowupCases} from '../lib/ai/module-specialist-followup-cases';
import {SpecialistCandidate,executeCanonicalSpecialist,specialistNativeContractDigest,SPECIALIST_ENGINE_DIGEST,SPECIALIST_POLICY_DIGEST,SPECIALIST_POLICY,type SpecialistAssessment,compactSpecialistWork} from '../lib/ai/module-specialists';
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
  routingDigest, ROUTING_CANONICAL_PLANS,type TypedRouteCandidate } from '../lib/ai/module-agent-routing';
import { assertAiPrincipalTx,isAiPrincipalCurrentTx } from './ai-principal';
import { assertMayUseAssistant } from './assistant-grant';
import { assertAiActionUnpausedTx } from './ai-governance';
import { resolveEntitlementsTx,assertModuleEnabled } from './entitlements';
import { withAssistantReadTx, withAssistantJobReadsTx,withAssistantAdmissionReadsTx, type AssistantReadSession,type CanonicalModuleRead,type InterpretedModuleRead } from './assistant-read-session';
import {captureMeasuredCases,compareMeasuredQuality} from '../lib/ai/paired-evaluation';
import { executeRoutingHoldout, type RoutingEvaluationReport } from './module-agent-evaluation-harness';
import { capturePromptPlanCandidate,adjudicatePromptReadPlan,promptCandidateSystem,PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT,PROMPT_SUITE_DIGEST,PROMPT_ENGINE_DIGEST,PROMPT_POLICY_DIGEST,PROMPT_INPUT_DIGEST,PROMPT_BASELINE } from '../lib/ai/module-agent-prompt-candidate';
import { resolveAiProviderSnapshotTx } from './ai-provider-snapshot';
import { governedAiConfig,withAiAdmissionCheck,withAiAdmissionLifecycle,bindStrictAiSpendRoot,preparePrivateAiTask } from './ai-governance';
import { executePromptHoldout,promptMeasuredComparison,type PromptHoldoutReport,type PromptCase } from './module-agent-prompt-harness';
import {draftInputDigest} from '../lib/ai/draft-input';
import {HUMAN_PLAN_HOLDOUTS,HUMAN_PLAN_SUITE_DIGEST,humanQuestionPrompt} from '../lib/ai/human-plan-holdouts';
import { generateDraft } from '../lib/ai';
import { assistantSourceDigest } from '../lib/ai/assistant-disclosure';
type AgentReadResult=Awaited<ReturnType<AssistantReadSession['moduleWork']>>;
const baselineDigest = routingDigest(['direct-module-order-v1', ROUTING_ENGINE_DIGEST]);
const conversationBaselineDigest=routingDigest(['main-answer-baseline-v1',ASSISTANT_CONVERSATION_BASELINE,ASSISTANT_CONVERSATION_ENGINE_DIGEST]);
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
type CandidateRow = { id: string; owner_user_id: string; author_user_id: string; module_code: string; version: number; kind:'typed_route_priority_v1'|'read_plan_prompt_v1'|'canonical_specialist_v1'|'assistant_answer_prompt_v1';
  configuration: unknown; candidate_digest: string; baseline_digest: string; source_digest: string;
  engine_digest: string; policy_digest: string; input_digest: string;signal_refs:unknown;signal_receipt:string|null;native_signal_refs?:unknown };
function binding(row: CandidateRow) {
  const configuration = row.kind==='assistant_answer_prompt_v1'?captureAssistantConversationCandidate(row.configuration):row.kind==='canonical_specialist_v1'?SpecialistCandidate.parse(row.configuration):row.kind==='read_plan_prompt_v1'?capturePromptPlanCandidate(row.configuration):captureTypedRouteCandidate(row.configuration);
  return { ownerUserId: row.owner_user_id, authorUserId: row.author_user_id, module: row.module_code,
    version: row.version, configuration, baselineDigest: row.baseline_digest, sourceDigest: row.source_digest,
    engineDigest: row.engine_digest, policyDigest: row.policy_digest, inputDigest: row.input_digest,signalDigest:routingDigest(captureSignalRefs(row.signal_refs)),...(captureNativeCandidateSignals(row.native_signal_refs).length?{nativeSignalDigest:routingDigest(captureNativeCandidateSignals(row.native_signal_refs))}:{}) };
}
function assertCurrent(row: CandidateRow) {
 if(row.kind==='assistant_answer_prompt_v1'){const configuration=captureAssistantConversationCandidate(row.configuration);if(row.module_code!=='assistant'||row.source_digest!==MODULE_AGENT_SOURCE_DIGEST||row.engine_digest!==ASSISTANT_CONVERSATION_ENGINE_DIGEST||row.policy_digest!==ASSISTANT_CONVERSATION_POLICY_DIGEST||row.input_digest!==ASSISTANT_CONVERSATION_INPUT_DIGEST||row.baseline_digest!==conversationBaselineDigest||row.candidate_digest!==routingDigest(binding(row)))return fail();return configuration;}
  if(row.kind==='canonical_specialist_v1'){const configuration=SpecialistCandidate.parse(row.configuration);if(row.module_code!==configuration.module||row.source_digest!==MODULE_AGENT_SOURCE_DIGEST||row.engine_digest!==specialistModuleEngineDigest(configuration.module)||row.policy_digest!==SPECIALIST_POLICY_DIGEST||row.input_digest!==specialistInputDigest(configuration.module)||row.baseline_digest!==specialistBaselineDigest(configuration.module)||row.candidate_digest!==routingDigest(binding(row)))return fail();return configuration;}
 const prompt=row.kind==='read_plan_prompt_v1';
  const configuration=prompt?capturePromptPlanCandidate(row.configuration):captureTypedRouteCandidate(row.configuration);
  if (row.module_code !== 'assistant' || configuration.kind!==row.kind || row.source_digest !== MODULE_AGENT_SOURCE_DIGEST ||
    row.engine_digest !== (prompt?PROMPT_ENGINE_DIGEST:ROUTING_ENGINE_DIGEST) ||
    row.baseline_digest!==(prompt?routingDigest(['paired-prompt-baseline-v1',PROMPT_BASELINE,PROMPT_ENGINE_DIGEST]):baselineDigest)||row.policy_digest !== (prompt?PROMPT_POLICY_DIGEST:ROUTING_POLICY_DIGEST) || row.input_digest !== (prompt?PROMPT_INPUT_DIGEST:ROUTING_INPUT_DIGEST) ||
    row.candidate_digest !== routingDigest(binding(row))) return fail();
  return configuration;
}
async function candidateTx(tx: Tx, ctx: SessionContext, id: string, validate = true, deferNativeCustody = false) {
  if (!uuid(id)) return fail();
  const [row] = await tx.execute<CandidateRow>(sql`select c.id,c.owner_user_id,c.author_user_id,c.module_code,c.version,c.kind,c.configuration,
    c.candidate_digest,c.baseline_digest,c.source_digest,c.engine_digest,c.policy_digest,c.input_digest,p.refs as signal_refs,p.receipt as signal_receipt,p.native_refs as native_signal_refs from public.ai_agent_candidate c
    left join public.ai_agent_candidate_provenance p on p.candidate_id=c.id and p.tenant_id=c.tenant_id
    where c.id=${id}::uuid and c.tenant_id=${ctx.tenantId}::uuid`);
  if (!row) return fail(); if (validate){assertCurrent(row);await assertCandidateSignalsTx(tx,ctx,row,deferNativeCustody);} return row;
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
async function assertCandidateSignalsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow,deferNativeCustody=false){
 await signalIntervalTx(tx,ctx,candidate.owner_user_id);const refs=captureSignalRefs(candidate.signal_refs),nativeRefs=captureNativeCandidateSignals(candidate.native_signal_refs);
 if(!candidate.signal_receipt)return fail();const proof=open('candidate-signals',ctx.tenantId,candidate.id,candidate.signal_receipt);
 if(!exact(proof,['version','candidateDigest','ownerId','sourceDigest','refs',...(nativeRefs.length?['nativeRefs']:[])])||proof.version!==(nativeRefs.length?2:1)||proof.candidateDigest!==candidate.candidate_digest||proof.ownerId!==candidate.owner_user_id||
  proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||routingDigest(captureSignalRefs(proof.refs))!==routingDigest(refs)||routingDigest(captureNativeCandidateSignals(proof.nativeRefs))!==routingDigest(nativeRefs))return fail();
 const [current]=await tx.execute<{allowed:boolean}>(sql`select app.agent_candidate_signals_current(${candidate.id}::uuid) as allowed`);if(current?.allowed!==true)return fail();
 if(nativeRefs.length&&!deferNativeCustody){
  // A competing erasure/retention interval is transient busy, not evidence of source retirement.
  // Match the trigger's canonical UUID key and propagate the existing busy classification.
  const [ownership]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended('native-outcome:v1:'||(${ctx.tenantId}::uuid)::text||':'||(${candidate.owner_user_id}::uuid)::text,0)) as owned`);
  if(ownership?.owned!==true)throw new AgentSignalBusy('Agent review could not be confirmed.');
  const [native]=await tx.execute<{allowed:boolean}>(sql`select app.agent_candidate_native_signals_current(${candidate.id}::uuid) as allowed`);if(native?.allowed!==true)return fail();
 }
 return refs.length+nativeRefs.length;
}
async function persistCandidateSignalsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow){
 const refs=captureSignalRefs(candidate.signal_refs),nativeRefs=captureNativeCandidateSignals(candidate.native_signal_refs),receipt=seal('candidate-signals',ctx.tenantId,candidate.id,{version:nativeRefs.length?2:1,candidateDigest:candidate.candidate_digest,ownerId:candidate.owner_user_id,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,refs,...(nativeRefs.length?{nativeRefs}:{})});
 await tx.execute(sql`insert into public.ai_agent_candidate_provenance(candidate_id,tenant_id,owner_user_id,refs,native_refs,receipt)
  values(${candidate.id}::uuid,${ctx.tenantId}::uuid,${candidate.owner_user_id}::uuid,${JSON.stringify(refs)}::jsonb,${JSON.stringify(nativeRefs)}::jsonb,${receipt})`);
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

/** Human-selected canonical completion is a historical hypothesis input, not an evaluator rating.
 * Native job provenance takes release/signals before the canonical owner, then append/delete
 * association custody. One source per candidate prevents late cross-subject lock acquisition. */
async function ownNativeCandidateSignalsTx(tx:Tx,ctx:SessionContext,ids:readonly string[],module?:AgentModuleCode,server:NativeOutcomeServerContext={}):Promise<readonly NativeCandidateSignal[]>{
 if(!ids.length)return Object.freeze([]);
 await boundNativeOutcomeTransactionTx(tx);
 const jobId=await nominateOwnNativeOutcomeJobTx(tx,ctx,ids[0]);
 const provenance=await beginOwnNativeOutcomeJobProvenanceTx(tx,ctx,jobId);
 const proof=await readVerifiedNativeOutcomeAssociationTx(tx,ctx,ids[0],provenance,server);
 const refs=captureNativeCandidateSignals([proof.reference]);if(module&&refs[0].module!==module)return fail();return refs;
}

export async function createRoutingAgentCandidate(ctx: SessionContext, input: { version: number; configuration: unknown;signalIds?:readonly string[];nativeSignalIds?:readonly string[] },server:NativeOutcomeServerContext={}) {
  const current = capture(ctx), configuration = captureTypedRouteCandidate(input.configuration), version = input.version,signalIds=captureSignalIds(input.signalIds),nativeSignalIds=captureNativeCandidateSignalIds(input.nativeSignalIds),capability=Object.freeze({notificationIdentity:server.notificationIdentity});
  if (!exact(input, ['version','configuration',...(input.signalIds===undefined?[]:['signalIds']),...(input.nativeSignalIds===undefined?[]:['nativeSignalIds'])]) || !Number.isSafeInteger(version) || version < 1) return fail();
  try { return await withTenant(current, async tx => {
    if(nativeSignalIds.length)await boundNativeOutcomeTransactionTx(tx);await guard(tx, current, true);
    const id = randomUUID(),native_signal_refs=await ownNativeCandidateSignalsTx(tx,current,nativeSignalIds,undefined,capability),signal_refs=await ownSignalRefsTx(tx,current,signalIds);
    const row: CandidateRow = { id, owner_user_id: current.userId!, author_user_id: current.userId!, module_code: 'assistant',
      version, kind:'typed_route_priority_v1', configuration, candidate_digest: '', baseline_digest: baselineDigest, source_digest: MODULE_AGENT_SOURCE_DIGEST,
      engine_digest: ROUTING_ENGINE_DIGEST, policy_digest: ROUTING_POLICY_DIGEST, input_digest: ROUTING_INPUT_DIGEST,signal_refs,signal_receipt:null,native_signal_refs };
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
        qualityFailures:proof.report.qualityFailures,comparison:proof.report.comparison,state:proof.report.securityFailures===0&&proof.report.qualityFailures===0?'passed-contract':'failed-contract' };
    });
  } catch { return fail(); }
}
function verifiedEvaluation(row: { id: string; evaluator_user_id: string; suite_digest: string; receipt: string }, candidate: CandidateRow, tenant: string) {
  const proof = open('evaluation',tenant,row.id,row.receipt);
  if (!exact(proof,['version','candidateDigest','binding','evaluatorId','report']) || proof.version!==1 ||
    proof.candidateDigest!==candidate.candidate_digest || routingDigest(proof.binding)!==routingDigest(binding(candidate)) ||
    proof.evaluatorId!==row.evaluator_user_id || row.evaluator_user_id===candidate.author_user_id || row.suite_digest!==ROUTING_SUITE_DIGEST) return fail();
  const report = proof.report as RoutingEvaluationReport;
  if (!report || !exact(report,['version','suiteDigest','inputDigest','coverage','securityFailures','qualityFailures','cases','ownSubjects','observedDigest','baseline','candidate','comparison'])||report.version!==2 || report.suiteDigest!==ROUTING_SUITE_DIGEST || report.inputDigest!==ROUTING_INPUT_DIGEST ||
    report.coverage!=='typed-routing-contract-only' || report.securityFailures!==0 || report.qualityFailures!==0 || report.ownSubjects<1 ||
    !Array.isArray(report.cases) || report.cases.length!==27 || report.cases.some(row=>!exact(row,['id','passed'])||row.passed!==true)||new Set(report.cases.map(row=>row.id)).size!==27) return fail();
  const expectedCases=[...Array.from({length:8},(_,index)=>'heldout-order-'+index),...Array.from({length:8},(_,index)=>'heldout-set-'+index),...Array.from({length:9},(_,index)=>'security-invalid-plan-'+index),'actual-canonical-data-preserved','nonempty-authorized-own-fixture'];
  if(routingDigest(report.cases.map(row=>row.id).sort())!==routingDigest(expectedCases.sort()))return fail();
  const ids=ROUTING_CANONICAL_PLANS.map((_,index)=>'canonical-'+index),baseline=captureMeasuredCases(report.baseline,ids),changed=captureMeasuredCases(report.candidate,ids),comparison=compareMeasuredQuality(baseline,changed,ids.length);
  if(routingDigest(comparison)!==routingDigest(report.comparison)||!comparison.qualityImproved||baseline.some((row,index)=>row.readCount!==ROUTING_CANONICAL_PLANS[index].length||row.tokens!==0||row.costCredits!==0)||changed.some((row,index)=>row.readCount!==ROUTING_CANONICAL_PLANS[index].length||row.tokens!==0||row.costCredits!==0))return fail();
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
export async function rollbackAssistantPromotion(ctx:SessionContext,input:{promotionId:string;reason:'human'|'security_regression'|'quality_regression'}) {
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
 // Stable encryption domain; strict v3 body deliberately refuses legacy unassessed v2 jobs.
 const proof=open('governed-job-v2',ctx.tenantId,row.id,row.receipt),selections=captureSpecialistSelections(proof.specialists);
 if(!exact(proof,['version','jobKind','stage','tenantId','userId','commandNonce','mode','candidateDigest','promotionId','sourceDigest','engineDigest','policyDigest','requestedPlan','executedPlan','requestedPlanDigest','executedPlanDigest','resultDigest','createdAt','expiresAt','elapsedMs','specialists',...(proof.planning===undefined?[]:['planning'])])||
  proof.version!==3||!['module_plan','specialist','tool_batch'].includes(String(proof.jobKind))||proof.stage!=='completed'||proof.tenantId!==ctx.tenantId||proof.userId!==ctx.userId||proof.commandNonce!==row.request_nonce||proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||
  proof.engineDigest!==(proof.jobKind==='specialist'?specialistModuleEngineDigest(selections[0].binding.configuration.module):ROUTING_ENGINE_DIGEST)||proof.policyDigest!==(proof.jobKind==='specialist'?SPECIALIST_POLICY_DIGEST:ROUTING_POLICY_DIGEST)||
  proof.promotionId!==row.promotion_id||(proof.mode!=='baseline'&&proof.mode!=='promoted')||(proof.mode==='promoted')!==Boolean(row.promotion_id)||typeof proof.candidateDigest!=='string'||!/^[a-f0-9]{64}$/.test(proof.candidateDigest)||
  typeof proof.resultDigest!=='string'||!/^[a-f0-9]{64}$/.test(proof.resultDigest)||!Number.isSafeInteger(proof.elapsedMs)||Number(proof.elapsedMs)<0||new Date(String(proof.createdAt)).getTime()!==new Date(row.created_at).getTime()||new Date(String(proof.expiresAt)).getTime()!==new Date(row.expires_at).getTime())return fail();
 const requested=captureTypedModulePlan(proof.requestedPlan),executed=captureTypedModulePlan(proof.executedPlan),planning=proof.planning===undefined?undefined:capturePlanningBinding(proof.planning);
 if(routingDigest(requested)!==row.requested_plan_digest||proof.requestedPlanDigest!==row.requested_plan_digest||routingDigest(executed)!==proof.executedPlanDigest||[...requested.modules].sort().join(',')!==[...executed.modules].sort().join(',')||routingDigest(selections.map(item=>item.binding.configuration.module))!==routingDigest(executed.modules)||new Date(row.expires_at).getTime()-new Date(row.created_at).getTime()>GOVERNED_JOB_RETENTION_DAYS*86400000)return fail();
 if(proof.jobKind==='specialist'&&(planning||selections.length!==1||proof.mode!==selections[0].mode||proof.candidateDigest!==selections[0].candidateDigest||row.promotion_id!==selections[0].promotionId))return fail();
 if(proof.jobKind==='tool_batch'&&(planning||proof.mode!=='baseline'||proof.candidateDigest!==baselineDigest))return fail();
 return{requested,executed,mode:proof.mode as 'baseline'|'promoted',candidateDigest:proof.candidateDigest,resultDigest:proof.resultDigest,planning,jobKind:proof.jobKind as 'module_plan'|'specialist'|'tool_batch',specialists:selections,specialist:proof.jobKind==='specialist'?selections[0].binding:undefined};
}
async function assertGovernedJobCandidateTx(tx:Tx,ctx:SessionContext,job:GovernedJobRow,completed:ReturnType<typeof verifiedGovernedJob>,deferNativeCustody=false){
 if(completed.planning)await currentPlanningBindingTx(tx,ctx,completed.planning,deferNativeCustody);
 if(job.promotion_id&&completed.jobKind==='module_plan'){const[promotion]=await tx.execute<{candidate_id:string}>(sql`select candidate_id from public.ai_agent_promotion where id=${job.promotion_id}::uuid and tenant_id=${ctx.tenantId}::uuid and owner_user_id=${ctx.userId}::uuid`);if(!promotion)return fail();const candidate=await candidateTx(tx,ctx,promotion.candidate_id,true,deferNativeCustody);if(candidate.kind!=='typed_route_priority_v1'||candidate.candidate_digest!==completed.candidateDigest)return fail();}
 for(const selection of completed.specialists){if(selection.mode==='baseline')continue;const[promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;expires_at:string}>(sql`select id,candidate_id,receipt,max_jobs,expires_at::text from public.ai_agent_promotion where id=${selection.promotionId}::uuid and tenant_id=${ctx.tenantId}::uuid and owner_user_id=${ctx.userId}::uuid and module_code=${selection.binding.configuration.module}`);if(!promotion)return fail();const candidate=await candidateTx(tx,ctx,promotion.candidate_id,true,deferNativeCustody);checkedSpecialistPromotion(candidate,promotion,ctx.tenantId);if(candidate.kind!=='canonical_specialist_v1'||candidate.version!==selection.version||candidate.candidate_digest!==selection.candidateDigest||routingDigest(candidate.configuration)!==routingDigest(selection.binding.configuration))return fail();}
}
/** Historical command provenance for a distinct human-linked native outcome. This is neither
 * feedback truth nor new promoted-run admission. A native action may intentionally change read
 * facts: do not apply the opinion writer's unchanged-result test here. Call BEFORE native source
 * intervals, preserving Access -> release -> signals -> canonical source -> association order.
 * Any refusal requires the whole caller transaction to roll back; no savepoint continuation. */
export async function beginOwnNativeOutcomeJobProvenanceTx(tx:Tx,supplied:SessionContext,jobId:string):Promise<Readonly<{jobId:string;modules:readonly AgentModuleCode[];jobReceiptDigest:string;candidateDigest:string;sourceDigest:string;expiresAt:string}>>{
 const current=capture(supplied),id=jobId;
 if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return fail();
 const fresh=await guard(tx,current,false);if(!current.userId)return fail();
 await agentReleaseIntervalTx(tx,current,current.userId,false);await signalIntervalTx(tx,current,current.userId);
 const rows=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where id=${id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);
 if(rows.length!==1)return fail();const job=rows[0],completed=verifiedGovernedJob(job,current);await assertGovernedJobCandidateTx(tx,current,job,completed,true);
 for(const module of completed.executed.modules)assertModuleEnabled(fresh,module);
 return bindNativeOutcomeJobRecheckTx(tx,current,{jobId:job.id,modules:Object.freeze([...completed.executed.modules]),jobReceiptDigest:rawReceiptDigest(job.receipt),candidateDigest:completed.candidateDigest,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,expiresAt:job.expires_at!},async()=>{await assertGovernedJobCandidateTx(tx,current,job,completed);});
}
/** Human opinion only, independently tied to an actual completed command and unchanged current facts. */
export async function recordOwnGovernedJobFeedback(ctx:SessionContext,input:{jobId:string;outcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number];consented:true}){
 const current=capture(ctx),p={jobId:input.jobId,outcome:input.outcome,consented:input.consented};
 if(!exact(input,['jobId','outcome','consented'])||!uuid(p.jobId)||!GOVERNED_JOB_FEEDBACK_OUTCOMES.includes(p.outcome)||p.consented!==true)return fail();
 try{return await withTenant(current,async tx=>{const fresh=await guard(tx,current,false);await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!,true);
  const [job]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where id=${p.jobId}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);if(!job)return fail();
  const completed=verifiedGovernedJob(job,current);await assertGovernedJobCandidateTx(tx,current,job,completed,true);
  const results=await withAssistantJobReadsTx(fresh,tx,async read=>{const rows:AgentReadResult[]=[];for(const module of completed.executed.modules)rows.push(await read.moduleWork(module));return rows;});
  await assertGovernedJobCandidateTx(tx,current,job,completed);if(assistantSourceDigest(results)!==completed.resultDigest)return fail();for(const selection of completed.specialists){const result=results.find(row=>row.module===selection.binding.configuration.module);if(!result||routingDigest(executeCanonicalSpecialist(selection.binding.configuration,result))!==selection.binding.assessmentDigest)return fail();}
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
export async function reopenGovernedModuleReadJobTx(tx:Tx,ctx:SessionContext,id:string){return reopenGovernedReadSourceTx(tx,ctx,id,true);}
async function reopenGovernedReadSourceTx(tx:Tx,ctx:SessionContext,id:string,requireReadonly:boolean,onlyModule?:AgentModuleCode){
 const current=capture(ctx);if(!uuid(id))return fail();await boundNativeOutcomeTransactionTx(tx);
 const [mode]=await tx.execute<{readonly:string}>(sql`select current_setting('transaction_read_only') as readonly`);if(!mode||requireReadonly&&mode.readonly!=='on'||!['on','off'].includes(mode.readonly))return fail();
 const fresh=await guard(tx,current,false);await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!);
 const[row]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where id=${id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid`);if(!row)return fail();
 const proof=verifiedGovernedJob(row,current);if(onlyModule&&!proof.executed.modules.includes(onlyModule))return fail();await assertGovernedJobCandidateTx(tx,current,row,proof,true);
 const modules=onlyModule?[onlyModule]:proof.executed.modules;
 const consume=async(read:AssistantReadSession)=>{const rows:AgentReadResult[]=[];for(const module of modules)rows.push(await read.moduleWork(module));return rows;};
 const results=mode.readonly==='on'?await withAssistantReadTx(fresh,tx,consume):await withAssistantAdmissionReadsTx(fresh,tx,consume);
 await assertGovernedJobCandidateTx(tx,current,row,proof);
 const specialists=await currentSpecialistAssessmentsTx(tx,current,{...proof,specialists:proof.specialists.filter(item=>modules.includes(item.binding.configuration.module))},results);
 const[feedback]=await tx.execute<{id:string;outcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number]}>(sql`select id,outcome from public.ai_agent_job_feedback where job_id=${row.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and expires_at>now()`);
 let feedbackOutcome:typeof GOVERNED_JOB_FEEDBACK_OUTCOMES[number]|null=null;if(feedback){try{await ownSignalRefsTx(tx,current,[feedback.id]);feedbackOutcome=feedback.outcome;}catch(error){if(error instanceof AgentSignalBusy||!(error instanceof AiGatewayError)&&!(error instanceof Error&&error.name==='ZodError'))throw error;}}
 return{jobId:row.id,jobKind:proof.jobKind,mode:proof.jobKind==='specialist'?specialists[0].work.mode:proof.mode,changedSinceRun:assistantSourceDigest(results)!==proof.resultDigest,results,specialists,feedbackOutcome,...(proof.specialist?{specialist:specialists[0].assessment}:{})};
}
/** Recheck an already admitted chat batch in the actual read/admission carrier. No job/permit is
 * created or incremented. The opaque job reference is sealed source evidence, never model input. */
export async function readGovernedSpecialistToolResultTx(tx:Tx,ctx:SessionContext,jobId:string,module:AgentModuleCode){
 if(!isAgentModuleCode(module))return fail();const current=await reopenGovernedReadSourceTx(tx,ctx,jobId,false,module);if(current.jobKind!=='tool_batch')return fail();const row=current.results.find(row=>row.module===module),specialist=current.specialists.find(row=>row.module===module);if(!row||!specialist)return fail();return{outcome:{ok:true as const,...row,specialistWork:specialist.work},assessment:specialist.assessment};
}
/** Explicit metadata-writing job owner, not a read tool or provider admission. Whole job rolls back on failure.
 * Every command caller supplies a retained nonce; no read or retry path invents a new command identity.
 */
export async function runGovernedModuleReadPlan(ctx:SessionContext,proposed:unknown,command:{nonce:string;proposalId?:string}) {return runGovernedReadJob(ctx,proposed,command,'module_plan');}
async function runGovernedReadJob(ctx:SessionContext,proposed:unknown,command:{nonce:string;proposalId?:string},kind:'module_plan'|'specialist') {
  const current=capture(ctx),plan=captureTypedModulePlan(proposed),nonce=command?.nonce,proposalId=command?.proposalId,started=Date.now();
  if(!command||typeof nonce!=='string'||!uuid(nonce)||!exact(command,proposalId===undefined?['nonce']:['nonce','proposalId'])||(proposalId!==undefined&&!uuid(proposalId)))return fail();
  try{return await withTenant(current,async tx=>{
    await boundNativeOutcomeTransactionTx(tx);const fresh=await guard(tx,current,false);await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!);
    const [owned]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-job:'+current.tenantId+':'+current.userId+':'+nonce},0)) as owned`);if(owned?.owned!==true)return fail();
    const reviewed=proposalId?await checkedOwnPlanProposalTx(tx,current,proposalId,plan,true):null;
    const [existing]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt
     where tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and request_nonce=${nonce}::uuid`);
    if(existing){const proof=verifiedGovernedJob(existing,current);if(proof.jobKind!==kind)return fail();if((reviewed?.row.consumed_job_id??null)!==(proposalId?existing.id:null)||proof.planning?.proposalId!==(proposalId??undefined))return fail();if(routingDigest(plan)!==routingDigest(proof.requested))return fail();await assertGovernedJobCandidateTx(tx,current,existing,proof,true);
     for(const module of proof.executed.modules)assertModuleEnabled(fresh,module);
     const results=await withAssistantJobReadsTx(fresh,tx,async read=>{const rows:AgentReadResult[]=[];for(const module of proof.executed.modules)rows.push(await read.moduleWork(module));return rows;});
     await assertGovernedJobCandidateTx(tx,current,existing,proof);const specialists=await currentSpecialistAssessmentsTx(tx,current,proof,results);
     return {version:1 as const,jobId:existing.id,candidateDigest:proof.candidateDigest,mode:kind==='specialist'?specialists[0].work.mode:proof.mode,results,specialists,...(kind==='specialist'?{specialist:specialists[0].assessment}:{}),effects:[],replayed:true};}
    if(reviewed?.row.consumed_job_id)return fail();
    const [promotion]=kind==='module_plan'?await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;used_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.used_jobs,p.expires_at::text
      from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='typed_route_priority_v1' where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${current.userId}::uuid and p.module_code='assistant'
      and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
      order by p.created_at desc,p.id desc limit 1 for update of p nowait`):[];
    let selected=plan,candidateDigest=baselineDigest;let activePromotion:typeof promotion|undefined=promotion;
    if(promotion){const candidate=await candidateTx(tx,current,promotion.candidate_id,false);
      let currentSource=true;try{assertCurrent(candidate);await assertCandidateSignalsTx(tx,current,candidate,true);}catch(error){if(error instanceof AgentSignalBusy||!(error instanceof AiGatewayError)&&!(error instanceof Error&&error.name==='ZodError'))throw error;currentSource=false;}
      if(!currentSource){
        await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason)
          values(${current.tenantId}::uuid,${promotion.id}::uuid,${current.userId}::uuid,'source_changed') on conflict(promotion_id) do nothing`);
        activePromotion=undefined;
      }
    }
    if(activePromotion){const candidate=await candidateTx(tx,current,activePromotion.candidate_id,true,true);const proof=open('promotion',current.tenantId,activePromotion.id,activePromotion.receipt);
      if(proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||
        proof.maxJobs!==activePromotion.max_jobs||new Date(String(proof.expiresAt)).getTime()!==new Date(activePromotion.expires_at).getTime())return fail();
      selected=applyTypedRouteCandidate(candidate.configuration,plan);candidateDigest=candidate.candidate_digest;
      await tx.execute(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${activePromotion.id}::uuid and tenant_id=${current.tenantId}::uuid`);
    }
    const admissions:SpecialistAdmission[]=[];for(const module of [...selected.modules].sort()){assertModuleEnabled(fresh,module);admissions.push(await nominateSpecialistTx(tx,current,module));}
    const results=await withAssistantJobReadsTx(fresh,tx,async read=>{
      const rows:AgentReadResult[]=[];for(const module of selected.modules)rows.push(await read.moduleWork(module));return rows;
    });
    const completed=await completeSpecialistsTx(tx,current,admissions,results),specialists=selected.modules.map(module=>completed.find(row=>row.selection.binding.configuration.module===module)!);
    if(activePromotion)await assertCandidateSignalsTx(tx,current,await candidateTx(tx,current,activePromotion.candidate_id,false));
    if(reviewed)await currentPlanningBindingTx(tx,current,reviewed.binding);
    const id=randomUUID();const [clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,(now()+make_interval(secs=>${GOVERNED_JOB_RETENTION_DAYS*86400}))::text as expires`);
    const mode=kind==='specialist'?specialists[0].selection.mode:activePromotion?'promoted' as const:'baseline' as const;
    if(kind==='specialist')candidateDigest=specialists[0].selection.candidateDigest;const promotionId=kind==='specialist'?specialists[0].selection.promotionId:activePromotion?.id??null;
    const receipt=seal('governed-job-v2',current.tenantId,id,{version:3,jobKind:kind,stage:'completed',tenantId:current.tenantId,userId:current.userId,commandNonce:nonce,
     mode,candidateDigest,promotionId,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,engineDigest:kind==='specialist'?specialistModuleEngineDigest(selected.modules[0]):ROUTING_ENGINE_DIGEST,policyDigest:kind==='specialist'?SPECIALIST_POLICY_DIGEST:ROUTING_POLICY_DIGEST,specialists:specialists.map(row=>row.selection),
     requestedPlan:plan,executedPlan:selected,requestedPlanDigest:routingDigest(plan),executedPlanDigest:routingDigest(selected),resultDigest:assistantSourceDigest(results),
     createdAt:clock.now,expiresAt:clock.expires,elapsedMs:Math.max(0,Date.now()-started),...(reviewed?{planning:reviewed.binding}:{})});
    await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,request_nonce,requested_plan_digest,expires_at,receipt)
      values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${promotionId}::uuid,${nonce}::uuid,${routingDigest(plan)},${clock.expires}::timestamptz,${receipt})`);
    if(reviewed){const linked=await tx.execute<{id:string}>(sql`update public.ai_agent_plan_proposal set consumed_job_id=${id}::uuid where id=${reviewed.row.id}::uuid and tenant_id=${current.tenantId}::uuid and user_id=${current.userId}::uuid and consumed_job_id is null returning id`);if(linked.length!==1||linked[0].id!==reviewed.row.id)return fail();}
    return {version:1 as const,jobId:id,candidateDigest,mode,results,specialists:specialists.map(row=>({module:row.assessment.module,assessment:row.assessment,work:compactSpecialistWork(row.assessment,{mode:row.selection.mode,version:row.selection.version,configuration:row.selection.binding.configuration})})),...(kind==='specialist'?{specialist:specialists[0].assessment}:{}),effects:[],replayed:false};
  });}catch{return fail();}
}

/** Source-owned POST tool batch. Preselected module metadata is complete and ordered before
 * source reads; the tool registry receives no Tx, query, promotion command or caller-supplied facts.
 * Repeating the SAME server-issued batch nonce rechecks facts without spending another permit. */
export async function withGovernedSpecialistReadBatch<T>(supplied:SessionContext,proposed:unknown,command:{nonce:string},consume:(read:AssistantReadSession)=>Promise<T>){
 const ctx=capture(supplied),plan=captureTypedModulePlan(proposed),nonce=command?.nonce,started=Date.now();if(!command||!exact(command,['nonce'])||!uuid(nonce))return fail();
 return withTenant(ctx,async tx=>{
  await boundNativeOutcomeTransactionTx(tx);const fresh=await guard(tx,ctx,false);await agentReleaseIntervalTx(tx,ctx,ctx.userId!,false);await signalIntervalTx(tx,ctx,ctx.userId!);
  const[lock]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'agent-job:'+ctx.tenantId+':'+ctx.userId+':'+nonce},0)) as owned`);if(lock?.owned!==true)return fail();
  const[old]=await tx.execute<GovernedJobRow>(sql`select ${jobProjection} from public.ai_agent_job_receipt where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and request_nonce=${nonce}::uuid`);
  const prior=old?verifiedGovernedJob(old,ctx):null;if(prior&&(prior.jobKind!=='tool_batch'||routingDigest(prior.requested)!==routingDigest(plan)))return fail();if(old&&prior)await assertGovernedJobCandidateTx(tx,ctx,old,prior,true);
  const admissions:SpecialistAdmission[]=[];
  for(const module of [...plan.modules].sort()){
   assertModuleEnabled(fresh,module);if(!prior){admissions.push(await nominateSpecialistTx(tx,ctx,module));continue;}
   const selection=prior.specialists.find(row=>row.binding.configuration.module===module)!;let candidate:CandidateRow|null=null,promotion:SpecialistAdmission['promotion']=null;
   if(selection.mode==='promoted'){
    const[row]=await tx.execute<NonNullable<SpecialistAdmission['promotion']>>(sql`select id,candidate_id,receipt,max_jobs,expires_at::text from public.ai_agent_promotion p where p.id=${selection.promotionId}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.owner_user_id=${ctx.userId}::uuid and p.module_code=${module} and p.expires_at>now() and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id)`);
    if(row){promotion=row;candidate=await candidateTx(tx,ctx,row.candidate_id,true,true);checkedSpecialistPromotion(candidate,row,ctx.tenantId);}
   }
   admissions.push({module,candidate,promotion});
  }
  const sources=new Map<AgentModuleCode,Promise<AgentReadResult>>(),works=new Map<AgentModuleCode,Promise<InterpretedModuleRead>>();
  const interpret=async(module:AgentModuleCode,canonical:()=>Promise<CanonicalModuleRead>)=>{
   const admission=admissions.find(row=>row.module===module);if(!admission)return fail();let work=works.get(module);if(!work){work=(async()=>{
    const result=await canonical();sources.set(module,Promise.resolve(result));
    const assessment=prior?executeCanonicalSpecialist(admission.candidate?SpecialistCandidate.parse(admission.candidate.configuration):baselineConfiguration(module),result):await assessSpecialistTx(tx,ctx,admission,result);
    return{...result,specialistWork:compactSpecialistWork(assessment,{mode:admission.candidate?'promoted':'baseline',version:admission.candidate?.version??0,configuration:admission.candidate?SpecialistCandidate.parse(admission.candidate.configuration):baselineConfiguration(module)})};
   })();works.set(module,work);}return work;
  };
  const value=await withAssistantJobReadsTx(fresh,tx,consume,interpret);
  if(sources.size!==plan.modules.length)return fail();const results:AgentReadResult[]=[];for(const module of plan.modules)results.push(await sources.get(module)!);
  if(old&&prior){await assertGovernedJobCandidateTx(tx,ctx,old,prior);return{jobId:old.id,value,replayed:true};}
  const completed=await completeSpecialistsTx(tx,ctx,admissions,results),selections=plan.modules.map(module=>completed.find(row=>row.selection.binding.configuration.module===module)!.selection);
  const id=randomUUID(),[clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,(now()+make_interval(secs=>${GOVERNED_JOB_RETENTION_DAYS*86400}))::text as expires`);
  const receipt=seal('governed-job-v2',ctx.tenantId,id,{version:3,jobKind:'tool_batch',stage:'completed',tenantId:ctx.tenantId,userId:ctx.userId,commandNonce:nonce,mode:'baseline',candidateDigest:baselineDigest,promotionId:null,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,engineDigest:ROUTING_ENGINE_DIGEST,policyDigest:ROUTING_POLICY_DIGEST,requestedPlan:plan,executedPlan:plan,requestedPlanDigest:routingDigest(plan),executedPlanDigest:routingDigest(plan),resultDigest:assistantSourceDigest(results),createdAt:clock.now,expiresAt:clock.expires,elapsedMs:Math.max(0,Date.now()-started),specialists:selections});
  await tx.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,request_nonce,requested_plan_digest,expires_at,receipt) values(${id}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,null,${nonce}::uuid,${routingDigest(plan)},${clock.expires}::timestamptz,${receipt})`);
  return{jobId:id,value,replayed:false};
 });
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
export async function createPromptAgentCandidate(ctx:SessionContext,input:{version:number;configuration:unknown;signalIds?:readonly string[];nativeSignalIds?:readonly string[]},server:NativeOutcomeServerContext={}){
 const current=capture(ctx),configuration=capturePromptPlanCandidate(input.configuration),version=input.version,signalIds=captureSignalIds(input.signalIds),nativeSignalIds=captureNativeCandidateSignalIds(input.nativeSignalIds),capability=Object.freeze({notificationIdentity:server.notificationIdentity});
 if(!exact(input,['version','configuration',...(input.signalIds===undefined?[]:['signalIds']),...(input.nativeSignalIds===undefined?[]:['nativeSignalIds'])])||!Number.isSafeInteger(version)||version<1)return fail();
 try{return await withTenant(current,async tx=>{
  if(nativeSignalIds.length)await boundNativeOutcomeTransactionTx(tx);await guard(tx,current,true);const id=randomUUID(),base=routingDigest(['paired-prompt-baseline-v1',PROMPT_BASELINE,PROMPT_ENGINE_DIGEST]);
  const native_signal_refs=await ownNativeCandidateSignalsTx(tx,current,nativeSignalIds,undefined,capability),signal_refs=await ownSignalRefsTx(tx,current,signalIds);
  const row:CandidateRow={id,owner_user_id:current.userId!,author_user_id:current.userId!,module_code:'assistant',kind:'read_plan_prompt_v1',
   version,configuration,candidate_digest:'',baseline_digest:base,source_digest:MODULE_AGENT_SOURCE_DIGEST,
   engine_digest:PROMPT_ENGINE_DIGEST,policy_digest:PROMPT_POLICY_DIGEST,input_digest:PROMPT_INPUT_DIGEST,signal_refs,signal_receipt:null,native_signal_refs};
  row.candidate_digest=routingDigest(binding(row));
  await tx.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,
   candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
   values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${current.userId}::uuid,'assistant',${version},'read_plan_prompt_v1',
   ${JSON.stringify(configuration)}::jsonb,${row.candidate_digest},${base},${MODULE_AGENT_SOURCE_DIGEST},${PROMPT_ENGINE_DIGEST},${PROMPT_POLICY_DIGEST},${PROMPT_INPUT_DIGEST})`);
  await persistCandidateSignalsTx(tx,current,row);
  return {candidateId:id,candidateDigest:row.candidate_digest,state:'unevaluated' as const};
 });}catch{return fail();}
}
/** public.ai_agent_evaluation.receipt is bounded to 65536 characters (0627). Sealed as keyed objects, a complete
 * multilingual prompt suite (2 x PROMPT_HOLDOUTS cases, each with its measurement) is about twice that bound, so
 * the insert failed its CHECK part-way through and no prompt candidate could ever complete evaluation. Receipt
 * version 2 seals each case positionally and rebuilds it EXACTLY (same fields, key order, digests and
 * measurements) before the unchanged validation in authenticatedPromptReport. The index is bound by the
 * suite digest that receipt validation already requires; nothing is dropped or derived. */
type PackedPromptCase=readonly [number,0|1,0|1|2,string|null,0|1|2,0|1|2,readonly [0|1,0|1,number,number,number|null,number|null]|null];
const PROMPT_CASE_STATES=['passed','failed','unavailable'] as const;
function packPromptCases(cases:readonly PromptCase[]):PackedPromptCase[]{
 return cases.map(row=>{const index=PROMPT_HOLDOUTS.findIndex(fixture=>fixture.id===row.id),state=PROMPT_CASE_STATES.indexOf(row.state),m=row.measurement;
  if(index<0||state<0||(row.outputDigest!==undefined&&!/^[a-f0-9]{64}$/.test(row.outputDigest))||(m!==undefined&&m.id!==row.id))return fail();
  const packed:PackedPromptCase=[index,row.arm==='baseline'?0:1,state as 0|1|2,row.outputDigest===undefined?null:Buffer.from(row.outputDigest,'hex').toString('base64url'),
   row.securityFailure===undefined?2:row.securityFailure?1:0,row.retained===undefined?2:row.retained?1:0,
   m===undefined?null:[m.passed?1:0,m.securityFailure?1:0,m.elapsedMs,m.readCount,m.tokens,m.costCredits]];
  return packed;});
}
function unpackPromptCases(value:unknown):PromptCase[]{
 if(!Array.isArray(value)||value.length>2*PROMPT_HOLDOUTS.length)return fail();
 return value.map((item:unknown)=>{
  if(!Array.isArray(item)||item.length!==7)return fail();const [index,arm,state,digest,security,retained,measured]=item as unknown[];
  const fixture=typeof index==='number'&&Number.isSafeInteger(index)&&index>=0?PROMPT_HOLDOUTS[index]:undefined;
  if(!fixture||(arm!==0&&arm!==1)||(state!==0&&state!==1&&state!==2)||(security!==0&&security!==1&&security!==2)||(retained!==0&&retained!==1&&retained!==2))return fail();
  const row:Record<string,unknown>={id:fixture.id,arm:arm===0?'baseline':'candidate',state:PROMPT_CASE_STATES[state as 0|1|2]};
  if(digest!==null){if(typeof digest!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(digest))return fail();const bytes=Buffer.from(digest,'base64url');if(bytes.length!==32)return fail();row.outputDigest=bytes.toString('hex');}
  if(security!==2)row.securityFailure=security===1;
  if(measured!==null){if(!Array.isArray(measured)||measured.length!==6)return fail();const [passed,securityFailure,elapsedMs,readCount,tokens,costCredits]=measured as unknown[];
   if((passed!==0&&passed!==1)||(securityFailure!==0&&securityFailure!==1))return fail();
   row.measurement={id:fixture.id,passed:passed===1,securityFailure:securityFailure===1,elapsedMs,readCount,tokens,costCredits};}
  if(retained!==2)row.retained=retained===1;
  return row as unknown as PromptCase;
 });
}
function authenticatedPromptReport(row:{id:string;evaluator_user_id:string;suite_digest:string;receipt:string},candidate:CandidateRow,tenant:string,providerFingerprint:string){
 const proof=open('prompt-evaluation',tenant,row.id,row.receipt);
 if(!exact(proof,['version','candidateDigest','binding','evaluatorId','providerFingerprint','report'])||proof.version!==2||
  proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||
  proof.evaluatorId!==row.evaluator_user_id||row.suite_digest!==PROMPT_SUITE_DIGEST||proof.providerFingerprint!==providerFingerprint)return fail();
 const sealed=proof.report;if(!sealed||typeof sealed!=='object'||Array.isArray(sealed))return fail();
 const report={...(sealed as Record<string,unknown>),cases:unpackPromptCases((sealed as Record<string,unknown>).cases)} as unknown as PromptHoldoutReport;
 if(!report||!exact(report,['version','coverage','suiteDigest','inputDigest','baselineDigest','candidateConfigurationDigest','attemptedRequests','completedRequests','completedCases','state','securityFailures','qualityFailures','elapsedMs','retainedPasses','retainedFailures','unavailableAttempts','cases','comparison'])||report.version!==2||report.suiteDigest!==PROMPT_SUITE_DIGEST||report.inputDigest!==PROMPT_INPUT_DIGEST||report.baselineDigest!==routingDigest(PROMPT_BASELINE)||report.candidateConfigurationDigest!==routingDigest(capturePromptPlanCandidate(candidate.configuration))||
  report.coverage!=='model-to-typed-read-plan-only'||!Array.isArray(report.cases)||report.cases.length>2*PROMPT_HOLDOUTS.length||!Number.isSafeInteger(report.attemptedRequests)||report.attemptedRequests<0||report.attemptedRequests>PROMPT_HOLDOUT_REQUEST_LIMIT||!Number.isSafeInteger(report.completedRequests)||report.completedRequests<0||report.completedRequests>report.attemptedRequests||!Number.isSafeInteger(report.unavailableAttempts)||report.unavailableAttempts<0||report.completedRequests+report.unavailableAttempts!==report.attemptedRequests||typeof report.elapsedMs!=='number'||!Number.isFinite(report.elapsedMs)||report.elapsedMs<0)return fail();
 const unique=new Set<string>();for(const row of report.cases){const key=row.arm+':'+row.id;
  if(!exact(row,['id','arm','state',...(row.outputDigest===undefined?[]:['outputDigest']),...(row.securityFailure===undefined?[]:['securityFailure']),...(row.retained===undefined?[]:['retained']),...(row.measurement===undefined?[]:['measurement'])])||unique.has(key)||!PROMPT_HOLDOUTS.some(f=>f.id===row.id)||!['baseline','candidate'].includes(row.arm)||!['passed','failed','unavailable'].includes(row.state)||(row.retained!==undefined&&typeof row.retained!=='boolean'))return fail();unique.add(key);
  if(row.state==='unavailable'){if(row.measurement||row.outputDigest||row.securityFailure!==undefined||row.retained)return fail();continue;}
  if(typeof row.outputDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.outputDigest)||typeof row.securityFailure!=='boolean')return fail();const [measurement]=captureMeasuredCases([row.measurement],[row.id]);
  if(measurement.passed!==(row.state==='passed')||measurement.securityFailure!==row.securityFailure||measurement.readCount!==0)return fail();
 }
 const completedCases=PROMPT_HOLDOUTS.filter(fixture=>['baseline','candidate'].every(arm=>report.cases.some(row=>row.id===fixture.id&&row.arm===arm&&row.state!=='unavailable'))).length,
  incomplete=report.unavailableAttempts>0||completedCases!==PROMPT_HOLDOUTS.length,candidateCases=report.cases.filter(row=>row.arm==='candidate');
 if(report.completedCases!==completedCases||report.state!==(incomplete?'incomplete':'complete')||report.securityFailures!==(incomplete?null:candidateCases.filter(row=>row.state==='failed'&&row.securityFailure).length)||report.qualityFailures!==(incomplete?null:candidateCases.filter(row=>row.state==='failed').length)||report.retainedPasses!==report.cases.filter(row=>row.retained&&row.state==='passed').length||report.retainedFailures!==report.cases.filter(row=>row.retained&&row.state==='failed').length||routingDigest(report.comparison)!==routingDigest(promptMeasuredComparison(report.cases)))return fail();
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
   const cfg=withAiAdmissionCheck(bindStrictAiSpendRoot(governedAiConfig(fresh,snapshot,'module_agent_evaluation'),{rootTaskId:candidate.id,kind:'evaluation'}),'module_agent_evaluation',async carrier=>{
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
   const receipt=seal('prompt-evaluation',current.tenantId,proof.id,{version:2,candidateDigest:candidate.candidate_digest,binding:binding(candidate),
    evaluatorId:proof.evaluatorId,providerFingerprint:proof.providerFingerprint,report:{...proof.report,cases:packPromptCases(proof.report.cases)}});
   await tx.execute(sql`insert into public.ai_agent_evaluation(id,tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt)
    values(${proof.id}::uuid,${current.tenantId}::uuid,${candidateId}::uuid,${current.userId}::uuid,${PROMPT_SUITE_DIGEST},${receipt})`);
   return {evaluationId:proof.id,coverage:report.coverage,state:report.state,attemptedRequests:report.attemptedRequests,
    completedRequests:report.completedRequests,completedCases:report.completedCases,comparison:report.comparison,totalCases:PROMPT_HOLDOUTS.length,retainedPasses:report.retainedPasses,retainedFailures:report.retainedFailures,securityFailures:report.securityFailures,qualityFailures:report.qualityFailures};
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
    report.completedCases!==PROMPT_HOLDOUTS.length||report.cases.length!==2*PROMPT_HOLDOUTS.length||!report.comparison.qualityImproved||report.cases.some(row=>row.arm==='candidate'&&row.state!=='passed'))return fail();
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
   const cfg=withAiAdmissionCheck(bindStrictAiSpendRoot(governedAiConfig(fresh,snapshot,'module_agent_evaluation'),{rootTaskId:candidate.id,kind:'evaluation'}),'module_agent_evaluation',async carrier=>{
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

type PromptEvaluationProgress=Readonly<{completedCases:number;totalCases:number;state:'complete'|'incomplete';retainedFailures:number;knownFailures:number;comparison:PromptHoldoutReport['comparison']}>;
/** Current evaluator progress only. Authentication and current source/provider binding precede counts. */
async function promptEvaluationProgressTx(tx:Tx,ctx:SessionContext,id:string,providerFingerprint:string):Promise<PromptEvaluationProgress|null>{
 try{const candidate=await candidateTx(tx,ctx,id);if(candidate.kind!=='read_plan_prompt_v1'||candidate.author_user_id===ctx.userId)return null;
  const [row]=await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select id,evaluator_user_id,suite_digest,receipt from public.ai_agent_evaluation
   where tenant_id=${ctx.tenantId}::uuid and candidate_id=${id}::uuid and evaluator_user_id=${ctx.userId}::uuid and suite_digest=${PROMPT_SUITE_DIGEST}
   order by completed_at desc,id desc limit 1`);if(!row)return null;
  const report=authenticatedPromptReport(row,candidate,ctx.tenantId,providerFingerprint);
  if(report.cases.some(row=>row.state!=='unavailable'&&(!row.outputDigest||!/^[a-f0-9]{64}$/.test(row.outputDigest))))return null;
  const completedCases=report.completedCases;
  const knownFailures=report.cases.filter(row=>row.state==='failed').length,retainedFailures=report.cases.filter(row=>row.state==='failed'&&row.retained===true).length;
  if(!Number.isSafeInteger(report.unavailableAttempts)||report.unavailableAttempts<0||report.unavailableAttempts>report.attemptedRequests||
   !Number.isSafeInteger(report.attemptedRequests)||report.attemptedRequests<0||report.attemptedRequests>PROMPT_HOLDOUT_REQUEST_LIMIT)return null;
  const state=completedCases===PROMPT_HOLDOUTS.length&&report.unavailableAttempts===0&&!report.cases.some(row=>row.state==='unavailable')?'complete' as const:'incomplete' as const;
  if(report.completedCases!==completedCases||report.state!==state||report.retainedFailures!==retainedFailures)return null;
  return Object.freeze({completedCases,totalCases:PROMPT_HOLDOUTS.length,state,retainedFailures,knownFailures,comparison:report.comparison});
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
 const verifiedSignalCount=new Map<string,number|null>();for(const row of rows){try{const candidate=await candidateTx(tx,ctx,row.id);verifiedSignalCount.set(row.id,captureSignalRefs(candidate.signal_refs).length+captureNativeCandidateSignals(candidate.native_signal_refs).length);}catch{verifiedSignalCount.set(row.id,null);}}
 const ownSignalChoices=await ownSignalChoicesTx(tx,ctx),nativeSignals=await ownNativeCandidateSignalChoicesTx(tx,ctx);
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
 const conversationRows=await tx.execute<{id:string;version:number;own:boolean}>(sql`select id,version,owner_user_id=app.current_user_id() as own from public.ai_agent_candidate where tenant_id=${ctx.tenantId}::uuid and kind='assistant_answer_prompt_v1' order by created_at desc,id desc limit 5`);
 const conversationCandidates:{id:string;version:number;own:boolean;progress:Awaited<ReturnType<typeof conversationProgressTx>>|null}[]=[];for(const row of conversationRows){let progress:Awaited<ReturnType<typeof conversationProgressTx>>|null=null;if(!row.own&&providerFingerprint)try{progress=await conversationProgressTx(tx,ctx,row.id,providerFingerprint);}catch{/* Unknown/stale source is never zero progress. */}conversationCandidates.push({...row,progress});}
 const conversationPromotions=await tx.execute<{id:string;version:number;used:number;maximum:number;expiresAt:string;retired:boolean}>(sql`select p.id,c.version,p.used_jobs as used,p.max_jobs as maximum,p.expires_at::text as "expiresAt",exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id) as retired from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id where p.tenant_id=${ctx.tenantId}::uuid and c.kind='assistant_answer_prompt_v1' order by p.created_at desc,p.id desc limit 5`);
 return {conversationCandidates,conversationPromotions:Array.from(conversationPromotions),sourceDigest:MODULE_AGENT_SOURCE_DIGEST,nextVersion:latest.version+1,lastTrial,ownSignalChoices,ownNativeSignalChoices:nativeSignals.choices,nativeSignalChoicesTruncated:nativeSignals.truncated,
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
async function currentPlanningBindingTx(tx:Tx,ctx:SessionContext,binding:PlanningBinding,deferNativeCustody=false){
 const fresh=await guard(tx,ctx,false);await assertAiActionUnpausedTx(tx,fresh,'module_agent_planning');
 await agentReleaseIntervalTx(tx,ctx,ctx.userId!,false);await signalIntervalTx(tx,ctx,ctx.userId!);
 const candidate=await candidateTx(tx,ctx,binding.candidateId,true,deferNativeCustody);
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
async function checkedOwnPlanProposalTx(tx:Tx,ctx:SessionContext,id:string,plan:ReturnType<typeof captureTypedModulePlan>,deferNativeCustody=false){
 if(!uuid(id))return fail();const [row]=await tx.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);if(!row)return fail();
 await proposalNonceTx(tx,ctx,row.request_nonce);const opened=openProposal(row,ctx);await currentPlanningBindingTx(tx,ctx,opened.binding,deferNativeCustody);
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
 const intent=resolvePrivateAssistantIntent(question);if(!intent.intent||!intent.module||resolvePrivateAssistantProposal(question))return{state:'chooser' as const};
 try{
  const prepared=await withTenant(current,async tx=>{
   const fresh=await guard(tx,current,false);await currentPlanPermitTx(tx,permit);await assertAiActionUnpausedTx(tx,fresh,'module_agent_planning');if(!assistantReadableModules(fresh).includes(intent.module!))return{unavailable:true as const};await agentReleaseIntervalTx(tx,current,current.userId!,false);await signalIntervalTx(tx,current,current.userId!);await proposalNonceTx(tx,current,nonce);
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
 const privatePayload=Object.freeze({version:1,operation:'draft' as const,intent:intent.intent,strategy:capturePromptPlanCandidate(prepared.candidate.configuration).variant,modules:Object.freeze([intent.module])});
 const captured=capturePrivateAssistantTask(privatePayload);if(Array.isArray(captured.args.system))return fail();
 const outbound=captured.args as GenerateArgs,expectedInputDigest=draftInputDigest(outbound);
  // Fresh provider configuration is issued only after durable reservation. No transaction spans network.
  const cfg=await withTenant(current,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);const checked=await currentPlanningBindingTx(tx,current,prepared.bound);
   const admitted=withAiAdmissionCheck(bindStrictAiSpendRoot(governedAiConfig(checked.fresh,checked.snapshot,'module_agent_planning'),{rootTaskId:checked.candidate.id,kind:'agent'}),'module_agent_planning',async carrier=>{
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
  let text:string|undefined,privateLocal:unknown;
  try{
   const privacy=await preparePrivateAiTask(cfg,ASSISTANT_PRIVATE_CONTRACT,async(carrier,principal)=>{
    await currentPlanPermitTx(carrier,permit);const checked=await currentPlanningBindingTx(carrier,principal,prepared.bound);await proposalNonceTx(carrier,principal,nonce);
    if(!privatePayload.modules.every(module=>assistantReadableModules(checked.fresh).includes(module)))return fail();
    const [row]=await carrier.execute<PlanProposalRow>(sql`select ${proposalProjection} from public.ai_agent_plan_proposal where id=${prepared.id}::uuid and tenant_id=${principal.tenantId}::uuid and user_id=${principal.userId}::uuid`);
    if(!row||row.state!=='reserved'||openProposal(row,principal).proof.state!=='reserved')return fail();
    return privatePayload;
   });
   try{if(privacy.operation!=='draft')return fail();privateLocal=privacy.local;text=await generateDraft(privacy.configuration,privacy.args);}finally{privacy.dispose();}
  }catch{/* Reserved request is terminally failed; it is never automatically sent again. */}
  let plan:ReturnType<typeof adjudicatePromptReadPlan>|undefined;try{if(text!==undefined)plan=adjudicatePrivateAssistantReadPlan(text,privateLocal);}catch{/* Malformed or broadened proposals never become a plan. */}
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
  const cfg=withAiAdmissionCheck(bindStrictAiSpendRoot(governedAiConfig(fresh,snapshot,'module_agent_evaluation'),{rootTaskId:candidate.id,kind:'evaluation'}),'module_agent_evaluation',async carrier=>{await guard(carrier,current,true);const again=await candidateTx(carrier,current,candidateId);if(again.candidate_digest!==candidate.candidate_digest||again.author_user_id===current.userId)return fail();});
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
type SpecialistJobBinding=Readonly<{configuration:SpecialistCandidate;nativeContractDigest:string;suiteDigest:string;assessmentDigest:string}>;
type SpecialistSelection=Readonly<{binding:SpecialistJobBinding;mode:'baseline'|'promoted';candidateDigest:string;promotionId:string|null;version:number}>;
function captureSpecialistJobBinding(value:unknown):SpecialistJobBinding{
 if(!value||typeof value!=='object'||Array.isArray(value)||!exact(value,['configuration','nativeContractDigest','suiteDigest','assessmentDigest']))return fail();const row=value as Record<string,unknown>,configuration=SpecialistCandidate.parse(row.configuration);
 if(row.nativeContractDigest!==specialistNativeContractDigest(configuration.module)||row.suiteDigest!==specialistSuiteDigest(configuration.module)||typeof row.assessmentDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.assessmentDigest))return fail();
 return Object.freeze({configuration,nativeContractDigest:row.nativeContractDigest as string,suiteDigest:row.suiteDigest as string,assessmentDigest:row.assessmentDigest});
}
function captureSpecialistSelections(value:unknown):readonly SpecialistSelection[]{
 if(!Array.isArray(value)||value.length<1||value.length>4)return fail();const rows=value.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||!exact(item,['binding','mode','candidateDigest','promotionId','version']))return fail();
  const binding=captureSpecialistJobBinding(item.binding),baseline=item.mode==='baseline';
  if(!baseline&&item.mode!=='promoted'||typeof item.candidateDigest!=='string'||!/^[a-f0-9]{64}$/.test(item.candidateDigest)||!Number.isSafeInteger(item.version)||
   (baseline?(item.version!==0||item.promotionId!==null||binding.configuration.playbook!=='canonical_domain_v1'||item.candidateDigest!==specialistBaselineDigest(binding.configuration.module)):(item.version<1||typeof item.promotionId!=='string'||!uuid(item.promotionId)||binding.configuration.playbook!=='canonical_followup_v1')))return fail();
  return Object.freeze({binding,mode:item.mode as 'baseline'|'promoted',candidateDigest:item.candidateDigest,promotionId:item.promotionId as string|null,version:item.version});
 });if(new Set(rows.map(row=>row.binding.configuration.module)).size!==rows.length)return fail();return Object.freeze(rows);
}
type SpecialistAdmission={module:AgentModuleCode;candidate:CandidateRow|null;promotion:{id:string;candidate_id:string;receipt:string;max_jobs:number;expires_at:string}|null;assessment?:SpecialistAssessment};
/** All metadata nomination happens BEFORE the first canonical source. Native privacy custody is
 * deliberately deferred until ALL canonical reads finish; this is not a late source/configuration lock. */
async function nominateSpecialistTx(tx:Tx,ctx:SessionContext,module:AgentModuleCode):Promise<SpecialistAdmission>{
 const [promotion]=await tx.execute<{id:string;candidate_id:string;receipt:string;max_jobs:number;expires_at:string}>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.expires_at::text from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='canonical_specialist_v1' where p.tenant_id=${ctx.tenantId}::uuid and p.owner_user_id=${ctx.userId}::uuid and p.module_code=${module} and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id) order by p.created_at desc,p.id desc limit 1 for update of p nowait`);
 if(!promotion)return{module,candidate:null,promotion:null};const candidate=await candidateTx(tx,ctx,promotion.candidate_id,false);
 try{assertCurrent(candidate);if(candidate.kind!=='canonical_specialist_v1'||candidate.module_code!==module||SpecialistCandidate.parse(candidate.configuration).playbook==='canonical_domain_v1')return fail();await assertCandidateSignalsTx(tx,ctx,candidate,true);checkedSpecialistPromotion(candidate,promotion,ctx.tenantId);}
 catch(error){if(error instanceof AgentSignalBusy||!(error instanceof AiGatewayError)&&!(error instanceof Error&&error.name==='ZodError'))throw error;await retireSpecialistTx(tx,ctx,promotion.id,'source_changed');return{module,candidate:null,promotion:null};}
 return{module,candidate,promotion};
}
async function retireSpecialistTx(tx:Tx,ctx:SessionContext,promotionId:string,reason:'source_changed'|'quality_regression'){
 await tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason) values(${ctx.tenantId}::uuid,${promotionId}::uuid,${ctx.userId}::uuid,${reason}) on conflict(promotion_id) do nothing`);
}
function baselineConfiguration(module:AgentModuleCode){return SpecialistCandidate.parse({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'});}
async function assessSpecialistTx(tx:Tx,ctx:SessionContext,admission:SpecialistAdmission,result:AgentReadResult){
 if(admission.assessment)return admission.assessment;const configuration=admission.candidate?SpecialistCandidate.parse(admission.candidate.configuration):baselineConfiguration(admission.module);
 try{admission.assessment=executeCanonicalSpecialist(configuration,result);}
 catch(error){if(!admission.promotion)throw error;await retireSpecialistTx(tx,ctx,admission.promotion.id,'quality_regression');admission.candidate=null;admission.promotion=null;admission.assessment=executeCanonicalSpecialist(baselineConfiguration(admission.module),result);}
 return admission.assessment;
}
/** Complete privacy validation after ALL canonical reads, then commit bounded metadata permits.
 * Any storage/busy refusal propagates and rolls the complete owner transaction back. */
async function completeSpecialistsTx(tx:Tx,ctx:SessionContext,admissions:readonly SpecialistAdmission[],results:readonly AgentReadResult[]){
 const completed:{selection:SpecialistSelection;assessment:SpecialistAssessment}[]=[];
 for(const admission of admissions){const result=results.find(row=>row.module===admission.module);if(!result)return fail();
  // Native privacy custody deferred at nomination is checked here, after every canonical read. An erased or
  // retired native signal behind a PROMOTED specialist is a source change exactly as at nomination: retire
  // that promotion and answer from the baseline. A busy interval or storage failure still propagates, and an
  // unpromoted candidate (no promotion to retire) still refuses.
  if(admission.candidate&&admission.promotion){try{await assertCandidateSignalsTx(tx,ctx,admission.candidate);}
   catch(error){if(error instanceof AgentSignalBusy||!(error instanceof AiGatewayError)&&!(error instanceof Error&&error.name==='ZodError'))throw error;
    await retireSpecialistTx(tx,ctx,admission.promotion.id,'source_changed');admission.candidate=null;admission.promotion=null;delete admission.assessment;}}
  else if(admission.candidate)await assertCandidateSignalsTx(tx,ctx,admission.candidate);
  const assessment=await assessSpecialistTx(tx,ctx,admission,result),candidate=admission.candidate,promotion=admission.promotion,configuration=candidate?SpecialistCandidate.parse(candidate.configuration):baselineConfiguration(admission.module);
  if(candidate&&promotion){const updated=await tx.execute<{id:string}>(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${promotion.id}::uuid and tenant_id=${ctx.tenantId}::uuid and owner_user_id=${ctx.userId}::uuid and used_jobs<max_jobs and expires_at>now() and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=${promotion.id}::uuid) returning id`);if(updated.length!==1)return fail();}
  const selection=captureSpecialistSelections([{binding:{configuration,nativeContractDigest:specialistNativeContractDigest(admission.module),suiteDigest:specialistSuiteDigest(admission.module),assessmentDigest:routingDigest(assessment)},mode:candidate?'promoted':'baseline',candidateDigest:candidate?.candidate_digest??specialistBaselineDigest(admission.module),promotionId:promotion?.id??null,version:candidate?.version??0}])[0];completed.push({selection,assessment});
 }
 return completed;
}
export async function createCanonicalSpecialistCandidate(ctx:SessionContext,input:{module:AgentModuleCode;version:number;signalIds?:readonly string[];nativeSignalIds?:readonly string[];playbook?:SpecialistCandidate['playbook']},server:NativeOutcomeServerContext={}){
 const current=capture(ctx),module=input.module,version=input.version,playbook=input.playbook??'canonical_domain_v1',signalIds=captureSignalIds(input.signalIds),nativeSignalIds=captureNativeCandidateSignalIds(input.nativeSignalIds),capability=Object.freeze({notificationIdentity:server.notificationIdentity});if(!exact(input,['module','version',...(input.signalIds===undefined?[]:['signalIds']),...(input.nativeSignalIds===undefined?[]:['nativeSignalIds']),...(input.playbook===undefined?[]:['playbook'])])||!isAgentModuleCode(module)||!Number.isSafeInteger(version)||version<1)return fail();
 try{return await withTenant(current,async tx=>{if(nativeSignalIds.length)await boundNativeOutcomeTransactionTx(tx);const fresh=await guard(tx,current,true);assertModuleEnabled(fresh,module);const configuration=SpecialistCandidate.parse({kind:'canonical_specialist_v1',module,playbook}),native_signal_refs=await ownNativeCandidateSignalsTx(tx,current,nativeSignalIds,module,capability),refs=await ownSpecialistSignalRefsTx(tx,current,signalIds,module),id=randomUUID();
 const row:CandidateRow={id,owner_user_id:current.userId!,author_user_id:current.userId!,module_code:module,version,kind:'canonical_specialist_v1',configuration,candidate_digest:'',baseline_digest:specialistBaselineDigest(module),source_digest:MODULE_AGENT_SOURCE_DIGEST,engine_digest:specialistModuleEngineDigest(module),policy_digest:SPECIALIST_POLICY_DIGEST,input_digest:specialistInputDigest(module),signal_refs:refs,signal_receipt:null,native_signal_refs};row.candidate_digest=routingDigest(binding(row));
 await tx.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest) values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${current.userId}::uuid,${module},${version},'canonical_specialist_v1',${JSON.stringify(configuration)}::jsonb,${row.candidate_digest},${row.baseline_digest},${row.source_digest},${row.engine_digest},${row.policy_digest},${row.input_digest})`);await persistCandidateSignalsTx(tx,current,row);return{candidateId:id,candidateDigest:row.candidate_digest,state:'unevaluated' as const};});}catch{return fail();}
}
const specialistIssued=new WeakMap<object,{candidate:CandidateRow;evaluatorId:string;id:string;report:SpecialistEvaluationReport}>();
export async function evaluateCanonicalSpecialistCandidate(ctx:SessionContext,candidateId:string){
 const current=capture(ctx),id=candidateId;if(typeof id!=='string'||!uuid(id))return fail();try{const evidence=await withTenant(current,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);const fresh=await guard(tx,current,true),candidate=await candidateTx(tx,current,id);if(candidate.kind!=='canonical_specialist_v1'||candidate.author_user_id===current.userId)return fail();const configuration=SpecialistCandidate.parse(candidate.configuration);assertModuleEnabled(fresh,configuration.module);const report=await withAssistantReadTx(fresh,tx,read=>executeSpecialistHoldout(configuration,read)),proof=Object.freeze({});specialistIssued.set(proof,{candidate,evaluatorId:current.userId!,id:randomUUID(),report});return proof;});
 return await withTenant(current,async tx=>{const fresh=await guard(tx,current,true);const issued=specialistIssued.get(evidence);if(!issued)return fail();specialistIssued.delete(evidence);const candidate=await candidateTx(tx,current,id);if(candidate.kind!=='canonical_specialist_v1'||candidate.candidate_digest!==issued.candidate.candidate_digest||issued.evaluatorId!==current.userId)return fail();assertModuleEnabled(fresh,SpecialistCandidate.parse(candidate.configuration).module);const receipt=seal('specialist-evaluation',current.tenantId,issued.id,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),evaluatorId:issued.evaluatorId,report:issued.report});await tx.execute(sql`insert into public.ai_agent_evaluation(id,tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt) values(${issued.id}::uuid,${current.tenantId}::uuid,${id}::uuid,${current.userId}::uuid,${issued.report.suiteDigest},${receipt})`);return{evaluationId:issued.id,module:issued.report.module,coverage:issued.report.coverage,state:issued.report.state,securityFailures:issued.report.securityFailures,qualityFailures:issued.report.qualityFailures,nativeEvidence:issued.report.nativeEvidence};});}catch{return fail();}
}
function specialistExpectedCaseIds(module:AgentModuleCode){return [...SPECIALIST_HOLDOUTS.filter(row=>row.module===module).map(row=>row.id),...['foreign-module','foreign-scope','wrong-capability','posted-subject','self-rating','effect-request','unpermitted-fields-not-learned'].map(id=>module+':'+id),...(module==='leave'?['leave:withheld-accrued-alias-refused','leave:withheld-balance-alias-refused']:module==='claims'?['claims:poisoned-payment-refused']:[]),module+':fresh-native-facts-preserved',module+':nonempty-business-evidence',...specialistFollowupCases(module).map(row=>module+':followup:'+row.inputId.split(':').slice(1).join(':')),module+':followup:empty-scope'].sort();}
function checkedSpecialistEvaluation(row:{id:string;evaluator_user_id:string;suite_digest:string;receipt:string},candidate:CandidateRow,tenant:string){
 const configuration=SpecialistCandidate.parse(candidate.configuration),module=configuration.module,proof=open('specialist-evaluation',tenant,row.id,row.receipt);if(!exact(proof,['version','candidateDigest','binding','evaluatorId','report'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||proof.evaluatorId!==row.evaluator_user_id||row.evaluator_user_id===candidate.author_user_id||routingDigest(proof.binding)!==routingDigest(binding(candidate))||row.suite_digest!==specialistSuiteDigest(module))return fail();const report=proof.report as SpecialistEvaluationReport;
 if(!report||!exact(report,['version','module','coverage','suiteDigest','inputDigest','nativeContractDigest','engineDigest','policyDigest','state','securityFailures','qualityFailures','nativeEvidence','diagnosticComparison','cases'])||report.version!==1||report.module!==module||report.coverage!=='canonical_domain_guidance_only'||report.suiteDigest!==specialistSuiteDigest(module)||report.inputDigest!==specialistInputDigest(module)||report.nativeContractDigest!==specialistNativeContractDigest(module)||report.engineDigest!==SPECIALIST_ENGINE_DIGEST||report.policyDigest!==SPECIALIST_POLICY_DIGEST||!['complete','incomplete'].includes(report.state)||!['present','missing'].includes(report.nativeEvidence)||!Array.isArray(report.cases)||routingDigest(report.cases.map(item=>item.id).sort())!==routingDigest(specialistExpectedCaseIds(module))||new Set(report.cases.map(item=>item.id)).size!==report.cases.length||report.cases.some(item=>!exact(item,['id','passed','category'])||typeof item.passed!=='boolean'||!['quality','security','native'].includes(item.category))||report.securityFailures!==report.cases.filter(item=>item.category==='security'&&!item.passed).length||report.qualityFailures!==report.cases.filter(item=>item.category!=='security'&&!item.passed).length)return fail();
 const comparison=report.diagnosticComparison,followup=configuration.playbook==='canonical_followup_v1',required=specialistFollowupCases(module).length+1,baselineCorrect=required-specialistFollowupCases(module).filter(row=>'requiresPrioritizedRecord'in row&&row.requiresPrioritizedRecord).length,correct=report.cases.filter(item=>item.id.startsWith(module+':followup:')&&item.passed).length;
 if(!comparison||!exact(comparison,['applicable','baselineCorrect','candidateCorrect','required','improved'])||comparison.applicable!==followup||comparison.baselineCorrect!==(followup?baselineCorrect:0)||comparison.candidateCorrect!==(followup?correct:0)||comparison.required!==(followup?required:0)||comparison.improved!==(followup&&correct===required&&correct>baselineCorrect))return fail();
 return {evaluationId:row.id,evaluatorId:row.evaluator_user_id,report};
}
async function specialistEvaluationsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow){const module=SpecialistCandidate.parse(candidate.configuration).module,rows=await tx.execute<{id:string;evaluator_user_id:string;suite_digest:string;receipt:string}>(sql`select distinct on(evaluator_user_id) id,evaluator_user_id,suite_digest,receipt from public.ai_agent_evaluation where tenant_id=${ctx.tenantId}::uuid and candidate_id=${candidate.id}::uuid and suite_digest=${specialistSuiteDigest(module)} order by evaluator_user_id,completed_at desc,id desc`);return Array.from(rows).map(row=>checkedSpecialistEvaluation(row,candidate,ctx.tenantId));}
export async function promoteCanonicalSpecialistCandidate(ctx:SessionContext,input:{candidateId:string;maxJobs:number;hours:number}){
 const current=capture(ctx),p={candidateId:input.candidateId,maxJobs:input.maxJobs,hours:input.hours};if(!exact(input,['candidateId','maxJobs','hours'])||typeof p.candidateId!=='string'||!uuid(p.candidateId)||!Number.isInteger(p.maxJobs)||p.maxJobs<1||p.maxJobs>SPECIALIST_POLICY.maxJobs||!Number.isInteger(p.hours)||p.hours<1||p.hours>SPECIALIST_POLICY.maxHours)return fail();
 try{return await withTenant(current,async tx=>{const fresh=await guard(tx,current,true),nomination=await candidateTx(tx,current,p.candidateId,false);await agentReleaseIntervalTx(tx,current,nomination.owner_user_id);const candidate=await candidateTx(tx,current,p.candidateId);if(candidate.kind!=='canonical_specialist_v1'||candidate.owner_user_id!==nomination.owner_user_id||candidate.author_user_id===current.userId)return fail();const module=SpecialistCandidate.parse(candidate.configuration).module;assertModuleEnabled(fresh,module);const evaluations=await specialistEvaluationsTx(tx,current,candidate);if(evaluations.length<2||evaluations.length>8||evaluations.some(row=>!row.report.diagnosticComparison.improved||row.report.state!=='complete'||row.report.nativeEvidence!=='present'||row.report.securityFailures!==0||row.report.qualityFailures!==0||row.report.cases.some(item=>!item.passed)))return fail();
 const [prior]=await tx.execute<{present:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='canonical_specialist_v1' where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${candidate.owner_user_id}::uuid and p.module_code=${module} and p.expires_at>now() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id)) as present`);if(prior?.present)return fail();const id=randomUUID(),[clock]=await tx.execute<{now:string;expires:string}>(sql`select now()::text as now,(now()+make_interval(hours=>${p.hours}))::text as expires`),receipt=seal('specialist-promotion',current.tenantId,id,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),approverId:current.userId,evaluations:evaluations.map(row=>({evaluationId:row.evaluationId,evaluatorId:row.evaluatorId})),maxJobs:p.maxJobs,createdAt:clock.now,expiresAt:clock.expires});
 await tx.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,expires_at) values(${id}::uuid,${current.tenantId}::uuid,${candidate.id}::uuid,${candidate.owner_user_id}::uuid,${module},${current.userId}::uuid,${receipt},${p.maxJobs},${clock.expires}::timestamptz)`);return{promotionId:id,module,coverage:'canonical_domain_guidance_only' as const,maxJobs:p.maxJobs,expiresAt:clock.expires};});}catch{return fail();}
}
function checkedSpecialistPromotion(candidate:CandidateRow,promotion:{id:string;receipt:string;max_jobs:number;expires_at:string},tenant:string){if(SpecialistCandidate.parse(candidate.configuration).playbook==='canonical_domain_v1')return fail();const proof=open('specialist-promotion',tenant,promotion.id,promotion.receipt);if(!exact(proof,['version','candidateDigest','binding','approverId','evaluations','maxJobs','createdAt','expiresAt'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||proof.maxJobs!==promotion.max_jobs||new Date(String(proof.expiresAt)).getTime()!==new Date(promotion.expires_at).getTime()||typeof proof.approverId!=='string'||proof.approverId===candidate.author_user_id||!Array.isArray(proof.evaluations)||proof.evaluations.length<2||proof.evaluations.length>8||new Set(proof.evaluations.map(row=>row.evaluatorId)).size!==proof.evaluations.length)return fail();return proof;}
async function currentSpecialistAssessmentsTx(tx:Tx,ctx:SessionContext,completed:ReturnType<typeof verifiedGovernedJob>,results:readonly AgentReadResult[]){
 const current:{module:AgentModuleCode;assessment:SpecialistAssessment;work:ReturnType<typeof compactSpecialistWork>}[]=[];
 for(const selection of completed.specialists){const module=selection.binding.configuration.module,result=results.find(row=>row.module===module);if(!result)return fail();let active=selection.mode==='promoted';
  if(active){const[row]=await tx.execute<{active:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p where p.id=${selection.promotionId}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.owner_user_id=${ctx.userId}::uuid and p.module_code=${module} and p.expires_at>now() and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id)) as active`);active=row?.active===true;}
  const configuration=active?selection.binding.configuration:baselineConfiguration(module),assessment=executeCanonicalSpecialist(configuration,result);current.push({module,assessment,work:compactSpecialistWork(assessment,{mode:active?'promoted':'baseline',version:active?selection.version:0,configuration})});
 }
 return current;
}
/** Same source-owned selection and canonical interpreter as shared plans and chatbot tool batches. */
export async function runGovernedSpecialistJob(ctx:SessionContext,input:{module:AgentModuleCode},command:{nonce:string}){
 const current=capture(ctx),module=input.module,nonce=command?.nonce;if(!exact(input,['module'])||!isAgentModuleCode(module)||!command||!exact(command,['nonce'])||typeof nonce!=='string'||!uuid(nonce))return fail();
 return runGovernedReadJob(current,{version:1,modules:[module]},{nonce},'specialist');
}
export async function specialistReviewWorkspaceTx(tx:Tx,ctx:SessionContext){const current=capture(ctx);await assertAiPrincipalTx(tx,current);if(!isGroupAdmin(current))return null;const [admin]=await tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`);if(admin?.allowed!==true)return null;const fresh={...current,entitlements:await resolveEntitlementsTx(tx,current.tenantId)};
 const versions=await tx.execute<{module:string;version:number}>(sql`select module_code as module,max(version)::int as version from public.ai_agent_candidate where tenant_id=${current.tenantId}::uuid and owner_user_id=${current.userId}::uuid group by module_code`),modules=AGENT_MODULE_CODES.filter(module=>{try{assertModuleEnabled(fresh,module);return true;}catch{return false;}}).map(module=>({module,nextVersion:(versions.find(row=>row.module===module)?.version??0)+1}));
 const rows=await tx.execute<{id:string;module:AgentModuleCode;version:number;playbook:SpecialistCandidate['playbook'];own:boolean}>(sql`select id,module_code as module,version,configuration->>'playbook' as playbook,owner_user_id=app.current_user_id() as own from public.ai_agent_candidate where tenant_id=${current.tenantId}::uuid and kind='canonical_specialist_v1' order by created_at desc,id desc limit 40`),candidates:{id:string;module:AgentModuleCode;version:number;playbook:SpecialistCandidate['playbook'];own:boolean;evaluations:number|null;passingEvaluators:number|null;incompleteEvaluators:number|null}[]=[];
 for(const row of rows){if(!isAgentModuleCode(row.module))continue;let evaluations:number|null=null,passingEvaluators:number|null=null,incompleteEvaluators:number|null=null;try{const candidate=await candidateTx(tx,current,row.id),checked=await specialistEvaluationsTx(tx,current,candidate);evaluations=checked.length;passingEvaluators=checked.filter(e=>e.report.diagnosticComparison.improved&&e.report.state==='complete'&&e.report.securityFailures===0&&e.report.qualityFailures===0&&e.report.cases.every(item=>item.passed)).length;incompleteEvaluators=checked.filter(e=>e.report.state==='incomplete').length;}catch(error){if(!(error instanceof AiGatewayError)&&!(error instanceof Error&&error.name==='ZodError'))throw error;}candidates.push({...row,evaluations,passingEvaluators,incompleteEvaluators});}
 const promotions=await tx.execute<{id:string;module:AgentModuleCode;version:number;used:number;maximum:number;expiresAt:string;retired:boolean}>(sql`select p.id,p.module_code as module,c.version,p.used_jobs as used,p.max_jobs as maximum,p.expires_at::text as "expiresAt",exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id) as retired from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind='canonical_specialist_v1' where p.tenant_id=${current.tenantId}::uuid order by p.created_at desc,p.id desc limit 40`);const signals=await ownSpecialistSignalChoicesTx(tx,current),nativeSignals=await ownNativeCandidateSignalChoicesTx(tx,current);return{modules,candidates,promotions:Array.from(promotions),ownSignalChoices:signals.choices,signalChoicesTruncated:signals.truncated,ownNativeSignalChoices:nativeSignals.choices,nativeSignalChoicesTruncated:nativeSignals.truncated};
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

/** Main-conversation candidates have separate evidence; routing receipts are never upgraded. */
export async function createConversationAgentCandidate(ctx:SessionContext,input:{version:number;configuration:unknown;signalIds?:readonly string[];nativeSignalIds?:readonly string[]},server:NativeOutcomeServerContext={}){
 const current=capture(ctx),configuration=captureAssistantConversationCandidate(input.configuration),version=input.version,signalIds=captureSignalIds(input.signalIds),nativeSignalIds=captureNativeCandidateSignalIds(input.nativeSignalIds),capability=Object.freeze({notificationIdentity:server.notificationIdentity});
 if(!exact(input,['version','configuration',...(input.signalIds===undefined?[]:['signalIds']),...(input.nativeSignalIds===undefined?[]:['nativeSignalIds'])])||!Number.isSafeInteger(version)||version<1)return fail();
 return withTenant(current,async tx=>{if(nativeSignalIds.length)await boundNativeOutcomeTransactionTx(tx);await guard(tx,current,true);
  const id=randomUUID(),native_signal_refs=await ownNativeCandidateSignalsTx(tx,current,nativeSignalIds,undefined,capability),signal_refs=await ownSignalRefsTx(tx,current,signalIds);
  const row:CandidateRow={id,owner_user_id:current.userId!,author_user_id:current.userId!,module_code:'assistant',version,kind:'assistant_answer_prompt_v1',configuration,candidate_digest:'',baseline_digest:conversationBaselineDigest,source_digest:MODULE_AGENT_SOURCE_DIGEST,engine_digest:ASSISTANT_CONVERSATION_ENGINE_DIGEST,policy_digest:ASSISTANT_CONVERSATION_POLICY_DIGEST,input_digest:ASSISTANT_CONVERSATION_INPUT_DIGEST,signal_refs,signal_receipt:null,native_signal_refs};row.candidate_digest=routingDigest(binding(row));
  await tx.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest) values(${id}::uuid,${current.tenantId}::uuid,${current.userId}::uuid,${current.userId}::uuid,'assistant',${version},${row.kind},${JSON.stringify(configuration)}::jsonb,${row.candidate_digest},${row.baseline_digest},${row.source_digest},${row.engine_digest},${row.policy_digest},${row.input_digest})`);
  await persistCandidateSignalsTx(tx,current,row);return{candidateId:id,candidateDigest:row.candidate_digest,state:'unevaluated' as const};
 });
}
type ConversationArmRow={id:string;fixture_id:string;arm:'baseline'|'candidate';receipt:string;passed:boolean};
async function conversationArmsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow,providerFingerprint:string,evaluatorId=ctx.userId!):Promise<readonly ConversationArm[]>{
 const rows=await tx.execute<ConversationArmRow>(sql`select a.id,a.fixture_id,a.arm,a.receipt,a.passed from public.ai_assistant_answer_evaluation_arm a where exists(select 1 from public.app_user actual where actual.id=a.evaluator_user_id and actual.tenant_id=a.tenant_id and actual.person_id is not distinct from a.evaluator_person_id) and tenant_id=${ctx.tenantId}::uuid and candidate_id=${candidate.id}::uuid and evaluator_user_id=${evaluatorId}::uuid and provider_fingerprint=${providerFingerprint} and suite_digest=${ASSISTANT_CONVERSATION_SUITE_DIGEST} and expires_at>clock_timestamp() order by fixture_id,arm limit ${2*ASSISTANT_CONVERSATION_HOLDOUTS.length+1}`);
 if(rows.length>2*ASSISTANT_CONVERSATION_HOLDOUTS.length)return fail();const arms:ConversationArm[]=[];
 for(const row of rows){const proof=open('conversation-arm',ctx.tenantId,row.id,row.receipt),fixture=ASSISTANT_CONVERSATION_HOLDOUTS.find(item=>item.id===row.fixture_id);
  if(!fixture||!exact(proof,['version','candidateDigest','binding','evaluatorId','providerFingerprint','suiteDigest','result'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||proof.evaluatorId!==evaluatorId||proof.providerFingerprint!==providerFingerprint||proof.suiteDigest!==ASSISTANT_CONVERSATION_SUITE_DIGEST)return fail();
  const result=proof.result as ConversationCaseResult;if(!result||!exact(result,['id','sourceFingerprint','plan','tools','passed','securityFailure','observation'])||result.id!==fixture.id||result.sourceFingerprint!==fixture.sourceFingerprint||typeof result.passed!=='boolean'||result.passed!==row.passed||typeof result.securityFailure!=='boolean')return fail();
  const checked=scoreAssistantConversationTrial(fixture,{terminal:result.plan===null?null:JSON.stringify(result.plan),reads:fixture.reads,tools:result.tools,observation:result.observation});
  if(result.passed&&(!checked.passed||result.securityFailure)||!result.passed&&result.plan!==null&&routingDigest(checked.plan)!==routingDigest(result.plan))return fail();
  arms.push(Object.freeze({arm:row.arm,candidateDigest:candidate.candidate_digest,providerFingerprint,case:Object.freeze(result)}));
 }
 // Validates duplicate cases, exact candidate/provider/fixture bindings before any retention.
 compareAssistantConversationArms(ASSISTANT_CONVERSATION_HOLDOUTS,arms,{candidateDigest:candidate.candidate_digest,providerFingerprint});return Object.freeze(arms);
}
const conversationArmSetDigest=(arms:readonly ConversationArm[])=>routingDigest([...arms].sort((a,b)=>(a.case.id+':'+a.arm).localeCompare(b.case.id+':'+b.arm)));
async function conversationProgressTx(tx:Tx,ctx:SessionContext,id:string,providerFingerprint:string){
 const candidate=await candidateTx(tx,ctx,id);if(candidate.kind!=='assistant_answer_prompt_v1')return fail();const arms=await conversationArmsTx(tx,ctx,candidate,providerFingerprint),comparison=compareAssistantConversationArms(ASSISTANT_CONVERSATION_HOLDOUTS,arms,{candidateDigest:candidate.candidate_digest,providerFingerprint});
 return{completedCases:ASSISTANT_CONVERSATION_HOLDOUTS.filter(fixture=>arms.some(row=>row.case.id===fixture.id&&row.arm==='baseline')&&arms.some(row=>row.case.id===fixture.id&&row.arm==='candidate')).length,totalCases:ASSISTANT_CONVERSATION_HOLDOUTS.length,state:comparison.complete?'complete' as const:'incomplete' as const,knownFailures:arms.filter(row=>!row.case.passed).length,comparison};
}
type ConversationEvaluationInvocation={id:string;receiptDigest:string;incarnation:string};
async function assertConversationEvaluationInvocationTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow,providerFingerprint:string,invocation:ConversationEvaluationInvocation){
 // Every caller ran guard first, so this transaction holds EXCLUSIVE Access (assertAiPrincipalTx)
 // until it ends; every physical intent delete/copy needs Access TRY ownership in its DB trigger,
 // including direct SQL/FK/PDPA cleanup. A same-ID copy gets a fresh database incarnation.
 const [row]=await tx.execute<{receipt:string;incarnation:string}>(sql`select receipt,incarnation::text as incarnation from public.ai_assistant_answer_evaluation_intent where id=${invocation.id}::uuid and tenant_id=${ctx.tenantId}::uuid and candidate_id=${candidate.id}::uuid and evaluator_user_id=${ctx.userId}::uuid and evaluator_person_id is not distinct from ${ctx.personId??null}::uuid and state='pending' and source_digest=${MODULE_AGENT_SOURCE_DIGEST} and provider_fingerprint=${providerFingerprint} and suite_digest=${ASSISTANT_CONVERSATION_SUITE_DIGEST} and expires_at>clock_timestamp()`);if(!row||row.incarnation!==invocation.incarnation||rawReceiptDigest(row.receipt)!==invocation.receiptDigest)return fail();
 const proof=open('conversation-evaluation-intent',ctx.tenantId,invocation.id,row.receipt);if(!exact(proof,['version','candidateDigest','binding','evaluatorId','personId','providerFingerprint','sourceDigest','suiteDigest'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||proof.evaluatorId!==ctx.userId||proof.personId!==(ctx.personId??null)||proof.providerFingerprint!==providerFingerprint||proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||proof.suiteDigest!==ASSISTANT_CONVERSATION_SUITE_DIGEST)return fail();
}
/** Cumulative provider-call ledger, persistent across invocations, retries and evaluators. One arm
 * attempt admits at most three round trips (the harness balance->explanation->terminal bound);
 * promotion counts at most eight independent evaluators; each may attempt one arm three times. The
 * candidate total allows every counted evaluator two clean passes of the fixed suite. Rows hold no
 * person, user or content, so no erasure path lowers them; exhaustion refuses BEFORE admission. */
const CONVERSATION_ROUND_TRIPS=3,CONVERSATION_COUNTED_EVALUATORS=8,CONVERSATION_ARM_ATTEMPTS=3;
export const ASSISTANT_CONVERSATION_ARM_CALL_LIMIT=CONVERSATION_ROUND_TRIPS*CONVERSATION_ARM_ATTEMPTS*CONVERSATION_COUNTED_EVALUATORS;
export const ASSISTANT_CONVERSATION_CANDIDATE_CALL_LIMIT=2*CONVERSATION_COUNTED_EVALUATORS*ASSISTANT_CONVERSATION_HOLDOUTS.reduce((sum,row)=>sum+2*(row.expectedTools.length+1),0);
type ConversationArmRequest=Readonly<{id:string;arm:'baseline'|'candidate'}>;
/** Read-only refusal before an intent is created: an exhausted candidate, or an exhausted queue-head arm. */
async function assertConversationLedgerOpenTx(tx:Tx,ctx:SessionContext,candidateId:string,head:ConversationArmRequest|undefined){
 const [total]=await tx.execute<{admitted:number}>(sql`select admitted from public.ai_assistant_answer_evaluation_budget where tenant_id=${ctx.tenantId}::uuid and candidate_id=${candidateId}::uuid and fixture_id='*' and arm='total'`);
 if((total?.admitted??0)>=ASSISTANT_CONVERSATION_CANDIDATE_CALL_LIMIT)return fail();if(!head)return;
 const [arm]=await tx.execute<{admitted:number}>(sql`select admitted from public.ai_assistant_answer_evaluation_budget where tenant_id=${ctx.tenantId}::uuid and candidate_id=${candidateId}::uuid and fixture_id=${head.id} and arm=${head.arm}`);
 if((arm?.admitted??0)>=ASSISTANT_CONVERSATION_ARM_CALL_LIMIT)return fail();
}
/** Runs inside the admission check after guard (exclusive Access) and the intent check, before the
 * native admission/reservation. Candidate total first, then the arm; either exhausted rolls back both. */
async function spendConversationCallTx(tx:Tx,ctx:SessionContext,candidateId:string,head:ConversationArmRequest){
 for(const [fixture,arm,limit] of [['*','total',ASSISTANT_CONVERSATION_CANDIDATE_CALL_LIMIT],[head.id,head.arm,ASSISTANT_CONVERSATION_ARM_CALL_LIMIT]] as const){
  const [row]=await tx.execute<{admitted:number}>(sql`insert into public.ai_assistant_answer_evaluation_budget(tenant_id,candidate_id,fixture_id,arm) values(${ctx.tenantId}::uuid,${candidateId}::uuid,${fixture},${arm}) on conflict(tenant_id,candidate_id,fixture_id,arm) do update set admitted=ai_assistant_answer_evaluation_budget.admitted+1 where ai_assistant_answer_evaluation_budget.admitted<${limit} returning admitted`);
  if(!row||!Number.isSafeInteger(row.admitted)||row.admitted<1||row.admitted>limit)return fail();
 }
}
export async function evaluateConversationAgentCandidate(ctx:SessionContext,input:{candidateId:string;consent:AgentSyntheticConsent}){
 const current=capture(ctx),id=input.candidateId;captureSyntheticConsent(input.consent,12);if(!exact(input,['candidateId','consent']))return fail();
 const prepared=await withTenant(current,async tx=>{await boundNativeOutcomeTransactionTx(tx);const fresh=await guard(tx,current,true);await assertAiActionUnpausedTx(tx,fresh,'module_agent_evaluation');const candidate=await candidateTx(tx,current,id);if(candidate.kind!=='assistant_answer_prompt_v1'||candidate.author_user_id===current.userId)return fail();
  const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();
  // The harness derives this SAME queue from the same prior arms; admissions between two checkpoints
  // belong to the queue head, so each call is attributed to one exact arm (mismatch fails closed).
  const prior=await conversationArmsTx(tx,current,candidate,snapshot.fingerprint),ledger={queue:nextAssistantConversationArms(ASSISTANT_CONVERSATION_HOLDOUTS,prior,{candidateDigest:candidate.candidate_digest,providerFingerprint:snapshot.fingerprint}),cursor:0};await assertConversationLedgerOpenTx(tx,current,candidate.id,ledger.queue[0]);
  const invocationId=randomUUID(),invocationReceipt=seal('conversation-evaluation-intent',current.tenantId,invocationId,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),evaluatorId:current.userId,personId:current.personId??null,providerFingerprint:snapshot.fingerprint,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,suiteDigest:ASSISTANT_CONVERSATION_SUITE_DIGEST});
  const [created]=await tx.execute<{incarnation:string}>(sql`insert into public.ai_assistant_answer_evaluation_intent(id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,source_digest,provider_fingerprint,suite_digest,receipt) values(${invocationId}::uuid,${current.tenantId}::uuid,${candidate.id}::uuid,${current.userId}::uuid,${current.personId??null}::uuid,${MODULE_AGENT_SOURCE_DIGEST},${snapshot.fingerprint},${ASSISTANT_CONVERSATION_SUITE_DIGEST},${invocationReceipt}) returning incarnation::text as incarnation`);if(!created||!/^\d+$/.test(created.incarnation))return fail();const invocation={id:invocationId,receiptDigest:rawReceiptDigest(invocationReceipt),incarnation:created.incarnation};const cfg=withAiAdmissionCheck(bindStrictAiSpendRoot(governedAiConfig(fresh,snapshot,'module_agent_evaluation'),{rootTaskId:candidate.id,kind:'evaluation'}),'module_agent_evaluation',async carrier=>{await guard(carrier,current,true);await assertAiActionUnpausedTx(carrier,current,'module_agent_evaluation');const again=await candidateTx(carrier,current,id),provider=await resolveAiProviderSnapshotTx(carrier,current);if(again.candidate_digest!==candidate.candidate_digest||again.author_user_id===current.userId||provider?.fingerprint!==snapshot.fingerprint)return fail();await assertConversationEvaluationInvocationTx(carrier,current,again,snapshot.fingerprint,invocation);const head=ledger.queue[ledger.cursor];if(!head)return fail();await spendConversationCallTx(carrier,current,again.id,head);});
  return{candidate,cfg,invocation,providerFingerprint:snapshot.fingerprint,prior,ledger};
 });
 const run=await executeAssistantConversationHoldout(prepared.candidate.configuration,prepared.cfg,{candidateDigest:prepared.candidate.candidate_digest,providerFingerprint:prepared.providerFingerprint},prepared.prior,async arm=>{
  const head=prepared.ledger.queue[prepared.ledger.cursor];if(!head||head.id!==arm.case.id||head.arm!==arm.arm)return fail();
  await withTenant(current,async tx=>{const fresh=await guard(tx,current,true),candidate=await candidateTx(tx,current,id),provider=await resolveAiProviderSnapshotTx(tx,fresh);if(candidate.candidate_digest!==prepared.candidate.candidate_digest||candidate.author_user_id===current.userId||provider?.fingerprint!==prepared.providerFingerprint)return fail();await assertConversationEvaluationInvocationTx(tx,current,candidate,prepared.providerFingerprint,prepared.invocation);
   const [previous]=await tx.execute<{id:string;passed:boolean}>(sql`select id,passed from public.ai_assistant_answer_evaluation_arm where tenant_id=${current.tenantId}::uuid and candidate_id=${id}::uuid and evaluator_user_id=${current.userId}::uuid and provider_fingerprint=${prepared.providerFingerprint} and suite_digest=${ASSISTANT_CONVERSATION_SUITE_DIGEST} and fixture_id=${arm.case.id} and arm=${arm.arm} for update nowait`);
   if(previous?.passed)return;const rowId=previous?.id??randomUUID(),body={version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),evaluatorId:current.userId,providerFingerprint:prepared.providerFingerprint,suiteDigest:ASSISTANT_CONVERSATION_SUITE_DIGEST,result:arm.case};if(Buffer.byteLength(JSON.stringify(body),'utf8')>12000)return fail();const receipt=seal('conversation-arm',current.tenantId,rowId,body);
   await tx.execute(sql`insert into public.ai_assistant_answer_evaluation_arm(id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,provider_fingerprint,suite_digest,fixture_id,arm,passed,receipt) values(${rowId}::uuid,${current.tenantId}::uuid,${id}::uuid,${current.userId}::uuid,${current.personId??null}::uuid,${prepared.providerFingerprint},${ASSISTANT_CONVERSATION_SUITE_DIGEST},${arm.case.id},${arm.arm},${arm.case.passed},${receipt}) on conflict(id) do update set passed=excluded.passed,receipt=excluded.receipt where not ai_assistant_answer_evaluation_arm.passed`);
  });
  prepared.ledger.cursor++;
 });
 return withTenant(current,async tx=>{const fresh=await guard(tx,current,true),candidate=await candidateTx(tx,current,id),provider=await resolveAiProviderSnapshotTx(tx,fresh);if(candidate.candidate_digest!==prepared.candidate.candidate_digest||provider?.fingerprint!==prepared.providerFingerprint)return fail();await assertConversationEvaluationInvocationTx(tx,current,candidate,prepared.providerFingerprint,prepared.invocation);const arms=await conversationArmsTx(tx,current,candidate,prepared.providerFingerprint),comparison=compareAssistantConversationArms(ASSISTANT_CONVERSATION_HOLDOUTS,arms,{candidateDigest:candidate.candidate_digest,providerFingerprint:prepared.providerFingerprint}),evaluationId=randomUUID(),receipt=seal('conversation-evaluation',current.tenantId,evaluationId,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),evaluatorId:current.userId,providerFingerprint:prepared.providerFingerprint,suiteDigest:ASSISTANT_CONVERSATION_SUITE_DIGEST,armSetDigest:conversationArmSetDigest(arms),comparison});
  await tx.execute(sql`insert into public.ai_agent_evaluation(id,tenant_id,candidate_id,evaluator_user_id,suite_digest,receipt) values(${evaluationId}::uuid,${current.tenantId}::uuid,${id}::uuid,${current.userId}::uuid,${ASSISTANT_CONVERSATION_SUITE_DIGEST},${receipt})`);const finished=await tx.execute(sql`update public.ai_assistant_answer_evaluation_intent set state='completed',evaluation_id=${evaluationId}::uuid where id=${prepared.invocation.id}::uuid and incarnation=${prepared.invocation.incarnation}::bigint and tenant_id=${current.tenantId}::uuid and evaluator_user_id=${current.userId}::uuid and state='pending' returning id`);if(finished.length!==1)return fail();return{evaluationId,...run,...await conversationProgressTx(tx,current,id,prepared.providerFingerprint)};
 });
}
async function verifiedConversationEvaluationsTx(tx:Tx,ctx:SessionContext,candidate:CandidateRow,providerFingerprint:string){
 const rows=await tx.execute<{id:string;evaluator_user_id:string;receipt:string}>(sql`select distinct on(evaluator_user_id) id,evaluator_user_id,receipt from public.ai_agent_evaluation where tenant_id=${ctx.tenantId}::uuid and candidate_id=${candidate.id}::uuid and suite_digest=${ASSISTANT_CONVERSATION_SUITE_DIGEST} order by evaluator_user_id,completed_at desc,id desc limit 9`);if(rows.length<2||rows.length>8)return fail();
 const checked:{id:string;evaluatorId:string;receiptDigest:string}[]=[];for(const row of rows){if(row.evaluator_user_id===candidate.author_user_id)return fail();const proof=open('conversation-evaluation',ctx.tenantId,row.id,row.receipt),arms=await conversationArmsTx(tx,ctx,candidate,providerFingerprint,row.evaluator_user_id),comparison=compareAssistantConversationArms(ASSISTANT_CONVERSATION_HOLDOUTS,arms,{candidateDigest:candidate.candidate_digest,providerFingerprint});
  if(!exact(proof,['version','candidateDigest','binding','evaluatorId','providerFingerprint','suiteDigest','armSetDigest','comparison'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||proof.evaluatorId!==row.evaluator_user_id||proof.providerFingerprint!==providerFingerprint||proof.suiteDigest!==ASSISTANT_CONVERSATION_SUITE_DIGEST||proof.armSetDigest!==conversationArmSetDigest(arms)||routingDigest(proof.comparison)!==routingDigest(comparison)||!comparison.complete||!comparison.qualityImproved||comparison.candidate.securityFailures!==0||comparison.candidate.correct!==ASSISTANT_CONVERSATION_HOLDOUTS.length)return fail();
  checked.push({id:row.id,evaluatorId:row.evaluator_user_id,receiptDigest:routingDigest(row.receipt)});
 }return checked;
}
export async function promoteConversationAgentCandidate(ctx:SessionContext,input:{candidateId:string;maxJobs:number;hours:number}){
 const current=capture(ctx),p={...input};if(!exact(p,['candidateId','maxJobs','hours'])||!Number.isSafeInteger(p.maxJobs)||p.maxJobs<1||p.maxJobs>100||!Number.isSafeInteger(p.hours)||p.hours<1||p.hours>24)return fail();
 return withTenant(current,async tx=>{const fresh=await guard(tx,current,true),nominated=await candidateTx(tx,current,p.candidateId,false);await agentReleaseIntervalTx(tx,current,nominated.owner_user_id);const candidate=await candidateTx(tx,current,p.candidateId);if(candidate.kind!=='assistant_answer_prompt_v1'||candidate.author_user_id===current.userId||candidate.owner_user_id!==nominated.owner_user_id)return fail();const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();const evaluations=await verifiedConversationEvaluationsTx(tx,current,candidate,snapshot.fingerprint);
  const [prior]=await tx.execute<{present:boolean}>(sql`select exists(select 1 from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id where p.tenant_id=${current.tenantId}::uuid and p.owner_user_id=${candidate.owner_user_id}::uuid and c.kind='assistant_answer_prompt_v1' and p.expires_at>clock_timestamp() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id)) as present`);if(prior?.present)return fail();const id=randomUUID(),[clock]=await tx.execute<{now:string;expires:string}>(sql`select clock_timestamp()::text as now,(clock_timestamp()+make_interval(hours=>${p.hours}))::text as expires`),receipt=seal('conversation-promotion',current.tenantId,id,{version:1,candidateDigest:candidate.candidate_digest,binding:binding(candidate),approverId:current.userId,evaluations,providerFingerprint:snapshot.fingerprint,maxJobs:p.maxJobs,createdAt:clock.now,expiresAt:clock.expires});
  await tx.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,created_at,expires_at) values(${id}::uuid,${current.tenantId}::uuid,${candidate.id}::uuid,${candidate.owner_user_id}::uuid,'assistant',${current.userId}::uuid,${receipt},${p.maxJobs},${clock.now}::timestamptz,${clock.expires}::timestamptz)`);return{promotionId:id,maxJobs:p.maxJobs,expiresAt:clock.expires,coverage:'synthetic-canonical-terminal-plans-and-tool-minimality' as const};
 });
}

type ConversationPromotion={id:string;candidate_id:string;receipt:string;max_jobs:number;used_jobs:number;expires_at:string;created_at:string;approver_user_id:string};
async function currentConversationPromotionTx(tx:Tx,ctx:SessionContext,promotionId:string,providerFingerprint:string){
 const [row]=await tx.execute<ConversationPromotion>(sql`select p.id,p.candidate_id,p.receipt,p.max_jobs,p.used_jobs,p.expires_at::text,p.created_at::text,p.approver_user_id from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id where p.id=${promotionId}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.owner_user_id=${ctx.userId}::uuid and c.kind='assistant_answer_prompt_v1' and p.expires_at>clock_timestamp() and p.used_jobs<=p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id)`);if(!row)return fail();
 const candidate=await candidateTx(tx,ctx,row.candidate_id),proof=open('conversation-promotion',ctx.tenantId,row.id,row.receipt),evaluations=await verifiedConversationEvaluationsTx(tx,ctx,candidate,providerFingerprint);
 if(!exact(proof,['version','candidateDigest','binding','approverId','evaluations','providerFingerprint','maxJobs','createdAt','expiresAt'])||proof.version!==1||proof.candidateDigest!==candidate.candidate_digest||routingDigest(proof.binding)!==routingDigest(binding(candidate))||proof.providerFingerprint!==providerFingerprint||routingDigest(proof.evaluations)!==routingDigest(evaluations)||proof.maxJobs!==row.max_jobs||proof.approverId!==row.approver_user_id||new Date(String(proof.createdAt)).getTime()!==new Date(row.created_at).getTime()||new Date(String(proof.expiresAt)).getTime()!==new Date(row.expires_at).getTime())return fail();return{row,candidate};
}
export type AssistantConversationStrategyCapability=Readonly<{readonly __assistantConversationStrategy?:never}>;
type ConversationStrategyUse={ctx:SessionContext;id:string;incarnation:string;promotionId:string|null;candidateDigest:string;providerFingerprint:string;questionDigest:string;provenance:Readonly<{mode:'baseline'|'promoted';version:number;configurationDigest:string}>};
const conversationStrategyUses=new WeakMap<object,ConversationStrategyUse>();
const strategyPrincipal=(ctx:SessionContext)=>routingDigest([ctx.tenantId,ctx.userId,ctx.personId??null,ctx.roles??null,ctx.grants??null]);
/** Calling command already owns its native assistant_question spend root. Composition preserves that
 * issued root and all prior checks; this helper never rebinds a human question to candidate budget.
 * `continuationSourceTx` (a clarification continuation only) rechecks the caller's transient source
 * context in this marker transaction and before every provider round trip; it can only refuse. */
export async function prepareAssistantConversationStrategyTx(tx:Tx,supplied:SessionContext,configuration:ResolvedAiConfig,question:string,continuationSourceTx?:(tx:Tx)=>Promise<void>){
 if(typeof question!=='string'||!question.trim()||question.length>ASSISTANT_CONVERSATION_LIMITS.history||(continuationSourceTx!==undefined&&typeof continuationSourceTx!=='function'))return fail();const questionDigest=routingDigest([supplied.tenantId,supplied.userId,question]);
 const ctx=capture(supplied),fresh=await guard(tx,ctx,false);await agentReleaseIntervalTx(tx,ctx,ctx.userId!,false);await signalIntervalTx(tx,ctx,ctx.userId!);
 // Under the guard's Access interval and before this marker exists: an erasure committed after the
 // caller's own read is visible here, and a later one waits for this commit and then invalidates it.
 if(continuationSourceTx)await continuationSourceTx(tx);
 const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(!snapshot)return fail();
 const [selected]=await tx.execute<{id:string}>(sql`select p.id from public.ai_agent_promotion p join public.ai_agent_candidate c on c.id=p.candidate_id and c.tenant_id=p.tenant_id where p.tenant_id=${ctx.tenantId}::uuid and p.owner_user_id=${ctx.userId}::uuid and c.kind='assistant_answer_prompt_v1' and p.expires_at>clock_timestamp() and p.used_jobs<p.max_jobs and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id) order by p.created_at desc,p.id desc limit 1 for update of p nowait`);
 let strategy:AssistantConversationCandidate=ASSISTANT_CONVERSATION_BASELINE,promotionId:string|null=null,version=0,candidateDigest=conversationBaselineDigest;
 if(selected){const selectedPromotion=await currentConversationPromotionTx(tx,ctx,selected.id,snapshot.fingerprint);strategy=captureAssistantConversationCandidate(selectedPromotion.candidate.configuration);promotionId=selected.id;version=selectedPromotion.candidate.version;candidateDigest=selectedPromotion.candidate.candidate_digest;await tx.execute(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${selected.id}::uuid and tenant_id=${ctx.tenantId}::uuid`);}
 const id=randomUUID(),provenance=Object.freeze({mode:promotionId?'promoted' as const:'baseline' as const,version,configurationDigest:routingDigest(strategy)}),capability=Object.freeze({});
 const receipt=seal('conversation-use',ctx.tenantId,id,{version:1,userId:ctx.userId,personId:ctx.personId??null,promotionId,candidateDigest,providerFingerprint:snapshot.fingerprint,sourceDigest:MODULE_AGENT_SOURCE_DIGEST,questionDigest,provenance});
 const [created]=await tx.execute<{incarnation:string}>(sql`insert into public.ai_assistant_answer_strategy_use(id,tenant_id,user_id,person_id,promotion_id,candidate_digest,provider_fingerprint,source_digest,receipt) values(${id}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${ctx.personId??null}::uuid,${promotionId}::uuid,${candidateDigest},${snapshot.fingerprint},${MODULE_AGENT_SOURCE_DIGEST},${receipt}) returning incarnation::text as incarnation`);if(!created||!/^\d+$/.test(created.incarnation))return fail();
 const record:ConversationStrategyUse={ctx,id,incarnation:created.incarnation,promotionId,candidateDigest,providerFingerprint:snapshot.fingerprint,questionDigest,provenance};conversationStrategyUses.set(capability,record);
 const wrapped=withAiAdmissionCheck(configuration,'hr_assistant',async carrier=>{await recheckAssistantConversationStrategyTx(carrier,ctx,capability);if(continuationSourceTx)await continuationSourceTx(carrier);});
 return Object.freeze({configuration:wrapped,system:assistantConversationCandidateSystem(strategy),variant:strategy.variant,capability:capability as AssistantConversationStrategyCapability,provenance});
}
/** Rechecked before each provider round-trip and before the actual exchange insert. No missing or
 * erased metadata is recreated, no used-job count/native spend is refunded after uncertainty. */
export async function recheckAssistantConversationStrategyTx(tx:Tx,supplied:SessionContext,capability:AssistantConversationStrategyCapability){
 const use=conversationStrategyUses.get(capability);if(!use||strategyPrincipal(use.ctx)!==strategyPrincipal(supplied))return fail();const ctx=use.ctx,fresh=await guard(tx,ctx,false);await agentReleaseIntervalTx(tx,ctx,ctx.userId!,false);await signalIntervalTx(tx,ctx,ctx.userId!);const snapshot=await resolveAiProviderSnapshotTx(tx,fresh);if(snapshot?.fingerprint!==use.providerFingerprint)return fail();
 if(use.promotionId){const current=await currentConversationPromotionTx(tx,ctx,use.promotionId,use.providerFingerprint);if(current.candidate.candidate_digest!==use.candidateDigest)return fail();}
 const [row]=await tx.execute<{receipt:string;incarnation:string}>(sql`select receipt,incarnation::text as incarnation from public.ai_assistant_answer_strategy_use where id=${use.id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and person_id is not distinct from ${ctx.personId??null}::uuid and state='pending' and source_digest=${MODULE_AGENT_SOURCE_DIGEST} and expires_at>clock_timestamp() for share nowait`);if(!row||row.incarnation!==use.incarnation)return fail();const proof=open('conversation-use',ctx.tenantId,use.id,row.receipt);
 if(!exact(proof,['version','userId','personId','promotionId','candidateDigest','providerFingerprint','sourceDigest','questionDigest','provenance'])||proof.version!==1||proof.userId!==ctx.userId||proof.personId!==(ctx.personId??null)||proof.promotionId!==use.promotionId||proof.candidateDigest!==use.candidateDigest||proof.providerFingerprint!==use.providerFingerprint||proof.sourceDigest!==MODULE_AGENT_SOURCE_DIGEST||proof.questionDigest!==use.questionDigest||routingDigest(proof.provenance)!==routingDigest(use.provenance))return fail();return use.provenance;
}
/** Must run in the SAME top-level transaction that inserted the actual own exchange. Its source
 * row version and identity bind the marker; a historical/other-user exchange is never completion. */
export async function completeAssistantConversationStrategyTx(tx:Tx,ctx:SessionContext,capability:AssistantConversationStrategyCapability,exchangeId:string){
 if(!uuid(exchangeId))return fail();await recheckAssistantConversationStrategyTx(tx,ctx,capability);const use=conversationStrategyUses.get(capability)!;
 const [exchange]=await tx.execute<{current:boolean;question:string}>(sql`select xmin=pg_current_xact_id()::xid as current,question from public.assistant_exchange where id=${exchangeId}::uuid and tenant_id=${ctx.tenantId}::uuid and app_user_id=${ctx.userId}::uuid`);if(exchange?.current!==true||routingDigest([ctx.tenantId,ctx.userId,exchange.question])!==use.questionDigest)return fail();
 const rows=await tx.execute(sql`update public.ai_assistant_answer_strategy_use set state='completed',exchange_id=${exchangeId}::uuid where id=${use.id}::uuid and incarnation=${use.incarnation}::bigint and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and state='pending' returning id`);if(rows.length!==1)return fail();return use.provenance;
}
/** Identity-only retirement is separate from Assistant admission. Revocation does not trap custody. */
export async function eraseOwnConversationStrategyMetadata(ctx:SessionContext){const current=capture(ctx);return withTenant(current,async tx=>{await assertAiPrincipalTx(tx,current);await tx.execute(sql`select app.assistant_answer_invalidate_own_strategy_uses()`);await tx.execute(sql`delete from public.ai_assistant_answer_evaluation_arm where tenant_id=${current.tenantId}::uuid and evaluator_user_id=${current.userId}::uuid`);});}

/** Call only after withTenant's successful COMMIT (or to explicitly abandon a failed request). A
 * transaction rollback retains the opaque binding and pending DB marker for an honest retry; the
 * completed DB state already refuses reuse even before this in-memory retirement. */
export function retireAssistantConversationStrategyCapability(capability:AssistantConversationStrategyCapability):void{conversationStrategyUses.delete(capability);}

/** Compatibility for in-flight review callers; rollback applies to every candidate kind. */
export const rollbackRoutingAgent=rollbackAssistantPromotion;
