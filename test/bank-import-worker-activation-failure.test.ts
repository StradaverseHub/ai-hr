import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {workerFixtureEnv} from './helpers/worker-fixture-tmp';

it('retains the original safe cutover failure and records only an exact stopped owned quarantine',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-activation-failure-tests.py'],{env:workerFixtureEnv('activation-failure'),encoding:'utf8',maxBuffer:1024**2});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 5 tests');
},120000);
