import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { appUser, company, employment, jobGrade, person, reviewCycle, performanceReview, peerFeedbackRequest, onehrCycle, onehrReview, onehrPanel, onehrCalibration, onehrCalibrationEntry, onehrPlan, onehrEvidence, onehrResult, performanceAttachment } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { resolveActiveAiConfig } from '../../../core/ai-config';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import framework from './framework.json';
import { assertWindow, kpiApprovers, pendingKpiApprover, bandFor, evidenceResponseSchema, careerSchema, competencySchema, defaultPolicy, frameworkFor, goalSchema, kpiSchema, pmBands, policySchema, potential, potentialBands, referenceCurve, resolveBand, scoreAnswers, scorecard, talentCategory, tiers, validateScorecard, type Competency, type FrozenResult, type KPI, type PMBand, type Policy, type PotentialBand, type Statement, type Tier, type WindowCell } from './model';

const uuid = z.uuid();
const note = z.string().trim().max(4000);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function revision(actual: number, expected: number) { if (!Number.isInteger(expected) || actual !== expected) throw Error('This record changed. Reload before saving.'); }
async function audit(tx: Tx, ctx: SessionContext, id: string, event: string, payload: Record<string, unknown> = {}) {
  // Subject-scoped events are readable by the employee. Panel counts and calibration details stay admin-only.
  const subjectScoped=['scorecard-proposed','scorecard-approved','scorecard-returned','results-submitted','competencies-submitted','plan-shared','plan-reviewed','plan-closed','result-released','result-revoked'].includes(event);
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
  if (!r) throw Error('OneHR cycle not found.');
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
async function isModerator(tx:Tx,id:string,kpiId?:string){const [r]=await tx.execute<{ok:boolean}>(sql`select app.onehr_moderator(${id}::uuid,${kpiId??null}::uuid) as ok`);return !!r?.ok;}

async function writable(tx: Tx, r: Awaited<ReturnType<typeof loadReview>>, cell: WindowCell, expected: number, actor: 'self'|'manager'|'either'|'moderator') {
  revision(r.row.revision,expected);
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
export async function initializeOnehrCycleTx(tx: Tx, ctx: SessionContext, cycleId: string) {
  const [configured]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));
  if (!configured) return;
  await requireAdmin(tx,cycleId);
  const policy=policySchema.parse(configured.policy);
  const reviews=await tx.select({id:performanceReview.id,employmentId:employment.id,companyId:employment.companyId,grade:jobGrade.code}).from(performanceReview).innerJoin(employment,eq(employment.id,performanceReview.employmentId)).leftJoin(jobGrade,eq(jobGrade.id,employment.gradeId)).where(eq(performanceReview.cycleId,cycleId));
  for (const r of reviews) {
    const grade=(r.grade??'').replace(/^JG\s*/i,'').trim();
    const available=policy.profiles.filter(p=>p.grade===grade&&(p.companyId==null||p.companyId===r.companyId));
    const assigned=available.filter(p=>p.employmentIds?.includes(r.employmentId));
    const profiles=assigned.length?assigned:available.filter(p=>!p.employmentIds?.length);
    if (profiles.length>1) throw Error('Assign exactly one competency profile per company and grade.');
    const statements=policy.modules.tm?frameworkFor(policy,grade):[];
    const competencies:Competency[]=(profiles[0]?.competencies??[]).map(s=>({...s,self:null,manager:null,managerRemark:''}));
    await tx.insert(onehrReview).values({tenantId:ctx.tenantId,reviewId:r.id,cycleId,employmentId:r.employmentId,companyId:r.companyId,grade,statements,competencies});
  }
}
export async function assertStandardCycleTx(tx:Tx,cycleId:string) {
  const [r]=await tx.select({id:onehrCycle.cycleId}).from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));
  if(r)throw Error('Use the OneHR workflow for this cycle.');
}
export async function assertOnehrClosureTx(tx:Tx,cycleId:string) {
  const [configured]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));if(!configured)return;
  const [missing]=await tx.select({id:onehrReview.reviewId}).from(onehrReview).innerJoin(performanceReview,eq(performanceReview.id,onehrReview.reviewId)).where(and(eq(onehrReview.cycleId,cycleId),isNull(performanceReview.closedAt))).limit(1);
  if(missing)throw Error('Finalize every assessment before closing this cycle.');
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

/** Whole-scorecard setting. Client state cannot set approval, moderation or results. */
export async function saveOnehrKpis(ctx:SessionContext,reviewId:string,expected:number,raw:unknown,propose=false) {
  const inputs=z.array(kpiSchema.pick({id:true,title:true,description:true,weightBp:true,unit:true,scoring:true,moderatorEmploymentId:true}).extend({approverEmploymentIds:z.array(uuid).min(1).max(10).optional()})).max(100).parse(raw);
  if(new Set(inputs.map(k=>k.id)).size!==inputs.length)throw Error('Duplicate KPI.');
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_setting',expected,'self');if(!r.cycle.policy.modules.pm)throw Error('Performance assessment is disabled.');
    if(r.kpis.some(k=>k.setting==='approved'||k.setting==='proposed'))throw Error('The scorecard is already proposed or approved.');
    const moderators=await moderatorChoices(tx,reviewId);
    if(inputs.some(k=>(k.approverEmploymentIds??[k.moderatorEmploymentId]).some(id=>!moderators.some(m=>m.id===id))))throw Error('Choose the assigned reviewer or a current native matrix manager as KPI moderator.');
    if(inputs.some(k=>{const people=(k.approverEmploymentIds??[k.moderatorEmploymentId]).map(id=>moderators.find(m=>m.id===id)?.personId);return new Set(people).size!==people.length;}))throw Error('Choose each approver once in a KPI chain.');
    const kpis:KPI[]=inputs.map(k=>({...k,moderatorEmploymentId:k.approverEmploymentIds?.[0]??k.moderatorEmploymentId,approvalChain:(k.approverEmploymentIds??[k.moderatorEmploymentId!]).map(employmentId=>({employmentId,actual:null,remark:'',at:null})),setting:propose?'proposed':'draft',settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false}));
    const mechanism=r.cycle.policy.bBands.some(b=>b.companyId===r.row.companyId)?'B':'A';
    if(kpis.some(k=>k.scoring.mechanism!==mechanism))throw Error('Use the scoring mechanism configured for this company.');
    if(propose)validateScorecard(kpis);
    await touchReview(tx,reviewId,{kpis});await audit(tx,ctx,reviewId,propose?'scorecard-proposed':'scorecard-saved');
  });
}
export async function approveOnehrScorecard(ctx:SessionContext,reviewId:string,expected:number,approve:boolean,remark:string) {
  note.parse(remark);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_setting_approve',expected,'manager');
    if(!r.kpis.length||r.kpis.some(k=>k.setting!=='proposed'))throw Error('The employee must propose the whole scorecard.');
    if(!approve&&!remark.trim())throw Error('Explain what needs changing.');validateScorecard(r.kpis);
    await touchReview(tx,reviewId,{kpis:r.kpis.map(k=>({...k,setting:approve?'approved':'returned',settingRemark:remark}))});await audit(tx,ctx,reviewId,approve?'scorecard-approved':'scorecard-returned',{reason:remark});
  });
}
export async function submitOnehrResults(ctx:SessionContext,reviewId:string,expected:number,raw:unknown) {
  const inputs=z.array(z.object({id:uuid,actual:z.number().finite(),note})).parse(raw);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_results',expected,'self');
    if(r.row.resultsSubmittedAt||!r.kpis.length||r.kpis.some(k=>k.setting!=='approved'))throw Error('An approved scorecard is required and results can be submitted once.');
    if(inputs.length!==r.kpis.length||new Set(inputs.map(k=>k.id)).size!==inputs.length||r.kpis.some(k=>!inputs.some(i=>i.id===k.id)))throw Error('Provide every KPI result.');
    const kpis=r.kpis.map(k=>({...k,...inputs.find(i=>i.id===k.id)!}));scorecard(kpis,r.cycle.policy,r.row.companyId,false);
    await touchReview(tx,reviewId,{kpis,resultsSubmittedAt:new Date()});await audit(tx,ctx,reviewId,'results-submitted');
  });
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
    await touchReview(tx,reviewId,{kpis});await audit(tx,ctx,reviewId,'kpi-moderated',{kpiId});
  });
}
export async function confirmOnehrPerformance(ctx:SessionContext,reviewId:string,expected:number,band:PMBand,remark:string) {
  z.enum(pmBands).parse(band);note.parse(remark);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'pm_approve',expected,'manager');
    const calculated=scorecard(r.kpis,r.cycle.policy,r.row.companyId,true);if(calculated.score==null)throw Error('Moderate every KPI before confirming the assessment.');
    if(band!==calculated.band&&!remark.trim())throw Error('Explain the overall band adjustment.');
    if(r.row.managerPerformance)throw Error('Manager assessment is already confirmed.');
    await touchReview(tx,reviewId,{managerPerformance:band,managerScore:String(calculated.score),managerRemark:remark});await audit(tx,ctx,reviewId,'performance-confirmed');
  });
}
export async function submitOnehrCompetencies(ctx:SessionContext,reviewId:string,expected:number,raw:unknown,manager=false) {
  const answers=z.record(z.string(),z.object({answer:z.enum(['yes','no']),remark:note.default('')})).parse(raw);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,manager?'tc_approve':'tc_self',expected,manager?'manager':'self');
    if(!r.cycle.policy.modules.tm||!r.competencies.length)throw Error('No technical competency profile is assigned.');
    if(manager?r.row.competencyStatus!=='submitted':r.row.competencyStatus!=='pending')throw Error('Competencies are not awaiting this step.');
    if(Object.keys(answers).length!==r.competencies.length||r.competencies.some(c=>!answers[c.id]))throw Error('Answer every competency.');
    const competencies=r.competencies.map(c=>{const a=answers[c.id];if(manager&&a.answer!==c.self&&!a.remark.trim())throw Error('Explain changed competency answers.');return manager?{...c,manager:a.answer,managerRemark:a.remark}:{...c,self:a.answer};});
    await touchReview(tx,reviewId,{competencies,competencyStatus:manager?'reviewed':'submitted'});await audit(tx,ctx,reviewId,manager?'competencies-reviewed':'competencies-submitted');
  });
}
export async function assignOnehrPanel(ctx:SessionContext,reviewId:string,expected:number,raw:unknown) {
  const inputs=z.array(z.object({employmentId:uuid,relationship:z.enum(['line_manager','matrix_manager','peer','direct_report'])})).min(1).max(30).parse(raw);
  if(new Set(inputs.map(i=>i.employmentId)).size!==inputs.length)throw Error('A panel cannot contain the same reviewer twice.');
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId,true);await writable(tx,r,'f360',expected,'manager');if(!r.cycle.policy.modules.tm)throw Error('Talent assessment is disabled.');
    const prior=await tx.select().from(onehrPanel).where(eq(onehrPanel.reviewId,reviewId));
    const omitted=prior.filter(p=>!p.archivedAt&&!inputs.some(i=>i.employmentId===p.peerEmploymentId));
    if(omitted.some(p=>p.submittedAt))throw Error('Submitted reviewers must remain on the panel.');
    const [subject]=await tx.select({name:person.fullName,personId:person.id}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(eq(employment.id,r.row.employmentId));
    if(!subject)throw Error('Subject not available.');
    if(/^[a-z]+$/i.test(r.row.grade)?inputs.length!==1:inputs.length<r.cycle.policy.minValid)throw Error('The panel is smaller than the required valid response count.');
    const peerPeople=new Set<string>();
    for(const input of inputs){
      const [peer]=await tx.select({id:employment.id,personId:employment.personId,name:person.fullName,grade:jobGrade.code}).from(employment).innerJoin(person,eq(person.id,employment.personId)).leftJoin(jobGrade,eq(jobGrade.id,employment.gradeId)).where(and(eq(employment.id,input.employmentId),sql`(${employment.terminatedOn} is null or ${employment.terminatedOn}>${todayInKualaLumpur()}::date)`));
      if(!peer||peer.personId===subject.personId||peerPeople.has(peer.personId)||!/^\d+$/.test((peer.grade??'').replace(/^JG\s*/i,'')))throw Error('Choose distinct active reviewers with numeric job grades, other than the subject.');
      peerPeople.add(peer.personId);
      if(input.relationship==='line_manager'&&peer.id!==r.native.reviewerEmploymentId)throw Error('The line manager must be the assigned manager.');
      if(input.relationship==='matrix_manager'&&!(await moderatorChoices(tx,reviewId)).some(m=>m.id===peer.id&&m.id!==r.native.reviewerEmploymentId))throw Error('Choose a current matrix manager.');
      if(input.relationship==='direct_report'){const [edge]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_report_of(${peer.id}::uuid,${r.row.employmentId}::uuid) as ok`);if(!edge?.ok)throw Error('Choose a current report of the subject.');}
      if(!/^\d+$/.test(r.row.grade)&&(inputs.length!==1||peer.id!==r.native.reviewerEmploymentId||input.relationship!=='line_manager'))throw Error('A letter-grade subject is assessed only by their line manager.');
      const existing=prior.find(p=>p.peerEmploymentId===peer.id);
      if(existing){if(existing.submittedAt){if(existing.relationship!==input.relationship)throw Error('A submitted reviewer relationship is immutable.');continue;}
       await tx.update(onehrPanel).set({archivedAt:null,relationship:input.relationship}).where(eq(onehrPanel.requestId,existing.requestId));
       await tx.update(peerFeedbackRequest).set({status:'pending'}).where(eq(peerFeedbackRequest.id,existing.requestId));continue;
      }
      const [request]=await tx.insert(peerFeedbackRequest).values({tenantId:ctx.tenantId,reviewId,subjectEmploymentId:r.row.employmentId,peerEmploymentId:peer.id,subjectName:subject.name,peerName:peer.name,cycleName:r.cycle.native.name,requestedByUserId:ctx.userId}).returning();
      await tx.insert(onehrPanel).values({tenantId:ctx.tenantId,requestId:request.id,reviewId,subjectEmploymentId:r.row.employmentId,peerEmploymentId:peer.id,relationship:input.relationship});
      await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'peer-feedback-request',aggregateId:request.id,eventType:'peer-feedback-request.created',actor:actorOf(ctx),payload:{reviewId}});
    }
    for(const p of omitted){await tx.update(onehrPanel).set({archivedAt:new Date()}).where(eq(onehrPanel.requestId,p.requestId));await tx.update(peerFeedbackRequest).set({status:'declined'}).where(eq(peerFeedbackRequest.id,p.requestId));}
    await touchReview(tx,reviewId,{});await audit(tx,ctx,reviewId,'panel-assigned',{count:inputs.length,removed:omitted.length});
  });
}
type FeedbackCard={requestId:string;reviewId:string;cycleId:string;subject:string;statements:Statement[];answers:Record<string,'yes'|'no'>|null;remark:string;submitted:boolean;frozen:boolean};
async function feedbackCard(tx:Tx,requestId:string) {uuid.parse(requestId);const [r]=await tx.execute<{value:FeedbackCard|null}>(sql`select app.onehr_feedback_card(${requestId}::uuid) as value`);if(!r?.value)throw Error('Feedback request not found or access has been removed.');return r.value;}
export async function getOnehrFeedback(ctx:SessionContext,requestId:string){return withPerformanceTenant(ctx,tx=>feedbackCard(tx,requestId));}
export async function submitOnehrFeedback(ctx:SessionContext,requestId:string,raw:unknown,remark:string) {
  const answers=z.record(z.string(),z.enum(['yes','no'])).parse(raw);note.parse(remark);
  return withPerformanceTenant(ctx,async tx=>{
    // Serialize all writes and freezing for the review, including peer responses.
    const card=await feedbackCard(tx,requestId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${card.reviewId},0))`);
    const fresh=await feedbackCard(tx,requestId);if(fresh.submitted||fresh.frozen)throw Error('Feedback is already submitted or finalized.');
    const cycle=await loadCycle(tx,card.cycleId);if(!['open','calibration'].includes(cycle.native.status))throw Error('The cycle is closed.');assertWindow(cycle.policy,'f360');
    const score=scoreAnswers(card.statements,answers);if(score.score/score.max*100>cycle.policy.midMaxPct&&!remark.trim())throw Error('Add an overall remark for a high assessment.');
    await tx.update(onehrPanel).set({answers,remark,submittedAt:new Date()}).where(eq(onehrPanel.requestId,requestId));
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

type Inputs={reviewId:string;employmentId:string;companyId:string;grade:string;name:string;performance:PMBand|null;managerScore:number|null;finalized:boolean;competencyStatus:string;competencies:Competency[];leadership:{score:number;max:number}[];principles:{principle:string;pct:number}[]};
async function assessment(tx:Tx,reviewId:string,policy:Policy) {
  const [r]=await tx.execute<{value:Inputs|null}>(sql`select app.onehr_assessment_inputs(${reviewId}::uuid) as value`);if(!r?.value)throw Error('Assessment not available to this calibration scope.');
  const input=r.value;const c=input.competencies;
  const tech=input.competencyStatus==='reviewed'&&c.length?scoreAnswers(c,Object.fromEntries(c.map(s=>[s.id,s.manager??s.self!]))):null;
  return {...input,potential:potential(input.leadership,tech,policy,input.grade)};
}
async function decisions(tx:Tx,reviewId:string) {
  const [r]=await tx.execute<{value:{tier:Tier;mode:string;performance:PMBand|null;potential:PotentialBand|null;locked:boolean;performanceLocked:boolean;potentialLocked:boolean;pip:boolean;promotion:boolean;specialReward:boolean}[]}>(sql`select app.onehr_decisions(${reviewId}::uuid) as value`);return r?.value??[];
}
async function resolved(tx:Tx,reviewId:string,policy:Policy) {
  const input=await assessment(tx,reviewId,policy),rows=await decisions(tx,reviewId),effective=rows.filter(d=>!(d.tier==='group'&&d.mode==='blend')&&!(d.tier==='bg'&&rows.some(g=>g.tier==='group'&&g.mode==='replace')));
  return {input,rows,performance:resolveBand<PMBand>(input.performance,effective.map(d=>({...d,band:d.performance,locked:d.performanceLocked}))),potential:resolveBand<PotentialBand>(input.potential.band,effective.map(d=>({...d,band:d.potential,locked:d.potentialLocked})))};
}
export async function createOnehrCalibration(ctx:SessionContext,cycleId:string,raw:unknown) {
  const p=z.object({name:z.string().trim().min(1).max(300),companyId:uuid.nullable(),tier:z.enum(tiers),reviewerUserIds:z.array(uuid).min(1).max(100),reviewIds:z.array(uuid).min(1).max(10000),pbtAchievement:z.number().finite().nullable(),mode:z.enum(['after','replace','blend']).default('after')}).parse(raw);
  return withPerformanceTenant(ctx,async tx=>{
    const cycle=await loadCycle(tx,cycleId,true);await requireAdmin(tx,cycleId);if(!['open','calibration'].includes(cycle.native.status))throw Error('Open the cycle before assigning calibration.');
    if(new Set(p.reviewIds).size!==p.reviewIds.length)throw Error('Duplicate assessment.');
    const reviews=await tx.select().from(onehrReview).where(and(eq(onehrReview.cycleId,cycleId),inArray(onehrReview.reviewId,p.reviewIds)));
    if(reviews.length!==p.reviewIds.length)throw Error('Every assessment must belong to this cycle and your scope.');
    if(p.companyId!=null){const [scope]=await tx.execute<{ok:boolean}>(sql`select app.onehr_admin(${p.companyId}::uuid) as ok`);if(!scope?.ok)throw Error('Company outside your scope.');}
    const [session]=await tx.insert(onehrCalibration).values({tenantId:ctx.tenantId,cycleId,companyId:p.companyId,name:p.name,tier:p.tier,reviewerUserIds:[...new Set(p.reviewerUserIds)],pbtAchievement:p.pbtAchievement==null?null:String(p.pbtAchievement),mode:p.mode}).returning();
    for(const r of reviews)await tx.insert(onehrCalibrationEntry).values({tenantId:ctx.tenantId,sessionId:session.id,reviewId:r.reviewId,employmentId:r.employmentId});
    await audit(tx,ctx,session.id,'calibration-assigned',{tier:p.tier,count:reviews.length});return session.id;
  });
}
async function loadCalibration(tx:Tx,id:string,expected?:number) {
  uuid.parse(id);const [session]=await tx.select().from(onehrCalibration).where(eq(onehrCalibration.id,id)).for('update');if(!session)throw Error('Calibration not found or access has been removed.');
  if(expected!==undefined)revision(session.revision,expected);
  return {session,cycle:await loadCycle(tx,session.cycleId)};
}
type Axis='performance'|'potential'|'both';
function calibrationWindows(policy:Policy,tier:Tier,axis:Axis) {
 if(tier==='hod'){if(axis!=='potential'&&policy.modules.pm)assertWindow(policy,'pm_hod');if(axis!=='performance'&&policy.modules.tm)assertWindow(policy,'pot_hod');}
 else if(tier==='bu'){if(axis!=='potential'&&policy.modules.pm)assertWindow(policy,'pm_buceo');if(axis!=='performance'&&policy.modules.tm)assertWindow(policy,'pot_buceo');}
 else assertWindow(policy,'tb_bgceo');
}
function needsAxes(policy:Policy,axis:Axis){return {pm:policy.modules.pm&&axis!=='potential',pot:policy.modules.tm&&axis!=='performance'};}
function assertPrecedingTier(rows:Awaited<ReturnType<typeof decisions>>,tier:Tier,mode:string,pm:boolean,pot:boolean) {
 const preceding=tier==='bg'?'bu':tier==='group'&&mode==='after'?'bg':null;
 if(preceding){const row=rows.find(d=>d.tier===preceding);if(!row||pm&&!row.performanceLocked||pot&&!row.potentialLocked)throw Error(`${preceding.toUpperCase()} calibration must be locked before this tier.`);}
 if(tier==='hod'&&rows.some(d=>['bu','bg'].includes(d.tier)&&(pm&&d.performanceLocked||pot&&d.potentialLocked)))throw Error('HOD calibration is closed after BU or BG locks.');
}
export async function saveOnehrCalibration(ctx:SessionContext,sessionId:string,expected:number,raw:unknown) {
 const p=z.object({reviewId:uuid,axis:z.enum(['performance','potential','both']).default('both'),performance:z.enum(pmBands).nullable(),potential:z.enum(potentialBands).nullable(),performanceNote:note,potentialNote:note,pip:z.boolean().default(false),promotion:z.boolean().default(false),specialReward:z.boolean().default(false),confirmTalentDecisions:z.boolean().default(false)}).parse(raw);
 return withPerformanceTenant(ctx,async tx=>{
  const {session,cycle}=await loadCalibration(tx,sessionId,expected);if(session.lockedAt||!['open','calibration'].includes(cycle.native.status))throw Error('This calibration is locked.');
  const {pm,pot}=needsAxes(cycle.policy,p.axis);if(!pm&&!pot)throw Error('This assessment axis is disabled.');calibrationWindows(cycle.policy,session.tier as Tier,p.axis);
  const [entry]=await tx.select().from(onehrCalibrationEntry).where(and(eq(onehrCalibrationEntry.sessionId,sessionId),eq(onehrCalibrationEntry.reviewId,p.reviewId)));
  if(!entry||await isSelf(tx,entry.employmentId))throw Error('This assessment cannot be calibrated by you.');
  if(pm&&(session.performanceLockedAt||entry.performanceLockedAt)&&session.tier!=='final'||pot&&(session.potentialLockedAt||entry.potentialLockedAt)&&session.tier!=='final')throw Error('This assessment axis is locked.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${p.reviewId},0))`);
  const current=await resolved(tx,p.reviewId,cycle.policy);if(current.input.finalized)throw Error('Assessment is finalized.');
  assertPrecedingTier(current.rows,session.tier as Tier,session.mode,pm,pot);
  const below=current.rows.filter(d=>tiers.indexOf(d.tier)<tiers.indexOf(session.tier as Tier)&&!(d.tier==='group'&&d.mode==='blend'));
  const baselinePm=resolveBand(current.input.performance,below.map(d=>({...d,band:d.performance,locked:d.performanceLocked}))).band;
  const baselinePot=resolveBand(current.input.potential.band,below.map(d=>({...d,band:d.potential,locked:d.potentialLocked}))).band;
  if(pm&&p.performance!=null&&p.performance!==baselinePm&&!p.performanceNote.trim()||pot&&p.potential!=null&&p.potential!==baselinePot&&!p.potentialNote.trim())throw Error('Explain each changed band.');
  if((p.pip||p.promotion||p.specialReward)&&!['bg','group','final'].includes(session.tier))throw Error('Talent decisions require BG, Group or final reviewer confirmation.');
  const confirmTalent=p.axis==='both'||p.confirmTalentDecisions;
  if(p.confirmTalentDecisions&&!['bg','group','final'].includes(session.tier))throw Error('Talent decisions require BG, Group or final reviewer confirmation.');
  const confirmedPm=pm?p.performance??baselinePm:entry.performance??baselinePm,confirmedPot=pot?p.potential??baselinePot:entry.potential??baselinePot;
  if(confirmTalent&&(p.pip||p.promotion||p.specialReward)&&(cycle.policy.modules.pm&&!confirmedPm||cycle.policy.modules.tm&&(!confirmedPot||!current.input.potential.valid)))throw Error('Confirm both enabled axes before making talent decisions.');
  const final=session.tier==='final',now=new Date();
  const pmLock=pm&&final&&p.performance?now:entry.performanceLockedAt,potLock=pot&&final&&p.potential?now:entry.potentialLockedAt;
  const data={...(pm?{performance:p.performance,performanceNote:p.performanceNote,seenPerformance:baselinePm,performanceLockedAt:pmLock}:{}),...(pot?{potential:p.potential,potentialNote:p.potentialNote,seenPotential:baselinePot,potentialLockedAt:potLock}:{}),...(confirmTalent?{pip:p.pip,promotion:p.promotion,specialReward:p.specialReward}:{}),lockedAt:(!cycle.policy.modules.pm||pmLock)&&(!cycle.policy.modules.tm||potLock)?now:null};
  await tx.update(onehrCalibrationEntry).set(data).where(eq(onehrCalibrationEntry.id,entry.id));
  await tx.update(onehrCalibration).set({revision:session.revision+1}).where(eq(onehrCalibration.id,sessionId));
  await audit(tx,ctx,sessionId,'calibration-recorded',{reviewId:p.reviewId,axis:p.axis,previous:{performance:entry.performance,potential:entry.potential,performanceNote:entry.performanceNote,potentialNote:entry.potentialNote},next:data});
 });
}
export async function lockOnehrCalibration(ctx:SessionContext,sessionId:string,expected:number,overrideReason:string,axis:Axis='both',reviewId?:string) {
 note.parse(overrideReason);z.enum(['performance','potential','both']).parse(axis);if(reviewId)uuid.parse(reviewId);
 return withPerformanceTenant(ctx,async tx=>{
  const {session,cycle}=await loadCalibration(tx,sessionId,expected);const {pm,pot}=needsAxes(cycle.policy,axis);
  if(!pm&&!pot)throw Error('This assessment axis is disabled.');if(session.lockedAt||pm&&session.performanceLockedAt||pot&&session.potentialLockedAt)throw Error('Calibration axis is already locked.');calibrationWindows(cycle.policy,session.tier as Tier,axis);
  const [own]=await tx.execute<{present:boolean}>(sql`select app.onehr_cohort_own(${sessionId}::uuid) as present`);if(!reviewId&&own?.present)throw Error('A reviewer cannot lock their own calibration.');
  const entries=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId)).orderBy(asc(onehrCalibrationEntry.reviewId));if(!entries.length)throw Error('An empty cohort cannot be locked.');
  if(reviewId&&(!['group','final'].includes(session.tier)||!entries.some(e=>e.reviewId===reviewId)))throw Error('Individual locking is available only within a Group or final cohort.');
  const selected=reviewId?entries.filter(e=>e.reviewId===reviewId):entries;
  if(own?.present&&cycle.policy.curveStrict&&!overrideReason.trim())throw Error('A separate reviewer or explicit override reason is required to assess a distribution that includes your own result.');
  const bands:{performance:PMBand|null;potential:PotentialBand|null}[]=[];
  for(const e of entries){
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${e.reviewId},0))`);
   if(await isSelf(tx,e.employmentId))throw Error('A reviewer cannot lock their own calibration.');
   const r=await resolved(tx,e.reviewId,cycle.policy);if(r.input.finalized&&selected.some(x=>x.id===e.id)&&(pm&&!e.performanceLockedAt||pot&&!e.potentialLockedAt))throw Error('An assessment in this cohort is already finalized.');
   const chosen=selected.some(x=>x.id===e.id);
   if(chosen)assertPrecedingTier(r.rows,session.tier as Tier,session.mode,pm,pot);
   const effective={performance:z.enum(pmBands).nullable().parse(e.performance??r.performance.band),potential:z.enum(potentialBands).nullable().parse(e.potential??r.potential.band)};
   const valid=(!pm||!!effective.performance)&&(!pot||!!effective.potential&&r.input.potential.valid);
   if(chosen&&!valid)throw Error('Complete the enabled assessment axes and required valid responses first.');
   if(valid)bands.push(effective);
  }
  const counts=Object.fromEntries(pmBands.map(b=>[b,bands.filter(e=>e.performance===b).length])) as Record<PMBand,number>;
  const curve=session.pbtAchievement==null?null:referenceCurve(Number(session.pbtAchievement)),tolerance=Math.max(cycle.policy.curveTolerancePeople,entries.length*cycle.policy.curveTolerancePct/100);
  const out=bands.length!==entries.length||pm&&curve&&pmBands.some(b=>Math.abs(counts[b]-entries.length*curve[b]/100)>tolerance)||pot&&potentialBands.some(b=>Math.abs(bands.filter(e=>e.potential===b).length-entries.length*({Low:15,Mid:70,High:15}[b])/100)>tolerance);
  if(session.tier!=='hod'&&cycle.policy.curveStrict&&out&&!overrideReason.trim())throw Error('The reference distribution needs an override reason.');
  const now=new Date();
  for(const e of selected){const pl=pm?e.performanceLockedAt??now:e.performanceLockedAt,tl=pot?e.potentialLockedAt??now:e.potentialLockedAt;
   if(pl===e.performanceLockedAt&&tl===e.potentialLockedAt)continue;
   await tx.update(onehrCalibrationEntry).set({performanceLockedAt:pl,potentialLockedAt:tl,lockedAt:(!cycle.policy.modules.pm||pl)&&(!cycle.policy.modules.tm||tl)?e.lockedAt??now:null}).where(eq(onehrCalibrationEntry.id,e.id));
  }
  const updated=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId));
  const pmLock=!own?.present&&updated.every(e=>e.performanceLockedAt)?session.performanceLockedAt??now:null,potLock=!own?.present&&updated.every(e=>e.potentialLockedAt)?session.potentialLockedAt??now:null;
  const all=(!cycle.policy.modules.pm||pmLock)&&(!cycle.policy.modules.tm||potLock);
  await tx.update(onehrCalibration).set({performanceLockedAt:pmLock,potentialLockedAt:potLock,lockedAt:all?now:null,revision:session.revision+1}).where(eq(onehrCalibration.id,sessionId));
  await audit(tx,ctx,sessionId,'calibration-locked',{axis,reviewId:reviewId??null,override:!!overrideReason.trim(),reason:overrideReason});
 });
}

export async function getOnehrCalibration(ctx:SessionContext,sessionId:string) {
  return withPerformanceTenant(ctx,async tx=>{
    const {session,cycle}=await loadCalibration(tx,sessionId);
    const entries=await tx.select().from(onehrCalibrationEntry).where(eq(onehrCalibrationEntry.sessionId,sessionId));
    const rows=[];for(const entry of entries){if(await isSelf(tx,entry.employmentId))continue;const r=await resolved(tx,entry.reviewId,cycle.policy);rows.push({entry,finalized:r.input.finalized,name:r.input.name,grade:r.input.grade,managerPerformance:r.input.performance,managerPotential:r.input.potential.band,currentPerformance:r.performance.band,currentPotential:r.potential.band});}
    const [own]=await tx.execute<{present:boolean}>(sql`select app.onehr_cohort_own(${sessionId}::uuid) as present`);
    return {session,canLockCohort:!own?.present,cycle:{id:cycle.native.id,name:cycle.native.name},modules:cycle.policy.modules,rows,reference:session.pbtAchievement==null?null:referenceCurve(Number(session.pbtAchievement))};
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
    if(resolvedResult.rows.some(d=>!d.locked&&d.tier!=='final'&&!(d.tier==='group'&&d.mode==='blend')&&!(d.tier==='bg'&&resolvedResult.rows.some(g=>g.tier==='group'&&g.mode==='replace'))))throw Error('Lock every assigned calibration scope before finalizing.');
    if(r.cycle.policy.modules.tm&&!resolvedResult.input.potential.valid)throw Error('Complete the manager assessment and required valid 360 submissions first.');
    if(r.cycle.policy.modules.pm&&!resolvedResult.performance.band||r.cycle.policy.modules.tm&&!resolvedResult.potential.band)throw Error('Complete every enabled assessment axis before finalizing.');
    const talentDecision=[...resolvedResult.rows].reverse().find(d=>['bg','group','final'].includes(d.tier)&&!(d.tier==='group'&&d.mode==='blend')&&d.locked);
    const evidence=await tx.select().from(onehrEvidence).where(and(eq(onehrEvidence.employmentId,r.row.employmentId),eq(onehrEvidence.state,'shared')));
    const attachments=await tx.select({id:performanceAttachment.id,fileName:performanceAttachment.fileName,sizeBytes:performanceAttachment.sizeBytes}).from(performanceAttachment).where(eq(performanceAttachment.reviewId,reviewId));
    const result:FrozenResult={version:1,provenance:{evidence,attachments,kpis:r.kpis,competencies:r.competencies,leadership:resolvedResult.input.leadership,decisions:resolvedResult.rows},performance:resolvedResult.performance.band,potential:resolvedResult.potential.band,performanceSource:resolvedResult.performance.source,potentialSource:resolvedResult.potential.source,talent:talentCategory(resolvedResult.performance.band,resolvedResult.potential.band),selfScore:scorecard(r.kpis,r.cycle.policy,r.row.companyId,false).score,managerScore:r.row.managerScore==null?null:Number(r.row.managerScore),potentialPct:resolvedResult.input.potential.pct,grade:r.row.grade,policyDigest:hash(r.cycle.policy),feedback:resolvedResult.input.principles.map(p=>({principle:p.principle,band:p.pct<=r.cycle.policy.lowMaxPct?'Low':p.pct<=r.cycle.policy.midMaxPct?'Mid':'High'})),pip:talentDecision?.pip??false,promotion:talentDecision?.promotion??false,specialReward:talentDecision?.specialReward??false};
    const [frozen]=await tx.insert(onehrResult).values({tenantId:ctx.tenantId,reviewId,cycleId:r.row.cycleId,employmentId:r.row.employmentId,result,digest:hash({reviewId,policy:r.cycle.policy,result})}).returning();
    // Legacy ratings stay null: OneHR's frozen record is the sole authoritative final assessment.
    await tx.update(performanceReview).set({closedAt:new Date(),status:'submitted'}).where(eq(performanceReview.id,reviewId));await audit(tx,ctx,reviewId,'assessment-frozen',{resultId:frozen.id,digest:frozen.digest});return frozen.id;
  });
}
export async function releaseOnehrResult(ctx:SessionContext,reviewId:string,component:'performance'|'potential'|'talent'|'feedback',release:boolean) {
  z.enum(['performance','potential','talent','feedback']).parse(component);z.boolean().parse(release);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId);await requireAdmin(tx,r.row.cycleId);
    const [frozen]=await tx.select().from(onehrResult).where(eq(onehrResult.reviewId,reviewId)).for('update');if(!frozen)throw Error('Finalize the assessment before releasing results.');
    const field={performance:'performanceReleasedAt',potential:'potentialReleasedAt',talent:'talentReleasedAt',feedback:'feedbackReleasedAt'}[component];
    await tx.update(onehrResult).set({[field]:release?new Date():null}).where(eq(onehrResult.id,frozen.id));await audit(tx,ctx,reviewId,release?'result-released':'result-revoked',{component});
  });
}

export async function saveOnehrPlan(ctx:SessionContext,reviewId:string,expected:number|null,raw:unknown,share=false) {
  const p=z.object({career:careerSchema,goals:z.array(goalSchema.omit({managerComment:true})).max(30)}).parse(raw);
  return withPerformanceTenant(ctx,async tx=>{
    const r=await loadReview(tx,reviewId);if(!await isSelf(tx,r.row.employmentId))throw Error('Only the employee may write their plan.');if(!r.cycle.policy.modules.idp)throw Error('Development plans are disabled.');assertWindow(r.cycle.policy,'idp_self');
    const year=Number(r.cycle.native.periodEnd.slice(0,4))+(r.cycle.policy.kind==='year_end'?1:0);
    const [existing]=await tx.select().from(onehrPlan).where(and(eq(onehrPlan.employmentId,r.row.employmentId),eq(onehrPlan.planYear,year))).for('update');
    if(existing){revision(existing.revision,expected!);if(existing.status!=='draft')throw Error('Career and development goals are locked after sharing.');}else if(expected!=null)throw Error('Reload this plan.');
    if(new Set(p.goals.map(g=>g.id)).size!==p.goals.length)throw Error('Duplicate development goal.');
    if(p.career.targetProfileId&&!r.cycle.policy.profiles.some(profile=>profile.id===p.career.targetProfileId))throw Error('Choose an available target profile.');
    if(share&&p.goals.length<r.cycle.policy.idpMinGoals)throw Error('Add the required development goals before sharing.');
    if(share&&p.goals.some(g=>r.cycle.policy.idpRequireAllActions?!g.onJob||!g.fromOthers||!g.formalLearning:!g.onJob&&!g.fromOthers&&!g.formalLearning))throw Error('Add development actions before sharing.');
    const data={career:p.career,goals:p.goals.map(g=>({...g,status:'not_started',managerComment:''})),status:share?'shared':'draft'};
    if(existing)await tx.update(onehrPlan).set({...data,revision:existing.revision+1}).where(eq(onehrPlan.id,existing.id));else await tx.insert(onehrPlan).values({...data,tenantId:ctx.tenantId,reviewId,employmentId:r.row.employmentId,planYear:year});await audit(tx,ctx,reviewId,share?'plan-shared':'plan-saved');
  });
}
export async function reviewOnehrPlan(ctx:SessionContext,planId:string,expected:number,comment:string,conversation:string,close=false,activeReviewId?:string) {
  uuid.parse(planId);note.parse(comment);note.parse(conversation);
  return withPerformanceTenant(ctx,async tx=>{
    const [plan]=await tx.select().from(onehrPlan).where(eq(onehrPlan.id,planId)).for('update');if(!plan)throw Error('Plan not found.');revision(plan.revision,expected);
    const r=await loadReview(tx,activeReviewId??plan.reviewId);const activeYear=Number(r.cycle.native.periodEnd.slice(0,4))+(r.cycle.policy.kind==='year_end'?1:0);if(r.row.employmentId!==plan.employmentId||activeYear!==plan.planYear)throw Error('This assessment does not own the plan year.');if(await isSelf(tx,plan.employmentId)||!await isManager(tx,activeReviewId??plan.reviewId))throw Error('Only the assigned manager may review this plan.');assertWindow(r.cycle.policy,'idp_review');
    if(plan.status!=='shared'&&!(plan.status==='closed'&&r.cycle.policy.kind==='mid_year'))throw Error('The employee must share the plan first.');if(close&&!conversation.trim())throw Error('Record the career conversation before closing.');
    await tx.update(onehrPlan).set({managerComment:comment,conversation,status:close||plan.status==='closed'?'closed':'shared',revision:plan.revision+1}).where(eq(onehrPlan.id,planId));await audit(tx,ctx,planId,close?'plan-closed':'plan-reviewed',{reviewId:activeReviewId??plan.reviewId,previous:{comment:plan.managerComment,conversation:plan.conversation,status:plan.status},next:{comment,conversation,status:close||plan.status==='closed'?'closed':'shared'}});
  });
}
export async function updateOnehrGoalProgress(ctx:SessionContext,planId:string,expected:number,goalId:string,status:'not_started'|'in_progress'|'done'|'dropped') {
  uuid.parse(planId);uuid.parse(goalId);z.enum(['not_started','in_progress','done','dropped']).parse(status);
  return withPerformanceTenant(ctx,async tx=>{const [plan]=await tx.select().from(onehrPlan).where(eq(onehrPlan.id,planId)).for('update');if(!plan||!await isSelf(tx,plan.employmentId))throw Error('Plan not found.');revision(plan.revision,expected);if(plan.status==='draft')throw Error('Share the plan before updating progress.');
    const goals=z.array(goalSchema).parse(plan.goals);if(!goals.some(g=>g.id===goalId))throw Error('Goal not found.');const previous=goals.find(g=>g.id===goalId)!.status;
    await tx.update(onehrPlan).set({goals:goals.map(g=>g.id===goalId?{...g,status}:g),revision:plan.revision+1}).where(eq(onehrPlan.id,planId));await audit(tx,ctx,planId,'goal-progress-updated',{goalId,previous,status});});
}
export async function acknowledgeOnehrPlan(ctx:SessionContext,planId:string,expected:number) {
  uuid.parse(planId);return withPerformanceTenant(ctx,async tx=>{const [p]=await tx.select().from(onehrPlan).where(eq(onehrPlan.id,planId)).for('update');if(!p||!await isSelf(tx,p.employmentId))throw Error('Plan not found.');revision(p.revision,expected);if(!p.conversation.trim())throw Error('A recorded career conversation is required.');await tx.update(onehrPlan).set({acknowledgedAt:new Date(),revision:p.revision+1}).where(eq(onehrPlan.id,planId));await audit(tx,ctx,planId,'plan-acknowledged');});
}
export async function addOnehrEvidence(ctx:SessionContext,reviewId:string,raw:unknown) {
  const p=z.object({kind:z.enum(['delivery','problem','behaviour','learning','recognition','support','told','other']),body:z.string().trim().min(1).max(1200),occurredOn:z.iso.date(),state:z.enum(['draft','shared']),supersedesId:uuid.nullable(),links:z.array(z.object({kind:z.enum(['kpi','principle','skill']),id:z.string().min(1).max(100)})).max(30)}).parse(raw);
  return withPerformanceTenant(ctx,async tx=>{const r=await loadReview(tx,reviewId);if(!r.cycle.policy.modules.evidence)throw Error('Evidence is disabled.');if(!await isSelf(tx,r.row.employmentId)&&!await isManager(tx,reviewId))throw Error('Only the employee or assigned manager may add evidence.');if(p.occurredOn>todayInKualaLumpur())throw Error('Evidence cannot be dated in the future.');
    for(const link of p.links)if(link.kind==='kpi'?!r.kpis.some(k=>k.id===link.id):link.kind==='skill'?!r.competencies.some(c=>c.id===link.id):!(r.row.statements as Statement[]).some(s=>s.principle===link.id))throw Error('Evidence link is not part of this assessment.');
    const [entry]=await tx.insert(onehrEvidence).values({...p,tenantId:ctx.tenantId,reviewId,employmentId:r.row.employmentId,authorUserId:ctx.userId!}).returning();await audit(tx,ctx,entry.id,'evidence-added');return entry.id;});
}
export async function changeOnehrEvidenceState(ctx:SessionContext,id:string,state:'shared'|'retracted') {
  uuid.parse(id);z.enum(['shared','retracted']).parse(state);return withPerformanceTenant(ctx,async tx=>{const [e]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,id)).for('update');if(!e||e.authorUserId!==ctx.userId)throw Error('Only the author may change this evidence.');if(state==='shared'&&e.state!=='draft'||state==='retracted'&&e.state!=='shared')throw Error('This evidence cannot change to that state.');await tx.update(onehrEvidence).set({state}).where(eq(onehrEvidence.id,id));await audit(tx,ctx,id,`evidence-${state}`);});
}

export async function respondOnehrEvidence(ctx:SessionContext,id:string,stance:'endorse'|'dispute',text:string,activeReviewId?:string) {
 uuid.parse(id);const response=evidenceResponseSchema.parse({userId:ctx.userId,stance,note:text,at:new Date().toISOString()});
 return withPerformanceTenant(ctx,async tx=>{
  const [e]=await tx.select().from(onehrEvidence).where(eq(onehrEvidence.id,id)).for('update');
  if(!e||e.state!=='shared'||e.authorUserId===ctx.userId)throw Error('Respond only to shared evidence from another author.');
  const context=await loadReview(tx,activeReviewId??e.reviewId);if(context.row.employmentId!==e.employmentId||!context.cycle.policy.modules.evidence||!await isSelf(tx,e.employmentId)&&!await isManager(tx,activeReviewId??e.reviewId))throw Error('Only the employee or assigned manager may respond.');
  const responses=evidenceResponseSchema.array().parse(e.responses);
  await tx.update(onehrEvidence).set({responses:[...responses,response]}).where(eq(onehrEvidence.id,id));await audit(tx,ctx,id,'evidence-response-recorded',{stance});
 });
}

/** The existing native attachment writer remains the owner of file storage. */
export async function onehrAttachmentSubjectTx(tx:Tx,reviewId:string) {
 const [configured]=await tx.select().from(onehrReview).where(eq(onehrReview.reviewId,reviewId));if(!configured)return null;
 const r=await loadReview(tx,reviewId);if(!r.cycle.policy.modules.evidence||!await isSelf(tx,r.row.employmentId)&&!await isManager(tx,reviewId))throw Error('Only the employee or assigned manager may attach evidence.');
 return {id:r.row.reviewId,employmentId:r.row.employmentId};
}

/** Own-person projection never returns intermediate calibration decisions or rater identities. */
export async function getOnehrReview(ctx:SessionContext,reviewId:string) {
  return withPerformanceTenant(ctx,async tx=>{
    uuid.parse(reviewId);const [exists]=await tx.select().from(onehrReview).where(eq(onehrReview.reviewId,reviewId));if(!exists)return null;
    const r=await loadReview(tx,reviewId);const self=await isSelf(tx,r.row.employmentId),manager=!self&&await isManager(tx,reviewId),admin=!self&&await isAdmin(tx,r.row.cycleId),moderator=!self&&!manager&&await isModerator(tx,reviewId);if(!self&&!manager&&!admin&&!moderator)throw Error('Assessment is not assigned to you.');
    const name={name:r.native.name};const moderators=self||manager||admin?await moderatorChoices(tx,reviewId):[];
    const [stored]=await tx.select().from(onehrResult).where(eq(onehrResult.reviewId,reviewId));
    let frozen:typeof stored|undefined=stored;
    if(self){const [card]=await tx.execute<{value:typeof frozen|null}>(sql`select app.onehr_result_card(${reviewId}::uuid) as value`);frozen=card?.value??undefined;}
    const result=frozen?.result as FrozenResult|undefined;
    const leadership=manager||admin?await assessment(tx,reviewId,r.cycle.policy):null;
    const planYear=Number(r.cycle.native.periodEnd.slice(0,4))+(r.cycle.policy.kind==='year_end'?1:0);
    const plans=moderator&&!admin?[]:await tx.select().from(onehrPlan).where(and(eq(onehrPlan.employmentId,r.row.employmentId),eq(onehrPlan.planYear,planYear)));
    const feedbackReport=result&&(!self||frozen!.feedbackReleasedAt)?result.feedback:[];
    const choices=manager||admin?await tx.select({id:employment.id,name:person.fullName,code:employment.employeeCode}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(and(sql`not exists(select 1 from employment sub where sub.id=${r.row.employmentId}::uuid and sub.person_id=${person.id})`,sql`(${employment.terminatedOn} is null or ${employment.terminatedOn}>${todayInKualaLumpur()}::date)`)):[];
    const evidence=r.cycle.policy.modules.evidence&&(!moderator||admin)?await tx.select().from(onehrEvidence).where(eq(onehrEvidence.employmentId,r.row.employmentId)).orderBy(desc(onehrEvidence.createdAt)):[];
    const attachments=r.cycle.policy.modules.evidence&&(!moderator||admin)?await tx.select({id:performanceAttachment.id,fileName:performanceAttachment.fileName,sizeBytes:performanceAttachment.sizeBytes}).from(performanceAttachment).where(eq(performanceAttachment.reviewId,reviewId)):[];
    const peers=manager||admin?await tx.select({requestId:onehrPanel.requestId,employmentId:onehrPanel.peerEmploymentId,relationship:onehrPanel.relationship,submittedAt:onehrPanel.submittedAt}).from(onehrPanel).where(and(eq(onehrPanel.reviewId,reviewId),isNull(onehrPanel.archivedAt))):[];
    let aiEnabled=false;if(self||manager){try{aiEnabled=!!await resolveActiveAiConfig(tx,ctx);}catch{/* Manual assessment remains available when AI configuration is unusable. */}}
    return {aiEnabled,viewerUserId:ctx.userId,reviewId,name:name?.name??'',cycle:{id:r.cycle.native.id,name:r.cycle.native.name,status:r.cycle.native.status},policy:moderator&&!admin?{...r.cycle.policy,modules:{pm:true,tm:false,idp:false,evidence:false}}:r.cycle.policy,grade:r.row.grade,revision:r.row.revision,self,manager,admin,moderator,moderators:moderators.map(({id,name})=>({id,name})),mechanism:r.cycle.policy.bBands.some(b=>b.companyId===r.row.companyId)?'B' as const:'A' as const,reviewerEmploymentId:r.native.reviewerEmploymentId,canModerateIds:r.kpis.filter(k=>{const next=pendingKpiApprover(k);return next&&r.native.ownEmploymentIds.includes(next);}).map(k=>k.id),
      kpis:moderator&&!admin?r.kpis.filter(k=>kpiApprovers(k).some(id=>r.native.ownEmploymentIds.includes(id))):r.kpis,competencies:moderator&&!admin?[]:r.competencies,competencyStatus:r.row.competencyStatus,resultsSubmitted:!!r.row.resultsSubmittedAt,managerPerformance:r.row.managerPerformance,managerScore:r.row.managerScore==null?null:Number(r.row.managerScore),managerRemark:r.row.managerRemark,
      potential:leadership?.potential.band??null,finalized:!!frozen||!!r.native.closedAt,result:result?{id:frozen!.id,digest:frozen!.digest,performance:!self||frozen!.performanceReleasedAt?result.performance:null,potential:!self||frozen!.potentialReleasedAt?result.potential:null,talent:!self||frozen!.talentReleasedAt?result.talent:null,performanceReleased:!!frozen!.performanceReleasedAt,potentialReleased:!!frozen!.potentialReleasedAt,talentReleased:!!frozen!.talentReleasedAt,feedbackReleased:!!frozen!.feedbackReleasedAt}:null,plans,planYear,feedbackReport,evidence:evidence.map(e=>({...e,responses:evidenceResponseSchema.array().parse(e.responses)})),attachments,peers,choices};
  });
}
export async function getOnehrCycle(ctx:SessionContext,cycleId:string) {
  return withPerformanceTenant(ctx,async tx=>{uuid.parse(cycleId);const [config]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));if(!config)return null;await requireAdmin(tx,cycleId);const cycle=await loadCycle(tx,cycleId);
    const reviews=await tx.select({reviewId:onehrReview.reviewId,employmentId:onehrReview.employmentId,revision:onehrReview.revision,grade:onehrReview.grade,name:person.fullName,managerPerformance:onehrReview.managerPerformance,frozenId:sql<string|null>`case when ${performanceReview.closedAt} is not null then ${performanceReview.id} end`}).from(onehrReview).innerJoin(employment,eq(employment.id,onehrReview.employmentId)).innerJoin(person,eq(person.id,employment.personId)).innerJoin(performanceReview,eq(performanceReview.id,onehrReview.reviewId)).where(eq(onehrReview.cycleId,cycleId));
    const users=await tx.select({id:appUser.id,name:person.fullName,email:person.primaryEmail}).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(and(isNull(appUser.archivedAt),sql`not app.login_blocked(${appUser.id})`));
    const companies=await tx.select({id:company.id,name:company.legalName}).from(company).where(sql`app.onehr_admin(${company.id})`);
    return {cycle:cycle.native,policy:cycle.policy,revision:config.revision,reviews,users,companies,sessions:await tx.select().from(onehrCalibration).where(eq(onehrCalibration.cycleId,cycleId))};});
}
export async function onehrAssignments(ctx:SessionContext) {
  return withPerformanceTenant(ctx,async tx=>({reviews:await tx.select({id:onehrReview.reviewId,cycle:reviewCycle.name,periodEnd:reviewCycle.periodEnd,name:sql<string>`app.onehr_review_header(${onehrReview.reviewId})->>'name'`}).from(onehrReview).innerJoin(reviewCycle,eq(reviewCycle.id,onehrReview.cycleId)).where(sql`app.onehr_manager(${onehrReview.reviewId}) or app.onehr_moderator(${onehrReview.reviewId}) or exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`).orderBy(desc(reviewCycle.periodEnd)),sessions:await tx.select({id:onehrCalibration.id,name:onehrCalibration.name,lockedAt:onehrCalibration.lockedAt}).from(onehrCalibration).orderBy(desc(onehrCalibration.createdAt)),feedback:await tx.select({id:onehrPanel.requestId,subject:peerFeedbackRequest.subjectName}).from(onehrPanel).innerJoin(peerFeedbackRequest,eq(peerFeedbackRequest.id,onehrPanel.requestId)).where(and(isNull(onehrPanel.submittedAt),isNull(onehrPanel.archivedAt),sql`exists(select 1 from employment e where e.id=${onehrPanel.peerEmploymentId} and app.is_self_person(e.person_id))`))}));
}
/** Rewards consumes this immutable projection under its own transaction and company authorization. */
export async function onehrRewardResultTx(tx:Tx,employmentId:string,year:number,rewardUnitId:string) {
  const [r]=await tx.execute<{value:{id:string;reviewId:string;cycleId:string;digest:string;frozenAt:string;performance:PMBand|null;potential:PotentialBand|null;talent:FrozenResult['talent'];pip:boolean;promotion:boolean;specialReward:boolean;policyDigest:string}|null}>(sql`select app.reward_onehr_source(${rewardUnitId}::uuid,${employmentId}::uuid,${year}) as value`);
  return r?.value??null;
}

export async function reassignOnehrReviewer(ctx:SessionContext,reviewId:string,expected:number,reviewerEmploymentId:string) {
 uuid.parse(reviewerEmploymentId);
 return withPerformanceTenant(ctx,async tx=>{
  const r=await loadReview(tx,reviewId,true);await requireAdmin(tx,r.row.cycleId);revision(r.row.revision,expected);
  if(r.row.managerPerformance||r.kpis.some(k=>k.locked||k.approvalChain?.some(step=>step.at))||r.row.competencyStatus==='reviewed')throw Error('Reassignment is closed after manager assessment begins.');
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
