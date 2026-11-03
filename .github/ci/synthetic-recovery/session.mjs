import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';

const [root,source,verifier,unit]=process.argv.slice(2);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const base='a'.repeat(40);
const grant={source:process.env.AIHR_STAGING_CANDIDATE,installId:'11111111-1111-4111-8111-111111111111',baselineBuildId:'old',build:{buildRecordId:'22222222-2222-4222-8222-222222222222',nextBuildId:'synthetic-recovery'}};
const bytes=JSON.stringify(grant)+'\n';
const selection={source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,authorizationSha256:hash(bytes),batch:process.env.AIHR_STAGING_BATCH,epoch:Number(process.env.AIHR_STAGING_EPOCH)};
const origin={runId:Number(process.env.GITHUB_RUN_ID),controller:base,artifactId:1,artifactDigest:'sha256:'+hash('synthetic'),witnessFingerprint:hash('fixture')};
process.env.FIXTURE_BINDING=join(root,'binding.json');
writeFileSync(process.env.FIXTURE_BINDING,JSON.stringify({selection,origin}),{flag:'wx',mode:0o600});
const {issueCleanupCertificate,createCleanupCommit,digest}=await import('./cleanup-only-recovery-policy.mjs');
const {runJournaledRecovery}=await import('./recovery-controller.mjs');
const {cleanupFrames,durableCleanupRecord}=await import('./normal-cleanup-io.mjs');
const directory=join(root,'.aihr-ci-builds',selection.installId),mirror=join(root,'mirror');
mkdirSync(directory,{recursive:true,mode:0o700});
for(const name of ['next','packet','audit','packet/bytes'])mkdirSync(join(directory,name),{mode:0o700});
mkdirSync(mirror);
writeFileSync(join(directory,'authorization.json'),bytes,{mode:0o600});
writeFileSync(join(directory,'next','BUILD_ID'),'old\n');
const records=['authorization.json','store.json','verified.json','activated.json','packet/system-testing.json','packet/successful-build.json','packet/build-provenance.json','packet/bytes/build-bundle-files.json'];
for(const name of records.slice(1))writeFileSync(join(directory,name),'synthetic\n',{mode:0o600});
const exec=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:30000});
const leaseArgs=[new URL('with-lease.py',import.meta.url).pathname,process.env.FIXTURE_QUEUE,'assert'];
const lease=()=>exec('python3',leaseArgs);
lease();
assert.throws(()=>execFileSync('python3',leaseArgs,{stdio:'pipe',env:{...process.env,AIHR_STAGING_EPOCH:String(selection.epoch+1)}}));
const rsync=['-r','--exclude=/.next/','--',source+'/',mirror+'/'];
exec('rsync',rsync);
const checksum=()=>exec('rsync',['--dry-run','--checksum','--itemize-changes',...rsync]);
const id=path=>{const s=statSync(path);return {device:s.dev,inode:s.ino};};
const active=join(source,'.next'),retained=join(directory,'next'),packet=join(directory,'packet');
const audit=()=>{
 lease();
 const actual=JSON.parse(exec(process.execPath,[new URL('verify-fixture-runtime.mjs',import.meta.url).pathname,source,verifier,unit]));
 return {...selection,pid:actual.pid,started:actual.restart,healthStatus:actual.healthStatus,fullMigrationLedgerVerified:true,migrationLedger:actual.ledger};
};
const fences=()=>{
 const runtime=audit();
 return {source:selection.source,installId:selection.installId,authorizationSha256:selection.authorizationSha256,lease:{batch:selection.batch,epoch:String(selection.epoch)},pid:runtime.pid,started:String(runtime.started),boot:hash(readFileSync('/proc/sys/kernel/random/boot_id')),environment:hash(unit),active:id(active),retained:id(retained),packet:id(packet),directory:id(directory),sourceMetadata:hash(checksum()),compiledMetadata:hash(readFileSync(join(active,'BUILD_ID'))),records:records.map(name=>[name,hash(readFileSync(join(directory,name))),Array(8).fill(1)]),ledger:runtime.migrationLedger};
};
const toolSha256=hash(readFileSync(new URL(import.meta.url)));
const runtime=audit(),snapshot=fences(),now=Date.now();
const certificate=issueCleanupCertificate({controller:base,toolSha256,humanEvidenceSha256:hash('synthetic'),reauthentication:{...origin,source:selection.source,alpha:base,main:base,metadataSha256:hash('synthetic'),verifiedAt:new Date(now).toISOString()},fences:snapshot,runtime,reconciliationSha256:hash(bytes),certificateId:hash('synthetic certificate'),now});
const input=new PassThrough(),output=new PassThrough(),frames=cleanupFrames(output);
const result=runJournaledRecovery({directory,input,output,assertLease:lease,certificate,controller:base,toolSha256,retainAudit:async()=>{},audit,fences,
 authorize:async request=>durableCleanupRecord(join(directory,'cleanup-authorized.json'),{...selection,format:1,kind:'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL',sourceDirectory:source,directory:id(directory),activeDirectory:id(active),retainedDirectory:id(retained),packetDirectory:id(packet),request}),
 removeOwned:async()=>JSON.parse(exec('python3',['-c','import importlib.util,json,sys; s=importlib.util.spec_from_file_location("engine",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.cleanup_install(sys.argv[2],sys.argv[3])))',join(process.cwd(),'.github/ci/cleanup-install.py'),directory,source])),
});
result.catch(()=>output.end());
const ready=await frames.next();
assert.throws(()=>createCleanupCommit(ready,certificate,{output:'dirty',checkedAt:new Date().toISOString()},{controller:base,toolSha256}),/checksum must be empty/);
assert(existsSync(retained)&&existsSync(packet));
input.end(JSON.stringify(createCleanupCommit(ready,certificate,{output:checksum(),checkedAt:new Date().toISOString()},{controller:base,toolSha256}))+'\n');
const receipt=await result;
output.end();
assert.equal(receipt.ownedResourceCleanupVerified,true);
assert.equal(checksum(),'');
assert.equal(readFileSync(join(directory,'authorization.json'),'utf8'),bytes);
assert(!existsSync(retained)&&!existsSync(packet));
console.log(JSON.stringify({build:selection.nextBuildId,epoch:selection.epoch,ledgerRows:receipt.runtime.migrationLedger.rows,cleanup:true,finalChecksumEmpty:true,receiptSha256:digest(receipt)}));
