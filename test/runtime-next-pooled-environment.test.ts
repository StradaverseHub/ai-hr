/** Source-only model of the optional pooled route in the closed managed Next environment. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('admits the pooled URL and pooler ceiling only as a complete loopback route to the owned database',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_pooled_environment.py'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(result.stdout).toBe('');expect(output).toMatch(/Ran 6 tests in /);expect(output).toMatch(/\nOK\s*$/);
 expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);process.stdout.write(output);
},35000);
