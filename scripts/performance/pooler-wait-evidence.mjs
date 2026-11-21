import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';

export async function readWebPoolerWork(target, database){
 const postgres=createRequire(join(process.cwd(),'package.json'))('postgres');
 const consoleUrl=new URL(target.appUrl);
 consoleUrl.pathname='/pgbouncer';
 const connection=postgres(consoleUrl.href,{max:1,prepare:false,fetch_types:false,connect_timeout:5});
 try{
  const stats=await connection.unsafe('SHOW STATS').simple();
  const rows=stats.filter(row=>row.database===database);
  assert(rows.length<=1,'Expected at most one fictional app database statistics row');
  // A freshly started wildcard database can be absent until the first connection.
  const counter=key=>{
   if(!rows.length)return 0;
   const value=rows[0][key];
   if(!/^\d+$/.test(String(value)))return null;
   const number=Number(value);
   return Number.isSafeInteger(number)?number:null;
  };
  const transactions=counter('total_xact_count'),queries=counter('total_query_count');
  assert(transactions!==null&&queries!==null&&queries>=transactions);
  return {
   capturedAt:Date.now(),
   transactions,queries,
   assignments:counter('total_server_assignment_count'),
   assignmentWaitUs:counter('total_wait_time'),
   transactionUs:counter('total_xact_time'),
   queryUs:counter('total_query_time'),
  };
 }finally{await connection.end({timeout:5});}
}

export function summarizePoolerWindow(before,after){
 const scope='Synthetic web pool from just before the mixed driver through settlement, including preflight. PgBouncer counts wait upon backend assignment.';
 if(!before||!after||after.capturedAt<before.capturedAt)return {available:false,scope};
 const keys=['transactions','queries','assignments','assignmentWaitUs','transactionUs','queryUs'];
 const changes=Object.fromEntries(keys.map(key=>[key,
  before[key]!==null&&after[key]!==null&&after[key]>=before[key]?after[key]-before[key]:null,
 ]));
 if(Object.values(changes).some(value=>value===null))return {available:false,scope};
 return {
  available:true,scope,elapsedMs:after.capturedAt-before.capturedAt,...changes,
  meanAssignedWaitUs:changes.assignments>0?Math.round(changes.assignmentWaitUs/changes.assignments):null,
 };
}
