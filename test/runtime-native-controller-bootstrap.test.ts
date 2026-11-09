/** Source/disposable-filesystem controls only; actual root bootstrap remains native qualification. */
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('bounds the pre-package controller snapshot and protects owner launch policy in source controls',()=>{
 expect(execFileSync('/usr/bin/python3',['-I','-B','.github/ci/test_native_controller_bootstrap.py'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']})).toBe('');
 const output=execFileSync(process.execPath,['--test','.github/ci/native-controller-owner.test.mjs'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 expect(output).toContain('# fail 0');
},65000);
