import { assessmentAiConfigTx,assessmentAiFeatureEnabledTx } from './ai-settings';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext,Tx } from '../../../db/client';
import { assessmentConversation } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { getOnehrReview, saveAssessmentDraftTx, saveOnehrKpisTx, saveAssessmentCareerProfileTx, saveOnehrPlanTx, addOnehrEvidenceTx, saveOnehrKpiCheckInTx,moderateOnehrKpiTx,submitAssessmentModerationTx,confirmOnehrPerformanceTx,submitOnehrCompetenciesTx,commentAssessmentCareerProfileTx,reviewOnehrPlanTx,editAssessmentDevelopmentGoalTx } from './service';
import { assessmentDraftSchema } from './journey-model';
import { proposeSettingCommands, proposeSettingSuggestion, proposeCareerCommands, proposeJourneyCommands } from './review-command-ai';
import { assessmentAiQuotaTx,recordAssessmentAiUseTx } from './ai-usage';
import { careerSchema } from './model';
import { readManagerCommand } from './manager-command-model';
import { draftOnehrNarrative } from './ai';

export const conversationStage=z.enum(['setting','results','moderation','competency','career','evidence','feedback']);
export type ConversationStage=z.infer<typeof conversationStage>;
const storedStage=(stage:ConversationStage)=>stage==='setting'||stage==='evidence'?stage:'journey';
const messageSchema=z.object({id:z.uuid(),role:z.enum(['user','assistant']),text:z.string().max(6000),at:z.iso.datetime(),kind:z.enum(['guide','draft','message','update','action'])});
export type ReviewMessage=z.infer<typeof messageSchema>;
export const reviewConversationMessages=z.array(messageSchema).max(300);
async function authorized(ctx:SessionContext,reviewId:string,stage:ConversationStage){
 z.uuid().parse(reviewId);conversationStage.parse(stage);if(stage==='feedback')throw Error('Use the assigned colleague feedback conversation.');
 const v=await getOnehrReview(ctx,reviewId);
 if(!v||!v.self&&!v.manager&&!v.moderator)throw Error('This review conversation is not assigned to you.');
 if(v.policy.modules.review===false)throw Error('Guided review is disabled.');
 if(['setting','results','moderation'].includes(stage)&&!v.policy.modules.pm||stage==='competency'&&!v.policy.modules.tm||stage==='career'&&!v.policy.modules.idp||stage==='evidence'&&!v.policy.modules.evidence)throw Error('This review module is disabled.');
 return v;
}
function commandContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 if(view.finalized||view.policy.kind==='quarterly')return null;
 const kind=stage==='results'&&view.self?'results':stage==='moderation'&&(view.manager||view.moderator)?'moderation':stage==='competency'&&view.self?'competency_self':stage==='competency'&&view.manager?'competency_manager':null;
 if(!kind||kind==='results'&&view.resultsSubmitted||kind==='moderation'&&!view.canModerateIds.length||kind==='competency_self'&&view.competencyStatus!=='pending'||kind==='competency_manager'&&view.competencyStatus!=='submitted')return null;
 const prior=view.drafts.find(d=>d.kind===kind);
 const kpis=view.kpis.filter(k=>!k.hrOwned&&(kind==='results'||view.canModerateIds.includes(k.id)));
 const draft=assessmentDraftSchema.parse(prior?.payload??(kind==='results'||kind==='moderation'?{kind,lines:kpis.map(k=>({id:k.id,actual:kind==='results'?k.actual:k.approvedActual??k.actual,note:kind==='results'?k.note:k.moderationRemark})),remark:kind==='results'?view.selfRemark:view.ownReviewerRemark}:{kind,answers:Object.fromEntries(view.competencies.map(c=>[c.id,{answer:kind==='competency_self'?c.self:c.manager??c.self,remark:kind==='competency_self'?c.selfRemark??'':c.managerRemark}])),remark:kind==='competency_self'?view.competencySelfRemark:view.competencyManagerRemark}));
 const targets=(kind==='results'||kind==='moderation'?kpis.map(k=>({id:k.id,label:k.title})):view.competencies.map(c=>({id:c.id,label:c.text})));
 return {facts:{text,draft,targets},draftRevision:prior?.revision??null};
}
function settingContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 if(stage!=='setting'||!view.self||view.finalized||view.kpis.some(k=>k.hrOwned||['approved','proposed'].includes(k.setting)))return null;
 return {text,kpis:view.kpis,library:view.kpiLibrary,moderatorEmploymentId:view.reviewerEmploymentId};
}
function careerContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 if(stage!=='career'||!view.self||view.finalized)return null;
 const plan=view.plans.find(p=>p.planYear===view.planYear);
 return {text,career:careerSchema.parse(view.careerProfile?.career??{aspiration:'',mobility:null,mobilityNote:'',targetProfileId:null,selfProfileId:null}),careerRevision:view.careerProfile?.revision??null,planRevision:plan?.revision??null,goals:plan?.goals??[],canEditCareer:!plan||plan.status==='draft'||!view.careerProfile?.career.mobility||![view.careerProfile.career.aspiration,view.careerProfile.career.aspirationNow,view.careerProfile.career.aspirationLong].some(s=>s?.trim()),canEditGoals:view.policy.kind==='year_end'&&(!plan||plan.status==='draft'),roles:view.policy.profiles.filter(p=>p.active!==false).map(p=>({id:p.id,label:`${p.jobTitle??p.name} · ${p.grade}${p.department?` · ${p.department}`:''}`}))};
}
function evidenceContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 if(!view.self||view.finalized||!['results','evidence'].includes(stage))return null;
 const canLog=view.policy.modules.evidence,canCheckIn=view.policy.modules.pm&&view.policy.kind==='quarterly'&&stage==='results';
 if(!canLog&&!canCheckIn)return null;
 return {text,canLog,canCheckIn,kpis:view.kpis.filter(k=>!k.hrOwned).map(k=>({id:k.id,label:k.title,approved:k.setting==='approved',note:k.checkIn?.note??''}))};
}
type ReviewView=NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>;
function humanManagerContext(view:ReviewView,stage:ConversationStage,text:string){
 const plan=view.plans.find(p=>p.planYear===view.planYear)??null;
 const command=readManagerCommand(text,{stage,self:view.self,manager:view.manager,moderator:view.moderator,finalized:!view.participating||view.cycle.status==='closed'||stage!=='career'&&view.finalized,kpis:view.kpis.filter(k=>view.canModerateIds.includes(k.id)),competencyStatus:view.competencyStatus,planRemarkWriter:view.planRemarkWriter,plan});
 return command?{command,revision:view.revision,ownReviewerRemark:view.ownReviewerRemark,privateDraft:commandContext(view,stage,text),plan,careerRevision:view.careerProfile?.revision??null}:null;
}
async function applyHumanManagerCommand(tx:Tx,ctx:SessionContext,view:ReviewView,input:NonNullable<ReturnType<typeof humanManagerContext>>){
 const {command,plan}=input,privateDraft=input.privateDraft?.facts.draft;
 if(command.action==='confirm_kpi'){
  const kpi=view.kpis.find(k=>k.id===command.id&&view.canModerateIds.includes(k.id));if(!kpi)throw Error('This KPI is no longer awaiting your review.');
  const line=privateDraft?.kind==='moderation'?privateDraft.lines.find(l=>l.id===kpi.id):null,actual=line?.actual??kpi.approvedActual??kpi.actual;
  if(actual==null)throw Error('Enter the KPI result before confirming.');
  await moderateOnehrKpiTx(tx,ctx,view.reviewId,view.revision,kpi.id,actual,line?.note??kpi.moderationRemark,true);
  return `KPI confirmed: ${kpi.title}.`;
 }
 if(command.action==='confirm_performance'){
  if(view.canModerateIds.length){
   const lines=view.kpis.filter(k=>view.canModerateIds.includes(k.id)).map(k=>{const line=privateDraft?.kind==='moderation'?privateDraft.lines.find(l=>l.id===k.id):null,actual=line?.actual??k.approvedActual??k.actual;if(actual==null)throw Error('Enter every assigned KPI result before confirming.');return {id:k.id,actual,note:line?.note??k.moderationRemark};});
   await submitAssessmentModerationTx(tx,ctx,view.reviewId,view.revision,lines,view.ownReviewerRemark);
  }else if(view.manager&&!view.managerPerformance&&view.calculatedPerformance)await confirmOnehrPerformanceTx(tx,ctx,view.reviewId,view.revision,view.calculatedPerformance,view.ownReviewerRemark);
  else throw Error('No KPI results are awaiting your confirmation.');
  return 'Your assigned KPI results are confirmed.';
 }
 if(command.action==='approve_competencies'){
  if(privateDraft?.kind!=='competency_manager')throw Error('This competency review is not awaiting your approval.');
  const answers=Object.fromEntries(view.competencies.map(c=>{const answer=privateDraft.answers[c.id];if(!answer?.answer)throw Error('Rate every competency before approving.');return [c.id,{answer:answer.answer,remark:answer.remark}];}));
  await submitOnehrCompetenciesTx(tx,ctx,view.reviewId,view.revision,answers,true,privateDraft.remark);return 'The competency review is approved.';
 }
 if(command.action==='comment_career'){
  await commentAssessmentCareerProfileTx(tx,ctx,view.reviewId,input.careerRevision,command.text);return 'Your career-profile comment is saved.';
 }
 if(!plan)throw Error('The employee must share a development plan first.');
 if(command.action==='comment_goal'){
  const goal=plan.goals.find(g=>g.id===command.id);if(!goal)throw Error('This development goal is no longer assigned.');
  await editAssessmentDevelopmentGoalTx(tx,ctx,view.reviewId,plan.id,plan.revision,goal.id,{...goal,managerComment:command.text});return `Goal feedback saved: ${goal.area}.`;
 }
 if(command.action==='comment_plan'){
  await reviewOnehrPlanTx(tx,ctx,plan.id,plan.revision,command.text,plan.conversation,false,view.reviewId);return 'Overall plan feedback is saved.';
 }
 await reviewOnehrPlanTx(tx,ctx,plan.id,plan.revision,plan.managerComment,command.text??plan.conversation,true,view.reviewId,command.heldOn??undefined);return 'The career conversation is recorded and the development plan is closed.';
}
async function proposalOrNull<T>(propose:()=>Promise<T>){try{return await propose();}catch{return null;}}
export async function getReviewConversation(ctx:SessionContext,reviewId:string,stage:ConversationStage){
 const view=await authorized(ctx,reviewId,stage);
 return withPerformanceTenant(ctx,async tx=>{
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,storedStage(stage)),eq(assessmentConversation.contextId,reviewId)));
  return {revision:row?.revision??null,messages:row?reviewConversationMessages.parse(row.messages):[],...(stage==='setting'&&view.self?{settingQuota:await assessmentAiQuotaTx(tx,ctx,`kpi_set:${view.cycle.id}`)}:{})};
 });
}
/** Provider proposals stay private. Only an explicit human command may confirm through the canonical writer. */
export async function sendReviewMessage(ctx:SessionContext,reviewId:string,stage:ConversationStage,expected:number|null,requestId:string,text:string,intent:'guide'|'draft'|'starter'='guide'){
 z.uuid().parse(requestId);const words=z.string().trim().min(1).max(2500).parse(text);z.enum(['guide','draft','starter']).parse(intent);
 const view=await authorized(ctx,reviewId,stage);
 const previous=await withPerformanceTenant(ctx,async tx=>{
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,storedStage(stage)),eq(assessmentConversation.contextId,reviewId)));
  if(!row)return null;const messages=reviewConversationMessages.parse(row.messages),index=messages.findIndex(m=>m.id===requestId);
  return index<0?null:{revision:row.revision,messages,draftUpdated:['update','action'].includes(messages[index+1]?.kind),...(stage==='setting'&&view.self?{settingQuota:await assessmentAiQuotaTx(tx,ctx,`kpi_set:${view.cycle.id}`)}:{})};
 });
 if(previous)return previous;
 let reply='';
 const humanInput=intent==='guide'?humanManagerContext(view,stage,words):null;
 const commandInput=intent==='guide'&&!humanInput&&view.aiEnabled?commandContext(view,stage,words):null;
 const evidenceInput=intent==='guide'&&!humanInput&&view.aiEnabled?evidenceContext(view,stage,words):null;
 const journey=commandInput||evidenceInput?await proposalOrNull(()=>proposeJourneyCommands(ctx,reviewId,commandInput?.facts??null,evidenceInput)):null;
 const command=journey?.review??null,evidence=journey?.evidence??null;
 const settingInput=['guide','starter'].includes(intent)&&!humanInput&&view.aiEnabled?settingContext(view,stage,words):null;
 const settingField=`kpi_set:${view.cycle.id}`;
 if(intent==='starter'){
  if(!settingInput||!view.aiFeatures.pm)throw Error('AI scorecard suggestions are unavailable for this assessment.');
  if(!settingInput.library.length)throw Error('There are no eligible library KPIs for your role yet.');
  const quota=await withPerformanceTenant(ctx,tx=>assessmentAiQuotaTx(tx,ctx,settingField));
  if(!quota.remaining)throw Error('All 5 AI scorecard suggestions have been used today. The limit resets at midnight Malaysia time.');
 }
 const starter=intent==='starter'&&settingInput?await proposalOrNull(()=>proposeSettingSuggestion(ctx,reviewId,settingInput)):null;
 if(intent==='starter'&&!starter)throw Error('Could not prepare a usable scorecard just now. You can add KPIs from the library and try again later.');
 const setting=starter??(intent==='guide'&&settingInput?await proposalOrNull(()=>proposeSettingCommands(ctx,reviewId,settingInput)):null);
 const careerInput=intent==='guide'&&!humanInput&&view.aiEnabled?careerContext(view,stage,words):null;
 const career=careerInput?await proposalOrNull(()=>proposeCareerCommands(ctx,reviewId,careerInput)):null;

 if(intent==='draft')reply=await draftOnehrNarrative(ctx,reviewId,words,stage==='competency'?'tc':stage==='career'?'idp':'pm');
 else{
  const guides={
   setting:'Build your scorecard with measurable outcomes and weights totalling 100%. HR assigns one moderator per KPI. Save your draft, then propose the scorecard for approval.',
   results:'Enter each actual result, add supporting notes, and write your overall remark. When evidence is enabled, every Above Expectation or Outstanding KPI needs a linked file. Drafts stay private until you confirm submission.',
   moderation:'Review the employee’s submitted results. Explain changes to actual results; the overall band is calculated from the moderated KPIs. Confirm only after checking the evidence.',
   competency:'Rate every assigned statement using observed examples. Draft answers and remarks remain private. A manager must explain any answer changed from the self-assessment.',
   career:'Complete your career aspiration and mobility preference, then add development goals with practical actions. Target dates are optional. Share the plan when ready; your manager records the conversation and you acknowledge it.',
   feedback:'Rate the assigned colleague using observed behaviours. Review your answers and submit through the form.',
   evidence:'Record what happened and when, then link the evidence to an objective or competency. Shared evidence can be endorsed or disputed. Correct a shared entry with a new entry to preserve its history.',
  };
  reply=guides[stage];
  if(view.manager||view.moderator){if(stage==='moderation')reply+=' To lock an entry, type “Confirm KPI: ” followed by its exact name, or “Confirm all KPI results”.';if(stage==='competency'&&view.manager)reply+=' To approve your reviewed answers, type “Approve competency review”.';if(stage==='career')reply='Review the shared plan and career profile. You can write “Career comment: …”, “Goal comment: [exact goal name]: …”, or, if assigned overall feedback, “Plan comment: …”. To record the conversation and close the shared plan, type “Close development plan on YYYY-MM-DD: …”; the date is optional.';}
 }
 // Recheck authority and graph state after a provider call, before persisting its answer.
 const fresh=await authorized(ctx,reviewId,stage);
 if((command||setting||career||evidence)&&!fresh.aiEnabled)throw Error('AI assistance or module access changed. Reload before sending again.');
 if(starter&&!fresh.aiFeatures.pm)throw Error('AI scorecard suggestions were switched off.');
 if(humanInput&&JSON.stringify(humanManagerContext(fresh,stage,words))!==JSON.stringify(humanInput))throw Error('The review entries or your assignment changed. Reload before confirming.');
 if(command&&JSON.stringify(commandContext(fresh,stage,words))!==JSON.stringify(commandInput))throw Error('Your private draft changed while preparing this response. Reload before sending again.');
 if(setting&&JSON.stringify(settingContext(fresh,stage,words))!==JSON.stringify(settingInput))throw Error('Your scorecard or eligible library changed. Reload before sending again.');
 if(career&&JSON.stringify(careerContext(fresh,stage,words))!==JSON.stringify(careerInput))throw Error('Your career profile, plan or role catalogue changed. Reload before sending again.');
 if(evidence&&JSON.stringify(evidenceContext(fresh,stage,words))!==JSON.stringify(evidenceInput))throw Error('Your check-ins or assigned KPIs changed. Reload before sending again.');
 if(fresh.revision!==view.revision)throw Error('The assessment changed while preparing this response. Try again with the current record.');
 return withPerformanceTenant(ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${reviewId}:${ctx.userId}:${storedStage(stage)}`},0))`);
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,storedStage(stage)),eq(assessmentConversation.contextId,reviewId))).for('update');
  const messages=row?reviewConversationMessages.parse(row.messages):[];
  const duplicate=messages.findIndex(m=>m.id===requestId);if(duplicate>=0)return {revision:row!.revision,messages,draftUpdated:['update','action'].includes(messages[duplicate+1]?.kind),...(stage==='setting'&&view.self?{settingQuota:await assessmentAiQuotaTx(tx,ctx,settingField)}:{})};
  if((row?.revision??null)!==expected)throw Error('This conversation changed. Reload before sending another message.');
  if(messages.length>296)throw Error('This conversation has reached its limit. Your saved review and full conversation remain available.');
  if((command||setting||career||evidence)&&!await assessmentAiConfigTx(tx,ctx))throw Error('AI assistance or module access changed.');
  if(intent==='draft'&&!(await assessmentAiFeatureEnabledTx(tx,ctx,stage==='competency'?'tc':stage==='career'?'idp':'pm')))throw Error('AI drafting was switched off.');
  if(humanInput)reply=await applyHumanManagerCommand(tx,ctx,view,humanInput);
  if(command&&commandInput){await saveAssessmentDraftTx(tx,ctx,reviewId,view.revision,commandInput.draftRevision,command.draft);reply='Private draft updated. Review the form, then confirm submission when ready.';}
  if(setting){
   if(starter&&!(await assessmentAiFeatureEnabledTx(tx,ctx,'pm')))throw Error('AI scorecard suggestions were switched off.');
   if(starter)await recordAssessmentAiUseTx(tx,ctx,reviewId,settingField,requestId);
   await saveOnehrKpisTx(tx,ctx,reviewId,view.revision,setting.kpis,false,starter?.aiBases);
   reply='Scorecard draft updated. Review the form, then propose it for approval when ready.';
  }
  if(career&&careerInput){
   if(career.goalsChanged)await saveOnehrPlanTx(tx,ctx,reviewId,careerInput.planRevision,{career:career.career,careerRevision:careerInput.careerRevision,goals:career.goals});
   else await saveAssessmentCareerProfileTx(tx,ctx,reviewId,careerInput.careerRevision,career.career);
   reply='Changes saved. Review your career profile and plan. Sharing and acknowledgment use the form.';
  }
  if(evidence){
   let revision=view.revision;
   for(const c of evidence.commands){
    if(c.action==='log_evidence')await addOnehrEvidenceTx(tx,ctx,reviewId,{...c.fields,state:'shared',supersedesId:null,links:c.links});
    else {await saveOnehrKpiCheckInTx(tx,ctx,reviewId,revision,c.id,c.answer,c.note);revision++;}
   }
   reply='Evidence and check-in changes saved. Review the updated record.';
  }
  const updated=!!humanInput||!!command||!!setting||!!career||!!evidence;
  const now=new Date().toISOString();
  const next:ReviewMessage[]=[...messages,{id:requestId,role:'user',text:words,at:now,kind:'message'},...(reply?[{id:crypto.randomUUID(),role:'assistant' as const,text:reply,at:now,kind:humanInput?'action' as const:updated?'update' as const:intent==='starter'?'guide' as const:intent}]:[])];
  const [saved]=row?await tx.update(assessmentConversation).set({messages:next,revision:row.revision+1,updatedAt:new Date()}).where(eq(assessmentConversation.id,row.id)).returning():await tx.insert(assessmentConversation).values({tenantId:ctx.tenantId,reviewId,actorUserId:ctx.userId!,stage:storedStage(stage),contextId:reviewId,messages:next}).returning();
  return {revision:saved.revision,messages:next,draftUpdated:updated,...(stage==='setting'&&view.self?{settingQuota:await assessmentAiQuotaTx(tx,ctx,settingField)}:{})};
 });
}
