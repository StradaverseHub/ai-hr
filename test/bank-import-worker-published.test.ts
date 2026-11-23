import {runWorkerFixture} from './helpers/worker-fixture-process';
import {expect,it} from 'vitest';

it('recovers only an explicitly sealed published stopped staging worker and preserves original failure evidence',()=>{
 const result=runWorkerFixture(['test/fixtures/bank-import-worker-published-tests.py']);
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 11 tests');
},120000);
