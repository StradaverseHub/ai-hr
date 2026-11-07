/** Source models only. This cannot stand in for the actual hybrid native singleton. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';

it('executes all closed prepackage diagnostic and redaction models without skips',()=>{
 const result=spawnSync('python3',['-I','-B','deploy/admission/test_next_prepackage_diagnostic.py'],{encoding:'utf8',timeout:10000});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(output).toMatch(/Ran 12 tests in /);expect(output).toMatch(/\nOK\s*$/);
 expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);
 process.stdout.write(output);
});
