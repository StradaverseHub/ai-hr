/** db/prepared-read.ts: a prepared read hands the driver its exact text and parameters with `prepare: true` (unnamed
 * again with AIHR_PREPARED_READS=off), and the shared read snapshot's driver memoizes it as the same read as the
 * unnamed statement, while any other driver option still passes through unmemoized. No database: the driver is a fake. */
import {afterEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {PREPARED_READ_BACKEND_BOUND_BYTES,PREPARED_READ_MEASURED_TEXT_BYTES,PREPARED_READ_OPTIONS,PREPARED_READ_TEXT_LIMITS,__resetPreparedReadAdmissionForTests,
 executePrepared,genericPlanSettingsStatement,preparedReadCounts,preparedReadsEnabled} from '../db/prepared-read';
import {classifySharedStatement,passedSettings,sharedReadDriver,type SharedReadCarrierControl,type SharedReadCarrierState} from '../db/shared-read';

type Sent={query:string;params:unknown[]|undefined;options:unknown};
function fakeDriver(){
 const sent:Sent[]=[];
 const unsafe=(query:string,params?:unknown[],options?:unknown)=>{
  sent.push({query,params,options});
  const rows=Object.assign([{n:sent.length,at:new Date('2026-11-26T00:00:00Z')}],{count:1,command:'SELECT'});
  return Object.assign(Promise.resolve(rows),{values:()=>Promise.resolve([[sent.length]])});
 };
 return {sent,driver:{unsafe}};
}
const fakeSession=()=>({stats:{statements:0,flights:0,memoHits:0,seeded:0},
 refuse:(reason:string)=>new Error('refused '+reason),failed:()=>{}});
/** One open carrier's state (db/shared-read.ts SharedReadCarrierState): its transaction already begun (no `open`). */
const openCarrier=():SharedReadCarrierState=>({plain:false,inFlight:0});

afterEach(()=>{delete process.env.AIHR_PREPARED_READS;__resetPreparedReadAdmissionForTests();});

describe('executePrepared',()=>{
 const statement=sql`select ${'a'}::text as x, ${7}::int as y`;
 it('sends the statement drizzle would send, as a named prepared statement',async()=>{
  const {sent,driver}=fakeDriver();
  const before=preparedReadCounts().get('recruitment-personal-todos')?.prepared??0;
  const rows=await executePrepared<{n:number}>({dialect:new PgDialect(),session:{client:driver}},statement,'recruitment-personal-todos');
  const expected=new PgDialect().sqlToQuery(statement);
  expect(sent).toEqual([{query:expected.sql,params:expected.params,options:PREPARED_READ_OPTIONS}]);
  expect(PREPARED_READ_OPTIONS).toEqual({prepare:true});
  expect(rows[0].n).toBe(1);
  expect(preparedReadCounts().get('recruitment-personal-todos')?.prepared).toBe(before+1);
 });
 it('sends it unnamed, exactly as before, with AIHR_PREPARED_READS=off',async()=>{
  process.env.AIHR_PREPARED_READS='off';
  expect(preparedReadsEnabled()).toBe(false);
  const {sent,driver}=fakeDriver();
  const before=preparedReadCounts().get('request-preamble')??{prepared:0,unnamed:0,overflow:0};
  await executePrepared({dialect:new PgDialect(),session:{client:driver}},statement,'request-preamble');
  expect(sent).toHaveLength(1);
  expect(sent[0].options).toBeUndefined();
  expect(preparedReadCounts().get('request-preamble')).toEqual({...before,unnamed:before.unnamed+1});
  expect(preparedReadsEnabled({AIHR_PREPARED_READS:'on'})).toBe(true);
  expect(preparedReadsEnabled({})).toBe(true);
 });
});

describe('the text limit per prepared read',()=>{
 it('prepares only the first texts of a label in a process, then sends the rest unnamed, as before',async()=>{
  const {sent,driver}=fakeDriver();
  const tx={dialect:new PgDialect(),session:{client:driver}};
  const limit=PREPARED_READ_TEXT_LIMITS['account-tasks'];
  for(let n=0;n<limit+2;n++)await executePrepared(tx,sql`select ${n}::int as n, ${sql.raw(String(n))} as shape`,'account-tasks');
  // An admitted text stays prepared on every later call.
  await executePrepared(tx,sql`select ${9}::int as n, ${sql.raw('0')} as shape`,'account-tasks');
  expect(sent.map(row=>row.options===PREPARED_READ_OPTIONS)).toEqual([...Array(limit).fill(true),false,false,true]);
  expect(sent.slice(limit,limit+2).every(row=>row.options===undefined)).toBe(true);
  // Labels are limited separately.
  await executePrepared(tx,sql`select 1`,'payroll-freshness-files');
  await executePrepared(tx,sql`select 2`,'payroll-freshness-files');
  expect(sent.slice(-2).map(row=>row.options===PREPARED_READ_OPTIONS)).toEqual([true,false]);
  expect(preparedReadCounts().get('payroll-freshness-files')?.overflow).toBeGreaterThan(0);
 });
 it('bounds one backend\'s retained plans at the limits times the measured sizes, with a margin',()=>{
  const labels=Object.keys(PREPARED_READ_TEXT_LIMITS) as (keyof typeof PREPARED_READ_TEXT_LIMITS)[];
  expect(Object.keys(PREPARED_READ_MEASURED_TEXT_BYTES).sort()).toEqual([...labels].sort());
  const raw=labels.reduce((sum,label)=>sum+PREPARED_READ_TEXT_LIMITS[label]*PREPARED_READ_MEASURED_TEXT_BYTES[label],0);
  expect(PREPARED_READ_BACKEND_BOUND_BYTES).toBe(Math.ceil(raw*1.25));
  // About 39 MB measured, 49 MB with the margin: the figure the release evidence multiplies by backends.
  expect(PREPARED_READ_BACKEND_BOUND_BYTES).toBeLessThanOrEqual(50_000_000);
 });
});

describe('the shared read snapshot driver and prepared reads',()=>{
 it('memoizes a prepared read as the same read as its unnamed statement, and copies its rows',async()=>{
  const {sent,driver}=fakeDriver();
  const session=fakeSession();
  const carrier=sharedReadDriver(driver,session as never,openCarrier()) as unknown as {unsafe(q:string,p?:unknown[],o?:unknown):PromiseLike<unknown[]>};
  const first=await carrier.unsafe('select 1 as n where $1::int=1',[1],PREPARED_READ_OPTIONS);
  const again=await carrier.unsafe('select 1 as n where $1::int=1',[1],PREPARED_READ_OPTIONS);
  const unnamed=await carrier.unsafe('select 1 as n where $1::int=1',[1]);
  expect(sent).toEqual([{query:'select 1 as n where $1::int=1',params:[1],options:PREPARED_READ_OPTIONS}]);
  expect(again).toEqual(first);
  expect(unnamed).toEqual(first);
  expect(again).not.toBe(first);
  expect(session.stats.memoHits).toBe(2);
  // Another parameter is another read.
  await carrier.unsafe('select 1 as n where $1::int=1',[2],PREPARED_READ_OPTIONS);
  expect(sent).toHaveLength(2);
 });
 it('still passes any other driver option through, unmemoized',async()=>{
  const {sent,driver}=fakeDriver();
  const carrier=sharedReadDriver(driver,fakeSession() as never,openCarrier()) as unknown as {unsafe(q:string,p?:unknown[],o?:unknown):PromiseLike<unknown[]>};
  await carrier.unsafe('select 2',[],{prepare:true});
  await carrier.unsafe('select 2',[],{prepare:true});
  expect(sent.map(row=>row.options)).toEqual([{prepare:true},{prepare:true}]);
 });
 it('refuses a prepared statement that is not a plain read, as it refuses the unnamed one',async()=>{
  const {sent,driver}=fakeDriver();
  const carrier=sharedReadDriver(driver,fakeSession() as never,openCarrier()) as unknown as {unsafe(q:string,p?:unknown[],o?:unknown):PromiseLike<unknown[]>};
  await expect(carrier.unsafe(`select set_config('x','y',true)`,[],PREPARED_READ_OPTIONS)).rejects.toThrow('refused setting');
  expect(sent).toEqual([]);
 });
});

describe('generic plan settings for a prepared read',()=>{
 it('is one simple-protocol statement in place of set local jit=off, and only jit with AIHR_PREPARED_READS=off',()=>{
  expect(genericPlanSettingsStatement({})).toBe('set local jit=off; set local plan_cache_mode=force_generic_plan');
  expect(genericPlanSettingsStatement({AIHR_PREPARED_READS:'off'})).toBe('set local jit=off');
 });
 it('passes only transaction-local planning settings through a carrier',()=>{
  expect(passedSettings('set local jit=off; set local plan_cache_mode=force_generic_plan')).toEqual([['jit','off'],['plan_cache_mode','force_generic_plan']]);
  expect(passedSettings('set local jit=off')).toEqual([['jit','off']]);
  expect(passedSettings('SET TRANSACTION READ ONLY')).toEqual([['transaction','read only']]);
  for(const refused of ['set plan_cache_mode=force_generic_plan','set local plan_cache_mode=force_custom_plan','set local jit=off; set local role x',
   'set local jit=off; select 1','set local work_mem=\'1GB\'',''])expect(passedSettings(refused),refused).toBeNull();
  expect(classifySharedStatement('set local jit=off; set local plan_cache_mode=force_generic_plan')).toEqual({kind:'pass'});
  expect(classifySharedStatement('set local jit=off; set local role x').kind).toBe('refuse');
 });
 it('sends the settings once per carrier and answers them when the carrier already holds both',async()=>{
  const {sent,driver}=fakeDriver();
  const control:{current?:SharedReadCarrierControl}={};
  const carrier=sharedReadDriver(driver,fakeSession() as never,openCarrier(),control) as unknown as {unsafe(q:string,p?:unknown[],o?:unknown):PromiseLike<unknown[]>};
  const settings=genericPlanSettingsStatement({});
  await carrier.unsafe(settings,[]);
  await carrier.unsafe(settings,[]);
  expect(sent.map(row=>row.query)).toEqual([settings]);
  // A Today carrier's identity statement set both: the owner's statement is not sent at all.
  const held=fakeDriver(),heldControl:{current?:SharedReadCarrierControl}={};
  const today=sharedReadDriver(held.driver,fakeSession() as never,openCarrier(),heldControl) as unknown as {unsafe(q:string,p?:unknown[],o?:unknown):PromiseLike<unknown[]>};
  heldControl.current!.hold('jit','off');heldControl.current!.hold('plan_cache_mode','force_generic_plan');
  await today.unsafe(settings,[]);
  expect(held.sent).toEqual([]);
  // Only jit held: the combined statement is sent.
  const partial=fakeDriver(),partialControl:{current?:SharedReadCarrierControl}={};
  const other=sharedReadDriver(partial.driver,fakeSession() as never,openCarrier(),partialControl) as unknown as {unsafe(q:string,p?:unknown[],o?:unknown):PromiseLike<unknown[]>};
  partialControl.current!.hold('jit','off');
  await other.unsafe(settings,[]);
  expect(partial.sent.map(row=>row.query)).toEqual([settings]);
 });
});
