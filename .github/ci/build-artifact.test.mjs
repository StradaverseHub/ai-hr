/** Private byte/refusal probes only; no application build, DB, compiler or deployment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,realpathSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {inspectCiBuildPacket,bindCiBuildSource,BUILD_ARTIFACT,BUILD_ARCHIVE_MAX,BUILD_ZIP_MAX} from './build-artifact.mjs';
import {BUILD_CAPACITY_PROFILE} from './build-production.mjs';
import {buildPacketFixture,fixtureHash} from './build-artifact-test-fixture.mjs';
import {requiredEvidence} from './manifest.mjs';
import {validateArtifacts} from './release-policy.mjs';
function fixture(){
 const f=buildPacketFixture(),directory=realpathSync(mkdtempSync(join(tmpdir(),'aihr-ci-build-packet-')));
 for(const [name,data]of Object.entries(f.entries)){mkdirSync(dirname(join(directory,name)),{recursive:true,mode:0o700});writeFileSync(join(directory,name),data,{mode:0o600});}
 return {...f,directory,close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('matching packet binds authentic identity/digests; canonical source is separately required and no installation is claimed',()=>{
 const f=fixture();
 try{
  const packet=inspectCiBuildPacket(f.directory,f.expected);
  assert.equal(packet.format,2);assert.deepEqual(packet.capacityProfile,BUILD_CAPACITY_PROFILE);
  assert.equal(packet.releaseAuthorized,false);assert.equal(packet.activeServiceVerified,false);assert.equal(packet.archiveMembersVerified,false);
  assert.equal(packet.canonicalCandidateInputsVerified,undefined);
  assert.equal(bindCiBuildSource(packet,f.source).canonicalCandidateInputsVerified,true);
  for(const key of ['lockBytes','packageBytes','preparedBytes'])assert.throws(()=>bindCiBuildSource(packet,{...f.source,[key]:Buffer.from('changed')}),/canonical preparation differ/);
  assert.throws(()=>bindCiBuildSource(packet,{}),/inputs missing/);
 }finally{f.close();}
});
test('foreign/relabelled diagnostic/PR/rerun/runtime/authority/source provenance refuses even with an intact archive',()=>{
 const changes={kind:'diagnostic-system-testing-build-not-release',source:'b'.repeat(40),controller:'d'.repeat(40),runId:124,runAttempt:2,repositoryId:9,
  workflowRef:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/pull/2/merge',releaseAuthorized:true,
  runtime:{...buildPacketFixture().provenance.runtime,node:'22.0.0'},buildRecordId:'bad',buildSourcePath:'/source/../elsewhere'};
 for(const [key,value]of Object.entries(changes)){
  const f=fixture();try{writeFileSync(join(f.directory,'build-provenance.json'),JSON.stringify({...f.provenance,[key]:value}));assert.throws(()=>inspectCiBuildPacket(f.directory,f.expected),undefined,key);}finally{f.close();}
 }
});
test('tampered record, observation, manifest and actual binary bytes all refuse',()=>{
 for(const name of ['system-testing.json','successful-build.json','bytes/build-bundle-files.json','bytes/build-bundle.tar.gz']){
  const f=fixture();try{writeFileSync(join(f.directory,name),Buffer.from('tampered'));assert.throws(()=>inspectCiBuildPacket(f.directory,f.expected),undefined,name);}finally{f.close();}
 }
});
test('foreign job times, symlinks, extra payloads and missing members refuse',()=>{
 const f=fixture();try{
  assert.throws(()=>inspectCiBuildPacket(f.directory,{...f.expected,producerCompletedAt:'2020-01-01'}));
  assert.throws(()=>inspectCiBuildPacket(f.directory,{...f.expected,controllerBranch:'feature'}));
  writeFileSync(join(f.directory,'extra.sh'),'exit 0');assert.throws(()=>inspectCiBuildPacket(f.directory,f.expected),/inventory/);rmSync(join(f.directory,'extra.sh'));
  const path=join(f.directory,'bytes/build-bundle.tar.gz'),bytes=readFileSync(path);rmSync(path);writeFileSync(join(f.directory,'foreign'),bytes);symlinkSync('../foreign',path);
  assert.throws(()=>inspectCiBuildPacket(f.directory,f.expected));rmSync(path);rmSync(join(f.directory,'foreign'));
  assert.throws(()=>inspectCiBuildPacket(f.directory,f.expected),/inventory/);
 }finally{f.close();}
});
test('v4 requires the build artifact; only that namespace has the binary bound and it never replaces a unit',()=>{
 // Use the actual deterministic manifest builder, not a caller-defined artifact list.
 return import('./manifest.mjs').then(({buildUnits})=>{
  const suite=['test/db.test.ts','test/plain.test.ts'],plan={suite,units:buildUnits(suite,{db:[suite[0]],nodb:[suite[1]]},['test/ui.browser.test.tsx'])};
  const p={runId:123,controller:'c'.repeat(40),controllerBranch:'main'};
  const artifacts=requiredEvidence(plan).artifacts.map((name,n)=>({id:n+1,name,size_in_bytes:name===BUILD_ARTIFACT?BUILD_ZIP_MAX:2,digest:'sha256:'+'a'.repeat(64),expired:false,
   workflow_run:{id:123,repository_id:1333414856,head_repository_id:1333414856,head_sha:p.controller,head_branch:'main'}}));
  assert.equal(validateArtifacts(artifacts,p,plan),true);
  assert.throws(()=>validateArtifacts(artifacts.filter(a=>a.name!==BUILD_ARTIFACT),p,plan));
  assert.throws(()=>validateArtifacts(artifacts.filter(a=>!a.name.startsWith('unit-db-')),p,plan));
  for(const name of ['gate-plan',BUILD_ARTIFACT]){
   const a=structuredClone(artifacts);a.find(x=>x.name===name).size_in_bytes=name===BUILD_ARTIFACT?BUILD_ZIP_MAX+1:64*1024**2+1;assert.throws(()=>validateArtifacts(a,p,plan));
  }
 });
});


test('only current manifest and provenance format/profile admit even when record hashes are freshly bound',()=>{
 const changes=[v=>v.format=1,v=>delete v.capacityProfile,v=>v.capacityProfile.profileVersion=1,
  v=>v.capacityProfile.archiveMaxBytes=268435456,v=>v.capacityProfile.zipMaxBytes++,v=>v.capacityProfile.extra=true];
 for(const owner of ['manifest','provenance'])for(const mutate of changes){
  const f=fixture();try{
   const path=join(f.directory,'bytes/build-bundle-files.json'),provenance=structuredClone(f.provenance);
   if(owner==='manifest'){
    const value=JSON.parse(readFileSync(path));mutate(value);const bytes=Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,bytes);provenance.manifestSha256=fixtureHash(bytes);
   }else mutate(provenance);
   writeFileSync(join(f.directory,'build-provenance.json'),JSON.stringify(provenance)+'\n');
   assert.throws(()=>inspectCiBuildPacket(f.directory,f.expected),undefined,owner);
  }finally{f.close();}
 }
});
test('archive capacity is264MiB while outer ZIP remains280MiB; oversized actual archive refuses',()=>{
 assert.equal(BUILD_ARCHIVE_MAX,276824064);assert.equal(BUILD_ZIP_MAX,293601280);
 const f=fixture();try{
  truncateSync(join(f.directory,'bytes/build-bundle.tar.gz'),BUILD_ARCHIVE_MAX+1);
  assert.throws(()=>inspectCiBuildPacket(f.directory,f.expected),/oversized packet member/);
 }finally{f.close();}
});
