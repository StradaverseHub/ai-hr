/** Actual owned Linux process controls; neither DB timings nor app boot proof. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('proves external Linux deadlines, monitor death, group shutdown-before-reap and command failure without numeric reuse',{timeout:30000},()=>{
 expect(process.platform).toBe('linux');
 const result=spawnSync('python3',['-I','-B','.github/ci/employee-benchmark-supervisor.test.py','-v'],{env:{...process.env,AIHR_BENCHMARK_TEST_NODE:process.execPath},encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(0);expect(result.stdout).toBe('');expect(result.stderr).toMatch(/Ran 10 tests in [0-9.]+s\n\nOK\n$/);
});
