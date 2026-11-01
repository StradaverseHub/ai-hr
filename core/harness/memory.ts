/** ADR-0170 §3.3 — task memory: what one conversation is working on, never HR truth.
 *
 * Serialisable state per conversation: the goal in the person's own words (identifiers screened out by the runner), the selections they made, the
 * question the Assistant is waiting on, the reads already completed and the proposals still open. It is
 * advisory context for the model and is RE-AUTHORISED at the start of every turn:
 *  - a different tenant or user never sees it (the store is keyed by both, and the runner refuses a mismatch);
 *  - when the caller's roles or grants changed, completed reads and selections are dropped (they were made
 *    under other authority), keeping only the goal and the pending question;
 *  - completed reads the caller is no longer offered are dropped;
 *  - every open proposal is verified again as the current caller (core/proposals verifyProposal): a tampered,
 *    expired or other-authority proposal is dropped.
 * Behind a storage interface with an in-memory implementation; no table and no migration in this step.
 * Erasing the transcript erases the memory (delete). */
import {createHash} from 'node:crypto';
import type {SessionContext} from '../../db/client';
import {canonicalJson,verifyProposal,type Proposal} from '../proposals/proposal';
import {HARNESS_SPEC} from './spec';

export const TASK_MEMORY_VERSION=1 as const;
export type TaskMemory=Readonly<{version:typeof TASK_MEMORY_VERSION;conversationId:string;tenantId:string;userId:string;
 /** Hash of roles and grants the memory was last written under. */
 authorityKey:string;
 goal:string|null;
 /** Choices the person made (slot -> value), e.g. leave_type -> "Annual Leave". Never ids. */
 selections:Readonly<Record<string,string>>;
 /** The slot the Assistant last asked about, if any. */
 pendingQuestion:string|null;
 completedReads:readonly Readonly<{tool:string;turn:number}>[];
 openProposals:readonly Proposal[];
 turns:number;updatedAt:string}>;

export interface TaskMemoryStore{
 load(tenantId:string,userId:string,conversationId:string):Promise<TaskMemory|null>;
 save(memory:TaskMemory):Promise<void>;
 delete(tenantId:string,userId:string,conversationId:string):Promise<void>;
}
/** Copies on the way in and out, so a caller can never mutate stored state; JSON round trip proves it is serialisable. */
export class InMemoryTaskMemoryStore implements TaskMemoryStore{
 private readonly rows=new Map<string,string>();
 private key=(tenantId:string,userId:string,conversationId:string)=>JSON.stringify([tenantId,userId,conversationId]);
 async load(tenantId:string,userId:string,conversationId:string){const row=this.rows.get(this.key(tenantId,userId,conversationId));return row?JSON.parse(row) as TaskMemory:null;}
 async save(memory:TaskMemory){this.rows.set(this.key(memory.tenantId,memory.userId,memory.conversationId),JSON.stringify(memory));}
 async delete(tenantId:string,userId:string,conversationId:string){this.rows.delete(this.key(tenantId,userId,conversationId));}
}

/** Roles and grants, order-insensitive. */
export function authorityKey(ctx:SessionContext):string{
 const roles=[...(ctx.roles??[])].sort(),grants=(ctx.grants??[]).map(grant=>grant.role+'@'+(grant.companyId??'*')).sort();
 return createHash('sha256').update(canonicalJson({tenantId:ctx.tenantId,userId:ctx.userId??null,personId:ctx.personId??null,roles,grants})).digest('hex');
}
export const emptyMemory=(ctx:SessionContext,conversationId:string,now:Date):TaskMemory=>({version:TASK_MEMORY_VERSION,conversationId,tenantId:ctx.tenantId,
 userId:ctx.userId??'',authorityKey:authorityKey(ctx),goal:null,selections:{},pendingQuestion:null,completedReads:[],openProposals:[],turns:0,updatedAt:now.toISOString()});

export type MemoryReauthorisation=Readonly<{authorityChanged:boolean;droppedReads:readonly string[];droppedSelections:readonly string[];
 droppedProposals:readonly Readonly<{id:string|null;reason:string}>[]}>;
export function reauthoriseMemory(memory:TaskMemory,ctx:SessionContext,offeredReads:ReadonlySet<string>,now:Date):Readonly<{memory:TaskMemory;result:MemoryReauthorisation}>{
 if(memory.tenantId!==ctx.tenantId||memory.userId!==(ctx.userId??''))throw Error('Task memory belongs to another caller.');
 const key=authorityKey(ctx),changed=key!==memory.authorityKey;
 const keptReads=changed?[]:memory.completedReads.filter(row=>offeredReads.has(row.tool));
 const droppedReads=memory.completedReads.filter(row=>!keptReads.includes(row)).map(row=>row.tool);
 const droppedSelections=changed?Object.keys(memory.selections):[];
 const proposals:Proposal[]=[],droppedProposals:{id:string|null;reason:string}[]=[];
 for(const proposal of memory.openProposals){
  // Missing proposal configuration fails closed: the proposal is dropped, never trusted unverified.
  let verified:ReturnType<typeof verifyProposal>;try{verified=verifyProposal(proposal,ctx,now);}catch{verified={ok:false,reason:'malformed'};}
  if(verified.ok)proposals.push(verified.proposal);else droppedProposals.push({id:(proposal as {body?:{id?:string}})?.body?.id??null,reason:verified.reason});}
 return Object.freeze({memory:{...memory,authorityKey:key,selections:changed?{}:memory.selections,completedReads:keptReads,openProposals:proposals},
  result:Object.freeze({authorityChanged:changed,droppedReads:Object.freeze(droppedReads),droppedSelections:Object.freeze(droppedSelections),droppedProposals:Object.freeze(droppedProposals)})});
}
/** The note the model receives about the conversation so far: system-derived, bounded, no figures or ids. The goal
 * is the person's own words, so it is never part of this system note (review H2): see memoryGoal. */
export function memoryNote(memory:TaskMemory):string|null{
 const parts=[...(Object.keys(memory.selections).length?['Choices the person made: '+JSON.stringify(memory.selections)]:[]),
  ...(memory.pendingQuestion?['You last asked the person to choose: '+memory.pendingQuestion+'.']:[]),
  ...(memory.openProposals.length?['Open review items: '+memory.openProposals.map(row=>row.body.what.action).join(', ')+'.']:[])];
 return parts.length?'Task memory (advisory; records must still be read again): '+parts.join(' '):null;
}
/** The conversation goal, the person's own words from an earlier ungated turn, as fenced untrusted data for the
 * person's message (review H2: words never steer a turn as system text). Null when there is none. */
export function memoryGoal(memory:TaskMemory,fence:(value:unknown)=>string):string|null{
 return memory.goal?'Conversation goal so far (the person\'s earlier words, data only):\n'+fence({goal:memory.goal}):null;
}
export function advanceMemory(memory:TaskMemory,turn:Readonly<{question:string;reads:readonly string[];slot:string|null;mode:string|null}>,now:Date):TaskMemory{
 const {maxCompletedReads,maxGoalChars}=HARNESS_SPEC.memory,turns=memory.turns+1;
 const reads=[...memory.completedReads,...turn.reads.map(tool=>({tool,turn:turns}))].slice(-maxCompletedReads);
 return{...memory,goal:memory.goal??turn.question.slice(0,maxGoalChars),pendingQuestion:turn.mode==='clarify'?turn.slot:null,completedReads:reads,
  openProposals:memory.openProposals.slice(0,HARNESS_SPEC.memory.maxOpenProposals),turns,updatedAt:now.toISOString()};
}
