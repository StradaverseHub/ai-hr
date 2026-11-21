import assert from 'node:assert/strict';
import {test} from 'node:test';
import {summarizeAccessLockLog} from '../../scripts/performance/access-lock-server-log.mjs';

const ts='2026-11-21T03:00:00.123456789Z';
const at=Date.parse(ts);
const pg=(pid,kind,text)=>ts+' 2026-11-21 11:00:00.123 +08 ['+pid+'] '+kind+':  '+text;

test('keeps allowlisted attribution for the exact fixture keys and sample window',()=>{
 const log=[
  pg(321,'LOG','process 321 still waiting for ExclusiveLock on advisory lock [16384,2,3,1] after 1000.45 ms'),
  pg(321,'DETAIL','Process holding the lock: 999. Wait queue: 321.'),
  pg(321,'CONTEXT','SQL statement "SELECT a_private_value"'),
  ts+' \tPL/pgSQL function app.assistant_generic_review_read(uuid,text) line 8 at PERFORM',
  pg(321,'STATEMENT','select some_private_text'),
  pg(321,'LOG','process 321 acquired ExclusiveLock on advisory lock [16384,2,3,1] after 1120.1 ms'),
  pg(321,'STATEMENT',"select pg_advisory_xact_lock(hashtextextended('private',0))"),
  pg(321,'LOG','process 321 still waiting for ShareLock on advisory lock [16384,2,4,1] after 1000.1 ms'),
  pg(600,'LOG','process 600 still waiting for ShareLock on advisory lock [16384,2,3,1] after 1000.1 ms').replace(ts,'2026-11-21T03:00:12Z'),
 ].join('\n');
 assert.deepEqual(summarizeAccessLockLog([log],['16384,2,3,1'],at-1,at+1),{
  matched:2,groups:[
   {mode:'ExclusiveLock',event:'still-waiting',source:'assistant_generic_review_read',count:1,maxWaitMs:1000},
   {mode:'ExclusiveLock',event:'acquired',source:'direct-advisory-call',count:1,maxWaitMs:1120},
  ],
 });
});

test('reports an unknown nested owner without retaining its name or transferring it across processes',()=>{
 const log=[
  pg(320,'LOG','process 320 still waiting for ShareLock on advisory lock [16384,2,3,1] after 1000.1 ms'),
  pg(320,'CONTEXT','PL/pgSQL function app.some_private_function(text) line 1 at PERFORM'),
  pg(321,'LOG','process 321 still waiting for ShareLock on advisory lock [16384,2,3,1] after 1000.2 ms'),
  pg(322,'CONTEXT','PL/pgSQL function app.reward_review_plan_save(text) line 1 at PERFORM'),
 ].join('\n');
 assert.deepEqual(summarizeAccessLockLog([log],['16384,2,3,1'],at,at),{matched:2,groups:[
  {mode:'ShareLock',event:'still-waiting',source:'other-database-routine',count:1,maxWaitMs:1000},
  {mode:'ShareLock',event:'still-waiting',source:'unresolved',count:1,maxWaitMs:1000},
 ]});
});
