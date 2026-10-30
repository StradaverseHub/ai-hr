import test from 'node:test';
import assert from 'node:assert/strict';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {runNormalCleanupSession,createCommit,validateCommit,validateReady} from './normal-cleanup-session.mjs';
import {createCleanupRequest} from './staging-cleanup-protocol.mjs';
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
