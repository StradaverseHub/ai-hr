/** Authored UNRUN. Requires the normally installed coordinated conversation-candidates draft (plus the
 * transcript-retention draft and parent PDPA hook for the own-history and PDPA cases). No skip flag:
 * a missing draft table must fail loudly, never pass. Only the provider transport is fictional and is
 * deliberately PAUSED mid-dispatch; the actual app principal, admission, custody triggers, RLS, canonical
 * PDPA owner and settlement run. No production data, live provider, inline migration or clock shortcut. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {converse} from '../lib/ai';
import {preparePrivateAiTask} from '../core/ai-governance';
import {ASSISTANT_PRIVATE_CONTRACT,privateAssistantCatalogue} from '../lib/ai/provider-assistant-policy';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {resolveActiveAiConfig} from '../core/ai-config';
import {bindAiSpendTaskTx} from '../core/ai-spend-task';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {erasePersonPii} from '../core/pdpa';
import {eraseOwnAssistantHistory} from '../core/assistant-history-retention';
import * as conversationHarness from '../core/assistant-conversation-harness';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {defaultModelFor} from '../lib/ai/registry';
import {MODULE_AGENT_SOURCE_DIGEST} from '../lib/ai/module-agent-source-manifest';
import {ASSISTANT_CONVERSATION_HOLDOUTS} from '../lib/ai/assistant-conversation-holdouts';
import {ASSISTANT_CONVERSATION_ARM_CALL_LIMIT,ASSISTANT_CONVERSATION_CANDIDATE_CALL_LIMIT,createConversationAgentCandidate,evaluateConversationAgentCandidate,prepareAssistantConversationStrategyTx,recheckAssistantConversationStrategyTx,completeAssistantConversationStrategyTx,eraseOwnConversationStrategyMetadata} from '../core/module-agent-releases';
import {installSyntheticSpendCapability} from './ai-spend-fixture';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-evaluation-fence-secret');vi.stubEnv('OPENAI_API_KEY','fictional-evaluation-fence-key');vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});

type Actor=SessionContext&{employmentId:string};
async function actor(name:string):Promise<Actor>{const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}),userId=await createAppUser(base.tenantId,hired.personId,'hr_admin');await grantAssistant(adminCtx(base),{appUserId:userId});return{...await entitledCtx(base,['hr_admin']),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],employmentId:hired.employmentId};}
async function actors(){return{author:await actor('Fictional Fence Author'),reviewer:await actor('Fictional Fence Reviewer')};}
const spendFixture={provider:'openai' as const,model:defaultModelFor('openai'),rootNanos:'5000000000',monthlyNanos:'10000000000'};
async function candidate(){const a=await actors(),created=await createConversationAgentCandidate(a.author,{version:1,configuration:{kind:'assistant_answer_prompt_v1',variant:'focused_v1'}});await installSyntheticSpendCapability(a.author,spendFixture);return{...a,candidateId:created.candidateId};}
const consent=()=>({synthetic:true as const,maxRequests:12,sourceDigest:MODULE_AGENT_SOURCE_DIGEST});

/** Settles without an unhandled rejection while the paused dispatch is still in flight. */
type Settled<T>={ok:true;value:T}|{ok:false;error:unknown};
const settle=<T,>(promise:Promise<T>):Promise<Settled<T>>=>promise.then(value=>({ok:true as const,value}),(error:unknown)=>({ok:false as const,error}));
function refusal(result:Settled<unknown>):unknown{expect(result.ok).toBe(false);return result.ok?undefined:result.error;}
const REFUSED={message:'Agent review could not be confirmed.'};

/** Fictional synthetic-holdout transport. The FIRST call of the requested kind (a tool step, whose next
 * step is another admission, or a terminal answer, whose next step is the arm checkpoint) is held open
 * until released, so erasure runs while an old in-memory dispatch is genuinely outstanding. */
type Step='tool'|'terminal';
function evaluationTransport(pauseOn:Step|null){
 let reached!:()=>void,open!:()=>void,paused=false,callsAtPause=-1;
 const atPause=new Promise<void>(yes=>{reached=yes;}),gate=new Promise<void>(yes=>{open=yes;});
 const spy=vi.spyOn(openaiAdapter,'converse').mockImplementation(async(_cfg,args)=>{
  const first=args.turns[0];if(first.role!=='user')throw Error('Expected fixed synthetic human turn');const input=JSON.parse(first.content),fixture=ASSISTANT_CONVERSATION_HOLDOUTS.find(row=>row.locale===input.locale&&row.question===input.question);if(!fixture)throw Error('Unexpected non-synthetic question');
  const completed=args.turns.flatMap(turn=>turn.role==='tool'?turn.results.filter(row=>!row.isError):[]).length,expected=fixture.expectedTools[completed];
  if(pauseOn&&!paused&&(expected?'tool':'terminal')===pauseOn){paused=true;callsAtPause=spy.mock.calls.length;reached();await gate;}
  if(expected)return{text:'',stop:'tool_use',toolCalls:[{id:'fence-call-'+completed,name:expected.name,input:expected.input}],usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0},usageReported:true};
  return{text:JSON.stringify(fixture.expected),stop:'end',toolCalls:[],usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0},usageReported:true};
 });
 return{spy,atPause,release:()=>open(),callsAtPause:()=>callsAtPause};
}
/** Fictional main-question transport, held open on its first call. */
function mainTransport(){
 let reached!:()=>void,open!:()=>void;const atPause=new Promise<void>(yes=>{reached=yes;}),gate=new Promise<void>(yes=>{open=yes;});
 const spy=vi.spyOn(openaiAdapter,'converse').mockImplementation(async()=>{reached();await gate;return{text:'FICTIONAL LATE MAIN REPLY',stop:'end',toolCalls:[],usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0},usageReported:true};});
 return{spy,atPause,release:()=>open()};
}

const INTENT='public.ai_assistant_answer_evaluation_intent',ARM='public.ai_assistant_answer_evaluation_arm',EVALUATION='public.ai_agent_evaluation',USE='public.ai_assistant_answer_strategy_use',EXCHANGE='public.assistant_exchange';
type Table=typeof INTENT|typeof ARM|typeof EVALUATION|typeof USE|typeof EXCHANGE;
async function count(table:Table){const[row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from ${sql.raw(table)} where tenant_id=${base.tenantId}::uuid`);return row.n;}
/** Native accounting is not erasure scope: admitted runs and monetary holds must survive and settle. */
async function accounting(){const runs=await owner.db.execute<{id:string;state:string}>(sql`select id::text as id,state from public.ai_model_run where tenant_id=${base.tenantId}::uuid order by id`),holds=await owner.db.execute<{run_id:string}>(sql`select run_id::text as run_id from app.ai_spend_reservation where tenant_id=${base.tenantId}::uuid order by run_id`);return{runs:Array.from(runs,row=>({id:row.id,state:row.state})),holds:Array.from(holds,row=>row.run_id)};}
function expectAccountingSurvived(atPause:Awaited<ReturnType<typeof accounting>>,after:Awaited<ReturnType<typeof accounting>>){
 expect(atPause.runs.length).toBeGreaterThan(0);expect(after.runs.map(row=>row.id)).toEqual(atPause.runs.map(row=>row.id));expect(after.runs.filter(row=>row.state==='pending')).toEqual([]);expect(after.holds).toEqual(atPause.holds);
}
type IntentCopy={id:string;candidate_id:string;evaluator_person_id:string|null;source_digest:string;provider_fingerprint:string;suite_digest:string;receipt:string;incarnation:string};
async function pendingIntent(){const rows=await owner.db.execute<IntentCopy>(sql`select id::text as id,candidate_id::text as candidate_id,evaluator_person_id::text as evaluator_person_id,source_digest,provider_fingerprint,suite_digest,receipt,incarnation::text as incarnation from public.ai_assistant_answer_evaluation_intent where tenant_id=${base.tenantId}::uuid and state='pending' order by id`);expect(rows.length).toBe(1);return rows[0];}
/** The app role re-inserts the erased row with the SAME id and ciphertext; only the database can choose incarnation. */
async function copyBack(reviewer:Actor,old:IntentCopy){const[copy]=await withTenant(reviewer,tx=>tx.execute<{incarnation:string}>(sql`insert into public.ai_assistant_answer_evaluation_intent(id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,source_digest,provider_fingerprint,suite_digest,receipt) values(${old.id}::uuid,${base.tenantId}::uuid,${old.candidate_id}::uuid,${reviewer.userId}::uuid,${old.evaluator_person_id}::uuid,${old.source_digest},${old.provider_fingerprint},${old.suite_digest},${old.receipt}) returning incarnation::text as incarnation`));expect(copy.incarnation).toMatch(/^\d+$/);expect(copy.incarnation).not.toBe(old.incarnation);expect(Number(copy.incarnation)).toBeGreaterThan(Number(old.incarnation));return copy.incarnation;}
async function intentState(id:string){return Array.from(await owner.db.execute<{state:string;evaluation_id:string|null;incarnation:string}>(sql`select state,evaluation_id::text as evaluation_id,incarnation::text as incarnation from public.ai_assistant_answer_evaluation_intent where id=${id}::uuid`),row=>({...row}));}
const pdpaRequest=(employmentId:string)=>({subjectEmploymentId:employmentId,scope:'contact' as const,reason:'Fictional canonical privacy request',requestRef:'fictional-evaluation-fence-'+randomUUID()});

describe('in-flight evaluation cannot recreate erased conversation metadata',()=>{
 it('self-erasure during a paused tool-step call refuses the next admission: no further call, arm, intent or evaluation; accounting survives settled',async()=>{
  const a=await candidate(),transport=evaluationTransport('tool'),running=settle(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()}));
  try{
   await transport.atPause;expect(await count(INTENT)).toBe(1);const atPause=await accounting();
   await eraseOwnConversationStrategyMetadata(a.reviewer);expect(await count(INTENT)).toBe(0);expect(await count(ARM)).toBe(0);
   transport.release();expect(refusal(await running)).toMatchObject(REFUSED);
   expect(transport.spy.mock.calls.length).toBe(transport.callsAtPause());
   expect(await count(INTENT)).toBe(0);expect(await count(ARM)).toBe(0);expect(await count(EVALUATION)).toBe(0);expectAccountingSurvived(atPause,await accounting());
  }finally{transport.release();await running;}
 },120000);
 it('self-erasure during a paused terminal call refuses the arm checkpoint and finalization',async()=>{
  const a=await candidate(),transport=evaluationTransport('terminal'),running=settle(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()}));
  try{
   await transport.atPause;const atPause=await accounting();
   await eraseOwnConversationStrategyMetadata(a.reviewer);expect(await count(INTENT)).toBe(0);expect(await count(ARM)).toBe(0);
   transport.release();expect(refusal(await running)).toMatchObject(REFUSED);
   expect(transport.spy.mock.calls.length).toBe(transport.callsAtPause());
   expect(await count(INTENT)).toBe(0);expect(await count(ARM)).toBe(0);expect(await count(EVALUATION)).toBe(0);expectAccountingSurvived(atPause,await accounting());
  }finally{transport.release();await running;}
 },120000);
 it('own raw-history clear invalidates the outstanding intent through the shared bridge, so no checkpoint follows it',async()=>{
  const a=await candidate(),transport=evaluationTransport('terminal'),running=settle(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()}));
  try{
   await transport.atPause;const atPause=await accounting(),armsAtPause=await count(ARM);
   expect(await eraseOwnAssistantHistory(a.reviewer)).toEqual({retired:0});expect(await count(INTENT)).toBe(0);
   transport.release();expect(refusal(await running)).toMatchObject(REFUSED);
   expect(transport.spy.mock.calls.length).toBe(transport.callsAtPause());
   // History clear retires transcripts and in-flight custody only; it adds no checkpoint after erasure.
   expect(await count(ARM)).toBe(armsAtPause);expect(await count(INTENT)).toBe(0);expect(await count(EVALUATION)).toBe(0);expectAccountingSurvived(atPause,await accounting());
  }finally{transport.release();await running;}
 },120000);
 it('canonical PDPA erasure of the evaluator during a paused terminal call deletes the intent and nothing is written afterwards',async()=>{
  const a=await candidate(),transport=evaluationTransport('terminal'),running=settle(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()}));
  try{
   await transport.atPause;const atPause=await accounting();
   const report=await erasePersonPii(adminCtx(base),pdpaRequest(a.reviewer.employmentId));expect(report.erased).toContain('assistantConversationLearning');expect(await count(INTENT)).toBe(0);expect(await count(ARM)).toBe(0);
   transport.release();expect((await running).ok).toBe(false);
   expect(transport.spy.mock.calls.length).toBe(transport.callsAtPause());
   expect(await count(INTENT)).toBe(0);expect(await count(ARM)).toBe(0);expect(await count(EVALUATION)).toBe(0);expectAccountingSurvived(atPause,await accounting());
  }finally{transport.release();await running;}
 },120000);
 it('an erased intent copied back with the same id and ciphertext gets a new incarnation and cannot resume the old dispatch',async()=>{
  const a=await candidate(),transport=evaluationTransport('terminal'),running=settle(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()}));
  try{
   await transport.atPause;const old=await pendingIntent();
   await eraseOwnConversationStrategyMetadata(a.reviewer);expect(await count(INTENT)).toBe(0);const incarnation=await copyBack(a.reviewer,old);
   transport.release();expect(refusal(await running)).toMatchObject(REFUSED);
   expect(transport.spy.mock.calls.length).toBe(transport.callsAtPause());
   expect(await count(ARM)).toBe(0);expect(await count(EVALUATION)).toBe(0);expect(await intentState(old.id)).toEqual([{state:'pending',evaluation_id:null,incarnation}]);
  }finally{transport.release();await running;}
 },120000);
 it('erasure plus a same-id copy between the last checkpoint and finalization refuses completion and records no evaluation',async()=>{
  const a=await candidate(),transport=evaluationTransport(null),original=conversationHarness.executeAssistantConversationHoldout;let old:IntentCopy|undefined,incarnation:string|undefined;
  vi.spyOn(conversationHarness,'executeAssistantConversationHoldout').mockImplementationOnce(async(...args:Parameters<typeof original>)=>{const report=await original(...args);old=await pendingIntent();await eraseOwnConversationStrategyMetadata(a.reviewer);incarnation=await copyBack(a.reviewer,old);return report;});
  expect(refusal(await settle(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()})))).toMatchObject(REFUSED);
  expect(transport.spy).toHaveBeenCalled();expect(old).toBeDefined();expect(incarnation).toBeDefined();
  expect(await count(EVALUATION)).toBe(0);expect(await count(ARM)).toBe(0);expect(await intentState(old!.id)).toEqual([{state:'pending',evaluation_id:null,incarnation}]);
 },120000);
 it('physical intent deletes and copies need Access custody: a competing holder refuses app, bridge and owner SQL with 55P03',async()=>{
  const a=await candidate(),id=randomUUID(),digest='a'.repeat(64),insert=(row:string)=>withTenant(a.reviewer,tx=>tx.execute(sql`insert into public.ai_assistant_answer_evaluation_intent(id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,source_digest,provider_fingerprint,suite_digest,receipt) values(${row}::uuid,${base.tenantId}::uuid,${a.candidateId}::uuid,${a.reviewer.userId}::uuid,${a.reviewer.personId}::uuid,${digest},${digest},${digest},'fictional-opaque-intent-receipt')`));
  await insert(id);expect(await count(INTENT)).toBe(1);
  let ready!:()=>void,release!:()=>void;const entered=new Promise<void>(yes=>{ready=yes;}),done=new Promise<void>(yes=>{release=yes;});
  const busy={cause:expect.objectContaining({code:'55P03'})},timeout=setTimeout(()=>release(),10000),holder=withTenant(a.author,async tx=>{await lockAccessConfigurationTx(tx,base.tenantId);ready();await done;});
  try{
   await entered;
   await expect(withTenant(a.reviewer,tx=>tx.execute(sql`delete from public.ai_assistant_answer_evaluation_intent where id=${id}::uuid`))).rejects.toMatchObject(busy);
   await expect(withTenant(a.reviewer,tx=>tx.execute(sql`select app.assistant_answer_invalidate_own_strategy_uses()`))).rejects.toMatchObject(busy);
   await expect(owner.db.execute(sql`delete from public.ai_assistant_answer_evaluation_intent where id=${id}::uuid`)).rejects.toMatchObject(busy);
   await expect(insert(randomUUID())).rejects.toMatchObject(busy);
   expect(await count(INTENT)).toBe(1);
  }finally{release();clearTimeout(timeout);await holder;}
  await withTenant(a.reviewer,tx=>tx.execute(sql`delete from public.ai_assistant_answer_evaluation_intent where id=${id}::uuid`));expect(await count(INTENT)).toBe(0);
 },120000);
});

const QUESTION='fictional fenced human question';
async function prepare(ctx:SessionContext){return withTenant(ctx,async tx=>{const cfg=await resolveActiveAiConfig(tx,ctx,'hr_assistant');if(!cfg)throw Error('Missing fictional configured provider');return prepareAssistantConversationStrategyTx(tx,ctx,await bindAiSpendTaskTx(tx,ctx,cfg,{kind:'assistant_question'}),QUESTION);});}
async function persist(tx:Tx,ctx:SessionContext,capability:Parameters<typeof completeAssistantConversationStrategyTx>[2]){await recheckAssistantConversationStrategyTx(tx,ctx,capability);const id=randomUUID();await tx.execute(sql`insert into public.assistant_exchange(id,tenant_id,app_user_id,question,answer) values(${id}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${QUESTION},'FICTIONAL LATE MAIN REPLY')`);await completeAssistantConversationStrategyTx(tx,ctx,capability,id);return id;}
/** The marker question stays local. Even this source-free custody fixture uses a genuine protected
 * task, on the SAME issued strategy/root, rather than granting privacy authority to raw turns. */
async function ask(selected:Awaited<ReturnType<typeof prepare>>){
 const task=await preparePrivateAiTask(selected.configuration,ASSISTANT_PRIVATE_CONTRACT,async()=>privateAssistantCatalogue('module_overview',[],selected.variant));
 try{if(task.operation!=='conversation')throw Error('Expected protected conversation');expect(JSON.stringify(task.args)).not.toContain(QUESTION);return await converse(task.configuration,task.args);}finally{task.dispose();}
}
async function reachedMainTransport(atPause:Promise<void>,running:Promise<Settled<unknown>>){
 await Promise.race([atPause,running.then(result=>{if(!result.ok)throw result.error;throw Error('Main call settled before reaching the paused transport');})]);
}

describe('in-flight main question shares the same marker fence',()=>{
 it('self-erasure while the provider call is paused leaves the late reply unpersistable, refuses further calls and keeps accounting',async()=>{
  const a=await actors();await installSyntheticSpendCapability(a.author,spendFixture);const selected=await prepare(a.author),transport=mainTransport(),running=settle(ask(selected));
  try{
   await reachedMainTransport(transport.atPause,running);expect(await count(USE)).toBe(1);const atPause=await accounting();
   await eraseOwnConversationStrategyMetadata(a.author);expect(await count(USE)).toBe(0);
   transport.release();const late=await running;expect(late.ok).toBe(true);
   await expect(withTenant(a.author,tx=>persist(tx,a.author,selected.capability))).rejects.toThrow();
   await expect(ask(selected)).rejects.toThrow();expect(transport.spy).toHaveBeenCalledTimes(1);
   expect(await count(EXCHANGE)).toBe(0);expect(await count(USE)).toBe(0);expectAccountingSurvived(atPause,await accounting());
  }finally{transport.release();await running;}
 },120000);
 it('a same-id strategy marker copied back with its original dates and ciphertext cannot complete the old in-memory question',async()=>{
  const a=await actors();await installSyntheticSpendCapability(a.author,spendFixture);const selected=await prepare(a.author),transport=mainTransport(),running=settle(ask(selected));
  try{
   await reachedMainTransport(transport.atPause,running);
   const[old]=await owner.db.execute<{id:string;user_id:string;person_id:string|null;promotion_id:string|null;candidate_digest:string;provider_fingerprint:string;source_digest:string;receipt:string;created_at:string;expires_at:string;incarnation:string}>(sql`select id::text as id,user_id::text as user_id,person_id::text as person_id,promotion_id::text as promotion_id,candidate_digest,provider_fingerprint,source_digest,receipt,created_at::text as created_at,expires_at::text as expires_at,incarnation::text as incarnation from public.ai_assistant_answer_strategy_use where tenant_id=${base.tenantId}::uuid and state='pending'`);
   expect(old).toBeDefined();await eraseOwnConversationStrategyMetadata(a.author);expect(await count(USE)).toBe(0);
   // Physical copy of every non-identity column, including dates; only the identity can differ.
   const[copy]=await owner.db.execute<{incarnation:string}>(sql`insert into public.ai_assistant_answer_strategy_use(id,tenant_id,user_id,person_id,promotion_id,candidate_digest,provider_fingerprint,source_digest,state,receipt,created_at,expires_at) values(${old.id}::uuid,${base.tenantId}::uuid,${old.user_id}::uuid,${old.person_id}::uuid,${old.promotion_id}::uuid,${old.candidate_digest},${old.provider_fingerprint},${old.source_digest},'pending',${old.receipt},${old.created_at}::timestamptz,${old.expires_at}::timestamptz) returning incarnation::text as incarnation`);
   expect(copy.incarnation).not.toBe(old.incarnation);
   transport.release();expect((await running).ok).toBe(true);
   await expect(withTenant(a.author,tx=>persist(tx,a.author,selected.capability))).rejects.toThrow();
   expect(await count(EXCHANGE)).toBe(0);
   expect(Array.from(await owner.db.execute(sql`select state,exchange_id::text as exchange_id,incarnation::text as incarnation from public.ai_assistant_answer_strategy_use where id=${old.id}::uuid`),row=>({...row}))).toEqual([{state:'pending',exchange_id:null,incarnation:copy.incarnation}]);
  }finally{transport.release();await running;}
 },120000);
});

async function ledger(candidateId:string){return Array.from(await owner.db.execute<{fixture_id:string;arm:string;admitted:number}>(sql`select fixture_id,arm,admitted from public.ai_assistant_answer_evaluation_budget where tenant_id=${base.tenantId}::uuid and candidate_id=${candidateId}::uuid order by fixture_id,arm`),row=>({...row}));}
/** Physical-owner fixture standing in for earlier invocations' spend; the app role can never set a count. */
async function seedLedger(candidateId:string,fixture:string,arm:'total'|'baseline'|'candidate',admitted:number){await owner.db.execute(sql`insert into public.ai_assistant_answer_evaluation_budget(tenant_id,candidate_id,fixture_id,arm,admitted) values(${base.tenantId}::uuid,${candidateId}::uuid,${fixture},${arm},${admitted})`);}
describe('cumulative provider-call ledger across invocations, retries and evaluators',()=>{
 it('charges every admitted call to its exact queued arm and to the candidate total, accumulating across invocations',async()=>{
  const a=await candidate(),transport=evaluationTransport(null);
  for(let invocation=0;invocation<2;invocation++){
   await evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});
   const rows=await ledger(a.candidateId),arms=rows.filter(row=>row.arm!=='total'),stored=await owner.db.execute<{fixture_id:string;arm:string}>(sql`select fixture_id,arm from public.ai_assistant_answer_evaluation_arm where tenant_id=${base.tenantId}::uuid and candidate_id=${a.candidateId}::uuid order by fixture_id,arm`);
   expect(rows.find(row=>row.arm==='total')?.admitted).toBe(transport.spy.mock.calls.length);
   expect(arms.reduce((sum,row)=>sum+row.admitted,0)).toBe(transport.spy.mock.calls.length);
   expect(arms.map(row=>row.fixture_id+':'+row.arm)).toEqual(Array.from(stored,row=>row.fixture_id+':'+row.arm));
   for(const row of arms)expect(row.admitted).toBe(ASSISTANT_CONVERSATION_HOLDOUTS.find(fixture=>fixture.id===row.fixture_id)!.expectedTools.length+1);
  }
  expect(transport.spy.mock.calls.length).toBeGreaterThan(12);
 },120000);
 it('an exhausted candidate total refuses before any intent, provider call or evaluation, and erasure never resets it',async()=>{
  const a=await candidate(),transport=evaluationTransport(null);await seedLedger(a.candidateId,'*','total',ASSISTANT_CONVERSATION_CANDIDATE_CALL_LIMIT);const before=await ledger(a.candidateId);
  await expect(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()})).rejects.toMatchObject(REFUSED);
  expect(transport.spy).not.toHaveBeenCalled();expect(await count(INTENT)).toBe(0);expect(await count(EVALUATION)).toBe(0);
  await eraseOwnConversationStrategyMetadata(a.reviewer);await eraseOwnAssistantHistory(a.reviewer);await erasePersonPii(adminCtx(base),pdpaRequest(a.reviewer.employmentId));
  expect(await ledger(a.candidateId)).toEqual(before);
  // A different, untouched evaluator proves the refusal is the ledger, not the erased evaluator's state.
  const second=await actor('Fictional Fence Second Reviewer');
  await expect(evaluateConversationAgentCandidate(second,{candidateId:a.candidateId,consent:consent()})).rejects.toMatchObject(REFUSED);
  expect(transport.spy).not.toHaveBeenCalled();expect(await ledger(a.candidateId)).toEqual(before);expect(await count(INTENT)).toBe(0);
 },120000);
 it('one remaining candidate call admits exactly one provider call, refuses the next admission mid-run, then refuses upfront',async()=>{
  const a=await candidate(),transport=evaluationTransport(null);await seedLedger(a.candidateId,'*','total',ASSISTANT_CONVERSATION_CANDIDATE_CALL_LIMIT-1);
  const report=await evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});expect(report.state).toBe('incomplete');expect(transport.spy).toHaveBeenCalledTimes(1);
  expect((await ledger(a.candidateId)).find(row=>row.arm==='total')?.admitted).toBe(ASSISTANT_CONVERSATION_CANDIDATE_CALL_LIMIT);
  await expect(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()})).rejects.toMatchObject(REFUSED);expect(transport.spy).toHaveBeenCalledTimes(1);
 },120000);
 it('a repeatedly retried queue-head arm never exceeds its own bound and, once exhausted, refuses upfront',async()=>{
  const a=await candidate(),transport=evaluationTransport(null),head=ASSISTANT_CONVERSATION_HOLDOUTS[0];expect(head.expectedTools.length).toBeGreaterThan(0);
  await seedLedger(a.candidateId,head.id,'baseline',ASSISTANT_CONVERSATION_ARM_CALL_LIMIT-1);
  const report=await evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()});expect(report.state).toBe('incomplete');expect(transport.spy).toHaveBeenCalledTimes(1);
  const rows=await ledger(a.candidateId);expect(rows.find(row=>row.fixture_id===head.id&&row.arm==='baseline')?.admitted).toBe(ASSISTANT_CONVERSATION_ARM_CALL_LIMIT);expect(rows.find(row=>row.arm==='total')?.admitted).toBe(1);expect(await count(ARM)).toBe(0);
  await expect(evaluateConversationAgentCandidate(a.reviewer,{candidateId:a.candidateId,consent:consent()})).rejects.toMatchObject(REFUSED);expect(transport.spy).toHaveBeenCalledTimes(1);
 },120000);
});
