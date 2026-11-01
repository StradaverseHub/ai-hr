/** ADR-0170 §3.3, step 5a — task memory persisted behind the step 1 storage interface (./memory.ts).
 *
 * One row per (tenant, login, conversation) in `teras_task_memory` (migration 0890). The store is bound to
 * one session and every call runs in that session's own transaction, so RLS admits only that login's rows:
 * another tenant, another login and any agent context read nothing and write nothing. The store adds no
 * authority of its own: the runner still re-authorises the loaded memory every turn (reauthoriseMemory), and
 * the store refuses a memory, key or load whose tenant or login is not the session's.
 *
 * Erased with the transcript: retiring or deleting the login's Assistant exchanges deletes its task memory
 * in the database (0890 trigger), whichever path retired them; delete() removes one conversation now.
 * Not wired: the runner stays off until the ADR-0169 §5.1 review. */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasTaskMemory} from '../../db/teras-schema';
import {TASK_MEMORY_VERSION,type TaskMemory,type TaskMemoryStore} from './memory';

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
  const [row]=await withTenant(this.ctx,tx=>tx.select({memory:terasTaskMemory.memory}).from(terasTaskMemory)
   .where(and(eq(terasTaskMemory.tenantId,tenantId),eq(terasTaskMemory.appUserId,userId),eq(terasTaskMemory.conversationId,conversationId))).limit(1));
  if(!row)return null;
  const memory=row.memory as unknown as TaskMemory;
  // A row of another shape or owner is never trusted: it is treated as absent.
  if(memory?.version!==TASK_MEMORY_VERSION||memory.tenantId!==tenantId||memory.userId!==userId||memory.conversationId!==conversationId)return null;
  return memory;
 }
 async save(memory:TaskMemory):Promise<void>{
  this.own(memory.tenantId,memory.userId);
  const value=JSON.parse(JSON.stringify(memory)) as TaskMemory;
  await withTenant(this.ctx,tx=>tx.insert(terasTaskMemory).values({tenantId:memory.tenantId,appUserId:memory.userId,conversationId:memory.conversationId,memory:value as unknown as Record<string,unknown>})
   .onConflictDoUpdate({target:[terasTaskMemory.tenantId,terasTaskMemory.appUserId,terasTaskMemory.conversationId],set:{memory:value as unknown as Record<string,unknown>,updatedAt:sql`now()`}}));
 }
 async delete(tenantId:string,userId:string,conversationId:string):Promise<void>{
  this.own(tenantId,userId);
  await withTenant(this.ctx,tx=>tx.delete(terasTaskMemory)
   .where(and(eq(terasTaskMemory.tenantId,tenantId),eq(terasTaskMemory.appUserId,userId),eq(terasTaskMemory.conversationId,conversationId))));
 }
}
