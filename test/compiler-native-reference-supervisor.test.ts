/** Native tiny Linux ownership controls, not compiler/application qualification. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('checks nine closed-adapter and actual-parent ownership controls',()=>{
 expect(process.platform).toBe('linux');
 const result=spawnSync('/usr/bin/python3',['-I','-B','.github/ci/compiler-reference-supervisor.test.py','-v'],{env:{...process.env,AIHR_BENCHMARK_TEST_NODE:process.execPath},encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);expect(result.stdout).toBe('');expect(output).toMatch(/Ran 9 tests in [0-9.]+s\n\nOK\n$/);process.stdout.write(output);
},25000);
