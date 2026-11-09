/** Actual hosted filesystem models only; no API/native result or release witness. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('preserves all12 finite unit artifact/report inventory controls with zero skipped or cancelled cases',()=>{
 const result=spawnSync(process.execPath,['--test','.github/ci/unit-report-directories.test.mjs'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 for(const line of ['# tests 12\n','# pass 12\n','# fail 0\n','# cancelled 0\n','# skipped 0\n','# todo 0\n'])expect(output).toContain(line);process.stdout.write(output);
},35000);
