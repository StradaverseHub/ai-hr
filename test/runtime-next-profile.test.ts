/** Source-only controls; this selector never qualifies an actual Next/native host. */
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('rejects unbound managed packages, mounts, private environments and resource claims in source models',()=>{
 const output=execFileSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_profile.py'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 expect(output).toBe('');
},35000);
