/** Authored UNRUN. Requires coordinated transcript+conversation SQL and parent PDPA hook.
 * Fictional transcripts are explicit fixtures; actual principal/RLS/retirement/marker owners run.
 * No provider, inline migration, accelerated clock or financial-refund shortcut is used.
 */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {recordOwnAgentFeedback} from '../core/module-agent-feedback';
import {erasePersonPii,erasePersonPiiTx} from '../core/pdpa';
import {saveAiProviderConfig,resolveActiveAiConfig} from '../core/ai-config';
import {bindAiSpendTaskTx} from '../core/ai-spend-task';
import {prepareAssistantConversationStrategyTx,recheckAssistantConversationStrategyTx} from '../core/module-agent-releases';
import {eraseOwnAssistantHistory,retireExpiredAssistantHistoryTx,ASSISTANT_TRANSCRIPT_RETENTION_DAYS} from '../core/assistant-history-retention';
import {adminCtx,createAppUser,entitledCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');vi.stubEnv('AI_CONFIG_SECRET','fictional-history-only-key');});
async function actor(base=b){const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional history owner',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}),userId=await createAppUser(base.tenantId,hired.personId,'employee');
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};return{ctx,hired};}
async function transcript(ctx:SessionContext,old=false){const id=randomUUID();await owner.db.execute(sql`insert into public.assistant_exchange(id,tenant_id,app_user_id,asked_at,question,answer,tool_calls,disclosure_receipt,error,input_tokens,output_tokens,cached_input_tokens) values(${id}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,clock_timestamp()-case when ${old} then interval '31 days' else interval '0 days' end,'FICTIONAL PRIVATE QUESTION','FICTIONAL PRIVATE ANSWER','[{"name":"fixture","input":{"private":"FICTIONAL INPUT"},"rowCount":1}]'::jsonb,'FICTIONAL SEALED PROOF','FICTIONAL GENERIC ERROR',11,3,2)`);return id;}
const rows=()=>owner.db.execute<{id:string;app_user_id:string;question:string;answer:string|null;tool_calls:unknown;disclosure_receipt:string|null;error:string|null;content_retired_at:Date|null;asked_at:Date;created_at:Date;input_tokens:number;output_tokens:number;cached_input_tokens:number}>(sql`select * from public.assistant_exchange order by id`);
const metadata=()=>owner.db.execute(sql`select id,app_user_id,asked_at,created_at,input_tokens,output_tokens,cached_input_tokens from public.assistant_exchange order by id`);
async function protectedState(){return{usage:await owner.db.execute(sql`select * from public.assistant_usage order by tenant_id,period`),model:await owner.db.execute(sql`select * from public.ai_model_run order by id`),money:await owner.db.execute(sql`select * from app.ai_spend_reservation order by run_id`),requests:await owner.db.execute(sql`select * from public.leave_request order by id`),events:await owner.db.execute(sql`select * from public.domain_event order by id`)};}
/** Fictional conversation metadata rows; the shared bridge, not transcript SQL, must erase and audit them. */
async function answerCandidate(){const id=randomUUID(),digest='c'.repeat(64);await owner.db.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
 values(${id}::uuid,${b.tenantId}::uuid,${b.adminUserId}::uuid,${b.adminUserId}::uuid,'assistant',1,'assistant_answer_prompt_v1','{"kind":"assistant_answer_prompt_v1","variant":"focused_v1"}'::jsonb,${digest},${digest},${digest},${digest},${digest},${digest})`);return id;}
async function pendingIntent(candidateId:string,ctx:SessionContext){const id=randomUUID(),hash='d'.repeat(64);await owner.db.execute(sql`insert into public.ai_assistant_answer_evaluation_intent(id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,source_digest,provider_fingerprint,suite_digest,receipt)
 values(${id}::uuid,${ctx.tenantId}::uuid,${candidateId}::uuid,${ctx.userId}::uuid,${ctx.personId??null}::uuid,${hash},${hash},${hash},'synthetic-intent-custody-not-evaluation-proof')`);return id;}
async function marker(ctx:SessionContext,exchangeId:string|null){const id=randomUUID(),hash='e'.repeat(64);await owner.db.execute(sql`insert into public.ai_assistant_answer_strategy_use(id,tenant_id,user_id,person_id,candidate_digest,provider_fingerprint,source_digest,receipt,state,exchange_id)
 values(${id}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${ctx.personId??null}::uuid,${hash},${hash},${hash},'synthetic-marker-custody-not-strategy-proof',case when ${exchangeId}::uuid is null then 'pending' else 'completed' end,${exchangeId}::uuid)`);return id;}
const conversationMetadata=()=>owner.db.execute(sql`select 'marker' as kind,id,user_id,state,exchange_id from public.ai_assistant_answer_strategy_use union all select 'intent',id,evaluator_user_id,state,null from public.ai_assistant_answer_evaluation_intent order by 1,2`);
const identities=()=>owner.db.execute(sql`select * from app.assistant_transcript_identity order by exchange_id`);
const retired=(row:Awaited<ReturnType<typeof rows>>[number])=>{expect(row).toMatchObject({question:'',answer:null,tool_calls:[],disclosure_receipt:null,error:null});expect(row.content_retired_at).not.toBeNull();};
describe('actual own transcript retirement without allowance reset',()=>{
 it('clears only actual own content after grant revocation and preserves rows/dates/usage/financial/native records',async()=>{
  const mine=await actor(),peer=await actor(),foreign=await actor(await seedBase()),id=await transcript(mine.ctx);await transcript(peer.ctx);await transcript(foreign.ctx);
  await grantAssistant(adminCtx(b),{appUserId:mine.ctx.userId!});await recordOwnAgentFeedback(mine.ctx,{exchangeId:id,outcome:'helpful',consented:true});await revokeAssistant(adminCtx(b),{appUserId:mine.ctx.userId!});const before=await metadata(),protectedBefore=await protectedState();
  expect(await eraseOwnAssistantHistory(mine.ctx)).toEqual({retired:1});const all=await rows();retired(all.find(row=>row.id===id)!);expect(all.filter(row=>row.id!==id).every(row=>row.question==='FICTIONAL PRIVATE QUESTION')).toBe(true);
  const[feedback]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_feedback where exchange_id=${id}::uuid`);expect(feedback.n).toBe(0);
  expect(await metadata()).toEqual(before);expect(await protectedState()).toEqual(protectedBefore);expect(await eraseOwnAssistantHistory(mine.ctx)).toEqual({retired:0});
  const[count]=await withTenant(mine.ctx,tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from public.assistant_exchange where app_user_id=app.current_user_id() and asked_at>=date_trunc('day',clock_timestamp())`));expect(count.n).toBe(1);
 });
 it('invalidates an actual prepared baseline marker before any next provider read or completion can persist',async()=>{
  const mine=await actor();await grantAssistant(adminCtx(b),{appUserId:mine.ctx.userId!});await saveAiProviderConfig(adminCtx(b),{provider:'openai',model:'fictional-history-model',apiKey:'fictional-key',makeActive:true});
  const selected=await withTenant(mine.ctx,async tx=>{const cfg=await resolveActiveAiConfig(tx,mine.ctx,'hr_assistant');if(!cfg)throw Error('Missing actual fixture configuration');return prepareAssistantConversationStrategyTx(tx,mine.ctx,await bindAiSpendTaskTx(tx,mine.ctx,cfg,{kind:'assistant_question'}),'Fictional in-flight private question');});
  await withTenant(mine.ctx,tx=>recheckAssistantConversationStrategyTx(tx,mine.ctx,selected.capability));await eraseOwnAssistantHistory(mine.ctx);
  await expect(withTenant(mine.ctx,tx=>recheckAssistantConversationStrategyTx(tx,mine.ctx,selected.capability))).rejects.toThrow();expect(await rows()).toEqual([]);
  const[markers]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_assistant_answer_strategy_use where user_id=${mine.ctx.userId}::uuid`);expect(markers.n).toBe(0);
 });
 it('rolls back raw retirement and marker deletion together on a real later transaction failure',async()=>{
  const mine=await actor();await transcript(mine.ctx);const before=await rows();
  await expect(withTenant(mine.ctx,async tx=>{await tx.execute(sql`select app.assistant_transcripts_erase_own()`);throw Error('Fictional later canonical failure');})).rejects.toThrow('Fictional later canonical failure');expect(await rows()).toEqual(before);
 });
 it('requires the explicit approved30day policy and physical owner, then retires only expired raw content',async()=>{
  const mine=await actor(),old=await transcript(mine.ctx,true),fresh=await transcript(mine.ctx),before=await metadata();expect(ASSISTANT_TRANSCRIPT_RETENTION_DAYS).toBe(30);
  for(const days of[undefined,0,7,90])await expect(owner.db.transaction(tx=>retireExpiredAssistantHistoryTx(tx as unknown as Tx,b.tenantId,days as number))).rejects.toThrow();
  await expect(withTenant(mine.ctx,tx=>retireExpiredAssistantHistoryTx(tx as unknown as Tx,b.tenantId,30))).rejects.toThrow();
  expect(await owner.db.transaction(tx=>retireExpiredAssistantHistoryTx(tx as unknown as Tx,b.tenantId,30))).toBe(1);const all=await rows();retired(all.find(row=>row.id===old)!);expect(all.find(row=>row.id===fresh)?.content_retired_at).toBeNull();expect(await metadata()).toEqual(before);
 });
 it('refuses during the actual calling-user source interval without partial content retirement, then succeeds after release',async()=>{
  const mine=await actor();await transcript(mine.ctx);const before=await rows();let ready!:()=>void,release!:()=>void;const entered=new Promise<void>(yes=>{ready=yes;}),done=new Promise<void>(yes=>{release=yes;});
  const timeout=setTimeout(()=>release(),10000),holder=withTenant(mine.ctx,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);ready();await done;});
  try{await entered;await expect(eraseOwnAssistantHistory(mine.ctx)).rejects.toThrow(/^Assistant history retirement unavailable\.$/);expect(await rows()).toEqual(before);}finally{release();clearTimeout(timeout);await holder;}
  expect(await eraseOwnAssistantHistory(mine.ctx)).toEqual({retired:1});retired((await rows())[0]);
 });
 it('does not let an authenticated caller nominate a foreign person erasure without the real canonical audit admission',async()=>{
  const mine=await actor();await transcript(mine.ctx);const before=await rows();await expect(withTenant(mine.ctx,tx=>tx.execute(sql`select app.assistant_transcripts_redact(${mine.hired.employmentId}::uuid)`))).rejects.toThrow();expect(await rows()).toEqual(before);
 });
 it('own clear invalidates the caller pending evaluation intent and main markers through the shared bridge, never a peer row',async()=>{
  const mine=await actor(),peer=await actor(),candidate=await answerCandidate(),own=await transcript(mine.ctx);
  await pendingIntent(candidate,mine.ctx);const peerIntent=await pendingIntent(candidate,peer.ctx);await marker(mine.ctx,null);await marker(mine.ctx,own);const peerMarker=await marker(peer.ctx,null);
  expect(await eraseOwnAssistantHistory(mine.ctx)).toEqual({retired:1});
  expect((await conversationMetadata()).map(row=>row.id).sort()).toEqual([peerIntent,peerMarker].sort());retired((await rows()).find(row=>row.id===own)!);
 });
 it('PDPA retires chat content and leaves marker erasure to the bridge so the audit records conversation learning too',async()=>{
  const subject=await actor(),own=await transcript(subject.ctx);await marker(subject.ctx,null);await marker(subject.ctx,own);
  await erasePersonPii(adminCtx(b),{subjectEmploymentId:subject.hired.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});
  retired((await rows()).find(row=>row.id===own)!);expect(await conversationMetadata()).toEqual([]);
  const[event]=await owner.db.execute<{payload:{erasedFields?:unknown}}>(sql`select payload from public.domain_event where tenant_id=${b.tenantId}::uuid and event_type='pii.erased' and aggregate_type='person' and aggregate_id=${subject.hired.personId}::uuid`);
  // Non-vacuous: transcript SQL that deleted these markers first would leave the bridge count at zero.
  expect(event?.payload.erasedFields).toEqual(expect.arrayContaining(['assistantChatContent','assistantConversationLearning']));
 });
 it('rolls PDPA chat-content retirement, identity custody and conversation metadata back together',async()=>{
  const subject=await actor(),own=await transcript(subject.ctx);await marker(subject.ctx,own);await pendingIntent(await answerCandidate(),subject.ctx);
  const before={rows:await rows(),metadata:await conversationMetadata(),identities:await identities()};
  await expect(withTenant(adminCtx(b),async tx=>{await erasePersonPiiTx(tx,adminCtx(b),{subjectEmploymentId:subject.hired.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});throw Error('Fictional later canonical failure');})).rejects.toThrow('Fictional later canonical failure');
  expect({rows:await rows(),metadata:await conversationMetadata(),identities:await identities()}).toEqual(before);
 });
 it('keeps the retention clock immutable and never reopens retired content, even for the physical owner',async()=>{
  const mine=await actor(),id=await transcript(mine.ctx,true);
  await expect(withTenant(mine.ctx,tx=>tx.execute(sql`update public.assistant_exchange set asked_at=clock_timestamp() where id=${id}::uuid`))).rejects.toThrow();
  await expect(owner.db.execute(sql`update public.assistant_exchange set asked_at=clock_timestamp() where id=${id}::uuid`)).rejects.toThrow();
  expect(await eraseOwnAssistantHistory(mine.ctx)).toEqual({retired:1});const before=await rows();
  await expect(owner.db.execute(sql`update public.assistant_exchange set content_retired_at=null where id=${id}::uuid`)).rejects.toThrow();
  await expect(owner.db.execute(sql`update public.assistant_exchange set question='FICTIONAL RESURRECTED QUESTION' where id=${id}::uuid`)).rejects.toThrow();
  expect(await rows()).toEqual(before);
 });
 it('joins actual person PDPA erasure using original capture and preserves later unrelated account history after relinking',async()=>{
  const original=await actor(),next=await actor(),old=await transcript(original.ctx);
  // Explicit owner fixture relink: source custody for old is already immutable and not recomputed.
  await owner.db.execute(sql`update public.app_user set person_id=${next.hired.personId}::uuid where id=${original.ctx.userId}::uuid`);
  const nextCtx={...original.ctx,personId:next.hired.personId},fresh=await transcript(nextCtx);
  await erasePersonPii(adminCtx(b),{subjectEmploymentId:original.hired.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});
  const all=await rows();retired(all.find(row=>row.id===old)!);expect(all.find(row=>row.id===fresh)?.question).toBe('FICTIONAL PRIVATE QUESTION');
 });
});
