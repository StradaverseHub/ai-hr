/** Pure counterexamples only. No Docker/process/database custody is inferred. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('retains eight custody and one aggregate deadline model plus two actual Linux publication controls',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','.github/ci/employee-postgres-policy.test.py','-v'],{encoding:'utf8',timeout:10000,maxBuffer:1048576});
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,(result.stdout??'')+(result.stderr??'')).toBe(0);
 expect(result.stdout).toBe('');expect(result.stderr).toMatch(/Ran 11 tests in [0-9.]+s\n\nOK\n$/);
});
