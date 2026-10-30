/** Pure synthetic port fixtures. No SSH, target, deletion, build, or CI witness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {installJson} from './ci-install-grant.mjs';
import {CLEANUP_SELECTION as selection,digest} from './post-arrival-cleanup-policy.mjs';
import {runAuthorizedCleanupSession} from './post-arrival-cleanup-session.mjs';
function fixture(change={}){
 let clock=Date.parse('2026-10-30T16:00:00Z'),removed=0,audits=0,consumed=false,ready;
 const controller='a'.repeat(40),toolSha256='b'.repeat(64),records=[];
 const grant={source:selection.source,installId:selection.installId,build:{buildRecordId:selection.buildRecordId,nextBuildId:selection.nextBuildId}};
 const approval={format:1,kind:'EXPLICIT_SINGLE_POST_EXPIRY_OWNED_CLEANUP',selection,controller,toolSha256,humanEvidenceSha256:'c'.repeat(64),approvedAt:new Date(clock).toISOString(),expiresAt:new Date(clock+1800000).toISOString()};
 const current={...Object.fromEntries(['bootIdSha256','environmentSha256','ledgerSha256','sourceStatSha256','compiledStatSha256','originalRecordsSha256'].map(k=>[k,'d'.repeat(64)])),
  source:selection.source,batch:selection.batch,epoch:7,pid:'123',nextBuildId:selection.nextBuildId,activeDirectory:{device:1,inode:2},retainedDirectory:{device:1,inode:3},packetDirectory:{device:1,inode:4}};
 const runtime={source:selection.source,installId:selection.installId,buildRecordId:selection.buildRecordId,nextBuildId:selection.nextBuildId,pid:'123',healthStatus:200,fullMigrationLedgerVerified:true};
 const ports={grant,authority:{},approval,controller,toolSha256,now:()=>clock,nonce:()=> 'e'.repeat(64),
  fences:async()=>structuredClone(current),audit:async()=>{audits++;clock+=240000;return runtime;},persist:async(name,value)=>records.push({name,value}),
  io:{ready:async value=>{ready=value;},commit:async()=>{clock+=10000;return {format:1,kind:'COMMIT_SINGLE_POST_ARRIVAL_OWNED_CLEANUP',selection,nonce:ready.nonce,preparationSha256:digest(installJson(ready)),approvalSha256:digest(installJson(approval)),toolSha256,checksumCheckedAt:new Date(clock).toISOString(),checksumOutputSha256:digest('')};}},
  consume:async()=>{assert(!consumed,'replayed');consumed=true;},removeOwned:async()=>{removed++;return {kind:'OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED',authorizationSha256:selection.authorizationSha256,installId:selection.installId,source:selection.source,nextBuildId:selection.nextBuildId,verifiedAbsent:['next','packet'],auditEvidenceRetained:true};}};
 Object.assign(ports,change);
 return {ports,current,records,get removed(){return removed;},get audits(){return audits;},advance:ms=>clock+=ms};
}
test('slow preparation plus new checksum succeeds; preserves incomplete handback boundary',async()=>{
 const f=fixture(),result=await runAuthorizedCleanupSession(f.ports);
 assert.equal(f.removed,1);assert.equal(f.audits,2);assert.equal(result.releaseHandbackVerified,false);assert.equal(result.fullSourceChecksumVerified,false);assert.equal(result.releaseAuthorized,false);
 assert.deepEqual(f.records.map(r=>r.name),['preparation','commit','owned-cleanup','result']);
});
test('EOF, late checksum, or source drift preserve owned resources',async()=>{
 for(const kind of ['eof','late','source']){
  const f=fixture(),commit=f.ports.io.commit;
  f.ports.io.commit=async()=>{if(kind==='eof')throw Error('EOF');const value=await commit();if(kind==='late')f.advance(60001);if(kind==='source')f.current.sourceStatSha256='f'.repeat(64);return value;};
  await assert.rejects(runAuthorizedCleanupSession(f.ports));assert.equal(f.removed,0,kind);
 }
});
test('delayed durable commit or consume cannot age source proof before removal',async()=>{
 for(const phase of ['persist','consume']){
  const f=fixture(),persist=f.ports.persist,consume=f.ports.consume;
  if(phase==='persist')f.ports.persist=async(name,value)=>{await persist(name,value);if(name==='commit')f.advance(60001);};
  else f.ports.consume=async value=>{await consume(value);f.advance(60001);};
  await assert.rejects(runAuthorizedCleanupSession(f.ports),/60 seconds/);assert.equal(f.removed,0);
 }
});
test('changed preparation state, failed audit, and replay consumption never invoke remover',async()=>{
 for(const kind of ['drift','audit','replay']){
  const f=fixture(),audit=f.ports.audit;
  if(kind==='drift')f.ports.audit=async()=>{const r=await audit();f.current.pid='999';return r;};
  if(kind==='audit')f.ports.audit=async()=>{throw Error('compiled bytes differ');};
  if(kind==='replay')f.ports.consume=async()=>{throw Error('nonce already consumed');};
  await assert.rejects(runAuthorizedCleanupSession(f.ports));assert.equal(f.removed,0);
 }
});
