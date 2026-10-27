/** Pure composition contract for the out-of-band AI custody maintenance tick. A scripted fake carrier
 * answers each statement: no database, migration, provider, clock or credential is used. This proves
 * the TypeScript ordering, bounds, counters and DERIVED owner inventory only. SQL/RLS/role/rollback
 * behaviour is proven solely by the authored DB cases (the AI drafts are journaled as 0650/0655/0656).
 */
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {AI_RETENTION_MAINTAINED_RELATIONS,expiredAiCustodyQueueSql,retireExpiredAiCustodyTx} from '../core/ai-retention-maintenance';
import {ASSISTANT_TRANSCRIPT_RETENTION_DAYS,expiredAssistantHistoryQueueSql,retireExpiredAssistantHistoryTx} from '../core/assistant-history-expiry';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';

const dialect=new PgDialect();
const MAINTENANCE_REFUSAL='AI retention maintenance could not be confirmed.';
const TRANSCRIPT_REFUSAL='Assistant history retirement unavailable.';
// The ownership guard also NAMES this function (regprocedure); only an actual call statement starts so.
const TRANSCRIPT_CALL='select app.assistant_transcripts_retire_expired(';
const isTranscriptCall=(step:{text:string})=>step.text.startsWith(TRANSCRIPT_CALL);
const A='0a0a0a0a-0000-4000-8000-00000000000a',B='0b0b0b0b-0000-4000-8000-00000000000b';
type Step={text:string;params:unknown[]};
type Script={allowed?:boolean;tenants?:string[];busy?:string[];transcripts?:Record<string,unknown>;intents?:number;queue?:{remaining:boolean;oldest_age_seconds:number|null}};
function carrier(script:Script){
 const log:Step[]=[];
 const execute=async(statement:SQL):Promise<unknown[]>=>{
  const query=dialect.sqlToQuery(statement),text=query.sql;log.push({text,params:query.params});
  if(text.includes('pg_catalog.pg_settings'))return [{name:'lock_timeout',value:'500'},{name:'statement_timeout',value:'5000'}];
  if(text.includes('pg_catalog.pg_roles')&&text.includes('current_user=session_user'))return [{allowed:script.allowed??true}];
  if(text.includes('group by tenant_id'))return (script.tenants??[]).map(tenant_id=>({tenant_id}));
  if(text.includes('pg_try_advisory_xact_lock')){const key=String(query.params[0]);return [{owned:!(script.busy??[]).some(id=>key==='access-configuration:'+id)}];}
  if(text.startsWith(TRANSCRIPT_CALL)){const reported=script.transcripts??{},key=String(query.params[0]);return [{retired:key in reported?reported[key]:0}];}
  if(text.includes('update app.assistant_own_leave_review r set state'))return [{retired:0,erased:0}];
  if(text.includes('delete from public.ai_assistant_answer_evaluation_intent'))return [{removed:script.intents??0}];
  if(text.includes('delete from '))return [{removed:0}];
  if(text.includes('exists(select 1 from oldest)'))return [script.queue??{remaining:false,oldest_age_seconds:null}];
  throw Error('Unscripted maintenance statement');
 };
 return {tx:{execute} as unknown as Tx,log};
}
const index=(log:Step[],predicate:(step:Step)=>boolean)=>log.findIndex(predicate);
const mutated=(text:string)=>[...text.matchAll(/\b(?:delete\s+from|update)\s+((?:public|app)\.[a-z_]+)/gi)].map(match=>match[1].toLowerCase());
const deleted=(text:string)=>[...text.matchAll(/\bdelete\s+from\s+((?:public|app)\.[a-z_]+)/gi)].map(match=>match[1].toLowerCase());
const read=(path:string)=>readFileSync(fileURLToPath(new URL(path,import.meta.url)),'utf8');
// Every SQL source: journaled migrations plus any still-unjournaled drafts. The AI drafts this proof
// was written against are journaled now (0650 native outcomes, 0655 conversation, 0656 transcript), so
// the drafts folder may be absent; its absence must not hide the journaled SQL.
const sqlDirectories=['../db/migrations/','../db/migration-drafts/'].filter(dir=>existsSync(fileURLToPath(new URL(dir,import.meta.url))));
const sqlSources=sqlDirectories.flatMap(dir=>readdirSync(fileURLToPath(new URL(dir,import.meta.url))).filter(name=>name.endsWith('.sql')).map(name=>read(dir+name)));
const qualify=(name:string)=>{const bare=name.replaceAll('"','').toLowerCase();return bare.includes('.')?bare:'public.'+bare;};
/** Every table whose FK declares ON DELETE CASCADE to one of the given parents, from actual SQL sources. */
function cascadeChildren(parents:ReadonlySet<string>):Set<string>{
 const children=new Set<string>();
 for(const text of sqlSources)for(const match of text.matchAll(/REFERENCES\s+("?[\w.]+"?)\s*\([^)]*\)\s*ON DELETE CASCADE/gi)){
  if(!parents.has(qualify(match[1])))continue;
  const owners=[...text.slice(0,match.index).matchAll(/(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: ONLY)?)\s+("?[\w.]+"?)/gi)];
  expect(owners.length).toBeGreaterThan(0);
  children.add(qualify(owners[owners.length-1][1]));
 }
 return children;
}
/** Statements inside the owner-only transcript helper body, from journaled 0656 (slice proven non-empty). */
function transcriptHelperBody(){
 const draft=read('../db/migrations/0656_assistant_transcript_retention.sql');
 const start=draft.indexOf('CREATE FUNCTION app._assistant_transcripts_retire('),end=draft.indexOf('END $$;',start);
 expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);
 const body=draft.slice(start,end);expect(body.length).toBeGreaterThan(400);return body;
}

describe('AI custody maintenance composition (pure, fake carrier)',()=>{
 it('derives the maintained-relation owner proof from every relation the tick and its transcript helper mutate',async()=>{
  const {tx,log}=carrier({tenants:[A]});await retireExpiredAiCustodyTx(tx);
  const helper=transcriptHelperBody(),helperStatements=[...helper.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+((?:public|app)\.[a-z_]+)/gi)].map(match=>match[1].toLowerCase());
  expect(new Set(helperStatements)).toEqual(new Set(['app.assistant_transcript_retirement_scope','public.assistant_exchange','public.ai_agent_feedback','public.ai_assistant_answer_strategy_use','app.assistant_transcript_identity']));
  const direct=new Set([...log.flatMap(step=>mutated(step.text)),...helperStatements]);
  const deletes=new Set([...log.flatMap(step=>deleted(step.text)),...[...helper.matchAll(/\bDELETE FROM\s+((?:public|app)\.[a-z_]+)/gi)].map(match=>match[1].toLowerCase())]);
  // Non-vacuity: the cascade sources must include the journaled tables that declare these cascades.
  expect(sqlDirectories).toContain('../db/migrations/');
  for(const table of ['CREATE TABLE app.assistant_transcript_identity','CREATE TABLE public.ai_assistant_answer_strategy_use','CREATE TABLE app.native_outcome_source_target'])expect(sqlSources.some(text=>text.includes(table)),table).toBe(true);
  // Close over declared FK cascades: deleting a parent physically deletes these children too.
  const closure=new Set(direct);for(let frontier=deletes;frontier.size;){const next=new Set([...cascadeChildren(frontier)].filter(name=>!closure.has(name)));next.forEach(name=>closure.add(name));frontier=next;}
  expect(log.flatMap(step=>mutated(step.text)).length).toBeGreaterThanOrEqual(12);
  expect(new Set(AI_RETENTION_MAINTAINED_RELATIONS).size).toBe(AI_RETENTION_MAINTAINED_RELATIONS.length);
  expect(new Set(AI_RETENTION_MAINTAINED_RELATIONS)).toEqual(closure);
  const guard=log.find(step=>step.text.includes('pg_catalog.pg_roles'));expect(guard).toBeDefined();
  expect(guard!.params).toEqual([AI_RETENTION_MAINTAINED_RELATIONS.length,...AI_RETENTION_MAINTAINED_RELATIONS]);
  expect(guard!.text).toContain("'app.assistant_transcripts_retire_expired(uuid,integer,integer)'::regprocedure");
  expect(guard!.text).toContain('p.proowner=r.oid');
 });
 it('retires raw transcripts first inside the owned Access interval, before every metadata expiry, with the fixed policy and bound',async()=>{
  const {tx,log}=carrier({tenants:[A],transcripts:{[A]:7}});const result=await retireExpiredAiCustodyTx(tx);expect(result.transcripts).toBe(7);
  const lock=index(log,step=>step.text.includes('pg_try_advisory_xact_lock')),transcript=index(log,isTranscriptCall);
  const firstMutation=index(log,step=>mutated(step.text).length>0);
  expect(lock).toBeGreaterThan(0);expect(transcript).toBeGreaterThan(lock);expect(firstMutation).toBeGreaterThan(transcript);
  expect(log[transcript].params).toEqual([A,ASSISTANT_TRANSCRIPT_RETENTION_DAYS,100]);expect(ASSISTANT_TRANSCRIPT_RETENTION_DAYS).toBe(30);
  expect(log.filter(isTranscriptCall)).toHaveLength(1);
 });
 it('counts transcripts and evaluation intents only for owned tenants and skips busy Access without any transcript call',async()=>{
  const {tx,log}=carrier({tenants:[A,B],busy:[B],transcripts:{[A]:3,[B]:99},intents:2});const result=await retireExpiredAiCustodyTx(tx);
  expect(result).toEqual({tenants:2,busy:1,reviews:0,feedback:0,transcripts:3,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:2});
  expect(log.filter(isTranscriptCall).map(step=>step.params[0])).toEqual([A]);
  for(const id of [A,B])expect(JSON.stringify(result)).not.toContain(id);
 });
 it.each([101,-1,1.5,'1',null,undefined])('refuses the whole tick when transcript retirement reports %s',async retired=>{
  const {tx}=carrier({tenants:[A],transcripts:{[A]:retired}});await expect(retireExpiredAiCustodyTx(tx)).rejects.toThrow(MAINTENANCE_REFUSAL);
 });
 it('refuses before tenant selection when the ownership proof fails',async()=>{
  const {tx,log}=carrier({allowed:false,tenants:[A]});await expect(retireExpiredAiCustodyTx(tx)).rejects.toThrow(MAINTENANCE_REFUSAL);
  expect(log.map(step=>step.text.includes('pg_catalog.pg_settings')?'bounds':step.text.includes('pg_catalog.pg_roles')?'guard':'other')).toEqual(['bounds','guard']);
 });
 const helperRefusals:[string,number|undefined,number][]=[[A,29,100],[A,31,100],[A,undefined,100],[A,30,0],[A,30,101],[A,30,1.5],['not-a-tenant',30,100]];
 it.each(helperRefusals)('the owner helper refuses tenant %s, %s days, limit %s without issuing SQL',async(tenant,days,limit)=>{
  const {tx,log}=carrier({});await expect(retireExpiredAssistantHistoryTx(tx,tenant,days as number,limit)).rejects.toThrow(TRANSCRIPT_REFUSAL);expect(log).toEqual([]);
 });
 it('queues transcripts by tenant and deadline metadata only, on the same now() clock as every other member',()=>{
  const own=dialect.sqlToQuery(expiredAssistantHistoryQueueSql());
  expect(own.sql).toBe("select tenant_id,asked_at+interval '30 days' as expires_at from public.assistant_exchange where content_retired_at is null and asked_at<=now()-interval '30 days'");
  expect(own.params).toEqual([]);
  const projection=own.sql.slice(own.sql.indexOf('select')+6,own.sql.indexOf(' from '));expect(projection.length).toBeGreaterThan(10);
  for(const column of ['question','answer','tool_calls','disclosure_receipt','error'])expect(projection).not.toContain(column);
  const queue=dialect.sqlToQuery(expiredAiCustodyQueueSql()).sql;
  expect(queue.split(own.sql)).toHaveLength(2);expect(queue).toContain('from public.ai_assistant_answer_evaluation_intent where expires_at<=now()');expect(queue).not.toContain('clock_timestamp');
 });
 it('the operator runner exposes the transcript counter beside its aggregate backlog signal',async()=>{
  const ok=carrier({tenants:[A],transcripts:{[A]:4},queue:{remaining:true,oldest_age_seconds:12.5}});
  const owner={db:{transaction:async(fn:(tx:Tx)=>Promise<unknown>,options?:{isolationLevel?:string})=>{expect(options?.isolationLevel).toBe('read committed');return fn(ok.tx);}}};
  const result=await runAiRetentionTick(owner as unknown as Parameters<typeof runAiRetentionTick>[0]);
  expect(result).toMatchObject({tenants:1,busy:0,transcripts:4,conversationIntents:0,backlog:true,oldestExpiredAgeSeconds:12.5});
  const skewed=carrier({tenants:[],queue:{remaining:true,oldest_age_seconds:-0.5}});
  await expect(runAiRetentionTick({db:{transaction:async(fn:(tx:Tx)=>Promise<unknown>)=>fn(skewed.tx)}} as unknown as Parameters<typeof runAiRetentionTick>[0])).rejects.toThrow(MAINTENANCE_REFUSAL);
 });
});
