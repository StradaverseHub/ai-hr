import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';

it('preserves generation fencing, publication recovery and complete drain semantics',()=>{
 const output=execFileSync('/usr/bin/python3',['-I','-B','deploy/admission/test_state.py'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 expect(output).toBe('');
},35000);
