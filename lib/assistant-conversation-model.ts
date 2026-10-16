/** Shared Home/Assistant conversation contracts. These values confer no authority: the server
 * derives the actor, sign-in binding and current scope before every owner operation. */
import {z} from 'zod';
import {isCalendarDate} from './calendar-date';

export const CONVERSATION_LIMITS={questionChars:2000,historyTurns:10,historyChars:16000,replyChars:24000,links:12,rows:100,columns:12,proposalSubjects:50} as const;
export const assistantConversationId=z.uuid();
export const assistantScopeFingerprint=z.string().regex(/^[a-f0-9]{64}$/);
export const assistantConversationRevision=z.number().int().safe().min(1);

/** Names refer to reviewed route adapters, never a URL proposed by a model or stored in a browser. */
export const ASSISTANT_HANDOFFS=['personnelCreate','personnelImport','ownProfile','ownAttendance','ownLeave','ownPayslips','payrollProcess','payrollTransactions','payrollExceptions','statutorySetup','eaStatement','feedback','attendanceAllowance'] as const;
export type AssistantHandoff=typeof ASSISTANT_HANDOFFS[number];
export const assistantHandoff=z.object({route:z.enum(ASSISTANT_HANDOFFS),label:z.string().trim().min(1).max(160)}).strict();
export const ASSISTANT_EVIDENCE_KINDS=['personnel','attendance','leave','payroll','statutory','knowledge','productGuide'] as const;
export const assistantEvidence=z.object({kind:z.enum(ASSISTANT_EVIDENCE_KINDS),label:z.string().trim().min(1).max(240),asAt:z.string().refine(isCalendarDate).nullable(),companyId:z.uuid().nullable(),truncated:z.boolean()}).strict();
export const assistantTable=z.object({columns:z.array(z.string().min(1).max(120)).min(1).max(CONVERSATION_LIMITS.columns),rows:z.array(z.array(z.string().max(1000)).max(CONVERSATION_LIMITS.columns)).max(CONVERSATION_LIMITS.rows)}).strict().superRefine((table,context)=>{for(const [index,row] of table.rows.entries())if(row.length!==table.columns.length)context.addIssue({code:'custom',message:'Each row must match the reviewed columns.',path:['rows',index]});});

/** Version1 deliberately exposes the one existing consequential adapter, without generic writers. */
export const assistantConfirmedPayload=z.object({typeId:z.literal('close_fixed_upstream'),verdictIds:z.array(z.uuid()).min(1).max(CONVERSATION_LIMITS.proposalSubjects)}).strict().superRefine((value,context)=>{if(new Set(value.verdictIds.map(id=>id.toLowerCase())).size!==value.verdictIds.length)context.addIssue({code:'custom',message:'A subject may occur only once.',path:['verdictIds']});});
export type AssistantConfirmedPayload=z.infer<typeof assistantConfirmedPayload>;

const replyFields={text:z.string().max(CONVERSATION_LIMITS.replyChars),evidence:z.array(assistantEvidence).max(24),links:z.array(assistantHandoff).max(CONVERSATION_LIMITS.links),tables:z.array(assistantTable).max(4)};
export const assistantCapabilityReply=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('guide'),...replyFields}).strict(),
 z.object({kind:z.literal('facts'),...replyFields}).strict(),
 z.object({kind:z.literal('draftHandoff'),...replyFields,handoff:assistantHandoff,draftId:z.uuid(),draftRevision:assistantConversationRevision}).strict(),
 z.object({kind:z.literal('awaitingConfirmation'),...replyFields,proposalId:z.uuid(),proposalRevision:assistantConversationRevision}).strict(),
 z.object({kind:z.literal('completed'),...replyFields,proposalId:z.uuid(),completedCount:z.number().int().min(0).max(CONVERSATION_LIMITS.proposalSubjects),staleCount:z.number().int().min(0).max(CONVERSATION_LIMITS.proposalSubjects)}).strict(),
 z.object({kind:z.enum(['refused','unavailable','unsupported']),...replyFields}).strict(),
]);
export type AssistantCapabilityReply=z.infer<typeof assistantCapabilityReply>;

/** Client submissions contain only a bounded question or exact existing proposal identity. */
export const assistantConversationTurnInput=z.object({conversationId:assistantConversationId,revision:assistantConversationRevision,requestId:z.uuid(),question:z.string().trim().min(1).max(CONVERSATION_LIMITS.questionChars),intent:z.enum(['question','prepareCloseFixed']).default('question')}).strict();
export const assistantProposalConfirmation=z.object({conversationId:assistantConversationId,conversationRevision:assistantConversationRevision,proposalId:z.uuid(),proposalRevision:assistantConversationRevision,requestId:z.uuid()}).strict();
export type AssistantConversationTurnInput=z.infer<typeof assistantConversationTurnInput>;
export type AssistantProposalConfirmation=z.infer<typeof assistantProposalConfirmation>;

export type AssistantConversationFailure='sessionUnavailable'|'scopeChanged'|'notFound'|'stale'|'busy'|'expired'|'invalid'|'unavailable';
export class AssistantConversationError extends Error {
 constructor(readonly code:AssistantConversationFailure){super('Assistant conversation unavailable.');this.name='AssistantConversationError';}
}

/** Trusted localized labels supplied by the server action, never a client authorization input. */
export type AssistantConversationCopy={feedbackDraft:string;feedbackDraftHelp:string;failures:Record<'not_configured'|'budget_monthly'|'budget_daily'|'invalid_question'|'provider_error'|'ai_control',string>;unavailable:string;notFinished:string;review:string;noCandidates:string;overCap:string;changed:string;completed:(closed:number,stale:number)=>string;employeeColumn:string;causeColumn:string;causes:Record<'no_bank_account'|'no_tax_number',string>;evidence:Record<string,string>;routes:Record<AssistantHandoff,string>};
