/** Actual host-only conformance; this is neither a Next build nor app journey. */
import {createHash} from 'node:crypto';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,lstatSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
it('proves privileged cache overlays and bounded owned stop with actual systemd255',()=>{
 expect(process.platform).toBe('linux');expect(process.env.GITHUB_ACTIONS).toBe('true');
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 const admission=admitSingletonTest('test/runtime-next-host-view-native.test.ts');
 // The shared unit evidence root has no0700 contract. Own a NEW private
 // child rather than relaxing the root probe or changing other unit artifacts.
 const privateDirectory=join(admission.evidenceDirectory,'runtime-next-host-view');mkdirSync(privateDirectory,{mode:0o700});
 const before=lstatSync(privateDirectory);expect(before.isDirectory()).toBe(true);expect(before.isSymbolicLink()).toBe(false);
 expect(realpathSync(privateDirectory)).toBe(privateDirectory);expect(before.uid).toBe(process.getuid!());expect(before.mode&0o777).toBe(0o700);
 const preflight={kind:'ACTUAL_HOST_PROBE_ENTRY_METADATA_NOT_NATIVE_CONFORMANCE',sharedEvidenceMode:lstatSync(admission.evidenceDirectory).mode&0o777,
  privateEvidenceMode:before.mode&0o777,privateOwnerMatches:true,releaseEligible:false};
 writeFileSync(join(privateDirectory,'entry-preflight.json'),JSON.stringify(preflight)+'\n',{flag:'wx',mode:0o600});
 const evidence=join(privateDirectory,'runtime-next-host-view-native.json');
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
 expect(report.resourceReadinessQualified).toBe(false);
 const topology=report.resourceTopology;
 expect(topology).toMatchObject({kind:'ACTUAL_UNCHANGED_RESOURCE_METHOD_DIAGNOSTIC_NOT_READINESS',
  actualProcessUnchanged:true,profileConstructorVerified:false,nextApplicationVerified:false,releaseEligible:false});
 expect(typeof topology.resourceReady).toBe('boolean');
 if(topology.resourceReady)expect(topology.guardReason).toBe('resource-check-accepted');
 else expect(topology.guardReason).toMatch(/^(?:missing-nonroot-cap|ancestor-memory-too-low|ancestor-cpu-too-low|resource-check-refused)$/);
 expect(topology.after).toEqual(topology.before);
 expect(topology.before.map((row:{tier:string})=>row.tier)).toEqual(['worker','aggregate','root']);
 for(const row of topology.before){
  expect(Object.keys(row).sort()).toEqual(['cpu','memory','tier']);
  for(const kind of ['cpu','memory']){expect(Object.keys(row[kind]).sort()).toEqual(['available','capPresent','subtreeEnabled']);for(const value of Object.values(row[kind]))expect(typeof value).toBe('boolean');}
 }
 expect(topology.kernelVersion).toMatch(/^[A-Za-z0-9.+_-]{1,128}$/);
},35000);
