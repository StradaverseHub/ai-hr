/** Original metadata/source models only; no API, capture or native acceptance. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('retains every original replay metadata/privacy control with no skips',()=>{
 const result=spawnSync(process.execPath,['--test','.github/ci/diagnostics/catalogue-original-replay/policy.test.mjs'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});const output=(result.stdout??'')+(result.stderr??'');expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 for(const[name,n]of [['tests',14],['pass',14],['fail',0],['cancelled',0],['skipped',0],['todo',0]])expect(output).toMatch(new RegExp('# '+name+' '+n+'(?:\\r?\\n)'));process.stdout.write(output);
});
it('proves six actual Linux cancellation and ownership controls without API or catalogue execution',{timeout:60000},async()=>{
 const {verifyAdapterControls}=await import('../.github/ci/diagnostics/catalogue-original-replay/adapter-controls.mjs');expect(await verifyAdapterControls()).toBe(6);
});
