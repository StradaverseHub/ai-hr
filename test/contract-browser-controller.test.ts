/** Pure hosted CI protocol checks; no database, server, browser or prerequisite provisioning. */
import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
it('verifies Contract source/bootstrap refusals and the unchanged canonical build admission roster',()=>{
 const output=execFileSync(process.execPath,['--test','.github/ci/contract-browser.test.mjs','.github/ci/contract-browser-push.test.mjs','.github/ci/build-heap.test.mjs'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 expect(output).toContain('# fail 0');
 expect(output).toContain('native preparation cannot fake a case');
});
