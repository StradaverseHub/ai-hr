/** Source/process refusal controls only; not normal lifecycle commissioning. */
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
it('passes all18 closed lifecycle registry/context controls with zero skipped cases',{timeout:35000},()=>{
 const child=spawnSync(process.execPath,['--test','.github/ci/employee-lifecycle-profile.test.mjs','.github/ci/employee-lifecycle-context.test.mjs'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});if(child.status!==0){process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');}expect(child.error).toBeUndefined();expect(child.signal).toBeNull();expect(child.status).toBe(0);expect(child.stdout).toMatch(/# tests 18(?:\r?\n|$)/);expect(child.stdout).toMatch(/# pass 18(?:\r?\n|$)/);expect(child.stdout).toMatch(/# fail 0(?:\r?\n|$)/);expect(child.stdout).toMatch(/# skipped 0(?:\r?\n|$)/);expect(child.stdout).toMatch(/# cancelled 0(?:\r?\n|$)/);
 const registry=JSON.parse(readFileSync('.github/ci/employee-lifecycle-profile.json','utf8'));expect(registry.files.map((row:{cases:number})=>row.cases)).toEqual([6,2,3,9,6]);
});
