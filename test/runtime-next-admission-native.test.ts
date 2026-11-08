/** Dedicated hybrid singleton. This is actual Next boot, not the500-actor release gate. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {expect,it} from 'vitest';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {collectNativeSourceProof} from '../scripts/performance/next-source-proof.mjs';
import {readProtectedBootstrap} from '../.github/ci/native-next-installation.mjs';

it('boots two actual same-build Next workers through protected native admission and real password/TOTP Home journeys',async()=>{
 const admission=admitSingletonTest('test/runtime-next-admission-native.test.ts');
 assert.equal(admission.mode,'full-ci-singleton');assert.equal(process.env.GITHUB_JOB,'native-test');
 const source=realpathSync(process.cwd()),candidate=process.env.AIHR_CI_HEAD!,controller=process.env.AIHR_CI_CONTROL_HEAD!;
 const bootstrap=readProtectedBootstrap();assert.equal(realpathSync(process.execPath),bootstrap.protectedNodePath);
 assert(/^[a-f0-9]{40}$/.test(candidate)&&/^[a-f0-9]{40}$/.test(controller));
 assert.equal(execFileSync('/usr/bin/git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidate);
 const runId=process.env.GITHUB_RUN_ID!,unit=admission.databaseUnit;
 assert(/^[1-9][0-9]{0,19}$/.test(runId)&&/^[A-Za-z0-9_-]{1,100}$/.test(unit));
 const sealed=join('/var/lib/aihr-native-build',runId,unit),packetDirectory=process.env.AIHR_NATIVE_NEXT_PACKET_DIR!,buildBindingPath=process.env.AIHR_NATIVE_NEXT_BUILD_BINDING!;
 assert.equal(packetDirectory,join(sealed,'packet'));assert.equal(buildBindingPath,join(sealed,'build-binding.json'));
 const privateDirectory=mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP!),'aihr-next-private-'));chmodSync(privateDirectory,0o700);
 const privateIdentity=lstatSync(privateDirectory),original=new Map<string,string|undefined>();
 const environment:Record<string,string>={NODE_ENV:'production',HOME:'/var/empty/aihr',PATH:'/usr/bin:/bin',NEXT_TELEMETRY_DISABLED:'1',
  AUTH_PROVIDER:'internal',ALLOW_DEMO_SESSION:'false',DATABASE_URL:process.env.DATABASE_URL!,AUTH_PUBLIC_ORIGIN:'https://localhost:3443',
  AUTH_SESSION_KEY:randomBytes(32).toString('hex'),AUTH_DEFAULT_ORGANIZATION:'native-a',AUDIT_HASH_CHAIN_ENABLED:'true',AI_CONFIG_SECRET:randomBytes(32).toString('hex')};
 try{
  // This process alone owns the fresh fixture DB. Real web workers receive only
  // the closed app environment; browser receives fictional logins and no DB URL.
  for(const key of ['AUTH_PROVIDER','ALLOW_DEMO_SESSION','AUTH_PUBLIC_ORIGIN','AUTH_SESSION_KEY','AUTH_DEFAULT_ORGANIZATION','AUDIT_HASH_CHAIN_ENABLED','AI_CONFIG_SECRET']){
   original.set(key,process.env[key]);process.env[key]=environment[key];
  }
  const {seedNativeNextFixture}=await import('./helpers/native-next-fixture');
  const fixture=await seedNativeNextFixture(),proof=collectNativeSourceProof(source,candidate);
  const browserInputPath=join(privateDirectory,'browser.json'),planPath=join(privateDirectory,'plan.json');
  writeFileSync(browserInputPath,JSON.stringify({version:1,kind:'PRIVATE_NATIVE_NEXT_BOOT_BROWSER_INPUT',budgetMs:300000,
   evidenceDirectory:admission.evidenceDirectory,fixture})+'\n',{flag:'wx',mode:0o600});
  const plan={version:1,kind:'NATIVE_NEXT_TWO_WORKER_BOOT_INPUT',candidate,controller,runId,unit,sourceDirectory:source,
   nodePath:bootstrap.node.path,packetDirectory,buildBindingPath,sourceProof:proof,environment,fixture,
   browserInputPath,evidenceDirectory:admission.evidenceDirectory,runnerUid:process.getuid!(),runnerGid:process.getgid!()};
  writeFileSync(planPath,JSON.stringify(plan)+'\n',{flag:'wx',mode:0o600});
  const keys=['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_JOB','GITHUB_RUN_ID','AIHR_CI_HEAD','AIHR_CI_CONTROL_HEAD','RUNNER_TEMP']as const;
  // The API provisioner captured and root-sealed this exact helper closure
  // before candidate code ran. Never sudo a mutable checkout Python module.
  execFileSync('sudo',['-n','/usr/bin/env','-i','PATH=/usr/sbin:/usr/bin:/sbin:/bin',`SUDO_UID=${process.getuid!()}`,`SUDO_GID=${process.getgid!()}`,
   ...keys.map(key=>`${key}=${process.env[key]??''}`),'/usr/bin/python3','-I','-B',
   join(sealed,'helpers/test_next_native.py'),planPath],{timeout:510000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024});
  const report=JSON.parse(readFileSync(join(admission.evidenceDirectory,'runtime-next-admission-native.json'),'utf8'));
  expect(report).toMatchObject({source:candidate,controller,runId,unit,complete:true,releaseEligible:false,
   fullApplicationJourneysVerified:false,hostInstallationVerified:false,actualNextBootVerified:true,
   checkOnlyDidNotStartWorkers:true,coldBusinessRequests:0,allStoppedGenerationsReclaimed:true,
   rawBindAndProcessFamilyBarriersPreserved:true,ownedRuntimeCleaned:true});
  const projection=report.managerEnvironmentProjection;
  expect(projection).toMatchObject({kind:'ACTUAL_PRIVATE_MANAGER_KEYS_PROJECTION_NOT_ADMISSION',stable:true,effectiveUnitsVerified:true});
  expect(projection.operations).toHaveLength(2);
  for(const [ordinal,operation]of projection.operations.entries()){
   expect(Object.keys(operation).sort()).toEqual(['ordinal','outcome','returned','settled','keyCount','unsetCount'].sort());
   expect(operation).toMatchObject({ordinal,outcome:'complete',returned:true,settled:true});
   expect(Number.isInteger(operation.keyCount)&&operation.keyCount>=0&&operation.keyCount<=128).toBe(true);
   expect(Number.isInteger(operation.unsetCount)&&operation.unsetCount>=0&&operation.unsetCount<=operation.keyCount).toBe(true);
  }
  expect(projection.operations[0].unsetCount).toBe(projection.operations[1].unsetCount);
  const bootstrapTiming=report.bootstrapTiming,stages=['profile-open','immutable-source-full-read','first-owned-start','first-ready','browser-launch','first-request-lifetime','first-ready-before','first-live-proof-composite','first-filesystem-proof','first-ready-after','first-reply-flush','browser-exit-observed','profile-close'];
  expect(Object.keys(bootstrapTiming).sort()).toEqual(['kind','slots','browserExit','browserFirstRequest'].sort());
  expect(bootstrapTiming.kind).toBe('FIXED_OWNER_STAGE_TIMINGS_NOT_ADMISSION');expect(bootstrapTiming.slots).toHaveLength(13);
  for(const [slot,row]of bootstrapTiming.slots.entries()){
   expect(Object.keys(row).sort()).toEqual(['slot','stage','outcome','startUs','endUs','elapsedUs','returned','code'].sort());
   expect(row).toMatchObject({slot,stage:stages[slot],outcome:'returned',returned:true,code:slot===11?0:null});
   expect(Number.isSafeInteger(row.startUs)&&row.startUs>=0&&Number.isSafeInteger(row.endUs)&&row.endUs>=row.startUs).toBe(true);
   expect(row.elapsedUs).toBe(row.endUs-row.startUs);
  }
  for(const [before,after]of [[0,1],[1,2],[2,3],[3,4],[4,5],[6,7],[7,8],[8,9],[9,10],[5,11],[11,12]]as const)expect(bootstrapTiming.slots[before].endUs).toBeLessThanOrEqual(bootstrapTiming.slots[after].startUs);
  expect(bootstrapTiming.slots[5].startUs).toBeLessThanOrEqual(bootstrapTiming.slots[6].startUs);expect(bootstrapTiming.slots[5].endUs).toBeGreaterThanOrEqual(bootstrapTiming.slots[10].endUs);
  expect(bootstrapTiming.slots[5].elapsedUs).toBeLessThanOrEqual(90000000);expect(bootstrapTiming.slots[12].endUs-bootstrapTiming.slots[0].startUs).toBeLessThanOrEqual(450000000);
  expect(bootstrapTiming.browserFirstRequest).toMatchObject({kind:'ACTUAL_FIRST_HOST_REQUEST_TIMING_NOT_ADMISSION',outcome:'returned'});
  expect(Number.isSafeInteger(bootstrapTiming.browserFirstRequest.timeoutMs)&&bootstrapTiming.browserFirstRequest.timeoutMs>0&&bootstrapTiming.browserFirstRequest.timeoutMs<=90000).toBe(true);
  expect(Number.isSafeInteger(bootstrapTiming.browserFirstRequest.elapsedMs)&&bootstrapTiming.browserFirstRequest.elapsedMs>=0&&bootstrapTiming.browserFirstRequest.elapsedMs<=bootstrapTiming.browserFirstRequest.timeoutMs).toBe(true);
  expect(Number.isSafeInteger(bootstrapTiming.browserFirstRequest.driverFinalElapsedMs)&&bootstrapTiming.browserFirstRequest.driverFinalElapsedMs>=0&&bootstrapTiming.browserFirstRequest.driverFinalElapsedMs<=300000).toBe(true);
  const exit=bootstrapTiming.browserExit;
  expect(Object.keys(exit).sort()).toEqual(['kind','invocationMatched','mainStartUs','mainExitUs','wrapperExitObservedUs','wrapperReturnCode','state'].sort());
  expect(exit.kind).toBe('OWNED_BROWSER_CLOCK_OBSERVATIONS_NOT_ADMISSION');expect(typeof exit.invocationMatched).toBe('boolean');expect(exit.wrapperReturnCode).toBe(0);
  expect(Number.isSafeInteger(exit.wrapperExitObservedUs)&&exit.wrapperExitObservedUs>=0).toBe(true);
  if(exit.state==='observed'){
   expect(exit.invocationMatched).toBe(true);expect(Number.isSafeInteger(exit.mainStartUs)&&exit.mainStartUs>0&&Number.isSafeInteger(exit.mainExitUs)&&exit.mainExitUs>=exit.mainStartUs).toBe(true);
  }else{expect(exit.state).toBe('unavailable');expect(exit.mainStartUs).toBeNull();expect(exit.mainExitUs).toBeNull();}
  expect(Buffer.byteLength(JSON.stringify(bootstrapTiming))).toBeLessThanOrEqual(4096);
  expect(Buffer.byteLength(JSON.stringify({bootstrapTiming},null,2))+2).toBeLessThanOrEqual(4096);
  expect(report.nativeIngress).toMatchObject({tls:true,nodeProxyUsed:false,webWorkers:2,steadyLoadCapacityClaim:false,proxyNextUpstream:'off'});
  expect(report.slicePreflight).toMatchObject({fixedImplicitSliceAbsenceVerified:true,existingKernelCgroup:false});
  expect(report.slicePreflight.lookupDirectories).toBeGreaterThan(0);expect(report.slicePreflight.lookupDirectories).toBeLessThanOrEqual(64);
  expect(report.slicePreflight.associatedUnitsInspected).toBeGreaterThan(0);expect(report.slicePreflight.associatedUnitsInspected).toBeLessThanOrEqual(2048);
  expect(report.dependencyProbe).toMatchObject({kind:'NONROOT_NATIVE_DEPENDENCY_PROBE_NOT_APPLICATION_ACCEPTANCE',
   copiedRuntimeCwdVerified:true,privateHomeVerified:true,cjkGlyphs:2,actualNextBootVerified:false});
  expect(report.dependencyProbe.uid).toBeGreaterThan(0);expect(report.dependencyProbe.imageBytes).toBeGreaterThan(20);
  expect(report.dependencyProbe.mappedExecutableFiles).toBeGreaterThan(0);expect(report.dependencyProbe.mappedExecutableFiles).toBeLessThanOrEqual(512);
  expect(report.workers).toHaveLength(3);expect(new Set(report.workers.map((row:{port:number})=>row.port)).size).toBe(2);
  for(const row of report.workers){
   expect(row.kernel.namespace).toMatchObject({actualKernelMountsVerified:true,actualEnvironmentVerified:true});
   expect(row.kernel.resources).toMatchObject({aggregateCapsVerified:true,productionEquivalent:false,cpuOversubscriptionDiagnostic:false});
   expect(row.filesystem).toEqual({actualNamespaceFilesystemVerified:true,cacheWrites:3,immutableParentRefusals:5,originalCheckoutReadWriteRefusals:4});
  }
  expect(report.browser).toMatchObject({complete:true,realPasswordTotpLogins:2,unexpectedBrowserErrors:0,nonemptyOwnPayrollView:true});
  expect(report.package).toMatchObject({source:candidate,sameCanonicalBuildPacket:true,actionKeyOverride:false});
  expect(report.package.actionManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.installation).toMatchObject({preCandidateWitnessMatched:true,
   dependencies:{normalization:'ROOT_COPY_DEPENDENCIES_V2'}});
  expect(report.installation.dependencies.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.ownedPostgresScope).toMatchObject({version:1,kind:'JOB_OWNED_PERSISTENT_ZERO_SWAP',scopeOnly:true});
  expect(report.ownedPostgresScope.containerIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.ownedPostgresScope.observations).toEqual(['registered','before-config-reload','after-config-reload',
   'before-cleanup-reload','after-cleanup-reload','final'].map(stage=>({stage,memoryMax:2113929216,memorySwapMax:0,managerSwapMax:'0'})));
  expect(report.remaining).toContain('500-actor-steady-load');
 }finally{
  for(const[key,value]of original){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const actual=lstatSync(privateDirectory);assert.equal(actual.ino,privateIdentity.ino);assert.equal(actual.dev,privateIdentity.dev);
  assert.equal(actual.uid,process.getuid!());assert.equal(realpathSync(privateDirectory),privateDirectory);assert.equal(dirname(privateDirectory),realpathSync(process.env.RUNNER_TEMP!));
  rmSync(privateDirectory,{recursive:true});
 }
},600000);
