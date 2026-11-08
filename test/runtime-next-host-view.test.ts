/** Nine source-only policy/settlement models; not a kernel/app receipt. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('retains host cache guards and mandatory stop settlement in source models',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_host_view.py'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(result.stdout).toBe('');expect(output).toMatch(/Ran 9 tests in /);expect(output).toMatch(/\nOK\s*$/);
 expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);process.stdout.write(output);
},35000);
