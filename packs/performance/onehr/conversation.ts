import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext } from '../../../db/client';
import { assessmentConversation } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { getOnehrReview, saveAssessmentDraftTx, saveOnehrKpisTx } from './service';
import { assessmentDraftSchema } from './journey-model';
import { proposeReviewCommands, proposeSettingCommands } from './review-command-ai';
import { draftOnehrNarrative } from './ai';

export const conversationStage=z.enum(['setting','results','moderation','competency','career','evidence']);
export type ConversationStage=z.infer<typeof conversationStage>;
const storedStage=(stage:ConversationStage)=>stage==='setting'||stage==='evidence'?stage:'journey';
const messageSchema=z.object({id:z.uuid(),role:z.enum(['user','assistant']),text:z.string().max(6000),at:z.iso.datetime(),kind:z.enum(['guide','draft','message','update'])});
export type ReviewMessage=z.infer<typeof messageSchema>;
export const reviewConversationMessages=z.array(messageSchema).max(300);
async function authorized(ctx:SessionContext,reviewId:string,stage:ConversationStage){
 z.uuid().parse(reviewId);conversationStage.parse(stage);
 const v=await getOnehrReview(ctx,reviewId);
 if(!v||!v.self&&!v.manager&&!v.moderator)throw Error('This review conversation is not assigned to you.');
 if(['setting','results','moderation'].includes(stage)&&!v.policy.modules.pm||stage==='competency'&&!v.policy.modules.tm||stage==='career'&&!v.policy.modules.idp||stage==='evidence'&&!v.policy.modules.evidence)throw Error('This review module is disabled.');
 return v;
}
function commandContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 if(view.finalized||view.policy.kind==='quarterly')return null;
 const kind=stage==='results'&&view.self?'results':stage==='moderation'&&(view.manager||view.moderator)?'moderation':stage==='competency'&&view.self?'competency_self':stage==='competency'&&view.manager?'competency_manager':null;
 if(!kind)return null;
 const prior=view.drafts.find(d=>d.kind===kind);
 const kpis=view.kpis.filter(k=>!k.hrOwned&&(kind==='results'||view.canModerateIds.includes(k.id)));
 const draft=assessmentDraftSchema.parse(prior?.payload??(kind==='results'||kind==='moderation'?{kind,lines:kpis.map(k=>({id:k.id,actual:kind==='results'?k.actual:k.approvedActual??k.actual,note:kind==='results'?k.note:k.moderationRemark})),remark:kind==='results'?view.selfRemark:view.managerRemark}:{kind,answers:Object.fromEntries(view.competencies.map(c=>[c.id,{answer:kind==='competency_self'?c.self:c.manager??c.self,remark:kind==='competency_self'?c.selfRemark??'':c.managerRemark}])),remark:kind==='competency_self'?view.competencySelfRemark:view.competencyManagerRemark}));
 const targets=(kind==='results'||kind==='moderation'?kpis.map(k=>({id:k.id,label:k.title})):view.competencies.map(c=>({id:c.id,label:c.text})));
 return {facts:{text,draft,targets},draftRevision:prior?.revision??null};
}
function settingContext(view:NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>,stage:ConversationStage,text:string){
 if(stage!=='setting'||!view.self||view.finalized||view.kpis.some(k=>k.hrOwned||['approved','proposed'].includes(k.setting)))return null;
 return {text,kpis:view.kpis,library:view.kpiLibrary,moderatorEmploymentId:view.reviewerEmploymentId};
}
export async function getReviewConversation(ctx:SessionContext,reviewId:string,stage:ConversationStage){
 await authorized(ctx,reviewId,stage);
 return withPerformanceTenant(ctx,async tx=>{
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,storedStage(stage))));
  return {revision:row?.revision??null,messages:row?reviewConversationMessages.parse(row.messages):[]};
 });
}
/** Messages and evidence are private to this actor. A response never submits a form or changes a rating. */
export async function sendReviewMessage(ctx:SessionContext,reviewId:string,stage:ConversationStage,expected:number|null,requestId:string,text:string,intent:'guide'|'draft'='guide'){
 z.uuid().parse(requestId);const words=z.string().trim().min(1).max(2500).parse(text);z.enum(['guide','draft']).parse(intent);
 const view=await authorized(ctx,reviewId,stage);
 const previous=await withPerformanceTenant(ctx,async tx=>{
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,storedStage(stage))));
  if(!row)return null;const messages=reviewConversationMessages.parse(row.messages),index=messages.findIndex(m=>m.id===requestId);
  return index<0?null:{revision:row.revision,messages,draftUpdated:messages[index+1]?.kind==='update'};
 });
 if(previous)return previous;
 let reply='';
 const commandInput=intent==='guide'&&view.aiEnabled?commandContext(view,stage,words):null;
 const command=commandInput?await proposeReviewCommands(ctx,reviewId,commandInput.facts):null;
 const settingInput=intent==='guide'&&view.aiEnabled?settingContext(view,stage,words):null;
 const setting=settingInput?await proposeSettingCommands(ctx,reviewId,settingInput):null;
 if(intent==='draft')reply=await draftOnehrNarrative(ctx,reviewId,words);
 else{
  const guides={
   setting:'Build your scorecard with measurable outcomes and weights totalling 100%. HR assigns one moderator per KPI. Save your draft, then propose the scorecard for approval.',
   results:'Enter each actual result, add supporting notes, and write your overall remark. When evidence is enabled, every Above Expectation or Outstanding KPI needs a linked file. Drafts stay private until you confirm submission.',
   moderation:'Review the employee’s submitted results. Explain changes to actual results; the overall band is calculated from the moderated KPIs. Confirm only after checking the evidence.',
   competency:'Rate every assigned statement using observed examples. Draft answers and remarks remain private. A manager must explain any answer changed from the self-assessment.',
   career:'Complete your career aspiration and mobility preference, then add development goals with practical actions. Target dates are optional. Share the plan when ready; your manager records the conversation and you acknowledge it.',
   evidence:'Record what happened and when, then link the evidence to an objective or competency. Shared evidence can be endorsed or disputed. Correct a shared entry with a new entry to preserve its history.',
  };
  reply=guides[stage];
 }
 // Recheck authority and graph state after a provider call, before persisting its answer.
 const fresh=await authorized(ctx,reviewId,stage);
 if(command&&JSON.stringify(commandContext(fresh,stage,words))!==JSON.stringify(commandInput))throw Error('Your private draft changed while preparing this response. Reload before sending again.');
 if(setting&&JSON.stringify(settingContext(fresh,stage,words))!==JSON.stringify(settingInput))throw Error('Your scorecard or eligible library changed. Reload before sending again.');
 if(fresh.revision!==view.revision)throw Error('The assessment changed while preparing this response. Try again with the current record.');
 return withPerformanceTenant(ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${reviewId}:${ctx.userId}:${storedStage(stage)}`},0))`);
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,storedStage(stage)))).for('update');
  const messages=row?reviewConversationMessages.parse(row.messages):[];
  const duplicate=messages.findIndex(m=>m.id===requestId);if(duplicate>=0)return {revision:row!.revision,messages,draftUpdated:messages[duplicate+1]?.kind==='update'};
  if((row?.revision??null)!==expected)throw Error('This conversation changed. Reload before sending another message.');
  if(messages.length>296)throw Error('This conversation has reached its limit. Your saved review and full conversation remain available.');
  if(command&&commandInput){await saveAssessmentDraftTx(tx,ctx,reviewId,view.revision,commandInput.draftRevision,command.draft);reply='Private draft updated. Review the form, then confirm submission when ready.';}
  if(setting){await saveOnehrKpisTx(tx,ctx,reviewId,view.revision,setting.kpis);reply='Scorecard draft updated. Review the form, then propose it for approval when ready.';}
  const updated=!!command||!!setting;
  const now=new Date().toISOString();
  const next:ReviewMessage[]=[...messages,{id:requestId,role:'user',text:words,at:now,kind:'message'},...(reply?[{id:crypto.randomUUID(),role:'assistant' as const,text:reply,at:now,kind:updated?'update' as const:intent}]:[])];
  const [saved]=row?await tx.update(assessmentConversation).set({messages:next,revision:row.revision+1,updatedAt:new Date()}).where(eq(assessmentConversation.id,row.id)).returning():await tx.insert(assessmentConversation).values({tenantId:ctx.tenantId,reviewId,actorUserId:ctx.userId!,stage:storedStage(stage),messages:next}).returning();
  return {revision:saved.revision,messages:next,draftUpdated:updated};
 });
}
