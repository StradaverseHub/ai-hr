/** Read-only, disposable DB wait observer. Never installed; not a latency acceptance run. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import postgres from 'postgres';

export async function observeLanguageWaits(env,out){
 assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
 const target=new URL(env.MIGRATION_DATABASE_URL);
 assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'5433');
 assert.equal(target.pathname,'/ai_hr_dev');assert.equal(target.username,'postgres');
 const db=postgres(target.href,{max:1,prepare:false,idle_timeout:2,connect_timeout:5,
  connection:{application_name:'aihr-language-readonly-wait-observer',default_transaction_read_only:'on',statement_timeout:'2000'}});
 const report={kind:'READ_ONLY_WAIT_DIAGNOSTIC_NOT_SPEED_ACCEPTANCE',releaseEligible:false,
  source:env.AIHR_CI_HEAD,run:env.GITHUB_RUN_ID,intervalMs:1000,maxSamples:620,
  observerConnections:1,applicationPoolUnchanged:10,rawSqlAndValuesExcluded:true,samples:[],errors:[],closed:false};
 const save=()=>writeFileSync(join(out,'language-database-waits.json'),JSON.stringify(report,null,2));
 let stopped=false,inFlight;
 async function sample(){
  if(stopped||report.samples.length>=report.maxSamples)return;
  try{
   const sessions=await db`select pid,usename,state,wait_event_type,wait_event,
    extract(epoch from(clock_timestamp()-xact_start)) as transaction_age_seconds,
    extract(epoch from(clock_timestamp()-query_start)) as query_age_seconds,
    pg_blocking_pids(pid) as blocking_pids,query
    from pg_stat_activity where datname=current_database() and usename='ai_hr_app'
    and backend_type='client backend' order by pid limit 20`;
   const locks=await db`select l.pid,l.locktype,l.mode,l.granted,l.classid::text,l.objid::text,l.objsubid
    from pg_locks l join pg_stat_activity a on a.pid=l.pid
    where a.datname=current_database() and a.usename='ai_hr_app' and l.locktype='advisory'
    order by l.pid,l.granted,l.classid,l.objid limit 100`;
   report.samples.push({at:new Date().toISOString(),sessions:sessions.map(({query,...row})=>({...row,
    command:query.match(/^\s*([a-z]+)/i)?.[1]?.toUpperCase()??null,
    queryHash:createHash('sha256').update(query).digest('hex'),
    nativeFunctions:[...new Set([...query.matchAll(/\b(app|public)\."?([a-z_][a-z0-9_]*)"?\s*\(/gi)].map(m=>m[1]+'.'+m[2]))].slice(0,20)})),locks});
  }catch(error){report.errors.push({at:new Date().toISOString(),name:error.name,code:/^[0-9A-Z]{5}$/.test(error.code??'')?error.code:null});}
  save();
 }
 await sample();
 const timer=setInterval(()=>{if(!inFlight)inFlight=sample().finally(()=>{inFlight=undefined;});},report.intervalMs);
 return async()=>{stopped=true;clearInterval(timer);if(inFlight)await inFlight;await db.end({timeout:2});report.closed=true;save();};
}
