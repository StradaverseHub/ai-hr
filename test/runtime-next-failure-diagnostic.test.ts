/** Source/read-only child controls only; not a privileged/native Next witness. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('checks all bounded sealed-source failure and privacy models without skips',()=>{
 const result=spawnSync('python3',['-I','-B','deploy/admission/test_next_failure_diagnostic.py'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(output).toMatch(/Ran 22 tests in /);expect(output).toMatch(/\nOK\s*$/);
 expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);
 process.stdout.write(output);
});
