import {expect,it} from 'vitest';
import {developmentPostgresLockWindow,postgresLockFailures} from '../scripts/performance/lock-failure-log.mjs';
import {observeSampledAdvisoryBlockers} from '../scripts/performance/lock-sample-attribution.mjs';
import {lockSampleEvidence} from '../scripts/performance/driver-shutdown.mjs';

const fictionalWaiter={app_session:true,pid:22,classid:'11',objid:'12',objsubid:1,mode:'ExclusiveLock',blockers:[84]};
const fictionalBlocker={family:'access-configuration',waiterMode:'ExclusiveLock',blockerMode:'ShareLock',blockerState:'granted',
 waiterCategory:'advisory-exclusive',blockerCategory:'rewards-library'};

it('attributes only app waiters and emits closed blocker facts without native identities',async()=>{
 const inputs:unknown[][]=[];
 const query=async (_text:TemplateStringsArray,...values:unknown[])=>{
  inputs.push(values);
  return [{...fictionalBlocker,pid:84,key:'private-key',query:'private SQL'}];
 };
 const edges=await observeSampledAdvisoryBlockers(query,[fictionalWaiter,{...fictionalWaiter,app_session:false,pid:83}],new Map([['11:12:1','access-configuration:fixture-tenant-0']]));
 expect(inputs).toEqual([[JSON.stringify([{pid:22,key:'11:12:1',mode:'ExclusiveLock',family:'access-configuration',blockers:[84]}]),8]]);
 expect(edges).toEqual([fictionalBlocker]);
});

it('keeps the positive lock gate when attribution refuses, disappears or overruns its bound',async()=>{
 const sample={state:'complete',startedMs:1,completedMs:2,locks:1,blockingAppSessions:1};
 const window={startMs:0,endMs:3};
 const queries=[async()=>{throw Error('private diagnostic failure');},async()=>[],
  async()=>[{...fictionalBlocker,blockerCategory:'private category'}],async()=>Array(9).fill(fictionalBlocker)];
 for(const query of queries){
  expect(await observeSampledAdvisoryBlockers(query,[fictionalWaiter],new Map())).toBeNull();
  expect(lockSampleEvidence([sample],window)).toMatchObject({coveragePass:true,blockingSamples:1,pass:false});
 }
});
it('keeps bounded lock graphs and routine names while excluding SQL, values and unknown errors',()=>{
 const log=`2026-11-04 14:00:00.000 +08 [98] ERROR:  deadlock detected
2026-11-04 14:00:00.000 +08 [98] DETAIL:  Process 98 waits for ExclusiveLock on advisory lock [1, 2, 3, 1]; blocked by process 99.
 Process 99 waits for ShareLock on transaction 1234; blocked by process 98.
 CONTEXT: SQL statement "SELECT 'private-value@example.invalid', 'postgres://hidden-password@host/db'"
 PL/pgSQL function app.access_workforce_write_lock() line 5 at PERFORM
 STATEMENT: update person set full_name='Private fixture value';
2026-11-04 14:00:01.000 +08 [99] ERROR: canceling statement due to lock timeout
 CONTEXT: while locking tuple (1,2) in relation "private-row-value"
 PL/pgSQL function app.native_employee_draft_discard_delete(uuid) line 8 at SQL statement
 STATEMENT: SELECT 'private-token'
2026-11-04 14:00:02.000 +08 [100] ERROR: other error with private payload
`;
 const failures=postgresLockFailures(log);
 expect(failures).toEqual([
  {kind:'deadlock detected',pid:98,waits:[{pid:98,mode:'ExclusiveLock',lock:'advisory lock [1, 2, 3, 1]',blockedBy:99},{pid:99,mode:'ShareLock',lock:'transaction 1234',blockedBy:98}],routines:[{function:'app.access_workforce_write_lock()',line:5,operation:'PERFORM'}]},
  {kind:'canceling statement due to lock timeout',pid:99,waits:[],routines:[{function:'app.native_employee_draft_discard_delete(uuid)',line:8,operation:'SQL statement'}]},
 ]);
 expect(JSON.stringify(failures)).not.toMatch(/private|hidden-password|SELECT|update person/);
 expect(postgresLockFailures(Array.from({length:100},()=>log).join('\n'))).toHaveLength(64);
});

it('recognizes a still-blocked, acquired or failed heavyweight wait without retaining lock objects',()=>{
 const log=`2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev LOG:  process 98 still waiting for ShareLock on transaction 1234 after 1000.070 ms
2026-11-09 14:00:00.000 +08 [98] DETAIL:  Process holding the lock: 99. Wait queue: 98.
2026-11-09 14:00:00.250 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev LOG:  process 98 acquired ShareLock on transaction 1234 after 1250.070 ms
2026-11-09 14:00:01.000 +08 [99] LOG:  process 99 failed to acquire AccessExclusiveLock on relation 5000 of database 321 after 1000.115 ms
2026-11-09 14:00:01.000 +08 [100] STATEMENT:  process 100 acquired ShareLock on transaction 9999 after 1001.123 ms
2026-11-09 14:00:01.000 +08 [100] LOG:  process 999 acquired ShareLock on transaction 9999 after 1001.123 ms
2026-11-09 14:00:01.000 +08 [100] abcdef01.63 ai_hr_app@ai_hr_dev LOG:  process 100 acquired ShareLock on transaction 9999 after 1001.123 ms
2026-11-09 14:00:02.000 +08 [101] abcdef01.65 @ LOG:  process 101 avoided deadlock for ExclusiveLock on transaction 9999 by rearranging queue order after 1002.444 ms`;
 const failures=postgresLockFailures(log);
 expect(failures).toEqual([
  {kind:'observed heavyweight lock wait',pid:98,outcome:'still waiting for',mode:'ShareLock',waitMs:1000.07,waits:[],routines:[]},
  {kind:'observed heavyweight lock wait',pid:98,outcome:'acquired',mode:'ShareLock',waitMs:1250.07,waits:[],routines:[]},
  {kind:'observed heavyweight lock wait',pid:99,outcome:'failed to acquire',mode:'AccessExclusiveLock',waitMs:1000.115,waits:[],routines:[]},
  {kind:'observed heavyweight lock wait',pid:101,outcome:'avoided deadlock for',mode:'ExclusiveLock',waitMs:1002.444,waits:[],routines:[]},
 ]);
 expect(JSON.stringify(failures)).not.toMatch(/1234|5000|9999|ai_hr|abcdef01/);
});

it('qualifies only the exact bracketed PostgreSQL log window and retains blocking evidence',()=>{
 const nonce='0123456789abcdef0123456789abcdef';
 const marker=(phase:string,pid=98,sessionPid='62',actor='postgres@ai_hr_dev')=>
  '2026-11-09 14:00:00.000 +08 ['+pid+'] abcdef01.'+sessionPid+' '+actor+' LOG:  AIHR_LOCK_WINDOW_V1 '+nonce+' '+phase;
 const wait='2026-11-09 14:00:00.100 +08 [101] abcdef01.65 ai_hr_app@ai_hr_dev LOG:  process 101 still waiting for ShareLock on transaction 789 after 100.135 ms';
 const log=(...lines:string[])=>lines.join('\n');
 expect(developmentPostgresLockWindow(log(wait,marker('begin'),marker('end',99,'63'),wait),nonce))
  .toEqual({thresholdMs:100,failures:[]});
 expect(developmentPostgresLockWindow(log(marker('begin'),wait,marker('end',99,'63')),nonce))
  .toEqual({thresholdMs:100,failures:[{kind:'observed heavyweight lock wait',pid:101,outcome:'still waiting for',mode:'ShareLock',waitMs:100.135,waits:[],routines:[]}]});
 for(const rejected of [
  log(marker('begin'),wait),log(marker('end'),marker('begin')),log(marker('begin'),marker('end'),marker('end')),
  log(marker('begin'),marker('end',99,'62')),log(marker('begin'),marker('end',99,'63','ai_hr_app@ai_hr_dev')),
  log(marker('begin'),marker('end')+' unexpected'),log(marker('begin'),marker('end').replace(nonce,'0'.repeat(32))),
 ])expect(developmentPostgresLockWindow(rejected,nonce)).toBeNull();
});

it('projects only closed lock families, ordinal topology and explicit log phase',()=>{
 const log=`2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev ERROR:  deadlock detected
2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev DETAIL:  Process 98 waits for ExclusiveLock on advisory lock [90, 42, 77, 1]; blocked by process 99.
 Process 99 waits for ExclusiveLock on advisory lock [90, 42, 77, 1]; blocked by process 98.
 Process 98: select pg_advisory_xact_lock(hashtextextended('private-source',0));
 Process 99: select * from app.unknown_private_routine('private-value');
 CONTEXT: SQL statement "private-source"
 PL/pgSQL function app.ai_centre_assert_running(integer) line 8 at PERFORM
 PL/pgSQL function app.unknown_private_routine(text) line 9 at PERFORM`;
 const options={runtimeFrom:'2026-11-09T06:00:00.001Z',advisoryKeys:new Map([['90:42:77:1','access-configuration']])};
 const evidence=postgresLockFailures(log,options)[0].diagnostic;
 expect(evidence).toEqual({phase:'before-runtime-start',waitFamily:null,allParsedEdgesRetained:true,victimRoutines:['ai-centre-running'],edges:[
  {waiter:1,blocker:2,resource:1,mode:'ExclusiveLock',family:'access-configuration',waiterCall:'direct-advisory-exclusive',blockerCall:null},
  {waiter:2,blocker:1,resource:1,mode:'ExclusiveLock',family:'access-configuration',waiterCall:null,blockerCall:'direct-advisory-exclusive'},
 ]});
 expect(JSON.stringify(evidence)).not.toMatch(/private|\b(?:98|99|90|42|77)\b/);
 expect(postgresLockFailures(log,{runtimeFrom:'2026-11-09T06:00:00.000Z'})[0].diagnostic).toMatchObject({
  phase:'after-runtime-start',edges:[expect.objectContaining({family:'advisory-unclassified'}),expect.objectContaining({family:'advisory-unclassified'})],
 });
 expect(postgresLockFailures(log,{bracketed:true})[0].diagnostic?.phase).toBe('qualified-runtime');
 expect(postgresLockFailures(log,{runtimeFrom:'invalid'})[0].diagnostic?.phase).toBe('unknown');
 const long=log+'\n'+Array.from({length:16},(_,i)=>` Process ${100+i} waits for ShareLock on transaction ${i}; blocked by process 98.`).join('\n');
 const bounded=postgresLockFailures(long,options)[0].diagnostic;
 expect(bounded?.edges).toHaveLength(8);expect(bounded?.allParsedEdgesRetained).toBe(false);
});

it('identifies heavyweight wait families from the header even without graph edges',()=>{
 const lines=[
  'process 98 still waiting for ExclusiveLock on advisory lock [90,42,77,1] after 100.070 ms',
  'process 98 acquired ExclusiveLock on advisory lock [90,42,77,1] after 402.465 ms',
  'process 98 avoided deadlock for ShareLock on transaction 1234 by rearranging queue order after 100.100 ms',
  'process 98 acquired ShareLock on unexpected private-value after 101.000 ms',
 ];
 const log=lines.map(line=>'2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev LOG:  '+line).join('\n');
 const options={bracketed:true,advisoryKeys:new Map([['90:42:77:1','access-configuration']])};
 const rows=postgresLockFailures(log,options);
 expect(rows.map(row=>row.diagnostic?.waitFamily)).toEqual(['access-configuration','access-configuration','transaction',null]);
 expect(rows.map(row=>row.diagnostic?.edges)).toEqual([[],[],[],[]]);
 expect(JSON.stringify(rows.map(row=>row.diagnostic))).not.toMatch(/private-value|1234|\b(?:90|42|77|98)\b/);
});
