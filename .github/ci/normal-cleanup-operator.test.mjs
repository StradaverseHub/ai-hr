import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,mkdirSync,lstatSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {openNormalCleanupChannel,driveNormalCleanup} from './normal-cleanup-operator.mjs';
import {withNormalCleanupLock,retainNormalCleanupAudit} from './staging-build-install.mjs';
import {canonicalSourceExclusions,captureNormalCleanupFences} from './normal-cleanup-fences.mjs';
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
 const script=`const raw=await import('./scripts/improve/release.ts');const official={...(raw.default??{}),...raw};if(typeof official.deploymentRsyncArgs!=='function')throw Error('Actual canonical filter export missing');console.log(JSON.stringify(official.deploymentRsyncArgs('/fictional/source')));`;
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);
 const args=JSON.parse(result.stdout),excluded=canonicalSourceExclusions(args);
 for(const path of ['.env.production','.next','node_modules','nested/node_modules','mobile/android','mobile/secret.pem','docs/adr','scratchpad','.improve'])assert.ok(excluded(path),path);
 for(const path of ['app/layout.tsx','.github/ci/staging-build-install.mjs','mobile/app/index.tsx','docs/current.md'])assert.ok(!excluded(path),path);
});
test('real installer CLI/package refuses cleanup-session outside canonical staging before I/O',()=>{
 const result=spawnSync(process.execPath,[join(root,'.github/ci/staging-build-install.mjs'),'cleanup-session','a'.repeat(40),'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(result.status,1);assert.match(result.stderr,/existing Linux alpha\/staging source/);
});

test('shared real legacy/session lock excludes interleaved mutators without taking over existing locks',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'normal-mutator-lock-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let finish,entered=0;const held=new Promise(done=>finish=done);
 const first=withNormalCleanupLock(directory,{mode:'session'},async()=>{entered++;await held;});
 await assert.rejects(withNormalCleanupLock(directory,{mode:'legacy'},async()=>entered++));
 await assert.rejects(withNormalCleanupLock(directory,{mode:'session'},async()=>entered++));assert.equal(entered,1);finish();await first;
 writeFileSync(join(directory,'normal-cleanup.lock'),'unknown',{mode:0o600});await assert.rejects(withNormalCleanupLock(directory,{mode:'legacy'},async()=>entered++));assert.equal(entered,1);
});

test('RESULT without terminal subprocess close times out without killing or retrying unknown peer',async()=>{
 const channel=openNormalCleanupChannel([],{terminalTimeout:20,launch:()=>spawn(process.execPath,['-e',"console.log('{}');setTimeout(()=>{},100)"],{stdio:['pipe','pipe','pipe']})});
 await assert.rejects(channel.success(),/timed out/);
});
for(const field of ['source','compiled','record','ledger','environment','lease','pid','active-inode','retained-inode','packet-inode'])test('actual production fence assembly detects '+field+' drift',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'normal-adapter-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const source=join(directory,'source'),store=join(directory,'store');mkdirSync(source,{mode:0o700});mkdirSync(store,{mode:0o700});for(const path of [join(source,'.next'),join(store,'next'),join(store,'packet')])mkdirSync(path,{mode:0o700});
 writeFileSync(join(source,'app.ts'),'a');writeFileSync(join(source,'.next','code.js'),'a');writeFileSync(join(store,'record.json'),'a');
 const ident=path=>{const s=lstatSync(path);return {device:s.dev,inode:s.ino};},p={directory:store,next:join(store,'next'),packet:join(store,'packet'),grant:{source:'fictional',installId:'fictional'},authorizationSha256:'fictional'};
 const activated={activation:{activeDirectory:ident(join(source,'.next')),retainedDirectory:ident(p.next)}};let ledger='before',environment='before',lease='before',pid='123';
 const capture=()=>captureNormalCleanupFences({source,p,activated,exclude:path=>path==='.next',recordNames:['record.json'],ports:{authority:async()=>{},lease:async()=>{},runtime:async()=>{},service:async()=>({pid,started:'1',active:true}),ledger:async()=>({actualSha256:ledger,verifiedAt:new Date().toISOString()}),leaseIdentity:async()=>lease,boot:async()=>'boot',environment:async()=>environment,health:async()=>200}});
 const before=await capture();assert.deepEqual(await capture(),before);
 if(field==='source')writeFileSync(join(source,'app.ts'),'b');if(field==='compiled')writeFileSync(join(source,'.next','code.js'),'b');if(field==='record')writeFileSync(join(store,'record.json'),'b');
 if(field==='ledger')ledger='after';if(field==='environment')environment='after';if(field==='lease')lease='after';if(field==='pid')pid='124';
 if(field.endsWith('-inode')){const path=field==='active-inode'?join(source,'.next'):field==='retained-inode'?p.next:p.packet;renameSync(path,path+'.old');mkdirSync(path,{mode:0o700});}
 let after;try{after=await capture();}catch(error){assert.match(String(error),/Cleanup runtime\/inodes changed|ENOENT/);return;}assert.notDeepEqual(after,before);
});
test('actual audit adapter retains original bytes and refuses partial/corrupt audit without authority',t=>{
 const directory=mkdtempSync(join(tmpdir(),'normal-audit-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const next=join(directory,'next'),packet=join(directory,'packet');mkdirSync(next,{mode:0o700});mkdirSync(packet,{mode:0o700});mkdirSync(join(packet,'bytes'),{mode:0o700});writeFileSync(join(next,'BUILD_ID'),'baseline');const st=lstatSync(next),p={directory,next,packet,grant:{baselineBuildId:'baseline'}},activated={activation:{retainedDirectory:{device:st.dev,inode:st.ino}}};
 for(const name of ['system-testing.json','successful-build.json','build-provenance.json'])writeFileSync(join(packet,name),'fictional-'+name);
 assert.throws(()=>retainNormalCleanupAudit(p,activated));assert.ok(!existsSync(join(directory,'cleanup-authorized.json')));
 writeFileSync(join(packet,'bytes/build-bundle-files.json'),'fictional-manifest');retainNormalCleanupAudit(p,activated);assert.equal(readFileSync(join(directory,'audit/system-testing.json'),'utf8'),'fictional-system-testing.json');
 writeFileSync(join(directory,'audit/system-testing.json'),'changed');assert.throws(()=>retainNormalCleanupAudit(p,activated));assert.ok(!existsSync(join(directory,'cleanup-authorized.json')));
});
