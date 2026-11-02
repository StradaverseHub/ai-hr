/** Execute the real Python transaction against isolated files, without root or staging access. */
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('preserves source/target custody, lease refusal, rollback and disabled capabilities',()=>{
 const result=execFileSync('python3',['-I','test/mobile-security-maintenance-fixtures.py','-v'],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});expect(result).toBe('');
});
