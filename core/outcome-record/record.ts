/** ADR-0170 §3.11 and §11.3 change 5, step 5a — the outcome record: one append-only row per AI run.
 *
 * It answers how a result came about: under what authority (the person who asked, or a mandate id and
 * version with its grantor), who acted (the agent identity), what was read (tool names and record
 * references, never the data), which native checks ran with their rule versions and results, what produced
 * it (model, provider, instruction set, spec), what was suggested, prepared or done, how far a person was
 * involved, and whether the affected person was told. Decisions, undo and notice that happen later are
 * appended as follow-ups; nothing is ever updated (migration 0890 refuses UPDATE and DELETE for every role).
 *
 * Values are bounded before they reach the database: every string is short and every object is flat, so a
 * caller cannot smuggle a record's contents, a question or a reply into the record. Retention follows audit
 * retention; ids are opaque references, so erasing a person's data in its native owner leaves nothing here
 * to erase. Not imported by the production Assistant. */
import {randomUUID} from 'node:crypto';
import {and,asc,desc,eq,inArray} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {terasOutcomeFollowup,terasOutcomeRecord} from '../../db/teras-schema';
import type {HumanInvolvement,NoticeState,OutcomeCheck,OutcomeKind,OutcomeRead,OutcomeReplay} from './types';

export type {HumanInvolvement,NoticeState,OutcomeCheck,OutcomeKind,OutcomeRead,OutcomeReplay} from './types';

const uuid=z.guid();
const name=z.string().regex(/^[a-z0-9_.:/#@*-]{1,160}$/i);
const ref=z.string().regex(/^[a-z0-9_.:/#@-]{1,80}$/i);
const short=z.string().max(120).regex(/^[^\n\r]*$/);
const scalar=z.union([short,z.number().finite(),z.boolean(),z.null()]);
/** A flat object of scalars or short lists: room for ids, counts, verdicts and names, none for prose. */
const flat=z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/),z.union([scalar,z.array(short).max(200)]))
 .refine(value=>Object.keys(value).length<=24);
const OutcomeReadSchema=z.object({tool:name,status:z.string().regex(/^[a-z_]{1,40}$/),argumentsDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
 refs:z.array(ref).max(200).optional()}).strict();
const OutcomeCheckSchema=z.object({check:z.string().regex(/^[a-z_]{1,60}$/),owner:name,ruleVersion:z.string().regex(/^[A-Za-z0-9_.:/#@*+-]{1,200}$/).nullable(),
 result:z.enum(['pass','needs_review','fail'])}).strict();
const OutcomeReplaySchema=z.object({model:name.nullable(),provider:name.nullable(),instructionSet:name.nullable(),specVersion:name.nullable(),
 specDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),toolCatalogue:name.nullable()}).strict();
const Authority=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('person'),askedByUserId:uuid}).strict(),
 z.object({kind:z.literal('mandate'),mandateId:uuid,mandateVersion:z.number().int().min(1),grantorUserId:uuid}).strict(),
]);
export const OutcomeRecordInput=z.object({
 runId:uuid,runKind:z.enum(['turn','mandate_run']),companyId:uuid.nullable().optional(),
 startedAt:z.date(),finishedAt:z.date(),
 authority:Authority,
 agentIdentity:z.string().regex(/^[a-z0-9_.:-]{1,120}$/),
 reads:z.array(OutcomeReadSchema).max(64),
 checks:z.array(OutcomeCheckSchema).max(64),
 replay:OutcomeReplaySchema,
 outcomeKind:z.enum(['answered','suggested','prepared','done','fallback','refused','stopped']),
 outcome:flat,
 humanInvolvement:z.enum(['none','reviewed','decided']),
 notice:z.enum(['not_applicable','given','not_given']),
 trace:z.record(z.string(),z.unknown()).nullable().optional(),
}).strict().refine(value=>value.finishedAt>=value.startedAt,{message:'finishedAt precedes startedAt'})
 .refine(value=>value.authority.kind==='person'||value.runKind==='mandate_run',{message:'A mandate authority records a mandate run'});
export type OutcomeRecordInput=z.input<typeof OutcomeRecordInput>;

export class OutcomeRecordRefused extends Error{constructor(readonly reason:string){super('Outcome record refused: '+reason);this.name='OutcomeRecordRefused';}}

/** Writes the record in the caller's transaction, so a run and its record commit together. The authority
 * must be the caller: a person records only their own turn; only an agent context records a mandate run. */
export async function writeOutcomeRecordTx(tx:Tx,ctx:SessionContext,supplied:OutcomeRecordInput):Promise<Readonly<{id:string;runId:string}>>{
 const parsed=OutcomeRecordInput.safeParse(supplied);
 if(!parsed.success)throw new OutcomeRecordRefused('invalid');
 const input=parsed.data,authority=input.authority;
 if(authority.kind==='person'&&(ctx.agent||ctx.userId!==authority.askedByUserId))throw new OutcomeRecordRefused('authority_not_caller');
 if(authority.kind==='mandate'&&!ctx.agent)throw new OutcomeRecordRefused('mandate_needs_agent');
 const [row]=await tx.insert(terasOutcomeRecord).values({
  tenantId:ctx.tenantId,companyId:input.companyId??null,runId:input.runId,runKind:input.runKind,startedAt:input.startedAt,finishedAt:input.finishedAt,
  authorityKind:authority.kind,askedByUserId:authority.kind==='person'?authority.askedByUserId:null,
  mandateId:authority.kind==='mandate'?authority.mandateId:null,mandateVersion:authority.kind==='mandate'?authority.mandateVersion:null,
  grantorUserId:authority.kind==='mandate'?authority.grantorUserId:null,
  agentIdentity:input.agentIdentity,reads:input.reads as OutcomeRead[],checks:input.checks as OutcomeCheck[],replay:input.replay as OutcomeReplay,
  outcomeKind:input.outcomeKind,outcome:input.outcome,humanInvolvement:input.humanInvolvement,notice:input.notice,trace:input.trace??null,
 }).returning({id:terasOutcomeRecord.id,runId:terasOutcomeRecord.runId});
 return Object.freeze({id:row.id,runId:row.runId});
}
export function writeOutcomeRecord(ctx:SessionContext,input:OutcomeRecordInput){return withTenant(ctx,tx=>writeOutcomeRecordTx(tx,ctx,input));}

export const OutcomeFollowupInput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('decision'),recordId:uuid,decision:z.enum(['accepted','rejected']),humanInvolvement:z.enum(['reviewed','decided']),reference:z.record(z.string(),ref).optional()}).strict(),
 z.object({kind:z.literal('undo'),recordId:uuid,reference:z.record(z.string(),ref).optional()}).strict(),
 z.object({kind:z.literal('notice'),recordId:uuid,notice:z.enum(['given','not_given']),channel:z.enum(['in_app','email']).optional(),reference:z.record(z.string(),ref).optional()}).strict(),
]);
export type OutcomeFollowupInput=z.input<typeof OutcomeFollowupInput>;
/** A person's later decision, undo or notice. A mandate's automatic completion belongs to decision jobs
 * (step 5b) and has no writer here; the database refuses it from the app role as well. */
export async function recordOutcomeFollowup(ctx:SessionContext,supplied:OutcomeFollowupInput):Promise<Readonly<{id:string}>>{
 const parsed=OutcomeFollowupInput.safeParse(supplied);
 if(!parsed.success||!ctx.userId||ctx.agent)throw new OutcomeRecordRefused('invalid');
 const input=parsed.data;
 if(input.kind==='notice'&&(input.notice==='given')!==(input.channel!==undefined))throw new OutcomeRecordRefused('invalid');
 return withTenant(ctx,async tx=>{
  const [row]=await tx.insert(terasOutcomeFollowup).values({tenantId:ctx.tenantId,recordId:input.recordId,kind:input.kind,byUserId:ctx.userId!,
   reference:input.reference??{},
   ...(input.kind==='decision'?{decision:input.decision,humanInvolvement:input.humanInvolvement}
    :input.kind==='undo'?{decision:'undone' as const,humanInvolvement:'decided' as const}
    :{notice:input.notice,noticeChannel:input.channel??null,humanInvolvement:'none' as const})}).returning({id:terasOutcomeFollowup.id});
  return Object.freeze({id:row.id});
 });
}

const involvementRank:Record<HumanInvolvement,number>={none:0,reviewed:1,decided:2};
export type OutcomeRecordView=Readonly<typeof terasOutcomeRecord.$inferSelect&{followups:readonly (typeof terasOutcomeFollowup.$inferSelect)[];
 /** The most a person was involved, over the run and every later decision. */
 effectiveHumanInvolvement:HumanInvolvement;
 /** The latest notice state: a later notice follow-up replaces the run's own. */
 effectiveNotice:NoticeState;
 /** The latest decision or undo, if any. */
 decision:'accepted'|'rejected'|'completed'|'undone'|null}>;
/** The records the caller may see (RLS: who asked, the grantor, group administrators), newest first. */
export async function listOutcomeRecords(ctx:SessionContext,filter:Readonly<{mandateId?:string;limit?:number}>={}):Promise<readonly OutcomeRecordView[]>{
 return withTenant(ctx,async tx=>{
  const rows=await tx.select().from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),
   ...(filter.mandateId?[eq(terasOutcomeRecord.mandateId,filter.mandateId)]:[]))).orderBy(desc(terasOutcomeRecord.startedAt),desc(terasOutcomeRecord.id))
   .limit(Math.min(Math.max(filter.limit??100,1),500));
  const followups=rows.length?await tx.select().from(terasOutcomeFollowup).where(and(eq(terasOutcomeFollowup.tenantId,ctx.tenantId),
   inArray(terasOutcomeFollowup.recordId,rows.map(row=>row.id)))).orderBy(asc(terasOutcomeFollowup.at),asc(terasOutcomeFollowup.id)):[];
  return rows.map(row=>{
   const own=followups.filter(item=>item.recordId===row.id);
   const involvement=own.reduce<HumanInvolvement>((max,item)=>involvementRank[item.humanInvolvement]>involvementRank[max]?item.humanInvolvement:max,row.humanInvolvement);
   const notice=own.filter(item=>item.kind==='notice').at(-1)?.notice??row.notice;
   const decision=own.filter(item=>item.decision).at(-1)?.decision??null;
   return Object.freeze({...row,followups:Object.freeze(own),effectiveHumanInvolvement:involvement,effectiveNotice:notice,decision});
  });
 });
}
export const newRunId=()=>randomUUID();
