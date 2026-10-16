/** Existing Feedback workflow handoff, not a model tool or generic AI mutation adapter. */
import {randomUUID,createHash} from 'node:crypto';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type Tx} from '../db/client';
import * as s from '../db/schema';
import {freshConversationIdentity,conversationAuthorityTx,readConversationTx,conversationViewTx,recordConversationReplyTx} from './assistant-conversation';
import {AssistantConversationError,type AssistantConversationCopy} from '../lib/assistant-conversation-model';
import {ownLiveEmploymentSubjectsTx,ownLiveEmploymentTx} from './own-employment-selection';
import {submitFeedback} from './feedback';
const prepare=z.object({conversationId:z.string().uuid(),conversationRevision:z.number().int().min(1),exchangeId:z.string().uuid(),requestId:z.string().uuid()}).strict();
const submit=z.object({draftId:z.string().uuid(),expectedRevision:z.number().int().min(1),reporterEmploymentId:z.string().uuid().nullable(),category:z.enum(['issue','enhancement','new_function']),title:z.string().trim().min(1).max(200),description:z.string().trim().min(1).max(8000),expectedBehavior:z.string().trim().max(8000).nullable(),expectedFunction:z.string().trim().max(8000).nullable()}).strict();
const digest=(p:z.infer<typeof submit>)=>createHash('sha256').update(JSON.stringify([p.reporterEmploymentId,p.category,p.title,p.description,p.expectedBehavior,p.expectedFunction])).digest('hex');
export async function prepareAssistantFeedbackDraft(raw:unknown,copy:AssistantConversationCopy){const p=prepare.parse(raw),identity=await freshConversationIdentity();const result=await withTenant(identity.ctx,async tx=>{
 const live=await conversationAuthorityTx(tx,identity),conversation=await readConversationTx(tx,live,p.conversationId,true);if(!conversation)return null;
 const [existing]=await tx.select().from(s.assistantFeedbackDraft).where(and(eq(s.assistantFeedbackDraft.conversationId,conversation.id),eq(s.assistantFeedbackDraft.sourceExchangeId,p.exchangeId))).limit(1);
 if(existing){if(existing.feedbackId||existing.expiresAt.getTime()>Date.now())return {id:existing.id,view:await conversationViewTx(tx,conversation)};throw new AssistantConversationError('expired');}
 if(conversation.pendingRequestId)throw new AssistantConversationError('busy');if(conversation.revision!==p.conversationRevision)throw new AssistantConversationError('stale');
 const [source]=await tx.select({id:s.assistantConversationTurn.id}).from(s.assistantConversationTurn).where(and(eq(s.assistantConversationTurn.conversationId,conversation.id),eq(s.assistantConversationTurn.exchangeId,p.exchangeId))).limit(1);if(!source)throw new AssistantConversationError('notFound');
 const id=randomUUID(),reply=await recordConversationReplyTx(tx,live,copy.feedbackDraft,{kind:'draftHandoff',text:copy.feedbackDraftHelp,draftId:id,draftRevision:1,handoff:{route:'feedback',label:copy.routes.feedback},evidence:[],links:[],tables:[]});
 await tx.insert(s.assistantFeedbackDraft).values({id,tenantId:live.ctx.tenantId,appUserId:live.ctx.userId!,conversationId:conversation.id,sourceExchangeId:p.exchangeId,handoffExchangeId:reply.exchangeId});
 await tx.insert(s.assistantConversationTurn).values({tenantId:live.ctx.tenantId,appUserId:live.ctx.userId!,conversationId:conversation.id,requestId:p.requestId,revision:conversation.revision+1,exchangeId:reply.exchangeId});
 const [updated]=await tx.update(s.assistantConversation).set({revision:conversation.revision+1}).where(eq(s.assistantConversation.id,conversation.id)).returning();
 return {id,view:await conversationViewTx(tx,updated!)};
 });if(!result)throw new AssistantConversationError('scopeChanged');return result;}
export async function readAssistantFeedbackDraft(id:string){z.string().uuid().parse(id);const identity=await freshConversationIdentity();const result=await withTenant(identity.ctx,async tx=>{
 const live=await conversationAuthorityTx(tx,identity),[row]=await tx.select().from(s.assistantFeedbackDraft).where(eq(s.assistantFeedbackDraft.id,id)).limit(1);if(!row)throw new AssistantConversationError('notFound');
 if(!await readConversationTx(tx,live,row.conversationId))return null;if(!row.feedbackId&&row.expiresAt.getTime()<=Date.now())throw new AssistantConversationError('expired');
 const [source]=await tx.select({question:s.assistantExchange.question}).from(s.assistantExchange).where(eq(s.assistantExchange.id,row.sourceExchangeId)).limit(1);if(!source)throw new AssistantConversationError('notFound');
 const subjects=await ownLiveEmploymentSubjectsTx(tx,live.ctx);
 return {id:row.id,revision:row.revision,feedbackId:row.feedbackId,category:'enhancement' as const,title:source.question.slice(0,160),description:source.question,subjects:subjects.filter(subject=>live.scopeIds.includes(subject.companyProof.companyId!)).map(subject=>({id:subject.employmentId,label:[subject.employeeCode,subject.company].filter(Boolean).join(' · ')}))};
 });if(!result)throw new AssistantConversationError('scopeChanged');return result;}
/** Requires the separately reviewed canonical Feedback user-only + explicit-Tx seam (Credit16db/2c).
 * No fake or borrowed employment. The real writer and consumed-link commit in this exact transaction. */
export async function submitAssistantFeedbackDraft(raw:unknown){const p=submit.parse(raw),identity=await freshConversationIdentity();const result=await withTenant(identity.ctx,async tx=>{
 const live=await conversationAuthorityTx(tx,identity);const [visible]=await tx.select({conversationId:s.assistantFeedbackDraft.conversationId}).from(s.assistantFeedbackDraft).where(eq(s.assistantFeedbackDraft.id,p.draftId)).limit(1);if(!visible)throw new AssistantConversationError('notFound');
 const conversation=await readConversationTx(tx,live,visible.conversationId,true);if(!conversation)return null;
 const [row]=await tx.select().from(s.assistantFeedbackDraft).where(eq(s.assistantFeedbackDraft.id,p.draftId)).limit(1).for('update');if(!row)throw new AssistantConversationError('notFound');const fingerprint=digest(p);
 if(row.feedbackId){if(row.submitDigest!==fingerprint)throw new AssistantConversationError('stale');return {feedbackId:row.feedbackId,created:false};}
 if(row.revision!==p.expectedRevision||row.expiresAt.getTime()<=Date.now())throw new AssistantConversationError('stale');
 if(p.reporterEmploymentId){const own=await ownLiveEmploymentTx(tx,live.ctx,p.reporterEmploymentId);if(!live.scopeIds.includes(own.companyProof.companyId!))throw new AssistantConversationError('scopeChanged');}
 const saved=await submitFeedback(live.ctx,{reporterEmploymentId:p.reporterEmploymentId,category:p.category,title:p.title,description:p.description,expectedBehavior:p.expectedBehavior,expectedFunction:p.expectedFunction},tx);
 await tx.update(s.assistantFeedbackDraft).set({feedbackId:saved.id,submitDigest:fingerprint,submittedAt:sql`now()`,revision:row.revision+1}).where(eq(s.assistantFeedbackDraft.id,row.id));
 return {feedbackId:saved.id,created:true};
 });if(!result)throw new AssistantConversationError('scopeChanged');return result;}
