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
  ownedRuntimeCleaned:true,admissionHandoffTransportSettled:true,resistantFamilyStopped:true,foreignInvocationRetained:true,
  actualExtraMountRefused:true,unmountedAppOwnedPlaceholderRefused:true});
 expect(report.privilegedHookView).toMatchObject({overlaid:true,rootUid:0,hostPlaceholders:3,nativeNamespaceVerified:true});
 expect(report.privilegedHookView.overlayOwnership).toEqual(Array(3).fill({uid:65534,mode:0o700}));
 expect(report.privilegedHookView.sourceRefusals).toEqual(['foreign-source','link-source','same-path-inode-replaced']);
 expect(report.hostPlaceholderOwnership).toEqual(Array(3).fill({uid:0,mode:0o755}));
 expect(report.sourceSha256).toEqual(Object.fromEntries([['probe.py','deploy/admission/test_next_host_view_native.py'],['next_profile.py','deploy/admission/next_profile.py'],['runtime_inventory.py','.github/ci/runtime_inventory.py'],['next_preparation.py','deploy/admission/test_next_native.py'],['controller.py','deploy/admission/controller.py']].map(([name,path])=>[name,createHash('sha256').update(readFileSync(path)).digest('hex')])));
 expect(report.admissionHandoff).toEqual({kind:'ACTUAL_SAME_PID_EXEC_JOURNAL_AVAILABILITY_NOT_ADMISSION',state:'observed',refusalCode:0,
  beforePairVerified:true,afterPairVerified:true,samePidObserved:true,exactDistinctArgvObserved:true,actualSharedEmitterTransportVerified:true,
  fullControllerAdmissionVerified:false,nextApplicationVerified:false,releaseEligible:false});
 expect(report.resourceTopology.admissionHandoff).toEqual(report.admissionHandoff);
 expect(report.stopElapsedMs).toBeLessThanOrEqual(4000);
 expect(report.resourceReadinessQualified).toBe(false);
 const preparation=report.managerEnvironmentPreparation;
 expect(preparation).toMatchObject({kind:'ACTUAL_SHARED_TYPED_MANAGER_PREPARATION_NOT_NEXT_OR_ADMISSION',stable:true,hostReadCapMs:500,fullHelperVerified:false,nextApplicationVerified:false,releaseEligible:false});
 expect(preparation.operations).toHaveLength(2);
 for(const [ordinal,operation]of preparation.operations.entries()){
  expect(Object.keys(operation).sort()).toEqual(['ordinal','outcome','returned','settled','keyCount','unsetCount'].sort());
  expect(operation).toMatchObject({ordinal,outcome:'complete',returned:true,settled:true});
  expect(Number.isInteger(operation.keyCount)&&operation.keyCount>=0&&operation.keyCount<=128).toBe(true);
  expect(Number.isInteger(operation.unsetCount)&&operation.unsetCount>=0&&operation.unsetCount<=operation.keyCount).toBe(true);
 }
 expect(preparation.operations[0].unsetCount).toBe(preparation.operations[1].unsetCount);
 const origin=report.installedPublicSgxSource;
 expect(Object.keys(origin).sort()).toEqual(['kind','state','knownPublicSourceSha256','defaultOverridesAbsent','customGeneratorPathObserved','exclusiveOriginVerified','nextApplicationVerified','releaseEligible'].sort());
 expect(origin).toMatchObject({kind:'INSTALLED_KNOWN_PUBLIC_UBUNTU_SGX_SOURCE_NOT_EXECUTION_HISTORY',customGeneratorPathObserved:false,exclusiveOriginVerified:false,nextApplicationVerified:false,releaseEligible:false});
 expect(['matched-public-source','unavailable']).toContain(origin.state);
 if(origin.state==='matched-public-source'){
  expect(origin.defaultOverridesAbsent).toBe(true);expect(origin.knownPublicSourceSha256).toBe('cb746a20301f3845341c980a4f5432f963a19645d2bbb390d1712bd1474751ab');
 }else expect(origin.knownPublicSourceSha256).toBeNull();
 const observed=report.initialEnvironmentObservation;
 expect(observed).toMatchObject({version:1,kind:'ACTUAL_OWNED_INITIAL_ENVIRONMENT_OBSERVATION_NOT_ADMISSION',
  subject:'host-component',sourceVerified:true,invocationMatched:true,processStable:true,parseComplete:true,
  nextApplicationVerified:false,releaseEligible:false});
 expect(observed.knownUnqualified).toMatchObject({'locale-language':true,'locale-numeric':true,'process-pwd':true,
  'locale-lang':false,'locale-all':false});
 expect(Object.keys(observed).sort()).toEqual(['version','kind','subject','sourceVerified','invocationMatched','processStable',
  'parseComplete','allowedCount','forbiddenPresent','unqualifiedCount','knownUnqualified','otherUnqualifiedCount',
  'nextApplicationVerified','releaseEligible'].sort());
 const knownLabels=['systemd-notify','systemd-fdstore','systemd-credentials','systemd-mainpid','systemd-managerpid',
  'systemd-listen-fds','systemd-listen-pid','systemd-listen-names','systemd-watchdog-pid','systemd-watchdog-usec',
  'systemd-runtime-directory','systemd-state-directory','systemd-cache-directory','systemd-logs-directory',
  'systemd-config-directory','systemd-log-namespace','systemd-terminal','systemd-xdg-runtime','systemd-xdg-seat',
  'systemd-xdg-vtnr','systemd-service-result','systemd-exit-code','systemd-exit-status','systemd-monitor-result',
  'systemd-monitor-exit-code','systemd-monitor-exit-status','systemd-monitor-invocation','systemd-monitor-unit',
  'systemd-pidfile','systemd-remote-address','systemd-remote-port','systemd-trigger-unit','systemd-trigger-path',
  'systemd-trigger-realtime','systemd-trigger-monotonic','next-start-time','next-runtime','next-origin',
  'locale-language','locale-ctype','locale-numeric','locale-time','locale-collate','locale-monetary','locale-messages',
  'locale-paper','locale-name','locale-address','locale-telephone','locale-measurement','locale-identification',
  'locale-lang','locale-all','process-timezone','process-pwd','process-shell-level','process-underscore',
  'next-processed-environment','next-deployment'];
 expect(Object.keys(observed.knownUnqualified).sort()).toEqual(knownLabels.sort());
 expect(typeof observed.forbiddenPresent).toBe('boolean');
 expect(Object.values(observed.knownUnqualified).every(value=>typeof value==='boolean')).toBe(true);
 for(const key of ['allowedCount','unqualifiedCount','otherUnqualifiedCount'])expect(Number.isInteger(observed[key])&&observed[key]>=0&&observed[key]<=1024*1024).toBe(true);
 expect(observed.allowedCount+observed.unqualifiedCount).toBeLessThanOrEqual(1024*1024);
 expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThanOrEqual(4096);
 expect(observed.unqualifiedCount).toBe(Object.values(observed.knownUnqualified).filter(Boolean).length+observed.otherUnqualifiedCount);
 expect(observed.otherUnqualifiedCount).toBeGreaterThanOrEqual(1);
 expect(JSON.stringify(observed)).not.toMatch(/fictional-private-canary|AIHR_OBSERVATION_CANARY|fictional-observation/);
 const hooks=report.initialEnvironmentHookObservation;
 expect(Object.keys(hooks).sort()).toEqual(['kind','stages','fullHelperVerified','nextApplicationVerified','releaseEligible'].sort());
 expect(hooks).toEqual({kind:'ACTUAL_SHARED_OBSERVER_HOOKS_NOT_FULL_HELPER_OR_NEXT',
  stages:['declaration-before','process-before','environment-read','environment-classified','process-after','custody-after'],
  fullHelperVerified:false,nextApplicationVerified:false,releaseEligible:false});
 const keyProof=report.initialEnvironmentKeyNameObservation;
 expect(Object.keys(keyProof).sort()).toEqual(['kind','subject','keyNames','fullHelperVerified','nextApplicationVerified','releaseEligible'].sort());
 expect(keyProof).toMatchObject({kind:'ACTUAL_SHARED_KEY_NAME_DIGEST_COMPONENT_NOT_FULL_HELPER_OR_NEXT',subject:'host-component',fullHelperVerified:false,nextApplicationVerified:false,releaseEligible:false});
 const keyNames=keyProof.keyNames;
 expect(Object.keys(keyNames).sort()).toEqual(['version','kind','state','count','digests','reason'].sort());
 expect(keyNames).toMatchObject({version:1,kind:'INITIAL_ENV_OTHER_KEY_NAMES_SHA256_NOT_ADMISSION',state:'complete',reason:'none',count:observed.otherUnqualifiedCount});
 expect(Number.isInteger(keyNames.count)&&keyNames.count>=1&&keyNames.count<=4).toBe(true);
 expect(keyNames.digests).toHaveLength(keyNames.count);expect(keyNames.digests).toEqual([...new Set(keyNames.digests)].sort());
 expect(keyNames.digests.every((value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))).toBe(true);
 expect(keyNames.digests).toContain(createHash('sha256').update(Buffer.concat([Buffer.from('AIHR_INITIAL_ENV_OTHER_KEY_NAME_SHA256_V1\0'),Buffer.from('AIHR_OBSERVATION_CANARY')])).digest('hex'));
 expect(JSON.stringify(keyProof)).not.toMatch(/fictional-private-canary|AIHR_OBSERVATION_CANARY|fictional-observation/);
 const plainProof=report.initialEnvironmentPlainKeyNameObservation;
 expect(Object.keys(plainProof).sort()).toEqual(['kind','subject','keyNames','namesComplete','names','fullHelperVerified','nextApplicationVerified','releaseEligible'].sort());
 expect(plainProof).toMatchObject({kind:'ACTUAL_SHARED_PLAIN_OTHER_KEY_NAMES_COMPONENT_NOT_FULL_HELPER_OR_NEXT',subject:'host-component',fullHelperVerified:false,nextApplicationVerified:false,releaseEligible:false});
 expect(plainProof.keyNames).toEqual(keyNames);expect(typeof plainProof.namesComplete).toBe('boolean');
 expect(Array.isArray(plainProof.names)).toBe(true);
 if(plainProof.namesComplete){
  expect(plainProof.names).toHaveLength(keyNames.count);expect(plainProof.names).toEqual([...new Set(plainProof.names)].sort());
  expect(plainProof.names.every((name:unknown)=>typeof name==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))).toBe(true);
  expect(plainProof.names).toContain('AIHR_OBSERVATION_CANARY');
  expect(plainProof.names.map((name:string)=>createHash('sha256').update(Buffer.concat([Buffer.from('AIHR_INITIAL_ENV_OTHER_KEY_NAME_SHA256_V1\0'),Buffer.from(name)])).digest('hex')).sort()).toEqual(keyNames.digests);
 }else expect(plainProof.names).toEqual([]);
 expect(JSON.stringify(plainProof)).not.toMatch(/fictional-private-canary|fictional-observation|name=value/);
 const topology=report.resourceTopology;
 expect(topology).toMatchObject({kind:'ACTUAL_UNCHANGED_RESOURCE_METHOD_DIAGNOSTIC_NOT_READINESS',
  actualProcessUnchanged:true,profileConstructorVerified:false,nextApplicationVerified:false,releaseEligible:false});
 expect(topology.resourceReady).toBe(true);expect(topology.guardReason).toBe('resource-check-accepted');
 expect(topology.leafCPUWeightBefore).toBe(100);expect(topology.leafCPUWeightAfter).toBe(100);
 expect(topology.before[0].cpu).toMatchObject({capPresent:true,available:true});expect(topology.before[1].cpu.subtreeEnabled).toBe(true);
 expect(topology.after).toEqual(topology.before);
 expect(topology.before.map((row:{tier:string})=>row.tier)).toEqual(['worker','aggregate','root']);
 for(const row of topology.before){
  expect(Object.keys(row).sort()).toEqual(['cpu','memory','tier']);
  for(const kind of ['cpu','memory']){expect(Object.keys(row[kind]).sort()).toEqual(['available','capPresent','subtreeEnabled']);for(const value of Object.values(row[kind]))expect(typeof value).toBe('boolean');}
 }
 expect(topology.kernelVersion).toMatch(/^[A-Za-z0-9.+_-]{1,128}$/);
},35000);
