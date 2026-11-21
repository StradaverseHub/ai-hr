import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';

it('keeps the legacy install grant and refuses uncertain managed-profile boundaries',()=>{
 const output=execFileSync(process.execPath,['--test','.github/ci/staging-environment.test.mjs','.github/ci/staging-build-install.test.mjs'],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024});
 expect(output).toContain('# fail 0');
},35000);
