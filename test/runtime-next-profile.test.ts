/** Source-only controls; this selector never qualifies an actual Next/native host. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('rejects unbound managed packages, mounts, private environments and resource claims in source models',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_profile.py'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(result.stdout).toBe('');expect(output).toMatch(/Ran 16 tests in /);expect(output).toMatch(/\nOK\s*$/);
 expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);process.stdout.write(output);
},35000);
