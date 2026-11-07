/** Dedicated hybrid singleton. This is actual Next boot, not the500-actor release gate. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {expect,it} from 'vitest';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {collectNativeSourceProof} from '../scripts/performance/next-source-proof.mjs';

it('boots two actual same-build Next workers through protected native admission and real password/TOTP Home journeys',async()=>{
 const admission=admitSingletonTest('test/runtime-next-admission-native.test.ts');
 assert.equal(admission.mode,'full-ci-singleton');assert.equal(process.env.GITHUB_JOB,'native-test');
 const source=realpathSync(process.cwd()),candidate=process.env.AIHR_CI_HEAD!,controller=process.env.AIHR_CI_CONTROL_HEAD!;
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
   nodePath:realpathSync(process.execPath),packetDirectory,buildBindingPath,sourceProof:proof,environment,fixture,
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
  expect(report.nativeIngress).toMatchObject({tls:true,nodeProxyUsed:false,webWorkers:2,steadyLoadCapacityClaim:false,proxyNextUpstream:'off'});
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
   dependencies:{normalization:'ROOT_COPY_DEPENDENCIES_V1'}});
  expect(report.installation.dependencies.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.remaining).toContain('500-actor-steady-load');
 }finally{
  for(const[key,value]of original){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const actual=lstatSync(privateDirectory);assert.equal(actual.ino,privateIdentity.ino);assert.equal(actual.dev,privateIdentity.dev);
  assert.equal(actual.uid,process.getuid!());assert.equal(realpathSync(privateDirectory),privateDirectory);assert.equal(dirname(privateDirectory),realpathSync(process.env.RUNNER_TEMP!));
  rmSync(privateDirectory,{recursive:true});
 }
},600000);
