/** ADR-0170 step 5a — task memory persisted behind the step 1 storage interface (migration 0890).
 *
 *  1. Two turns of one conversation share memory through the database store, and each turn re-authorises it.
 *  2. Only the owning login reads or writes it: another login, another tenant and an agent context see none.
 *  3. It is erased with the transcript: retiring or deleting the login's Assistant exchanges deletes it. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import {terasTaskMemory} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {PostgresTaskMemoryStore,TaskMemoryRefused} from '../core/harness/task-memory-store';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-memory-passphrase');await resetDb();base=await seedBase();for(const code of ['assistant','claims'])await setModule(base.tenantId,code,'active');});

async function employee(name:string):Promise<SessionContext>{
 const admin=adminCtx(base);
 const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 return{...await entitledCtx(base,['employee']),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}
const turn=(ctx:SessionContext,conversationId:string,question:string)=>runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId,question,scope:{companyId:base.companyId,locale:'en'},
 model:scriptedModel([{calls:[{name:'my_leave_balances'}]},{final:{reply:'Which leave type do you mean?',mode:'clarify',slot:'leave_type'}}]),memory:new PostgresTaskMemoryStore(ctx)});
const rows=(userId:string)=>owner.db.select().from(terasTaskMemory).where(and(eq(terasTaskMemory.tenantId,base.tenantId),eq(terasTaskMemory.appUserId,userId)));

describe('task memory persistence',()=>{
 it('expires a day after its last update: never read again, and erased by a later write in the tenant (0906)',async()=>{
  const me=await employee('Fictional Expiring Memory');const other=await employee('Fictional Later Writer');const conversationId=randomUUID();
  await turn(me,conversationId,'How much leave do I have?');
  expect(await new PostgresTaskMemoryStore(me).load(base.tenantId,me.userId!,conversationId)).not.toBeNull();
  // Two days later the conversation cannot continue (two-hour continuation), so its memory is not read.
  await owner.db.update(terasTaskMemory).set({updatedAt:new Date(Date.now()-2*86_400_000)}).where(eq(terasTaskMemory.appUserId,me.userId!));
  expect(await new PostgresTaskMemoryStore(me).load(base.tenantId,me.userId!,conversationId)).toBeNull();
  expect(await rows(me.userId!)).toHaveLength(1);
  // Any later memory write in the tenant erases expired rows, including another login's.
  await turn(other,randomUUID(),'How much leave do I have?');
  expect(await rows(me.userId!)).toHaveLength(0);
  expect(await rows(other.userId!)).toHaveLength(1);
 });
 it('carries a conversation across turns through the database and re-authorises it every turn',async()=>{
  const me=await employee('Fictional Memory Employee');const conversationId=randomUUID();
  const first=await turn(me,conversationId,'How much leave do I have?');
  expect(first.memory).toMatchObject({turns:1,goal:'How much leave do I have?',pendingQuestion:'leave_type'});
  expect(await rows(me.userId!)).toHaveLength(1);
  const second=await turn(me,conversationId,'Annual leave please.');
  expect(second.memory).toMatchObject({turns:2,goal:'How much leave do I have?'});
  expect(second.trace.memory.authorityChanged).toBe(false);
  // Changed authority: the stored memory was written under other roles, so reads and selections are dropped.
  const widened={...me,roles:['employee','manager'],grants:[{role:'employee',companyId:null},{role:'manager',companyId:null}]};
  const third=await turn(widened,conversationId,'And my team?');
  expect(third.trace.memory.authorityChanged).toBe(true);expect(third.memory.turns).toBe(3);
  const stored=await new PostgresTaskMemoryStore(me).load(base.tenantId,me.userId!,conversationId);
  expect(stored).toMatchObject({conversationId,tenantId:base.tenantId,userId:me.userId,turns:3});
 });

 it('belongs to one login: another login, another tenant and an agent context read and write none',async()=>{
  const me=await employee('Fictional Owner');const other=await employee('Fictional Neighbour');const conversationId=randomUUID();
  await turn(me,conversationId,'How much leave do I have?');
  await expect(new PostgresTaskMemoryStore(other).load(base.tenantId,me.userId!,conversationId)).rejects.toThrow(TaskMemoryRefused);
  expect(await withTenant(other,tx=>tx.select().from(terasTaskMemory))).toEqual([]);
  const stolen=(await rows(me.userId!))[0];
  await expect(withTenant(other,tx=>tx.insert(terasTaskMemory).values({...stolen,conversationId:randomUUID()}))).rejects.toThrow();
  expect(await withTenant({...me,tenantId:(await seedBase()).tenantId},tx=>tx.select().from(terasTaskMemory))).toEqual([]);
  const principal=await ensureAgentPrincipal(owner.db,base.tenantId);
  expect(await withTenant(agentContext(base.tenantId,principal,harnessSnapshot(base.tenantId)),tx=>tx.select().from(terasTaskMemory))).toEqual([]);
  expect(()=>new PostgresTaskMemoryStore(agentContext(base.tenantId,principal,harnessSnapshot(base.tenantId)))).toThrow(TaskMemoryRefused);
  // delete() removes one conversation.
  await new PostgresTaskMemoryStore(me).delete(base.tenantId,me.userId!,conversationId);
  expect(await rows(me.userId!)).toHaveLength(0);
 });

 it('is erased with the transcript, whichever path retires it',async()=>{
  const me=await employee('Fictional Transcript Owner');const other=await employee('Fictional Bystander');
  await turn(me,randomUUID(),'How much leave do I have?');await turn(other,randomUUID(),'How much leave do I have?');
  const exchange=(userId:string)=>owner.db.insert(schema.assistantExchange).values({tenantId:base.tenantId,appUserId:userId,question:'Fictional question'}).returning({id:schema.assistantExchange.id});
  const [mine]=await exchange(me.userId!);
  expect(await rows(me.userId!)).toHaveLength(1);
  await owner.db.delete(schema.assistantExchange).where(eq(schema.assistantExchange.id,mine.id));
  expect(await rows(me.userId!)).toHaveLength(0);
  // Retirement (content cleared, identity kept) erases it too; another login's memory is untouched.
  await turn(me,randomUUID(),'How much leave do I have?');
  const [again]=await exchange(me.userId!);
  await owner.db.update(schema.assistantExchange).set({contentRetiredAt:new Date(),question:'',answer:null,toolCalls:[]}).where(eq(schema.assistantExchange.id,again.id));
  expect(await rows(me.userId!)).toHaveLength(0);
  expect(await rows(other.userId!)).toHaveLength(1);
 });
});
