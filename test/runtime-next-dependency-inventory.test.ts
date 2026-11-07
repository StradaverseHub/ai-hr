/** Disposable filesystem controls, not root copying or native application acceptance. */
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('binds pre-candidate installed dependencies to the exact normalized immutable-copy bytes',()=>{
 const output=execFileSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_dependency_inventory.py'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 expect(output).toBe('');
},35000);
