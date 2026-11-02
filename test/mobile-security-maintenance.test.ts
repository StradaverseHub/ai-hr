/** Execute the real Python transaction against isolated files, without root or staging access. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('preserves source/target custody, lease refusal, rollback and disabled capabilities',()=>{
 const result=spawnSync('python3',['-I','-B','test/mobile-security-maintenance-fixtures.py','-v'],{encoding:'utf8',timeout:20000});
 expect(result.status,result.stderr).toBe(0);expect(result.stdout).toBe('');expect(result.stderr).toMatch(/Ran 13 tests/);expect(result.stderr).toMatch(/\nOK\n/);process.stdout.write(result.stderr);
});
