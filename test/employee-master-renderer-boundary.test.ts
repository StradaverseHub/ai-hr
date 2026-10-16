/** Compile the real isolated entry: no external stubs or application execution. */
import {build} from 'esbuild';
import {describe,expect,it} from 'vitest';

describe('isolated report renderer import boundary',()=>{
 it('bundles canonical report/permission readers without request sessions or web authentication',async()=>{
  const result=await build({bundle:true,platform:'node',target:'node22',format:'cjs',write:false,logLevel:'silent',metafile:true,entryPoints:['deploy/identity-email/report-renderer.ts']});
  expect(result.outputFiles?.[0]?.contents.byteLength).toBeGreaterThan(1000);
  const inputs=Object.keys(result.metafile!.inputs);
  expect(inputs).toContain('lib/authz-model.ts');
  expect(inputs).toContain('core/employee-master-reports.ts');
  expect(inputs).toContain('core/notification-email.ts');
  for(const forbidden of ['lib/authz.ts','lib/session.ts','lib/workos.ts'])expect(inputs).not.toContain(forbidden);
  expect(inputs.filter(file=>file.startsWith('node_modules/')&&/\/(?:next|@workos-inc)\//.test(file))).toEqual([]);
 });
});
