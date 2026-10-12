import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext } from '../../../db/client';
import { assessmentConversation } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { getOnehrReview } from './service';
import { draftOnehrNarrative } from './ai';

export const conversationStage=z.enum(['setting','results','moderation','competency','career','evidence']);
export type ConversationStage=z.infer<typeof conversationStage>;
const storedStage=(stage:ConversationStage)=>stage==='setting'||stage==='evidence'?stage:'journey';
const messageSchema=z.object({id:z.uuid(),role:z.enum(['user','assistant']),text:z.string().max(6000),at:z.iso.datetime(),kind:z.enum(['guide','draft','message'])});
export type ReviewMessage=z.infer<typeof messageSchema>;
export const reviewConversationMessages=z.array(messageSchema).max(300);
async function authorized(ctx:SessionContext,reviewId:string,stage:ConversationStage){
 z.uuid().parse(reviewId);conversationStage.parse(stage);
 const v=await getOnehrReview(ctx,reviewId);
 if(!v||!v.self&&!v.manager)throw Error('This review conversation is not assigned to you.');
 if(['setting','results','moderation'].includes(stage)&&!v.policy.modules.pm||stage==='competency'&&!v.policy.modules.tm||stage==='career'&&!v.policy.modules.idp||stage==='evidence'&&!v.policy.modules.evidence)throw Error('This review module is disabled.');
 return v;
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
 let reply='';
 if(intent==='draft')reply=await draftOnehrNarrative(ctx,reviewId,words);
 else{
  const guides={
   setting:'Build your scorecard with measurable outcomes and weights totalling 100%. HR assigns one moderator per KPI. Save your draft, then propose the scorecard for approval.',
   results:'Enter each actual result, add supporting notes, and write your overall remark. When evidence is enabled, every Above Expectation or Outstanding KPI needs a linked file. Drafts stay private until you confirm submission.',
   moderation:'Review the employee’s submitted results. Explain changes to actual results; the overall band is calculated from the moderated KPIs. Confirm only after checking the evidence.',
   competency:'Rate every assigned statement using observed examples. Draft answers and remarks remain private. A manager must explain any answer changed from the self-assessment.',
   career:'Complete your career aspiration and mobility preference, then add development goals with dates and actions. Share the plan when ready; your manager records the conversation and you acknowledge it.',
   evidence:'Record what happened and when, then link the evidence to an objective or competency. Shared evidence can be endorsed or disputed. Correct a shared entry with a new entry to preserve its history.',
  };
  reply=guides[stage];
 }
 // Recheck authority and graph state after a provider call, before persisting its answer.
 const fresh=await authorized(ctx,reviewId,stage);
 if(fresh.revision!==view.revision)throw Error('The assessment changed while preparing this response. Try again with the current record.');
 return withPerformanceTenant(ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${reviewId}:${ctx.userId}:${storedStage(stage)}`},0))`);
  const [row]=await tx.select().from(assessmentConversation).where(and(eq(assessmentConversation.reviewId,reviewId),eq(assessmentConversation.actorUserId,ctx.userId!),eq(assessmentConversation.stage,storedStage(stage)))).for('update');
  const messages=row?reviewConversationMessages.parse(row.messages):[];
  if(messages.some(m=>m.id===requestId))return {revision:row!.revision,messages};
  if((row?.revision??null)!==expected)throw Error('This conversation changed. Reload before sending another message.');
  if(messages.length>296)throw Error('This conversation has reached its limit. Your saved review and full conversation remain available.');
  const now=new Date().toISOString();
  const next:ReviewMessage[]=[...messages,{id:requestId,role:'user',text:words,at:now,kind:'message'},...(reply?[{id:crypto.randomUUID(),role:'assistant' as const,text:reply,at:now,kind:intent}]:[])];
  const [saved]=row?await tx.update(assessmentConversation).set({messages:next,revision:row.revision+1,updatedAt:new Date()}).where(eq(assessmentConversation.id,row.id)).returning():await tx.insert(assessmentConversation).values({tenantId:ctx.tenantId,reviewId,actorUserId:ctx.userId!,stage:storedStage(stage),messages:next}).returning();
  return {revision:saved.revision,messages:next};
 });
}
