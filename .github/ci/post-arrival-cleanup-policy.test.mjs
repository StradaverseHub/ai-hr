import assert from 'node:assert/strict';
import test from 'node:test';
import {installJson} from './ci-install-grant.mjs';
import {CLEANUP_SELECTION as selection,digest,createCleanupPreparation,validateCleanupCommit,validateCleanupExecutionApproval,historicalCleanupSelection,stableCleanupLedger} from './post-arrival-cleanup-policy.mjs';

const at=Date.parse('2026-10-30T16:00:00Z'),controller='a'.repeat(40),approvalSha256='b'.repeat(64),toolSha256='c'.repeat(64);
const fences={source:selection.source,batch:selection.batch,epoch:7,pid:'1116406',bootIdSha256:'d'.repeat(64),environmentSha256:'e'.repeat(64),ledgerSha256:'f'.repeat(64),
 sourceStatSha256:'a'.repeat(64),compiledStatSha256:'b'.repeat(64),originalRecordsSha256:'c'.repeat(64),nextBuildId:selection.nextBuildId,
 activeDirectory:{device:64512,inode:42},retainedDirectory:{device:64512,inode:5898289},packetDirectory:{device:64512,inode:5898285}};
const runtime={...selection,healthStatus:200,fullMigrationLedgerVerified:true};
test('ledger observation timestamps do not create false drift; actual row identity still does',()=>{
 const ledger={kind:'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE',rows:581,expectedSha256:'1'.repeat(64),actualSha256:'2'.repeat(64),releaseAuthorized:false,verifiedAt:'2026-10-30T16:00:00Z'};
 assert.deepEqual(stableCleanupLedger(ledger),stableCleanupLedger({...ledger,verifiedAt:'2026-10-30T16:00:10Z'}));
 assert.notDeepEqual(stableCleanupLedger(ledger),stableCleanupLedger({...ledger,actualSha256:'3'.repeat(64)}));
 assert.throws(()=>stableCleanupLedger({...ledger,rows:580}));
});
function fixture(now=at){
 const preparation=createCleanupPreparation({nonce:'1'.repeat(64),fences,runtime,approvalSha256,toolSha256,now});
 const request={format:1,kind:'COMMIT_SINGLE_POST_ARRIVAL_OWNED_CLEANUP',selection,nonce:preparation.nonce,preparationSha256:digest(installJson(preparation)),approvalSha256,toolSha256,
  checksumCheckedAt:new Date(now+50000).toISOString(),checksumOutputSha256:digest('')};
 return {preparation,request};
}
test('long preparation finishes before a newly observed checksum; no age exception',()=>{
 const {preparation,request}=fixture(at+240000);
 assert.equal(validateCleanupCommit(request,preparation,{fences,approvalSha256,toolSha256,now:at+295000}),request);
 assert.throws(()=>validateCleanupCommit(request,preparation,{fences,approvalSha256,toolSha256,now:at+350001}),/60 seconds/);
});
test('checksum from before preparation and future observations refuse',()=>{
 for(const time of [at-1,at+55001]){
  const {preparation,request}=fixture();request.checksumCheckedAt=new Date(time).toISOString();
  assert.throws(()=>validateCleanupCommit(request,preparation,{fences,approvalSha256,toolSha256,now:at+55000}),/60 seconds/);
 }
});
test('each challenge, authority and source-proof substitution refuses',()=>{
 const changes={kind:'INSTALL',nonce:'2'.repeat(64),preparationSha256:'0'.repeat(64),approvalSha256:'0'.repeat(64),toolSha256:'0'.repeat(64),checksumOutputSha256:digest('changed')};
 for(const [key,value]of Object.entries(changes)){
  const {preparation,request}=fixture();request[key]=value;
  assert.throws(()=>validateCleanupCommit(request,preparation,{fences,approvalSha256,toolSha256,now:at+55000}),key);
 }
 const {preparation,request}=fixture();request.selection={...selection,installId:'00000000-0000-4000-8000-000000000000'};
 assert.throws(()=>validateCleanupCommit(request,preparation,{fences,approvalSha256,toolSha256,now:at+55000}));
});
test('active inode, PID, boot, environment, ledger, source and lease drift refuse',()=>{
 for(const [key,value]of Object.entries(fences)){
  const {preparation,request}=fixture();const changed={...fences,[key]:typeof value==='object'?{...value,inode:99}:typeof value==='number'?value+1:'changed'};
  assert.throws(()=>validateCleanupCommit(request,preparation,{fences:changed,approvalSha256,toolSha256,now:at+55000}),key);
 }
});
test('expired preparation and unknown request keys refuse',()=>{
 const {preparation,request}=fixture();
 assert.throws(()=>validateCleanupCommit(request,preparation,{fences,approvalSha256,toolSha256,now:at+180001}),/expired/);
 assert.throws(()=>validateCleanupCommit({...request,allowExpired:true},preparation,{fences,approvalSha256,toolSha256,now:at+55000}),/shape/);
});
test('missing or malformed fences cannot become a valid preparation',()=>{
 for(const key of Object.keys(fences)){
  const changed={...fences};delete changed[key];
  assert.throws(()=>createCleanupPreparation({nonce:'1'.repeat(64),fences:changed,runtime,approvalSha256,toolSha256,now:at}));
 }
 for(const changed of [{...fences,bootIdSha256:'unknown'},{...fences,activeDirectory:{device:0,inode:1}},{...fences,packetDirectory:fences.activeDirectory}])
  assert.throws(()=>createCleanupPreparation({nonce:'1'.repeat(64),fences:changed,runtime,approvalSha256,toolSha256,now:at}));
});
test('new cleanup-only human approval is distinct from an installation grant',()=>{
 const approval={format:1,kind:'EXPLICIT_SINGLE_POST_EXPIRY_OWNED_CLEANUP',selection,controller,toolSha256,approvedAt:new Date(at).toISOString(),expiresAt:new Date(at+900000).toISOString(),humanEvidenceSha256:'3'.repeat(64)};
 assert.equal(validateCleanupExecutionApproval(approval,{controller,now:at+1}),approval);
 for(const changed of [{...approval,kind:'OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL'},{...approval,controller:'4'.repeat(40)},{...approval,expiresAt:new Date(at+1800001).toISOString()}, {...approval,selection:{...selection,epoch:8}}])
  assert.throws(()=>validateCleanupExecutionApproval(changed,{controller,now:at+1}));
 assert.throws(()=>validateCleanupExecutionApproval(approval,{controller,now:at+900001}),/bounded/);
 assert.throws(()=>historicalCleanupSelection(Buffer.from('{}'),Buffer.from('{}'),{now:at}),/immutable/);
});
