/** Private fixtures only: no GitHub/SSH/service/app/database or real installation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,chmodSync,symlinkSync,renameSync,readdirSync,statSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {CI_POLICY} from './policy-version.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {STAGING_BUILD_RUNTIME,BUILD_CAPACITY_PROFILE,assertBuildDotenvCompileKeys} from './build-production.mjs';
import {validateInstallGrant,createInstallGrant,installJson,installHash} from './ci-install-grant.mjs';
import {initializePrivateInstall,readPrivateInstall,assertServiceDescriptor,retainNormalCleanupAudit} from './staging-build-install.mjs';
import {installationFixture as fixture} from './staging-install-test-fixture.mjs';
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sha=c=>c.repeat(40),digest=c=>c.repeat(64);
function privateFixture(t){
 const home=mkdtempSync(join(tmpdir(),'aihr-ci-install-'));t.after(()=>rmSync(home,{recursive:true,force:true}));return home;
}
test('fresh attempts retain the original build UUID and authenticated origin without creating a gate receipt',()=>{
 const f=fixture(),second=createInstallGrant(f);
 assert.notEqual(f.grant.installId,second.installId);assert.notEqual(f.grant.installId,f.grant.build.buildRecordId);
 assert.equal(second.build.buildRecordId,f.grant.build.buildRecordId);assert.equal(second.runId,f.run.id);
 assert.equal(validateInstallGrant(f.grant,{now:f.now}),f.grant);
 assert.equal(f.grant.result,undefined);assert.equal(f.grant.releaseAuthorized,undefined);
});
test('failed, partial, different-source, repeated-attempt and duplicate-artifact evidence refuses',()=>{
 for(const mutate of [
  f=>f.evidence.result='FAIL',f=>f.evidence.tier='focused',f=>f.evidence.build.canonicalCandidateInputsVerified=false,
  f=>f.evidence.build.source=sha('c'),f=>f.run.id++,f=>f.run.head_sha=sha('c'),f=>f.run.run_attempt=2,
  f=>f.run.conclusion='failure',f=>f.run.repository.id=1,f=>f.run.head_repository.id=1,
  f=>f.producer.conclusion='failure',f=>f.producer.run_attempt=2,f=>f.producer.run_id++,
  f=>f.evidence.artifacts.push({...f.evidence.artifacts[0]}),f=>f.evidence.artifacts=[]
 ]){const f=fixture();mutate(f);assert.throws(()=>createInstallGrant(f));}
});
test('grant scope, exact shapes, hashes, runtime and immutable source/build identities refuse mutations',()=>{
 for(const mutate of [
  g=>g.target='production',g=>g.controllerBranch='codex/work',g=>g.source='short',g=>g.baselineBuildId=g.build.nextBuildId,
  g=>g.environmentSha256='bad',g=>g.witnessFingerprint='bad',g=>g.runAttempt=2,g=>g.extra='unrecognized',
  g=>g.artifact.extra=true,g=>g.artifact.digest=digest('a'),g=>g.build.extra=true,
  g=>g.build.runtime.node='22.0.0',g=>g.build.archiveBytes=272*1024**2+1,
  g=>g.format=1,g=>g.build.format=1,g=>delete g.build.capacityProfile,g=>g.policyVersion='aihr-staging-ci/v15',g=>g.policyVersion='aihr-staging-ci/v16',
  g=>g.build.capacityProfile={profileVersion:2,archiveMaxBytes:276824064,zipMaxBytes:293601280},g=>g.build.capacityProfile.profileVersion=2,g=>g.build.capacityProfile.archiveMaxBytes=276824064,g=>g.build.capacityProfile.profileVersion=true,g=>g.build.capacityProfile.archiveMaxBytes=285212673,g=>g.build.capacityProfile.profileVersion=1,g=>g.build.capacityProfile.archiveMaxBytes=268435456,g=>g.build.capacityProfile.zipMaxBytes++,
  g=>g.build.capacityProfile.extra=true,g=>g.build.buildSourcePath='/source/../other',g=>g.build.preparedSha256='bad',g=>g.installId='../escape'
 ]){const {grant}=fixture();mutate(grant);assert.throws(()=>validateInstallGrant(grant));}
});
test('expired or overlong authority never silently extends the original CI lifetime',()=>{
 const f=fixture(),g=f.grant;
 assert.throws(()=>validateInstallGrant(g,{now:Date.parse(g.expiresAt)}));
 for(const mutate of [
  g=>g.expiresAt=new Date(f.now+31*60000).toISOString(),
  g=>g.runCreatedAt=new Date(f.now-86400001).toISOString(),
  g=>g.producerCompletedAt=new Date(f.now+1).toISOString(),
  g=>g.producerStartedAt=new Date(f.now-250000).toISOString(),
  g=>g.issuedAt='not-a-date'
 ]){const copy=structuredClone(g);mutate(copy);assert.throws(()=>validateInstallGrant(copy,{now:f.now}));}
});
test('private store persists canonical immutable grants, pins its directory and refuses replay',t=>{
 const home=privateFixture(t),{grant}=fixture(),created=initializePrivateInstall(grant,{home}),p=readPrivateInstall(grant.installId,{home});
 assert.equal(created.releaseAuthorized,false);assert.equal(created.authorizationSha256,p.authorizationSha256);
 assert.equal(installHash(readFileSync(join(p.directory,'authorization.json'))),created.authorizationSha256);
 assert.equal(readFileSync(join(p.directory,'authorization.json'),'utf8'),installJson(grant)+'\n');
 for(const path of [p.parent,p.directory,p.packet])assert.equal(statSync(path).mode&0o777,0o700);
 assert.throws(()=>initializePrivateInstall(grant,{home}));
 assert.deepEqual(readdirSync(p.directory).sort(),['authorization.json','packet','store.json']);
});
test('private-store symlink, shared permissions and changed grant bytes refuse before installation',t=>{
 const home=privateFixture(t),{grant}=fixture(),created=initializePrivateInstall(grant,{home}),p=readPrivateInstall(grant.installId,{home});
 chmodSync(p.parent,0o755);assert.throws(()=>readPrivateInstall(grant.installId,{home}));chmodSync(p.parent,0o700);
 const auth=join(p.directory,'authorization.json'),bytes=readFileSync(auth);
 writeFileSync(auth,JSON.stringify(grant,null,2));assert.throws(()=>readPrivateInstall(grant.installId,{home}));
 writeFileSync(auth,bytes);const saved=auth+'.saved';renameSync(auth,saved);symlinkSync(saved,auth);
 assert.throws(()=>readPrivateInstall(grant.installId,{home}));
 assert.equal(created.releaseAuthorized,false);
});
test('moving a store and replacing it with identical files does not retain its inode authority',t=>{
 const home=privateFixture(t),{grant}=fixture();initializePrivateInstall(grant,{home});const p=readPrivateInstall(grant.installId,{home}),moved=p.directory+'.moved';
 renameSync(p.directory,moved);mkdirSync(p.directory,{mode:0o700});mkdirSync(p.packet,{mode:0o700});
 for(const name of ['authorization.json','store.json'])copyFileSync(join(moved,name),join(p.directory,name));
 assert.throws(()=>readPrivateInstall(grant.installId,{home}));
 assert.equal(readFileSync(join(moved,'authorization.json'),'utf8'),installJson(grant)+'\n');
});
test('an existing parent symlink cannot redirect a new installation',t=>{
 const home=privateFixture(t),foreign=join(home,'foreign');mkdirSync(foreign,{mode:0o700});symlinkSync(foreign,join(home,'.aihr-ci-builds'));
 assert.throws(()=>initializePrivateInstall(fixture().grant,{home}));assert.deepEqual(readdirSync(foreign),[]);
});
test('actual systemd descriptor requires the pinned Node and Next startup path',()=>{
 const source='/opt/ai-hr',descriptor='{ path=/opt/node22/bin/node ; argv[]=/opt/node22/bin/node /opt/ai-hr/node_modules/next/dist/bin/next start -p 3000 ; ignore_errors=no ; }';
 assert.equal(assertServiceDescriptor(descriptor,source),true);
 for(const text of [descriptor.replaceAll('node22','node24'),descriptor.replaceAll('node22','node20'),descriptor.replace('/opt/ai-hr/node_modules','/tmp/other/node_modules'),descriptor+descriptor,descriptor.replace('next start','next dev'),'']){assert.notEqual(text,descriptor,'Refusal control must actually change the descriptor');assert.throws(()=>assertServiceDescriptor(text,source));}
});
test('all four Next dotenv inputs refuse compile-affecting private keys without returning values',t=>{
 const source=privateFixture(t);
 for(const name of ['.env.production.local','.env.local','.env.production','.env']){
  const path=join(source,name);writeFileSync(path,'SERVER_ONLY_FIXTURE=private-value\n');assert.doesNotThrow(()=>assertBuildDotenvCompileKeys(source));
  for(const key of ['NEXT_PUBLIC_TEST','NEXT_SERVER_ACTIONS_ENCRYPTION_KEY']){
   writeFileSync(path,'export '+key+'=never-print-this-value\n');
   assert.throws(()=>assertBuildDotenvCompileKeys(source),e=>!e.message.includes('never-print-this-value'));
  }rmSync(path);
 }
});
test('CI deployment refuses invalid/reseed/partial inputs before private env or any external commands',t=>{
 const root=privateFixture(t);mkdirSync(join(root,'deploy'));
 copyFileSync(new URL('../../deploy/deploy.sh',import.meta.url),join(root,'deploy/deploy.sh'));
 writeFileSync(join(root,'deploy/deploy-state.sh'),'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> state-events\n',{mode:0o700});
 const valid='--ci-build='+uuid(2),record='--testing-build-record='+uuid(1);
 for(const args of [['--ci-build=invalid'],[valid],[valid,record,'--reseed'],[valid,record,'--migrate-only'],[valid,valid,record]]){
  const result=spawnSync('bash',[join(root,'deploy/deploy.sh'),...args],{encoding:'utf8',timeout:3000,env:{PATH:process.env.PATH}});
  assert.equal(result.status,1,result.stderr+result.stdout);assert.doesNotMatch(result.stdout+result.stderr,/Missing .env.production/);
 }
 assert.deepEqual(readdirSync(root).sort(),['deploy','state-events']);
 assert.equal(readFileSync(join(root,'state-events'),'utf8').split('\n').filter(x=>x.startsWith('finish ')).length,5);
});

test('a substituted packet directory and missing-packet cleanup scope cannot authorize ordinary staging',t=>{
 const home=privateFixture(t),{grant}=fixture();initializePrivateInstall(grant,{home});
 const p=readPrivateInstall(grant.installId,{home}),original=p.packet+'.original';renameSync(p.packet,original);mkdirSync(p.packet,{mode:0o700});
 assert.throws(()=>readPrivateInstall(grant.installId,{home}));rmSync(p.packet,{recursive:true});renameSync(original,p.packet);
 rmSync(p.packet,{recursive:true});
 assert.throws(()=>readPrivateInstall(grant.installId,{home}));
 assert.throws(()=>readPrivateInstall(grant.installId,{home,allowCleanup:true}));
 const authority={kind:'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL',authorizationSha256:p.authorizationSha256,source:grant.source,installId:grant.installId,
  buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,directory:{device:statSync(p.directory).dev,inode:statSync(p.directory).ino}};
 writeFileSync(join(p.directory,'cleanup-authorized.json'),JSON.stringify(authority),{mode:0o600});
 assert.equal(readPrivateInstall(grant.installId,{home,allowCleanup:true}).allowCleanup,true);
 assert.throws(()=>readPrivateInstall(grant.installId,{home})); // Never becomes activation authority.
});

test('bundle hashing and unpacking get ten minutes, inside the detached deploy deadline',async()=>{
 const {BUNDLE_PYTHON_TIMEOUT_MS}=await import('./staging-build-install.mjs');
 assert.equal(BUNDLE_PYTHON_TIMEOUT_MS,600000);
 const source=readFileSync(new URL('./staging-build-install.mjs',import.meta.url),'utf8');
 assert.equal(source.match(/timeout:BUNDLE_PYTHON_TIMEOUT_MS/g).length,2);
 assert.ok(3*BUNDLE_PYTHON_TIMEOUT_MS+BUNDLE_PYTHON_TIMEOUT_MS<60*60_000);
});


test('only the closed current grant admits the newly bounded archive range',()=>{
 const {grant}=fixture();
 assert.equal(grant.format,2);assert.equal(grant.build.format,2);assert.deepEqual(grant.build.capacityProfile,BUILD_CAPACITY_PROFILE);
 for(const archiveBytes of [256*1024**2+1,264*1024**2+1,272*1024**2])assert.doesNotThrow(()=>validateInstallGrant({...grant,build:{...grant.build,archiveBytes}}));
 assert.throws(()=>validateInstallGrant({...grant,build:{...grant.build,archiveBytes:272*1024**2+1}}));
});
test('retained baseline identity fences preserve opaque old records without a legacy decoder or new authority',t=>{
 const directory=privateFixture(t),next=join(directory,'retained'),packet=join(directory,'packet');
 mkdirSync(next,{mode:0o700});mkdirSync(packet,{mode:0o700});mkdirSync(join(packet,'bytes'),{mode:0o700});
 writeFileSync(join(next,'BUILD_ID'),'old-baseline');
 const opaque=Buffer.from('{"format":1,"oldBaselineRecord":"unchanged and never decoded"}\n');
 writeFileSync(join(next,'original-format1-manifest.json'),opaque,{mode:0o600});
 const opaqueProfile2=Buffer.from('{"format":2,"capacityProfile":{"profileVersion":2,"archiveMaxBytes":276824064,"zipMaxBytes":293601280},"oldBaselineRecord":"unchanged and never decoded"}\n');
 writeFileSync(join(next,'original-profile2-manifest.json'),opaqueProfile2,{mode:0o600});
 const entries={'system-testing.json':Buffer.from('new prepared record'),'successful-build.json':Buffer.from('new observation record'),
  'build-provenance.json':Buffer.from('new current provenance'),'bytes/build-bundle-files.json':Buffer.from('new current manifest')};
 for(const [name,data]of Object.entries(entries))writeFileSync(join(packet,name),data,{mode:0o600});
 const stat=statSync(next),p={directory,next,packet,grant:{baselineBuildId:'old-baseline'}},activated={activation:{retainedDirectory:{device:stat.dev,inode:stat.ino}}};
 retainNormalCleanupAudit(p,activated);
 assert.deepEqual(readFileSync(join(next,'original-format1-manifest.json')),opaque);
 assert.deepEqual(readFileSync(join(next,'original-profile2-manifest.json')),opaqueProfile2);
 assert.equal(readFileSync(join(next,'BUILD_ID'),'utf8'),'old-baseline');
 for(const [name,data]of Object.entries(entries))assert.deepEqual(readFileSync(join(directory,'audit',name)),data);
 assert.equal(readdirSync(directory).includes('cleanup-authorized.json'),false,'Audit retention alone grants no cleanup authority');
 for(const changed of [{activation:{retainedDirectory:{device:stat.dev,inode:stat.ino+1}}}, {activation:{retainedDirectory:{device:stat.dev+1,inode:stat.ino}}}])assert.throws(()=>retainNormalCleanupAudit(p,changed));
 writeFileSync(join(next,'BUILD_ID'),'foreign');assert.throws(()=>retainNormalCleanupAudit(p,activated));writeFileSync(join(next,'BUILD_ID'),'old-baseline');
 writeFileSync(join(packet,'build-provenance.json'),'changed current record');assert.throws(()=>retainNormalCleanupAudit(p,activated));
 assert.deepEqual(readFileSync(join(next,'original-format1-manifest.json')),opaque);
 assert.deepEqual(readFileSync(join(next,'original-profile2-manifest.json')),opaqueProfile2);
 assert.equal(readFileSync(join(next,'BUILD_ID'),'utf8'),'old-baseline');
});
