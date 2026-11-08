/** Actual host-only conformance; this is neither a Next build nor app journey. */
import {createHash} from 'node:crypto';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
it('proves privileged cache overlays and bounded owned stop with actual systemd255',()=>{
 expect(process.platform).toBe('linux');expect(process.env.GITHUB_ACTIONS).toBe('true');
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 const admission=admitSingletonTest('test/runtime-next-host-view-native.test.ts');
 const evidence=join(admission.evidenceDirectory,'runtime-next-host-view-native.json');
 const keys=['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY']as const;
 execFileSync('sudo',['-n','env',...keys.map(key=>`${key}=${process.env[key]??''}`),'/usr/bin/python3','-I','-B','deploy/admission/test_next_host_view_native.py',evidence],
  {encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe'],maxBuffer:65536});
 const report=JSON.parse(readFileSync(evidence,'utf8'));
 expect(report).toMatchObject({complete:true,nextApplicationVerified:false,releaseEligible:false,
  ownedRuntimeCleaned:true,resistantFamilyStopped:true,foreignInvocationRetained:true,
  actualExtraMountRefused:true,unmountedAppOwnedPlaceholderRefused:true});
 expect(report.privilegedHookView).toMatchObject({overlaid:true,rootUid:0,hostPlaceholders:3,nativeNamespaceVerified:true});
 expect(report.privilegedHookView.overlayOwnership).toEqual(Array(3).fill({uid:65534,mode:0o700}));
 expect(report.privilegedHookView.sourceRefusals).toEqual(['foreign-source','link-source','same-path-inode-replaced']);
 expect(report.hostPlaceholderOwnership).toEqual(Array(3).fill({uid:0,mode:0o755}));
 expect(report.sourceSha256).toEqual(Object.fromEntries([['probe.py','deploy/admission/test_next_host_view_native.py'],['next_profile.py','deploy/admission/next_profile.py'],['runtime_inventory.py','.github/ci/runtime_inventory.py']].map(([name,path])=>[name,createHash('sha256').update(readFileSync(path)).digest('hex')])));
 expect(report.stopElapsedMs).toBeLessThanOrEqual(4000);
},35000);
