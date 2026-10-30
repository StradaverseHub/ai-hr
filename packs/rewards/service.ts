import type { Tx as AiReadTx } from '../../db/client';
import { withCanonicalAiReadTx } from '../../core/ai-read-transaction';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, or, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { appUser, assignment, businessUnit, company, compensation, domainEvent, employment, jobGrade, movementEventType, payrollBatch, payrollInput, performanceReview, reviewCycle, person, rewardCalendar, rewardCycle, rewardDecision, rewardEntry, rewardMember, rewardUnit, rewardGovernance, rewardGovernanceHistory, rewardSeniorEvidence, rewardGovernancePublic, rewardSeniorAward } from '../../db/schema';
import { assertModuleGate, withRewardsTenant } from '../../core/module-gate';
import { setCompensation } from '../../core/comp';
import { setEmploymentGrade } from '../../core/org';
import { lockLeaveDependencyConfigurationTx, lockLeaveDependenciesTx } from '../../core/leave-dependency-lock';
import { setPayrollInput } from '../payroll/service';
import { todayInKualaLumpur } from '../../lib/hr-date';
import type { PackTaskItem } from '../../lib/assigned-work';
import { calculateRewards, ratio, increase, type RewardMultiplierSuggestion } from './engine';
import { emptyGovernance, effectiveRewardPolicy, poolStatus, unitInputSchema, confirmedSeniorAwards, seniorGrade, maySeeSeniorAmounts, redactPatPolicy, seniorAwardSchema, governanceBasis,governanceHistoryProjection,seniorSourceFingerprint,type RewardPublicGovernance,type RewardGovernance, type SeniorAward } from './governance-model';
import { assertRewardPolicyGrids } from './policy-grid-validation';
import { onehrRewardResultTx } from '../performance/service';
import { decisionActorRole, factsFromOnehr, isSeniorPlanMember, returnedState } from './model';
import {rewardPolicyForReviewTx} from './policy-groups';
import { deriveConfidentialityTx, sourceWithFloor } from './confidentiality';
export {rewardCompanyExclusions,changeRewardCompanyExclusion,rewardPolicyHistory,rewardPolicyHiddenCount} from './shared-governance';
export type {RewardCompanyExclusion,RewardPolicyHistory} from './shared-governance';
export {rewardPolicyMemberships,rewardPolicyTaken,saveRewardPolicyGroup,listRewardPolicyGroups,rewardSharedPolicyChoices,rewardPolicyGroupUsage,RewardPolicyGroupError} from './policy-groups';
export type {RewardPolicyTaken,RewardSharedChoice,RewardPolicySummary} from './policy-groups';
import { calculateOffcycle, offcycleRoute, offcycleTransition, type Funding } from './offcycle';
import { applyConfidentialityFloor, belowConfidentialityFloor, bpSchema, canEditStage, defaultPolicy, emptyFacts, emptyRecommendation, factsSchema, isoDateSchema, policySchema, recommendationSchema, rewardRoles, transition, visibleEntry, type RewardEntry, type RewardFacts, type RewardPolicy, type RewardRole, type RewardSource } from './model';

import { emptyRewardCalendar, rewardCalendarSchema, rewardDaysUntil, rewardNextSeat, rewardRouteProgress, rewardStageDue, rewardStageSeat, rewardStageStep, type RewardCalendarValues, type RewardRouteStep } from './calendar';
export { rewardCalendarStages, rewardOffcycleSlaStages, emptyRewardCalendar, rewardDueWording, rewardNextSeat, rewardRouteProgress } from './calendar';
export type { RewardCalendarValues, RewardCalendarStage, RewardOffcycleSlaStage, RewardRouteStep } from './calendar';
import {changeRewardMember} from './maintenance';
export {rewardAccessSingleAdminCompanies,rewardAccessRequests,decideRewardAccessRequest,rewardAccessAdministration,previewRewardAccessChange,saveRewardAccessChange,rewardDeletionEligibility,deleteRewardReview,RewardMaintenanceError} from './maintenance';
export type {RewardAccessRequest,RewardAccessChange,RewardAccessAdministration,RewardDeletionReason} from './maintenance';
export {previewRewardAccessBatch,saveRewardAccessBatch,previewRewardAccessCopy} from './maintenance';
export type {RewardAccessBatch,RewardAccessCopyProposal} from './maintenance';
import {activeRewardLogin,missingRewardRoles,rewardRequiredRoles,rewardRoleLabels,rewardUnitCoverage} from './coverage';
export {rewardRoleLabels,rewardRequiredRoles,rewardUnitCoverage} from './coverage';
export type {RewardUnitCoverage,RewardRoleCoverage} from './coverage';
/** cd72f915 — required-role coverage for the configuration list's "roles missing" badge (same predicate as submission). */
export async function rewardCoverageForUnits(ctx: SessionContext, unitIds: string[]) { return withRewardsTenant(ctx, tx => rewardUnitCoverage(tx, unitIds)); }

export { calculateRewards } from './engine';
export { defaultPolicy } from './model';
export class RewardError extends Error { constructor(message: string) { super(message); this.name = 'RewardError'; } }
const idSchema = z.uuid();
// Match the canonical catalogue display used by setup and shared policy targets. Legacy name is
// retained data, not an alternative label for the same unit once a review has been created.
const businessUnitDisplayName = sql<string>`coalesce(nullif(trim(${businessUnit.label}),''),${businessUnit.code})`;
const moneyToCents = (v: string) => Math.round(Number(v) * 100);
const digest = (unit: typeof rewardUnit.$inferSelect, entries: RewardEntry[]) => createHash('sha256').update(JSON.stringify({ policy: unit.policy, kind: unit.kind, parentUnitId: unit.parentUnitId, offcycle: unit.offcycle, entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)).map(e => ({ id: e.id, source: e.source, facts: e.facts, recommendation: e.recommendation })) })).digest('hex');

async function rolesFor(tx: Tx, unitId: string): Promise<RewardRole[]> {
  const result = await tx.execute<{ role: RewardRole }>(sql`select app.reward_roles(${unitId}::uuid) as role`);
  return result.map(r => r.role);
}
/** Reads are internal calculation inputs; outbound projections below redact private facts by role. */
async function governanceStateTx(tx:Tx,unitId:string):Promise<RewardGovernance|null>{
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regclass('public.reward_governance') is not null as ready`);
 if(!ready?.ready)return null;
 const [row]=await tx.select().from(rewardGovernance).where(eq(rewardGovernance.unitId,unitId));
 return row?.state??null;
}
async function governancePublicTx(tx:Tx,unitId:string):Promise<RewardPublicGovernance|null>{
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regclass('public.reward_governance_public') is not null as ready`);if(!ready?.ready)return null;
 const [row]=await tx.select().from(rewardGovernancePublic).where(eq(rewardGovernancePublic.unitId,unitId));return row?.snapshot??null;
}
async function seniorAwardsTx(tx:Tx,unitId:string,posting=false):Promise<Record<string,SeniorAward>>{
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regclass('public.reward_senior_award') is not null as ready`);if(!ready?.ready)return {};
 if(posting){const [row]=await tx.execute<{awards:Record<string,SeniorAward>}>(sql`select app.reward_senior_awards_for_post(${unitId}::uuid) as awards`);return row?.awards??{};}
 return Object.fromEntries((await tx.select().from(rewardSeniorAward).where(eq(rewardSeniorAward.unitId,unitId))).map(row=>[row.entryId,row.award]));
}
async function projectGovernanceTx(tx:Tx,ctx:SessionContext,unitId:string,state:RewardGovernance){
 const [unit]=await tx.select().from(rewardUnit).where(eq(rewardUnit.id,unitId)),entries=await tx.select().from(rewardEntry).where(eq(rewardEntry.unitId,unitId)).orderBy(asc(rewardEntry.id));
 const policy=effectiveRewardPolicy(unit.policy,state),result=calculateRewards(entries,policy,{poolStatus:poolStatus(state),seniorAwards:confirmedSeniorAwards(state,entries)});
 const snapshot:RewardPublicGovernance={status:poolStatus(state),pools:{standard:result.budgets.standard.bonusPoolCents,h:result.budgets.h.bonusPoolCents},targetMonthsBp:policy.targetMonthsBp,multiplierBp:policy.bonusStructure==='branch'?10000:policy.multiplierBp,branchRatings:policy.branchRatings,selectionConfirmed:!!state.selection?.confirmedBy,previousPools:state.previousPools,basis:governanceBasis(unit.policy,entries)};
 await tx.insert(rewardGovernancePublic).values({tenantId:ctx.tenantId,unitId,snapshot}).onConflictDoUpdate({target:rewardGovernancePublic.unitId,set:{snapshot}});
 // Derived amount projection has stricter SELECT custody than the public budget snapshot.
 await tx.delete(rewardSeniorAward).where(eq(rewardSeniorAward.unitId,unitId));
 for(const [entryId,award]of Object.entries(state.awards))await tx.insert(rewardSeniorAward).values({tenantId:ctx.tenantId,unitId,entryId,award});
}
async function saveGovernanceTx(tx:Tx,ctx:SessionContext,unitId:string,before:RewardGovernance|null,after:RewardGovernance,kind:string,reason:string){
 const actor=idSchema.parse(ctx.userId);
 await tx.insert(rewardGovernance).values({tenantId:ctx.tenantId,unitId,state:after}).onConflictDoUpdate({target:rewardGovernance.unitId,set:{state:after,updatedAt:new Date()}});
 await tx.insert(rewardGovernanceHistory).values({tenantId:ctx.tenantId,unitId,actorId:actor,kind,reason,before,after});
 const [savedUnit]=await tx.select({policy:rewardUnit.policy}).from(rewardUnit).where(eq(rewardUnit.id,unitId));
 await tx.update(rewardUnit).set({policy:{...savedUnit.policy,unitGovernanceDigest:createHash('sha256').update(JSON.stringify(after)).digest('hex')}}).where(eq(rewardUnit.id,unitId));
 await projectGovernanceTx(tx,ctx,unitId,after);
 await touch(tx,unitId);
 // Monetary before/after is retained in the private history, never generic notification payloads.
 await stamp(tx,ctx,unitId,kind,{privateHistory:true});
}
function governanceAuthority(unit:typeof rewardUnit.$inferSelect,roles:RewardRole[],revision:number){
 assertRevision(unit,revision);assertUnlocked(unit);
 if(unit.kind!=='annual'||!roles.includes('gr'))throw new RewardError('Group Rewards access to a draft annual review is required.');
}
function reasonForGovernance(reason:string){return z.string().trim().min(10).max(2000).parse(reason);}
export async function getRewardUnitGovernance(ctx:SessionContext,unitId:string){
 return withRewardsTenant(ctx,async tx=>{
  const {unit,roles,entries}=await load(tx,unitId),state=await governanceStateTx(tx,unitId),publicState=await governancePublicTx(tx,unitId),effective=effectiveRewardPolicy(unit.policy,state),awardProjection=await seniorAwardsTx(tx,unitId);
  const calculated=await calculateUnit(tx,unit,entries);
  const visible=entries.filter(entry=>visibleEntry(entry,roles,ctx.personId)),senior=visible.filter(entry=>isSeniorPlanMember(unit.policy,entry.facts,entry.source.grade));
  const canAmounts=maySeeSeniorAmounts(roles),isGr=roles.includes('gr');
  const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regclass('public.reward_governance') is not null as ready`);
  return {unitId,revision:unit.revision,canEdit:isGr&&unit.status==='draft'&&unit.kind==='annual',isGr,canAmounts,managed:!!publicState,
   available:ready?.ready===true,legacyInputs:isGr?{forecastCents:null,actualCents:unit.policy.patActual,targetCents:unit.policy.patTarget,targetMonthsBp:unit.policy.targetMonthsBp,multiplierBp:unit.policy.bonusStructure==='branch'?10000:unit.policy.multiplierBp,branchRatings:unit.policy.branchRatings}:null,
   poolStatus:publicState?.status??'legacy',inputs:isGr?(state?.inputs??null):null,selection:isGr?state?.selection??null:null,
   exemption:isGr?state?.exemption??null:null,previousPools:publicState?.previousPools??null,
   pools:{standard:calculated.budgets.standard.bonusPoolCents,h:calculated.budgets.h.bonusPoolCents},
   branches:isGr?[...new Set(entries.filter(entry=>entry.facts.branch).map(entry=>entry.facts.branch))].sort():[],
   senior:senior.map(entry=>({entryId:entry.id,employmentId:entry.employmentId,name:entry.source.name,employeeCode:entry.source.employeeCode,grade:entry.source.grade,
    basicCents:canAmounts?entry.source.basicCents:null,award:canAmounts?awardProjection[entry.id]??null:null,awaiting:!awardProjection[entry.id]?.confirmedBy})),
   totals:canAmounts?{count:senior.length,incrementCents:senior.reduce((n,e)=>n+Math.max(0,(awardProjection[e.id]?.confirmedBy?awardProjection[e.id].newBasicCents:e.source.basicCents)-e.source.basicCents),0),bonusCents:senior.reduce((n,e)=>n+(awardProjection[e.id]?.confirmedBy?awardProjection[e.id].bonusCents:0),0)}:null,
   history:isGr&&ready?.ready?(await tx.select({id:rewardGovernanceHistory.id,kind:rewardGovernanceHistory.kind,reason:rewardGovernanceHistory.reason,actorId:rewardGovernanceHistory.actorId,actorName:person.fullName,createdAt:rewardGovernanceHistory.createdAt,before:rewardGovernanceHistory.before,after:rewardGovernanceHistory.after}).from(rewardGovernanceHistory).leftJoin(appUser,eq(appUser.id,rewardGovernanceHistory.actorId)).leftJoin(person,eq(person.id,appUser.personId)).where(eq(rewardGovernanceHistory.unitId,unitId)).orderBy(desc(rewardGovernanceHistory.createdAt),desc(rewardGovernanceHistory.id))).map(event=>({...event,before:governanceHistoryProjection(event.before,visible),after:governanceHistoryProjection(event.after,visible)})):[],
  };
 });
}
export async function saveRewardUnitInputs(ctx:SessionContext,unitId:string,revision:number,raw:unknown,reason:string){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const inputs=unitInputSchema.parse(raw),why=reasonForGovernance(reason);
 return withRewardsTenant(ctx,async tx=>{
  const {unit,roles,entries}=await load(tx,unitId,true);governanceAuthority(unit,roles,revision);
  if(unit.policy.bonusStructure==='branch'&&inputs.multiplierBp!==10000)throw new RewardError('PPCH unit multiplier must be fixed at 1.00.');
  const before=await governanceStateTx(tx,unitId),prior=before??emptyGovernance(),oldPublic=await governancePublicTx(tx,unitId),old=calculateRewards(entries,effectiveRewardPolicy(unit.policy,before));
  const after:RewardGovernance={...prior,inputs,previousPools:{standard:old.budgets.standard.bonusPoolCents,h:old.budgets.h.bonusPoolCents}};
  await saveGovernanceTx(tx,ctx,unitId,before,after,'unit-inputs-updated',why);
  const currentPublic=await governancePublicTx(tx,unitId);
  if(oldPublic?.status!==currentPublic?.status||!isDeepStrictEqual(oldPublic?.pools,currentPublic?.pools))await stamp(tx,ctx,unitId,'final-pool-changed',{revision:revision+1});
 });
}
export async function proposeRewardExemption(ctx:SessionContext,unitId:string,revision:number,reason:string){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const why=reasonForGovernance(reason);
 return withRewardsTenant(ctx,async tx=>{
  const {unit,roles}=await load(tx,unitId,true);governanceAuthority(unit,roles,revision);
  const before=await governanceStateTx(tx,unitId),after={...(before??emptyGovernance()),exemption:{reason:why,proposedBy:idSchema.parse(ctx.userId),confirmedBy:null,confirmedAt:null}};
  await saveGovernanceTx(tx,ctx,unitId,before,after,'exemption-proposed',why);
 });
}
export async function confirmRewardGovernance(ctx:SessionContext,unitId:string,revision:number,kind:'selection'|'exemption'|'award',entryId?:string){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 return withRewardsTenant(ctx,async tx=>{
  const {unit,roles,entries}=await load(tx,unitId,true);governanceAuthority(unit,roles,revision);
  const before=await governanceStateTx(tx,unitId);if(!before)throw new RewardError('There is no pending decision to confirm.');
  const after:RewardGovernance=structuredClone(before),decision=kind==='selection'?after.selection:kind==='exemption'?after.exemption:entryId?after.awards[entryId]:null;
  if(!decision||decision.confirmedBy)throw new RewardError('There is no pending decision to confirm.');
  if(decision.proposedBy===ctx.userId)throw new RewardError('A different Group Rewards user must check this decision.');
  if(kind==='award'){
   const entry=entries.find(entry=>entry.id===entryId);if(!entry||!visibleEntry(entry,roles,ctx.personId)||!isSeniorPlanMember(unit.policy,entry.facts,entry.source.grade))throw new RewardError('This Senior plan entry is not available.');
   const award=after.awards[entry.id];if(award.sourceFingerprint!==seniorSourceFingerprint(entry))throw new RewardError('Employee salary or grade changed. Enter and check the offline decision again.');
   if(award.newBasicCents<entry.source.basicCents)throw new RewardError('The approved salary must not be below the current salary.');
   const [fresh]=await tx.execute<{current:boolean}>(sql`select app.reward_senior_source_current(${unitId}::uuid,${entry.id}::uuid) as current`);
   if(!fresh?.current)throw new RewardError('Salary data changed after the snapshot. Return and refresh the review.');
  }
  decision.confirmedBy=idSchema.parse(ctx.userId);decision.confirmedAt=new Date().toISOString();
  await saveGovernanceTx(tx,ctx,unitId,before,after,`${kind}-confirmed`,'Independently checked and confirmed');
 });
}
export async function saveRewardSeniorAward(ctx:SessionContext,unitId:string,revision:number,raw:unknown){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const input=seniorAwardSchema.parse(raw);
 return withRewardsTenant(ctx,async tx=>{
  const {unit,roles,entries}=await load(tx,unitId,true);governanceAuthority(unit,roles,revision);
  const entry=entries.find(entry=>entry.id===input.entryId);
  if(!entry||!visibleEntry(entry,roles,ctx.personId)||!isSeniorPlanMember(unit.policy,entry.facts,entry.source.grade)||!seniorGrade(entry.source.grade))throw new RewardError('Select an eligible Senior plan member first.');
  const newBasicCents=input.newBasicCents??entry.source.basicCents+increase(entry.source.basicCents,input.incrementBp!);
  if(newBasicCents<entry.source.basicCents)throw new RewardError('The new basic salary must not be lower than the current salary.');
  const before=await governanceStateTx(tx,unitId),after:RewardGovernance=structuredClone(before??emptyGovernance());
  if(!after.selection?.confirmedBy)throw new RewardError('A second Group Rewards user must confirm Senior membership before amount entry.');
  const evidence:SeniorAward['evidence']=[...(after.awards[entry.id]?.evidence??[])];
  let evidenceBytes=0;
  for(const file of input.evidence){
   if(!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content))throw new RewardError('Invalid evidence file.');
   const bytes=Buffer.from(file.content,'base64');evidenceBytes+=bytes.length;if(evidenceBytes>10*1024*1024)throw new RewardError('Evidence files exceed the total upload limit.');if(!bytes.length||bytes.length>10*1024*1024)throw new RewardError('Evidence must be a nonempty PDF, PNG or JPEG of at most 10 MB.');
   if(file.mime==='application/pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))||file.mime==='image/png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||file.mime==='image/jpeg'&&!(bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw new RewardError('Evidence file contents do not match the supported format.');
   const id=randomUUID();await tx.insert(rewardSeniorEvidence).values({id,tenantId:ctx.tenantId,unitId,entryId:entry.id,uploadedBy:idSchema.parse(ctx.userId),name:file.name,mime:file.mime,content:file.content});
   evidence.push({id,name:file.name,mime:file.mime,size:bytes.length});
  }
  after.awards[entry.id]={newBasicCents,sourceFingerprint:seniorSourceFingerprint(entry),bonusCents:input.bonusCents,approvalDate:input.approvalDate,approvalReference:input.approvalReference,reason:input.reason,evidence,proposedBy:idSchema.parse(ctx.userId),confirmedBy:null,confirmedAt:null};
  await saveGovernanceTx(tx,ctx,unitId,before,after,'senior-award-proposed',input.reason);
 });
}
export async function readRewardSeniorEvidence(ctx:SessionContext,unitId:string,evidenceId:string){
 idSchema.parse(evidenceId);
 return withRewardsTenant(ctx,async tx=>{
  const {roles,entries}=await load(tx,unitId);if(!maySeeSeniorAmounts(roles))throw new RewardError('Senior plan evidence is restricted.');
  const [file]=await tx.select().from(rewardSeniorEvidence).where(and(eq(rewardSeniorEvidence.unitId,unitId),eq(rewardSeniorEvidence.id,evidenceId)));
  const entry=file&&entries.find(entry=>entry.id===file.entryId);if(!file||!entry||!visibleEntry(entry,roles,ctx.personId))throw new RewardError('Evidence is not available.');
  return {name:file.name,mime:file.mime,content:file.content};
 });
}

async function funding(tx: Tx, unitId: string, lock = false): Promise<Funding & { duplicate: boolean }> {
  const [r] = await tx.execute<{ value: Funding & { duplicate: boolean } }>(sql`select app.reward_funding(${unitId}::uuid, ${lock}) as value`);
  return r.value;
}
async function calculateUnit(tx: Tx, unit: typeof rewardUnit.$inferSelect, entries: RewardEntry[],posting=false) {
  if (unit.kind === 'annual') {
    const state=await governanceStateTx(tx,unit.id),publicState=await governancePublicTx(tx,unit.id),awards=await seniorAwardsTx(tx,unit.id,posting);
    const calculationState=state?{...state,awards}: {...emptyGovernance(),awards};
    const policy=state?effectiveRewardPolicy(unit.policy,state):publicState?{...unit.policy,patActual:0,patTarget:100,targetMonthsBp:publicState.targetMonthsBp,multiplierBp:publicState.multiplierBp,branchRatings:publicState.branchRatings,exemptReason:''}:unit.policy;
    const result=calculateRewards(entries,policy,{poolStatus:publicState?.status??'legacy',...(publicState?{bonusPools:publicState.pools}:{}),seniorAwards:confirmedSeniorAwards(calculationState,entries)});
    if(publicState&&publicState.basis!==governanceBasis(unit.policy,entries))result.flags.push({severity:'block',code:'PAT-STALE',message:'Eligibility or employee source facts changed. Group Rewards must review and refresh the unit budget inputs.'});
    return result;
  }
  const available = await funding(tx, unit.id);
  const result = calculateOffcycle(entries, unit.policy, unit.kind, unit.offcycle!, available);
  if (available.duplicate) result.flags.push({ severity: 'block', code: 'OC-12', message: 'An employee already has an open off-cycle request against this annual review.' });
  return result;
}
/**
 * Who may post a fully approved review to payroll (H1). The ONE owner of this rule: postRewardUnit's guard
 * and the review page's Post button both ask it, so the button can never offer what the guard refuses.
 * Posting needs BOTH the unit's payroll seat AND fresh company HR administration, because the salary and
 * grade writers it calls are administrator-owned. Who MAY post is unchanged here (DR-13 is not decided).
 */
export type RewardPostingAuthority = 'allowed' | 'no-seat' | 'needs-admin';
async function rewardPostingAuthorityTx(tx: Tx, unit: { companyId: string }, roles: readonly RewardRole[]): Promise<RewardPostingAuthority> {
  if (!roles.includes('payroll')) return 'no-seat';
  const [r] = await tx.execute<{ ok: boolean }>(sql`select app.reward_admin(${unit.companyId}::uuid) as ok`);
  return r?.ok ? 'allowed' : 'needs-admin';
}
/** The posting predicate for a caller without a transaction. True only when postRewardUnit's guard passes. */
export async function canPostRewardUnit(ctx: SessionContext, unitId: string): Promise<boolean> {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles } = await load(tx, unitId);
    return (await rewardPostingAuthorityTx(tx, unit, roles)) === 'allowed';
  });
}
/** Assistant shortcut OFFER only, never a grant: does this login currently administer Rewards for any
 * company in its tenant? Same app.reward_admin predicate every Rewards administrator writer and the
 * Assistant posting review require. Read-only; a failure throws and the caller keeps the link hidden. */
export async function administersRewardsForAnyCompany(ctx: SessionContext): Promise<boolean> {
  return withRewardsTenant(ctx, async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [r] = await tx.execute<{ ok: boolean }>(sql`select exists(select 1 from public.company c where c.tenant_id=app.current_tenant_id() and app.reward_admin(c.id)) as ok`);
    return r?.ok === true;
  });
}
async function requireAdmin(tx: Tx, companyId: string) {
  const [r] = await tx.execute<{ ok: boolean }>(sql`select app.reward_admin(${companyId}::uuid) as ok`);
  if (!r?.ok) throw new RewardError('Company administrator access is required.');
}
async function load(tx: Tx, unitId: string, lock = false) {
  idSchema.parse(unitId);
  const query = tx.select().from(rewardUnit).where(eq(rewardUnit.id, unitId));
  const [unit] = await (lock ? query.for('update') : query);
  if (!unit || unit.deletedAt) throw new RewardError('Reward unit not found or access has been removed.');
  const roles = await rolesFor(tx, unitId);
  if (!roles.length) throw new RewardError('Ask an administrator to assign your Reward Desk role for this unit.');
  const entries = await tx.select().from(rewardEntry).where(eq(rewardEntry.unitId, unitId)).orderBy(asc(rewardEntry.id));
  return { unit, roles, entries };
}
function assertRevision(unit: typeof rewardUnit.$inferSelect, revision: number) {
  if (!Number.isInteger(revision) || unit.revision !== revision) throw new RewardError('This review changed in another session. Reload before saving.');
}
function assertUnlocked(unit: typeof rewardUnit.$inferSelect) {
  if (unit.status !== 'draft') throw new RewardError('Return the unit to draft before changing its approved inputs.');
}
async function stamp(tx: Tx, ctx: SessionContext, unitId: string, event: string, payload: Record<string, unknown> = {}, returnEventId = false, eventId?: string) {
  return appendEvent(tx, { id: eventId, tenantId: ctx.tenantId, aggregateType: 'reward-unit', aggregateId: unitId, eventType: `reward-unit.${event}`, actor: actorOf(ctx), payload }, {returnId:returnEventId});
}
async function touch(tx: Tx, unitId: string) {
  await tx.update(rewardUnit).set({ revision: sql`${rewardUnit.revision}+1`, approvedDigest: null, updatedAt: new Date() }).where(eq(rewardUnit.id, unitId));
}

/**
 * Approval history, newest first by (created_at DESC, id DESC). Reads only rows reward_decision RLS
 * already grants this viewer. The actor's name is joined through person RLS (never widened): when the
 * viewer cannot read that person, the screen falls back to the actor's Reward Desk role on this unit.
 */
async function decisionHistory(tx: Tx, unitId: string, members: { role: string; userId: string }[]) {
  const rows = await tx.select({ id: rewardDecision.id, action: rewardDecision.action, fromStage: rewardDecision.fromStage, toStage: rewardDecision.toStage, actorId: rewardDecision.actorId, actorName: person.fullName, reason: rewardDecision.reason, createdAt: rewardDecision.createdAt, revision: rewardDecision.revision })
    .from(rewardDecision).leftJoin(appUser, eq(appUser.id, rewardDecision.actorId)).leftJoin(person, eq(person.id, appUser.personId))
    .where(eq(rewardDecision.unitId, unitId)).orderBy(desc(rewardDecision.createdAt), desc(rewardDecision.id));
  return rows.map(d => ({ ...d, actorRole: decisionActorRole(d.fromStage, members.filter(m => m.userId === d.actorId).map(m => m.role as RewardRole)) }));
}
type DecisionRow = Awaited<ReturnType<typeof decisionHistory>>[number];
function returnedProjection(unit: typeof rewardUnit.$inferSelect, latest: DecisionRow | undefined) {
  const state = returnedState(unit.status, latest, unit.offcycle?.bgOrigin === true);
  return state && latest ? { reason: state.reason, at: state.at, fromStage: state.fromStage, toSeat: state.toSeat, actorName: latest.actorName ?? null, actorRole: latest.actorRole } : null;
}

/** The full pay-bearing review projection. Never return hidden internal entries or EC aggregates. */
export async function getRewardUnit(ctx: SessionContext, unitId: string) {
  await withRewardsTenant(ctx,tx=>tx.execute(sql`select app.reward_access_observe(${unitId}::uuid)`));
  return withRewardsTenant(ctx, tx => reviewProjectionTx(tx, ctx, unitId));
}
/**
 * The review read path. getRewardUnit and the Approvals board (rewardApprovalsBoard) both read a review
 * through this one function, so membership, entry visibility (visibleEntry, including the own-person
 * exclusion) and flag filtering are decided in one place.
 */
async function reviewProjectionTx(tx: Tx, ctx: SessionContext, unitId: string) {
  {
    const { unit, roles, entries } = await load(tx, unitId);
    const calculated = await calculateUnit(tx, unit, entries);
    const state=await governanceStateTx(tx,unitId),publicState=await governancePublicTx(tx,unitId),effectivePolicy=state?effectiveRewardPolicy(unit.policy,state):publicState?{...unit.policy,multiplierBp:publicState.multiplierBp,branchRatings:publicState.branchRatings,targetMonthsBp:publicState.targetMonthsBp}:unit.policy;
    if(publicState&&!publicState.selectionConfirmed&&roles.includes('bu')&&!roles.includes('gr'))throw new RewardError('Senior plan membership awaits independent Group Rewards confirmation before the BU review can open.');
    const visible = calculated.rows.filter(e => visibleEntry(e, roles, ctx.personId)).map(entry=>{
      if(maySeeSeniorAmounts(roles)||!isSeniorPlanMember(unit.policy,entry.facts,entry.source.grade))return entry;
      return {...entry,recommendation:emptyRecommendation(),newBasicCents:entry.source.basicCents,bonusCents:0,meritCents:0,promotionCents:0,specialCents:0,lumpCents:0};
    });
    const visibleIds = new Set(visible.map(e => e.id));
    const flags = calculated.flags.filter(f => !f.entryId || visibleIds.has(f.entryId));
    const hiddenBlocks = calculated.flags.filter(f => f.entryId && !visibleIds.has(f.entryId) && f.severity === 'block').length;
    if (hiddenBlocks) flags.push({ severity: 'block', code: 'ACCESS-01', message: 'A restricted record needs review by its authorised reviewer.' });
    const [cycle] = await tx.select().from(rewardCycle).where(eq(rewardCycle.id, unit.cycleId));
    const [bu] = await tx.select({ name: businessUnitDisplayName }).from(businessUnit).where(eq(businessUnit.id, unit.businessUnitId));
    // 9070acae: a review is always one company and one unit; the page names both on every save.
    const [co] = await tx.select({ name: company.legalName }).from(company).where(eq(company.id, unit.companyId));
    const members = await tx.select({ id: rewardMember.id, role: rewardMember.role, userId: rewardMember.userId }).from(rewardMember).where(eq(rewardMember.unitId, unitId)).orderBy(asc(rewardMember.role), asc(rewardMember.userId));
    const decisions = await decisionHistory(tx, unitId, members);
    const returned = returnedProjection(unit, decisions[0]);
    const route: RewardRole[] = unit.kind === 'annual' ? ['bu', 'bg', 'gr', 'ctro', 'ec'] : offcycleRoute(unit.kind, unit.offcycle!, entries);
    // The latest decision is the one that moved the review to its current step (or returned it).
    const entered = decisions[0] && decisions[0].toStage === unit.status ? todayInKualaLumpur(new Date(decisions[0].createdAt)) : null;
    const calendar = await calendarTx(tx, unit.cycleId, unit.companyId);
    const due = rewardStageDue(calendar, { kind: unit.kind, status: unit.status, returned: !!returned, enteredOn: entered });
    // The payroll step's calendar date, whatever the current step (annual only; an off-cycle request has none).
    const payrollDue = rewardStageDue(calendar, { kind: unit.kind, status: 'approved', returned: false, enteredOn: null });
    // EC totals are derived ONLY from the rows the viewer may see (including the own-person exclusion).
    const ecRows = visible.filter(e => e.plan === 'ec');
    const bonusCounts = (plan: 'standard' | 'h') => {
      const group = calculated.rows.filter(e => e.plan === plan&&!isSeniorPlanMember(unit.policy,e.facts,e.source.grade));
      // Do not infer confidential category membership from the visible subset or expose hidden counts.
      if (group.some(e => !visibleIds.has(e.id))) return null;
      return { eligible: group.filter(e => e.bonusEligible).length,
        increases: group.filter(e => e.bonusCents > e.standardBonusCents).length,
        reductions: group.filter(e => e.bonusCents < e.standardBonusCents).length,
        lump: group.filter(e => e.lumpCents > 0).length };
    };
    // 8ad87ae8: people left out of the salary-increase base for a pay change, under the same hidden-record rule.
    const payWindow = (plan: 'standard' | 'h') => calculated.rows.some(e => e.plan === plan && !visibleIds.has(e.id)) ? null
      : { count: calculated.budgets[plan].excludedCount, payrollCents: calculated.budgets[plan].excludedPayrollCents };
    // 4e3e1af7: who withheld the unit lump sum and when; the name only where the viewer may see that person.
    const [lumpDecision] = unit.policy.lumpUnitCents === 0 ? await tx.select({ at: domainEvent.occurredAt, actorName: person.fullName }).from(domainEvent)
      .leftJoin(appUser, eq(appUser.id, domainEvent.actorId)).leftJoin(person, and(eq(person.id, appUser.personId), visibleSeatHolder))
      .where(and(eq(domainEvent.aggregateType, 'reward-unit'), eq(domainEvent.aggregateId, unitId), eq(domainEvent.eventType, 'reward-unit.lump-updated'))).orderBy(desc(domainEvent.occurredAt)).limit(1) : [];
    return { unit:{...unit,policy:redactPatPolicy(effectivePolicy,roles)}, poolStatus:publicState?.status??'legacy',seniorAmountsVisible:maySeeSeniorAmounts(roles), cycle, route, due, payrollDue, name: bu?.name ?? 'Business unit', companyName: co?.name ?? '', roles, members, decisions, returned,
      rows: visible, flags, hiddenCount: entries.length - visible.length,
      budgets: { standard: calculated.budgets.standard, h: calculated.budgets.h },
      bonusCounts: { standard: bonusCounts('standard'), h: bonusCounts('h') },
      payWindow: { standard: payWindow('standard'), h: payWindow('h') },
      lumpDecision: unit.policy.lumpUnitCents === 0 ? { at: lumpDecision ? todayInKualaLumpur(new Date(lumpDecision.at)) : null, actorName: lumpDecision?.actorName ?? null, reason: unit.policy.lumpReason ?? null } : null,
      ec: roles.some(r => ['gr', 'ctro', 'ec'].includes(r)) ? { count: ecRows.length, referenceCents: Math.round(ecRows.reduce((v, e) => v + e.source.basicCents, 0) * .07), incrementCents: ecRows.reduce((v, e) => v + e.newBasicCents - e.source.basicCents, 0), bonusCents: ecRows.reduce((v, e) => v + e.bonusCents + e.lumpCents, 0) } : null,
      suggestedLumpCents: calculated.suggestedLumpCents, lumpUnitCents: calculated.lumpUnitCents,
      suggestedMultiplierBp: calculated.suggestedMultiplierBp, suggestion: (roles.includes('gr')&&'suggestion' in calculated ? calculated.suggestion : null) as RewardMultiplierSuggestion | null, lumpWorking: calculated.lumpWorking,
      canEdit: canEditStage(unit.status, roles) || unit.kind !== 'annual' && unit.status === 'draft' && roles.includes('bg'), canConfigure: roles.includes('gr') && unit.status === 'draft' && unit.kind === 'annual',
      posting: await rewardPostingAuthorityTx(tx, unit, roles),
    };
  }
}

// Latest decision by (created_at DESC, id DESC), read through reward_decision RLS: a viewer who cannot
// read the unit's decisions sees no Returned state rather than a widened read.
const latestDecisionActionSql = sql<string | null>`(select d.action from reward_decision d where d.unit_id=${rewardUnit.id} order by d.created_at desc, d.id desc limit 1)`;
/** Derived Returned seat for list rows: null unless the draft's latest decision is a return. */
const returnedSeatSql = sql<'bu' | 'bg' | null>`case when ${rewardUnit.status}='draft' and ${latestDecisionActionSql}='return' then case when ${rewardUnit.offcycle}->>'bgOrigin'='true' then 'bg' else 'bu' end end`;

/**
 * Reviews returned to a seat the viewer holds (the BU CEO, or the BG CEO for a BG-originated off-cycle
 * request). The reason is the one reward_decision RLS already lets this viewer read; no pay is returned.
 */
export async function returnedRewardUnits(ctx: SessionContext, companyIds?: string[]) {
  return withRewardsTenant(ctx, async tx => {
    if (companyIds && !companyIds.length) return [];
    const rows = await tx.select({ id: rewardUnit.id, kind: rewardUnit.kind, name: businessUnitDisplayName, cycle: rewardCycle.name, toSeat: returnedSeatSql })
      .from(rewardUnit).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId))
      .where(and(isNull(rewardUnit.deletedAt), eq(rewardUnit.status, 'draft'), ...(companyIds ? [inArray(rewardUnit.companyId, companyIds)] : []),
        sql`${latestDecisionActionSql}='return'`,
        sql`(case when ${rewardUnit.offcycle}->>'bgOrigin'='true' then 'bg' else 'bu' end) in (select app.reward_roles(${rewardUnit.id}))`))
      .orderBy(asc(rewardUnit.updatedAt), asc(rewardUnit.id));
    const out = [];
    for (const row of rows) {
      const [latest] = await tx.select({ action: rewardDecision.action, fromStage: rewardDecision.fromStage, toStage: rewardDecision.toStage, reason: rewardDecision.reason, actorId: rewardDecision.actorId, actorName: person.fullName, createdAt: rewardDecision.createdAt })
        .from(rewardDecision).leftJoin(appUser, eq(appUser.id, rewardDecision.actorId)).leftJoin(person, eq(person.id, appUser.personId))
        .where(eq(rewardDecision.unitId, row.id)).orderBy(desc(rewardDecision.createdAt), desc(rewardDecision.id)).limit(1);
      const state = returnedState('draft', latest, row.toSeat === 'bg');
      if (state) out.push({ id: row.id, kind: row.kind, name: row.name, cycle: row.cycle, toSeat: state.toSeat, reason: state.reason, returnedAt: state.at, actorName: latest.actorName ?? null });
    }
    return out;
  });
}

// Seat holders' names use the canonical workforce read (as Reward access administration does), never general person RLS.
const visibleSeatHolder = sql<boolean>`app.access_workforce_person(${person.id}, 'workforce.view')`;
const ANNUAL_ROUTE: RewardRole[] = ['bu', 'bg', 'gr', 'ctro', 'ec'];
/**
 * The Rewards configuration list (7a8102a7). Besides the row it returns, per review: the current seat and its
 * active holders (a name only where the viewer may read that person), the calendar due date, and totals only
 * — people and verified counts — read through reward_entry RLS: null when the viewer holds no seat on the
 * review, never a partial count, and never any pay or a per-category count.
 */
export async function listRewardUnits(ctx: SessionContext, companyIds: string[], existingTx?: AiReadTx) {
  ctx = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  companyIds = companyIds.slice();
  if(!existingTx)await withRewardsTenant(ctx,tx=>tx.execute(sql`select app.reward_access_observe(NULL::uuid)`));

  return withCanonicalAiReadTx(ctx, existingTx, 'rewards', withRewardsTenant, tx=>listRewardUnitsTx(tx,companyIds));
}
async function listRewardUnitsTx(tx:Tx,companyIds:string[]){
    if (!companyIds.length) return [];
    const seated = sql`exists(select 1 from app.reward_roles(${rewardUnit.id}))`;
    const rows = await tx.select({ id: rewardUnit.id, cycleId: rewardCycle.id, cycle: rewardCycle.name, kind: rewardUnit.kind, year: rewardCycle.year, companyId: rewardUnit.companyId, company: company.legalName, businessUnitId: rewardUnit.businessUnitId, unit: businessUnitDisplayName, status: rewardUnit.status, returnedTo: returnedSeatSql, revision: rewardUnit.revision, canConfigure:sql<boolean>`${rewardUnit.status}='draft' and ${rewardUnit.kind}='annual' and 'gr' in (select app.reward_roles(${rewardUnit.id}))`, deletionReason:sql<import('./maintenance').RewardDeletionReason|null>`case when app.reward_admin(${rewardUnit.companyId}) then app.reward_deletion_reason(${rewardUnit.id}) else 'locked' end`,
      bgOrigin: sql<boolean>`coalesce(${rewardUnit.offcycle}->>'bgOrigin','false')='true'`,
      effectiveFrom: sql<string | null>`${rewardUnit.policy}->>'effectiveFrom'`,
      people: sql<number | null>`case when ${seated} then (select count(*)::int from reward_entry e where e.unit_id=${rewardUnit.id}) end`,
      verified: sql<number | null>`case when ${seated} then (select count(*)::int from reward_entry e where e.unit_id=${rewardUnit.id} and e.facts->>'reviewed'='true') end`,
      // 56595838: the shared configuration version the review started from, and whether its own settings changed since.
      policyOrigin: sql<{ versionId: string; revision: number; name: string; changed: boolean } | null>`app.reward_policy_unit_origin(${rewardUnit.id})`,
      // 62e743ed: cancelRewardReview's guard, projected for the row actions (the service still decides).
      canCancel: sql<boolean>`${rewardUnit.status} not in ('posted','withdrawn','rejected') and (app.reward_admin(${rewardUnit.companyId}) or 'gr' in (select app.reward_roles(${rewardUnit.id})))` })
      .from(rewardUnit).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).innerJoin(company, eq(company.id, rewardUnit.companyId)).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId))
      .where(and(inArray(rewardUnit.companyId, companyIds),isNull(rewardUnit.deletedAt))).orderBy(desc(rewardCycle.year), asc(rewardCycle.name), asc(businessUnitDisplayName), asc(rewardUnit.id));
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    // Off-cycle seats: only the first seat depends on the request's route; later stages are their own seat.
    const routeOf = (r: typeof rows[number]): RewardRole[] => r.kind === 'annual' ? ANNUAL_ROUTE : [r.bgOrigin ? 'bg' : 'bu', 'bg', 'gr', 'ctro', 'ec'];
    const holders = await tx.select({ unitId: rewardMember.unitId, role: rewardMember.role, name: person.fullName }).from(rewardMember)
      .innerJoin(appUser, and(eq(appUser.id, rewardMember.userId), isNull(appUser.archivedAt), sql`not app.login_blocked(${appUser.id})`))
      .leftJoin(person, and(eq(person.id, appUser.personId), visibleSeatHolder))
      .where(and(inArray(rewardMember.unitId, ids),sql`app.reward_member_eligible(${rewardMember.id})`)).orderBy(asc(person.fullName), asc(rewardMember.userId));
    const calendars = new Map((await tx.select().from(rewardCalendar).where(inArray(rewardCalendar.cycleId, [...new Set(rows.map(r => r.cycleId))])))
      .map(c => [`${c.cycleId}:${c.companyId}`, calendarValues(c)]));
    const offcycle = rows.filter(r => r.kind !== 'annual').map(r => r.id);
    const decisions = offcycle.length ? await tx.select({ unitId: rewardDecision.unitId, toStage: rewardDecision.toStage, createdAt: rewardDecision.createdAt }).from(rewardDecision).where(inArray(rewardDecision.unitId, offcycle)).orderBy(desc(rewardDecision.createdAt), desc(rewardDecision.id)) : [];
    // Who cancelled, when and why: the audit event (domain_event RLS: administrators), the actor's name only where readable.
    const withdrawn = rows.filter(r => r.status === 'withdrawn').map(r => r.id);
    const cancellations = withdrawn.length ? await tx.select({ unitId: domainEvent.aggregateId, at: domainEvent.occurredAt, reason: sql<string | null>`${domainEvent.payload}->>'reason'`, actorName: person.fullName }).from(domainEvent)
      .leftJoin(appUser, eq(appUser.id, domainEvent.actorId)).leftJoin(person, and(eq(person.id, appUser.personId), visibleSeatHolder))
      .where(and(eq(domainEvent.aggregateType, 'reward-unit'), eq(domainEvent.eventType, 'reward-unit.cancelled'), inArray(domainEvent.aggregateId, withdrawn))).orderBy(desc(domainEvent.occurredAt)) : [];
    const today = todayInKualaLumpur();
    return rows.map(r => {
      const seat = rewardStageSeat(r.status, routeOf(r));
      const latest = decisions.find(d => d.unitId === r.id);
      const due = rewardStageDue(calendars.get(`${r.cycleId}:${r.companyId}`) ?? null, { kind: r.kind, status: r.status, returned: !!r.returnedTo, enteredOn: latest && latest.toStage === r.status ? todayInKualaLumpur(new Date(latest.createdAt)) : null });
      const c = cancellations.find(x => x.unitId === r.id);
      return { ...r, seat, holders: seat ? holders.filter(h => h.unitId === r.id && h.role === seat).map(h => h.name ?? null) : [], due, daysUntilDue: due ? rewardDaysUntil(due, today) : null,
        cancellation: c ? { on: todayInKualaLumpur(new Date(c.at)), reason: c.reason ?? '', by: c.actorName ?? null } : null };
    });
}

export async function rewardSetupChoices(ctx: SessionContext, companyIds: string[],options:{includeArchived?:boolean;sharedPolicy?:boolean}={}) {
  return withRewardsTenant(ctx, async tx => {
    // Outer qualifiers stay literal: Drizzle strips Column qualifiers in single-table SELECT fields.
    const companies = companyIds.length ? await tx.select({ id: company.id, name: company.legalName,archived:sql<boolean>`${company.archivedAt} is not null`,excludedYears:sql<number[]>`array(select e.year from reward_company_exclusion e where e.tenant_id="company"."tenant_id" and e.company_id="company"."id" and e.ended_at is null order by e.year)` }).from(company).where(and(options.sharedPolicy?undefined:isNull(company.archivedAt),inArray(company.id, companyIds),sql`app.reward_admin(${company.id})`,options.sharedPolicy?eq(company.currency,'MYR'):undefined)).orderBy(asc(company.legalName)) : [];
    if (!companies.length) return { companies: [], units: [], users: [], cycles: [] };
    const units = await tx.select({ id: businessUnit.id, companyId: businessUnit.companyId, name:businessUnitDisplayName, global: businessUnit.isGlobal,archived:sql<boolean>`${businessUnit.archivedAt} is not null` }).from(businessUnit).where(and(options.includeArchived?undefined:isNull(businessUnit.archivedAt), or(inArray(businessUnit.companyId, companies.map(c => c.id)), eq(businessUnit.isGlobal, true)))).orderBy(asc(businessUnit.code),asc(businessUnit.id));
    const users = await tx.select({ id: appUser.id, name: person.fullName, email: person.primaryEmail }).from(appUser).innerJoin(person, and(eq(person.id, appUser.personId),sql`app.access_workforce_person(${person.id}, 'workforce.view')`)).where(and(isNull(appUser.archivedAt), sql`not app.login_blocked(${appUser.id})`)).orderBy(asc(person.fullName), asc(appUser.id));
    const cycles = await tx.select({ id: rewardCycle.id, name: rewardCycle.name, year: rewardCycle.year }).from(rewardCycle).orderBy(desc(rewardCycle.year), asc(rewardCycle.name));
    return { companies, units, users, cycles };
  });
}

/** Configuration carries policy and participants, never the employee salary roster. */
export async function getRewardConfiguration(ctx: SessionContext, unitId: string) {
  idSchema.parse(unitId);
  return withRewardsTenant(ctx, async tx => {
    const [unit] = await tx.select().from(rewardUnit).where(eq(rewardUnit.id, unitId));
    if (!unit || unit.deletedAt) throw new RewardError('Reward unit not found or access has been removed.');
    const roles = await rolesFor(tx, unitId);
    const [admin] = await tx.execute<{ ok: boolean }>(sql`select app.reward_admin(${unit.companyId}::uuid) as ok`);
    if (!admin?.ok && !roles.includes('gr')) throw new RewardError('Rewards configuration requires company administrator or Group Rewards access.');
    const [cycle] = await tx.select({ name: rewardCycle.name, year: rewardCycle.year }).from(rewardCycle).where(eq(rewardCycle.id, unit.cycleId));
    const [bu] = await tx.select({ name: businessUnitDisplayName }).from(businessUnit).where(eq(businessUnit.id, unit.businessUnitId));
    const members = await tx.select({ id: rewardMember.id, userId: rewardMember.userId, role: rewardMember.role }).from(rewardMember).where(eq(rewardMember.unitId, unitId)).orderBy(asc(rewardMember.role), asc(rewardMember.userId));
    const [originRow]=await tx.execute<{origin:{versionId:string;revision:number;name:string;changed:boolean}|null}>(sql`select app.reward_policy_unit_origin(${unitId}::uuid) as origin`);
    return { unit:{...unit,policy:redactPatPolicy(effectiveRewardPolicy(unit.policy,await governanceStateTx(tx,unitId)),roles)}, cycle, name: bu?.name ?? 'Business unit', members,canReadPat:roles.includes('gr'),policyOrigin:originRow?.origin??null,
      canConfigure: roles.includes('gr') && unit.status === 'draft' && unit.kind === 'annual',
      canManageMembers: !!admin?.ok && unit.status === 'draft',
    };
  });
}

/** The unit's roster as Personnel and Compensation stand on `at`. Read-only; refresh preview and save share it. */
async function snapshotRoster(tx: Tx, unit: typeof rewardUnit.$inferSelect, at: string) {
  await requireAdmin(tx, unit.companyId);
  const records = await tx.select({ employmentId: employment.id, personId: employment.personId, companyId: employment.companyId, employeeCode: employment.employeeCode, name: person.fullName, grade: jobGrade.code, gradeId: employment.gradeId, hiredOn: employment.hiredOn, confirmedOn: employment.confirmationDate, tenderDate: employment.tenderResignationDate, resignedOn: employment.resignationDate, assignmentId: assignment.id })
    .from(employment).innerJoin(person, eq(person.id, employment.personId)).innerJoin(assignment, eq(assignment.employmentId, employment.id)).leftJoin(jobGrade, eq(jobGrade.id, employment.gradeId))
    .where(and(eq(employment.companyId, unit.companyId), eq(assignment.businessUnitId, unit.businessUnitId), lte(employment.hiredOn, at), or(isNull(employment.terminatedOn), gt(employment.terminatedOn, at)), lte(assignment.validFrom, at), or(isNull(assignment.validTo), gt(assignment.validTo, at)), isNull(assignment.supersededAt)))
    .orderBy(asc(employment.employeeCode), asc(employment.id));
  const roster = new Map<string, RewardSource>();
  const kinds = new Map((await tx.select({ code: movementEventType.code, behaviourKind: movementEventType.behaviourKind }).from(movementEventType)).map(k => [k.code, k.behaviourKind]));
  for (const e of records) {
    if (roster.has(e.employmentId)) throw new RewardError('An employee has overlapping assignments. Correct Personnel before importing.');
    const [comp] = await tx.select().from(compensation).where(and(eq(compensation.employmentId, e.employmentId), lte(compensation.validFrom, at), or(isNull(compensation.validTo), gt(compensation.validTo, at)), isNull(compensation.supersededAt))).orderBy(desc(compensation.validFrom)).limit(1);
    const [review] = await tx.select({ id: performanceReview.id, rating: performanceReview.overallRating }).from(performanceReview).innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId)).where(and(eq(performanceReview.employmentId, e.employmentId), lte(reviewCycle.periodStart, `${unit.policy.year}-12-31`), sql`${reviewCycle.periodEnd} >= ${`${unit.policy.year}-01-01`}`, sql`${performanceReview.closedAt} is not null`)).orderBy(desc(performanceReview.closedAt), desc(performanceReview.id)).limit(1);
    roster.set(e.employmentId, {
      employmentId: e.employmentId, personId: e.personId, compensationId: comp?.id ?? null,
      employeeCode: e.employeeCode ?? e.employmentId, name: e.name, grade: (e.grade ?? '').replace(/^JG\s*/i, ''), gradeId: e.gradeId,
      basicCents: comp ? moneyToCents(comp.basicSalary) : 0, currency: comp?.currency ?? 'MYR', payMode: comp?.payMode ?? 'monthly',
      hiredOn: e.hiredOn, confirmedOn: e.confirmedOn, notice: !!((e.tenderDate && e.tenderDate <= at) || (e.resignedOn && e.resignedOn <= at)),
      lastPayChange: comp && comp.validFrom > e.hiredOn ? comp.validFrom : null,
      confirmationPayChange: !!(comp && e.confirmedOn && comp.validFrom === e.confirmedOn && comp.validFrom > e.hiredOn),
      payChanges: await payChangesTx(tx, e.employmentId, e.hiredOn, unit.policy.year, kinds),
      performanceReviewId: review?.id ?? null, performanceRating: review?.rating ?? null,
      onehr: await onehrRewardResultTx(tx, e.employmentId, unit.policy.year, unit.id),
    });
  }
  return roster;
}
/**
 * 8ad87ae8 — basic-salary changes effective from 1 January of the reward year to the end of the next year, oldest
 * first, including records dated after the snapshot. The engine applies the review's exclusion window, so Group
 * Rewards can move the window without a refresh. A record whose basic equals the one before it (a lateral transfer
 * or a re-save) is not a change. The kind is the movement behaviour tagged on the compensation event, if any.
 */
async function payChangesTx(tx: Tx, employmentId: string, hiredOn: string, year: number, kinds: Map<string, string>) {
  const rows = await tx.select({ id: compensation.id, validFrom: compensation.validFrom, basicSalary: compensation.basicSalary }).from(compensation)
    .where(and(eq(compensation.employmentId, employmentId), isNull(compensation.supersededAt), lte(compensation.validFrom, `${year + 1}-12-31`))).orderBy(asc(compensation.validFrom), asc(compensation.id));
  const changed = rows.filter((row, i) => i > 0 && row.validFrom > hiredOn && row.validFrom >= `${year}-01-01` && moneyToCents(row.basicSalary) !== moneyToCents(rows[i - 1].basicSalary));
  if (!changed.length) return [];
  const tags = await tx.select({ id: domainEvent.aggregateId, type: sql<string | null>`${domainEvent.payload}->'movement'->>'type'` }).from(domainEvent)
    .where(and(eq(domainEvent.aggregateType, 'compensation'), eq(domainEvent.eventType, 'compensation.set'), inArray(domainEvent.aggregateId, changed.map(row => row.id))));
  const tagOf = new Map(tags.filter(t => t.type).map(t => [t.id, t.type!]));
  return changed.map(row => { const type = tagOf.get(row.id); return { on: row.validFrom, basicCents: moneyToCents(row.basicSalary), kind: type ? kinds.get(type) ?? type : null }; });
}
/** Creation snapshot. A later refresh goes through previewRewardSourceRefresh/saveRewardSourceRefresh. */
async function snapshotEmployees(tx: Tx, ctx: SessionContext, unit: typeof rewardUnit.$inferSelect) {
  const roster = await snapshotRoster(tx, unit, unit.snapshotDate);
  // 6fd08f37: derived confidentiality floor (BG/EC seats assigned later re-derive through the access commit).
  const floors = await deriveConfidentialityTx(tx, unit.id, [...roster.keys()], unit.snapshotDate);
  for (const raw of roster.values()) {
    const source = sourceWithFloor(raw, floors.get(raw.employmentId));
    await tx.insert(rewardEntry).values({ tenantId: ctx.tenantId, unitId: unit.id, employmentId: source.employmentId, source, facts: { ...emptyFacts(), confidentiality: source.confidentialityFloor ?? 'standard' }, recommendation: emptyRecommendation() });
  }
  return new Set(roster.keys());
}

export async function createRewardUnit(ctx: SessionContext, raw: { name?: string; year: number; companyId: string; businessUnitId: string; cycleId?: string; snapshotDate: string;sharedPolicyVersionId?:string }) {
  // The cycle name is asked for only when a new cycle is created; an existing cycle keeps its own name.
  const p = z.object({ name: z.string().trim().max(160).default(''), year: z.number().int().min(2000).max(2200), companyId: idSchema, businessUnitId: idSchema, cycleId: idSchema.optional(), snapshotDate: isoDateSchema,sharedPolicyVersionId:idSchema.optional() }).parse(raw);
  if (p.snapshotDate > todayInKualaLumpur()) throw new RewardError('The snapshot date cannot be in the future.');
  return withRewardsTenant(ctx, async tx => {
    await tx.execute(sql`select app.access_workforce_write_lock()`);
    await requireAdmin(tx, p.companyId);
    const [available]=await tx.execute<{ok:boolean}>(sql`select app.reward_company_admin_available(${p.companyId}::uuid,${p.year}) as ok`);
    if(!available?.ok)throw new RewardError('This company is archived or excluded from rewards for the selected year.');
    const shared=await rewardPolicyForReviewTx(tx,p.sharedPolicyVersionId,p.companyId,p.businessUnitId,p.year);
    if(shared&&shared.policy.year!==p.year)throw new RewardError('The shared configuration belongs to a different reward year.');
    let cycleId = p.cycleId;
    if (cycleId) { const [cycle] = await tx.select().from(rewardCycle).where(eq(rewardCycle.id, cycleId)); if (!cycle || cycle.year !== p.year) throw new RewardError('Select a cycle in the same reward year.'); }
    else { if (!p.name) throw new RewardError('Name the new review cycle.'); const [cycle] = await tx.insert(rewardCycle).values({ tenantId: ctx.tenantId, name: p.name, year: p.year, createdBy: ctx.userId! }).returning(); cycleId = cycle.id; }
    const [unit] = await tx.insert(rewardUnit).values({ tenantId: ctx.tenantId, createdBy: ctx.userId!, cycleId, companyId: p.companyId, businessUnitId: p.businessUnitId, policy: shared?.policy??defaultPolicy(p.year),policyGroupVersionId:shared?.versionId??null, snapshotDate: p.snapshotDate }).returning();
    await tx.insert(rewardMember).values({ tenantId: ctx.tenantId, unitId: unit.id, userId: ctx.userId!, role: 'gr' });
    const employees = await snapshotEmployees(tx, ctx, unit);
    const [governanceReady]=await tx.execute<{ready:boolean}>(sql`select to_regclass('public.reward_governance') is not null as ready`);
    if(governanceReady?.ready){
      // Only newly-created reviews adopt the unit-owned workflow automatically. Existing reviews
      // retain their exact saved budget basis until Group Rewards explicitly adopts new inputs.
      const state:RewardGovernance={...emptyGovernance(),inputs:{forecastCents:null,actualCents:null,targetCents:null,targetMonthsBp:0,multiplierBp:unit.policy.bonusStructure==='branch'?10000:null,branchRatings:{}},selection:{employmentIds:[],proposedBy:idSchema.parse(ctx.userId),confirmedBy:null,confirmedAt:null}};
      await tx.insert(rewardGovernance).values({tenantId:ctx.tenantId,unitId:unit.id,state});
      await tx.update(rewardUnit).set({policy:{...unit.policy,unitGovernanceDigest:createHash('sha256').update(JSON.stringify(state)).digest('hex')}}).where(eq(rewardUnit.id,unit.id));
      await projectGovernanceTx(tx,ctx,unit.id,state);
    }
    await stamp(tx, ctx, unit.id, 'created', { cycleId, employeeCount: employees.size,...(shared?{sharedPolicyGroupId:shared.groupId,sharedPolicyVersionId:shared.versionId,sharedPolicyRevision:shared.revision}:{}) });
    return unit.id;
  });
}

export async function saveRewardPolicy(ctx: SessionContext, unitId: string, revision: number, raw: unknown) {
  const parsed = policySchema.parse(raw);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    // bcd7cc0f: the unit multiplier has one writer (saveRewardMultiplier), which previews it and records a reason.
    // 4e3e1af7 / 8ad87ae8: the lump reason and pay-window decisions also have their own writers.
    const { lumpReason: _lr, payWindowKeep: _pk, unitGovernanceDigest:_gd, ...settings } = parsed;
    const policy: RewardPolicy = { ...settings, multiplierBp: unit.policy.multiplierBp, ...(unit.policy.unitGovernanceDigest?{unitGovernanceDigest:unit.policy.unitGovernanceDigest}:{}),
      ...(unit.policy.lumpReason ? { lumpReason: unit.policy.lumpReason } : {}), ...(unit.policy.payWindowKeep ? { payWindowKeep: unit.policy.payWindowKeep } : {}) };
    if (!roles.includes('gr')) throw new RewardError('Only Group Rewards may change policy.');
    assertRewardPolicyGrids(policy);
    const governance=await governanceStateTx(tx,unitId);
    for(const key of ['patActual','patTarget','targetMonthsBp','multiplierBp','branchRatings','exemptReason'] as const)Object.assign(policy,{[key]:unit.policy[key]});
    if (unit.kind !== 'annual') throw new RewardError('Off-cycle reviews inherit their annual policy.');
    if (policy.year !== unit.policy.year) throw new RewardError('The reward year cannot change after the roster is created.');
    if (policy.seniorMembershipMode !== unit.policy.seniorMembershipMode ||
        policy.seniorMembershipMode !== 'named-members' && !isDeepStrictEqual(policy.seniorGrades, unit.policy.seniorGrades)) {
      throw new RewardError('Preview and confirm named Senior Plan membership before changing the legacy eligibility rule.');
    }
    await tx.update(rewardUnit).set({ policy }).where(eq(rewardUnit.id, unitId)); await touch(tx, unitId);
    // Field-level before/after of the changed policy keys (62e743ed); policy inputs only, never employee pay.
    const changed = (Object.keys(policy) as (keyof RewardPolicy)[]).filter(k => !isDeepStrictEqual(policy[k], unit.policy[k]));
    await stamp(tx, ctx, unitId, 'policy-updated', { revision: unit.revision + 1, before: Object.fromEntries(changed.map(k => [k, unit.policy[k] ?? null])), after: Object.fromEntries(changed.map(k => [k, policy[k] ?? null])) });
  });
}

/**
 * bcd7cc0f — the unit bonus multiplier override (Group Rewards, Draft annual review, standard structure).
 * A preview recalculates both plans with the candidate and binds the result to the actor, revision and inputs;
 * the save refuses a stale preview, a reason under 10 characters, and any plan above 100% of its bonus pool
 * unless the review already holds a budget-cap exemption. Utilisation is returned as rates, never amounts.
 */
const multiplierInputSchema = bpSchema.nullable();
function assertMultiplierAuthority(unit: typeof rewardUnit.$inferSelect, revision: number, roles: RewardRole[]) {
  assertRevision(unit, revision); assertUnlocked(unit);
  if (!roles.includes('gr')) throw new RewardError('Only Group Rewards may change the unit multiplier.');
  if (unit.kind !== 'annual') throw new RewardError('Off-cycle reviews inherit their annual policy.');
  if (unit.policy.bonusStructure === 'branch') throw new RewardError('The unit multiplier is not used because this review uses branch factors.');
}
function prepareRewardMultiplier(ctx: SessionContext, unit: typeof rewardUnit.$inferSelect, entries: RewardEntry[], multiplierBp: number | null,controls:import('./engine').RewardCalculationControls={}) {
  const now = calculateRewards(entries, unit.policy,controls), next = calculateRewards(entries, { ...unit.policy, multiplierBp },controls);
  const utilisation = (b: { bonusUsedCents: number; bonusPoolCents: number }) => b.bonusPoolCents > 0 ? ratio(b.bonusUsedCents, 10000, b.bonusPoolCents, 'nearest') : null;
  const plans = (['standard', 'h'] as const).map(plan => ({ plan, nowBp: utilisation(now.budgets[plan]), afterBp: utilisation(next.budgets[plan]), over: next.budgets[plan].bonusUsedCents > next.budgets[plan].bonusPoolCents }));
  const exempt = !!unit.policy.exemptReason;
  const token = createHash('sha256').update(JSON.stringify({ actor: { userId: ctx.userId, personId: ctx.personId }, unitId: unit.id, revision: unit.revision, snapshot: digest(unit, entries), multiplierBp })).digest('hex');
  return { unitId: unit.id, revision: unit.revision, beforeBp: unit.policy.multiplierBp, requestedBp: multiplierBp, effectiveBp: multiplierBp ?? next.suggestedMultiplierBp, plans, exempt, blocked: (controls.poolStatus==='final'||!exempt) && plans.some(p => p.over), digest: token };
}
export async function previewRewardMultiplier(ctx: SessionContext, unitId: string, revision: number, multiplierBp: number | null) {
  const value = multiplierInputSchema.parse(multiplierBp);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId);
    assertMultiplierAuthority(unit, revision, roles);
    const state=await governanceStateTx(tx,unitId),publicState=await governancePublicTx(tx,unitId);
    return prepareRewardMultiplier(ctx, {...unit,policy:effectiveRewardPolicy(unit.policy,state)}, entries, value,publicState?{bonusPools:publicState.pools,poolStatus:publicState.status}:{});
  });
}
export async function saveRewardMultiplier(ctx: SessionContext, unitId: string, revision: number, multiplierBp: number | null, reason: string, previewDigest: string) {
  const value = multiplierInputSchema.parse(multiplierBp); z.string().regex(/^[a-f0-9]{64}$/).parse(previewDigest);
  const why = z.string().trim().max(2000).parse(reason);
  if (why.length < 10) throw new RewardError('Explain the unit multiplier change in at least 10 characters.');
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true);
    assertMultiplierAuthority(unit, revision, roles);
    const state=await governanceStateTx(tx,unitId),publicState=await governancePublicTx(tx,unitId),effective=effectiveRewardPolicy(unit.policy,state);
    const prepared = prepareRewardMultiplier(ctx, {...unit,policy:effective}, entries, value,publicState?{bonusPools:publicState.pools,poolStatus:publicState.status}:{});
    if (prepared.digest !== previewDigest) throw new RewardError('The review changed. Check the impact again before saving.');
    if (prepared.blocked) throw new RewardError(publicState?.status==='final'?'A plan would exceed 100% of its final bonus pool. A budget exemption does not bypass the final-pool cap.':'A plan would exceed 100% of its bonus pool and this review has no budget-cap exemption.');
    if(state?.inputs)await saveGovernanceTx(tx,ctx,unitId,state,{...state,inputs:{...state.inputs,multiplierBp:value}},'unit-inputs-updated',why);
    else {await tx.update(rewardUnit).set({ policy: { ...unit.policy, multiplierBp: value } }).where(eq(rewardUnit.id, unitId)); await touch(tx, unitId);}
    await stamp(tx, ctx, unitId, 'multiplier-updated', { revision: unit.revision + 1, before: effective.multiplierBp, after: value, reason: why });
  });
}

const seniorSelectionSchema = z.object({
  employmentIds: z.array(idSchema).max(5000),
  adoptLegacy: z.boolean(),
}).strict();
export type SeniorPlanSelection = z.infer<typeof seniorSelectionSchema>;
type SeniorRosterEntry = RewardEntry & { employmentId: string };

function seniorMembershipProjection(unit: typeof rewardUnit.$inferSelect, entries: SeniorRosterEntry[], roles: RewardRole[], ctx: SessionContext) {
  return {
    mode: unit.policy.seniorMembershipMode ?? ('legacy-grades' as const),
    rows: entries.filter(entry => visibleEntry(entry, roles, ctx.personId)).map(entry => ({
      employmentId: entry.employmentId, name: entry.source.name, employeeCode: entry.source.employeeCode,
      member: isSeniorPlanMember(unit.policy, entry.facts, entry.source.grade),eligible:seniorGrade(entry.source.grade),grade:entry.source.grade,
    })),
  };
}
function assertSeniorSelectionAuthority(unit: typeof rewardUnit.$inferSelect, revision: number, roles: RewardRole[]) {
  assertRevision(unit, revision); assertUnlocked(unit);
  if (unit.kind !== 'annual' || !roles.includes('gr')) throw new RewardError('Only Group Rewards may configure Senior Plan membership in a draft annual review.');
}

/** A separate, intentionally pay-free projection; administrative role management never loads this roster. */
export async function getRewardSeniorMembership(ctx: SessionContext, unitId: string) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId);
    if (!roles.includes('gr')) throw new RewardError('Group Rewards membership access is required.');
    return { unitId, revision: unit.revision, canEdit: unit.kind === 'annual' && unit.status === 'draft', ...seniorMembershipProjection(unit, entries, roles, ctx) };
  });
}

function prepareSeniorSelection(ctx: SessionContext, unit: typeof rewardUnit.$inferSelect, entries: SeniorRosterEntry[], roles: RewardRole[], raw: unknown) {
  const input = seniorSelectionSchema.parse(raw);
  const selected = new Set(input.employmentIds);
  if (selected.size !== input.employmentIds.length) throw new RewardError('Select each employee only once.');
  const visible = new Set(entries.filter(entry => visibleEntry(entry, roles, ctx.personId)).map(entry => entry.employmentId));
  if (input.employmentIds.some(id => !visible.has(id))) throw new RewardError('A selected employee is not in your visible review roster. Reload the review.');
  if (input.employmentIds.some(id => !entries.some(entry=>entry.employmentId===id&&seniorGrade(entry.source.grade)))) throw new RewardError('Only employees in JG 21, 22 or 23 may be selected for the Senior plan.');
  const legacy = unit.policy.seniorMembershipMode !== 'named-members';
  if (legacy && !input.adoptLegacy) throw new RewardError('Confirm conversion from the saved grade rule to named membership.');
  const updated = entries.map(entry => {
    const before = isSeniorPlanMember(unit.policy, entry.facts, entry.source.grade);
    // Preserve effective membership of own-person/otherwise hidden entries during conversion.
    const after = visible.has(entry.employmentId) ? selected.has(entry.employmentId) : before;
    return { ...entry, facts: { ...entry.facts, seniorPlan: after, reviewed: before === after ? entry.facts.reviewed : false } };
  });
  const token = createHash('sha256').update(JSON.stringify({
    actor: { userId: ctx.userId, personId: ctx.personId }, unitId: unit.id, revision: unit.revision,
    snapshot: digest(unit, entries), rosterIds: entries.map(entry => [entry.id, entry.employmentId]), selected: [...selected].sort(), adoptLegacy: input.adoptLegacy,
  })).digest('hex');
  const projection = seniorMembershipProjection(unit, entries, roles, ctx);
  return { token, updated, projection, selected, legacy };
}

export async function previewRewardSeniorMembership(ctx: SessionContext, unitId: string, revision: number, raw: unknown) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId);
    assertSeniorSelectionAuthority(unit, revision, roles);
    const prepared = prepareSeniorSelection(ctx, unit, entries, roles, raw);
    return { unitId, revision, digest: prepared.token, convertingLegacy: prepared.legacy,
      rows: prepared.projection.rows.map(row => ({ ...row, nextMember: prepared.selected.has(row.employmentId) })),
    };
  });
}

export async function saveRewardSeniorMembership(ctx: SessionContext, unitId: string, revision: number, raw: unknown, previewDigest: string) {
  z.string().regex(/^[a-f0-9]{64}$/).parse(previewDigest);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true);
    assertSeniorSelectionAuthority(unit, revision, roles);
    const prepared = prepareSeniorSelection(ctx, unit, entries, roles, raw);
    if (prepared.token !== previewDigest) throw new RewardError('Membership or the review changed. Preview it again before saving.');
    const changedIds: string[] = [];
    const previous = new Map(entries.map(entry => [entry.id, entry]));
    for (const entry of prepared.updated) {
      const old = previous.get(entry.id)!;
      if (isDeepStrictEqual(old.facts, entry.facts)) continue;
      await tx.update(rewardEntry).set({ facts: entry.facts, updatedAt: new Date() }).where(eq(rewardEntry.id, entry.id));
      changedIds.push(entry.employmentId);
    }
    await tx.update(rewardUnit).set({ policy: { ...unit.policy, seniorMembershipMode: 'named-members' } }).where(eq(rewardUnit.id, unitId));
    await touch(tx, unitId);
    await stamp(tx, ctx, unitId, 'senior-membership-updated', { revision: unit.revision + 1, convertedLegacy: prepared.legacy, changedEmploymentIds: changedIds });
    const prior=await governanceStateTx(tx,unitId),state=prior??emptyGovernance();
    const selectedIds=new Set(prepared.updated.filter(entry=>entry.facts.seniorPlan).map(entry=>entry.id));
    const after:RewardGovernance={...state,selection:{employmentIds:prepared.updated.filter(entry=>entry.facts.seniorPlan).map(entry=>entry.employmentId),proposedBy:idSchema.parse(ctx.userId),confirmedBy:null,confirmedAt:null},awards:Object.fromEntries(Object.entries(state.awards).filter(([id])=>selectedIds.has(id)))};
    // touch was already performed for the roster write; persist the checkpoint atomically without another revision.
    await tx.insert(rewardGovernance).values({tenantId:ctx.tenantId,unitId,state:after}).onConflictDoUpdate({target:rewardGovernance.unitId,set:{state:after,updatedAt:new Date()}});
    await tx.insert(rewardGovernanceHistory).values({tenantId:ctx.tenantId,unitId,actorId:idSchema.parse(ctx.userId),kind:'senior-selection-proposed',reason:'Senior membership submitted for independent checking',before:prior,after});
    await projectGovernanceTx(tx,ctx,unitId,after);
    await tx.update(rewardUnit).set({policy:{...unit.policy,seniorMembershipMode:'named-members',unitGovernanceDigest:createHash('sha256').update(JSON.stringify(after)).digest('hex')}}).where(eq(rewardUnit.id,unitId));
  });
}

export async function setRewardMember(ctx: SessionContext, unitId: string, revision: number, userId: string, role: RewardRole, remove = false) {
  return changeRewardMember(ctx,unitId,revision,userId,role,remove);
}

const confidentialityFloorMessage = 'This person is marked confidential from their reporting line in People. Group Rewards can make the marking stricter, never lower.';
export async function saveRewardEntry(ctx: SessionContext, unitId: string, revision: number, entryId: string, recommendation: unknown, facts?: unknown) {
  idSchema.parse(entryId); const rec = recommendationSchema.parse(recommendation);
  const validatedFacts = facts === undefined ? undefined : factsSchema.parse(facts);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    const entry = entries.find(e => e.id === entryId);
    if (!entry || !visibleEntry(entry, roles, ctx.personId)) throw new RewardError('This reward record is not available to you.');
    const canEC = entry.facts.confidentiality === 'ec' && roles.some(r => ['gr', 'ctro', 'ec'].includes(r));
    if (!canEditStage(unit.status, roles) && !(unit.kind !== 'annual' && roles.includes('bg')) && !canEC) throw new RewardError('You cannot edit this reward recommendation.');
    if (entry.facts.confidentiality !== 'ec' && rec.bonusCents != null) throw new RewardError('Use the bonus multiplier for a standard or JG H employee.');
    if (validatedFacts && !roles.includes('gr')) {
      const { erDecision: _er, pipDecision: _pip, caseReason: _reason, ...oldClassification } = entry.facts;
      const { erDecision: _newEr, pipDecision: _newPip, caseReason: _newReason, ...newClassification } = validatedFacts;
      if (!roles.includes('bu') || !isDeepStrictEqual(oldClassification, newClassification)) throw new RewardError('Only Group Rewards may verify employee inputs.');
    }
    if(validatedFacts&&validatedFacts.seniorPlan!==entry.facts.seniorPlan)throw new RewardError('Use the checked Senior membership workflow to change selection.');
    if (validatedFacts && belowConfidentialityFloor(validatedFacts, entry.source)) throw new RewardError(confidentialityFloorMessage);
    await tx.update(rewardEntry).set({ recommendation: rec, ...(validatedFacts ? { facts: validatedFacts } : {}), updatedAt: new Date() }).where(eq(rewardEntry.id, entryId));
    await touch(tx, unitId); await stamp(tx, ctx, unitId, 'recommendation-updated', { entryId, revision: unit.revision + 1 });
  });
}

export async function importRewardFacts(ctx: SessionContext, unitId: string, revision: number, rows: { employmentId: string; facts: RewardFacts }[]) {
  const input = z.array(z.object({ employmentId: idSchema, facts: factsSchema })).min(1).max(10000).parse(rows);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    if (!roles.includes('gr')) throw new RewardError('Only Group Rewards may import ratings and classifications.');
    const seen = new Set<string>();
    for (const row of input) {
      const e = entries.find(e => e.employmentId === row.employmentId);
      if (!e || !visibleEntry(e, roles, ctx.personId) || seen.has(row.employmentId)) throw new RewardError('The import contains a duplicate or unavailable employee. Nothing was imported.');
      if(row.facts.seniorPlan!==e.facts.seniorPlan)throw new RewardError('Use the checked Senior membership workflow to change selection.');
      seen.add(row.employmentId);
      if (belowConfidentialityFloor(row.facts, e.source)) throw new RewardError(`${confidentialityFloorMessage} Nothing was imported.`);
      await tx.update(rewardEntry).set({ facts: row.facts, updatedAt: new Date() }).where(eq(rewardEntry.id, e.id));
    }
    await touch(tx, unitId); await stamp(tx, ctx, unitId, 'facts-imported', { count: input.length, revision: unit.revision + 1 });
  });
}

/** 40bf44f7 — what a source refresh changes, by category. `other` is a source change outside the six named
 *  categories (for example a newly closed performance review); it is shown so no person loses verification silently. */
export const rewardRefreshCategories = ['joined', 'left', 'confirmed', 'notice', 'grade', 'salary', 'other'] as const;
export type RewardRefreshCategory = typeof rewardRefreshCategories[number];
type RefreshChange = { entry: typeof rewardEntry.$inferSelect | null; employmentId: string; source: RewardSource; categories: RewardRefreshCategory[] };
/** The facts a refresh writes: verification cleared, confidentiality moved with the derived floor (6fd08f37). */
const refreshedFacts = (c: RefreshChange): RewardFacts => c.entry && !c.categories.length ? c.entry.facts : c.entry
  ? { ...c.entry.facts, confidentiality: applyConfidentialityFloor(c.entry.facts.confidentiality, c.entry.source.confidentialityFloor, c.source.confidentialityFloor), reviewed: false }
  : { ...emptyFacts(), confidentiality: c.source.confidentialityFloor ?? 'standard' };

async function planSourceRefreshTx(tx: Tx, ctx: SessionContext, unit: typeof rewardUnit.$inferSelect, roles: RewardRole[], entries: (typeof rewardEntry.$inferSelect)[], revision: number, rawAsOf: unknown) {
  assertRevision(unit, revision); assertUnlocked(unit);
  if (!roles.includes('gr')) throw new RewardError('Only Group Rewards may refresh the roster.');
  if (unit.kind !== 'annual') throw new RewardError('Create a replacement off-cycle request if its salary snapshot is stale.');
  const today = todayInKualaLumpur(), asOf = rawAsOf == null || rawAsOf === '' ? today : isoDateSchema.parse(rawAsOf);
  if (asOf > today) throw new RewardError('The snapshot date cannot be in the future.');
  if (asOf < unit.snapshotDate) throw new RewardError('Refresh to a date on or after the current snapshot date.');
  const roster = await snapshotRoster(tx, unit, asOf);
  const floors = await deriveConfidentialityTx(tx, unit.id, [...roster.keys()], asOf);
  for (const [id, source] of roster) roster.set(id, sourceWithFloor(source, floors.get(id)));
  const changes: RefreshChange[] = [];
  for (const entry of entries) {
    const old = entry.source, next = roster.get(entry.employmentId);
    if (!next) {
      if (old.leftOn) continue;
      // Terminated on or before asOf; otherwise moved out of this business unit while still employed.
      const [emp] = await tx.select({ terminatedOn: employment.terminatedOn }).from(employment).where(eq(employment.id, entry.employmentId));
      const terminatedOn = emp?.terminatedOn && emp.terminatedOn <= asOf ? emp.terminatedOn : null;
      const [moved] = terminatedOn ? [] : await tx.select({ on: sql<string | null>`max(${assignment.validTo})` }).from(assignment).where(and(eq(assignment.employmentId, entry.employmentId), eq(assignment.businessUnitId, unit.businessUnitId), isNull(assignment.supersededAt), lte(assignment.validTo, asOf)));
      changes.push({ entry, employmentId: entry.employmentId, source: { ...old, leftOn: terminatedOn ?? moved?.on ?? asOf, leftReason: terminatedOn ? 'terminated' : 'moved' }, categories: ['left'] });
      continue;
    }
    const source: RewardSource = { ...next, ...(old.onehrFactImport ? { onehrFactImport: old.onehrFactImport } : {}) };
    if (isDeepStrictEqual(source, old)) continue;
    // 8ad87ae8: a snapshot taken before pay-change history was recorded gains an empty history silently;
    // nothing about the person changed, so their verification stands.
    const { payChanges, ...rest } = source;
    if (old.payChanges === undefined && !payChanges?.length && isDeepStrictEqual(rest, old)) { changes.push({ entry, employmentId: entry.employmentId, source, categories: [] }); continue; }
    const categories: RewardRefreshCategory[] = [];
    if (old.leftOn) categories.push('joined');
    if (next.confirmedOn && next.confirmedOn !== old.confirmedOn) categories.push('confirmed');
    if (next.notice && !old.notice) categories.push('notice');
    if (next.gradeId !== old.gradeId || next.grade !== old.grade) categories.push('grade');
    if (next.compensationId !== old.compensationId || next.basicCents !== old.basicCents || next.currency !== old.currency || next.payMode !== old.payMode || !isDeepStrictEqual(next.payChanges, old.payChanges)) categories.push('salary');
    changes.push({ entry, employmentId: entry.employmentId, source, categories: categories.length ? categories : ['other'] });
  }
  const existing = new Set(entries.map(e => e.employmentId));
  for (const [employmentId, source] of roster) if (!existing.has(employmentId)) changes.push({ entry: null, employmentId, source, categories: ['joined'] });
  const token = createHash('sha256').update(JSON.stringify({
    actor: { userId: ctx.userId, personId: ctx.personId }, unitId: unit.id, revision: unit.revision, from: unit.snapshotDate, asOf,
    snapshot: digest(unit, entries), changes: changes.map(c => [c.employmentId, c.categories, c.source]),
  })).digest('hex');
  return { asOf, changes, token };
}

export type RewardRefreshPerson = { employmentId: string; name: string; employeeCode: string };
/** Read-only preview. Names are limited to what visibleEntry lets this viewer see; hidden people are not counted. */
export async function previewRewardSourceRefresh(ctx: SessionContext, unitId: string, revision: number, asOf?: string) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId);
    const plan = await planSourceRefreshTx(tx, ctx, unit, roles, entries, revision, asOf);
    const people = Object.fromEntries(rewardRefreshCategories.map(c => [c, [] as RewardRefreshPerson[]])) as Record<RewardRefreshCategory, RewardRefreshPerson[]>;
    for (const c of plan.changes) {
      const shown: RewardEntry = { id: c.entry?.id ?? c.employmentId, source: c.source, facts: refreshedFacts(c), recommendation: c.entry?.recommendation ?? emptyRecommendation() };
      if (!visibleEntry({ ...shown, facts: { ...shown.facts, reviewed: true } }, roles, ctx.personId)) continue;
      for (const category of c.categories) people[category].push({ employmentId: c.employmentId, name: c.source.name, employeeCode: c.source.employeeCode });
    }
    return { unitId, revision, from: unit.snapshotDate, asOf: plan.asOf, digest: plan.token, people };
  });
}

/** Applies exactly the previewed refresh. Leavers are kept and marked; only changed entries need verification again. */
export async function saveRewardSourceRefresh(ctx: SessionContext, unitId: string, revision: number, asOf: string, previewDigest: string) {
  z.string().regex(/^[a-f0-9]{64}$/).parse(previewDigest);
  const date = isoDateSchema.parse(asOf);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true);
    const plan = await planSourceRefreshTx(tx, ctx, unit, roles, entries, revision, date);
    if (plan.token !== previewDigest) throw new RewardError('The source records or the review changed. Preview the refresh again before confirming.');
    for (const c of plan.changes) {
      if (c.entry) await tx.update(rewardEntry).set({ source: c.source, facts: refreshedFacts(c), updatedAt: new Date() }).where(eq(rewardEntry.id, c.entry.id));
      else await tx.insert(rewardEntry).values({ tenantId: ctx.tenantId, unitId, employmentId: c.employmentId, source: c.source, facts: refreshedFacts(c), recommendation: emptyRecommendation() });
    }
    await tx.update(rewardUnit).set({ snapshotDate: plan.asOf }).where(eq(rewardUnit.id, unitId));
    await touch(tx, unitId);
    const counts = Object.fromEntries(rewardRefreshCategories.map(c => [c, plan.changes.filter(x => x.categories.includes(c)).length]));
    await stamp(tx, ctx, unitId, 'sources-refreshed', { revision: unit.revision + 1, from: unit.snapshotDate, asOf: plan.asOf, counts, changed: plan.changes.length });
  });
}

/** Preview and confirm in one call (scripts and tests). The Data centre always shows the preview first. */
export async function refreshRewardSources(ctx: SessionContext, unitId: string, revision: number, asOf?: string) {
  const preview = await previewRewardSourceRefresh(ctx, unitId, revision, asOf);
  await saveRewardSourceRefresh(ctx, unitId, revision, preview.asOf, preview.digest);
}

/**
 * 4e3e1af7 — the unit lump sum is one of three explicit choices, so a cleared box or a typed 0 can no longer
 * withhold the token for a whole unit: follow the suggestion, set a positive amount, or withhold with a reason.
 * Every change records the old and new amount, the choice and the reason.
 */
const lumpReasonSchema = z.string().trim().max(1000).default('');
const lumpChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto'), reason: lumpReasonSchema }).strict(),
  z.object({ mode: z.literal('set'), cents: z.number().int().min(1).max(100_000_000_000), reason: lumpReasonSchema }).strict(),
  z.object({ mode: z.literal('withhold'), reason: lumpReasonSchema }).strict(),
]);
export type RewardLumpChoice = z.input<typeof lumpChoiceSchema>;
export async function setRewardUnitLump(ctx: SessionContext, unitId: string, revision: number, raw: RewardLumpChoice) {
  const choice = lumpChoiceSchema.parse(raw);
  if (choice.mode === 'withhold' && choice.reason.length < 10) throw new RewardError('Explain why the lump sum is withheld, in at least 10 characters.');
  const value = choice.mode === 'auto' ? null : choice.mode === 'set' ? choice.cents : 0;
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    if (!canEditStage(unit.status, roles)) throw new RewardError('You cannot change this unit recommendation.');
    const { lumpReason: _old, ...rest } = unit.policy;
    await tx.update(rewardUnit).set({ policy: { ...rest, lumpUnitCents: value, ...(choice.reason ? { lumpReason: choice.reason } : {}) } }).where(eq(rewardUnit.id, unitId));
    await touch(tx, unitId);
    await stamp(tx, ctx, unitId, 'lump-updated', { revision: unit.revision + 1, mode: choice.mode, before: unit.policy.lumpUnitCents, after: value, reason: choice.reason || null });
  });
}

/**
 * c28db2f0 — what a candidate unit lump sum does to each plan, before it is saved. Read-only: the same engine
 * calculation the review uses, with only the unit amount replaced. Headcounts follow bonusCounts' rule and are
 * withheld when the plan holds a record this viewer may not see; amounts are plan totals the budget tab shows.
 */
export async function previewRewardLump(ctx: SessionContext, unitId: string, revision: number, cents: number | null) {
  const value = z.number().int().min(0).max(100_000_000_000).nullable().parse(cents);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId); assertRevision(unit, revision);
    if (unit.kind !== 'annual') throw new RewardError('Off-cycle reviews have no unit lump sum.');
    const result = calculateRewards(entries, { ...unit.policy, lumpUnitCents: value });
    const plans = (['standard', 'h'] as const).map(plan => {
      const group = result.rows.filter(x => x.plan === plan), b = result.budgets[plan];
      const hidden = group.some(x => !visibleEntry(x, roles, ctx.personId));
      return { plan, count: hidden ? null : group.filter(x => x.lumpEligible).length,
        amendments: hidden ? null : group.filter(x => x.lumpEligible && x.recommendation.lumpCents != null && x.lumpCents !== result.lumpUnitCents).length,
        lumpCents: b.lumpCents, balanceCents: b.balanceCents, usedBp: b.bonusPoolCents > 0 ? ratio(b.bonusUsedCents, 10000, b.bonusPoolCents, 'nearest') : null, over: b.bonusUsedCents > b.bonusPoolCents };
    });
    return { unitId, revision: unit.revision, lumpUnitCents: result.lumpUnitCents, suggestedLumpCents: result.suggestedLumpCents, exempt: !!unit.policy.exemptReason, plans };
  });
}

/**
 * 8ad87ae8 — Group Rewards keeps one person eligible for the salary increase despite a basic-salary change in
 * the exclusion window (for example a payroll correction), or removes that decision. Both need a reason and are
 * recorded. Stored on the review, so a refresh or an input import never loses it.
 */
export async function setRewardPayWindowKeep(ctx: SessionContext, unitId: string, revision: number, entryId: string, keep: boolean, reason: string) {
  idSchema.parse(entryId); z.boolean().parse(keep);
  const why = z.string().trim().max(1000).parse(reason);
  if (why.length < 10) throw new RewardError('Explain the decision in at least 10 characters.');
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    if (!roles.includes('gr') || unit.kind !== 'annual' || unit.status !== 'draft') throw new RewardError('Only Group Rewards may change pay-change eligibility in a draft annual review.');
    const entry = entries.find(e => e.id === entryId);
    if (!entry || !visibleEntry(entry, roles, ctx.personId)) throw new RewardError('This reward record is not available to you.');
    if (!calculateRewards([entry], unit.policy).rows[0].payChange) throw new RewardError('This person has no salary change in the exclusion window.');
    const kept = { ...(unit.policy.payWindowKeep ?? {}) }, before = entry.employmentId in kept;
    if (keep) kept[entry.employmentId] = why; else delete kept[entry.employmentId];
    const { payWindowKeep: _old, ...rest } = unit.policy;
    await tx.update(rewardUnit).set({ policy: { ...rest, ...(Object.keys(kept).length ? { payWindowKeep: kept } : {}) } }).where(eq(rewardUnit.id, unitId));
    await touch(tx, unitId);
    await stamp(tx, ctx, unitId, 'pay-window-updated', { revision: unit.revision + 1, entryId, before, after: keep, reason: why });
  });
}

export async function decideRewardUnit(ctx: SessionContext, unitId: string, revision: number, action: 'submit' | 'approve' | 'return' | 'reject' | 'withdraw', reason: string, acknowledged = false) {
  z.enum(['submit', 'approve', 'return', 'reject', 'withdraw']).parse(action); reason = z.string().trim().max(4000).parse(reason);
  return withRewardsTenant(ctx, async tx => {
    idSchema.parse(unitId); await funding(tx, unitId, true);
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision);
    const route = unit.kind === 'annual' ? ['bu', 'bg', 'gr', 'ctro', 'ec'] as RewardRole[] : offcycleRoute(unit.kind, unit.offcycle!, entries);
    if (unit.kind === 'annual' && (action === 'reject' || action === 'withdraw')) throw new RewardError('Return an annual review to draft instead.');
    const governance=unit.kind==='annual'?await governancePublicTx(tx,unitId):null;
    const next = unit.kind === 'annual' ? transition(unit.status, roles, action as 'submit' | 'approve' | 'return') : offcycleTransition(unit.status, roles, action, route);
    if (unit.kind !== 'annual' && action === 'approve' && entries.some(e => visibleEntry(e, roles, ctx.personId) && e.recommendation.promotionGrade) && !acknowledged) throw new RewardError('Acknowledge that you reviewed the current and proposed role summaries.');
    if (['return', 'reject', 'withdraw'].includes(action) && reason.length < 10) throw new RewardError('Explain why the unit is being returned (at least 10 characters).');
    const hash = digest(unit, entries), calculated = await calculateUnit(tx, unit, entries);
    if (action === 'submit' || action === 'approve') {
      if (!entries.length) throw new RewardError('A review needs at least one employee.');
      if(governance){
        if(entries.some(entry=>isSeniorPlanMember(unit.policy,entry.facts,entry.source.grade)&&!seniorGrade(entry.source.grade)))throw new RewardError('Senior plan membership is limited to JG 21–23. Correct selection before submission.');
        if(!governance.selectionConfirmed)throw new RewardError('A different Group Rewards user must confirm and lock Senior membership before the BU review opens.');
        if(['ctro','ec','approved'].includes(next)&&governance.status!=='final')throw new RewardError('The unit bonus pool must be Final (Actual) before CTRO or EC approval.');
        if(unit.policy.bonusStructure==='branch'&&entries.some(entry=>entry.facts.branch&&!governance.branchRatings[entry.facts.branch]))throw new RewardError('Every PPCH branch needs a rating before submission.');
      }
      if (calculated.flags.some(f => f.severity === 'block')) throw new RewardError('Resolve all blocking checks, including restricted records, before proceeding.');
      if (calculated.flags.some(f => ['exception', 'warning'].includes(f.severity)) && reason.length < 10) throw new RewardError('Record why the exceptions and warnings are acceptable.');
      const members = await tx.select({ role: rewardMember.role }).from(rewardMember).innerJoin(appUser, eq(appUser.id, rewardMember.userId)).where(and(eq(rewardMember.unitId, unitId),sql`app.reward_member_eligible(${rewardMember.id})`));
      const missing = missingRewardRoles(rewardRequiredRoles(unit, entries), members);
      if (missing.length) throw new RewardError(`Assign every approval role and the payroll handoff before submitting. Missing: ${missing.map(role => rewardRoleLabels[role]).join(', ')}.`);
      if (unit.status !== 'draft' && unit.approvedDigest !== hash) throw new RewardError('The inputs changed after submission. Return this review to draft.');
      // A person must not sign consecutive stages of the same revision, even if granted both roles.
      const [prior] = await tx.select().from(rewardDecision).where(and(eq(rewardDecision.unitId, unitId), eq(rewardDecision.revision, revision))).orderBy(desc(rewardDecision.createdAt), desc(rewardDecision.id)).limit(1);
      if (prior?.actorId === ctx.userId && action === 'approve') throw new RewardError('A different reviewer must sign the next approval stage.');
    }
    await tx.insert(rewardDecision).values({ tenantId: ctx.tenantId, unitId, actorId: ctx.userId!, revision, action, fromStage: unit.status, toStage: next, reason, digest: hash });
    await tx.update(rewardUnit).set({ status: next, approvedDigest: ['return', 'reject', 'withdraw'].includes(action) ? null : hash, ...(action === 'return' ? { revision: revision + 1 } : {}), ...(unit.kind !== 'annual' ? { reservedCents: { standard: calculated.budgets.standard.used[0], h: calculated.budgets.h.used[0] } } : {}), updatedAt: new Date() }).where(eq(rewardUnit.id, unitId));
    await stamp(tx, ctx, unitId, next === 'approved' ? 'approved' : 'routed', { from: unit.status, to: next, revision });
    return next;
  });
}

/**
 * Cancel a review that has started (62e743ed). Authority: the company's Rewards administrator or the review's
 * Group Rewards seat. A posted review cannot be cancelled (salaries already changed; corrections go through an
 * off-cycle review). The review keeps every entry and decision read-only; status 'withdrawn' (shown as Cancelled
 * for an annual review) leaves the approval route, the task list, the board and posting. For an off-cycle request,
 * reward_funding stops counting a withdrawn request's reservation, exactly as the off-cycle withdraw path does.
 */
export async function cancelRewardReview(ctx: SessionContext, unitId: string, revision: number, reason: string) {
  idSchema.parse(unitId); reason = z.string().trim().max(4000).parse(reason);
  if (reason.length < 10) throw new RewardError('Explain why the review is being cancelled (at least 10 characters).');
  return withRewardsTenant(ctx, tx => cancelRewardReviewTx(tx, ctx, unitId, revision, reason));
}

/** Native transaction seam for reviewed cancellation. Caller owns rollback of the entire transaction.
 * Authority and state remain here, including GR users without an administrator role. */
export async function cancelRewardReviewTx(tx: Tx, ctx: SessionContext, unitId: string, revision: number, reason: string) {
  assertModuleGate(ctx, 'rewards');
  idSchema.parse(unitId); reason = z.string().trim().min(10).max(4000).parse(reason);
  const [unit] = await tx.select().from(rewardUnit).where(eq(rewardUnit.id, unitId)).for('update');
  if (!unit || unit.deletedAt) throw new RewardError('Reward unit not found or access has been removed.');
  const roles = await rolesFor(tx, unitId);
  const [admin] = await tx.execute<{ ok: boolean }>(sql`select app.reward_admin(${unit.companyId}::uuid) as ok`);
  if (!admin?.ok && !roles.includes('gr')) throw new RewardError('Only the company Rewards administrator or Group Rewards may cancel this review.');
  assertRevision(unit, revision);
  if (['posted', 'withdrawn', 'rejected'].includes(unit.status)) throw new RewardError('This review can no longer be cancelled.');
  // Serialize with sibling off-cycle submissions against the same annual funding.
  if (unit.parentUnitId) await tx.select({ id: rewardUnit.id }).from(rewardUnit).where(eq(rewardUnit.id, unit.parentUnitId)).for('update');
  await tx.update(rewardUnit).set({ status: 'withdrawn', approvedDigest: null, revision: revision + 1, updatedAt: new Date() }).where(eq(rewardUnit.id, unitId));
  // reward_decision RLS admits only a seat holder; an administrator without a seat is recorded by the audit event.
  if (roles.some(r => r !== 'pbp')) {
    const entries = await tx.select().from(rewardEntry).where(eq(rewardEntry.unitId, unitId)).orderBy(asc(rewardEntry.id));
    await tx.insert(rewardDecision).values({ tenantId: ctx.tenantId, unitId, actorId: ctx.userId!, revision, action: 'withdraw', fromStage: unit.status, toStage: 'withdrawn', reason, digest: digest(unit, entries) });
  }
  const [proof] = await tx.execute<{hash:string}>(sql`select encode(sha256(convert_to(to_jsonb(q)::text,'UTF8')),'hex') as hash from reward_unit q where q.id=${unitId}::uuid and q.tenant_id=${ctx.tenantId}::uuid`);
  // Preallocation preserves the native insert-only audit path for GR users who cannot read
  // unscoped audit rows. The enclosing custody verifier still requires the actual top-TX event.
  const eventId = randomUUID();
  await stamp(tx, ctx, unitId, 'cancelled', { cancelRowHash: proof.hash, fromStage: unit.status, reason, revision, before: { status: unit.status, revision }, after: { status: 'withdrawn', revision: revision + 1 } }, false, eventId);
  return { unitId, eventId, cancelledRevision: revision, currentRevision: revision + 1, status: 'withdrawn' as const };
}

export async function rewardPayrollChoices(ctx: SessionContext, unitId: string) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles } = await load(tx, unitId);
    if (!roles.includes('payroll')) return [];
    return tx.select({ id: payrollBatch.id, period: payrollBatch.payPeriod }).from(payrollBatch).where(and(eq(payrollBatch.companyId, unit.companyId), eq(payrollBatch.status, 'draft'))).orderBy(desc(payrollBatch.payPeriod), asc(payrollBatch.id));
  });
}

async function prepareRewardPostTx(tx:Tx,ctx:SessionContext,unitId:string,revision:number,batchId?:string,reviewed=false){
    idSchema.parse(unitId); await funding(tx, unitId, true);
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision);
    const authority = await rewardPostingAuthorityTx(tx, unit, roles);
    if (authority === 'no-seat') throw new RewardError('The assigned payroll role is required.');
    if (authority === 'needs-admin') throw new RewardError('Company administrator access is required.');
    if (unit.status === 'posted') return { alreadyPosted: true as const,unit,roles,entries };
    if (unit.status !== 'approved' || unit.approvedDigest !== digest(unit, entries)) throw new RewardError('Only the unchanged, fully approved review can be posted.');
    const postingAwards=await seniorAwardsTx(tx,unitId,true);
    if(unit.kind==='annual'&&entries.some(entry=>isSeniorPlanMember(unit.policy,entry.facts,entry.source.grade)&&(!postingAwards[entry.id]?.confirmedBy||postingAwards[entry.id].sourceFingerprint!==seniorSourceFingerprint(entry))))throw new RewardError('Every Senior plan member needs an independently confirmed offline decision before payroll transfer.');
    const result = await calculateUnit(tx, unit, entries,true);
    if (result.flags.some(f => f.severity === 'block')) throw new RewardError('The approved review no longer passes validation.');
    const hasBonus = result.rows.some(e => e.bonusCents + e.lumpCents > 0||isSeniorPlanMember(unit.policy,e.facts,e.source.grade));
    if (hasBonus && !batchId) throw new RewardError('Select a draft payroll batch for the bonus and lump-sum awards.');
    if (batchId) {
      const query=tx.select().from(payrollBatch).where(eq(payrollBatch.id,batchId));
      const [batch]=await (reviewed ? query.for('update',{noWait:true}) : query.for('update'));
      if (!batch || batch.companyId !== unit.companyId || batch.status !== 'draft') throw new RewardError('The payroll batch must be a draft in this company.');
    }
    return {alreadyPosted:false as const,unit,roles,entries,result,postingAwards};
}

async function currentRewardPostEmployeeTx(tx:Tx,unit:typeof rewardUnit.$inferSelect,e:Awaited<ReturnType<typeof calculateUnit>>['rows'][number],reviewed=false){
      const [emp] = await tx.select().from(employment).where(eq(employment.id, e.source.employmentId)).for('update',reviewed?{noWait:true}:undefined);
      if (!emp || emp.companyId !== unit.companyId || emp.terminatedOn || emp.gradeId !== e.source.gradeId) throw new RewardError('An employee changed company, grade or employment status. Return and refresh the review.');
      if(isSeniorPlanMember(unit.policy,e.facts,e.source.grade)){
        const [grade]=await tx.select({code:jobGrade.code}).from(jobGrade).where(eq(jobGrade.id,emp.gradeId!)).for('share',reviewed?{noWait:true}:undefined);
        const currentGrade=(grade?.code??'').replace(/^JG\s*/i,'').trim();
        if(currentGrade!==e.source.grade||!seniorGrade(currentGrade))throw new RewardError('The Senior employee grade changed after the snapshot. Return and refresh the review.');
      }
      const [cur] = await tx.select().from(compensation).where(and(eq(compensation.employmentId, emp.id), isNull(compensation.validTo), isNull(compensation.supersededAt))).for('update',reviewed?{noWait:true}:undefined);
      if (!cur || cur.id !== e.source.compensationId || moneyToCents(cur.basicSalary) !== e.source.basicCents || cur.currency !== e.source.currency || cur.payMode !== e.source.payMode) throw new RewardError('Salary data changed after the snapshot. Return and refresh the review.');
      return {emp,cur};
}

async function postRewardEffectTx(tx:Tx,ctx:SessionContext,unitId:string,revision:number,batchId:string|undefined,
 prepared:Extract<Awaited<ReturnType<typeof prepareRewardPostTx>>,{alreadyPosted:false}>,returnEventId=false){
 const {unit,result}=prepared;
    // Deterministic lock order makes simultaneous reward units on the same people serialize.
    for (const e of [...result.rows].sort((a, b) => a.source.employmentId.localeCompare(b.source.employmentId))) {
      const {emp,cur}=await currentRewardPostEmployeeTx(tx,unit,e);
      if (e.newBasicCents !== e.source.basicCents) {
        if (unit.policy.effectiveFrom <= cur.validFrom) throw new RewardError('The salary effective date must follow the current salary record.');
        const comp = await setCompensation(ctx, { employmentId: emp.id, basicSalary: e.newBasicCents / 100, effectiveFrom: unit.policy.effectiveFrom, remarks: `${isSeniorPlanMember(unit.policy,e.facts,e.source.grade)?'Senior plan — ':''}Approved Reward Desk review ${unitId}` }, tx);
        await tx.update(rewardEntry).set({ enactedCompensationId: comp.compensationId }).where(eq(rewardEntry.id, e.id));
      }
      // 40bf44f7: a leaver's retained recommendation is a record only; it never changes their grade.
      if (e.recommendation.promotionGrade && !e.source.leftOn && !isSeniorPlanMember(unit.policy,e.facts,e.source.grade)) {
        // Grade is currently an undated employment attribute: do not silently apply a future promotion today.
        if (unit.policy.effectiveFrom !== todayInKualaLumpur()) throw new RewardError('A promotion must be posted on its effective date because Job Grade is not effective-dated.');
        const grades = await tx.select().from(jobGrade).where(isNull(jobGrade.archivedAt));
        const grade = grades.find(g => g.code.replace(/^JG\s*/i, '') === e.recommendation.promotionGrade);
        if (!grade) throw new RewardError('The approved promotion grade does not exist in Job Grades.');
        await setEmploymentGrade(ctx, { employmentId: emp.id, gradeId: grade.id }, tx);
      }
      const award = e.bonusCents + e.lumpCents;
      if ((award||isSeniorPlanMember(unit.policy,e.facts,e.source.grade)) && batchId) {
        const [existing] = await tx.select().from(payrollInput).where(and(eq(payrollInput.batchId, batchId), eq(payrollInput.employmentId, emp.id))).for('update');
        await setPayrollInput(ctx, { batchId, employmentId: emp.id, overtimeAmount: Number(existing?.overtimeAmount ?? 0), bonusAmount: Number(existing?.bonusAmount ?? 0) + award / 100, tp1Deduction: Number(existing?.tp1Deduction ?? 0), zakat: Number(existing?.zakat ?? 0), otSource: 'preserve', tp1SourceMode: 'preserve' }, tx);
        if(isSeniorPlanMember(unit.policy,e.facts,e.source.grade)){
          const decision=prepared.postingAwards[e.id];
          if(!decision?.confirmedBy||!decision.confirmedAt)throw new RewardError('Senior decision lost its independent confirmation.');
          const source={unitId,entryId:e.id,revision,plan:'Senior plan' as const,confirmedBy:decision.confirmedBy,confirmedAt:decision.confirmedAt,historicalOnly:true as const};
          const sources=[...(existing?.rewardProvenance??[]).filter(item=>item.unitId!==unitId||item.entryId!==e.id),source];
          if(sources.length>100)throw new RewardError('This payroll input has too many historical reward sources.');
          await tx.update(payrollInput).set({rewardProvenance:sources}).where(and(eq(payrollInput.batchId,batchId),eq(payrollInput.employmentId,emp.id)));
        }
      }
    }
    await tx.update(rewardUnit).set({ status: 'posted', fundingCents: unit.kind === 'annual' ? { standard: result.budgets.standard.pools.reduce((n, amount, i) => n + Math.max(0, amount - result.budgets.standard.used[i]), 0), h: result.budgets.h.pools.reduce((n, amount, i) => n + Math.max(0, amount - result.budgets.h.used[i]), 0) } : unit.fundingCents, postedBatchId: batchId ?? null, postedAt: new Date(), updatedAt: new Date() }).where(eq(rewardUnit.id, unitId));
    const postedEventId=await stamp(tx, ctx, unitId, 'posted', { batchId: batchId ?? null, revision, seniorPlanEntryIds:result.rows.filter(entry=>isSeniorPlanMember(unit.policy,entry.facts,entry.source.grade)).map(entry=>entry.id) },returnEventId);
    return { alreadyPosted: false, ...(returnEventId?{postedEventId}: {}) };
}

export async function postRewardUnit(ctx: SessionContext, unitId: string, revision: number, batchId?: string) {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if (batchId) idSchema.parse(batchId);
  assertModuleGate(ctx, 'payroll');
  return withRewardsTenant(ctx, async tx => {
    // Posting can enact an approved grade change. Own the graph interval before funding/source,
    // credit/Payroll or employment locks rather than upgrading at the later grade-writer call.
    await tx.execute(sql`select app.access_workforce_write_lock()`);
    await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
    const prepared=await prepareRewardPostTx(tx,ctx,unitId,revision,batchId);
    if(prepared.alreadyPosted)return {alreadyPosted:true};
    return postRewardEffectTx(tx,ctx,unitId,revision,batchId,prepared);

  });
}

type ReviewedRewardPostSelection={unitId:string;revision:number;batchId:string|null};
// A JS array interpolated into a drizzle sql template becomes a ROW of parameters, not a uuid[]; build an
// explicit typed array (empty-safe) as the other review owners do.
const rewardUuidArray=(ids:readonly string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
const captureRewardPostContext=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
async function reviewedRewardPostPrincipalTx(tx:Tx,ctx:SessionContext){
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));const roles=ctx.roles??Array.from(new Set(grants.map(g=>g.role)));
 const [proof]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.app_user u where u.id=${ctx.userId??null}::uuid
  and u.tenant_id=${ctx.tenantId}::uuid and u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id()
  and u.person_id is not distinct from ${ctx.personId??null}::uuid and u.archived_at is null and not app.login_blocked(u.id)
  and current_setting('transaction_isolation')='read committed' and app.principal_snapshot_current()
  and current_setting('app.roles',true)=${roles.join(',')} and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb) as allowed`);
 if(!proof?.allowed)throw new RewardError('Current Rewards principal is unavailable.');
}
async function reviewedRewardPostAuthorityTx(tx:Tx,ctx:SessionContext,unitId:string){
 await reviewedRewardPostPrincipalTx(tx,ctx);
 idSchema.parse(unitId);
 const [nominee]=await tx.select({id:rewardUnit.id,companyId:rewardUnit.companyId,parentUnitId:rewardUnit.parentUnitId,deletedAt:rewardUnit.deletedAt})
  .from(rewardUnit).where(eq(rewardUnit.id,unitId));
 if(!nominee||nominee.deletedAt)throw new RewardError('Reward unit not found or access has been removed.');
 // H1: the same single posting-authority owner as postRewardUnit and the review page's Post button.
 const roles=await rolesFor(tx,unitId),authority=await rewardPostingAuthorityTx(tx,nominee,roles);
 if(authority==='no-seat')throw new RewardError('The assigned payroll role is required.');
 if(authority==='needs-admin')throw new RewardError('Company administrator access is required.');
 return nominee;
}
/** Advisory post-selection metadata only. No entries, compensation, budgets or hidden-person
 * arrays are loaded. Native prepare remains the sole posting eligibility/calculation owner. */
export async function reviewedRewardPostChoiceMetadataTx(tx:Tx,supplied:SessionContext){
 const ctx=captureRewardPostContext(supplied);await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);await reviewedRewardPostPrincipalTx(tx,ctx);
 const nominees=await tx.select({id:rewardUnit.id}).from(rewardUnit).where(and(eq(rewardUnit.tenantId,ctx.tenantId),isNull(rewardUnit.deletedAt),eq(rewardUnit.status,'approved'),sql`exists(select 1 from app.reward_roles(${rewardUnit.id}) as assigned(role) where assigned.role='payroll')`,sql`app.reward_admin(${rewardUnit.companyId})`)).orderBy(asc(rewardUnit.id)).limit(21);
 const units=[];
 for(const nominated of nominees.slice(0,20)){
  const owned=await reviewedRewardPostAuthorityTx(tx,ctx,nominated.id);
  const [row]=await tx.select({unitId:rewardUnit.id,revision:rewardUnit.revision,companyName:company.legalName,name:businessUnitDisplayName,cycleName:rewardCycle.name,year:rewardCycle.year,kind:rewardUnit.kind}).from(rewardUnit).innerJoin(company,eq(company.id,rewardUnit.companyId)).innerJoin(rewardCycle,eq(rewardCycle.id,rewardUnit.cycleId)).innerJoin(businessUnit,eq(businessUnit.id,rewardUnit.businessUnitId)).where(and(eq(rewardUnit.id,owned.id),eq(rewardUnit.status,'approved'),isNull(rewardUnit.deletedAt)));
  if(!row)throw new RewardError('The selected Rewards metadata changed.');
  const batches=await tx.select({id:payrollBatch.id,payPeriod:payrollBatch.payPeriod}).from(payrollBatch).where(and(eq(payrollBatch.tenantId,ctx.tenantId),eq(payrollBatch.companyId,owned.companyId),eq(payrollBatch.status,'draft'))).orderBy(desc(payrollBatch.payPeriod),asc(payrollBatch.id)).limit(21);
  units.push({...row,batches:batches.slice(0,20),batchesTruncated:batches.length>20});
 }
 return {units,truncated:nominees.length>20};
}
export async function lockReviewedRewardPostSourceTx(tx:Tx,supplied:SessionContext,unitId:string){
 const ctx=captureRewardPostContext(supplied),id=idSchema.parse(unitId);
 await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 // Minimal selection/current native role and company authority BEFORE funding, private entries or employee locks.
 const nominee=await reviewedRewardPostAuthorityTx(tx,ctx,id);
 if(nominee.parentUnitId)await tx.select({id:rewardUnit.id}).from(rewardUnit).where(eq(rewardUnit.id,nominee.parentUnitId)).for('update',{noWait:true});
 await tx.select({id:rewardUnit.id}).from(rewardUnit).where(eq(rewardUnit.id,id)).for('update',{noWait:true});
 const current=await reviewedRewardPostAuthorityTx(tx,ctx,id);if(JSON.stringify(current)!==JSON.stringify(nominee))throw new RewardError('The reward unit source changed.');
 return {ctx,unit:current};
}
async function reviewedRewardPostPreflightTx(tx:Tx,supplied:SessionContext,selection:ReviewedRewardPostSelection){
 const p=structuredClone(selection);if(p.batchId)idSchema.parse(p.batchId);const {ctx}=await lockReviewedRewardPostSourceTx(tx,supplied,p.unitId);
 const prepared=await prepareRewardPostTx(tx,ctx,p.unitId,p.revision,p.batchId??undefined,true);
 if(prepared.alreadyPosted)throw new RewardError('Reopen the recorded posting instead of preparing another.');
 const {unit,result,roles,entries}=prepared;
 await tx.select({id:rewardEntry.id}).from(rewardEntry).where(eq(rewardEntry.unitId,unit.id)).orderBy(asc(rewardEntry.id)).for('update',{noWait:true});
 // The canonical unit lock protects all native entry writers. Re-read exact rows after explicit ownership
 // as well, so no directly changed version can be reviewed and then silently enacted.
 const locked=await load(tx,unit.id);if(JSON.stringify(locked.entries)!==JSON.stringify(entries))throw new RewardError('The reward entries changed.');
 const subjects=[...new Set(result.rows.map(row=>row.source.employmentId))].sort();
 await lockLeaveDependenciesTx(tx,ctx.tenantId,subjects);
 const protectedSource=await load(tx,unit.id);if(!isDeepStrictEqual(protectedSource.entries,locked.entries))throw new RewardError('The whole reward source set changed.');
 const sourceRows=[];
 for(const row of [...result.rows].sort((a,b)=>a.source.employmentId.localeCompare(b.source.employmentId))){
  const {emp,cur}=await currentRewardPostEmployeeTx(tx,unit,row,true);
  let input:typeof payrollInput.$inferSelect|undefined;
  if(p.batchId&&row.bonusCents+row.lumpCents){const [existing]=await tx.select().from(payrollInput).where(and(eq(payrollInput.batchId,p.batchId),eq(payrollInput.employmentId,emp.id))).for('update',{noWait:true});input=existing;}
  sourceRows.push({employmentId:emp.id,compensationId:cur.id,payrollInputId:input?.id??null});
 }
 const [batch]=p.batchId?await tx.select({id:payrollBatch.id,payPeriod:payrollBatch.payPeriod}).from(payrollBatch).where(eq(payrollBatch.id,p.batchId)):[];
 const visible=result.rows.filter(row=>visibleEntry(row,roles,ctx.personId));
 const [cycle]=await tx.select({id:rewardCycle.id,name:rewardCycle.name,year:rewardCycle.year}).from(rewardCycle).where(eq(rewardCycle.id,unit.cycleId));
 const [bu]=await tx.select({name:businessUnitDisplayName}).from(businessUnit).where(eq(businessUnit.id,unit.businessUnitId));
 if(!cycle||!bu)throw new RewardError('The reward cycle or business unit changed.');
 const review={unitId:unit.id,revision:unit.revision,companyId:unit.companyId,businessUnitId:unit.businessUnitId,name:bu.name,cycleName:cycle.name,year:cycle.year,kind:unit.kind,effectiveFrom:unit.policy.effectiveFrom,
  batch:batch??null,hiddenCount:entries.length-visible.length,
  rows:visible.map(row=>({entryId:row.id,employmentId:row.source.employmentId,employeeCode:row.source.employeeCode,name:row.source.name,currency:row.source.currency,
   basicCents:row.source.basicCents,newBasicCents:row.newBasicCents,promotionGrade:row.recommendation.promotionGrade,
   bonusCents:row.bonusCents,lumpCents:row.lumpCents})),
  scope:'whole_approved_unit_including_restricted_records' as const,consequence:'salary_grade_and_draft_payroll_inputs_not_processed_or_paid' as const};
 const versions=await tx.execute(sql`select
  (select jsonb_agg(jsonb_build_array(u.id,u.xmin::text) order by u.id) from public.reward_unit u where u.id=${unit.id}::uuid or u.id=${unit.parentUnitId}::uuid or u.parent_unit_id=${unit.parentUnitId}::uuid) as units,
  (select jsonb_agg(jsonb_build_array(e.id,e.xmin::text) order by e.id) from public.reward_entry e where e.unit_id=${unit.id}::uuid) as entries,
  (select jsonb_agg(jsonb_build_array(e.id,e.xmin::text) order by e.id) from public.employment e where e.id=any(${rewardUuidArray(result.rows.map(row=>row.source.employmentId))})) as employments,
  (select jsonb_agg(jsonb_build_array(c.id,c.xmin::text) order by c.id) from public.compensation c where c.id=any(${rewardUuidArray(sourceRows.map(row=>row.compensationId))})) as compensations,
  (select jsonb_agg(jsonb_build_array(g.id,g.xmin::text) order by g.id) from public.job_grade g) as grades,
  (select b.xmin::text from public.payroll_batch b where b.id=${p.batchId}::uuid) as batch,
  (select jsonb_agg(jsonb_build_array(i.id,i.xmin::text) order by i.id) from public.payroll_input i where i.batch_id=${p.batchId}::uuid and i.employment_id=any(${rewardUuidArray(result.rows.map(row=>row.source.employmentId))})) as inputs`);
 const available=await funding(tx,unit.id);
 const reviewedDigest=createHash('sha256').update(JSON.stringify(['reviewed-rewards-post:v1',{tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null},p,unit,entries,result,sourceRows,versions,available,review])).digest('hex');
 return{ctx,p,prepared,review,reviewedDigest};
}
export async function prepareReviewedRewardPostTx(tx:Tx,ctx:SessionContext,p:ReviewedRewardPostSelection){const prepared=await reviewedRewardPostPreflightTx(tx,ctx,p);return{review:prepared.review,reviewedDigest:prepared.reviewedDigest};}
export async function postReviewedRewardUnitTx(tx:Tx,ctx:SessionContext,p:ReviewedRewardPostSelection,reviewedDigest:string){
 const prepared=await reviewedRewardPostPreflightTx(tx,ctx,p);if(prepared.reviewedDigest!==reviewedDigest)throw new RewardError('The approved posting source changed.');
 const effect=await postRewardEffectTx(tx,prepared.ctx,prepared.p.unitId,prepared.p.revision,prepared.p.batchId??undefined,prepared.prepared,true);
 if(!effect.postedEventId)throw new RewardError('The native posting event is unavailable.');
 const receipt=await readReviewedRewardPostReferenceTx(tx,prepared.ctx,{unitId:prepared.p.unitId,postedEventId:effect.postedEventId});
 if(!receipt)throw new RewardError('The canonical posting reference is unavailable.');return receipt;
}
/** Exact original-actor native unit posting plus CURRENT root metadata. No old salary text, hidden
 * employee/input IDs, payslip/payment claim, or automatic second posting on a completed retry. */
export async function readReviewedRewardPostReferenceTx(tx:Tx,supplied:SessionContext,reference:{unitId:string;postedEventId:string}){
 const p={...reference},{ctx}=await lockReviewedRewardPostSourceTx(tx,supplied,p.unitId);
 const [row]=await tx.execute<{unitId:string;postedEventId:string;currentStatus:typeof rewardUnit.$inferSelect['status'];currentRevision:number;postedRevision:number;postedBatchId:string|null}>(sql`select u.id as "unitId",d.id as "postedEventId",u.status as "currentStatus",u.revision as "currentRevision",(d.payload->>'revision')::integer as "postedRevision",u.posted_batch_id as "postedBatchId"
  from public.reward_unit u join public.domain_event d on d.tenant_id=u.tenant_id and d.aggregate_id=u.id
  where u.id=${p.unitId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.deleted_at is null and d.id=${p.postedEventId}::uuid
   and d.aggregate_type='reward-unit' and d.event_type='reward-unit.posted' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid
   and (d.payload->>'batchId')::uuid is not distinct from u.posted_batch_id`);
 return row??null;
}

export async function createOffcycleReview(ctx: SessionContext, parentId: string, raw: { kind: 'adhoc' | 'midyear'; entryIds: string[]; effectiveFrom: string; exceptionReason: string }) {
  idSchema.parse(parentId);
  const p = z.object({ kind: z.enum(['adhoc', 'midyear']), entryIds: z.array(idSchema).min(1).max(10000), effectiveFrom: isoDateSchema, exceptionReason: z.string().trim().max(4000) }).parse(raw);
  if (p.kind === 'adhoc' && p.entryIds.length !== 1) throw new RewardError('Select exactly one employee for an ad-hoc request.');
  if (new Set(p.entryIds).size !== p.entryIds.length) throw new RewardError('Select each employee only once.');
  if (p.exceptionReason && (p.kind !== 'adhoc' || p.exceptionReason.length < 30)) throw new RewardError('A budget exception is available only for an ad-hoc request and needs a reason of at least 30 characters.');
  return withRewardsTenant(ctx, async tx => {
    await tx.execute(sql`select app.access_workforce_write_lock()`);
    const { unit: parent, roles, entries } = await load(tx, parentId, true);
    if (parent.kind !== 'annual' || parent.status !== 'posted') throw new RewardError('Use a posted annual review as the funding source.');
    if (!roles.some(r => ['bu', 'bg', 'gr'].includes(r))) throw new RewardError('BU, BG or Group Rewards access is required.');
    if (p.effectiveFrom <= parent.policy.effectiveFrom) throw new RewardError('The off-cycle effective date must follow the annual award.');
    const selected = p.entryIds.map(id => entries.find(e => e.id === id));
    if (selected.some(e => !e || !visibleEntry(e, roles, ctx.personId))) throw new RewardError('The request contains an unavailable employee.');
    const chosen = selected as typeof entries;
    const bgOrigin = !roles.includes('bu') && !roles.includes('gr') && roles.includes('bg');
    if (bgOrigin && (p.kind !== 'adhoc' || chosen.some(e => e.facts.confidentiality !== 'bg'))) throw new RewardError('BG may originate an ad-hoc request for a BG direct report.');
    const id = randomUUID();
    const [unit] = await tx.insert(rewardUnit).values({ id, tenantId: ctx.tenantId, createdBy: ctx.userId!, cycleId: parent.cycleId, companyId: parent.companyId, businessUnitId: parent.businessUnitId,
      kind: p.kind, parentUnitId: parent.id, offcycle: { exceptionReason: p.exceptionReason, bgOrigin },
      policy: { ...parent.policy, effectiveFrom: p.effectiveFrom }, snapshotDate: todayInKualaLumpur(),
    }).returning();
    const members = await tx.select({ userId: rewardMember.userId, role: rewardMember.role,validFrom:rewardMember.validFrom,validTo:rewardMember.validTo,coversUserId:rewardMember.coversUserId,restoredReason:rewardMember.restoredReason,restoredFingerprint:rewardMember.restoredFingerprint }).from(rewardMember).where(and(eq(rewardMember.unitId,parentId),sql`app.reward_member_eligible(${rewardMember.id})`));
    for (const m of members) await tx.insert(rewardMember).values({ tenantId: ctx.tenantId, unitId: id,...m });
    for (const e of chosen) {
      const [record] = await tx.execute<{ source: Partial<RewardSource> | null }>(sql`select app.reward_current_source(${parentId}::uuid, ${e.employmentId}::uuid) as source`);
      if (!record.source) throw new RewardError('An employee has left this company or has no current salary.');
      const source = { ...e.source, ...record.source };
      if (source.lastPayChange && p.effectiveFrom <= source.lastPayChange) throw new RewardError('The effective date must follow the current salary record.');
      await tx.insert(rewardEntry).values({ tenantId: ctx.tenantId, unitId: id, employmentId: e.employmentId, source, facts: e.facts, recommendation: emptyRecommendation() });
    }
    await stamp(tx, ctx, id, 'created', { parentId, kind: unit.kind, employeeCount: chosen.length });
    return id;
  });
}

export async function pendingRewardReviews(ctx: SessionContext, companyIds: string[]) {
  return withRewardsTenant(ctx, async tx => {
    if (!companyIds.length) return [];
    return tx.select({ id: rewardUnit.id, kind: rewardUnit.kind, status: rewardUnit.status, name: businessUnitDisplayName, cycle: rewardCycle.name })
      .from(rewardUnit).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId))
      .where(and(inArray(rewardUnit.companyId, companyIds), sql`${rewardUnit.status} in ('bg','gr','ctro','ec')`, sql`${rewardUnit.status} in (select app.reward_roles(${rewardUnit.id}))`))
      .orderBy(asc(rewardUnit.createdAt), asc(rewardUnit.id));
  });
}

/** In-app notification fan-out for the shared dispatcher; payloads contain no employee pay. */
/** Pool changes concern every live approver, independently of the review's current routing stage. */
export async function rewardPoolNotificationRecipients(tx:Tx,unitId:string):Promise<string[]>{
 const rows=await tx.execute<{employmentId:string}>(sql`select app.reward_pool_notification_recipients(${unitId}::uuid) as "employmentId"`);
 return rows.map(row=>row.employmentId);
}

export async function rewardNotificationRecipients(tx: Tx, unitId: string, stage: unknown): Promise<string[]> {
  if (typeof stage !== 'string') return [];
  const role = stage === 'approved' ? 'payroll' : stage === 'draft' ? 'bu' : stage;
  if (!(rewardRoles as readonly string[]).includes(role)) return [];
  const rows = await tx.execute<{ employmentId: string }>(sql`select app.reward_notification_recipients(${unitId}::uuid, ${stage}) as "employmentId"`);
  return rows.map(r => r.employmentId);
}

export async function rewardAccessSuspensionEventRecipients(tx:Tx,eventId:string|undefined):Promise<string[]>{
 if(!eventId)return [];
 const rows=await tx.execute<{employment_id:string}>(sql`select app.reward_access_suspension_event_recipients(${eventId}::uuid) as employment_id`);
 return rows.map(row=>row.employment_id);
}
export async function rewardAccessSuspensionRecipients(tx:Tx,unitId:string):Promise<string[]>{
 const rows=await tx.execute<{employment_id:string}>(sql`select app.reward_access_suspension_recipients(${unitId}::uuid) as employment_id`);
 return rows.map(row=>row.employment_id);
}

/** Explicit Group Rewards import. Re-opens fact verification and invalidates approval digests. */
export async function importOnehrRewardResults(ctx: SessionContext, unitId: string, expected: number) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true);
    assertRevision(unit, expected); assertUnlocked(unit);
    if (!roles.includes('gr') || unit.kind !== 'annual') throw new RewardError('Only Group Rewards may import annual assessment results.');
    let imported = 0;
    for (const entry of entries) {
      if (!visibleEntry(entry, roles, ctx.personId)) continue;
      const onehr = await onehrRewardResultTx(tx, entry.source.employmentId, unit.policy.year, unit.id);
      if (!onehr) continue;
      await tx.update(rewardEntry).set({ source: {...entry.source, onehr, onehrFactImport:{resultId:onehr.id,digest:onehr.digest,importedAt:new Date().toISOString()}, performanceReviewId:onehr.reviewId, performanceRating:null}, facts:factsFromOnehr(onehr,entry.facts), updatedAt:new Date() }).where(eq(rewardEntry.id,entry.id));
      imported++;
    }
    if (!imported) throw new RewardError('No finalized assessment results are available for this roster and reward year.');
    await touch(tx,unitId); await stamp(tx,ctx,unitId,'onehr-results-imported',{count:imported});
    return { imported };
  });
}

const REWARD_TASK_APPROVAL_STAGES = ['bg', 'gr', 'ctro', 'ec'] as const;

/**
 * Rewards work awaiting the viewer, projected into the shared task list (WP-A1; core/approvals-inbox.ts
 * PACK_TASK_SOURCES). Two owners decide the rows; this function only supplies what the shared list needs:
 *
 *   - `pendingRewardReviews` — the queue /approvals already renders as its Rewards card: a unit at an
 *     approval stage (bg, gr, ctro, ec) that `app.reward_roles` says is THIS viewer's stage. A BU or PBP
 *     member therefore sees nothing while the unit sits at BG; the BG member sees it.
 *   - `returnedRewardUnits` — a draft whose latest decision is a return, for the viewer holding the seat it
 *     was returned to (BU CEO, or BG CEO for a BG-originated off-cycle request). Its reason and actor are
 *     NOT projected.
 *
 * The first read is the cheap exit and the unscoped company source: the units the viewer can read at all
 * (RLS) that sit at an approval stage or are drafts whose latest decision is a return. A viewer with none
 * (almost everyone, on almost every page) costs one query. `pendingRewardReviews` takes company ids and
 * answers [] for none, but Home and My tasks ask without a company selection, so the companies come from
 * that read — a superset of the queue, which still decides every row.
 *
 * Payload: id, kind, subject name, owner timestamp and link. No pay, budget, band, recommendation, return
 * reason or actor.
 */
export async function pendingRewardTasks(ctx: SessionContext, scopeIds: string[] | undefined): Promise<PackTaskItem[]> {
  await withRewardsTenant(ctx,tx=>tx.execute(sql`select app.reward_access_observe(NULL::uuid)`));
  const readable = await withRewardsTenant(ctx, (tx) => tx
    .select({ id: rewardUnit.id, companyId: rewardUnit.companyId, status: rewardUnit.status, createdAt: rewardUnit.createdAt })
    .from(rewardUnit)
    .where(and(isNull(rewardUnit.deletedAt), or(
      inArray(rewardUnit.status, [...REWARD_TASK_APPROVAL_STAGES]),
      and(eq(rewardUnit.status, 'draft'), sql`${latestDecisionActionSql}='return'`),
    ))));
  if (!readable.length) return [];
  const atApproval = readable.filter((u) => u.status !== 'draft');
  const createdAt = new Map(atApproval.map((u) => [u.id, u.createdAt]));
  const companyIds = scopeIds ?? [...new Set(atApproval.map((u) => u.companyId))];
  const [queue, returned] = await Promise.all([
    atApproval.length ? pendingRewardReviews(ctx, companyIds) : Promise.resolve([]),
    atApproval.length < readable.length ? returnedRewardUnits(ctx, scopeIds) : Promise.resolve([]),
  ]);
  // A unit that entered the queue between the two reads has no owner time here; it is left to the next
  // read rather than given a guessed age (lib/assigned-work.ts: never a guessed task age).
  const approvals: PackTaskItem[] = queue.flatMap((r) => {
    const at = createdAt.get(r.id);
    return at ? [{ id: r.id, kind: 'rewardReview' as const, subjectName: `${r.cycle} · ${r.name}`, createdAt: at.toISOString(), linkPath: `/rewards/${r.id}?view=approvals` }] : [];
  });
  // A unit is a draft or at an approval stage, never both; the reads are separate, so a unit that moved
  // between them is listed once (its approval-stage row wins).
  const listed = new Set(approvals.map((t) => t.id));
  const back: PackTaskItem[] = returned.filter((r) => !listed.has(r.id)).map((r) => ({
    id: r.id, kind: 'rewardReview' as const, subjectName: `${r.cycle} · ${r.name}`, createdAt: r.returnedAt, linkPath: `/rewards/${r.id}`,
  }));
  return [...approvals, ...back];
}

// ── Reward calendar (migration 0646) ────────────────────────────────────────────────────────────────────

type CalendarRow = typeof rewardCalendar.$inferSelect;
const calendarValues = (r: CalendarRow): RewardCalendarValues => ({
  due: { bu: r.buDue, returned: r.returnedDue, bg: r.bgDue, gr: r.grDue, ctro: r.ctroDue, ec: r.ecDue, payroll: r.payrollDue },
  caseDue: r.caseDue,
  offcycleDays: { bg: r.offcycleBgDays, gr: r.offcycleGrDays, ctro: r.offcycleCtroDays, ec: r.offcycleEcDays, returned: r.offcycleReturnedDays },
});
/** The calendar for a (cycle, company), read through reward_calendar RLS; null when none is set or readable. */
async function calendarTx(tx: Tx, cycleId: string, companyId: string): Promise<RewardCalendarValues | null> {
  const [row] = await tx.select().from(rewardCalendar).where(and(eq(rewardCalendar.cycleId, cycleId), eq(rewardCalendar.companyId, companyId)));
  return row ? calendarValues(row) : null;
}
async function calendarUnit(tx: Tx, unitId: string) {
  idSchema.parse(unitId);
  const [unit] = await tx.select({ id: rewardUnit.id, cycleId: rewardUnit.cycleId, companyId: rewardUnit.companyId, deletedAt: rewardUnit.deletedAt }).from(rewardUnit).where(eq(rewardUnit.id, unitId));
  if (!unit || unit.deletedAt) throw new RewardError('Reward unit not found or access has been removed.');
  const [access] = await tx.execute<{ read: boolean; write: boolean }>(sql`select app.reward_calendar_access(${unit.cycleId}::uuid, ${unit.companyId}::uuid, false) as read, app.reward_calendar_access(${unit.cycleId}::uuid, ${unit.companyId}::uuid, true) as write`);
  if (!access?.read) throw new RewardError('Ask an administrator to assign your Reward Desk role for this unit.');
  return { unit, canEdit: !!access.write };
}

/** The reward calendar of the review's cycle in the review's company. Dates only; no pay. */
export async function getRewardCalendar(ctx: SessionContext, unitId: string) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, canEdit } = await calendarUnit(tx, unitId);
    const [row] = await tx.select().from(rewardCalendar).where(and(eq(rewardCalendar.cycleId, unit.cycleId), eq(rewardCalendar.companyId, unit.companyId)));
    return { cycleId: unit.cycleId, companyId: unit.companyId, revision: row?.revision ?? 0, values: row ? calendarValues(row) : emptyRewardCalendar(), canEdit };
  });
}

/**
 * Save the calendar for the review's (cycle, company). Writers: a company HR administrator or the Group
 * Rewards seat (enforced again by reward_calendar RLS). `revision` is what the editor opened: 0 for a calendar
 * not yet created. A stale form is refused rather than overwriting another person's dates.
 */
export async function saveRewardCalendar(ctx: SessionContext, unitId: string, revision: number, raw: unknown) {
  const values = rewardCalendarSchema.parse(raw);
  return withRewardsTenant(ctx, async tx => {
    const { unit, canEdit } = await calendarUnit(tx, unitId);
    if (!canEdit) throw new RewardError('The reward calendar is maintained by Group Rewards or a company HR administrator.');
    const [existing] = await tx.select().from(rewardCalendar).where(and(eq(rewardCalendar.cycleId, unit.cycleId), eq(rewardCalendar.companyId, unit.companyId))).for('update');
    if ((existing?.revision ?? 0) !== revision) throw new RewardError('The reward calendar changed in another session. Reload before saving.');
    const columns = {
      buDue: values.due.bu, returnedDue: values.due.returned, bgDue: values.due.bg, grDue: values.due.gr, ctroDue: values.due.ctro, ecDue: values.due.ec, payrollDue: values.due.payroll,
      caseDue: values.caseDue,
      offcycleBgDays: values.offcycleDays.bg, offcycleGrDays: values.offcycleDays.gr, offcycleCtroDays: values.offcycleDays.ctro, offcycleEcDays: values.offcycleDays.ec, offcycleReturnedDays: values.offcycleDays.returned,
      updatedBy: ctx.userId!, updatedAt: new Date(),
    };
    const [saved] = existing
      ? await tx.update(rewardCalendar).set({ ...columns, revision: existing.revision + 1 }).where(eq(rewardCalendar.id, existing.id)).returning({ id: rewardCalendar.id, revision: rewardCalendar.revision })
      : await tx.insert(rewardCalendar).values({ tenantId: ctx.tenantId, cycleId: unit.cycleId, companyId: unit.companyId, ...columns }).returning({ id: rewardCalendar.id, revision: rewardCalendar.revision });
    // Deadlines stay editable after launch (62e743ed): the audit carries the dates before and after.
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'reward-calendar', aggregateId: saved.id, eventType: 'reward-calendar.updated', actor: actorOf(ctx), payload: { cycleId: unit.cycleId, companyId: unit.companyId, revision: saved.revision, values, before: existing ? calendarValues(existing) : null, after: values } });
    return saved.revision;
  });
}

// ── Approvals board (P1 WP-G) ────────────────────────────────────────────────────────────────────────────

const BOARD_STAGES = ['draft', 'bg', 'gr', 'ctro', 'ec', 'approved'] as const;
type ReviewProjection = Awaited<ReturnType<typeof reviewProjectionTx>>;
export type RewardBoardAction = 'submit' | 'approve' | 'post';
export type RewardBoardRow = {
  id: string; kind: 'annual' | 'adhoc' | 'midyear'; name: string; cycle: string; companyId: string; company: string;
  status: typeof BOARD_STAGES[number]; revision: number; returnedTo: 'bu' | 'bg' | null;
  seat: RewardRole | null; step: { step: number; steps: number } | null;
  /** Every step of the route with its state (rewardRouteProgress); null once the review has left the route. */
  progress: RewardRouteStep[] | null;
  /** Where a decision at the current step sends the review (rewardNextSeat); null at payroll or off the route. */
  nextSeat: RewardRole | null;
  due: string | null; daysUntilDue: number | null;
  /** The calendar's payroll date for this review (annual only), shown on the Matrix view's payroll column. */
  payrollDue: string | null;
  waiting: boolean; action: RewardBoardAction | null; canReturn: boolean;
  /** Waiting on the viewer, no blocking check and nothing that needs a written reason: the decision needs no note. */
  ready: boolean;
  /** Visible people only. Money is null ("—") when the viewer can see no record of the review. */
  people: number;
  salary: { increaseCents: number; poolCents: number; poolShareBp: number | null; overLimit: boolean } | null;
  bonus: { totalCents: number; budgetCents: number; budgetShareBp: number | null; overLimit: boolean } | null;
  exceptions: number; blocking: number;
};

/**
 * One board row from the review projection the review page itself renders (reviewProjectionTx): its `rows`
 * are already filtered by visibleEntry for THIS viewer, and its `flags` already withhold hidden records'
 * flags (a hidden block becomes ACCESS-01). Money is summed from those visible rows only — never from the
 * full roster — and only over the pooled plans (standard and JG H); the Executive plan consumes no pool.
 */
function boardRow(v: ReviewProjection, meta: { cycle: string; company: string }, today: string): RewardBoardRow {
  const { unit } = v, status = unit.status as typeof BOARD_STAGES[number];
  const seat = rewardStageSeat(unit.status, v.route), step = rewardStageStep(unit.status, v.route);
  const waiting = seat === 'payroll' ? v.posting === 'allowed' : !!seat && v.roles.includes(seat) && (unit.status !== 'draft' || v.canEdit);
  const action: RewardBoardAction | null = !waiting ? null : unit.status === 'draft' ? 'submit' : unit.status === 'approved' ? 'post' : 'approve';
  const blocking = v.flags.filter(f => f.severity === 'block').length, exceptions = v.flags.filter(f => f.severity === 'exception').length;
  const needsReason = v.flags.some(f => f.severity === 'exception' || f.severity === 'warning');
  // An off-cycle promotion needs the approver's explicit role-summary acknowledgement on the review page.
  const needsAcknowledgement = unit.kind !== 'annual' && v.rows.some(r => r.recommendation.promotionGrade);
  const pooled = v.rows.filter(r => r.plan === 'standard' || r.plan === 'h');
  const plans = ['standard', 'h'] as const;
  const seen = v.rows.length > 0;
  const usedBy = (plan: 'standard' | 'h') => { const g = pooled.filter(r => r.plan === plan); return [g.reduce((n, r) => n + r.meritCents, 0), g.reduce((n, r) => n + r.promotionCents, 0), g.reduce((n, r) => n + r.specialCents, 0)]; };
  const increaseCents = pooled.reduce((n, r) => n + r.newBasicCents - r.source.basicCents, 0);
  const poolCents = plans.reduce((n, p) => n + v.budgets[p].pools.reduce((a, b) => a + b, 0), 0);
  const salaryOver = plans.some(p => usedBy(p).some((used, i) => used > v.budgets[p].pools[i]));
  const annual = unit.kind === 'annual';
  const bonusOf = (plan: 'standard' | 'h') => pooled.filter(r => r.plan === plan).reduce((n, r) => n + r.bonusCents + r.lumpCents, 0);
  const totalCents = plans.reduce((n, p) => n + bonusOf(p), 0), budgetCents = plans.reduce((n, p) => n + v.budgets[p].bonusPoolCents, 0);
  return {
    id: unit.id, kind: unit.kind, name: v.name, cycle: meta.cycle, companyId: unit.companyId, company: meta.company,
    status, revision: unit.revision, returnedTo: v.returned?.toSeat ?? null, seat, step,
    progress: rewardRouteProgress(unit.status, v.route, v.decisions), nextSeat: rewardNextSeat(unit.status, v.route),
    due: v.due, daysUntilDue: v.due ? rewardDaysUntil(v.due, today) : null, payrollDue: v.payrollDue,
    waiting, action, canReturn: waiting && action === 'approve',
    ready: waiting && (action === 'approve' || action === 'submit') && blocking === 0 && !needsReason && !needsAcknowledgement,
    people: v.rows.length,
    salary: seen ? { increaseCents, poolCents, poolShareBp: poolCents > 0 ? Math.round(increaseCents * 10000 / poolCents) : null, overLimit: salaryOver } : null,
    bonus: seen && annual ? { totalCents, budgetCents, budgetShareBp: budgetCents > 0 ? Math.round(totalCents * 10000 / budgetCents) : null, overLimit: plans.some(p => bonusOf(p) > v.budgets[p].bonusPoolCents) } : null,
    exceptions, blocking,
  };
}

/**
 * The Approvals board (RW-03 WP-7): every live review on the route on which the viewer holds a Reward Desk
 * seat, in the companies of the viewer's current scope. Each review is read through reviewProjectionTx — the
 * review page's own read — so membership, entry visibility and flags cannot drift between the two screens.
 */
export async function rewardApprovalsBoard(ctx: SessionContext, companyIds: string[]) {
  await withRewardsTenant(ctx,tx=>tx.execute(sql`select app.reward_access_observe(NULL::uuid)`));
  return withRewardsTenant(ctx, async tx => {
    if (!companyIds.length) return [] as RewardBoardRow[];
    const units = await tx.select({ id: rewardUnit.id, cycle: rewardCycle.name, company: company.legalName })
      .from(rewardUnit).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).innerJoin(company, eq(company.id, rewardUnit.companyId))
      .where(and(inArray(rewardUnit.companyId, companyIds), isNull(rewardUnit.deletedAt), inArray(rewardUnit.status, [...BOARD_STAGES]),
        sql`exists(select 1 from app.reward_roles(${rewardUnit.id}))`))
      .orderBy(asc(company.legalName), asc(rewardCycle.name), asc(rewardUnit.id));
    const today = todayInKualaLumpur();
    const rows: RewardBoardRow[] = [];
    for (const u of units) rows.push(boardRow(await reviewProjectionTx(tx, ctx, u.id), u, today));
    return rows;
  });
}

/** 9040c2eb / b4729de7: the list uses exactly the review/board projection for seated viewers.
 * An administrator without a seat receives metadata only. Empty-state scope checks return booleans,
 * never names or counts from reviews outside the selected company scope. */
export async function listRewardReviewStatus(ctx:SessionContext,companyIds:string[]){
 return withRewardsTenant(ctx,async tx=>{
  const units=await listRewardUnitsTx(tx,companyIds),today=todayInKualaLumpur(),year=Number(today.slice(0,4));
  const rows=[];
  for(const unit of units){
   const roles=await rolesFor(tx,unit.id);
   if(!roles.length){rows.push({...unit,roles,waiting:false,salary:null,bonus:null,blocking:null,exceptions:null,laterSeats:[] as RewardRole[]});continue;}
   const projection=await reviewProjectionTx(tx,ctx,unit.id),board=boardRow(projection,{cycle:unit.cycle,company:unit.company},today);
   const step=rewardStageStep(projection.unit.status,projection.route);
   const laterSeats=step?([...projection.route,'payroll'] as RewardRole[]).filter((seat,index)=>index>=step.step&&roles.includes(seat)):[];
   rows.push({...unit,roles,waiting:board.waiting,salary:board.salary,bonus:board.bonus,blocking:board.blocking,exceptions:board.exceptions,laterSeats});
  }
  let emptyReason:'noScope'|'noCycle'|'noRole'|'otherScope'|null=null;
  if(!rows.length){
   if(!companyIds.length)emptyReason='noScope';
   else{
    const [access]=await tx.execute<{admin:boolean;has_seat:boolean;has_cycle:boolean}>(sql`select
     exists(select 1 from company c where c.id in ${sql`(${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`,`)})`} and app.reward_admin(c.id)) as admin,
     exists(select 1 from reward_unit r where r.deleted_at is null and exists(select 1 from app.reward_roles(r.id))) as has_seat,
     exists(select 1 from reward_cycle c join reward_unit r on r.cycle_id=c.id where c.year=${year} and r.deleted_at is null and r.company_id in ${sql`(${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`,`)})`}) as has_cycle`);
    emptyReason=access?.admin&&!access.has_cycle?'noCycle':!access?.has_seat?'noRole':'otherScope';
   }
  }
  return {rows,emptyReason,year};
 });
}
export type RewardReviewListRow=Awaited<ReturnType<typeof listRewardReviewStatus>>['rows'][number];

const sendReadySchema = z.array(z.object({ unitId: idSchema, revision: z.number().int().positive() }).strict()).max(500);
export type RewardSendReadyResult = { sent: string[]; skipped: string[]; refused: { id: string; name: string; message: string }[] };

/**
 * "Send all ready": approve every review that is waiting on the viewer at an approval step (BG, Group
 * Rewards, CTRO, EC) and needs no written reason. `seen` is the (unit, revision) list of the page the viewer
 * opened. Each unit goes through decideRewardUnit — the same decision the review page's Approve button makes,
 * in its own transaction, with the revision the viewer saw, so a review that changed since is refused and the
 * others still proceed. Units the viewer did not see are left alone. ADR-0099 order is decideRewardUnit's.
 */
export async function sendReadyRewardUnits(ctx: SessionContext, companyIds: string[], seen: unknown): Promise<RewardSendReadyResult> {
  const opened = new Map(sendReadySchema.parse(seen).map(s => [s.unitId, s.revision]));
  const board = await rewardApprovalsBoard(ctx, companyIds);
  const result: RewardSendReadyResult = { sent: [], skipped: [], refused: [] };
  for (const row of board) {
    const revision = opened.get(row.id);
    if (revision === undefined || !row.waiting || row.action !== 'approve') continue;
    if (!row.ready) { result.skipped.push(row.id); continue; }
    try { await decideRewardUnit(ctx, row.id, revision, 'approve', ''); result.sent.push(row.id); }
    catch (error) { result.refused.push({ id: row.id, name: `${row.cycle} · ${row.name}`, message: error instanceof RewardError ? error.message : 'This review could not be sent.' }); }
  }
  return result;
}
