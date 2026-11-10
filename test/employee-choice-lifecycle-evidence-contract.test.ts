/** Hosted source/byte/API-shape models only. Never a native test or release receipt. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
// 6f35a07d5 split the archived-restoration control out of employee-lifecycle-sources.test.mjs's
// rehash test into its own case, so the six files now hold 29 controls (none removed).
it('retains all29 independent lifecycle evidence and mechanical extraction controls',()=>{
 const child=spawnSync(process.execPath,['--test','.github/ci/employee-lifecycle-api.test.mjs','.github/ci/employee-lifecycle-extract.test.mjs','.github/ci/employee-lifecycle-sources.test.mjs','.github/ci/employee-native-log-codec.test.mjs','.github/ci/employee-lifecycle-witness.test.mjs','.github/ci/employee-lifecycle-operational.test.mjs'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 const output=(child.stdout??'')+(child.stderr??'');expect(child.error).toBeUndefined();expect(child.signal).toBeNull();expect(child.status,output).toBe(0);expect(output).toMatch(/# tests 29\n/);expect(output).toMatch(/# pass 29\n/);expect(output).toMatch(/# fail 0\n/);expect(output).toMatch(/# cancelled 0\n/);expect(output).toMatch(/# skipped 0\n/);expect(output).toMatch(/# todo 0\n/);process.stdout.write(output);
},35000);
