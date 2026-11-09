/** Pure source provenance controls; never an actual Next/native acceptance. */
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('derives source paths and blob identities from the exact commit tree instead of caller claims',()=>{
 const output=execFileSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_source.py'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 expect(output).toBe('');
},35000);
