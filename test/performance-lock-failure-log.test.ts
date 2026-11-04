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
