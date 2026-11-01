/** REVIEW (stress and concurrency) — the turn harness under volume. Written as if at test/review/harness-stress.test.ts.
 * Scripted model and fictional tools (test/harness-ratchet), no provider. The last block uses the database for
 * the persisted task-memory store.
 *
 *  - core/harness/runner.ts:177-205 runs every tool call a single model response contains; nothing caps calls per
 *    step, so one response can dispatch any number of reads, and the trace then exceeds the outcome record's own
 *    ceiling (core/outcome-record/record.ts:46 reads max 64), so persistTurnTrace refuses the turn's record.
 *  - core/harness/runner.ts:112,130 sends the whole history every call; there is no history cap in HARNESS_SPEC.
 *  - core/harness/runner.ts:119 loads and :223 saves task memory with no version check; two overlapping turns in
 *    one conversation lose one turn's update (core/harness/task-memory-store.ts:36-41 last write wins). */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import {HARNESS_SPEC} from '../../core/harness/spec';
import {HARNESS_TEST_ONLY,runTurn,type ModelHistoryMessage} from '../../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../../core/harness/memory';
import {PostgresTaskMemoryStore} from '../../core/harness/task-memory-store';
import {outcomeRecordFromTrace} from '../../core/harness/trace-persistence';
import {OutcomeRecordInput} from '../../core/outcome-record/record';
import {hireEmployee} from '../../core/org';
import {fakeTools} from '../harness-ratchet/fake-tools';
import {scriptedModel} from '../harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,resetDb,seedBase,type Base} from '../harness';

const SCOPE={companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'};
const caller=(tenant:number,user:number):SessionContext=>({tenantId:`00000000-0000-4000-8000-0000000000${(0xa0+tenant).toString(16)}`,
 userId:`00000000-0000-4000-8001-${String(user).padStart(12,'0')}`,personId:`00000000-0000-4000-8002-${String(user).padStart(12,'0')}`,roles:['employee'],grants:[{role:'employee',companyId:null}]});

describe('harness volume (no database)',()=>{
 it('REVIEW pass: 30 concurrent turns across 3 tenants keep each conversation\'s memory with its own tenant and login',async()=>{
  const memory=new InMemoryTaskMemoryStore(),started=Date.now();
  const jobs=Array.from({length:30},(_,i)=>{const ctx=caller(i%3,i),{provider}=fakeTools();
   const model=scriptedModel([{calls:[{name:'product_guidance',args:{query:'leave '+i}}]},{final:{reply:'Open Leave and choose Apply.',mode:'answer'}}]);
   return runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:'conversation-'+i,question:'How do I apply for leave? ('+i+')',scope:SCOPE,model,memory,tools:provider}).then(result=>({i,ctx,result}));});
  const results=await Promise.all(jobs);
  expect(Date.now()-started).toBeLessThan(30_000);
  for(const {i,ctx,result} of results){
   expect(result.memory).toMatchObject({tenantId:ctx.tenantId,userId:ctx.userId,conversationId:'conversation-'+i,turns:1});
   const stored=await memory.load(ctx.tenantId,ctx.userId!,'conversation-'+i);
   expect(stored?.turns).toBe(1);
   // Another tenant's key never finds it.
   expect(await memory.load(caller((i+1)%3,i).tenantId,ctx.userId!,'conversation-'+i)).toBeNull();
  }
 },60_000);

 it('REVIEW medium: one model step cannot dispatch an unbounded number of tool calls; the turn stays recordable (runner.ts:177-205, record.ts:46)',async()=>{
  const {provider,dispatched}=fakeTools(),memory=new InMemoryTaskMemoryStore();
  const flood=Array.from({length:100},(_,i)=>({name:'product_guidance',args:{query:'fictional query '+i}}));
  const model=scriptedModel([{calls:flood},{final:{reply:'Open Leave and choose Apply.',mode:'answer'}}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:caller(0,1),conversationId:'flood',question:'How do I apply for leave?',scope:SCOPE,model,memory,tools:provider});
  // The outcome record admits at most 64 reads; a turn whose trace exceeds it cannot be recorded at all.
  expect(dispatched.length,'tool executions from one model step').toBeLessThanOrEqual(64);
  expect(OutcomeRecordInput.safeParse(outcomeRecordFromTrace(result.trace)).success).toBe(true);
 },60_000);

 it('REVIEW low: a single model call is never sent more history than the turn\'s own token budget (runner.ts:112,130)',async()=>{
  const {provider}=fakeTools(),memory=new InMemoryTaskMemoryStore();
  // 300 earlier turns of ~2,000 characters each (~600k characters, far above maxTotalTokens of input).
  const history:ModelHistoryMessage[]=Array.from({length:600},(_,i)=>({role:i%2?'assistant':'user',content:'Fictional earlier text. '.repeat(85)+i,side:'model'}));
  const model=scriptedModel([{final:{reply:'Open Leave and choose Apply.',mode:'answer'}}]);
  await runTurn({enabled:HARNESS_TEST_ONLY,ctx:caller(0,2),conversationId:'long',question:'How do I apply for leave?',history,scope:SCOPE,model,memory,tools:provider});
  const sentChars=JSON.stringify(model.requests[0].messages).length;
  // A conservative four characters per token.
  expect(sentChars,'characters in the first request').toBeLessThanOrEqual(HARNESS_SPEC.budgets.maxTotalTokens*4);
 },60_000);
});

let b:Base,me:SessionContext;
describe('task memory under overlapping turns (database store)',()=>{
 beforeAll(migrateTestDb);afterAll(closeAll);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();
  const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Memory Person',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(b.tenantId,hired.personId,'employee');
  me={...await entitledCtx(b,['employee']),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext;
 });
 it('REVIEW low: two overlapping turns in one conversation both count in task memory (runner.ts:119/223, task-memory-store.ts:36-41)',async()=>{
  const store=new PostgresTaskMemoryStore(me),conversationId='overlap-'+randomUUID();
  const turn=(question:string)=>{const {provider}=fakeTools();
   return runTurn({enabled:HARNESS_TEST_ONLY,ctx:me,conversationId,question,scope:{companyId:b.companyId,locale:'en'},
    model:scriptedModel([{calls:[{name:'product_guidance',args:{query:question}}]},{final:{reply:'Open Leave and choose Apply.',mode:'answer'}}]),memory:store,tools:provider});};
  // A double submit: the same person sends two questions before the first reply arrives.
  await Promise.all([turn('How do I apply for leave?'),turn('How do I cancel leave?')]);
  const stored=await store.load(me.tenantId,me.userId!,conversationId);
  // Either both turns are counted, or the second save is refused and the surface retries; silently dropping one is the defect.
  expect(stored?.turns).toBe(2);
 },60_000);
});
