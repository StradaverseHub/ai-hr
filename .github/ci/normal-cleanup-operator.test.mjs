import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {openNormalCleanupChannel,driveNormalCleanup} from './normal-cleanup-operator.mjs';
import {canonicalSourceExclusions} from './normal-cleanup-fences.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
for(const dirty of [false,true])test('actual parent driver and server orchestration '+(dirty?'refuse dirty checksum':'complete one valid-grant handshake'),async t=>{
 const directory=mkdtempSync(join(tmpdir(),'normal-cleanup-ipc-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const {grant}=installationFixture();writeFileSync(join(directory,'grant.json'),JSON.stringify(grant),{mode:0o600});
 const channel=openNormalCleanupChannel([],{launch:()=>spawn(process.execPath,[fileURLToPath(new URL('./normal-cleanup-fixture-child.mjs',import.meta.url)),directory],{stdio:['pipe','pipe','pipe']})});
 const arrival={source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,healthStatus:200},saved=[];
 const run=driveNormalCleanup({channel,grant,arrival,checksum:async()=>dirty?'>f fixture changed\n':'',frozen:()=>{},save:(name)=>saved.push(name)});
 if(dirty){await assert.rejects(run);await assert.rejects(channel.success());assert.ok(!existsSync(join(directory,'engine-observed.json')));assert.ok(saved.includes('cleanup-session-incomplete.json'));}
 else{const result=await run;assert.equal(result.cleanup.fictional,true);assert.equal(JSON.parse(readFileSync(join(directory,'engine-observed.json'))).consumed,true);assert.ok(saved.includes('cleanup-session-commit.json'));assert.ok(!existsSync(join(directory,'normal-cleanup.lock')));}
});
test('actual canonical release filter imports under installed tsx and parses every exclusion',()=>{
 const script=`import {deploymentRsyncArgs} from './scripts/improve/release.ts';console.log(JSON.stringify(deploymentRsyncArgs('/fictional/source')));`;
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:root,encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);
 const args=JSON.parse(result.stdout),excluded=canonicalSourceExclusions(args);
 for(const path of ['.env.production','.next','node_modules','nested/node_modules','mobile/android','mobile/secret.pem','docs/adr','scratchpad','.improve'])assert.ok(excluded(path),path);
 for(const path of ['app/layout.tsx','.github/ci/staging-build-install.mjs','mobile/app/index.tsx','docs/current.md'])assert.ok(!excluded(path),path);
});
test('real installer CLI/package refuses cleanup-session outside canonical staging before I/O',()=>{
 const result=spawnSync(process.execPath,[join(root,'.github/ci/staging-build-install.mjs'),'cleanup-session','a'.repeat(40),'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(result.status,1);assert.match(result.stderr,/existing Linux alpha\/staging source/);
});
