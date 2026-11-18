import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';

it('recovers only an explicitly sealed published stopped staging worker and preserves original failure evidence',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-published-tests.py'],{encoding:'utf8',maxBuffer:1024**2});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 6 tests');
},120000);
