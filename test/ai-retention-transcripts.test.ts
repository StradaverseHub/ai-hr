/** Authored UNRUN. Requires the coordinated AI drafts (assistant-conversation-candidates, then
 * assistant-transcript-retention) to be centrally allocated, journaled and applied; until then these
 * cases fail on missing relations/functions and are not evidence. Fictional raw content only; no
 * provider, inline migration, accelerated clock or allowance shortcut. Expiry runs through the real
 * operator maintenance tick (owner connection), never an app session.
 */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {retireExpiredAiCustodyTx} from '../core/ai-retention-maintenance';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let base:Base,userId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional transcript owner',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 userId=await createAppUser(base.tenantId,hired.personId,'employee');});
const zero={reviews:0,feedback:0,transcripts:0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0};
async function exchange(tenantId:string,user:string,ageDays:number){const id=randomUUID();await owner.db.execute(sql`insert into public.assistant_exchange(id,tenant_id,app_user_id,asked_at,question,answer,tool_calls,disclosure_receipt,error,provider,model,turn_count,input_tokens,output_tokens,cached_input_tokens)
 values(${id}::uuid,${tenantId}::uuid,${user}::uuid,clock_timestamp()-make_interval(days=>${ageDays}),'FICTIONAL PRIVATE QUESTION','FICTIONAL PRIVATE ANSWER','[{"name":"fixture","input":{"private":"FICTIONAL INPUT"},"rowCount":1}]'::jsonb,'FICTIONAL SEALED PROOF','FICTIONAL GENERIC ERROR','openai','fictional-model',2,11,3,2)`);return id;}
/** In-window consent opinion linked to an exchange; only the exchange's retirement may remove it. */
async function linkedFeedback(exchangeId:string,user:string){const id=randomUUID();await owner.db.execute(sql`insert into public.ai_agent_feedback(id,tenant_id,user_id,exchange_id,outcome,consented,created_at,expires_at)
 values(${id}::uuid,${base.tenantId}::uuid,${user}::uuid,${exchangeId}::uuid,'helpful',true,now()-interval '1 day',now()+interval '29 days')`);return id;}
type ExchangeRow={id:string;question:string;answer:string|null;tool_calls:unknown;disclosure_receipt:string|null;error:string|null;content_retired_at:Date|null;[column:string]:unknown};
const exchanges=()=>owner.db.execute<ExchangeRow>(sql`select id,tenant_id,app_user_id,asked_at,created_at,question,answer,tool_calls,disclosure_receipt,error,content_retired_at,provider,model,turn_count,input_tokens,output_tokens,cached_input_tokens from public.assistant_exchange order by id`);
/** Everything that must survive retirement: identity, dates, tokens and usage-bearing metadata. */
const accounting=(rows:ExchangeRow[])=>rows.map(({question:_q,answer:_a,tool_calls:_t,disclosure_receipt:_d,error:_e,content_retired_at:_r,...kept})=>kept);
const identities=async(id:string)=>{const[row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.assistant_transcript_identity where exchange_id=${id}::uuid`);return row.n;};
async function protectedState(){return{usage:await owner.db.execute(sql`select * from public.assistant_usage order by tenant_id,period`),model:await owner.db.execute(sql`select * from public.ai_model_run order by id`),money:await owner.db.execute(sql`select * from app.ai_spend_reservation order by run_id`),requests:await owner.db.select().from(schema.leaveRequest).orderBy(schema.leaveRequest.id),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,base.tenantId)).orderBy(schema.domainEvent.id)};}
const retired=(row:ExchangeRow|undefined)=>{expect(row).toMatchObject({question:'',answer:null,tool_calls:[],disclosure_receipt:null,error:null});expect(row?.content_retired_at).not.toBeNull();};

describe('automatic 30-day raw transcript retirement through operator maintenance',()=>{
 it('retires stored expired content, keeps identity/dates/tokens/usage/canonical records, counts only exchanges and is idempotent',async()=>{
  const old=await exchange(base.tenantId,userId,31),fresh=await exchange(base.tenantId,userId,0),feedback=await linkedFeedback(old,userId);
  expect(await identities(old)).toBe(1);const before=await exchanges(),protectedBefore=await protectedState();
  const result=await runAiRetentionTick(owner);
  // Linked in-window feedback retires WITH the content and is deliberately not counted as expired feedback.
  expect(result).toEqual({...zero,tenants:1,busy:0,transcripts:1,backlog:false,oldestExpiredAgeSeconds:null});
  for(const id of [old,fresh,feedback,userId,base.tenantId])expect(JSON.stringify(result)).not.toContain(id);
  const after=await exchanges();expect(after).toHaveLength(before.length);expect(accounting(after)).toEqual(accounting(before));
  retired(after.find(row=>row.id===old));expect(after.find(row=>row.id===fresh)).toEqual(before.find(row=>row.id===fresh));
  const[left]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_feedback where id=${feedback}::uuid`);expect(left.n).toBe(0);
  expect(await identities(old)).toBe(0);expect(await identities(fresh)).toBe(1);expect(await protectedState()).toEqual(protectedBefore);
  const[today]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.assistant_exchange where app_user_id=${userId}::uuid and asked_at>=date_trunc('day',clock_timestamp())`);expect(today.n).toBe(1);
  expect(await runAiRetentionTick(owner)).toEqual({...zero,tenants:0,busy:0,backlog:false,oldestExpiredAgeSeconds:null});expect(await exchanges()).toEqual(after);
 });
 it('bounds a tenant pass to100 exchanges, reports the real remaining backlog and finishes in a separate pass',async()=>{
  await owner.db.execute(sql`insert into public.assistant_exchange(id,tenant_id,app_user_id,asked_at,question,answer)
   select gen_random_uuid(),${base.tenantId}::uuid,${userId}::uuid,clock_timestamp()-interval '31 days'-make_interval(secs=>g),'FICTIONAL BULK QUESTION','FICTIONAL BULK ANSWER' from generate_series(1,101) g`);
  const first=await runAiRetentionTick(owner);expect(first).toMatchObject({...zero,tenants:1,busy:0,transcripts:100,backlog:true});expect(first.oldestExpiredAgeSeconds).toBeGreaterThan(0);
  const[open]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.assistant_exchange where content_retired_at is null`);expect(open.n).toBe(1);
  expect(await runAiRetentionTick(owner)).toEqual({...zero,tenants:1,busy:0,transcripts:1,backlog:false,oldestExpiredAgeSeconds:null});
  const all=await exchanges();expect(all).toHaveLength(101);all.forEach(row=>retired(row));
 });
 it('selects at most ten tenants per pass and leaves the rest for the next pass',async()=>{
  const bases=[base];for(let index=0;index<10;index++)bases.push(await seedBase());
  for(const tenant of bases)await exchange(tenant.tenantId,tenant.adminUserId,31);
  const first=await runAiRetentionTick(owner);expect(first).toMatchObject({...zero,tenants:10,busy:0,transcripts:10,backlog:true});
  for(const tenant of bases)expect(JSON.stringify(first)).not.toContain(tenant.tenantId);
  expect(await runAiRetentionTick(owner)).toEqual({...zero,tenants:1,busy:0,transcripts:1,backlog:false,oldestExpiredAgeSeconds:null});
 });
 it('skips a genuinely held Access interval without touching raw content, then retires after release',async()=>{
  const old=await exchange(base.tenantId,userId,31),before=await exchanges();
  let ready!:()=>void,fail!:(error:unknown)=>void,release!:()=>void;
  const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
  const watchdog=setTimeout(()=>{fail(Error('owned transcript handshake timed out'));release();},10_000);
  const holder=withTenant(adminCtx(base),async tx=>{await lockAccessConfigurationTx(tx,base.tenantId);ready();await finish;});void holder.catch(fail);
  try{await started;const result=await runAiRetentionTick(owner);expect(result).toMatchObject({...zero,tenants:1,busy:1,transcripts:0,backlog:true});expect(await exchanges()).toEqual(before);}
  finally{release();clearTimeout(watchdog);await holder;}
  expect(await runAiRetentionTick(owner)).toMatchObject({tenants:1,busy:0,transcripts:1,backlog:false});retired((await exchanges()).find(row=>row.id===old));
 });
 it('rolls stored retirement, identity custody and linked feedback back with the owning transaction',async()=>{
  const old=await exchange(base.tenantId,userId,31);await linkedFeedback(old,userId);const before=await exchanges();
  await expect(owner.db.transaction(async tx=>{expect((await retireExpiredAiCustodyTx(tx as unknown as Tx)).transcripts).toBe(1);throw Error('Fictional later maintenance failure');})).rejects.toThrow('Fictional later maintenance failure');
  expect(await exchanges()).toEqual(before);expect(await identities(old)).toBe(1);
  const[kept]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.ai_agent_feedback where exchange_id=${old}::uuid`);expect(kept.n).toBe(1);
 });
 it('refuses an application session for both the owner helper and the maintenance tick without changes',async()=>{
  await exchange(base.tenantId,userId,31);const before=await exchanges();
  await expect(withTenant(adminCtx(base),tx=>tx.execute(sql`select app.assistant_transcripts_retire_expired(${base.tenantId}::uuid,30,100)`))).rejects.toThrow();
  await expect(withTenant(adminCtx(base),tx=>retireExpiredAiCustodyTx(tx))).rejects.toThrow('AI retention maintenance could not be confirmed');
  expect(await exchanges()).toEqual(before);
 });
 it('expires evaluation intents as counted metadata and leaves in-window pending intents untouched',async()=>{
  const candidate=randomUUID(),digest='c'.repeat(64);
  await owner.db.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
   values(${candidate}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${base.adminUserId}::uuid,'assistant',1,'assistant_answer_prompt_v1','{"kind":"assistant_answer_prompt_v1","variant":"focused_v1"}'::jsonb,${digest},${digest},${digest},${digest},${digest},${digest})`);
  const intent=async(expired:boolean)=>{const id=randomUUID(),hash='d'.repeat(64);await owner.db.execute(sql`insert into public.ai_assistant_answer_evaluation_intent(id,tenant_id,candidate_id,evaluator_user_id,source_digest,provider_fingerprint,suite_digest,receipt,created_at,expires_at)
   values(${id}::uuid,${base.tenantId}::uuid,${candidate}::uuid,${userId}::uuid,${hash},${hash},${hash},'synthetic-intent-custody-not-evaluation-proof',clock_timestamp()-case when ${expired} then interval '31 days' else interval '1 hour' end,clock_timestamp()+case when ${expired} then interval '-1 day' else interval '29 days' end)`);return id;};
  const expired=await intent(true),pending=await intent(false);
  const[kept]=await owner.db.execute<{incarnation:string}>(sql`select incarnation::text as incarnation from public.ai_assistant_answer_evaluation_intent where id=${pending}::uuid`);
  expect(await runAiRetentionTick(owner)).toEqual({...zero,tenants:1,busy:0,conversationIntents:1,backlog:false,oldestExpiredAgeSeconds:null});
  const rows=await owner.db.execute<{id:string;state:string;incarnation:string}>(sql`select id,state,incarnation::text as incarnation from public.ai_assistant_answer_evaluation_intent order by id`);
  expect(rows).toEqual([{id:pending,state:'pending',incarnation:kept.incarnation}]);expect(rows.some(row=>row.id===expired)).toBe(false);
 });
});
