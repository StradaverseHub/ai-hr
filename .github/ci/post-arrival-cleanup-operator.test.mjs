/** Hosted private-channel fixtures; no SSH, credentials or target mutations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {CLEANUP_SELECTION as selection,createCleanupPreparation,digest} from './post-arrival-cleanup-policy.mjs';
import {installJson} from './ci-install-grant.mjs';
import {driveCleanup,waitCleanupMessage} from './post-arrival-cleanup-operator.mjs';
function fixture({checksum='',badResult=false}={}){
 const now=Date.parse('2026-10-30T16:00:00Z'),tool={controller:'a'.repeat(40),toolSha256:'b'.repeat(64)};
 const approval={format:1,kind:'EXPLICIT_SINGLE_POST_EXPIRY_OWNED_CLEANUP',selection,...tool,humanEvidenceSha256:'c'.repeat(64),approvedAt:new Date(now).toISOString(),expiresAt:new Date(now+1800000).toISOString()};
 const fences={source:selection.source,batch:selection.batch,epoch:7,pid:'123',nextBuildId:selection.nextBuildId,
  ...Object.fromEntries(['bootIdSha256','environmentSha256','ledgerSha256','sourceStatSha256','compiledStatSha256','originalRecordsSha256'].map(k=>[k,'d'.repeat(64)])),activeDirectory:{device:1,inode:2},retainedDirectory:{device:1,inode:3},packetDirectory:{device:1,inode:4}};
 const runtime={source:selection.source,installId:selection.installId,buildRecordId:selection.buildRecordId,nextBuildId:selection.nextBuildId,healthStatus:200,fullMigrationLedgerVerified:true};
 const preparation=createCleanupPreparation({nonce:'e'.repeat(64),fences,runtime,approvalSha256:digest(installJson(approval)),toolSha256:tool.toolSha256,now});
 const stdout=new PassThrough(),records=[];let commits=0,checks=0,phases=0;
 const stdin=new Writable({write(chunk,encoding,done){
  const request=JSON.parse(chunk.toString());commits++;assert.equal(request.nonce,preparation.nonce);
  queueMicrotask(()=>stdout.end(installJson({kind:'PRIVATE_CLEANUP_RESULT',result:{kind:'POST_EXPIRY_OWNED_CLEANUP_COMPLETE_NOT_HAND_BACK',...selection,
   source:badResult?'wrong':selection.source,approvalSha256:request.approvalSha256,toolSha256:tool.toolSha256,ownedResourceCleanupVerified:true,releaseHandbackVerified:false,releaseAuthorized:false}})+'\n'));done();
 }});
 queueMicrotask(()=>stdout.write(installJson({kind:'PRIVATE_CLEANUP_READY',preparation})+'\n'));
 return {ports:{channel:{stdout,stdin,success:async()=>{}},checksum:async()=>{checks++;return checksum;},frozen:()=>{},save:(name,value)=>records.push({name,value}),approval,tool,
  phase:async()=>{phases++;return {phase:'arrived'};},now:()=>now+10000},records,get commits(){return commits;},get checks(){return checks;},get phases(){return phases;}};
}
test('actual private channel sends one fresh commit and requires final checksum before phase arrival',async()=>{
 const f=fixture(),result=await driveCleanup(f.ports);assert.equal(f.commits,1);assert.equal(f.checks,2);assert.equal(f.phases,1);assert.equal(result.fullSourceChecksumVerified,true);assert.equal(result.releaseHandbackVerified,false);
});
test('nonempty source proof or wrong finalizer result cannot phase or finish the lease',async()=>{
 const changed=fixture({checksum:'>fcs....... changed\n'});await assert.rejects(driveCleanup(changed.ports),/empty/);assert.equal(changed.commits,0);assert.equal(changed.phases,0);changed.ports.channel.stdin.end();changed.ports.channel.stdout.end();
 const wrong=fixture({badResult:true});await assert.rejects(driveCleanup(wrong.ports),/identity/);assert.equal(wrong.phases,0);
});
test('server channel EOF and observation timeout remain uncertain and do not synthesize a result',async()=>{
 const eof=new PassThrough(),waiting=waitCleanupMessage(eof);eof.end();await assert.rejects(waiting,/without a result/);
 await assert.rejects(waitCleanupMessage(new PassThrough(),{timeout:5}),/reconcile/);
});
