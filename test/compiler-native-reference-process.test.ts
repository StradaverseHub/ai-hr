/** Source-handle and read-only own-proc controls; no compiler/native-family claim. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('checks all eleven direct-child/source-admission controls without skips',()=>{
 const result=spawnSync(process.execPath,['--test','.github/ci/diagnostics/native-reference/process.test.mjs','.github/ci/diagnostics/native-reference/admission.test.mjs'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(output).toMatch(/# tests 11(?:\r?\n)/);expect(output).toMatch(/# pass 11(?:\r?\n)/);expect(output).toMatch(/# fail 0(?:\r?\n)/);expect(output).toMatch(/# cancelled 0(?:\r?\n)/);expect(output).toMatch(/# skipped 0(?:\r?\n)/);expect(output).toMatch(/# todo 0(?:\r?\n)/);process.stdout.write(output);
},15000);
