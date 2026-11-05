/** Pure refusal/orchestration fixtures. Never a staging authority or application witness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,mkdirSync,rmSync,symlinkSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {assertControllerInventory,controllerInventoryEntry,controllerLaunchCheck} from './reconciliation-controller-inventory.mjs';
import {durableCleanupRecord} from './normal-cleanup-io.mjs';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {validateInstallGrant,installHash,installJson} from './ci-install-grant.mjs';
import {validateReconciliationAuthority,createReconciliationAuthority,createReconciliationCommit,validateReconciliationCommit,runReconciliationSession} from './post-arrival-reconciliation-policy.mjs';
import {runNormalCleanupSession} from './normal-cleanup-session.mjs';
import {validateReconciliationDiagnostics} from './post-arrival-reconciliation-operator.mjs';
function fixture(){
 let clock=Date.now(),ready,calls=0;const original=installationFixture(clock-31*60000),g=original.grant,e=original.evidence,events=[];
 const tuple={source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256:installHash(installJson(g)+'\n')};
 const ledger={rows:681,expectedSha256:'c'.repeat(64),actualSha256:'d'.repeat(64)};
 const installed={authorizationSha256:tuple.authorizationSha256,releaseAuthorized:false,verified:{...tuple},activated:{...tuple,activation:{activeDirectory:{device:1,inode:22}},afterActivationMonotonicUs:10,bootIdSha256:'f'.repeat(64)},runtime:{...tuple,healthStatus:200,pid:'123',startedMonotonicUs:11,migrationLedger:ledger,verifiedAt:new Date(clock).toISOString()}};
 const input={grant:g,evidence:e,controller:'f'.repeat(40),diagnosticsRunId:1234,controllerInventorySha256:'a'.repeat(64),lease:{batch:'00000000-0000-4000-8000-000000000002',epoch:40,candidate:g.source},installed,output:'',checkedAt:new Date(clock).toISOString(),ciRevalidatedAt:new Date(clock).toISOString(),now:clock};
 const a=createReconciliationAuthority(input);
 let state={source:g.source,installId:g.installId,authorizationSha256:tuple.authorizationSha256,lease:a.lease,environment:a.environmentSha256,active:a.activeDirectory,pid:a.pid,started:a.startedMonotonicUs,boot:a.bootIdSha256,ledger:a.ledger,sourceMetadata:'same',compiledMetadata:'same',controllerMetadata:'a'.repeat(64),healthStatus:200};
 const options={authority:a,grant:g,now:()=>clock,nonce:()=> 'c'.repeat(64),retainAudit:async()=>events.push('durable-audit'),fences:async()=>{calls++;return structuredClone(state);},audit:async()=>{events.push('full-audit');return {...structuredClone(installed.runtime),verifiedAt:new Date(clock).toISOString()};},postFences:async()=>structuredClone(state),persist:async name=>events.push(name),consume:async()=>events.push('consumed'),authorize:async()=>events.push('authority'),removeOwned:async()=>{events.push('engine');return {fixture:true};},io:{ready:async value=>{ready=value;events.push('READY');},commit:async()=>createReconciliationCommit(ready,a,g,{output:'',checkedAt:new Date(clock).toISOString(),now:clock})}};
 return {g,a,input,installed,events,options,advance:ms=>clock+=ms,change:fn=>fn(state),calls:()=>calls,getReady:()=>ready,getClock:()=>clock};
}
test('distinct cleanup-only authority preserves expired original bytes and normal expiry refusal',async()=>{
 const f=fixture(),bytes=installJson(f.g);assert.throws(()=>validateInstallGrant(f.g));assert.throws(()=>validateInstallGrant(f.g,{now:f.getClock()}));
 await assert.rejects(runNormalCleanupSession({...f.options,grant:f.g}));assert.equal(installJson(f.g),bytes);
 assert.equal(validateReconciliationAuthority(f.a,f.g),f.a);await runReconciliationSession(f.options);
 assert.deepEqual(f.events,['durable-audit','full-audit','ready','READY','commit','authority','consumed','engine','owned-cleanup','full-audit']);assert.equal(f.calls(),4);assert.equal(installJson(f.g),bytes);
});
for(const [name,mutate]of [
 ['originalgrant',a=>a.selection.authorizationSha256='0'.repeat(64)],['source',a=>a.selection.source='0'.repeat(40)],['build',a=>a.selection.nextBuildId='other'],['run',a=>a.originalCi.runId++],['witness',a=>a.originalCi.witnessFingerprint='0'.repeat(64)],['baseline',a=>a.originalCi.baseline='0'.repeat(40)],
 ['environment',a=>a.environmentSha256='0'.repeat(63)+'1'],['scope',a=>a.kind='OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL'],['unknown',a=>a.extra=true],['unbounded',a=>a.expiresAt=new Date(Date.parse(a.issuedAt)+61*60000).toISOString()],['expired',a=>a.expiresAt=a.issuedAt],['staleCI',a=>a.originalCi.revalidatedAt=new Date(Date.parse(a.issuedAt)-301000).toISOString()],['stalechecksum',a=>a.sourceChecksum.checkedAt=new Date(Date.parse(a.issuedAt)-61000).toISOString()],['nonemptychecksum',a=>a.sourceChecksum.outputSha256=installHash('changed')],['leasecandidate',a=>a.lease.candidate='0'.repeat(40)],['wrongledger',a=>a.ledger.rows=0],['releaseclaim',a=>a.releaseAuthorized=true]
])test('reconciliation authority refuses '+name,()=>{const f=fixture(),a=structuredClone(f.a);mutate(a);assert.throws(()=>validateReconciliationAuthority(a,f.g));});
for(const [name,mutate]of [
 ['failedCI',i=>i.evidence={...i.evidence,result:'FAIL'}],['focusedCI',i=>i.evidence={...i.evidence,tier:'focused'}],['foreignartifact',i=>i.evidence={...i.evidence,build:{...i.evidence.build,archiveSha256:'0'.repeat(64)}}],['nocanonicalbinding',i=>i.evidence={...i.evidence,build:{...i.evidence.build,canonicalCandidateInputsVerified:false}}],['changedsource',i=>i.output='changed'],['unhealthy',i=>i.installed={...i.installed,runtime:{...i.installed.runtime,healthStatus:500}}],['futureruntime',i=>i.installed={...i.installed,runtime:{...i.installed.runtime,verifiedAt:new Date(i.now+1000).toISOString()}}]
])test('new authority requires actual original CI and installed evidence: '+name,()=>{const f=fixture(),i=structuredClone(f.input);mutate(i);assert.throws(()=>createReconciliationAuthority(i));});
test('slow full preparation audits precede READY and do not age the eventual source commitment',async()=>{
 const f=fixture();f.options.audit=async()=>{f.events.push('full-audit');f.advance(8*60000);return structuredClone(f.installed.runtime);};await runReconciliationSession(f.options);assert.ok(f.events.includes('engine'));
});
for(const name of ['pid','active','lease','environment','ledger','sourceMetadata','compiledMetadata','controllerMetadata'])test('live '+name+' drift after READY refuses deletion',async()=>{
 const f=fixture(),commit=f.options.io.commit;f.options.io.commit=async()=>{const c=await commit();f.change(s=>{if(name==='active')s.active.inode++;else if(name==='lease')s.lease.epoch++;else if(name==='ledger')s.ledger.actualSha256='0'.repeat(64);else s[name]='changed';});return c;};await assert.rejects(runReconciliationSession(f.options));assert.ok(!f.events.includes('engine'));
});
for(const stage of ['commit','authority','consumed'])test('checksum aging during '+stage+' refuses deletion',async()=>{
 const f=fixture(),old=f.options.persist;if(stage==='commit')f.options.persist=async n=>{await old(n);if(n==='commit')f.advance(61000);};else f.options[stage==='authority'?'authorize':'consume']=async()=>{f.events.push(stage);f.advance(61000);};await assert.rejects(runReconciliationSession(f.options));assert.ok(!f.events.includes('engine'));
});
test('same-channel nonce, selection and proof age are mandatory',async()=>{
 const f=fixture();f.options.io.commit=async()=>{
  const r=f.getReady(),c=createReconciliationCommit(r,f.a,f.g,{output:'',checkedAt:new Date(f.getClock()).toISOString(),now:f.getClock()});
  for(const mutate of [x=>x.nonce='0'.repeat(64),x=>x.readySha256='0'.repeat(64),x=>x.authoritySha256='0'.repeat(64),x=>x.checkedAt=new Date(f.getClock()-61000).toISOString(),x=>x.extra=true]){const bad=structuredClone(c);mutate(bad);assert.throws(()=>validateReconciliationCommit(bad,r,f.a,f.g,{now:f.getClock()}));}return c;
 };await runReconciliationSession(f.options);
});
test('separate authority expiry before removal refuses; expiry after removal retains consumed state and refuses final success',async()=>{
 for(const after of [false,true]){const f=fixture();if(after){let audits=0;f.options.audit=async()=>{if(++audits===2)f.advance(61*60000);return structuredClone(f.installed.runtime);};}else f.options.consume=async()=>{f.events.push('consumed');f.advance(61*60000);};await assert.rejects(runReconciliationSession(f.options));assert.equal(f.events.filter(e=>e==='engine').length,after?1:0);assert.equal(f.events.filter(e=>e==='consumed').length,1);}
});
test('failed final audit never returns success or repeats the cleanup engine',async()=>{const f=fixture();let calls=0;f.options.audit=async()=>{if(++calls===2)throw Error('fixture final audit failure');return {};};await assert.rejects(runReconciliationSession(f.options),/fixture final audit failure/);assert.equal(f.events.filter(e=>e==='engine').length,1);assert.equal(f.events.filter(e=>e==='consumed').length,1);});
for(const field of ['pid','startedMonotonicUs','source','migrationLedger'])test('final full runtime drift refuses final success: '+field,async()=>{
 const f=fixture();let audits=0;f.options.audit=async()=>{const runtime=structuredClone(f.installed.runtime);if(++audits===2){if(field==='migrationLedger')runtime.migrationLedger.actualSha256='0'.repeat(64);else runtime[field]=field==='startedMonotonicUs'?12:'changed';}return runtime;};
 await assert.rejects(runReconciliationSession(f.options));assert.equal(f.events.filter(e=>e==='engine').length,1);assert.equal(f.events.filter(e=>e==='consumed').length,1);
});
for(const field of ['pid','active','lease','environment','ledger','sourceMetadata','compiledMetadata','controllerMetadata','healthStatus'])test('post-cleanup live fence drift refuses final success: '+field,async()=>{
 const f=fixture(),post=f.options.postFences;f.options.postFences=async()=>{const state=await post();if(field==='active')state.active.inode++;else if(field==='lease')state.lease.epoch++;else if(field==='ledger')state.ledger.actualSha256='0'.repeat(64);else state[field]='changed';return state;};await assert.rejects(runReconciliationSession(f.options));assert.equal(f.events.filter(e=>e==='engine').length,1);
});
function inventoryFixture(t){
 const root=mkdtempSync(join(tmpdir(),'reconciliation-inventory-'));chmodSync(root,0o700);t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'ci'),{mode:0o700});
 const helper=Buffer.from('reviewed-helper-fixture\n');writeFileSync(join(root,'ci/helper.py'),helper,{mode:0o644});
 const manifest={format:1,kind:'REVIEWED_PRIVATE_RECONCILIATION_EXECUTABLE_INVENTORY',controller:'a'.repeat(40),entries:[controllerInventoryEntry('ci/helper.py',helper)]};
 durableCleanupRecord(join(root,'controller-inventory.json'),manifest);return {root,manifest,hash:installHash(installJson(manifest))};
}
test('real filesystem executable inventory binds bytes, paths, mode and metadata',t=>{
 const f=inventoryFixture(t),before=assertControllerInventory(f.root,f.manifest,{expectedSha256:f.hash});writeFileSync(join(f.root,'ci/helper.py'),'reviewed-helper-fixturE\n');assert.throws(()=>assertControllerInventory(f.root,f.manifest,{expectedSha256:f.hash}));
 writeFileSync(join(f.root,'ci/helper.py'),'reviewed-helper-fixture\n');assert.notEqual(assertControllerInventory(f.root,f.manifest,{expectedSha256:f.hash}),before);
 chmodSync(join(f.root,'ci/helper.py'),0o755);assert.throws(()=>assertControllerInventory(f.root,f.manifest,{expectedSha256:f.hash}));
});
test('real filesystem executable inventory refuses helper/directory symlinks and unknown executable additions',t=>{
 for(const scenario of ['file-link','directory-link','extra-file']){const f=inventoryFixture(t);if(scenario==='file-link'){renameSync(join(f.root,'ci/helper.py'),join(f.root,'ci/saved.py'));symlinkSync('saved.py',join(f.root,'ci/helper.py'));}else if(scenario==='directory-link'){renameSync(join(f.root,'ci'),join(f.root,'saved'));symlinkSync('saved',join(f.root,'ci'));}else writeFileSync(join(f.root,'ci/unreviewed.py'),'unreviewed');assert.throws(()=>assertControllerInventory(f.root,f.manifest,{expectedSha256:f.hash}));}
});
test('durable authority publication is owned, exact and refuses overwrite',t=>{
 const f=inventoryFixture(t),path=join(f.root,'authority.json');durableCleanupRecord(path,{kind:'PRIVATE_FIXTURE_AUTHORITY'});assert.throws(()=>durableCleanupRecord(path,{kind:'REPLACEMENT'}));
});
test('hosted diagnostic must be the exact reviewed controller with successful actual refusal steps',()=>{
 const controller='f'.repeat(40),run={id:123,repository:{id:1333414856},head_repository:{id:1333414856},head_sha:controller,event:'workflow_dispatch',run_attempt:1,status:'completed',conclusion:'success',path:'.github/workflows/alpha-staging.yml',created_at:new Date().toISOString()};
 const jobs=[{name:'resolve',head_sha:controller,run_id:123,run_attempt:1,conclusion:'success',steps:['CI integrity regression checks','Post-arrival reconciliation refusal checks'].map(name=>({name,conclusion:'success'}))},{name:'build',conclusion:'skipped'}];assert.equal(validateReconciliationDiagnostics(run,jobs,controller),true);
 for(const mutate of [(r,j)=>r.head_sha='0'.repeat(40),(r,j)=>r.run_attempt++,(r,j)=>j[0].steps.pop(),(r,j)=>j[0].steps[1].conclusion='failure',(r,j)=>j[1].conclusion='success']){const r=structuredClone(run),j=structuredClone(jobs);mutate(r,j);assert.throws(()=>validateReconciliationDiagnostics(r,j,controller));}
});

test('trusted inline launch inventory check prevents loading mutated or linked private helpers',t=>{
 const f=inventoryFixture(t),run=()=>spawnSync('bash',['-c','set -e; '+controllerLaunchCheck(f.root,f.hash)+'printf checked'],{encoding:'utf8'});
 const good=run();assert.equal(good.status,0);assert.equal(good.stdout,'checked');
 writeFileSync(join(f.root,'ci/helper.py'),'unreviewed fixture payload');const changed=run();assert.notEqual(changed.status,0);assert.equal(changed.stdout,'');
 rmSync(join(f.root,'ci/helper.py'));symlinkSync('../controller-inventory.json',join(f.root,'ci/helper.py'));const linked=run();assert.notEqual(linked.status,0);assert.equal(linked.stdout,'');
});

test('slow final live fences cannot outlast authority or return success',async()=>{
 const f=fixture(),post=f.options.postFences;f.options.postFences=async()=>{const state=await post();f.advance(61000);return state;};await assert.rejects(runReconciliationSession(f.options));assert.equal(f.events.filter(e=>e==='engine').length,1);
});
