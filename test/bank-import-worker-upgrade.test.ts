/** Privileged helper controls execute without root operations or live services, only in Actions. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('preserves managed drain, immutable bytes and privileged update refusal boundaries',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-upgrade-tests.py'],{encoding:'utf8',maxBuffer:1024**2});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 24 tests');
});
