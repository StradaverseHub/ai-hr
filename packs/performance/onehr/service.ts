import { leaderWorkspaceParts, type WorkspaceAxis } from './workspace-model';
import { evidenceFileLimit, validateEvidenceFile } from './evidence-file-model';
import { personalPlan } from './personal-record-model';
import { evidenceCitationSchema, evidenceDetailsSchema, evidenceFieldsSchema, evidenceLinkSchema, patchEvidenceFields, standingResponses, upsertEvidenceResponse } from './evidence-model';
import { assessmentParticipantsTx } from './participation-service';
import { talentContext, writeTalentAction } from './talent-service';
import { careerRoutes, demonstratedSkills, resolveTechnicalProfile, technicalProfilePlan } from './career-model';
import { anonymousFeedbackReport } from './feedback-report';
import { assertOverallRemark } from './journey-model';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { appUser, company, department, position, assignment, employment, jobGrade, person, reviewCycle, performanceReview, peerFeedbackRequest, onehrCycle, onehrReview, onehrPanel, onehrCalibration, onehrCalibrationEntry, onehrPlan, onehrEvidence, onehrResult, performanceAttachment, assessmentDraft, assessmentConversation, assessmentAttachmentLink, performanceKpiLibrary, assessmentCareerProfile, assessmentRelease } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { resolveActiveAiConfig } from '../../../core/ai-config';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { assessmentImportRecords, importKpiDefinition, importValue, kpiLibraryTemplateSchema } from './import-model';
import framework from './framework.json';
import { settingModerator, assertCurveLock, assessmentDraftSchema, type AssessmentDraft, type DraftKind } from './journey-model';
import { assertWindow, checkInAnswers, ratedPerformance, kpiApprovers, pendingKpiApprover, pendingSettingApprover, bandFor, evidenceResponseSchema, careerSchema, competencySchema, defaultPolicy, frameworkFor, goalSchema, kpiSchema, pmBands, policySchema, potential, potentialBands, referenceCurve, resolveBand, scoreAnswers, scorecard, talentCategory, tiers, validateScorecard, type Competency, type FrozenResult, type KPI, type PMBand, type Policy, type PotentialBand, type Statement, statementSchema, type Tier, type WindowCell } from './model';

const uuid = z.uuid();
const note = z.string().trim().max(4000);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function revision(actual: number, expected: number) { if (!Number.isInteger(expected) || actual !== expected) throw Error('This record changed. Reload before saving.'); }
async function audit(tx: Tx, ctx: SessionContext, id: string, event: string, payload: Record<string, unknown> = {}) {
  // Subject-scoped events are readable by the employee. Panel counts and calibration details stay admin-only.
  const subjectScoped=['kpi-checkin-saved','scorecard-proposed','scorecard-approved','scorecard-returned','results-submitted','competencies-submitted','plan-shared','plan-reviewed','plan-closed','plan-reopened','development-goal-reviewed','result-released','result-revoked'].includes(event);
  const [review]=subjectScoped?await tx.select({employmentId:onehrReview.employmentId}).from(onehrReview).where(eq(onehrReview.reviewId,id)):[];
  const [plan]=subjectScoped&&!review?await tx.select({employmentId:onehrPlan.employmentId}).from(onehrPlan).where(eq(onehrPlan.id,id)):[];
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'onehr', aggregateId: id, eventType: `onehr.${event}`, actor: actorOf(ctx), subjectEmploymentId:review?.employmentId??plan?.employmentId, payload });
}
async function isSelf(tx: Tx, employmentId: string) {
  const [r] = await tx.execute<{ ok: boolean }>(sql`select exists(select 1 from employment e join app_user u on u.person_id=e.person_id and u.tenant_id=e.tenant_id where e.id=${employmentId}::uuid and e.tenant_id=app.current_tenant_id() and u.id=app.current_user_id() and u.archived_at is null and not app.login_blocked(u.id)) as ok`); return !!r?.ok;
}
async function isAdmin(tx: Tx, cycleId: string) { const [r] = await tx.execute<{ok:boolean}>(sql`select app.onehr_cycle_admin(${cycleId}::uuid) as ok`); return !!r?.ok; }
async function isManager(tx: Tx, reviewId: string) { const [r] = await tx.execute<{ok:boolean}>(sql`select app.onehr_manager(${reviewId}::uuid) as ok`); return !!r?.ok; }
async function requireAdmin(tx: Tx, cycleId: string) { if (!await isAdmin(tx,cycleId)) throw Error('Performance administrator access is required.'); }
async function loadCycle(tx: Tx, cycleId: string, lock = false) {
  uuid.parse(cycleId);
  const q = tx.select({ native:reviewCycle, config:onehrCycle }).from(reviewCycle).innerJoin(onehrCycle,eq(onehrCycle.cycleId,reviewCycle.id)).where(eq(reviewCycle.id,cycleId));
  const [r] = await (lock?q.for('no key update'):q);
  if (!r) throw Error('Performance review cycle not found.');
  return {...r, policy:policySchema.parse(r.config.policy)};
}
async function loadReview(tx: Tx, reviewId: string, lock = false) {
  uuid.parse(reviewId);
  const q=tx.select().from(onehrReview).where(eq(onehrReview.reviewId,reviewId));
  const [row]=await (lock?q.for('update'):q);if(!row)throw Error('Assessment not found or access has been removed.');
  const [header]=await tx.execute<{value:{reviewerEmploymentId:string|null;closedAt:string|null;name:string;ownEmploymentIds:string[]}|null}>(sql`select app.onehr_review_header(${reviewId}::uuid) as value`);
  if(!header?.value)throw Error('Assessment not assigned to you.');
  const cycle=await loadCycle(tx,row.cycleId);
  return {row,native:header.value,cycle,kpis:z.array(kpiSchema).parse(row.kpis),competencies:z.array(competencySchema).parse(row.competencies)};
}
async function moderatorChoices(tx:Tx,id:string){const [r]=await tx.execute<{value:{id:string;name:string;personId:string}[]}>(sql`select app.onehr_moderator_choices(${id}::uuid) as value`);return r?.value??[];}
async function notifyKpiApprovers(tx:Tx,ctx:SessionContext,id:string,kpis:KPI[],phase:'setting'|'results') {
 const allowed=await moderatorChoices(tx,id);
 const employmentIds=[...new Set(kpis.map(k=>phase==='setting'?pendingSettingApprover(k):pendingKpiApprover(k)).filter((id):id is string=>!!id&&allowed.some(m=>m.id===id)))];
 if(employmentIds.length)await audit(tx,ctx,id,'kpi-approval-needed',{employmentIds,phase});
}
async function isModerator(tx:Tx,id:string,kpiId?:string){const [r]=await tx.execute<{ok:boolean}>(sql`select app.onehr_moderator(${id}::uuid,${kpiId??null}::uuid) as ok`);return !!r?.ok;}

async function writable(tx: Tx, r: Awaited<ReturnType<typeof loadReview>>, cell: WindowCell, expected: number, actor: 'self'|'manager'|'either'|'moderator') {
  revision(r.row.revision,expected);
  const [participation]=await tx.execute<{ok:boolean}>(sql`select app.assessment_review_participates(${r.row.reviewId}::uuid) as ok`);
  if(!participation?.ok)throw Error('This employee is not participating in the cycle.');
  const self=await isSelf(tx,r.row.employmentId), manager=!self&&await isManager(tx,r.row.reviewId);
  if (actor==='self'?!self:actor==='manager'?!manager:actor==='moderator'?self||!await isModerator(tx,r.row.reviewId):!self&&!manager) throw Error('This action is not assigned to you.');
  if (!['open','calibration'].includes(r.cycle.native.status)) throw Error('The cycle is not open.');
  const [frozen]=await tx.select({id:onehrResult.id}).from(onehrResult).where(eq(onehrResult.reviewId,r.row.reviewId));
  if (frozen||r.native.closedAt) throw Error('This assessment has been finalized.');
  assertWindow(r.cycle.policy,cell);
  return {self,manager};
}
async function touchReview(tx: Tx, reviewId: string, data: Partial<typeof onehrReview.$inferInsert>) {
  await tx.update(onehrReview).set({...data,revision:sql`${onehrReview.revision}+1`}).where(eq(onehrReview.reviewId,reviewId));
}

/** Called by the existing cycle opener inside its transaction. No second roster or identity master. */
export async function initializeOnehrCycleTx(tx: Tx, ctx: SessionContext, cycleId: string, reviewIds?:string[]) {
  const [configured]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));
  if (!configured) return;
  await requireAdmin(tx,cycleId);
  const policy=policySchema.parse(configured.policy);
  const reviews=await tx.select({id:performanceReview.id,employmentId:employment.id,companyId:employment.companyId,grade:jobGrade.code}).from(performanceReview).innerJoin(employment,eq(employment.id,performanceReview.employmentId)).leftJoin(jobGrade,eq(jobGrade.id,employment.gradeId)).where(and(eq(performanceReview.cycleId,cycleId),reviewIds?inArray(performanceReview.id,reviewIds):undefined,sql`not exists(select 1 from performance_onehr_review ar where ar.review_id=${performanceReview.id})`));
  for (const r of reviews) {
    const grade=(r.grade??'').replace(/^JG\s*/i,'').trim();
    const [role]=await tx.select({department:department.name,title:position.title}).from(assignment).innerJoin(department,eq(department.id,assignment.departmentId)).leftJoin(position,eq(position.id,assignment.positionId)).where(and(eq(assignment.employmentId,r.employmentId),isNull(assignment.supersededAt),sql`${assignment.validFrom}<=${todayInKualaLumpur()}::date and (${assignment.validTo} is null or ${assignment.validTo}>${todayInKualaLumpur()}::date)`)).orderBy(desc(assignment.validFrom)).limit(1);
    const [careerProfile]=await tx.select().from(assessmentCareerProfile).where(eq(assessmentCareerProfile.employmentId,r.employmentId));
    const picked=careerProfile?careerSchema.parse(careerProfile.career).selfProfileId:null;
    const chosen=resolveTechnicalProfile(policy.profiles,{companyId:r.companyId,employmentId:r.employmentId,department:role?.department??'',title:role?.title??'',grade},picked);
    const statements=policy.modules.tm?frameworkFor(policy,grade):[];
    const competencies:Competency[]=(chosen?technicalProfilePlan(chosen.profile,policy.skills??[]):[]).map(s=>({...s,self:null,selfRemark:'',manager:null,managerRemark:''}));
    await tx.insert(onehrReview).values({tenantId:ctx.tenantId,reviewId:r.id,cycleId,employmentId:r.employmentId,companyId:r.companyId,grade,statements,competencies,profileId:chosen?.profile.id??null,profileMatch:chosen?.source??null});
  }
}
export async function assertStandardCycleTx(tx:Tx,cycleId:string) {
  const [r]=await tx.select({id:onehrCycle.cycleId}).from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));
  if(r)throw Error('Use the performance and talent review for this cycle.');
}
/** Archiving preserves incomplete work and the last signed rating ledger; it never finalizes results for Rewards. */
export async function prepareAssessmentClosureTx(tx:Tx,cycleId:string) {
  const [configured]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));
  if(configured)await requireAdmin(tx,cycleId);
}
export async function configureOnehrCycle(ctx:SessionContext,cycleId:string,expected:number|null,raw?:unknown) {
  return withPerformanceTenant(ctx,async tx=>{
    uuid.parse(cycleId);
    const [native]=await tx.select().from(reviewCycle).where(eq(reviewCycle.id,cycleId)).for('update');
    if(!native)throw Error('Cycle not found.');await requireAdmin(tx,cycleId);
    if(native.status!=='draft')throw Error('Assessment policy is fixed when the cycle opens.');
    const policy=policySchema.parse(raw??defaultPolicy(framework));
    for(const profile of policy.profiles){
      if(profile.companyId){const [scope]=await tx.execute<{ok:boolean}>(sql`select app.onehr_admin(${profile.companyId}::uuid) as ok`);if(!scope?.ok)throw Error('A competency profile company is outside your scope.');}
      if(profile.employmentIds?.length){const selected=await tx.select({id:employment.id,companyId:employment.companyId}).from(employment).where(inArray(employment.id,profile.employmentIds));if(selected.length!==new Set(profile.employmentIds).size||profile.companyId&&selected.some(e=>e.companyId!==profile.companyId))throw Error('Profile assignments must use visible native employments in the configured company.');}
    }
    const [existing]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));
    if(existing){revision(existing.revision,expected!);await tx.update(onehrCycle).set({policy,revision:existing.revision+1}).where(eq(onehrCycle.cycleId,cycleId));}
    else {if(expected!=null)throw Error('Reload before configuring this cycle.');await tx.insert(onehrCycle).values({tenantId:ctx.tenantId,cycleId,policy});}
    await audit(tx,ctx,cycleId,'policy-configured',{policyDigest:hash(policy)});
  });
}

/** Operational module switches preserve all inputs, approvals and historical results. */
export async function updateAssessmentModules(ctx:SessionContext,cycleId:string,expected:number,raw:unknown) {
 const modules=policySchema.shape.modules.parse(raw);
 return withPerformanceTenant(ctx,async tx=>{
  uuid.parse(cycleId);await requireAdmin(tx,cycleId);const cycle=await loadCycle(tx,cycleId,true);revision(cycle.config.revision,expected);
  if(!['open','calibration'].includes(cycle.native.status))throw Error('Change modules only in an active cycle.');
  await tx.update(onehrCycle).set({policy:{...cycle.policy,modules},revision:cycle.config.revision+1}).where(eq(onehrCycle.cycleId,cycleId));
  await audit(tx,ctx,cycleId,'modules-updated',{previous:cycle.policy.modules,next:modules});
 });
}

/** Operational deadlines can change without reopening inputs or changing assessment rules. */
export async function updateOnehrWindows(ctx:SessionContext,cycleId:string,expected:number,raw:unknown,reason:string) {
  const windows=policySchema.shape.windows.parse(raw);z.string().trim().min(1).max(4000).parse(reason);
  return withPerformanceTenant(ctx,async tx=>{
    uuid.parse(cycleId);await requireAdmin(tx,cycleId);const cycle=await loadCycle(tx,cycleId,true);revision(cycle.config.revision,expected);
    if(!['open','calibration'].includes(cycle.native.status))throw Error('Change active-cycle deadlines only; closed periods are read-only.');
    await tx.update(onehrCycle).set({policy:{...cycle.policy,windows},revision:cycle.config.revision+1}).where(eq(onehrCycle.cycleId,cycleId));
    await audit(tx,ctx,cycleId,'windows-updated',{reason,previous:cycle.policy.windows,next:windows});
  });
}

/** Whole-scorecard setting. Client state cannot set approval, moderation or results. */
export async function saveOnehrKpis(ctx:SessionContext,reviewId:string,expected:number,raw:unknown,propose=false) {
 return withPerformanceTenant(ctx,tx=>saveOnehrKpisTx(tx,ctx,reviewId,expected,raw,propose));
}
export async function saveOnehrKpisTx(tx:Tx,ctx:SessionContext,reviewId:string,expected:number,raw:unknown,propose=false) {
  const inputs=z.array(kpiSchema.pick({id:true,title:true,category:true,libraryId:true,description:true,weightBp:true,unit:true,scoring:true,moderatorEmploymentId:true}).extend({approverEmploymentIds:z.array(uuid).max(1).optional()})).max(100).parse(raw);
  if(new Set(inputs.map(k=>k.id)).size!==inputs.length)throw Error('Duplicate KPI.');
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_setting',expected,'self');if(!r.cycle.policy.modules.pm)throw Error('Performance assessment is disabled.');
    if(r.kpis.some(k=>k.setting==='approved'||k.setting==='proposed'))throw Error('The scorecard is already proposed or approved.');
    const moderators=await moderatorChoices(tx,reviewId);
    const catalogue=await availableKpiLibraryTx(tx,r);
    if(inputs.some(k=>k.libraryId&&!catalogue.some(item=>item.id===k.libraryId)))throw Error('A selected library KPI is no longer available for your role.');
    const kpis:KPI[]=inputs.map(k=>{
      const moderatorEmploymentId=settingModerator(r.kpis.find(old=>old.id===k.id),r.native.reviewerEmploymentId,moderators.map(m=>m.id),k.approverEmploymentIds,k.moderatorEmploymentId);
      if(propose&&!moderatorEmploymentId)throw Error('HR must assign an active KPI moderator before this scorecard can be proposed.');
      return {...k,moderatorSource:r.kpis.find(old=>old.id===k.id)?.moderatorSource??'line',moderatorEmploymentId,approvalChain:moderatorEmploymentId?[{employmentId:moderatorEmploymentId,actual:null,remark:'',at:null}]:[],setting:propose?'proposed':'draft',settingApprovals:[],settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false};
    });
    const mechanism=r.cycle.policy.bBands.some(b=>b.companyId===r.row.companyId)?'B':'A';
    if(kpis.some(k=>k.scoring.mechanism!==mechanism))throw Error('Use the scoring mechanism configured for this company.');
    const configuredVariant=r.cycle.policy.bBands.find(b=>b.companyId===r.row.companyId)?.variant??'base';
    if(kpis.some(k=>k.scoring.mechanism==='B'&&k.scoring.variant!==configuredVariant))throw Error('Use the achievement variant configured for this company.');
    if(propose)validateScorecard(kpis);
    await touchReview(tx,reviewId,{kpis});await audit(tx,ctx,reviewId,propose?'scorecard-proposed':'scorecard-saved');if(propose)await notifyKpiApprovers(tx,ctx,reviewId,kpis,'setting');
}
export async function approveOnehrScorecard(ctx:SessionContext,reviewId:string,expected:number,approve:boolean,remark:string) {
  note.parse(remark);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_setting_approve',expected,'moderator');
    if(!r.kpis.length||!r.kpis.some(k=>k.setting==='proposed'))throw Error('The employee must propose the whole scorecard.');
    const allowed=await moderatorChoices(tx,reviewId);
    const actionable=r.kpis.filter(k=>{const id=pendingSettingApprover(k);return id&&r.native.ownEmploymentIds.includes(id)&&allowed.some(m=>m.id===id);});
    if(!actionable.length)throw Error('No proposed KPI is awaiting your turn in the approval chain.');
    if(!approve&&!remark.trim())throw Error('Explain what needs changing.');validateScorecard(r.kpis);
    const kpis=r.kpis.map(k=>{
      const pending=pendingSettingApprover(k),acts=actionable.some(a=>a.id===k.id);
      const settingApprovals=acts?[...(k.settingApprovals??[]),{employmentId:pending!,action:approve?'approved' as const:'returned' as const,remark,at:new Date().toISOString()}]:k.settingApprovals;
      return {...k,setting:!approve?'returned' as const:acts&&settingApprovals!.length===kpiApprovers(k).length?'approved' as const:k.setting,settingApprovals,settingRemark:acts||!approve?remark:k.settingRemark};
    });
    await touchReview(tx,reviewId,{kpis});await audit(tx,ctx,reviewId,approve?'scorecard-approved':'scorecard-returned',{reason:remark,kpiIds:actionable.map(k=>k.id)});
    if(approve)await notifyKpiApprovers(tx,ctx,reviewId,kpis,'setting');
  });
}
export async function submitOnehrResults(ctx:SessionContext,reviewId:string,expected:number,raw:unknown,overallRemark='') {
  note.parse(overallRemark);
  const inputs=z.array(z.object({id:uuid,actual:z.number().finite(),note})).parse(raw);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_results',expected,'self');
    if(r.cycle.policy.kind==='quarterly')throw Error('Quarterly cycles collect KPI check-in status, not numeric results.');
    if(r.row.resultsSubmittedAt||!r.kpis.length||r.kpis.some(k=>k.setting!=='approved'))throw Error('An approved scorecard is required and results can be submitted once.');
    const ownKpis=r.kpis.filter(k=>!k.hrOwned);
    if(inputs.length!==ownKpis.length||new Set(inputs.map(k=>k.id)).size!==inputs.length||ownKpis.some(k=>!inputs.some(i=>i.id===k.id)))throw Error('Provide every employee-owned KPI result. Company KPI results are filled by HR.');
    const kpis=r.kpis.map(k=>({...k,...inputs.find(i=>i.id===k.id)!}));scorecard(kpis,r.cycle.policy,r.row.companyId,false);
    assertOverallRemark(overallRemark,true);
    const [lockedProof]=r.cycle.policy.modules.evidence?await tx.execute<{value:{attachmentId:string;kpiId:string}[]}>(sql`select app.assessment_file_lock_proof(${reviewId}::uuid) as value`):[];
    const submittedProof=(lockedProof?.value??[]).map(({attachmentId,kpiId})=>({attachmentId,kpiId}));
    if(r.cycle.policy.modules.evidence){
      const linked=submittedProof;
      const standout=kpis.filter(k=>{if(k.hrOwned)return false;const value=scorecard([{...k,weightBp:10000}],r.cycle.policy,r.row.companyId,false);return ['AE','OU'].includes(value.band??'');});
      if(standout.some(k=>!linked.some(a=>a.kpiId===k.id)))throw Error('Attach a supporting file to every Above Expectation or Outstanding KPI before submitting.');
    }
    await clearAssessmentDraftTx(tx,ctx,reviewId,'results');
    await touchReview(tx,reviewId,{kpis,submittedProof,selfRemark:overallRemark,resultsSubmittedAt:new Date(),...(kpis.every(k=>k.locked)?{managerPerformance:scorecard(kpis,r.cycle.policy,r.row.companyId,true).band,managerScore:String(scorecard(kpis,r.cycle.policy,r.row.companyId,true).score)}:{})});await audit(tx,ctx,reviewId,'results-submitted');await notifyKpiApprovers(tx,ctx,reviewId,kpis,'results');
  });
}
export async function saveOnehrKpiCheckIn(ctx:SessionContext,reviewId:string,expected:number,kpiId:string,answer:typeof checkInAnswers[number],text:string) {
 return withPerformanceTenant(ctx,tx=>saveOnehrKpiCheckInTx(tx,ctx,reviewId,expected,kpiId,answer,text));
}
export async function saveOnehrKpiCheckInTx(tx:Tx,ctx:SessionContext,reviewId:string,expected:number,kpiId:string,answer:typeof checkInAnswers[number],text:string) {
 uuid.parse(kpiId);z.enum(checkInAnswers).parse(answer);note.parse(text);
  const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_results',expected,'self');
  if(!r.cycle.policy.modules.pm||r.cycle.policy.kind!=='quarterly')throw Error('KPI status check-ins belong to quarterly cycles.');
  const k=r.kpis.find(k=>k.id===kpiId);if(!k||k.setting!=='approved')throw Error('Agree the KPI before checking in.');
  const checkIn={answer,note:text,at:new Date().toISOString(),userId:ctx.userId!};
  await touchReview(tx,reviewId,{kpis:r.kpis.map(k=>k.id===kpiId?{...k,checkIn}:k)});
  await audit(tx,ctx,reviewId,'kpi-checkin-saved',{kpiId,previous:k.checkIn??null,next:checkIn});
}
export async function moderateOnehrKpi(ctx:SessionContext,reviewId:string,expected:number,kpiId:string,actual:number,remark:string) {
  uuid.parse(kpiId);z.number().finite().parse(actual);note.parse(remark);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_approve',expected,'moderator');
    if(!await isModerator(tx,reviewId,kpiId))throw Error('This KPI is assigned to another moderator.');
    const k=r.kpis.find(k=>k.id===kpiId);if(!r.row.resultsSubmittedAt||!k||k.locked)throw Error('This KPI is not awaiting moderation.');
    if(actual!==(k.approvedActual??k.actual)&&!remark.trim())throw Error('Explain the adjusted result.');
    const chain=k.approvalChain?.length?k.approvalChain:[{employmentId:k.moderatorEmploymentId!,actual:null,remark:'',at:null}];
    const next=chain.findIndex(step=>!step.at);if(next<0)throw Error('This KPI chain is complete.');
    const approvalChain=chain.map((step,i)=>i===next?{...step,actual,remark,at:new Date().toISOString()}:step);
    const kpis=r.kpis.map(k=>k.id===kpiId?{...k,approvalChain,approvedActual:actual,moderationRemark:remark,locked:approvalChain.every(step=>step.at!=null)}:k);
    await touchReview(tx,reviewId,{kpis});await audit(tx,ctx,reviewId,'kpi-moderated',{kpiId});await notifyKpiApprovers(tx,ctx,reviewId,kpis,'results');
  });
}
export async function confirmOnehrPerformance(ctx:SessionContext,reviewId:string,expected:number,band:PMBand,remark:string) {
  z.enum(pmBands).parse(band);note.parse(remark);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_approve',expected,'manager');
    if(!ratedPerformance(r.cycle.policy))throw Error('This cycle does not produce performance ratings.');
    const calculated=scorecard(r.kpis,r.cycle.policy,r.row.companyId,true);if(calculated.score==null)throw Error('Moderate every KPI before confirming the assessment.');
    if(band!==calculated.band)throw Error('The manager performance band is calculated from the moderated KPIs. Change the underlying result, or use the authorized calibration workflow.');
    const employee=scorecard(r.kpis,r.cycle.policy,r.row.companyId,false);
    if(employee.band!==calculated.band&&!remark.trim())throw Error('Explain why moderation changed the overall performance band.');
    if(r.row.managerPerformance)throw Error('Manager assessment is already confirmed.');
    await touchReview(tx,reviewId,{managerPerformance:band,managerScore:String(calculated.score),managerRemark:remark});await audit(tx,ctx,reviewId,'performance-confirmed');
  });
}
export async function submitOnehrCompetencies(ctx:SessionContext,reviewId:string,expected:number,raw:unknown,manager=false,overallRemark='') {
  note.parse(overallRemark);
  const answers=z.record(z.string(),z.object({answer:z.enum(['yes','no']),remark:note.default('')})).parse(raw);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,manager?'tc_approve':'tc_self',expected,manager?'manager':'self');
    if(!r.cycle.policy.modules.tm||!r.competencies.length)throw Error('No technical competency profile is assigned.');
    assertOverallRemark(overallRemark,!manager);
    if(manager?r.row.competencyStatus!=='submitted':r.row.competencyStatus!=='pending')throw Error('Competencies are not awaiting this step.');
    if(Object.keys(answers).length!==r.competencies.length||r.competencies.some(c=>!answers[c.id]))throw Error('Answer every competency.');
    const competencies=r.competencies.map(c=>{const a=answers[c.id];if(manager&&a.answer!==c.self&&!a.remark.trim())throw Error('Explain changed competency answers.');return manager?{...c,manager:a.answer,managerRemark:a.remark}:{...c,self:a.answer,selfRemark:a.remark};});
    await clearAssessmentDraftTx(tx,ctx,reviewId,manager?'competency_manager':'competency_self');
    await touchReview(tx,reviewId,{competencies,...(manager?{competencyManagerRemark:overallRemark}:{competencySelfRemark:overallRemark}),competencyStatus:manager?'reviewed':'submitted'});await audit(tx,ctx,reviewId,manager?'competencies-reviewed':'competencies-submitted');
  });
}
export async function assignOnehrPanel(ctx:SessionContext,reviewId:string,expected:number,raw:unknown) {
 return withPerformanceTenant(ctx,tx=>assignOnehrPanelTx(tx,ctx,reviewId,expected,raw));
}
export async function assignOnehrPanelTx(tx:Tx,ctx:SessionContext,reviewId:string,expected:number,raw:unknown) {
  const inputs=z.array(z.object({employmentId:uuid,relationship:z.enum(['line_manager','matrix_manager','peer','direct_report'])})).max(30).parse(raw);
  if(new Set(inputs.map(i=>i.employmentId)).size!==inputs.length)throw Error('A panel cannot contain the same reviewer twice.');
    const r=await loadReview(tx,reviewId,true),admin=await isAdmin(tx,r.row.cycleId);
    if(admin){
     const [participant]=await tx.execute<{ok:boolean}>(sql`select app.assessment_review_participates(${reviewId}::uuid) as ok`);if(!participant?.ok)throw Error('This employee is not participating in the cycle.');
     revision(r.row.revision,expected);if(await isSelf(tx,r.row.employmentId))throw Error('Ask another administrator to assign your panel.');
     const [frozen]=await tx.select({id:onehrResult.id}).from(onehrResult).where(eq(onehrResult.reviewId,reviewId));
     if(frozen||r.native.closedAt||!['open','calibration'].includes(r.cycle.native.status))throw Error('This assessment is finalized or closed.');
    }else await writable(tx,r,'f360',expected,'manager');
    if(!r.cycle.policy.modules.tm)throw Error('Talent assessment is disabled.');
    if(/^\d+$/.test(r.row.grade)&&inputs.length>r.cycle.policy.panelTarget)throw Error('The panel exceeds the configured assessor limit.');
    const prior=await tx.select().from(onehrPanel).where(eq(onehrPanel.reviewId,reviewId));
    const omitted=prior.filter(p=>!p.archivedAt&&!inputs.some(i=>i.employmentId===p.peerEmploymentId));
    if(omitted.some(p=>p.submittedAt))throw Error('Submitted reviewers must remain on the panel.');
    const [subject]=await tx.select({name:person.fullName,personId:person.id}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(eq(employment.id,r.row.employmentId));
    if(!subject)throw Error('Subject not available.');
    if(!admin&&(/^[a-z]+$/i.test(r.row.grade)?inputs.length!==1:inputs.length<r.cycle.policy.minValid))throw Error('The panel is smaller than the required valid response count.');
    const peerPeople=new Set<string>();
    for(const input of inputs){
      const [peer]=await tx.select({id:employment.id,personId:employment.personId,name:person.fullName,grade:jobGrade.code}).from(employment).innerJoin(person,eq(person.id,employment.personId)).leftJoin(jobGrade,eq(jobGrade.id,employment.gradeId)).where(and(eq(employment.id,input.employmentId),sql`(${employment.terminatedOn} is null or ${employment.terminatedOn}>${todayInKualaLumpur()}::date)`));
      if(!peer||peer.personId===subject.personId||peerPeople.has(peer.personId)||!/^\d+$/.test((peer.grade??'').replace(/^JG\s*/i,'')))throw Error('Choose distinct active reviewers with numeric job grades, other than the subject.');
      peerPeople.add(peer.personId);
      if(input.relationship==='line_manager'&&peer.id!==r.native.reviewerEmploymentId)throw Error('The line manager must be the assigned manager.');
      if(!admin&&input.relationship==='matrix_manager'&&!(await moderatorChoices(tx,reviewId)).some(m=>m.id===peer.id&&m.id!==r.native.reviewerEmploymentId))throw Error('Choose a current matrix manager.');
      if(input.relationship==='direct_report'){const [edge]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_report_of(${peer.id}::uuid,${r.row.employmentId}::uuid) as ok`);if(!edge?.ok)throw Error('Choose a current report of the subject.');}
      if(!/^\d+$/.test(r.row.grade)&&(inputs.length!==1||peer.id!==r.native.reviewerEmploymentId||input.relationship!=='line_manager'))throw Error('A letter-grade subject is assessed only by their line manager.');
      const existing=prior.find(p=>p.peerEmploymentId===peer.id);
      if(existing){if(existing.submittedAt){if(existing.archivedAt)throw Error('Restore archived submitted feedback through the panel controls.');if(existing.relationship!==input.relationship){if(!admin)throw Error('Only scoped HR may change a submitted reviewer relationship.');await tx.update(onehrPanel).set({relationship:input.relationship}).where(eq(onehrPanel.requestId,existing.requestId));}continue;}
       await tx.update(onehrPanel).set({archivedAt:null,relationship:input.relationship}).where(eq(onehrPanel.requestId,existing.requestId));
       await tx.update(peerFeedbackRequest).set({status:'pending'}).where(eq(peerFeedbackRequest.id,existing.requestId));continue;
      }
      const [request]=await tx.insert(peerFeedbackRequest).values({tenantId:ctx.tenantId,reviewId,subjectEmploymentId:r.row.employmentId,peerEmploymentId:peer.id,subjectName:subject.name,peerName:peer.name,cycleName:r.cycle.native.name,requestedByUserId:ctx.userId}).returning();
      await tx.insert(onehrPanel).values({tenantId:ctx.tenantId,requestId:request.id,reviewId,subjectEmploymentId:r.row.employmentId,peerEmploymentId:peer.id,relationship:input.relationship});
      await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'peer-feedback-request',aggregateId:request.id,eventType:'peer-feedback-request.created',actor:actorOf(ctx),payload:{reviewId}});
    }
    for(const p of omitted){await tx.update(onehrPanel).set({archivedAt:new Date()}).where(eq(onehrPanel.requestId,p.requestId));await tx.update(peerFeedbackRequest).set({status:'declined'}).where(eq(peerFeedbackRequest.id,p.requestId));}
    await touchReview(tx,reviewId,{});await audit(tx,ctx,reviewId,'panel-assigned',{count:inputs.length,removed:omitted.length,before:prior.map(p=>({requestId:p.requestId,employmentId:p.peerEmploymentId,relationship:p.relationship,archived:!!p.archivedAt,submitted:!!p.submittedAt})),after:inputs.map(p=>({employmentId:p.employmentId,relationship:p.relationship}))});
}
export async function changeAssessmentPanelState(ctx:SessionContext,reviewId:string,expected:number,requestId:string,operation:'archive'|'restore'|'reset',reason=''){
 return withPerformanceTenant(ctx,tx=>changeAssessmentPanelStateTx(tx,ctx,reviewId,expected,requestId,operation,reason));
}
export async function changeAssessmentPanelStateTx(tx:Tx,ctx:SessionContext,reviewId:string,expected:number,requestId:string,operation:'archive'|'restore'|'reset',reason=''){
 uuid.parse(requestId);z.enum(['archive','restore','reset']).parse(operation);note.parse(reason);
  const r=await loadReview(tx,reviewId,true);await requireAdmin(tx,r.row.cycleId);revision(r.row.revision,expected);
  if(await isSelf(tx,r.row.employmentId))throw Error('Ask another administrator to manage your panel.');
  if(!r.cycle.policy.modules.tm||!['open','calibration'].includes(r.cycle.native.status)||r.native.closedAt)throw Error('This assessment is finalized or closed.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${reviewId},0))`);
  const [frozen]=await tx.select({id:onehrResult.id}).from(onehrResult).where(eq(onehrResult.reviewId,reviewId));if(frozen)throw Error('This assessment is finalized.');
  const [panel]=await tx.select().from(onehrPanel).where(and(eq(onehrPanel.requestId,requestId),eq(onehrPanel.reviewId,reviewId))).for('update');if(!panel)throw Error('Panel member not found.');
  if(operation==='archive'){
   if(panel.archivedAt)return;
   await tx.update(onehrPanel).set({archivedAt:new Date(),archiveReason:reason||null}).where(eq(onehrPanel.requestId,requestId));
   await tx.update(peerFeedbackRequest).set({status:'declined'}).where(eq(peerFeedbackRequest.id,requestId));
  }else if(operation==='restore'){
   if(!panel.archivedAt)return;
   const active=await tx.select({id:onehrPanel.requestId}).from(onehrPanel).where(and(eq(onehrPanel.reviewId,reviewId),isNull(onehrPanel.archivedAt)));
   const cap=/^\d+$/.test(r.row.grade)?r.cycle.policy.panelTarget:1;if(active.length>=cap)throw Error('The panel is already at its configured assessor limit.');
   const [peer]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,panel.peerEmploymentId),sql`(${employment.terminatedOn} is null or ${employment.terminatedOn}>${todayInKualaLumpur()}::date)`));if(!peer)throw Error('A departed reviewer cannot be restored.');
   await tx.update(onehrPanel).set({archivedAt:null,archiveReason:null}).where(eq(onehrPanel.requestId,requestId));
   await tx.update(peerFeedbackRequest).set({status:panel.submittedAt?'submitted':'pending'}).where(eq(peerFeedbackRequest.id,requestId));
  }else{
   if(panel.archivedAt||!panel.submittedAt)throw Error('Reset only an active submitted reviewer.');
   await tx.update(onehrPanel).set({submittedAt:null,resetAt:new Date()}).where(eq(onehrPanel.requestId,requestId));
   await tx.update(peerFeedbackRequest).set({status:'pending'}).where(eq(peerFeedbackRequest.id,requestId));
  }
  await touchReview(tx,reviewId,{});await audit(tx,ctx,reviewId,`panel-${operation}`,{requestId,reason});
}
type FeedbackCard={requestId:string;reviewId:string;cycleId:string;guidedReview:boolean;closed:boolean;resetAt:string|null;subject:string;statements:Statement[];answers:Record<string,'yes'|'no'>|null;remark:string;comments:Record<string,string>;submitted:boolean;frozen:boolean};
async function feedbackCard(tx:Tx,requestId:string) {uuid.parse(requestId);const [r]=await tx.execute<{value:FeedbackCard|null}>(sql`select app.onehr_feedback_card(${requestId}::uuid) as value`);if(!r?.value)throw Error('Feedback request not found or access has been removed.');return r.value;}
export async function getOnehrFeedback(ctx:SessionContext,requestId:string){return withPerformanceTenant(ctx,async tx=>{
 const card=await feedbackCard(tx,requestId);
 const [draft]=await tx.select().from(assessmentDraft).where(and(eq(assessmentDraft.contextId,requestId),eq(assessmentDraft.kind,'feedback'),eq(assessmentDraft.actorUserId,ctx.userId!)));
 return {...card,draft:draft?{...draft,payload:assessmentDraftSchema.parse(draft.payload)}:null};
});}
export async function submitOnehrFeedback(ctx:SessionContext,requestId:string,raw:unknown,remark:string,comments:Record<string,string>={}) {
  const answers=z.record(z.string(),z.enum(['yes','no'])).parse(raw);note.parse(remark);
  const principleComments=z.record(z.string().max(200),z.string().trim().max(2000)).parse(comments);
  return withPerformanceTenant(ctx,async tx=>{
    // Serialize all writes and freezing for the review, including peer responses.
    const card=await feedbackCard(tx,requestId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${card.reviewId},0))`);
    const fresh=await feedbackCard(tx,requestId);if(fresh.submitted||fresh.frozen)throw Error('Feedback is already submitted or finalized.');
    const cycle=await loadCycle(tx,card.cycleId);if(!['open','calibration'].includes(cycle.native.status))throw Error('The cycle is closed.');assertWindow(cycle.policy,'f360');
    if(Object.keys(principleComments).some(key=>!card.statements.some(s=>s.principle===key)))throw Error('Use only the assigned leadership principles.');
    const score=scoreAnswers(card.statements,answers);assertOverallRemark(remark,score.score/score.max*100>cycle.policy.midMaxPct);
    await clearAssessmentDraftTx(tx,ctx,card.reviewId,'feedback',requestId);
    await tx.update(onehrPanel).set({answers,remark,principleComments,submittedAt:new Date()}).where(eq(onehrPanel.requestId,requestId));
    await tx.update(peerFeedbackRequest).set({status:'submitted'}).where(eq(peerFeedbackRequest.id,requestId));await audit(tx,ctx,requestId,'feedback-submitted');
  });
}

export async function declineOnehrFeedback(ctx:SessionContext,requestId:string) {
 return withPerformanceTenant(ctx,async tx=>{
  const card=await feedbackCard(tx,requestId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${card.reviewId},0))`);
  const fresh=await feedbackCard(tx,requestId);if(fresh.submitted||fresh.frozen)throw Error('Feedback is already submitted or finalized.');
  const cycle=await loadCycle(tx,card.cycleId);if(!['open','calibration'].includes(cycle.native.status))throw Error('The cycle is closed.');assertWindow(cycle.policy,'f360');
  await tx.update(onehrPanel).set({archivedAt:new Date()}).where(eq(onehrPanel.requestId,requestId));
  await tx.update(peerFeedbackRequest).set({status:'declined'}).where(eq(peerFeedbackRequest.id,requestId));await audit(tx,ctx,requestId,'feedback-declined');
 });
}

type Inputs={reviewId:string;employmentId:string;companyId:string;grade:string;name:string;performance:PMBand|null;managerScore:number|null;finalized:boolean;competencyStatus:string;competencyAssigned:boolean;competencies:Competency[];selfCompetencies:Competency[];submittedKpis:KPI[];leadership:{score:number;max:number}[];principles:{principle:string;pct:number}[]};
async function assessment(tx:Tx,reviewId:string,policy:Policy) {
  const [participant]=await tx.execute<{ok:boolean}>(sql`select app.assessment_review_participates(${reviewId}::uuid) as ok`);if(!participant?.ok)throw Error('This employee is not participating in the cycle.');
  const [r]=await tx.execute<{value:Inputs|null}>(sql`select app.onehr_assessment_inputs(${reviewId}::uuid) as value`);if(!r?.value)throw Error('Assessment not available to this calibration scope.');
  const input=r.value;const c=input.competencies;
  const tech=input.competencyStatus==='reviewed'&&c.length?scoreAnswers(c,Object.fromEntries(c.map(s=>[s.id,s.manager??s.self!]))):null;
  const managerPotential=potential(input.leadership,tech,policy,input.grade);
  const selfTech=input.selfCompetencies.length?scoreAnswers(input.selfCompetencies,Object.fromEntries(input.selfCompetencies.map(s=>[s.id,s.self!]))):null;
  const selfPotential=input.selfCompetencies.length?potential(input.leadership,selfTech,policy,input.grade):null;
  return {...input,performance:ratedPerformance(policy)?input.performance:null,
   selfPerformance:input.submittedKpis.length?scorecard(input.submittedKpis,policy,input.companyId,false).band:null,
   selfPotential:selfPotential?.valid?selfPotential.band:null,
   potential:managerPotential};
}
async function decisions(tx:Tx,reviewId:string) {
  const [r]=await tx.execute<{value:{tier:Tier;mode:string;performance:PMBand|null;potential:PotentialBand|null;locked:boolean;performanceLocked:boolean;potentialLocked:boolean;pipConfirmed:boolean;promotionConfirmed:boolean;pip:boolean;promotion:boolean;specialReward:boolean}[]}>(sql`select app.onehr_decisions(${reviewId}::uuid) as value`);return r?.value??[];
}
async function resolved(tx:Tx,reviewId:string,policy:Policy) {
  const input=await assessment(tx,reviewId,policy),rows=await decisions(tx,reviewId),effective=rows.filter(d=>!(d.tier==='group'&&d.mode==='blend')&&!(d.tier==='bg'&&rows.some(g=>g.tier==='group'&&g.mode==='replace')));
  return {input,rows,performance:resolveBand<PMBand>(input.performance,effective.map(d=>({...d,band:d.performance,locked:d.performanceLocked}))),potential:resolveBand<PotentialBand>(input.potential.band,rows.filter(d=>!(d.tier==='group'&&d.mode==='blend')).map(d=>({...d,band:d.potential,locked:d.potentialLocked})))};
}
/** Source Talent Box places everyone. Defaults stay provisional until a human locks them. */
function boxBands(result:Awaited<ReturnType<typeof resolved>>,tier:string) {
 const box=['bu','bg','group','final'].includes(tier);
 return {
  performance:result.performance.band??(box?result.input.selfPerformance??'UA':null),
  potential:result.potential.band??(box?result.input.selfPotential??'Low':null),
  performanceSource:result.performance.band?result.performance.source:box&&result.input.selfPerformance?'self':box?'default':null,
  potentialSource:result.potential.band?result.potential.source:box&&result.input.selfPotential?'self':box?'default':null,
 };
}
export async function createOnehrCalibration(ctx:SessionContext,cycleId:string,raw:unknown) {
  const p=z.object({name:z.string().trim().min(1).max(300),companyId:uuid.nullable(),tier:z.enum(tiers),reviewerUserIds:z.array(uuid).min(1).max(100),reviewIds:z.array(uuid).min(1).max(10000),pbtAchievement:z.number().finite().nullable(),mode:z.enum(['after','replace','blend']).default('after')}).parse(raw);
  return withPerformanceTenant(ctx,async tx=>{
    const cycle=await loadCycle(tx,cycleId,true);await requireAdmin(tx,cycleId);if(cycle.policy.modules.calibration===false)throw Error('Calibration is disabled.');if(cycle.policy.kind!=='year_end')throw Error('Calibration is available only in year-end cycles.');if(!ratedPerformance(cycle.policy)&&!cycle.policy.modules.tm)throw Error('This cycle has no rating axes to calibrate.');if(!['open','calibration'].includes(cycle.native.status))throw Error('Open the cycle before assigning calibration.');
    if(new Set(p.reviewIds).size!==p.reviewIds.length)throw Error('Duplicate assessment.');
    const reviews=await tx.select().from(onehrReview).where(and(eq(onehrReview.cycleId,cycleId),inArray(onehrReview.reviewId,p.reviewIds)));
    if(reviews.length!==p.reviewIds.length||!(await tx.execute<{ok:boolean}>(sql`select bool_and(app.assessment_review_participates(r)) as ok from unnest(array[${sql.join(p.reviewIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) r`))[0]?.ok)throw Error('Every assessment must belong to this cycle and your scope.');
    if(p.companyId!=null){const [scope]=await tx.execute<{ok:boolean}>(sql`select app.onehr_admin(${p.companyId}::uuid) as ok`);if(!scope?.ok)throw Error('Company outside your scope.');}
    const [session]=await tx.insert(onehrCalibration).values({tenantId:ctx.tenantId,cycleId,companyId:p.companyId,name:p.name,tier:p.tier,reviewerUserIds:[...new Set(p.reviewerUserIds)],pbtAchievement:p.pbtAchievement==null?null:String(p.pbtAchievement),mode:p.mode}).returning();
    for(const r of reviews)await tx.insert(onehrCalibrationEntry).values({tenantId:ctx.tenantId,sessionId:session.id,reviewId:r.reviewId,employmentId:r.employmentId});
    await audit(tx,ctx,session.id,'calibration-assigned',{tier:p.tier,count:reviews.length});return session.id;
  });
}
async function loadCalibration(tx:Tx,id:string,expected?:number) {
  uuid.parse(id);const [session]=await tx.select().from(onehrCalibration).where(eq(onehrCalibration.id,id)).for('update');if(!session)throw Error('Calibration not found or access has been removed.');
  if(expected!==undefined)revision(session.revision,expected);
  const cycle=await loadCycle(tx,session.cycleId);if(cycle.policy.modules.calibration===false)throw Error('Calibration is disabled.');
  return {session,cycle};
}
type Axis='performance'|'potential'|'both';
function calibrationWindows(policy:Policy,tier:Tier,axis:Axis) {
 if(tier==='hod'){if(axis!=='potential'&&ratedPerformance(policy))assertWindow(policy,'pm_hod');if(axis!=='performance'&&policy.modules.tm)assertWindow(policy,'pot_hod');}
 else if(tier==='bu'){if(axis!=='potential'&&ratedPerformance(policy))assertWindow(policy,'pm_buceo');if(axis!=='performance'&&policy.modules.tm)assertWindow(policy,'pot_buceo');}
 else if(tier==='bg')assertWindow(policy,'tb_bgceo');
}
function needsAxes(policy:Policy,axis:Axis,_tier?:string){return {pm:ratedPerformance(policy)&&axis!=='potential',pot:policy.modules.tm&&axis!=='performance'};}
function assertPrecedingTier(rows:Awaited<ReturnType<typeof decisions>>,tier:Tier,mode:string,pm:boolean,pot:boolean) {
 if(tier==='bu'&&rows.some(d=>d.tier==='bg'&&(pm&&d.performanceLocked||pot&&d.potentialLocked)))throw Error('BU calibration is closed after BG locks.');
 if(tier==='hod'&&rows.some(d=>['bu','bg'].includes(d.tier)&&(pm&&d.performanceLocked||pot&&d.potentialLocked)))throw Error('HOD calibration is closed after BU or BG locks.');
}
export async function saveOnehrCalibration(ctx:SessionContext,sessionId:string,expected:number,raw:unknown) {
 const p=z.object({reviewId:uuid,axis:z.enum(['performance','potential','both']).default('both'),performance:z.enum(pmBands).nullable(),potential:z.enum(potentialBands).nullable(),performanceNote:note,potentialNote:note,pip:z.boolean().default(false),promotion:z.boolean().default(false),specialReward:z.boolean().default(false),confirmTalentDecisions:z.boolean().default(false)}).parse(raw);
 return withPerformanceTenant(ctx,async tx=>{
  const {session,cycle}=await loadCalibration(tx,sessionId,expected);if(session.lockedAt||!['open','calibration'].includes(cycle.native.status))throw Error('This calibration is locked.');
  const {pm,pot}=needsAxes(cycle.policy,p.axis,session.tier);if(!pm&&!pot)throw Error('This assessment axis is disabled.');calibrationWindows(cycle.policy,session.tier as Tier,p.axis);
  const [entry]=await tx.select().from(onehrCalibrationEntry).where(and(eq(onehrCalibrationEntry.sessionId,sessionId),eq(onehrCalibrationEntry.reviewId,p.reviewId)));
  if(!entry||await isSelf(tx,entry.employmentId))throw Error('This assessment cannot be calibrated by you.');
  if(pm&&(session.performanceLockedAt||entry.performanceLockedAt)&&session.tier!=='final'||pot&&(session.potentialLockedAt||entry.potentialLockedAt)&&session.tier!=='final')throw Error('This assessment axis is locked.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${p.reviewId},0))`);
  const current=await resolved(tx,p.reviewId,cycle.policy);if(current.input.finalized)throw Error('Assessment is finalized.');
  assertPrecedingTier(current.rows,session.tier as Tier,session.mode,pm,pot);
  const below=current.rows.filter(d=>tiers.indexOf(d.tier)<tiers.indexOf(session.tier as Tier)&&!(d.tier==='group'&&d.mode==='blend'));
  const baselinePm=resolveBand(current.input.performance,below.map(d=>({...d,band:d.performance,locked:d.performanceLocked}))).band;
  const baselinePot=resolveBand(current.input.potential.band,below.map(d=>({...d,band:d.potential,locked:d.potentialLocked}))).band;
  if(session.tier==='hod'&&(pm&&p.performance!=null&&p.performance!==baselinePm&&!p.performanceNote.trim()||pot&&p.potential!=null&&p.potential!==baselinePot&&!p.potentialNote.trim()))throw Error('Explain each changed band.');
  if((p.pip||p.promotion||p.specialReward)&&!['bg','group','final'].includes(session.tier))throw Error('Talent decisions require BG, Group or final reviewer confirmation.');
  if(p.pip||p.promotion||p.specialReward||p.confirmTalentDecisions)throw Error('Confirm talent decisions in the decision lists after locking calibration.');
  const chosenPm=pm?p.performance??baselinePm:entry.performance,chosenPot=pot?p.potential??baselinePot:entry.potential;
  if(session.tier==='hod'&&(pm&&!chosenPm||pot&&!chosenPot))throw Error('Assign a band before saving this department review.');
  const final=session.tier==='final',once=session.tier==='hod',now=new Date();
  const pmLock=pm&&(final||once)&&chosenPm?now:entry.performanceLockedAt,potLock=pot&&(final||once)&&chosenPot?now:entry.potentialLockedAt;
  const axes=needsAxes(cycle.policy,'both',session.tier);
  const data={...(pm?{performance:chosenPm,performancePinned:false,performanceNote:p.performanceNote,seenPerformance:baselinePm,performanceLockedAt:pmLock}:{}),...(pot?{potential:chosenPot,potentialPinned:false,potentialNote:p.potentialNote,seenPotential:baselinePot,potentialLockedAt:potLock}:{}),lockedAt:(!axes.pm||pmLock)&&(!axes.pot||potLock)?now:null};
  await tx.update(onehrCalibrationEntry).set(data).where(eq(onehrCalibrationEntry.id,entry.id));
  await tx.update(onehrCalibration).set({revision:session.revision+1}).where(eq(onehrCalibration.id,sessionId));
  await audit(tx,ctx,sessionId,'calibration-recorded',{reviewId:p.reviewId,axis:p.axis,previous:{performance:entry.performance,potential:entry.potential,performanceNote:entry.performanceNote,potentialNote:entry.potentialNote},next:data});
 });
}
export async function lockOnehrCalibration(ctx:SessionContext,sessionId:string,expected:number,overrideReason:string,axis:Axis='both',reviewId?:string,companyId?:string) {
 note.parse(overrideReason);z.enum(['performance','potential','both']).parse(axis);if(reviewId)uuid.parse(reviewId);if(companyId)uuid.parse(companyId);
 if(reviewId&&companyId)throw Error('Choose one person or one business unit to lock.');
 return withPerformanceTenant(ctx,async tx=>{
  const {session,cycle}=await loadCalibration(tx,sessionId,expected);if(!['open','calibration'].includes(cycle.native.status))throw Error('Closed calibration periods are read-only.');const {pm,pot}=needsAxes(cycle.policy,axis,session.tier);
  if(!pm&&!pot)throw Error('This assessment axis is disabled.');if(session.lockedAt||pm&&session.performanceLockedAt||pot&&session.potentialLockedAt)throw Error('Calibration axis is already locked.');calibrationWindows(cycle.policy,session.tier as Tier,axis);
  const [own]=await tx.execute<{present:boolean}>(sql`select app.onehr_cohort_own(${sessionId}::uuid) as present`);if(!reviewId&&!companyId&&own?.present)throw Error('A reviewer cannot lock their own calibration.');
  const entries=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId)).orderBy(asc(onehrCalibrationEntry.reviewId));if(!entries.length)throw Error('An empty cohort cannot be locked.');
  if(reviewId&&(!['group','final'].includes(session.tier)||!entries.some(e=>e.reviewId===reviewId)))throw Error('Individual locking is available only within a Group or final cohort.');
  if(companyId&&session.tier!=='bg')throw Error('Business-unit locking is available in the BG Talent Box.');
  const selected=reviewId?entries.filter(e=>e.reviewId===reviewId):companyId?[]:entries;
  if(own?.present&&session.tier==='bu'&&cycle.policy.curveStrict&&!overrideReason.trim())throw Error('A separate reviewer or explicit override reason is required to assess a distribution that includes your own result.');
  const bands:{performance:PMBand|null;potential:PotentialBand|null}[]=[];
  const pinned=new Map<string,{performance:PMBand|null;potential:PotentialBand|null}>();
  for(const e of entries){
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${e.reviewId},0))`);
   if(await isSelf(tx,e.employmentId)){
    if(companyId){const [ownReview]=await tx.execute<{companyId:string}>(sql`select company_id as "companyId" from performance_onehr_review where review_id=${e.reviewId}::uuid`);if(ownReview?.companyId===companyId)throw Error('A reviewer cannot lock their own calibration.');}
    else if(selected.some(x=>x.id===e.id))throw Error('A reviewer cannot lock their own calibration.');
    continue;
   }
   const r=await resolved(tx,e.reviewId,cycle.policy);
   if(companyId&&r.input.companyId===companyId)selected.push(e);if(r.input.finalized&&selected.some(x=>x.id===e.id)&&(pm&&!e.performanceLockedAt||pot&&!e.potentialLockedAt))throw Error('An assessment in this cohort is already finalized.');
   const chosen=selected.some(x=>x.id===e.id);
   if(chosen)assertPrecedingTier(r.rows,session.tier as Tier,session.mode,pm,pot);
   const baseline=boxBands(r,session.tier);
   const effective={performance:z.enum(pmBands).nullable().parse(e.performance??baseline.performance),potential:z.enum(potentialBands).nullable().parse(e.potential??baseline.potential)};
   const valid=(!pm||!!effective.performance)&&(!pot||!!effective.potential&&(session.tier!=='hod'||r.input.potential.valid||!!e.potential||r.potential.source!=='manager'));
   if(chosen&&!valid)throw Error('Complete the enabled assessment axes and required valid responses first.');
   if(valid)bands.push(effective);
   if(chosen)pinned.set(e.id,effective);
  }
  if(!selected.length)throw Error('No assessments belong to this business unit.');
  assertCurveLock(cycle.policy,session.tier,bands,session.pbtAchievement==null?null:referenceCurve(Number(session.pbtAchievement)),{pm,pot},overrideReason);
  const now=new Date();
  for(const e of selected){const pl=pm?e.performanceLockedAt??now:e.performanceLockedAt,tl=pot?e.potentialLockedAt??now:e.potentialLockedAt;
   if(pl===e.performanceLockedAt&&tl===e.potentialLockedAt)continue;
   const effective=pinned.get(e.id)!;
   await tx.update(onehrCalibrationEntry).set({...(pm?{performance:effective.performance,performancePinned:e.performancePinned||e.performance==null}:{}),...(pot?{potential:effective.potential,potentialPinned:e.potentialPinned||e.potential==null}:{}),performanceLockedAt:pl,potentialLockedAt:tl,lockedAt:(!needsAxes(cycle.policy,'both',session.tier).pm||pl)&&(!needsAxes(cycle.policy,'both',session.tier).pot||tl)?e.lockedAt??now:null}).where(eq(onehrCalibrationEntry.id,e.id));
  }
  const updated=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId));
  const pmLock=!own?.present&&updated.every(e=>e.performanceLockedAt)?session.performanceLockedAt??now:null,potLock=!own?.present&&updated.every(e=>e.potentialLockedAt)?session.potentialLockedAt??now:null;
  const all=(!needsAxes(cycle.policy,'both',session.tier).pm||pmLock)&&(!needsAxes(cycle.policy,'both',session.tier).pot||potLock);
  await tx.update(onehrCalibration).set({performanceLockedAt:pmLock,potentialLockedAt:potLock,lockedAt:all?now:null,revision:session.revision+1}).where(eq(onehrCalibration.id,sessionId));
  await audit(tx,ctx,sessionId,'calibration-locked',{axis,reviewId:reviewId??null,companyId:companyId??null,override:!!overrideReason.trim(),reason:overrideReason});
 });
}

/** HR can reopen an unfinalized decision; downstream confirmations must be reopened first. */
export async function unlockOnehrCalibration(ctx:SessionContext,sessionId:string,expected:number,reason:string,axis:Axis='both',reviewId?:string) {
 z.string().trim().min(1).max(4000).parse(reason);z.enum(['performance','potential','both']).parse(axis);if(reviewId)uuid.parse(reviewId);
 return withPerformanceTenant(ctx,async tx=>{
  const {session,cycle}=await loadCalibration(tx,sessionId,expected);await requireAdmin(tx,session.cycleId);
  if(!['open','calibration'].includes(cycle.native.status))throw Error('Closed calibration periods are read-only.');
  const {pm,pot}=needsAxes(cycle.policy,axis,session.tier);if(!pm&&!pot)throw Error('This assessment axis is disabled.');
  const [own]=await tx.execute<{present:boolean}>(sql`select app.onehr_cohort_own(${sessionId}::uuid) as present`);if(!reviewId&&own?.present)throw Error('Ask another administrator to reopen a cohort containing your assessment.');
  const entries=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId)).orderBy(asc(onehrCalibrationEntry.reviewId));
  if(reviewId&&!entries.some(e=>e.reviewId===reviewId))throw Error('Assessment not available in this cohort.');
  const changed=[];
  for(const e of entries.filter(e=>!reviewId||e.reviewId===reviewId)){
   if(await isSelf(tx,e.employmentId))throw Error('Ask another administrator to reopen your assessment.');
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${e.reviewId},0))`);
   const current=await resolved(tx,e.reviewId,cycle.policy);
   if(current.input.finalized){if(reviewId)throw Error('Finalized assessments cannot reopen.');continue;}
   if(session.pipLockedAt||session.promotionLockedAt)throw Error('Reopen the confirmed talent decision lists before reopening calibration.');
   if(current.rows.some(d=>tiers.indexOf(d.tier)>tiers.indexOf(session.tier as Tier)&&(pm&&d.performanceLocked||pot&&d.potentialLocked)))throw Error('Reopen later calibration tiers first.');
   if(!(pm&&(session.performanceLockedAt||e.performanceLockedAt)||pot&&(session.potentialLockedAt||e.potentialLockedAt)))continue;
   changed.push({reviewId:e.reviewId,previous:e});
   await tx.update(onehrCalibrationEntry).set({...(pm?{performanceLockedAt:null,performancePinned:false,...(session.tier==='final'||e.performancePinned?{performance:null}:{})}:{}),...(pot?{potentialLockedAt:null,potentialPinned:false,...(session.tier==='final'||e.potentialPinned?{potential:null}:{})}:{}),lockedAt:null}).where(eq(onehrCalibrationEntry.id,e.id));
  }
  if(!changed.length)throw Error('No unfinalized locked assessments are available to reopen.');
  const updated=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId));
  const pl=!own?.present&&updated.length&&updated.every(e=>e.performanceLockedAt)?session.performanceLockedAt:null;
  const tl=!own?.present&&updated.length&&updated.every(e=>e.potentialLockedAt)?session.potentialLockedAt:null;
  await tx.update(onehrCalibration).set({performanceLockedAt:pl||null,potentialLockedAt:tl||null,lockedAt:null,revision:session.revision+1}).where(eq(onehrCalibration.id,sessionId));
  await audit(tx,ctx,sessionId,'calibration-reopened',{axis,reason,changes:changed});
 });
}

async function calibrationRow(tx:Tx,ctx:SessionContext,entry:typeof onehrCalibrationEntry.$inferSelect,policy:Policy,tier:string){
 const r=await resolved(tx,entry.reviewId,policy),talent=await talentContext(tx,ctx.tenantId,entry.reviewId,entry.employmentId,policy),bands=boxBands(r,tier);
 return {entry:{...entry,...talent.actions},talent,companyId:r.input.companyId,finalized:r.input.finalized,name:r.input.name,grade:r.input.grade,managerPerformance:r.input.performance,managerPotential:r.input.potential.band,currentPerformance:bands.performance,currentPotential:bands.potential,performanceSource:bands.performanceSource,potentialSource:bands.potentialSource};
}
export async function getOnehrCalibration(ctx:SessionContext,sessionId:string) {
  return withPerformanceTenant(ctx,async tx=>{
    const {session,cycle}=await loadCalibration(tx,sessionId);
    const entries=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId));
    const rows:Awaited<ReturnType<typeof calibrationRow>>[]=[];
    for(const entry of entries){if(await isSelf(tx,entry.employmentId))continue;rows.push(await calibrationRow(tx,ctx,entry,cycle.policy,session.tier));}
    const [own]=await tx.execute<{present:boolean}>(sql`select app.onehr_cohort_own(${sessionId}::uuid) as present`);
    const companyIds=[...new Set(rows.map(r=>r.companyId))];
    const companies=companyIds.length?await tx.select({id:company.id,name:company.legalName}).from(company).where(inArray(company.id,companyIds)):[];
    const units=companyIds.map(id=>({id,name:companies.find(c=>c.id===id)?.name??id,locked:rows.filter(r=>r.companyId===id).every(r=>r.entry.lockedAt)}));
    return {actorUserId:ctx.userId,units,session,canReopen:await isAdmin(tx,session.cycleId)&&['open','calibration'].includes(cycle.native.status),canLockCohort:!own?.present,cycle:{id:cycle.native.id,name:cycle.native.name},modules:{...cycle.policy.modules,pm:ratedPerformance(cycle.policy)},axes:needsAxes(cycle.policy,'both',session.tier),rows,reference:session.pbtAchievement==null?null:referenceCurve(Number(session.pbtAchievement))};
  });
}
export async function freezeOnehrReview(ctx:SessionContext,reviewId:string,expected:number) {
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await requireAdmin(tx,r.row.cycleId);revision(r.row.revision,expected);
    if(await isSelf(tx,r.row.employmentId))throw Error('Ask another administrator to finalize your assessment.');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${reviewId},0))`);
    const [existing]=await tx.select().from(onehrResult).where(eq(onehrResult.reviewId,reviewId));if(existing)return existing.id;
    if(!['open','calibration'].includes(r.cycle.native.status))throw Error('The cycle is closed.');
    const resolvedResult=await resolved(tx,reviewId,r.cycle.policy);
    const activeDecisions=resolvedResult.rows.filter(d=>!(d.tier==='group'&&d.mode==='blend'));
    const pmDecisions=activeDecisions.filter(d=>!(d.tier==='bg'&&activeDecisions.some(g=>g.tier==='group'&&g.mode==='replace')));
    const covered=(tier:Tier,axis:'performanceLocked'|'potentialLocked')=>(axis==='performanceLocked'?pmDecisions:activeDecisions).some(h=>tiers.indexOf(h.tier)>tiers.indexOf(tier)&&h[axis]);
    if(activeDecisions.some(d=>d.tier!=='final'&&(
     ratedPerformance(r.cycle.policy)&&pmDecisions.includes(d)&&!d.performanceLocked&&!covered(d.tier,'performanceLocked')||
     r.cycle.policy.modules.tm&&(d.tier!=='group'||d.potential!=null)&&!d.potentialLocked&&!covered(d.tier,'potentialLocked'))))throw Error('Lock every assigned calibration scope or its superseding tier before finalizing.');
    if(r.cycle.policy.modules.tm&&!resolvedResult.input.potential.valid&&resolvedResult.potential.source==='manager')throw Error('Complete the required valid 360 submissions first.');
    if(ratedPerformance(r.cycle.policy)&&!resolvedResult.performance.band||r.cycle.policy.modules.tm&&!resolvedResult.potential.band)throw Error('Complete every enabled assessment axis before finalizing.');
    if(r.cycle.policy.modules.pm&&r.cycle.policy.kind==='quarterly'&&(!r.kpis.length||r.kpis.some(k=>!k.checkIn)))throw Error('Complete every quarterly KPI check-in before finalizing.');
    const talentDecision=[...resolvedResult.rows].reverse().find(d=>['bg','group','final'].includes(d.tier)&&!(d.tier==='group'&&d.mode==='blend')&&d.locked);
    if(talentDecision&&(!talentDecision.pipConfirmed||!talentDecision.promotionConfirmed))throw Error('Confirm the PIP and promotion lists before finalizing talent decisions for Rewards.');
    const evidence=await tx.select().from(onehrEvidence).where(and(eq(onehrEvidence.employmentId,r.row.employmentId),eq(onehrEvidence.state,'shared')));
    const attachmentLinks=(await assessmentKpiFilesTx(tx,reviewId)).map(({attachmentId,kpiId})=>({attachmentId,kpiId}));
    const proofIds=attachmentLinks.map(l=>l.attachmentId);
    const attachments=await tx.select({id:performanceAttachment.id,fileName:performanceAttachment.fileName,sizeBytes:performanceAttachment.sizeBytes}).from(performanceAttachment).where(sql`(${performanceAttachment.reviewId}=${reviewId}::uuid ${proofIds.length?sql`or ${inArray(performanceAttachment.id,proofIds)}`:sql``})`).orderBy(asc(performanceAttachment.createdAt),asc(performanceAttachment.id));
    const panel=await tx.select({answers:onehrPanel.answers,remark:onehrPanel.remark,comments:onehrPanel.principleComments}).from(onehrPanel).where(and(eq(onehrPanel.reviewId,reviewId),isNull(onehrPanel.archivedAt),sql`${onehrPanel.submittedAt} is not null`));
    const anonymousFeedback=anonymousFeedbackReport(z.array(statementSchema).parse(r.row.statements),panel.map(p=>({answers:z.record(z.string(),z.enum(['yes','no'])).parse(p.answers),remark:p.remark,comments:p.comments})));
    const sharedTalent=(await talentContext(tx,ctx.tenantId,reviewId,r.row.employmentId,r.cycle.policy)).actions;
    const result:FrozenResult={version:1,anonymousFeedback,confirmedGrade:sharedTalent.promotion?sharedTalent.confirmedGrade:'',confirmedTitle:sharedTalent.promotion?sharedTalent.confirmedTitle:'',pipReason:sharedTalent.pipReason,promotionReason:sharedTalent.promotionReason,specialRewardReason:sharedTalent.specialRewardReason,provenance:{selfRemark:r.row.selfRemark,managerRemark:r.row.managerRemark,competencySelfRemark:r.row.competencySelfRemark,competencyManagerRemark:r.row.competencyManagerRemark,attachmentLinks,evidence,attachments,kpis:r.kpis,competencies:r.competencies,leadership:resolvedResult.input.leadership,decisions:resolvedResult.rows},performance:resolvedResult.performance.band,potential:resolvedResult.potential.band,performanceSource:resolvedResult.performance.source,potentialSource:resolvedResult.potential.source,talent:talentCategory(resolvedResult.performance.band,resolvedResult.potential.band),selfScore:scorecard(r.kpis,r.cycle.policy,r.row.companyId,false).score,managerScore:r.row.managerScore==null?null:Number(r.row.managerScore),potentialPct:resolvedResult.input.potential.pct,grade:r.row.grade,policyDigest:hash(r.cycle.policy),feedback:resolvedResult.input.principles.map(p=>({principle:p.principle,band:p.pct<=r.cycle.policy.lowMaxPct?'Low':p.pct<=r.cycle.policy.midMaxPct?'Mid':'High'})),pip:sharedTalent.pip,promotion:sharedTalent.promotion,specialReward:sharedTalent.specialReward};
    const [released]=await tx.select().from(assessmentRelease).where(eq(assessmentRelease.reviewId,reviewId));
    const [frozen]=await tx.insert(onehrResult).values({tenantId:ctx.tenantId,reviewId,cycleId:r.row.cycleId,employmentId:r.row.employmentId,result,digest:hash({reviewId,policy:r.cycle.policy,result}),performanceReleasedAt:released?.performanceReleasedAt,potentialReleasedAt:released?.potentialReleasedAt,talentReleasedAt:released?.talentReleasedAt,feedbackReleasedAt:released?.feedbackReleasedAt}).returning();
    // Legacy ratings stay null: OneHR's frozen record is the sole authoritative final assessment.
    await tx.update(performanceReview).set({closedAt:new Date(),status:'submitted'}).where(eq(performanceReview.id,reviewId));await audit(tx,ctx,reviewId,'assessment-frozen',{resultId:frozen.id,digest:frozen.digest});return frozen.id;
  });
}
export async function releaseOnehrResult(ctx:SessionContext,reviewId:string,component:'performance'|'potential'|'talent'|'feedback',release:boolean) {
  z.enum(['performance','potential','talent','feedback']).parse(component);z.boolean().parse(release);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await requireAdmin(tx,r.row.cycleId);
    if(await isSelf(tx,r.row.employmentId))throw Error('Ask another administrator to release your results.');
    const [card]=await tx.execute<{value:ResultCard|null}>(sql`select app.onehr_result_card(${reviewId}::uuid) as value`);
    if(release){
      if(!card?.value)throw Error('This assessment is not available for release.');
      if(component==='feedback'){
        const panels=await tx.select({id:onehrPanel.requestId}).from(onehrPanel).where(and(eq(onehrPanel.reviewId,reviewId),isNull(onehrPanel.archivedAt),sql`${onehrPanel.submittedAt} is not null`));
        const minimum=/^\d+$/.test(r.row.grade.replace(/^JG\s*/i,'').trim())?r.cycle.policy.minValid:1;
        if(panels.length<minimum)throw Error('Enough valid feedback submissions are required before releasing the report.');
      }else if(!card.value.result[component])throw Error('There is no result to release for this component yet.');
    }
    const field={performance:'performanceReleasedAt',potential:'potentialReleasedAt',talent:'talentReleasedAt',feedback:'feedbackReleasedAt'}[component];
    const at=release?new Date():null;
    await tx.insert(assessmentRelease).values({tenantId:ctx.tenantId,reviewId,[field]:at,updatedBy:ctx.userId!,updatedAt:new Date()}).onConflictDoUpdate({target:assessmentRelease.reviewId,set:{[field]:at,updatedBy:ctx.userId!,updatedAt:new Date()}});
    // Compatibility projection for frozen-result readers; the release grant owns visibility.
    await tx.update(onehrResult).set({[field]:at}).where(eq(onehrResult.reviewId,reviewId));
    await audit(tx,ctx,reviewId,release?'result-released':'result-revoked',{component,interim:!card?.value?.frozen});
  });
}

async function saveCareerTx(tx:Tx,ctx:SessionContext,r:Awaited<ReturnType<typeof loadReview>>,career:ReturnType<typeof careerSchema.parse>,expected?:number|null) {
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`career:${r.row.employmentId}`},0))`);
 const [current]=await tx.select().from(assessmentCareerProfile).where(eq(assessmentCareerProfile.employmentId,r.row.employmentId)).for('update');
 if(expected!==undefined&&(current?.revision??null)!==expected)throw Error('Your career profile changed. Reload before saving.');
 for(const id of [career.selfProfileId,career.targetProfileId])if(id&&!r.cycle.policy.profiles.some(p=>p.id===id&&p.active!==false))throw Error('Choose an active role from the career catalogue.');
 if(current)await tx.update(assessmentCareerProfile).set({reviewId:r.row.reviewId,career,revision:current.revision+1,updatedAt:new Date()}).where(eq(assessmentCareerProfile.employmentId,r.row.employmentId));
 else await tx.insert(assessmentCareerProfile).values({tenantId:ctx.tenantId,employmentId:r.row.employmentId,reviewId:r.row.reviewId,career});
}
export async function saveAssessmentCareerProfile(ctx:SessionContext,reviewId:string,expected:number|null,raw:unknown) {
 return withPerformanceTenant(ctx,tx=>saveAssessmentCareerProfileTx(tx,ctx,reviewId,expected,raw));
}
export async function saveAssessmentCareerProfileTx(tx:Tx,ctx:SessionContext,reviewId:string,expected:number|null,raw:unknown) {
 const career=careerSchema.parse(raw);
  const r=await loadReview(tx,reviewId);
  const self=await isSelf(tx,r.row.employmentId),admin=!self&&await isAdmin(tx,r.row.cycleId);
  if(!r.cycle.policy.modules.idp||!self&&!admin)throw Error('Only the employee or a scoped Performance administrator may update the career profile.');
  if(!admin){if(!['open','calibration'].includes(r.cycle.native.status))throw Error('This assessment period is read-only.');assertWindow(r.cycle.policy,'idp_self');}
  const [previous]=await tx.select({career:assessmentCareerProfile.career}).from(assessmentCareerProfile).where(eq(assessmentCareerProfile.employmentId,r.row.employmentId));
  await saveCareerTx(tx,ctx,r,career,expected);await audit(tx,ctx,reviewId,'career-profile-saved',{byAdmin:admin,previous:previous?.career??null,next:career});
}
export async function commentAssessmentCareerProfile(ctx:SessionContext,reviewId:string,expected:number|null,comment:string) {
 note.parse(comment);
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId);
  if(await isSelf(tx,r.row.employmentId)||!r.cycle.policy.modules.idp||!await isManager(tx,reviewId)&&!await isModerator(tx,reviewId))throw Error('Only the assigned manager may comment on the career profile.');
  if(!['open','calibration'].includes(r.cycle.native.status))throw Error('This assessment period is read-only.');assertWindow(r.cycle.policy,'idp_review');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`career:${r.row.employmentId}`},0))`);
  const [profile]=await tx.select().from(assessmentCareerProfile).where(eq(assessmentCareerProfile.employmentId,r.row.employmentId)).for('update');
  if((profile?.revision??null)!==expected)throw Error('The career profile changed. Reload before commenting.');
  const data={reviewId,managerComment:comment,managerUserId:ctx.userId!,managerCommentAt:new Date(),revision:(profile?.revision??0)+1,updatedAt:new Date()};
  if(profile)await tx.update(assessmentCareerProfile).set(data).where(eq(assessmentCareerProfile.employmentId,r.row.employmentId));
  else await tx.insert(assessmentCareerProfile).values({...data,tenantId:ctx.tenantId,employmentId:r.row.employmentId,career:{aspiration:'',mobility:null,mobilityNote:'',targetProfileId:null,selfProfileId:null}});
  await audit(tx,ctx,reviewId,'career-profile-commented');
 });
}

export async function saveOnehrPlan(ctx:SessionContext,reviewId:string,expected:number|null,raw:unknown,share=false) {
 return withPerformanceTenant(ctx,tx=>saveOnehrPlanTx(tx,ctx,reviewId,expected,raw,share));
}
export async function saveOnehrPlanTx(tx:Tx,ctx:SessionContext,reviewId:string,expected:number|null,raw:unknown,share=false) {
  const p=z.object({careerRevision:z.number().int().nullable().optional(),career:careerSchema,goals:z.array(goalSchema.pick({id:true,area:true,dueOn:true,onJob:true,fromOthers:true,formalLearning:true,status:true})).max(100)}).parse(raw);
    const r=await loadReview(tx,reviewId);if(!await isSelf(tx,r.row.employmentId))throw Error('Only the employee may write their plan.');if(!r.cycle.policy.modules.idp)throw Error('Development plans are disabled.');if(r.cycle.policy.kind!=='year_end')throw Error('Write development plans at year-end; use this period to review the agreed plan.');if(!['open','calibration'].includes(r.cycle.native.status))throw Error('This assessment period is read-only.');assertWindow(r.cycle.policy,'idp_self');
    const year=Number(r.cycle.native.periodEnd.slice(0,4))+(r.cycle.policy.kind==='year_end'?1:0);
    const [existing]=await tx.select().from(onehrPlan).where(and(eq(onehrPlan.employmentId,r.row.employmentId),eq(onehrPlan.planYear,year))).for('update');
    if(existing){revision(existing.revision,expected!);if(existing.status!=='draft')throw Error('Career and development goals are locked after sharing.');}else if(expected!=null)throw Error('Reload this plan.');
    if(new Set(p.goals.map(g=>g.id)).size!==p.goals.length)throw Error('Duplicate development goal.');
    if(p.career.targetProfileId&&!r.cycle.policy.profiles.some(profile=>profile.id===p.career.targetProfileId))throw Error('Choose an available target profile.');
    if(share&&![p.career.aspiration,p.career.aspirationNow,p.career.aspirationLong].some(v=>v?.trim()))throw Error('Complete your career aspiration before sharing the plan.');
    if(share&&!p.career.mobility)throw Error('Choose your mobility preference before sharing the plan.');
    const filled=p.goals.filter(g=>[g.area,g.onJob,g.fromOthers,g.formalLearning].some(v=>v.trim()));
    if(share&&filled.some(g=>!g.area.trim()))throw Error('Name the area for every development goal.');
    if(share&&r.cycle.policy.idpMaxGoals&&filled.length>r.cycle.policy.idpMaxGoals)throw Error('This plan exceeds the configured development goal limit.');
    if(share&&filled.length<r.cycle.policy.idpMinGoals)throw Error('Add the required development goals before sharing.');
    if(share&&filled.some(g=>r.cycle.policy.idpRequireAllActions?!g.onJob||!g.fromOthers||!g.formalLearning:!g.onJob&&!g.fromOthers&&!g.formalLearning))throw Error('Add development actions before sharing.');
    await saveCareerTx(tx,ctx,r,p.career,p.careerRevision);
    const data={career:p.career,goals:(share?filled:p.goals).map(g=>({...g,status:'not_started',managerComment:''})),status:share?'shared':'draft'};
    if(existing)await tx.update(onehrPlan).set({...data,revision:existing.revision+1}).where(eq(onehrPlan.id,existing.id));else await tx.insert(onehrPlan).values({...data,tenantId:ctx.tenantId,reviewId,employmentId:r.row.employmentId,planYear:year});await audit(tx,ctx,reviewId,share?'plan-shared':'plan-saved');
}
export async function reviewOnehrPlan(ctx:SessionContext,planId:string,expected:number,comment:string,conversation:string,close=false,activeReviewId?:string,heldOn?:string|null) {
  uuid.parse(planId);note.parse(comment);note.parse(conversation);assertOverallRemark(comment);if(heldOn)z.iso.date().parse(heldOn);
  return withPerformanceTenant(ctx,async tx=>{
    const [plan]=await tx.select().from(onehrPlan).where(eq(onehrPlan.id,planId)).for('update');if(!plan)throw Error('Plan not found.');revision(plan.revision,expected);
    const r=await loadReview(tx,activeReviewId??plan.reviewId);if(!r.cycle.policy.modules.idp)throw Error('Development plans are disabled.');const activeYear=Number(r.cycle.native.periodEnd.slice(0,4))+(r.cycle.policy.kind==='year_end'?1:0);if(r.row.employmentId!==plan.employmentId||activeYear!==plan.planYear)throw Error('This assessment does not own the plan year.');if(await isSelf(tx,plan.employmentId)||!await isManager(tx,activeReviewId??plan.reviewId)&&!await isModerator(tx,activeReviewId??plan.reviewId))throw Error('Only the assigned manager may review this plan.');if(!['open','calibration'].includes(r.cycle.native.status))throw Error('This assessment period is read-only.');assertWindow(r.cycle.policy,'idp_review');
    if(plan.status!=='shared'&&plan.status!=='closed')throw Error('The employee must share the plan first.');if(plan.status==='closed'&&comment!==plan.managerComment)throw Error('An agreed plan remark cannot change. Record a new conversation or update goal progress instead.');
    await tx.update(onehrPlan).set({managerComment:comment,conversation,conversationHeldOn:heldOn===undefined?plan.conversationHeldOn:heldOn,acknowledgedAt:conversation!==plan.conversation||heldOn!==undefined&&heldOn!==plan.conversationHeldOn?null:plan.acknowledgedAt,status:close||plan.status==='closed'?'closed':'shared',revision:plan.revision+1}).where(eq(onehrPlan.id,planId));await audit(tx,ctx,planId,close?'plan-closed':'plan-reviewed',{reviewId:activeReviewId??plan.reviewId,previous:{comment:plan.managerComment,conversation:plan.conversation,heldOn:plan.conversationHeldOn,status:plan.status},next:{comment,conversation,heldOn:heldOn===undefined?plan.conversationHeldOn:heldOn,status:close||plan.status==='closed'?'closed':'shared'}});
  });
}
export async function updateOnehrGoalProgress(ctx:SessionContext,planId:string,expected:number,goalId:string,status:'not_started'|'in_progress'|'done'|'dropped',progressNote='',activeReviewId?:string) {
  uuid.parse(planId);uuid.parse(goalId);z.enum(['not_started','in_progress','done','dropped']).parse(status);z.string().trim().max(2000).parse(progressNote);
  return withPerformanceTenant(ctx,async tx=>{const [plan]=await tx.select().from(onehrPlan).where(eq(onehrPlan.id,planId)).for('update');if(!plan||!await isSelf(tx,plan.employmentId))throw Error('Plan not found.');revision(plan.revision,expected);if(plan.status==='draft')throw Error('Share the plan before updating progress.');
    const r=await loadReview(tx,activeReviewId??plan.reviewId);const year=Number(r.cycle.native.periodEnd.slice(0,4))+(r.cycle.policy.kind==='year_end'?1:0);
    if(r.row.employmentId!==plan.employmentId||year!==plan.planYear||!r.cycle.policy.modules.idp||!['open','calibration'].includes(r.cycle.native.status))throw Error('Check in through an active assessment period for this plan year.');
    const now=new Date().toISOString();
    const goals=z.array(goalSchema).parse(plan.goals);if(!goals.some(g=>g.id===goalId))throw Error('Goal not found.');const previous=goals.find(g=>g.id===goalId)!.status;
    await tx.update(onehrPlan).set({goals:goals.map(g=>g.id===goalId?{...g,status,progressNote,progressAt:now,checkins:[...(g.checkins??[]),{status,note:progressNote,at:now}]}:g),revision:plan.revision+1}).where(eq(onehrPlan.id,planId));await audit(tx,ctx,planId,'goal-progress-updated',{goalId,previous,status,note:progressNote,reviewId:r.row.reviewId});});
}
export async function acknowledgeOnehrPlan(ctx:SessionContext,planId:string,expected:number) {
  uuid.parse(planId);return withPerformanceTenant(ctx,async tx=>{const [p]=await tx.select().from(onehrPlan).where(eq(onehrPlan.id,planId)).for('update');if(!p||!await isSelf(tx,p.employmentId))throw Error('Plan not found.');revision(p.revision,expected);if(p.status!=='closed')throw Error('A recorded career conversation is required.');await tx.update(onehrPlan).set({acknowledgedAt:new Date(),revision:p.revision+1}).where(eq(onehrPlan.id,planId));await audit(tx,ctx,planId,'plan-acknowledged');});
}
export async function reopenAssessmentPlan(ctx:SessionContext,planId:string,expected:number){
 uuid.parse(planId);
 return withPerformanceTenant(ctx,async tx=>{
  const [plan]=await tx.select().from(onehrPlan).where(eq(onehrPlan.id,planId)).for('update');
  if(!plan)throw Error('Plan not found in your scope.');
  const r=await loadReview(tx,plan.reviewId);await requireAdmin(tx,r.row.cycleId);
  if(await isSelf(tx,plan.employmentId))throw Error('Ask another administrator to reopen your plan.');revision(plan.revision,expected);
  if(plan.status==='draft')return;
  await tx.update(onehrPlan).set({status:'draft',acknowledgedAt:null,revision:plan.revision+1}).where(eq(onehrPlan.id,planId));
  await audit(tx,ctx,planId,'plan-reopened',{previousStatus:plan.status,planYear:plan.planYear});
 });
}
async function validateEvidenceLinks(r:Awaited<ReturnType<typeof loadReview>>,links:z.infer<typeof evidenceLinkSchema>[]){
 for(const link of links)if(link.kind==='kpi'?!r.kpis.some(k=>k.id===link.id&&!k.hrOwned):link.kind==='skill'?!r.competencies.some(c=>c.id===link.id):!(r.row.statements as Statement[]).some(s=>s.principle===link.id))throw Error('Choose an employee-owned KPI, assigned competency or leadership principle.');
}
export async function addOnehrEvidence(ctx:SessionContext,reviewId:string,raw:unknown) {
 return withPerformanceTenant(ctx,tx=>addOnehrEvidenceTx(tx,ctx,reviewId,raw));
}
export async function addOnehrEvidenceTx(tx:Tx,ctx:SessionContext,reviewId:string,raw:unknown) {
 const p=evidenceFieldsSchema.extend({state:z.enum(['draft','shared']),supersedesId:uuid.nullable(),links:evidenceLinkSchema.array().max(30)}).parse(raw);
  const r=await loadReview(tx,reviewId),self=await isSelf(tx,r.row.employmentId);
  if(!r.cycle.policy.modules.evidence)throw Error('Evidence is disabled.');
  if(!self&&!await isManager(tx,reviewId)&&!await isModerator(tx,reviewId))throw Error('Only the employee or assigned manager may add evidence.');
  if(!self&&p.links.length)throw Error('Only the employee may link evidence to their assessment.');
  await validateEvidenceLinks(r,p.links);
  if(p.supersedesId){const [previous]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,p.supersedesId));if(!previous||previous.employmentId!==r.row.employmentId||previous.authorUserId!==ctx.userId||previous.state!=='shared')throw Error('Correct only your own shared evidence.');}
  const {kind,body,occurredOn,state,supersedesId,links,...details}=p;
  const [entry]=await tx.insert(onehrEvidence).values({kind,body,occurredOn,details,state:self?state:'shared',supersedesId,links,tenantId:ctx.tenantId,reviewId,employmentId:r.row.employmentId,authorUserId:ctx.userId!}).returning();
  await audit(tx,ctx,entry.id,'evidence-added');return entry.id;
}
export async function editAssessmentEvidence(ctx:SessionContext,id:string,expected:number,raw:unknown){
 uuid.parse(id);
 return withPerformanceTenant(ctx,async tx=>{
  const [e]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,id)).for('update');
  if(!e||e.authorUserId!==ctx.userId)throw Error('Edit only evidence you wrote.');revision(e.revision,expected);if(e.state!=='draft')throw Error('Shared evidence cannot be edited. Add a correction instead.');
  const r=await loadReview(tx,e.reviewId);if(!r.cycle.policy.modules.evidence)throw Error('Evidence is disabled.');
  const next=patchEvidenceFields({kind:e.kind as z.infer<typeof evidenceFieldsSchema>['kind'],body:e.body,occurredOn:e.occurredOn,...evidenceDetailsSchema.parse(e.details)},raw),{kind,body,occurredOn,...details}=next;
  await tx.update(onehrEvidence).set({kind,body,occurredOn,details,revision:e.revision+1}).where(eq(onehrEvidence.id,id));await audit(tx,ctx,id,'evidence-draft-edited',{previous:{kind:e.kind,body:e.body,occurredOn:e.occurredOn,details:e.details},next});
 });
}
export async function linkAssessmentEvidence(ctx:SessionContext,reviewId:string,id:string,expected:number,raw:unknown,link=true){
 uuid.parse(id);const target=evidenceLinkSchema.parse(raw);z.boolean().parse(link);
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId);if(!r.cycle.policy.modules.evidence||!await isSelf(tx,r.row.employmentId))throw Error('Only the employee may change their evidence links.');
  const [e]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,id)).for('update');if(!e||e.employmentId!==r.row.employmentId||e.state==='retracted')throw Error('Evidence not found.');revision(e.revision,expected);
  await validateEvidenceLinks(r,[target]);const previous=evidenceLinkSchema.array().parse(e.links),exists=previous.some(l=>l.kind===target.kind&&l.id===target.id);
  const links=link?exists?previous:[...previous,target]:previous.filter(l=>l.kind!==target.kind||l.id!==target.id);
  if(links.length>30)throw Error('One evidence item can link to at most 30 assessment items.');
  await tx.update(onehrEvidence).set({links,revision:e.revision+1}).where(eq(onehrEvidence.id,id));await audit(tx,ctx,id,link?'evidence-linked':'evidence-unlinked',{target,reviewId});
 });
}
export async function citeAssessmentEvidence(ctx:SessionContext,reviewId:string,id:string,expected:number,stance:z.infer<typeof evidenceCitationSchema>['stance'],decisionKind:z.infer<typeof evidenceCitationSchema>['decisionKind']){
 uuid.parse(id);const citation=evidenceCitationSchema.parse({userId:ctx.userId,stance,decisionKind,at:new Date().toISOString()});
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId);if(!r.cycle.policy.modules.evidence||!await isSelf(tx,r.row.employmentId)&&!await isManager(tx,reviewId)&&!await isModerator(tx,reviewId))throw Error('This evidence decision is not assigned to you.');
  const [e]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,id)).for('update');if(!e||e.employmentId!==r.row.employmentId||e.state!=='shared')throw Error('Cite only shared evidence.');revision(e.revision,expected);
  const previous=evidenceCitationSchema.array().parse(e.citations),found=previous.some(c=>c.userId===ctx.userId&&c.decisionKind===decisionKind);
  const citations=found?previous.map(c=>c.userId===ctx.userId&&c.decisionKind===decisionKind?citation:c):[...previous,citation];
  await tx.update(onehrEvidence).set({citations,revision:e.revision+1}).where(eq(onehrEvidence.id,id));await audit(tx,ctx,id,'evidence-cited',{previous:previous.find(c=>c.userId===ctx.userId&&c.decisionKind===decisionKind)??null,citation,reviewId});
 });
}
export async function changeOnehrEvidenceState(ctx:SessionContext,id:string,state:'shared'|'retracted') {
  uuid.parse(id);z.enum(['shared','retracted']).parse(state);return withPerformanceTenant(ctx,async tx=>{const [e]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,id)).for('update');if(!e||e.authorUserId!==ctx.userId)throw Error('Only the author may change this evidence.');if(state==='shared'&&e.state!=='draft'||state==='retracted'&&e.state!=='shared')throw Error('This evidence cannot change to that state.');await tx.update(onehrEvidence).set({state,revision:e.revision+1}).where(eq(onehrEvidence.id,id));await audit(tx,ctx,id,`evidence-${state}`);});
}

export async function respondOnehrEvidence(ctx:SessionContext,id:string,stance:'endorse'|'dispute',text:string,activeReviewId?:string) {
 uuid.parse(id);const response=evidenceResponseSchema.parse({userId:ctx.userId,stance,note:text,at:new Date().toISOString()});
 return withPerformanceTenant(ctx,async tx=>{
  const [e]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,id)).for('update');
  if(!e||e.state!=='shared'||e.authorUserId===ctx.userId)throw Error('Respond only to shared evidence from another author.');
  const context=await loadReview(tx,activeReviewId??e.reviewId);if(context.row.employmentId!==e.employmentId||!context.cycle.policy.modules.evidence||!await isSelf(tx,e.employmentId)&&!await isManager(tx,activeReviewId??e.reviewId)&&!await isModerator(tx,activeReviewId??e.reviewId))throw Error('Only the employee or assigned manager may respond.');
  const responses=evidenceResponseSchema.array().parse(e.responses);
  await tx.update(onehrEvidence).set({responses:upsertEvidenceResponse(responses,response),revision:e.revision+1}).where(eq(onehrEvidence.id,id));await audit(tx,ctx,id,'evidence-response-recorded',{previous:responses.filter(r=>r.userId===ctx.userId),next:response});
 });
}

/** Validate the evidence edge while the native file writer remains the only byte-store writer. */
export async function prepareAssessmentEvidenceFileTx(tx:Tx,ctx:SessionContext,reviewId:string,evidenceId:string,fileName:string,sizeBytes:number) {
 uuid.parse(evidenceId);uuid.parse(reviewId);validateEvidenceFile(fileName,sizeBytes);
 const [e]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,evidenceId)).for('update');
 if(!e||e.authorUserId!==ctx.userId||!(e.state==='draft'||e.state==='shared'&&e.kind==='recognition'))throw Error('Attach only to your draft or shared review recognition.');
 const [context]=await tx.select({employmentId:onehrReview.employmentId}).from(onehrReview).where(eq(onehrReview.reviewId,reviewId));
 // The author can keep proof on a historical entry; an unrelated review cannot be used as its context.
 if(reviewId!==e.reviewId&&context?.employmentId!==e.employmentId)throw Error('Evidence does not belong to this assessment.');
 const files=await tx.select({id:performanceAttachment.id}).from(performanceAttachment).where(and(eq(performanceAttachment.evidenceId,evidenceId),isNull(performanceAttachment.removedAt)));
 if(files.length>=evidenceFileLimit)throw Error('An evidence entry can carry up to four files.');
 return {id:e.reviewId,employmentId:e.employmentId,evidenceId,auditSubject:e.state==='shared'};
}
export async function prepareAssessmentKpiFileTx(tx:Tx,ctx:SessionContext,reviewId:string,kpiId:string,fileName:string,sizeBytes:number) {
 uuid.parse(kpiId);const r=await loadReview(tx,reviewId,true);validateEvidenceFile(fileName,sizeBytes);
 if(!r.cycle.policy.modules.evidence||!await isSelf(tx,r.row.employmentId))throw Error('Attach supporting files to your own KPI.');
 if(!['open','calibration'].includes(r.cycle.native.status)||r.row.resultsSubmittedAt||r.native.closedAt)throw Error('The KPI check-in is locked.');
 if(!r.kpis.some(k=>k.id===kpiId&&!k.hrOwned))throw Error('Choose an employee-owned KPI.');
 const [existing]=await tx.select().from(onehrEvidence).where(and(eq(onehrEvidence.employmentId,r.row.employmentId),eq(onehrEvidence.authorUserId,ctx.userId!),eq(onehrEvidence.kind,'recognition'),eq(onehrEvidence.state,'shared'),sql`${onehrEvidence.links} @> ${JSON.stringify([{kind:'kpi',id:kpiId}])}::jsonb`)).orderBy(desc(onehrEvidence.createdAt),desc(onehrEvidence.id)).limit(1);
 let evidenceId=existing?.id;
 if(!evidenceId){const [created]=await tx.insert(onehrEvidence).values({tenantId:ctx.tenantId,employmentId:r.row.employmentId,reviewId,authorUserId:ctx.userId!,kind:'recognition',body:'',occurredOn:todayInKualaLumpur(),state:'shared',details:evidenceDetailsSchema.parse({fileOnly:true}),links:[{kind:'kpi',id:kpiId}]}).returning({id:onehrEvidence.id});evidenceId=created.id;await audit(tx,ctx,reviewId,'file-evidence-created',{evidenceId,kpiId});}
 return prepareAssessmentEvidenceFileTx(tx,ctx,reviewId,evidenceId,fileName,sizeBytes);
}
async function assessmentKpiFilesTx(tx:Tx,reviewId:string) {
 const [row]=await tx.execute<{value:{id:string;tenantId:string;reviewId:string;attachmentId:string;kpiId:string;createdAt:string}[]}>(sql`select app.assessment_kpi_file_links(${reviewId}::uuid) as value`);
 return row?.value??[];
}
export async function removeAssessmentEvidenceFile(ctx:SessionContext,reviewId:string,attachmentId:string) {
 uuid.parse(attachmentId);uuid.parse(reviewId);
 return withPerformanceTenant(ctx,async tx=>{
  await tx.execute(sql`select app.assessment_file_lock_targets(${attachmentId}::uuid)`);
  const [file]=await tx.select().from(performanceAttachment).where(eq(performanceAttachment.id,attachmentId)).for('update');
  if(!file||file.uploadedByUserId!==ctx.userId||!file.evidenceId||file.removedAt)throw Error('Supporting file not found.');
  const [entry]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,file.evidenceId)).for('update');
  if(!entry||entry.authorUserId!==ctx.userId||!(entry.state==='draft'||entry.state==='shared'&&entry.kind==='recognition'))throw Error('Only the author may remove this supporting file.');
  const [context]=await tx.select({employmentId:onehrReview.employmentId}).from(onehrReview).where(eq(onehrReview.reviewId,reviewId));
  if(reviewId!==entry.reviewId&&context?.employmentId!==entry.employmentId)throw Error('Supporting file not found.');
  await tx.execute(sql`select app.assessment_file_remove(${attachmentId}::uuid)`);
  await audit(tx,ctx,entry.reviewId,'evidence-file-removed',{attachmentId,evidenceId:entry.id});
 });
}

/** The existing native attachment writer remains the owner of file storage. */
export async function onehrAttachmentSubjectTx(tx:Tx,reviewId:string) {
 const [configured]=await tx.select().from(onehrReview).where(eq(onehrReview.reviewId,reviewId));if(!configured)return null;
 const r=await loadReview(tx,reviewId);if(!r.cycle.policy.modules.evidence||!await isSelf(tx,r.row.employmentId)&&!await isManager(tx,reviewId))throw Error('Only the employee or assigned manager may attach evidence.');
 return {id:r.row.reviewId,employmentId:r.row.employmentId};
}

type ResultCard={id:string;digest:string|null;frozen:boolean;performanceReleasedAt:string|null;potentialReleasedAt:string|null;talentReleasedAt:string|null;feedbackReleasedAt:string|null;result:Pick<FrozenResult,'performance'|'potential'|'talent'|'performanceSource'|'potentialSource'|'feedback'|'anonymousFeedback'>};
/** Own-person projection returns only expressly released ratings and anonymous feedback. */
export async function getOnehrReview(ctx:SessionContext,reviewId:string) {
  return withPerformanceTenant(ctx,async tx=>{
    uuid.parse(reviewId);const [exists]=await tx.select().from(onehrReview).where(eq(onehrReview.reviewId,reviewId));if(!exists)return null;
    const r=await loadReview(tx,reviewId);const self=await isSelf(tx,r.row.employmentId),manager=!self&&await isManager(tx,reviewId),admin=!self&&await isAdmin(tx,r.row.cycleId),moderator=!self&&!manager&&await isModerator(tx,reviewId);if(!self&&!manager&&!admin&&!moderator)throw Error('Assessment is not assigned to you.');
    const name={name:r.native.name};const moderators=await moderatorChoices(tx,reviewId);
    const [stored]=await tx.select().from(onehrResult).where(eq(onehrResult.reviewId,reviewId));
    const [card]=self||admin?await tx.execute<{value:ResultCard|null}>(sql`select app.onehr_result_card(${reviewId}::uuid) as value`):[];
    const record=self||admin?card?.value:stored?{...stored,frozen:true}:null;
    const result=record?.result as ResultCard['result']|undefined;
    const [participant]=await tx.execute<{ok:boolean}>(sql`select app.assessment_review_participates(${reviewId}::uuid) as ok`);
    const leadership=(manager||admin)&&participant?.ok?await assessment(tx,reviewId,r.cycle.policy):null;
    const planYear=Number(r.cycle.native.periodEnd.slice(0,4))+(r.cycle.policy.kind==='year_end'?1:0);
    const storedPlans=(await tx.select().from(onehrPlan).where(and(eq(onehrPlan.employmentId,r.row.employmentId),eq(onehrPlan.planYear,planYear)))).map(p=>({...p,career:careerSchema.parse(p.career),goals:z.array(goalSchema).parse(p.goals)}));
    const [activePlanCycle]=self?await tx.select({periodEnd:reviewCycle.periodEnd,policy:onehrCycle.policy}).from(onehrReview).innerJoin(reviewCycle,eq(reviewCycle.id,onehrReview.cycleId)).innerJoin(onehrCycle,eq(onehrCycle.cycleId,onehrReview.cycleId)).where(and(eq(onehrReview.employmentId,r.row.employmentId),sql`${reviewCycle.status} in ('open','calibration')`)).orderBy(desc(reviewCycle.periodEnd),asc(onehrReview.reviewId)).limit(1):[];
    const activePlanningYear=activePlanCycle?Number(activePlanCycle.periodEnd.slice(0,4))+(policySchema.parse(activePlanCycle.policy).kind==='year_end'?1:0):null;
    const plans=self?storedPlans.map(p=>personalPlan(p,activePlanningYear)):storedPlans;
    const [careerProfile]=await tx.select().from(assessmentCareerProfile).where(eq(assessmentCareerProfile.employmentId,r.row.employmentId));
    const feedbackReport=result&&(!self||record!.feedbackReleasedAt)?result.feedback:[];
    const choices=manager||admin?await tx.select({id:employment.id,name:person.fullName,code:employment.employeeCode}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(and(sql`not exists(select 1 from employment sub where sub.id=${r.row.employmentId}::uuid and sub.person_id=${person.id})`,sql`(${employment.terminatedOn} is null or ${employment.terminatedOn}>${todayInKualaLumpur()}::date)`)):[];
    const evidence=r.cycle.policy.modules.evidence?await tx.select().from(onehrEvidence).where(and(eq(onehrEvidence.employmentId,r.row.employmentId),sql`${onehrEvidence.state}<>'retracted'`)).orderBy(desc(onehrEvidence.occurredOn),desc(onehrEvidence.id)):[];
    const [evidencePeople]=evidence.length?await tx.execute<{names:Record<string,string>}>(sql`select app.assessment_evidence_people(array[${sql.join(evidence.map(e=>sql`${e.id}::uuid`),sql`, `)}]::uuid[]) as names`):[];
    const attachmentLinks=await assessmentKpiFilesTx(tx,reviewId);
    const attachments=r.cycle.policy.modules.evidence?await tx.select({id:performanceAttachment.id,fileName:performanceAttachment.fileName,sizeBytes:performanceAttachment.sizeBytes,evidenceId:performanceAttachment.evidenceId,canRemove:sql<boolean>`app.assessment_file_removable(${performanceAttachment.id})`}).from(performanceAttachment).where(and(isNull(performanceAttachment.removedAt),sql`(${performanceAttachment.reviewId}=${reviewId}::uuid ${attachmentLinks.length?sql`or ${inArray(performanceAttachment.id,attachmentLinks.map(l=>l.attachmentId))}`:sql``} or ${performanceAttachment.evidenceId} in (select id from performance_onehr_evidence where employment_id=${r.row.employmentId}::uuid))`)).orderBy(asc(performanceAttachment.createdAt),asc(performanceAttachment.id)):[];
    const peers=manager||admin?await tx.select({requestId:onehrPanel.requestId,employmentId:onehrPanel.peerEmploymentId,name:peerFeedbackRequest.peerName,relationship:onehrPanel.relationship,submittedAt:onehrPanel.submittedAt,archivedAt:onehrPanel.archivedAt,resetAt:onehrPanel.resetAt,archiveReason:onehrPanel.archiveReason}).from(onehrPanel).innerJoin(peerFeedbackRequest,eq(peerFeedbackRequest.id,onehrPanel.requestId)).where(and(eq(onehrPanel.reviewId,reviewId),admin?undefined:isNull(onehrPanel.archivedAt))).orderBy(asc(peerFeedbackRequest.peerName),asc(onehrPanel.requestId)):[];
    let aiEnabled=false;if(self||manager){try{aiEnabled=!!await resolveActiveAiConfig(tx,ctx);}catch{/* Manual assessment remains available when AI configuration is unusable. */}}
    const drafts=await tx.select().from(assessmentDraft).where(and(eq(assessmentDraft.reviewId,reviewId),eq(assessmentDraft.actorUserId,ctx.userId!)));
    const kpiLibrary=self&&!r.kpis.some(k=>['proposed','approved'].includes(k.setting))?await availableKpiLibraryTx(tx,r):[];
    const profile=r.cycle.policy.profiles.find(p=>p.id===r.row.profileId)??null;
    const [skillHistory]=self||manager||admin?await tx.execute<{value:{status:string;competencies:Competency[]}[]}>(sql`select app.assessment_skill_history(${reviewId}::uuid) as value`):[];
    const ownDraft=self?drafts.find(d=>d.kind==='competency_self'):null;
    const ownAnswers=ownDraft?assessmentDraftSchema.parse(ownDraft.payload):null;
    const privateSkills=ownAnswers?.kind==='competency_self'?[{status:'pending',competencies:r.competencies.map(c=>({...c,self:ownAnswers.answers[c.id]?.answer??c.self}))}]:[];
    const skills=demonstratedSkills([...(skillHistory?.value??[]),...privateSkills],self);
    const careerChoice=careerProfile?careerSchema.parse(careerProfile.career).selfProfileId:null;
    const mapProfile=careerChoice&&!['roster','assigned'].includes(r.row.profileMatch??'')?r.cycle.policy.profiles.find(p=>p.id===careerChoice&&p.active!==false)??profile:profile;
    const routes=mapProfile?careerRoutes(mapProfile,r.cycle.policy.profiles,skills,r.cycle.policy.careerRoutes??[]):[];
    return {participating:!!participant?.ok,careerProfile:careerProfile?{...careerProfile,career:careerSchema.parse(careerProfile.career)}:null,careerRoutes:routes,profile,profileMatch:r.row.profileMatch,companyId:r.row.companyId,kpiLibrary,drafts:drafts.map(d=>({...d,payload:assessmentDraftSchema.parse(d.payload)})),attachmentLinks,calculatedPerformance:moderator&&!admin?null:scorecard(r.kpis,r.cycle.policy,r.row.companyId,true).band,selfRemark:moderator&&!admin?'':r.row.selfRemark,competencySelfRemark:moderator&&!admin?'':r.row.competencySelfRemark,competencyManagerRemark:moderator&&!admin?'':r.row.competencyManagerRemark,aiEnabled,viewerUserId:ctx.userId,reviewId,name:name?.name??'',cycle:{id:r.cycle.native.id,name:r.cycle.native.name,status:r.cycle.native.status},policy:moderator&&!admin?{...r.cycle.policy,modules:{pm:true,tm:false,idp:r.cycle.policy.modules.idp,evidence:false}}:r.cycle.policy,grade:r.row.grade,revision:r.row.revision,self,manager,planReviewer:manager||moderator,admin,moderator,moderators:self||manager||admin?moderators.map(({id,name})=>({id,name})):[],mechanism:r.cycle.policy.bBands.some(b=>b.companyId===r.row.companyId)?'B' as const:'A' as const,reviewerEmploymentId:r.native.reviewerEmploymentId,canApproveSettingIds:r.kpis.filter(k=>{const next=pendingSettingApprover(k);return next&&r.native.ownEmploymentIds.includes(next)&&moderators.some(m=>m.id===next);}).map(k=>k.id),canModerateIds:r.kpis.filter(k=>{const next=pendingKpiApprover(k);return next&&r.native.ownEmploymentIds.includes(next)&&moderators.some(m=>m.id===next);}).map(k=>k.id),
      kpis:moderator&&!admin?r.kpis.filter(k=>kpiApprovers(k).some(id=>r.native.ownEmploymentIds.includes(id))):r.kpis,competencies:moderator&&!admin?[]:r.competencies,competencyStatus:r.row.competencyStatus,resultsSubmitted:!!r.row.resultsSubmittedAt,managerPerformance:moderator&&!admin?null:r.row.managerPerformance,managerScore:moderator&&!admin||r.row.managerScore==null?null:Number(r.row.managerScore),managerRemark:moderator&&!admin?'':r.row.managerRemark,
      potential:leadership?.potential.band??null,finalized:!!record?.frozen||!!r.native.closedAt||r.cycle.native.status==='closed'||!participant?.ok,result:result?{id:record!.id,digest:record!.digest,interim:!record!.frozen,performance:!self||record!.performanceReleasedAt?result.performance:null,potential:!self||record!.potentialReleasedAt?result.potential:null,talent:!self||record!.talentReleasedAt?result.talent:null,performanceReleased:!!record!.performanceReleasedAt,potentialReleased:!!record!.potentialReleasedAt,talentReleased:!!record!.talentReleasedAt,feedbackReleased:!!record!.feedbackReleasedAt}:null,plans,planYear,feedbackReport,anonymousFeedback:result&&record!.feedbackReleasedAt?result.anonymousFeedback??null:null,evidence:evidence.map(e=>({...e,authorName:evidencePeople?.names[e.authorUserId]??'',files:attachments.filter(a=>a.evidenceId===e.id),details:evidenceDetailsSchema.parse(e.details),links:evidenceLinkSchema.array().parse(e.links),citations:evidenceCitationSchema.array().parse(e.citations).map(c=>({...c,name:evidencePeople?.names[c.userId]??''})),responses:standingResponses(evidenceResponseSchema.array().parse(e.responses)).map(c=>({...c,name:evidencePeople?.names[c.userId]??''}))})),attachments,peers,choices};
  });
}
export async function getOnehrCycle(ctx:SessionContext,cycleId:string) {
  return withPerformanceTenant(ctx,async tx=>{uuid.parse(cycleId);const [config]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));if(!config)return null;await requireAdmin(tx,cycleId);const cycle=await loadCycle(tx,cycleId);
    const reviews=await tx.select({reviewId:onehrReview.reviewId,employmentId:onehrReview.employmentId,revision:onehrReview.revision,kpis:onehrReview.kpis,grade:onehrReview.grade,name:person.fullName,managerPerformance:onehrReview.managerPerformance,frozenId:sql<string|null>`case when ${performanceReview.closedAt} is not null then ${performanceReview.id} end`}).from(onehrReview).innerJoin(employment,eq(employment.id,onehrReview.employmentId)).innerJoin(person,eq(person.id,employment.personId)).innerJoin(performanceReview,eq(performanceReview.id,onehrReview.reviewId)).where(eq(onehrReview.cycleId,cycleId));
    const users=await tx.select({id:appUser.id,name:person.fullName,email:person.primaryEmail}).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(and(isNull(appUser.archivedAt),sql`not app.login_blocked(${appUser.id})`));
    const companies=await tx.select({id:company.id,name:company.legalName}).from(company).where(sql`app.onehr_admin(${company.id})`);
    return {cycle:cycle.native,policy:cycle.policy,revision:config.revision,participants:await assessmentParticipantsTx(tx,cycleId),kpiNames:[...new Set(reviews.flatMap(r=>kpiSchema.array().parse(r.kpis).map(k=>k.title)))].sort(),reviews:reviews.map(({kpis,...r})=>r),users,companies,sessions:await tx.select().from(onehrCalibration).where(eq(onehrCalibration.cycleId,cycleId))};});
}
export async function onehrAssignments(ctx:SessionContext) {
  return withPerformanceTenant(ctx,async tx=>({reviews:await tx.select({id:onehrReview.reviewId,cycle:reviewCycle.name,periodEnd:reviewCycle.periodEnd,name:sql<string>`app.onehr_review_header(${onehrReview.reviewId})->>'name'`}).from(onehrReview).innerJoin(reviewCycle,eq(reviewCycle.id,onehrReview.cycleId)).where(sql`(app.assessment_review_participates(${onehrReview.reviewId}) or ${reviewCycle.status}='closed') and (app.onehr_manager(${onehrReview.reviewId}) or app.onehr_moderator(${onehrReview.reviewId}) or exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id)))`).orderBy(desc(reviewCycle.periodEnd)),sessions:await tx.select({id:onehrCalibration.id,name:onehrCalibration.name,lockedAt:onehrCalibration.lockedAt}).from(onehrCalibration).orderBy(desc(onehrCalibration.createdAt)),feedback:await tx.select({id:onehrPanel.requestId,subject:peerFeedbackRequest.subjectName}).from(onehrPanel).innerJoin(peerFeedbackRequest,eq(peerFeedbackRequest.id,onehrPanel.requestId)).where(and(isNull(onehrPanel.submittedAt),isNull(onehrPanel.archivedAt),sql`app.onehr_feedback_card(${onehrPanel.requestId})->>'closed'='false'`,sql`exists(select 1 from employment e where e.id=${onehrPanel.peerEmploymentId} and app.is_self_person(e.person_id))`))}));
}
/** Rewards consumes this immutable projection under its own transaction and company authorization. */
export async function onehrRewardResultTx(tx:Tx,employmentId:string,year:number,rewardUnitId:string) {
  const [r]=await tx.execute<{value:{id:string;reviewId:string;cycleId:string;digest:string;frozenAt:string;performance:PMBand|null;potential:PotentialBand|null;talent:FrozenResult['talent'];pip:boolean;promotion:boolean;specialReward:boolean;policyDigest:string;confirmedGrade?:string;confirmedTitle?:string;pipReason?:string;promotionReason?:string;specialRewardReason?:string}|null}>(sql`select app.reward_onehr_source(${rewardUnitId}::uuid,${employmentId}::uuid,${year}) as value`);
  return r?.value??null;
}

export async function reassignOnehrReviewer(ctx:SessionContext,reviewId:string,expected:number,reviewerEmploymentId:string) {
 uuid.parse(reviewerEmploymentId);
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId,true);await requireAdmin(tx,r.row.cycleId);revision(r.row.revision,expected);
  if(r.row.managerPerformance||r.kpis.some(k=>k.locked||k.settingApprovals?.length||k.approvalChain?.some(step=>step.at))||r.row.competencyStatus==='reviewed')throw Error('Reassignment is closed after manager assessment begins.');
  const [reviewer]=await tx.select().from(employment).where(eq(employment.id,reviewerEmploymentId));
  const [subject]=await tx.select().from(employment).where(eq(employment.id,r.row.employmentId));
  const [nativeScope]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_report_of(${r.row.employmentId}::uuid,${reviewerEmploymentId}::uuid) or app.heads_department_of(${r.row.employmentId}::uuid,${reviewerEmploymentId}::uuid) as ok`);
  if(!reviewer||!subject||reviewer.personId===subject.personId||!nativeScope?.ok||reviewer.terminatedOn&&reviewer.terminatedOn<=todayInKualaLumpur())throw Error('Choose an active reviewer other than the subject.');
  const [frozen]=await tx.select().from(onehrResult).where(eq(onehrResult.reviewId,reviewId));if(frozen||r.native.closedAt||r.cycle.native.status==='closed')throw Error('Assessment is finalized.');
  await tx.update(performanceReview).set({reviewerEmploymentId}).where(eq(performanceReview.id,reviewId));await touchReview(tx,reviewId,{kpis:r.kpis.map(k=>({...k,moderatorEmploymentId:k.moderatorEmploymentId===r.native.reviewerEmploymentId?reviewerEmploymentId:k.moderatorEmploymentId,approvalChain:k.approvalChain?.map(step=>step.employmentId===r.native.reviewerEmploymentId?{...step,employmentId:reviewerEmploymentId}:step)}))});await audit(tx,ctx,reviewId,'reviewer-reassigned',{reviewerEmploymentId});
 });
}

/** Canonical final labels for native report consumers, with result RLS and module policy unchanged. */
export async function onehrReportResultsTx(tx:Tx,reviewIds:string[]) {
 if(!reviewIds.length)return new Map<string,{performance:PMBand|null;potential:PotentialBand|null;talent:FrozenResult['talent'];id:string;digest:string}>();
 const results=await tx.select().from(onehrResult).where(inArray(onehrResult.reviewId,reviewIds));
 return new Map(results.map(r=>{const f=r.result as FrozenResult;return [r.reviewId,{performance:f.performance,potential:f.potential,talent:f.talent,id:r.id,digest:r.digest}];}));
}

async function clearAssessmentDraftTx(tx:Tx,ctx:SessionContext,reviewId:string,kind:DraftKind,contextId=reviewId) {
  await tx.delete(assessmentDraft).where(and(eq(assessmentDraft.reviewId,reviewId),eq(assessmentDraft.actorUserId,ctx.userId!),eq(assessmentDraft.kind,kind),eq(assessmentDraft.contextId,contextId)));
}

/** Private autosave. It cannot publish results, approve a rating, or become another actor's AI context. */
export async function saveAssessmentDraft(ctx:SessionContext,reviewId:string,expectedReview:number,expectedDraft:number|null,raw:unknown,contextId=reviewId) {
  return withPerformanceTenant(ctx,tx=>saveAssessmentDraftTx(tx,ctx,reviewId,expectedReview,expectedDraft,raw,contextId));
}

export async function saveAssessmentDraftTx(tx:Tx,ctx:SessionContext,reviewId:string,expectedReview:number,expectedDraft:number|null,raw:unknown,contextId=reviewId) {
  uuid.parse(reviewId);uuid.parse(contextId);const payload=assessmentDraftSchema.parse(raw);assertOverallRemark(payload.remark);
  if(!ctx.userId)throw Error('Sign in to save your draft.');
  let reviewRevision=expectedReview;
  if(payload.kind==='feedback'){
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${reviewId},0))`);
    const card=await feedbackCard(tx,contextId);if(card.reviewId!==reviewId)throw Error('Feedback belongs to another assessment.');
    if(card.submitted||card.frozen)throw Error('Feedback is already submitted or finalized.');
    const cycle=await loadCycle(tx,card.cycleId);if(!['open','calibration'].includes(cycle.native.status))throw Error('The cycle is closed.');assertWindow(cycle.policy,'f360');
    if(Object.keys(payload.comments??{}).some(key=>!card.statements.some(s=>s.principle===key)))throw Error('Use only the assigned leadership principles.');
    if(Object.keys(payload.answers).some(id=>!card.statements.some(st=>st.id===id)))throw Error('Use only the assigned feedback statements.');
    reviewRevision=0;
  }else{
    if(contextId!==reviewId)throw Error('Invalid assessment draft context.');
    const r=await loadReview(tx,reviewId,true);
    const cells={results:'pm_results',moderation:'pm_approve',competency_self:'tc_self',competency_manager:'tc_approve'} as const;
    await writable(tx,r,cells[payload.kind],expectedReview,payload.kind==='moderation'?'moderator':payload.kind==='competency_manager'?'manager':'self');
    if(payload.kind==='results'||payload.kind==='moderation'){
      if(!ratedPerformance(r.cycle.policy))throw Error('This cycle does not collect numeric results.');
      if(payload.kind==='results'&&(r.row.resultsSubmittedAt||r.kpis.some(k=>k.setting!=='approved')))throw Error('An approved scorecard awaiting your results is required.');
      if(payload.kind==='moderation'&&(!r.row.resultsSubmittedAt||r.row.managerPerformance))throw Error('Submitted results awaiting moderation are required.');
      if(new Set(payload.lines.map(l=>l.id)).size!==payload.lines.length)throw Error('Duplicate KPI.');
      for(const line of payload.lines){
        const k=r.kpis.find(k=>k.id===line.id);if(!k)throw Error('KPI not found.');
        if(k.hrOwned)throw Error('Company KPI results are filled by HR.');
        if(payload.kind==='moderation'&&(k.locked||!await isModerator(tx,reviewId,k.id)))throw Error('This KPI is not awaiting your moderation.');
      }
    }else{
      if(!r.cycle.policy.modules.tm||!r.competencies.length)throw Error('No competency assessment is assigned.');
      if(payload.kind==='competency_self'?r.row.competencyStatus!=='pending':r.row.competencyStatus!=='submitted')throw Error('Competencies are not awaiting this step.');
      if(Object.keys(payload.answers).some(id=>!r.competencies.some(c=>c.id===id)))throw Error('Use only the assigned competencies.');
    }
  }
  const [prior]=await tx.select().from(assessmentDraft).where(and(eq(assessmentDraft.reviewId,reviewId),eq(assessmentDraft.actorUserId,ctx.userId!),eq(assessmentDraft.kind,payload.kind),eq(assessmentDraft.contextId,contextId))).for('update');
  if(prior)revision(prior.revision,expectedDraft!);else if(expectedDraft!=null)throw Error('This draft changed. Reload before saving.');
  const data={payload,reviewRevision,updatedAt:new Date()};
  const [saved]=prior?await tx.update(assessmentDraft).set({...data,revision:prior.revision+1}).where(eq(assessmentDraft.id,prior.id)).returning():await tx.insert(assessmentDraft).values({...data,tenantId:ctx.tenantId,reviewId,actorUserId:ctx.userId!,contextId,kind:payload.kind}).returning();
  return {revision:saved.revision,updatedAt:saved.updatedAt};
}

/** Attachments retain the kernel's storage and authorization; this link supplies KPI-level provenance. */
export async function linkAssessmentAttachmentTx(tx:Tx,ctx:SessionContext,reviewId:string,attachmentId:string,kpiId:string) {
  uuid.parse(attachmentId);uuid.parse(kpiId);const r=await loadReview(tx,reviewId);
  if(!r.cycle.policy.modules.evidence||!await isSelf(tx,r.row.employmentId)&&!await isManager(tx,reviewId))throw Error('Evidence is not available for this assessment.');
  if(r.row.resultsSubmittedAt)throw Error('KPI evidence links are fixed when results are submitted.');
  if(!r.kpis.some(k=>k.id===kpiId&&!k.hrOwned))throw Error('Choose an employee-owned KPI. Company KPI results do not require employee evidence.');
  const [attachment]=await tx.select({id:performanceAttachment.id,reviewId:performanceAttachment.reviewId,author:performanceAttachment.uploadedByUserId}).from(performanceAttachment).where(eq(performanceAttachment.id,attachmentId));
  if(!attachment||attachment.reviewId!==reviewId||attachment.author!==ctx.userId)throw Error('Choose a file you uploaded to this assessment.');
  await tx.insert(assessmentAttachmentLink).values({tenantId:ctx.tenantId,reviewId,attachmentId,kpiId}).onConflictDoNothing();
  await audit(tx,ctx,reviewId,'kpi-evidence-linked',{attachmentId,kpiId});
}

export type PerformanceWorkspaceItem={key:string;id:string;kind:'review'|'feedback'|'calibration';cycleId:string;cycle:string;periodEnd:string;view:'mine'|'team'|'dept'|'bu'|'bg'|'group';module:'pm'|'tm'|'idp'|'cal';axis?:WorkspaceAxis;state:'open'|'waiting'|'done'|'later';title:string;stage:string;locked:boolean};
/** A worklist projection, not a second workflow state store. Every card derives from current assignments. */
export async function performanceWorkspace(ctx:SessionContext) {
 return withPerformanceTenant(ctx,async tx=>{
  const items:PerformanceWorkspaceItem[]=[];
  const reviews=await tx.select({row:onehrReview,cycle:reviewCycle,policy:onehrCycle.policy,header:sql<{name:string;ownEmploymentIds:string[]}>`app.onehr_review_header(${onehrReview.reviewId})`,self:sql<boolean>`exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`,manager:sql<boolean>`app.onehr_manager(${onehrReview.reviewId})`})
   .from(onehrReview).innerJoin(reviewCycle,eq(reviewCycle.id,onehrReview.cycleId)).innerJoin(onehrCycle,eq(onehrCycle.cycleId,onehrReview.cycleId))
   .where(sql`${reviewCycle.status}<>'closed' and app.assessment_review_participates(${onehrReview.reviewId}) and (app.onehr_manager(${onehrReview.reviewId}) or app.onehr_moderator(${onehrReview.reviewId}) or exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id)))`).orderBy(desc(reviewCycle.periodEnd),asc(onehrReview.reviewId));
  for(const {row,cycle,policy:raw,header,self,manager} of reviews){
   const policy=policySchema.parse(raw),kpis=kpiSchema.array().parse(row.kpis),closed=cycle.status==='closed';
   const base={id:row.reviewId,kind:'review' as const,cycleId:cycle.id,cycle:cycle.name,periodEnd:cycle.periodEnd,view:self?'mine' as const:'team' as const,title:header.name,locked:false};
   let pmState:PerformanceWorkspaceItem['state']='open',pmStage='results';
   if(!kpis.length||kpis.some(k=>['draft','returned'].includes(k.setting))){pmStage='setting';pmState=self?'open':'waiting';}
   else if(kpis.some(k=>k.setting==='proposed')){pmStage='setting';pmState=self?'waiting':kpis.some(k=>header.ownEmploymentIds.includes(pendingSettingApprover(k)??''))?'open':'waiting';}
   else if(policy.kind==='quarterly'){pmStage='checkin';pmState=kpis.every(k=>k.checkIn)?'done':self?'open':'waiting';}
   else if(row.managerPerformance){pmState='done';}
   else if(row.resultsSubmittedAt){pmStage=self?'results':'moderation';pmState=self?'done':'open';}
   else pmState=self?'open':'waiting';
   if(policy.modules.pm)items.push({...base,key:`${row.reviewId}.pm`,module:'pm',stage:pmStage,state:closed?'done':pmState});
   const competencies=competencySchema.array().parse(row.competencies);
   const tcState=closed||row.competencyStatus==='reviewed'?'done':row.competencyStatus==='submitted'?self?'done':'open':self?'open':'waiting';
   if(policy.modules.tm&&competencies.length&&(self||manager))items.push({...base,key:`${row.reviewId}.tm`,module:'tm',stage:'competency',state:tcState});
   if(policy.modules.idp&&policy.kind==='year_end'){
    const year=Number(cycle.periodEnd.slice(0,4))+1;
    const [plan]=await tx.select({status:onehrPlan.status}).from(onehrPlan).where(and(eq(onehrPlan.employmentId,row.employmentId),eq(onehrPlan.planYear,year)));
    const locked=self&&(policy.modules.pm&&['open','waiting'].includes(pmState)||policy.modules.tm&&competencies.length>0&&['open','waiting'].includes(tcState));
    const state=closed||plan?.status==='closed'?'done':locked?'later':plan?.status==='shared'?self?'done':'open':self?'open':'waiting';
    items.push({...base,key:`${row.reviewId}.idp`,module:'idp',stage:'career',state,locked});
   }
  }
  const feedback=await tx.select({panel:onehrPanel,subject:peerFeedbackRequest.subjectName,cycle:reviewCycle}).from(onehrPanel).innerJoin(peerFeedbackRequest,eq(peerFeedbackRequest.id,onehrPanel.requestId)).innerJoin(reviewCycle,eq(reviewCycle.id,sql`(app.onehr_feedback_card(${onehrPanel.requestId})->>'cycleId')::uuid`)).where(and(isNull(onehrPanel.archivedAt),sql`${reviewCycle.status}<>'closed' and app.onehr_feedback_card(${onehrPanel.requestId}) is not null`));
  for(const {panel,subject,cycle} of feedback)items.push({key:panel.requestId,id:panel.requestId,kind:'feedback',cycleId:cycle.id,cycle:cycle.name,periodEnd:cycle.periodEnd,view:'mine',module:'tm',state:panel.submittedAt?'done':'open',title:subject,stage:'feedback',locked:false});
  const sessions=await tx.select({session:onehrCalibration,cycle:reviewCycle,policy:onehrCycle.policy}).from(onehrCalibration).innerJoin(reviewCycle,eq(reviewCycle.id,onehrCalibration.cycleId)).innerJoin(onehrCycle,eq(onehrCycle.cycleId,onehrCalibration.cycleId)).where(sql`coalesce((${onehrCycle.policy}->'modules'->>'calibration')::boolean,true) and ${reviewCycle.status}<>'closed'`).orderBy(desc(reviewCycle.periodEnd),asc(onehrCalibration.id));
  for(const {session,cycle,policy:raw} of sessions){
   const view=session.tier==='hod'?'dept':session.tier==='final'?'group':session.tier as 'bu'|'bg'|'group';
   for(const part of leaderWorkspaceParts(policySchema.parse(raw),session.tier as Tier,session))items.push({key:`${session.id}.${part.stage}`,id:session.id,kind:'calibration',cycleId:cycle.id,cycle:cycle.name,periodEnd:cycle.periodEnd,view,title:session.name,locked:false,...part});
  }
  const bgLeaderCycles=new Set<string>();
  for(const {session} of sessions)if(session.tier==='bg'&&session.reviewerUserIds.includes(ctx.userId!)&&!await isAdmin(tx,session.cycleId))bgLeaderCycles.add(session.cycleId);
  // A BG leader's own assessment is not requested. Mine remains only while they owe a colleague feedback.
  return items.filter(i=>!bgLeaderCycles.has(i.cycleId)||i.view!=='mine'||i.kind==='feedback'&&i.state==='open').sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd)||a.title.localeCompare(b.title)||a.key.localeCompare(b.key));
 });
}

export async function saveAssessmentTalentDecision(ctx:SessionContext,sessionId:string,expected:number,reviewId:string,kind:'pip'|'promotion'|'specialReward'|'nomination',selected:boolean,reason:string,details:{grade?:string;title?:string;talentRevision?:number}={}) {
 uuid.parse(reviewId);z.enum(['pip','promotion','specialReward','nomination']).parse(kind);note.parse(reason);
 const grade=z.string().trim().max(20).parse(details.grade??''),title=z.string().trim().max(120).parse(details.title??'');
 return withPerformanceTenant(ctx,async tx=>{
  const {session,cycle}=await loadCalibration(tx,sessionId,expected);
  if(kind==='specialReward'||kind==='nomination'){if(kind==='nomination'&&session.tier!=='bg')throw Error('Only the BG reviewer can nominate from the Talent Box.');if(!['bu','bg','group','final'].includes(session.tier)||session.lockedAt)throw Error('Special reward pins belong to an open Talent Box.');}
  else if(!['bg','group','final'].includes(session.tier)||!session.lockedAt)throw Error('Lock BG or Group calibration before confirming talent decisions.');
  if(!['open','calibration'].includes(cycle.native.status))throw Error('The cycle is closed.');
  if(kind==='pip'&&session.pipLockedAt||kind==='promotion'&&session.promotionLockedAt)throw Error('Reopen this decision list before changing it.');
  const [entry]=await tx.select().from(onehrCalibrationEntry).where(and(eq(onehrCalibrationEntry.sessionId,sessionId),eq(onehrCalibrationEntry.reviewId,reviewId)));
  if(!entry||await isSelf(tx,entry.employmentId))throw Error('You cannot decide this assessment.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${reviewId},0))`);
  const current=await resolved(tx,reviewId,cycle.policy);if(current.input.finalized)throw Error('Finalized talent decisions are immutable.');
  calibrationWindows(cycle.policy,session.tier as Tier,'both');
  if(kind==='specialReward'||kind==='nomination'){if(entry.lockedAt)throw Error('This business unit is already locked.');assertPrecedingTier(current.rows,session.tier as Tier,session.mode,true,true);}
  const category=talentCategory(z.enum(pmBands).nullable().parse(entry.performance??boxBands(current,session.tier).performance),z.enum(potentialBands).nullable().parse(entry.potential??boxBands(current,session.tier).potential));
  const talent=await talentContext(tx,ctx.tenantId,reviewId,entry.employmentId,cycle.policy);
  if(kind==='promotion'&&!talent.promotionEligible)throw Error('This person has no nomination or qualifying promotion history.');
  if(kind==='pip'&&category!=='PIP/Improvement'||(kind==='specialReward'||kind==='nomination')&&(category==null||category==='PIP/Improvement'))throw Error('This decision is not available for the calibrated talent category.');
  if(kind==='specialReward'&&!selected)reason='';
  await writeTalentAction(tx,sessionId,reviewId,kind,selected,reason,grade,title,details.talentRevision??talent.revision);
  await tx.update(onehrCalibration).set({revision:session.revision+1}).where(eq(onehrCalibration.id,sessionId));
  await audit(tx,ctx,sessionId,'talent-decision-saved',{reviewId,kind,previous:kind==='nomination'?talent.actions.nominations:talent.actions[kind],selected,reason,grade,title});
 });
}
export async function confirmAssessmentTalentList(ctx:SessionContext,sessionId:string,expected:number,kind:'pip'|'promotion',reopen=false,reason='') {
 z.enum(['pip','promotion']).parse(kind);note.parse(reason);
 return withPerformanceTenant(ctx,async tx=>{
  const {session,cycle}=await loadCalibration(tx,sessionId,expected);
  if(!['bg','group','final'].includes(session.tier)||!session.lockedAt)throw Error('Lock calibration before confirming the talent lists.');
  if(!['open','calibration'].includes(cycle.native.status))throw Error('The cycle is closed.');
  const [own]=await tx.execute<{present:boolean}>(sql`select app.onehr_cohort_own(${sessionId}::uuid) as present`);
  if(own?.present)throw Error('A separate reviewer must confirm a list containing your assessment.');
  const prior=kind==='pip'?session.pipLockedAt:session.promotionLockedAt;
  if(reopen?!prior:!!prior)throw Error(reopen?'This list is already open.':'This list is already confirmed.');
  const entries=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId)).orderBy(asc(onehrCalibrationEntry.reviewId));
  if(!entries.length)throw Error('An empty decision list cannot be confirmed.');
  for(const entry of entries){
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${entry.reviewId},0))`);
   if((await resolved(tx,entry.reviewId,cycle.policy)).input.finalized)throw Error('A finalized assessment prevents this list from changing.');
  }
  await tx.update(onehrCalibration).set({...(kind==='pip'?{pipLockedAt:reopen?null:new Date()}:{promotionLockedAt:reopen?null:new Date()}),revision:session.revision+1}).where(eq(onehrCalibration.id,sessionId));
  await audit(tx,ctx,sessionId,reopen?'talent-list-reopened':'talent-list-confirmed',{kind,reason,reviewIds:entries.map(e=>e.reviewId)});
 });
}

/** Used by the native cycle creator so a configured draft and its assessment policy appear atomically. */
export async function configureAssessmentCycleTx(tx:Tx,ctx:SessionContext,cycleId:string) {
 await requireAdmin(tx,cycleId);
 const policy=defaultPolicy(framework);
 await tx.insert(onehrCycle).values({tenantId:ctx.tenantId,cycleId,policy});
 await audit(tx,ctx,cycleId,'policy-configured',{policyDigest:hash(policy)});
}

/** The journey's single human confirmation publishes every assigned moderation draft atomically. */
export async function submitAssessmentModeration(ctx:SessionContext,reviewId:string,expected:number,raw:unknown,overallRemark:string) {
 const lines=z.array(z.object({id:uuid,actual:z.number().finite(),note})).min(1).max(100).parse(raw);note.parse(overallRemark);
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_approve',expected,'moderator');
  if(!r.row.resultsSubmittedAt||r.row.managerPerformance)throw Error('Submitted results awaiting moderation are required.');
  const assigned:KPI[]=[];for(const k of r.kpis)if(!k.locked&&await isModerator(tx,reviewId,k.id))assigned.push(k);
  if(lines.length!==assigned.length||new Set(lines.map(l=>l.id)).size!==lines.length||assigned.some(k=>!lines.some(l=>l.id===k.id)))throw Error('Provide every KPI awaiting your moderation.');
  const now=new Date().toISOString();
  const kpis=r.kpis.map(k=>{
   const line=lines.find(l=>l.id===k.id);if(!line)return k;
   if(line.actual!==k.actual&&!line.note.trim())throw Error('Explain each adjusted KPI result.');
   const chain=k.approvalChain?.length?k.approvalChain:[{employmentId:k.moderatorEmploymentId!,actual:null,remark:'',at:null}];
   const next=chain.findIndex(step=>!step.at);if(next<0)throw Error('This moderation has already been confirmed.');
   const approvalChain=chain.map((step,i)=>i===next?{...step,actual:line.actual,remark:line.note,at:now}:step);
   return {...k,approvalChain,approvedActual:line.actual,moderationRemark:line.note,locked:approvalChain.every(step=>!!step.at)};
  });
  const final=scorecard(kpis,r.cycle.policy,r.row.companyId,true),self=scorecard(kpis,r.cycle.policy,r.row.companyId,false);
  if(final.score!=null&&final.band!==self.band&&!overallRemark.trim())throw Error('Explain why moderation changed the overall performance band.');
  await clearAssessmentDraftTx(tx,ctx,reviewId,'moderation');
  await touchReview(tx,reviewId,{kpis,...(final.score!=null?{managerPerformance:final.band,managerScore:String(final.score),managerRemark:overallRemark}:{})});
  await audit(tx,ctx,reviewId,'moderation-submitted',{kpiIds:lines.map(l=>l.id),complete:final.score!=null});
  await notifyKpiApprovers(tx,ctx,reviewId,kpis,'results');
 });
}

export async function assignAssessmentKpiModerator(ctx:SessionContext,reviewId:string,expected:number,kpiId:string,moderatorEmploymentId:string) {
 uuid.parse(kpiId);uuid.parse(moderatorEmploymentId);
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId,true);await requireAdmin(tx,r.row.cycleId);revision(r.row.revision,expected);
  if(!['open','calibration'].includes(r.cycle.native.status)||r.native.closedAt)throw Error('This cycle is read-only.');
  const k=r.kpis.find(k=>k.id===kpiId);if(!k)throw Error('KPI not found.');
  if(k.locked||k.approvalChain?.some(a=>a.at))throw Error('An acted-on KPI moderator cannot change.');
  const [candidate]=await tx.select().from(employment).where(eq(employment.id,moderatorEmploymentId));
  const [subject]=await tx.select().from(employment).where(eq(employment.id,r.row.employmentId));
  if(!candidate||!subject||candidate.personId===subject.personId||candidate.terminatedOn&&candidate.terminatedOn<=todayInKualaLumpur())throw Error('Choose an active employee other than the subject within your scope.');
  const updated={...k,moderatorEmploymentId,moderatorSource:moderatorEmploymentId===r.native.reviewerEmploymentId?'line' as const:'matrix' as const,approvalChain:[{employmentId:moderatorEmploymentId,actual:null,remark:'',at:null}]};
  await touchReview(tx,reviewId,{kpis:r.kpis.map(item=>item.id===kpiId?updated:item)});
  await audit(tx,ctx,reviewId,'kpi-moderator-assigned',{kpiId,previous:k.moderatorEmploymentId,moderatorEmploymentId});
  await notifyKpiApprovers(tx,ctx,reviewId,[updated],r.row.resultsSubmittedAt?'results':'setting');
 });
}
export async function editAssessmentDevelopmentGoal(ctx:SessionContext,reviewId:string,planId:string,expected:number,goalId:string,raw:unknown) {
 uuid.parse(planId);uuid.parse(goalId);
 const patch=goalSchema.pick({area:true,dueOn:true,onJob:true,fromOthers:true,formalLearning:true,managerComment:true}).parse(raw);if(!patch.area.trim())throw Error('Name the development goal.');
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId);if(!await isManager(tx,reviewId)&&!await isModerator(tx,reviewId)||await isSelf(tx,r.row.employmentId))throw Error('Only the assigned KPI reviewer may edit a shared development goal.');
  if(!r.cycle.policy.modules.idp||!['open','calibration'].includes(r.cycle.native.status))throw Error('Development review is not open.');assertWindow(r.cycle.policy,'idp_review');
  const [plan]=await tx.select().from(onehrPlan).where(eq(onehrPlan.id,planId)).for('update');
  const year=Number(r.cycle.native.periodEnd.slice(0,4))+(r.cycle.policy.kind==='year_end'?1:0);
  if(!plan||plan.employmentId!==r.row.employmentId||plan.planYear!==year)throw Error('This plan does not belong to this review.');
  revision(plan.revision,expected);if(plan.status!=='shared')throw Error('Only shared, open development plans can be edited.');
  const goals=goalSchema.array().parse(plan.goals),previous=goals.find(g=>g.id===goalId);if(!previous)throw Error('Goal not found.');
  const [editor]=await tx.select({name:person.fullName}).from(appUser).innerJoin(person,eq(person.id,appUser.personId)).where(eq(appUser.id,ctx.userId!));
  const next={...previous,...patch,editedByName:editor?.name??'',editedAt:new Date().toISOString()};
  await tx.update(onehrPlan).set({goals:goals.map(g=>g.id===goalId?next:g),revision:plan.revision+1}).where(eq(onehrPlan.id,planId));
  await audit(tx,ctx,planId,'development-goal-reviewed',{reviewId,goalId,previous,next});
 });
}

type AssessmentImportKind='targets'|'library';
/** Preview and commit run the same resolution and validation against the current native roster. */
export async function importAssessmentKpis(ctx:SessionContext,cycleId:string,csv:string,kind:AssessmentImportKind,expectedPreview?:string) {
 z.enum(['targets','library']).parse(kind);const records=assessmentImportRecords(csv);
 return withPerformanceTenant(ctx,async tx=>{
  const cycle=await loadCycle(tx,cycleId,true);await requireAdmin(tx,cycleId);
  if(cycle.native.status==='closed'||!cycle.policy.modules.pm)throw Error('KPI configuration is not open for this cycle.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:performance-kpi-import`},0))`);
  const companies=await tx.select({id:company.id,name:company.legalName}).from(company).where(sql`app.onehr_admin(${company.id})`).orderBy(asc(company.id));
  const departments=await tx.select({id:department.id,name:department.name,companyId:department.companyId}).from(department).where(isNull(department.archivedAt));
  const employees=await tx.select({id:employment.id,personId:employment.personId,code:employment.employeeCode,companyId:employment.companyId,terminatedOn:employment.terminatedOn}).from(employment).orderBy(asc(employment.id));
  const reviews=await tx.select({row:onehrReview,reviewerEmploymentId:performanceReview.reviewerEmploymentId,closedAt:performanceReview.closedAt}).from(onehrReview).innerJoin(performanceReview,eq(performanceReview.id,onehrReview.reviewId)).where(and(eq(onehrReview.cycleId,cycleId),sql`app.assessment_review_participates(${onehrReview.reviewId})`));
  const library=kind==='library'?await tx.select().from(performanceKpiLibrary).orderBy(asc(performanceKpiLibrary.id)):[];
  const errors:string[]=[],seen=new Set<string>();
  const targets=new Map<string,{row:typeof onehrReview.$inferSelect;kpis:KPI[]}>();
  const catalogue:{existing:typeof performanceKpiLibrary.$inferSelect|undefined;data:typeof performanceKpiLibrary.$inferInsert}[]=[];
  const preview:{row:number;subject:string;title:string;action:'create'|'update'|'skip';note:string}[]=[];
  function resolveName<T extends {id:string;name:string}>(items:T[],value:string,label:string):T {
   const matches=items.filter(i=>i.id===value||i.name.toLowerCase()===value.toLowerCase());
   if(matches.length!==1)throw Error(`${label} must identify exactly one native record in your scope: ${value}.`);return matches[0];
  }
  function resolveEmployee(value:string){
   const matches=employees.filter(e=>e.id===value||e.code===value);
   if(matches.length!==1)throw Error(`Employee ID must identify exactly one employment in your scope: ${value}.`);return matches[0];
  }
  for(const [index,record] of records.entries()){
   try{
    if(kind==='targets'){
     const employee=resolveEmployee(importValue(record,'Employee ID','eid','id','staff id'));
     const review=reviews.find(r=>r.row.employmentId===employee.id);
     const title=importValue(record,'KPI','KPI name');
     if(!review){preview.push({row:index+2,subject:employee.code??employee.id,title,action:'skip',note:'Not a participant in this cycle.'});continue;}
     if(review.closedAt)throw Error('A finalized assessment cannot be changed.');
     const key=`${review.row.reviewId}:${title}`;if(seen.has(key))throw Error('This employee and KPI occur more than once.');seen.add(key);
     const config=cycle.policy.bBands.find(b=>b.companyId===review.row.companyId);
     const definition=importKpiDefinition(record,config?'B':'A',config?.variant??'base');
     const current=targets.get(review.row.reviewId)??{row:review.row,kpis:kpiSchema.array().parse(review.row.kpis)};
     const previous=current.kpis.find(k=>k.title===definition.title);
     if(previous?.locked||previous?.approvalChain?.some(a=>a.at)){preview.push({row:index+2,subject:employee.code??employee.id,title,action:'skip',note:'A moderator has already acted on this KPI.'});continue;}
     const matrix=importValue(record,'Matrix manager ID','Matrix manager employee id','matrix manager');
     const candidate=matrix?resolveEmployee(matrix):employees.find(e=>e.id===review.reviewerEmploymentId);
     if(matrix&&candidate&&(candidate.personId===employee.personId||candidate.terminatedOn&&candidate.terminatedOn<=todayInKualaLumpur()))throw Error('A matrix manager must be an active person other than the subject.');
     const moderatorEmploymentId=candidate&&candidate.personId!==employee.personId&&(!candidate.terminatedOn||candidate.terminatedOn>todayInKualaLumpur())?candidate.id:null;
     const next=kpiSchema.parse({...previous,id:previous?.id??randomUUID(),title:definition.title,category:definition.category,description:definition.description,weightBp:definition.weightBp,unit:definition.unit,scoring:definition.scoring,moderatorEmploymentId,moderatorSource:matrix?'matrix':'line',approvalChain:moderatorEmploymentId?[{employmentId:moderatorEmploymentId,actual:null,remark:'',at:null}]:[],setting:'approved',settingApprovals:[],settingRemark:'Agreed offline; imported by HR.',actual:previous?.actual??null,note:previous?.note??'',approvedActual:null,moderationRemark:'',locked:false});
     current.kpis=previous?current.kpis.map(k=>k.id===previous.id?next:k):[...current.kpis,next];targets.set(review.row.reviewId,current);
     preview.push({row:index+2,subject:employee.code??employee.id,title,action:previous?'update':'create',note:moderatorEmploymentId?'':'No moderator resolved. HR must assign one.'});
    }else{
     const groupValue=importValue(record,'Business Group','bg');
     const group=groupValue&&groupValue!=='*'?resolveName(companies,groupValue,'Business Group'):null;
     const companyValue=importValue(record,'Company','bu');
     const scope=companyValue&&companyValue!=='*'?resolveName(companies,companyValue,'Company'):null;
     if(!group&&!scope)throw Error('Specify a native Business Group or Company scope.');
     if(group&&scope){const [inside]=await tx.execute<{ok:boolean}>(sql`select app.is_company_descendant(${scope.id}::uuid,${group.id}::uuid) as ok`);if(!inside?.ok)throw Error('The company is outside the selected group.');}
     const deptValue=importValue(record,'Department','dept');
     const dept=deptValue&&deptValue!=='*'?resolveName(departments.filter(d=>!scope||d.companyId===scope.id),deptValue,'Department'):null;
     if(dept&&group){const [inside]=await tx.execute<{ok:boolean}>(sql`select app.is_company_descendant(${dept.companyId}::uuid,${group.id}::uuid) as ok`);if(!inside?.ok)throw Error('The department is outside the selected group.');}
     const tier=z.number().int().min(0).max(4).parse(Number(importValue(record,'Tier','Tier band','tier_n')||0));
     const grade=importValue(record,'Job Grade','jg').replace(/^JG\s*/i,'');const grades=grade&&grade!=='*'?[grade]:[],departmentIds=dept?[dept.id]:[];
     const config=cycle.policy.bBands.find(b=>b.companyId===(scope?.id??group?.id));
     const template=importKpiDefinition(record,config?'B':'A',config?.variant??'base',true);
     const key=JSON.stringify([group?.id??null,scope?.id??null,departmentIds,tier,grades,template.title]);if(seen.has(key))throw Error('This library scope and KPI occur more than once.');seen.add(key);
     const existing=library.find(l=>l.groupCompanyId===(group?.id??null)&&l.companyId===(scope?.id??null)&&l.tier===tier&&JSON.stringify(l.grades)===JSON.stringify(grades)&&JSON.stringify(l.departmentIds)===JSON.stringify(departmentIds)&&l.name===template.title);
     catalogue.push({existing,data:{tenantId:ctx.tenantId,companyId:scope?.id??null,groupCompanyId:group?.id??null,tier,grades,departmentIds,name:template.title,description:template.description,template,archivedAt:null}});
     preview.push({row:index+2,subject:scope?.name??group!.name,title:template.title,action:existing?'update':'create',note:''});
    }
   }catch(error){errors.push(`Row ${index+2}: ${error instanceof z.ZodError?error.issues.map(i=>i.message).join('; '):error instanceof Error?error.message:'Invalid row.'}`);}
  }
  // IDs for new KPI lines are generated at commit; the preview token closes over data and current revisions.
  const token=hash({cycleRevision:cycle.config.revision,csv,kind,preview,targets:[...targets].map(([id,r])=>({id,revision:r.row.revision})),catalogue:catalogue.map(r=>({data:r.data,id:r.existing?.id,revision:r.existing?.revision}))});
  const result={preview,errors,token,created:preview.filter(p=>p.action==='create').length,updated:preview.filter(p=>p.action==='update').length,skipped:preview.filter(p=>p.action==='skip').length,applied:false};
  if(expectedPreview===undefined)return result;
  if(errors.length)throw Error(`Import rejected; no changes applied. ${errors.slice(0,10).join(' ')}`);
  if(expectedPreview!==token)throw Error('The roster, catalogue or cycle changed. Preview this import again.');
  for(const [reviewId,target] of targets){
   const current=await loadReview(tx,reviewId,true);revision(current.row.revision,target.row.revision);
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${reviewId},0))`);
   if(current.native.closedAt)throw Error('An assessment was finalized. Preview the import again.');
   await touchReview(tx,reviewId,{kpis:target.kpis});
   await audit(tx,ctx,reviewId,'kpis-imported',{previous:current.kpis,next:target.kpis});
  }
  for(const row of catalogue){
   if(row.existing)await tx.update(performanceKpiLibrary).set({...row.data,revision:row.existing.revision+1}).where(eq(performanceKpiLibrary.id,row.existing.id));
   else await tx.insert(performanceKpiLibrary).values(row.data);
  }
  await audit(tx,ctx,cycleId,kind==='targets'?'kpi-import-completed':'kpi-library-imported',{created:result.created,updated:result.updated,skipped:result.skipped});
  return {...result,applied:true};
 });
}

async function availableKpiLibraryTx(tx:Tx,r:Awaited<ReturnType<typeof loadReview>>) {
 const grade=r.row.grade.replace(/^JG\s*/i,''),n=Number(grade),index=r.cycle.policy.framework.findIndex(f=>/^\d+$/.test(grade)?n>=f.gradeMin&&n<=f.gradeMax:f.letters.includes(grade)||f.letters.includes('*'));
 const rows=await tx.select().from(performanceKpiLibrary).where(and(isNull(performanceKpiLibrary.archivedAt),
  sql`(${performanceKpiLibrary.companyId} is null or ${performanceKpiLibrary.companyId}=${r.row.companyId}::uuid)`,
  sql`(${performanceKpiLibrary.groupCompanyId} is null or app.is_company_descendant(${r.row.companyId}::uuid,${performanceKpiLibrary.groupCompanyId}))`,
  sql`(cardinality(${performanceKpiLibrary.grades})=0 or ${grade}=any(${performanceKpiLibrary.grades}))`,
  sql`(${performanceKpiLibrary.tier}=0 or ${performanceKpiLibrary.tier}=${index+1})`,
  sql`(cardinality(${performanceKpiLibrary.departmentIds})=0 or exists(select 1 from assignment a where a.employment_id=${r.row.employmentId}::uuid and a.department_id=any(${performanceKpiLibrary.departmentIds}) and a.valid_from<=${todayInKualaLumpur()}::date and (a.valid_to is null or a.valid_to>${todayInKualaLumpur()}::date) and a.superseded_at is null))`,
 )).orderBy(asc(performanceKpiLibrary.name),asc(performanceKpiLibrary.id));
 const mechanism=r.cycle.policy.bBands.some(b=>b.companyId===r.row.companyId)?'B':'A';
 return rows.map(row=>({id:row.id,revision:row.revision,...kpiLibraryTemplateSchema.parse(row.template)})).filter(row=>row.scoring.mechanism===mechanism);
}

/** HR fills one shared company KPI. Acted-on lines are reported and never overwritten. */
export async function fillAssessmentCompanyKpi(ctx:SessionContext,cycleId:string,raw:unknown,expectedPreview?:string) {
 const input=z.object({companyId:uuid.nullable(),title:z.string().trim().min(1).max(300),actual:z.number().finite(),note}).parse(raw);
 return withPerformanceTenant(ctx,async tx=>{
  const cycle=await loadCycle(tx,cycleId,true);await requireAdmin(tx,cycleId);
  if(!['open','calibration'].includes(cycle.native.status)||!ratedPerformance(cycle.policy))throw Error('Company KPI results require an open performance results cycle.');
  if(input.companyId){const [scope]=await tx.execute<{ok:boolean}>(sql`select app.onehr_admin(${input.companyId}::uuid) as ok`);if(!scope?.ok)throw Error('Company outside your scope.');}
  const rows=await tx.select().from(onehrReview).where(and(eq(onehrReview.cycleId,cycleId),sql`app.assessment_review_participates(${onehrReview.reviewId})`,input.companyId?eq(onehrReview.companyId,input.companyId):undefined)).orderBy(asc(onehrReview.reviewId)).for('update');
  const preview:{reviewId:string;kpiId:string;employee:string;action:'fill'|'skip';reason:string}[]=[],changes:{row:typeof onehrReview.$inferSelect;kpis:KPI[]}[]=[];
  for(const row of rows){
   const kpis=kpiSchema.array().parse(row.kpis);if(!kpis.some(k=>k.title===input.title))continue;
   const review=await loadReview(tx,row.reviewId);let changed=false;
   const next=kpis.map(k=>{
    if(k.title!==input.title)return k;
    const reason=review.native.closedAt?'Finalized assessment.':k.locked?'KPI is already locked.':k.approvalChain?.some(a=>a.at)?'A moderator has already acted.':'';
    preview.push({reviewId:row.reviewId,kpiId:k.id,employee:review.native.name,action:reason?'skip':'fill',reason});
    if(reason)return k;changed=true;
    return {...k,hrOwned:true,actual:input.actual,approvedActual:input.actual,note:input.note,moderationRemark:input.note,locked:true,setting:'approved' as const};
   });
   if(changed)changes.push({row,kpis:next});
  }
  if(!preview.length)throw Error('No matching KPI lines were found in this cycle and company scope.');
  const token=hash({input,cycleRevision:cycle.config.revision,preview,revisions:changes.map(c=>[c.row.reviewId,c.row.revision])});
  if(expectedPreview===undefined)return {preview,token,applied:false};
  if(expectedPreview!==token)throw Error('The assessments changed. Preview the company KPI fill again.');
  for(const {row,kpis} of changes){
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${row.reviewId},0))`);
   const final=scorecard(kpis,cycle.policy,row.companyId,true);
   await touchReview(tx,row.reviewId,{kpis,...(row.resultsSubmittedAt&&final.score!=null?{managerPerformance:final.band,managerScore:String(final.score)}:{})});
   await audit(tx,ctx,row.reviewId,'company-kpi-filled',{title:input.title,actual:input.actual,note:input.note,previous:row.kpis,next:kpis});
  }
  return {preview,token,applied:true};
 });
}

/** HR may correct an unstarted profile; neither submitted answers nor a private saved answer is discarded. */
export async function assignAssessmentProfile(ctx:SessionContext,reviewId:string,expected:number,profileId:string) {
 uuid.parse(profileId);
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId,true);await requireAdmin(tx,r.row.cycleId);revision(r.row.revision,expected);
  if(await isSelf(tx,r.row.employmentId))throw Error('Ask another administrator to assign your competency profile.');
  if(!r.cycle.policy.modules.tm||!['open','calibration'].includes(r.cycle.native.status))throw Error('Open a cycle with competency assessment enabled.');
  const [started]=await tx.execute<{yes:boolean}>(sql`select app.assessment_competency_started(${reviewId}::uuid) as yes`);
  if(started?.yes)throw Error('This competency assessment has started. Preserve the existing answers and assignments.');
  const profile=r.cycle.policy.profiles.find(p=>p.id===profileId&&p.active!==false&&(p.companyId==null||p.companyId===r.row.companyId));
  if(!profile)throw Error('Choose an available profile for this company.');
  const competencies=technicalProfilePlan(profile,r.cycle.policy.skills??[]).map(s=>({...s,self:null,manager:null,selfRemark:'',managerRemark:''}));
  await touchReview(tx,reviewId,{competencies,profileId,profileMatch:'assigned'});
  await audit(tx,ctx,reviewId,'competency-profile-assigned',{previousProfileId:r.row.profileId,profileId,statements:competencies.map(s=>s.id)});
 });
}
