import {expect,it} from 'vitest';
import {postgresLockFailures} from '../scripts/performance/lock-failure-log.mjs';
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
 const log=`2026-11-09 14:00:00.000 +08 [98] ai_hr_app@ai_hr_dev LOG:  process 98 still waiting for ShareLock on transaction 1234 after 1000.070 ms
2026-11-09 14:00:00.000 +08 [98] DETAIL:  Process holding the lock: 99. Wait queue: 98.
2026-11-09 14:00:00.250 +08 [98] ai_hr_app@ai_hr_dev LOG:  process 98 acquired ShareLock on transaction 1234 after 1250.070 ms
2026-11-09 14:00:01.000 +08 [99] LOG:  process 99 failed to acquire AccessExclusiveLock on relation 5000 of database 321 after 1000.115 ms
2026-11-09 14:00:01.000 +08 [100] STATEMENT:  process 100 acquired ShareLock on transaction 9999 after 1001.123 ms
2026-11-09 14:00:01.000 +08 [100] LOG:  process 999 acquired ShareLock on transaction 9999 after 1001.123 ms`;
 const failures=postgresLockFailures(log);
 expect(failures).toEqual([
  {kind:'observed heavyweight lock wait',pid:98,outcome:'still waiting for',mode:'ShareLock',waitMs:1000.07,waits:[],routines:[]},
  {kind:'observed heavyweight lock wait',pid:98,outcome:'acquired',mode:'ShareLock',waitMs:1250.07,waits:[],routines:[]},
  {kind:'observed heavyweight lock wait',pid:99,outcome:'failed to acquire',mode:'AccessExclusiveLock',waitMs:1000.115,waits:[],routines:[]},
 ]);
 expect(JSON.stringify(failures)).not.toMatch(/1234|5000|9999|ai_hr/);
});
