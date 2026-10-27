/** Authored UNRUN. Requires the normally installed coordinated conversation-candidates draft; no skip
 * flag hides a missing table. Privileges are read from the live catalogue and exercised as the real
 * app role, never inferred from SQL text. Fictional opaque receipts only; nothing is decrypted. */
import {randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {createConversationAgentCandidate} from '../core/module-agent-releases';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-marker-acl-secret');vi.stubEnv('OPENAI_API_KEY','fictional-marker-acl-key');vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});

const TABLES={
 intent:{name:'public.ai_assistant_answer_evaluation_intent',identity:true,
  insert:['candidate_id','evaluator_person_id','evaluator_user_id','id','provider_fingerprint','receipt','source_digest','suite_digest','tenant_id'],update:['evaluation_id','state']},
 strategyUse:{name:'public.ai_assistant_answer_strategy_use',identity:true,
  insert:['candidate_digest','id','person_id','promotion_id','provider_fingerprint','receipt','source_digest','tenant_id','user_id'],update:['exchange_id','state']},
 arm:{name:'public.ai_assistant_answer_evaluation_arm',identity:false,
  insert:['arm','candidate_id','evaluator_person_id','evaluator_user_id','fixture_id','id','passed','provider_fingerprint','receipt','suite_digest','tenant_id'],update:['passed','receipt']},
} as const;
const MARKERS=[TABLES.intent.name,TABLES.strategyUse.name] as const;

describe('conversation marker ACL in the live catalogue',()=>{
 it.each(Object.entries(TABLES))('%s: the app role holds exactly its insert/update columns, no table-wide INSERT/UPDATE/TRUNCATE, and PUBLIC holds nothing',async(_key,table)=>{
  const columns=Array.from(await owner.db.execute<{name:string;can_insert:boolean;can_update:boolean}>(sql`select a.attname::text as name,has_column_privilege('ai_hr_app',a.attrelid,a.attnum,'INSERT') as can_insert,has_column_privilege('ai_hr_app',a.attrelid,a.attnum,'UPDATE') as can_update from pg_catalog.pg_attribute a where a.attrelid=${table.name}::regclass and a.attnum>0 and not a.attisdropped order by a.attname`),row=>({...row}));
  // Non-vacuity: these are real catalogue rows, and the table has columns the app may NOT write.
  expect(columns.length).toBeGreaterThan(table.insert.length);
  expect(columns.filter(row=>row.can_insert).map(row=>row.name)).toEqual([...table.insert]);
  expect(columns.filter(row=>row.can_update).map(row=>row.name)).toEqual([...table.update]);
  for(const forbidden of ['created_at','expires_at',...(table.identity?['incarnation']:[])])expect(columns.find(row=>row.name===forbidden)).toMatchObject({can_insert:false,can_update:false});
  const[whole]=await owner.db.execute<Record<string,boolean>>(sql`select has_table_privilege('ai_hr_app',${table.name}::text,'SELECT') as can_select,has_table_privilege('ai_hr_app',${table.name}::text,'DELETE') as can_delete,
   has_table_privilege('ai_hr_app',${table.name}::text,'INSERT') as table_insert,has_table_privilege('ai_hr_app',${table.name}::text,'UPDATE') as table_update,has_table_privilege('ai_hr_app',${table.name}::text,'TRUNCATE') as can_truncate,
   has_table_privilege('ai_hr_app',${table.name}::text,'REFERENCES') as can_reference,has_table_privilege('ai_hr_app',${table.name}::text,'TRIGGER') as can_trigger,has_any_column_privilege('public',${table.name}::text,'SELECT,INSERT,UPDATE') as public_any`);
  expect({...whole}).toEqual({can_select:true,can_delete:true,table_insert:false,table_update:false,can_truncate:false,can_reference:false,can_trigger:false,public_any:false});
 });
 it.each(MARKERS)('%s: incarnation is GENERATED ALWAYS and its sequence grants neither the app role nor PUBLIC anything',async table=>{
  const[row]=await owner.db.execute<{identity:string;sequence:string|null}>(sql`select a.attidentity::text as identity,pg_get_serial_sequence(${table}::text,'incarnation') as sequence from pg_catalog.pg_attribute a where a.attrelid=${table}::regclass and a.attname='incarnation' and not a.attisdropped`);
  expect(row).toBeDefined();expect(row.identity).toBe('a');expect(row.sequence).toMatch(/incarnation/);
  const[grants]=await owner.db.execute<Record<string,boolean>>(sql`select has_sequence_privilege('ai_hr_app',${row.sequence}::text,'USAGE') as app_usage,has_sequence_privilege('ai_hr_app',${row.sequence}::text,'SELECT') as app_select,
   has_sequence_privilege('ai_hr_app',${row.sequence}::text,'UPDATE') as app_update,has_sequence_privilege('public',${row.sequence}::text,'USAGE,SELECT,UPDATE') as public_any`);
  expect({...grants}).toEqual({app_usage:false,app_select:false,app_update:false,public_any:false});
 });
});

type Actor=SessionContext&{userId:string;personId:string};
async function actor(name:string):Promise<Actor>{const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}),userId=await createAppUser(base.tenantId,hired.personId,'hr_admin');await grantAssistant(adminCtx(base),{appUserId:userId});return{...await entitledCtx(base,['hr_admin']),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};}
const DIGEST='a'.repeat(64),DENIED={cause:expect.objectContaining({code:'42501'})},GENERATED_ALWAYS={cause:expect.objectContaining({code:'428C9'})};
async function sequenceOf(table:string){const[row]=await owner.db.execute<{name:string}>(sql`select pg_get_serial_sequence(${table}::text,'incarnation') as name`);expect(row.name).toMatch(/incarnation/);return row.name;}
async function incarnationOf(table:string,id:string){const[row]=await owner.db.execute<{incarnation:string}>(sql`select incarnation::text as incarnation from ${sql.raw(table)} where id=${id}::uuid`);return row.incarnation;}

describe('the real app role cannot choose, rewind or re-issue marker identity or retention',()=>{
 it('creates markers and checkpoint arms only with database-issued incarnation and dates',async()=>{
  const author=await actor('Fictional ACL Author'),reviewer=await actor('Fictional ACL Reviewer'),{candidateId}=await createConversationAgentCandidate(author,{version:1,configuration:{kind:'assistant_answer_prompt_v1',variant:'focused_v1'}});
  const as=(who:Actor,query:SQL)=>withTenant(who,tx=>tx.execute(query));
  const intentColumns=sql`id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,source_digest,provider_fingerprint,suite_digest,receipt`;
  const intentValues=(id:string)=>sql`${id}::uuid,${base.tenantId}::uuid,${candidateId}::uuid,${reviewer.userId}::uuid,${reviewer.personId}::uuid,${DIGEST},${DIGEST},${DIGEST},'fictional-opaque-intent-receipt'`;
  const useColumns=sql`id,tenant_id,user_id,person_id,promotion_id,candidate_digest,provider_fingerprint,source_digest,receipt`;
  const useValues=(id:string)=>sql`${id}::uuid,${base.tenantId}::uuid,${author.userId}::uuid,${author.personId}::uuid,null,${DIGEST},${DIGEST},${DIGEST},'fictional-opaque-use-receipt'`;
  const armColumns=sql`id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,provider_fingerprint,suite_digest,fixture_id,arm,passed,receipt`;
  const armValues=(id:string,fixture:string)=>sql`${id}::uuid,${base.tenantId}::uuid,${candidateId}::uuid,${reviewer.userId}::uuid,${reviewer.personId}::uuid,${DIGEST},${DIGEST},${fixture},'baseline',false,'fictional-opaque-arm-receipt'`;
  const later=sql`clock_timestamp()+interval '300 days'`;

  // Positive controls: the granted column lists succeed WITHOUT any sequence privilege.
  const intentId=randomUUID(),useId=randomUUID(),armId=randomUUID();
  const[intent]=await withTenant(reviewer,tx=>tx.execute<{incarnation:string}>(sql`insert into public.ai_assistant_answer_evaluation_intent(${intentColumns}) values(${intentValues(intentId)}) returning incarnation::text as incarnation`));
  const[use]=await withTenant(author,tx=>tx.execute<{incarnation:string}>(sql`insert into public.ai_assistant_answer_strategy_use(${useColumns}) values(${useValues(useId)}) returning incarnation::text as incarnation`));
  await as(reviewer,sql`insert into public.ai_assistant_answer_evaluation_arm(${armColumns}) values(${armValues(armId,'fictional-acl-fixture-1')})`);
  expect(intent.incarnation).toMatch(/^\d+$/);expect(use.incarnation).toMatch(/^\d+$/);

  // Identity: neither an explicit value nor OVERRIDING SYSTEM VALUE nor DEFAULT re-issue is available.
  await expect(as(reviewer,sql`insert into public.ai_assistant_answer_evaluation_intent(incarnation,${intentColumns}) overriding system value values(1,${intentValues(randomUUID())})`)).rejects.toMatchObject(DENIED);
  await expect(as(reviewer,sql`insert into public.ai_assistant_answer_evaluation_intent(incarnation,${intentColumns}) values(1,${intentValues(randomUUID())})`)).rejects.toMatchObject(GENERATED_ALWAYS);
  await expect(as(author,sql`insert into public.ai_assistant_answer_strategy_use(incarnation,${useColumns}) overriding system value values(1,${useValues(randomUUID())})`)).rejects.toMatchObject(DENIED);
  await expect(as(reviewer,sql`update public.ai_assistant_answer_evaluation_intent set incarnation=default where id=${intentId}::uuid`)).rejects.toMatchObject(DENIED);
  await expect(as(author,sql`update public.ai_assistant_answer_strategy_use set incarnation=default where id=${useId}::uuid`)).rejects.toMatchObject(DENIED);

  // Retention and lifecycle columns stay database-owned on INSERT and UPDATE.
  for(const column of ['created_at','expires_at','state'] as const){
   await expect(as(reviewer,sql`insert into public.ai_assistant_answer_evaluation_intent(${sql.raw(column)},${intentColumns}) values(${column==='state'?sql`'pending'`:later},${intentValues(randomUUID())})`)).rejects.toMatchObject(DENIED);
   await expect(as(author,sql`insert into public.ai_assistant_answer_strategy_use(${sql.raw(column)},${useColumns}) values(${column==='state'?sql`'pending'`:later},${useValues(randomUUID())})`)).rejects.toMatchObject(DENIED);
  }
  for(const column of ['created_at','expires_at'] as const){
   await expect(as(reviewer,sql`insert into public.ai_assistant_answer_evaluation_arm(${sql.raw(column)},${armColumns}) values(${later},${armValues(randomUUID(),'fictional-acl-fixture-2')})`)).rejects.toMatchObject(DENIED);
   await expect(as(reviewer,sql`update public.ai_assistant_answer_evaluation_intent set ${sql.raw(column)}=${later} where id=${intentId}::uuid`)).rejects.toMatchObject(DENIED);
   await expect(as(author,sql`update public.ai_assistant_answer_strategy_use set ${sql.raw(column)}=${later} where id=${useId}::uuid`)).rejects.toMatchObject(DENIED);
   await expect(as(reviewer,sql`update public.ai_assistant_answer_evaluation_arm set ${sql.raw(column)}=${later} where id=${armId}::uuid`)).rejects.toMatchObject(DENIED);
  }
  await expect(as(reviewer,sql`update public.ai_assistant_answer_evaluation_intent set receipt='fictional-replacement' where id=${intentId}::uuid`)).rejects.toMatchObject(DENIED);
  await expect(as(author,sql`update public.ai_assistant_answer_strategy_use set receipt='fictional-replacement' where id=${useId}::uuid`)).rejects.toMatchObject(DENIED);

  // Sequences: no read, draw or rewind. Then prove nothing moved and identity still advances.
  for(const [table,who] of [[TABLES.intent.name,reviewer],[TABLES.strategyUse.name,author]] as const){
   const sequence=await sequenceOf(table);
   await expect(as(who,sql`select nextval(${sequence}::regclass)`)).rejects.toMatchObject(DENIED);
   await expect(as(who,sql`select setval(${sequence}::regclass,1,false)`)).rejects.toMatchObject(DENIED);
   await expect(as(who,sql`select last_value from ${sql.raw(sequence)}`)).rejects.toMatchObject(DENIED);
  }
  expect(await incarnationOf(TABLES.intent.name,intentId)).toBe(intent.incarnation);expect(await incarnationOf(TABLES.strategyUse.name,useId)).toBe(use.incarnation);
  const nextId=randomUUID(),[next]=await withTenant(reviewer,tx=>tx.execute<{incarnation:string}>(sql`insert into public.ai_assistant_answer_evaluation_intent(${intentColumns}) values(${intentValues(nextId)}) returning incarnation::text as incarnation`));
  expect(Number(next.incarnation)).toBeGreaterThan(Number(intent.incarnation));
  const[dates]=await owner.db.execute<{bounded:boolean}>(sql`select bool_and(expires_at>created_at and expires_at<=created_at+interval '31 days' and created_at<=clock_timestamp()) as bounded from (select created_at,expires_at from public.ai_assistant_answer_evaluation_intent union all select created_at,expires_at from public.ai_assistant_answer_strategy_use union all select created_at,expires_at from public.ai_assistant_answer_evaluation_arm) stored`);
  expect(dates.bounded).toBe(true);
 },120000);
});
