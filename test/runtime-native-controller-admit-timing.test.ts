/** Pure source/control models only; actual exec/journal availability requires native HOST. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('bounds actual controller phase emission, strict native decoding and same-PID handoff refusal models',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','deploy/admission/test_controller_admit_timing.py'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);expect(result.stdout).toBe('');
 expect(output).toMatch(/Ran 46 tests in /);expect(output).toMatch(/\nOK\s*$/);expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);process.stdout.write(output);
},35000);
