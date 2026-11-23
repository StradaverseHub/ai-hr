import {runWorkerFixture} from './helpers/worker-fixture-process';
import {expect,it} from 'vitest';

it('retains the original safe cutover failure and records only an exact stopped owned quarantine',()=>{
 const result=runWorkerFixture(['test/fixtures/bank-import-worker-activation-failure-tests.py']);
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 5 tests');
},120000);
