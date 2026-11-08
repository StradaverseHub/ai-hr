/** Ordinary source/counter-wire controls, not native classifier timing. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('checks eight fixed diagnostic source and counter controls without skips',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','.github/ci/diagnostics/db-classifier-timeout.test.py','-v'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);expect(result.stdout).toBe('');expect(output).toMatch(/Ran 8 tests in [0-9.]+s\n\nOK\n$/);process.stdout.write(output);
},20000);
