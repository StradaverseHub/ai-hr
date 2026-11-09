/** Synthetic stdlib controls only; actual root handoff/Next startup are separate native gates. */
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('refuses caller-owned build authority and protects native byte/helper identity in source models',()=>{
 const output=execFileSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_build_binding.py'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 expect(output).toBe('');
},35000);
