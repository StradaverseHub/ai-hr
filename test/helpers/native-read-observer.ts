/** Test-only native Tx observer. Never a product pool, authority or read owner.
 * Raw query objects support exact in-memory correctness assertions; new receipts
 * contain only statement digests, classifications, counts and awaited timings. */
import {createHash} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {vi} from 'vitest';
import * as database from '../../db/client';
import type {SessionContext,Tx} from '../../db/client';

export type NativeReadQuery={sql:string;params:unknown[];rows?:number};
type Properties={role:string;isolation:string;readOnly:boolean;pid:number};
type DigestSummary={digest:string;classification:string;count:number;elapsedMs:number;maxElapsedMs:number;
 returnedRows:number;unknownRowCounts:number;failed:number;firstOrdinal:number;lastOrdinal:number};
type Sample={ordinal:number;digest:string;classification:string;elapsedMs:number;returnedRows:number|null;succeeded:boolean};
const MAX_DIGESTS=128,MAX_SAMPLES=256;

export function observeNativeRead(options:{
 after?:(query:NativeReadQuery)=>Promise<void>;
 fail?:{matches:(query:NativeReadQuery)=>boolean;error:Error};
 captureQueries?:boolean;
 classify?:(sql:string)=>string;
}={}){
 const actual=database.withTenant,dialect=new PgDialect(),queries:NativeReadQuery[]=[],properties:Properties[]=[];
 const state={active:0,maxActive:0};
 const summaries=new Map<string,DigestSummary>(),samples:Sample[]=[];
 const totals={statements:0,elapsedMs:0,returnedRows:0,unknownRowCounts:0,failed:0,unclassified:0,
  digestOverflowStatements:0,sampleOverflowStatements:0};
 const record=(query:NativeReadQuery,elapsedMs:number,succeeded:boolean)=>{
  const digest=createHash('sha256').update(query.sql).digest('hex');
  const classification=options.classify?.(query.sql)??'unclassified',ordinal=++totals.statements;
  totals.elapsedMs+=elapsedMs;totals.returnedRows+=query.rows??0;totals.unknownRowCounts+=Number(query.rows===undefined);
  totals.failed+=Number(!succeeded);totals.unclassified+=Number(classification==='unclassified');
  const key=digest+'|'+classification;let summary=summaries.get(key);
  if(!summary&&summaries.size<MAX_DIGESTS){
   summary={digest,classification,count:0,elapsedMs:0,maxElapsedMs:0,returnedRows:0,unknownRowCounts:0,failed:0,firstOrdinal:ordinal,lastOrdinal:ordinal};
   summaries.set(key,summary);
  }
  if(summary){
   summary.count++;summary.elapsedMs+=elapsedMs;summary.maxElapsedMs=Math.max(summary.maxElapsedMs,elapsedMs);
   summary.returnedRows+=query.rows??0;summary.unknownRowCounts+=Number(query.rows===undefined);summary.failed+=Number(!succeeded);summary.lastOrdinal=ordinal;
  }else totals.digestOverflowStatements++;
  if(samples.length<MAX_SAMPLES)samples.push({ordinal,digest,classification,elapsedMs,returnedRows:query.rows??null,succeeded});
  else totals.sampleOverflowStatements++;
 };
 const run=async<T>(query:NativeReadQuery,work:()=>PromiseLike<T>):Promise<T>=>{
  if(options.captureQueries!==false)queries.push(query);state.active++;state.maxActive=Math.max(state.maxActive,state.active);
  try{
   let result:T;const started=performance.now();let succeeded=false;
   try{
    if(options.fail?.matches(query))throw options.fail.error;
    result=await work();if(Array.isArray(result))query.rows=result.length;succeeded=true;
   }finally{record(query,performance.now()-started,succeeded);}
   await options.after?.(query);return result;
  }finally{state.active--;}
 };
 const wrap=(query:object):object=>new Proxy(query,{get(target,key,receiver){
  const value=Reflect.get(target,key,receiver);
  if(key==='then')return (resolve:(rows:unknown)=>unknown,reject:(error:unknown)=>unknown)=>{
   const prepared=(target as {toSQL:()=>NativeReadQuery}).toSQL();
   return run(prepared,()=>Promise.resolve(Reflect.apply(value,target,[(rows:unknown)=>rows]))).then(resolve,reject);
  };
  return typeof value==='function'? (...args:unknown[])=>{
   const result=Reflect.apply(value,target,args);return result&&typeof result==='object'&&'then' in result?wrap(result):result;
  }:value;
 }});
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,opts?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
  const [facts]=await tx.execute<Properties>(sql`select current_user as role,current_setting('transaction_isolation') as isolation,
    current_setting('transaction_read_only')='on' as "readOnly",pg_backend_pid() as pid`);
  properties.push(facts);
  return read(new Proxy(tx,{get(target,key,receiver){
   if(key==='select'||key==='selectDistinct')return (...args:unknown[])=>wrap(Reflect.apply(target[key],target,args));
   if(key==='execute')return (query:SQL)=>run(dialect.sqlToQuery(query),()=>target.execute(query));
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }}));
 },opts));
 return {queries,properties,state,restore:()=>spy.mockRestore(),telemetry:()=>({
  kind:'TEST_NATIVE_READ_DIGEST_TELEMETRY' as const,includesSqlOrParametersOrResultContent:false,
  limits:{distinctDigests:MAX_DIGESTS,ordinalSamples:MAX_SAMPLES},totals:{...totals},
  summaries:[...summaries.values()].map(summary=>({...summary})),samples:samples.map(sample=>({...sample})),
  detailComplete:totals.digestOverflowStatements===0&&totals.sampleOverflowStatements===0,
 })};
}
