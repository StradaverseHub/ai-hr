/** Source models only; the real owned scope still requires the native singleton. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('preserves zero-swap manager persistence and refuses foreign ownership and resource drift in all six models',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_postgres_scope.py'],{encoding:'utf8',timeout:10000});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(result.stdout).toBe('');expect(output).toMatch(/Ran 6 tests in /);expect(output).toMatch(/\nOK\s*$/);
 expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);process.stdout.write(output);
});
