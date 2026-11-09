/** Hosted tiny native metadata fixture; no full application compiler claim. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('checks genuine default Program mode context and parent immutability without semantics',()=>{
 const child=spawnSync(process.execPath,['--test','.github/ci/diagnostics/native-reference/application-mode-native.test.mjs'],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
 const output=(child.stdout??'')+(child.stderr??'');expect(child.error).toBeUndefined();expect(child.signal).toBeNull();expect(child.status,output).toBe(0);
 expect(output).toMatch(/# tests 4(?:\r?\n)/);expect(output).toMatch(/# pass 4(?:\r?\n)/);expect(output).toMatch(/# fail 0(?:\r?\n)/);expect(output).toMatch(/# cancelled 0(?:\r?\n)/);expect(output).toMatch(/# skipped 0(?:\r?\n)/);expect(output).toMatch(/# todo 0(?:\r?\n)/);process.stdout.write(output);
},25000);
