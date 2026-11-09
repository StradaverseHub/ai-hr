import test from 'node:test';
import assert from 'node:assert/strict';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {runNormalCleanupSession,createCommit,validateCommit,validateReady} from './normal-cleanup-session.mjs';
import {createCleanupRequest} from './staging-cleanup-protocol.mjs';
import {installJson,validateInstallGrant} from './ci-install-grant.mjs';
import {cleanupInstallSelection,createArrivalCleanupAuthority,validateArrivalCleanupAuthority,validateArrivalCleanupRuntime} from './arrival-cleanup-authority.mjs';
function fixture(change={}){
 let clock=Date.now(),ready,calls=0;const {grant}=installationFixture(clock),events=[];let state={pid:'123',ledger:'original',source:'same',compiled:'same'};
 const arrival={source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,healthStatus:200};
 const options={grant,now:()=>clock,nonce:()=> 'c'.repeat(64),retainAudit:async()=>events.push('durable-audit'),fences:async()=>{calls++;return structuredClone(state);},audit:async()=>{events.push('full-audit');return {healthStatus:200};},persist:async name=>events.push(name),consume:async()=>events.push('consumed'),authorize:async()=>events.push('authority'),removeOwned:async()=>{events.push('engine');return {fixture:true};},io:{ready:async value=>{ready=value;events.push('READY');},commit:async()=>createCommit(ready,{...createCleanupRequest(grant,{output:'',checkedAt:new Date().toISOString(),arrival}),checkedAt:new Date(clock).toISOString()},grant,{now:clock})},...change};
 return {grant,events,options,advance:ms=>clock+=ms,mutate:()=>state.pid='changed',calls:()=>calls,getReady:()=>ready};
}
test('normal valid grant session retains audit before READY and consumes once before unchanged engine',async()=>{
 const f=fixture();await runNormalCleanupSession(f.options);assert.deepEqual(f.events,['durable-audit','full-audit','ready','READY','commit','authority','consumed','engine','owned-cleanup','full-audit']);assert.equal(f.calls(),4);
});
test('slow complete audit precedes source proof; proof age does not include full preparation',async()=>{
 const f=fixture();f.options.audit=async()=>{f.events.push('full-audit');f.advance(90000);return {};};await runNormalCleanupSession(f.options);assert.ok(f.events.includes('engine'));
});
for(const stage of ['commit','authority','consumed'])test('proof aging during '+stage+' durable write refuses engine',async()=>{
 const f=fixture(),old=f.options.persist;if(stage==='commit')f.options.persist=async name=>{await old(name);if(name==='commit')f.advance(61000);};else f.options[stage==='authority'?'authorize':'consume']=async()=>{f.events.push(stage);f.advance(61000);};
 await assert.rejects(runNormalCleanupSession(f.options));assert.ok(!f.events.includes('engine'));
});
test('runtime drift after READY refuses without deletion',async()=>{const f=fixture(),old=f.options.io.commit;f.options.io.commit=async()=>{const c=await old();f.mutate();return c;};await assert.rejects(runNormalCleanupSession(f.options));assert.ok(!f.events.includes('engine'));});
test('original installation grant expiry is never renewed by a fresh proof',async()=>{const f=fixture();f.options.consume=async()=>f.advance(24*60*60*1000);await assert.rejects(runNormalCleanupSession(f.options));assert.ok(!f.events.includes('engine'));});
test('READY and COMMIT refuse foreign selection, unknown fields, stale/old proof and nonce replay',async()=>{
 const f=fixture();f.options.io.commit=async()=>{const ready=f.getReady(),proof=createCleanupRequest(f.grant,{output:'',checkedAt:new Date().toISOString(),arrival:{source:f.grant.source,installId:f.grant.installId,buildRecordId:f.grant.build.buildRecordId,nextBuildId:f.grant.build.nextBuildId,healthStatus:200}}),commit=createCommit(ready,proof,f.grant);
 for(const mutate of [c=>c.nonce='a'.repeat(64),c=>c.extra=true,c=>c.readySha256='b'.repeat(64),c=>c.proof.checkedAt=new Date(Date.now()-61000).toISOString()]){const c=structuredClone(commit);mutate(c);assert.throws(()=>validateCommit(c,ready,f.grant));}
 assert.throws(()=>validateReady({...ready,selection:{...ready.selection,source:'e'.repeat(40)}},f.grant));return commit;};await runNormalCleanupSession(f.options);
});

test('grant expiry during post-removal full audit refuses final success without replaying engine',async()=>{const f=fixture();let audits=0;f.options.audit=async()=>{if(++audits===2)f.advance(31*60000);return {};};await assert.rejects(runNormalCleanupSession(f.options));assert.equal(f.events.filter(e=>e==='engine').length,1);assert.equal(f.events.filter(e=>e==='consumed').length,1);});

test('failed post-cleanup full audit retains consumed state and never repeats engine',async()=>{const f=fixture();let calls=0;f.options.audit=async()=>{if(++calls===2)throw Error('controlled post-audit failure');};await assert.rejects(runNormalCleanupSession(f.options),/controlled post-audit failure/);assert.equal(f.events.filter(e=>e==='engine').length,1);assert.equal(f.events.filter(e=>e==='consumed').length,1);});

// Observed release offsets. Only the wall clock and fictional identities are used here.
function arrivalFixture({ciToArrivalMs=30000,checksumMs=120000}={}){
 const issued=Date.parse('2026-11-09T19:18:14.582Z'),arrived=Date.parse('2026-11-09T19:47:45.021Z');
 let clock=arrived+checksumMs,ready,attempts=0,audits=0;
 const {grant,evidence}=installationFixture(issued);
 const selection=cleanupInstallSelection(grant),lease={batch:'0'.repeat(36),epoch:74,candidate:grant.source};
 const active={device:9,inode:1},directory={device:9,inode:2},retained={device:9,inode:3},packet={device:9,inode:4};
 const ledger={rows:726,expectedSha256:'a'.repeat(64),actualSha256:'b'.repeat(64)};
 const boot='d'.repeat(64),pid='123',started=100,environment=grant.environmentSha256;
 const activated={...selection,activation:{activeDirectory:active},bootIdSha256:boot,afterActivationMonotonicUs:98};
 const arrival={...selection,healthStatus:200,pid,startedMonotonicUs:started,migrationLedger:ledger,verifiedAt:new Date(arrived).toISOString()};
 const input={grant,evidence,lease,installed:{verified:selection,activated,runtime:arrival,cleanupCustody:{directory,retained,packet}},output:'',
  checkedAt:new Date(clock).toISOString(),revalidatedAt:new Date(arrived-ciToArrivalMs).toISOString(),now:clock};
 const authority=createArrivalCleanupAuthority(input),events=[];
 const live={source:grant.source,installId:grant.installId,authorizationSha256:selection.authorizationSha256,lease,boot,pid,started,environment,active,directory,retained,packet,ledger};
 const options={grant,authority,now:()=>clock,fences:async()=>structuredClone(live),retainAudit:async()=>events.push('retained'),
  audit:async()=>{clock+=++audits===1?180000:120000;return arrival;},persist:async name=>events.push(name),consume:async()=>events.push('consumed'),
  authorize:async()=>events.push('authority'),removeOwned:async()=>{attempts++;return {fixture:true};},
  io:{ready:async value=>{ready=value;},commit:async()=>{
   clock+=70000;const opts={now:clock,authority};
   return createCommit(ready,createCleanupRequest(grant,{output:'',checkedAt:new Date(clock).toISOString(),arrival},opts),grant,opts);
  }}};
 return {grant,authority,options,events,live,input,arrived,arrivedRuntime:arrival,advance:ms=>clock+=ms,attempts:()=>attempts};
}
test('healthy f07 timing finishes one cleanup after the immutable installation grant expired',async()=>{
 const f=arrivalFixture(),bytes=installJson(f.grant);
 assert.equal(Date.parse(f.grant.expiresAt)-f.arrived,29561);
 assert.throws(()=>validateInstallGrant(f.grant,{now:f.options.now()}),/Staging grant expired/);
 await assert.rejects(runNormalCleanupSession({...f.options,authority:undefined}),/Staging grant expired/);
 await runNormalCleanupSession(f.options);
 assert.equal(f.attempts(),1);assert.equal(installJson(f.grant),bytes);
 assert.deepEqual(f.events,['retained','ready','commit','authority','consumed','owned-cleanup']);
});
for(const [label,mutate] of [
 ['foreign lease',f=>{f.live.lease={...f.live.lease,epoch:75};}],
 ['foreign boot',f=>{f.live.boot='e'.repeat(64);}],
 ['wrong PID',f=>{f.live.pid='321';}],
 ['wrong ledger',f=>{f.live.ledger={...f.live.ledger,rows:725};}],
 ['retained inode changed',f=>{f.live.retained={device:9,inode:10};}],
 ['packet inode changed',f=>{f.live.packet={device:9,inode:11};}],
 ['active inode changed',f=>{f.live.active={device:9,inode:12};}],
 ['expired cleanup authority',f=>{f.advance(30*60000);}],
 ['insufficient reserve before READY',f=>{f.advance(13*60000);}],
])test('arrival cleanup refuses '+label+' before deletion',async()=>{
 const f=arrivalFixture();mutate(f);await assert.rejects(runNormalCleanupSession(f.options));assert.equal(f.attempts(),0);
});
test('arrival cleanup rejects mismatched original witness, scope, stale evidence and post-cleanup health drift',()=>{
 const f=arrivalFixture();
 for(const mutate of [
  v=>v.kind='OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL',v=>v.ci.witnessFingerprint='0'.repeat(64),
  v=>v.ci.revalidatedAt=new Date(f.input.now-13*60000-1).toISOString(),v=>v.checksum.checkedAt=new Date(f.input.now-61000).toISOString(),
  v=>v.expiresAt=new Date(f.input.now+31*60000).toISOString()
 ]){
  const value=structuredClone(f.authority);mutate(value);assert.throws(()=>validateArrivalCleanupAuthority(value,f.grant,{now:f.input.now}));
 }
 const {pid,startedMonotonicUs,...live}=f.authority.runtime;
 assert.throws(()=>validateArrivalCleanupRuntime(f.authority,{...f.arrivedRuntime,healthStatus:503},live),/live health/);
});
test('delayed original CI revalidation, ten-minute live arrival audit and two-minute checksum fit the bounded authority',()=>{
 const f=arrivalFixture({ciToArrivalMs:600000,checksumMs:120000});
 assert.equal(Date.parse(f.input.revalidatedAt),f.arrived-600000);
 assert.doesNotThrow(()=>validateArrivalCleanupAuthority(f.authority,f.grant,{now:f.input.now}));
 assert.throws(()=>validateArrivalCleanupAuthority(f.authority,f.grant,{now:f.input.now+60001,freshSource:true}),/Fresh actual source verification/);
 assert.throws(()=>arrivalFixture({ciToArrivalMs:660001,checksumMs:120000}),/Fresh CI and source verification/);
 assert.throws(()=>arrivalFixture({ciToArrivalMs:30000,checksumMs:180001}),/Fresh exact live installation/);
});
test('arrival cleanup fails after deletion when final audit outlasts authority and does not replay mutation',async()=>{
 const f=arrivalFixture(),original=f.options.audit;let calls=0;
 f.options.audit=async()=>{const value=await original();if(++calls===2)f.advance(30*60000);return value;};
 await assert.rejects(runNormalCleanupSession(f.options),/Live arrival cleanup authority/);
 assert.equal(f.attempts(),1);assert.ok(f.events.includes('consumed'));assert.ok(f.events.includes('owned-cleanup'));
});
