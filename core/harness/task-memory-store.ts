/** ADR-0170 §3.3, step 5a — task memory persisted behind the step 1 storage interface (./memory.ts).
 *
 * One row per (tenant, login, conversation) in `teras_task_memory` (migration 0890). The store is bound to
 * one session and every call runs in that session's own transaction, so RLS admits only that login's rows:
 * another tenant, another login and any agent context read nothing and write nothing. The store adds no
 * authority of its own: the runner still re-authorises the loaded memory every turn (reauthoriseMemory), and
 * the store refuses a memory, key or load whose tenant or login is not the session's.
 *
 * Erased with the transcript: retiring or deleting the login's Assistant exchanges deletes its task memory
 * in the database (0890 trigger), whichever path retired them; delete() removes one conversation now. Memory not
 * updated for TASK_MEMORY_RETENTION is expired: never read, and erased by the database on later writes (0906).
 * Wired by core/teras-wiring/turn.ts, keyed by the conversation, when the tenant's Noveri conversation switch is on. */
import {and,eq,gt,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasTaskMemory} from '../../db/teras-schema';
import {TASK_MEMORY_VERSION,type TaskMemory,type TaskMemoryStore} from './memory';
import {HARNESS_SPEC} from './spec';

/** Task memory not updated within this interval is expired (migration 0906 erases it; the store never reads it). */
export const TASK_MEMORY_RETENTION='1 day';

/** Review L4 (seen in run 41363906691): two overlapping turns of one conversation (a double submit) each saved a
 * whole memory and the later save silently overwrote the earlier. A save now succeeds only over the turn count it
 * was built from; when another turn saved first, this turn is folded into the latest memory and saved again. */
export function foldTurnInto(latest:TaskMemory,mine:TaskMemory):TaskMemory{
 const {maxCompletedReads,maxOpenProposals}=HARNESS_SPEC.memory,turns=latest.turns+1;
 const seen=new Set(latest.completedReads.map(row=>row.tool+'\n'+row.turn));
 const reads=[...latest.completedReads,...mine.completedReads.filter(row=>!seen.has(row.tool+'\n'+row.turn)).map(row=>({tool:row.tool,turn:turns}))].slice(-maxCompletedReads);
 const ids=new Set(latest.openProposals.map(row=>row.body.id));
 const proposals=[...mine.openProposals.filter(row=>!ids.has(row.body.id)),...latest.openProposals].slice(0,maxOpenProposals);
 return{...latest,goal:latest.goal??mine.goal,pendingQuestion:mine.pendingQuestion,completedReads:reads,openProposals:proposals,turns,
  updatedAt:mine.updatedAt>latest.updatedAt?mine.updatedAt:latest.updatedAt};
}

export class TaskMemoryRefused extends Error{constructor(){super('Task memory belongs to another caller.');this.name='TaskMemoryRefused';}}

export class PostgresTaskMemoryStore implements TaskMemoryStore{
 private readonly ctx:SessionContext;
 constructor(ctx:SessionContext){
  if(!ctx.userId||ctx.agent)throw new TaskMemoryRefused();
  this.ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 }
 private own(tenantId:string,userId:string){if(tenantId!==this.ctx.tenantId||userId!==this.ctx.userId)throw new TaskMemoryRefused();}
 async load(tenantId:string,userId:string,conversationId:string):Promise<TaskMemory|null>{
  this.own(tenantId,userId);
  // Retention (migration 0906): memory not updated for a day belongs to a conversation that can no longer continue
  // (core/teras-wiring/history.ts), so it is never read again; the database erases it on later writes.
  const [row]=await withTenant(this.ctx,tx=>tx.select({memory:terasTaskMemory.memory}).from(terasTaskMemory)
   .where(and(eq(terasTaskMemory.tenantId,tenantId),eq(terasTaskMemory.appUserId,userId),eq(terasTaskMemory.conversationId,conversationId),
    gt(terasTaskMemory.updatedAt,sql`now()-${TASK_MEMORY_RETENTION}::interval`))).limit(1));
  if(!row)return null;
  const memory=row.memory as unknown as TaskMemory;
  // A row of another shape or owner is never trusted: it is treated as absent.
  if(memory?.version!==TASK_MEMORY_VERSION||memory.tenantId!==tenantId||memory.userId!==userId||memory.conversationId!==conversationId)return null;
  return memory;
 }
 async save(memory:TaskMemory):Promise<void>{
  this.own(memory.tenantId,memory.userId);
  let next=memory;
  for(let attempt=0;attempt<5;attempt++){
   const value=JSON.parse(JSON.stringify(next)) as TaskMemory,stored=value as unknown as Record<string,unknown>,base=next.turns-1;
   const key=and(eq(terasTaskMemory.tenantId,next.tenantId),eq(terasTaskMemory.appUserId,next.userId),eq(terasTaskMemory.conversationId,next.conversationId));
   const written=await withTenant(this.ctx,async tx=>{
    // First turn: insert only. Later turns: replace only the memory this one was built from (same turn count), or an
    // expired or unreadable row (which load treats as absent, so this turn was built from nothing).
    const inserted=await tx.insert(terasTaskMemory).values({tenantId:next.tenantId,appUserId:next.userId,conversationId:next.conversationId,memory:stored})
     .onConflictDoNothing().returning({id:terasTaskMemory.conversationId});
    if(inserted.length)return true;
    const updated=await tx.update(terasTaskMemory).set({memory:stored,updatedAt:sql`now()`})
     .where(and(key,sql`((${terasTaskMemory.memory}->>'turns')::int = ${base} OR ${terasTaskMemory.updatedAt} <= now()-${TASK_MEMORY_RETENTION}::interval OR (${terasTaskMemory.memory}->>'version') IS DISTINCT FROM ${String(TASK_MEMORY_VERSION)})`))
     .returning({id:terasTaskMemory.conversationId});
    return updated.length>0;
   });
   if(written)return;
   const latest=await this.load(next.tenantId,next.userId,next.conversationId);
   if(!latest)continue;
   next=foldTurnInto(latest,memory);
  }
  throw Error('Task memory could not be saved after concurrent turns.');
 }
 async delete(tenantId:string,userId:string,conversationId:string):Promise<void>{
  this.own(tenantId,userId);
  await withTenant(this.ctx,tx=>tx.delete(terasTaskMemory)
   .where(and(eq(terasTaskMemory.tenantId,tenantId),eq(terasTaskMemory.appUserId,userId),eq(terasTaskMemory.conversationId,conversationId))));
 }
}
