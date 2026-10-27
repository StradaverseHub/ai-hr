import {issuePerformanceMessageSpendTaskTx,type PerformanceMessageSpendTask} from '../../../core/ai-spend-task';
import {assertPerformanceProviderSourceTx} from './provider-source-authority';
import {assessmentHelp} from './help';
import { competencyGuidance } from './competency-guide-model';
import { competencyReflectionSchema,literalCompetencyReflection } from './review-command-model';
import { assessmentAiConfigTx,assessmentAiFeatureEnabledTx } from './ai-settings';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext,Tx } from '../../../db/client';
import { assessmentConversation } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { getOnehrReview,getOnehrReviewTx, saveAssessmentDraftTx, saveOnehrKpisTx, saveAssessmentCareerProfileTx, saveOnehrPlanTx, addOnehrEvidenceTx, saveOnehrKpiCheckInTx,moderateOnehrKpiTx,submitAssessmentModerationTx,confirmOnehrPerformanceTx,submitOnehrCompetenciesTx,commentAssessmentCareerProfileTx,reviewOnehrPlanTx,editAssessmentDevelopmentGoalTx } from './service';
import { assessmentDraftSchema } from './journey-model';
import { proposeSettingCommands, proposeSettingSuggestion, proposeCareerCommands, proposeJourneyCommands } from './review-command-ai';
import { assessmentAiQuotaTx,recordAssessmentAiUseTx } from './ai-usage';
import { careerSchema } from './model';
import { readManagerCommand } from './manager-command-model';
import { draftOnehrNarrative } from './ai';

export const conversationStage=z.enum(['setting','results','moderation','competency','career','evidence','feedback']);
export type ConversationStage=z.infer<typeof conversationStage>;
const storedStage=(stage:ConversationStage)=>stage==='setting'||stage==='evidence'?stage:'journey';
const messageSchema=z.object({id:z.uuid(),role:z.enum(['user','assistant']),text:z.string().max(6000),at:z.iso.datetime(),kind:z.enum(['guide','draft','message','update','action']),reflection:competencyReflectionSchema.optional(),keptReflectionId:z.uuid().optional(),guidance:z.boolean().optional()});
export type ReviewMessage=z.infer<typeof messageSchema>;
export const reviewConversationMessages=z.array(messageSchema).max(300);
async function authorized(ctx:SessionContext,reviewId:string,stage:ConversationStage){
 return withPerformanceTenant(ctx,tx=>authorizedTx(tx,ctx,reviewId,stage));
}
async function authorizedTx(tx:Tx,ctx:SessionContext,reviewId:string,stage:ConversationStage){
 z.uuid().parse(reviewId);conversationStage.parse(stage);if(stage==='feedback')throw Error('Use the assigned colleague feedback conversation.');
 const v=await getOnehrReviewTx(tx,ctx,reviewId);
 if(!v||!v.self&&!v.manager&&!v.moderator)throw Error('This review conversation is not assigned to you.');
 if(v.policy.modules.review===false)throw Error('Guided review is disabled.');
 if(['setting','results','moderation'].includes(stage)&&!v.policy.modules.pm||stage==='competency'&&!v.policy.modules.tm||stage==='career'&&!v.policy.modules.idp||stage==='evidence'&&!v.policy.modules.evidence)throw Error('This review module is disabled.');
 return v;
}
function commandContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 const reading=stage==='competency'&&view.self&&/^read saved reflection:/i.test(text.trim());
 if(!reading&&(view.finalized||view.policy.kind==='quarterly'))return null;
 const kind=stage==='results'&&view.self?'results':stage==='moderation'&&(view.manager||view.moderator)?'moderation':stage==='competency'&&view.self?'competency_self':stage==='competency'&&view.manager?'competency_manager':null;
 if(!kind||kind==='results'&&view.resultsSubmitted||kind==='moderation'&&!view.canModerateIds.length||kind==='competency_self'&&!reading&&view.competencyStatus!=='pending'||kind==='competency_manager'&&view.competencyStatus!=='submitted')return null;
 const prior=reading&&view.competencyStatus!=='pending'?undefined:view.drafts.find(d=>d.kind===kind);
 const kpis=view.kpis.filter(k=>!k.hrOwned&&(kind==='results'||view.canModerateIds.includes(k.id)));
 const draft=assessmentDraftSchema.parse(prior?.payload??(kind==='results'||kind==='moderation'?{kind,lines:kpis.map(k=>({id:k.id,actual:kind==='results'?k.actual:k.approvedActual??k.actual,note:kind==='results'?k.note:k.moderationRemark})),remark:kind==='results'?view.selfRemark:view.ownReviewerRemark}:{kind,sections:kind==='competency_self'?view.competencySelfSections:view.competencyManagerSections,answers:Object.fromEntries(view.competencies.map(c=>[c.id,{answer:kind==='competency_self'?c.self:c.manager??c.self,remark:kind==='competency_self'?c.selfRemark??'':c.managerRemark}])),remark:kind==='competency_self'?view.competencySelfRemark:view.competencyManagerRemark}));
 const targets=(kind==='results'||kind==='moderation'?kpis.map(k=>({id:k.id,label:k.title})):view.competencies.map(c=>({id:c.id,label:c.text,...(c.skillTitle?{competency:{title:c.skillTitle,category:c.principle,future:c.future}}:{})})));
 return {facts:{text,draft,targets},draftRevision:prior?.revision??null};
}
function settingContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 if(stage!=='setting'||!view.self||view.finalized||view.kpis.some(k=>k.hrOwned||['approved','proposed'].includes(k.setting)))return null;
 return {text,kpis:view.kpis,library:view.kpiLibrary,moderatorEmploymentId:view.reviewerEmploymentId};
}
function careerContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 if(stage!=='career'||!view.self||view.finalized)return null;
 const plan=view.plans.find(p=>p.planYear===view.planYear);
 return {text,career:careerSchema.parse(view.careerProfile?.career??{aspiration:'',mobility:null,mobilityNote:'',targetProfileId:null,selfProfileId:null}),careerRevision:view.careerProfile?.revision??null,planRevision:plan?.revision??null,goals:plan?.goals??[],canEditCareer:!plan||plan.status==='draft'||!view.careerProfile?.career.mobility||![view.careerProfile.career.aspiration,view.careerProfile.career.aspirationNow,view.careerProfile.career.aspirationLong].some(s=>s?.trim()),canEditGoals:view.policy.kind==='year_end'&&(!plan||plan.status==='draft'),roles:view.careerDirections.map(p=>({id:p.id,label:`${p.jobTitle??p.name} · ${p.grade}${p.department?` · ${p.department}`:''}`}))};
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
  await submitOnehrCompetenciesTx(tx,ctx,view.reviewId,view.revision,answers,true,privateDraft.remark,privateDraft.sections??{});return 'The competency review is approved.';
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
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 z.uuid().parse(requestId);const words=z.string().trim().min(1).max(2500).parse(text);z.enum(['guide','draft','starter']).parse(intent);
 const view=await authorized(ctx,reviewId,stage);
 const previous=await withPerformanceTenant(ctx,async tx=>{
  // A completed earlier authorization cannot admit a historical reply after stage policy changes.
  // Hold the actual native source interval across the fresh gate, messages and optional quota read.
  await assertPerformanceProviderSourceTx(tx,ctx);const current=await authorizedTx(tx,ctx,reviewId,stage);
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,storedStage(stage)),eq(assessmentConversation.contextId,reviewId)));
  if(!row)return null;const messages=reviewConversationMessages.parse(row.messages),index=messages.findIndex(m=>m.id===requestId);
  return index<0?null:{revision:row.revision,messages,draftUpdated:['update','action'].includes(messages[index+1]?.kind),...(stage==='setting'&&current.self?{settingQuota:await assessmentAiQuotaTx(tx,ctx,`kpi_set:${current.cycle.id}`)}:{})};
 });
 if(previous)return previous;
 let spendIntent:Promise<PerformanceMessageSpendTask>|undefined;
 const spendTask=()=>spendIntent??=(withPerformanceTenant(ctx,async tx=>{await assertPerformanceProviderSourceTx(tx,ctx);await authorizedTx(tx,ctx,reviewId,stage);return issuePerformanceMessageSpendTaskTx(tx,ctx,{reviewId,contextId:reviewId,requestId,channel:stage});}));
 let reply='';
 const help=intent==='guide'?await assessmentHelp(ctx,words):null;
 const humanInput=intent==='guide'&&!help?humanManagerContext(view,stage,words):null;
 const commandInput=intent==='guide'&&!help&&!humanInput?commandContext(view,stage,words):null;
 const reflection=intent==='guide'&&stage==='competency'&&commandInput?literalCompetencyReflection(words,commandInput.facts):null;
 const evidenceInput=intent==='guide'&&!help&&!humanInput&&view.aiEnabled?evidenceContext(view,stage,words):null;
 const journey=!reflection&&view.aiEnabled&&(commandInput||evidenceInput)?await proposalOrNull(async ()=>proposeJourneyCommands(ctx,reviewId,commandInput?.facts??null,evidenceInput,async tx=>{const fresh=await authorizedTx(tx,ctx,reviewId,stage);if(!fresh.aiEnabled)throw Error('AI review assistance is unavailable.');return {review:commandInput?commandContext(fresh,stage,words)?.facts??null:null,evidence:evidenceInput?evidenceContext(fresh,stage,words):null};},await spendTask())):null;
 const command=reflection??journey?.review??null,evidence=journey?.evidence??null;
 const settingInput=['guide','starter'].includes(intent)&&!help&&!humanInput&&view.aiEnabled?settingContext(view,stage,words):null;
 const settingField=`kpi_set:${view.cycle.id}`;
 if(intent==='starter'){
  if(!settingInput||!view.aiFeatures.pm)throw Error('AI scorecard suggestions are unavailable for this assessment.');
  if(!settingInput.library.length)throw Error('There are no eligible library KPIs for your role yet.');
  const quota=await withPerformanceTenant(ctx,tx=>assessmentAiQuotaTx(tx,ctx,settingField));
  if(!quota.remaining)throw Error('All 5 AI scorecard suggestions have been used today. The limit resets at midnight Malaysia time.');
 }
 const starter=intent==='starter'&&settingInput?await proposalOrNull(()=>proposeSettingSuggestion(ctx,reviewId,settingInput,async tx=>{const fresh=await authorizedTx(tx,ctx,reviewId,stage);if(!(await assessmentAiQuotaTx(tx,ctx,settingField)).remaining)throw Error('Current scorecard drafting allowance is unavailable.');return fresh.aiEnabled?settingContext(fresh,stage,words):null;})):null;
 if(intent==='starter'&&!starter)throw Error('Could not prepare a usable scorecard just now. You can add KPIs from the library and try again later.');
 const setting=starter??(intent==='guide'&&settingInput?await proposalOrNull(async ()=>proposeSettingCommands(ctx,reviewId,settingInput,async tx=>{const fresh=await authorizedTx(tx,ctx,reviewId,stage);return fresh.aiEnabled?settingContext(fresh,stage,words):null;},await spendTask())):null);
 const careerInput=intent==='guide'&&!help&&!humanInput&&view.aiEnabled?careerContext(view,stage,words):null;
 const career=careerInput?await proposalOrNull(async ()=>proposeCareerCommands(ctx,reviewId,careerInput,async tx=>{const fresh=await authorizedTx(tx,ctx,reviewId,stage);return fresh.aiEnabled?careerContext(fresh,stage,words):null;},await spendTask())):null;

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
 if((command&&!reflection||setting||career||evidence)&&!fresh.aiEnabled)throw Error('AI assistance or module access changed. Reload before sending again.');
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
  if((command&&!reflection||setting||career||evidence)&&!await assessmentAiConfigTx(tx,ctx))throw Error('AI assistance or module access changed.');
  if(intent==='draft'&&!(await assessmentAiFeatureEnabledTx(tx,ctx,stage==='competency'?'tc':stage==='career'?'idp':'pm')))throw Error('AI drafting was switched off.');
  if(humanInput)reply=await applyHumanManagerCommand(tx,ctx,view,humanInput);
  if(command?.changed&&commandInput){await saveAssessmentDraftTx(tx,ctx,reviewId,view.revision,commandInput.draftRevision,command.draft);reply='Private draft updated. Review the form, then confirm submission when ready.';}
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
  if(help)reply=help;
 const guided=stage==='competency'&&view.self&&intent==='guide'&&!help&&!command?.reflection;
  if(guided){const draft=command?.draft??commandContext(fresh,stage,words)?.facts.draft;reply=(command?.changed?'Your private draft is updated. ':'')+competencyGuidance(fresh.competencies,draft?.kind==='competency_self'?draft:null,messages.some(m=>m.role==='assistant'&&m.text.includes('in 50-100 words, tell me your strengths')));}
  if(command?.reflection)reply=command.reflection.isDraft?'Review this proposed reflection. It is kept only when you choose Save reflection.':'This is your saved reflection.';
  const updated=!!humanInput||!!command?.changed||!!setting||!!career||!!evidence;
  const now=new Date().toISOString();
  const next:ReviewMessage[]=[...messages,{id:requestId,role:'user',text:words,at:now,kind:'message'},...(reply?[{id:crypto.randomUUID(),role:'assistant' as const,text:reply,at:now,...(command?.reflection?{reflection:command.reflection}:{}),...(guided?{guidance:true}:{}),kind:command?.reflection?(command.reflection.isDraft?'draft' as const:'guide' as const):humanInput?'action' as const:updated?'update' as const:intent==='starter'?'guide' as const:intent}]:[])];
  const [saved]=row?await tx.update(assessmentConversation).set({messages:next,revision:row.revision+1,updatedAt:new Date()}).where(eq(assessmentConversation.id,row.id)).returning():await tx.insert(assessmentConversation).values({tenantId:ctx.tenantId,reviewId,actorUserId:ctx.userId!,stage:storedStage(stage),contextId:reviewId,messages:next}).returning();
  return {revision:saved.revision,messages:next,draftUpdated:updated,...(stage==='setting'&&view.self?{settingQuota:await assessmentAiQuotaTx(tx,ctx,settingField)}:{})};
 });
}

/** Explicit human keep of a server-stored card, merged through the ordinary private draft writer. */
export async function keepCompetencyReflection(ctx:SessionContext,reviewId:string,messageId:string){
 z.uuid().parse(messageId);const view=await authorized(ctx,reviewId,'competency'),input=commandContext(view,'competency','');
 if(!view.self||input?.facts.draft.kind!=='competency_self')throw Error('This competency reflection is no longer editable.');
 return withPerformanceTenant(ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${reviewId}:${ctx.userId}:journey`},0))`);
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,'journey'),eq(assessmentConversation.contextId,reviewId))).for('update');
  if(!row)throw Error('Reflection card not found.');const messages=reviewConversationMessages.parse(row.messages),card=messages.find(m=>m.id===messageId&&m.role==='assistant')?.reflection;
  if(!card?.isDraft)throw Error('Choose a proposed reflection from your own conversation.');
  if(messages.some(m=>m.keptReflectionId===messageId))return {revision:row.revision,messages,draftUpdated:false};
  const draft=input.facts.draft;if(draft.kind!=='competency_self')throw Error('Choose your own competency.');
  const line=draft.answers[card.id];if(!line?.answer||!view.competencies.some(c=>c.id===card.id))throw Error('This competency is no longer assigned and answered.');
  if(line.remark!==card.originalNote)throw Error('This reflection changed after the card was prepared. Review your current words before drafting again.');
  if(messages.length>=300)throw Error('This conversation has reached its limit. Use the reflection field on the review form.');
  line.remark=card.text;
  await saveAssessmentDraftTx(tx,ctx,reviewId,view.revision,input.draftRevision,draft);
  const next:ReviewMessage[]=[...messages,{id:crypto.randomUUID(),role:'assistant',kind:'update',text:'Reflection saved in your private draft.',at:new Date().toISOString(),keptReflectionId:messageId}];
  const [saved]=await tx.update(assessmentConversation).set({messages:next,revision:row.revision+1,updatedAt:new Date()}).where(eq(assessmentConversation.id,row.id)).returning();
  return {revision:saved.revision,messages:next,draftUpdated:true};
 });
}
