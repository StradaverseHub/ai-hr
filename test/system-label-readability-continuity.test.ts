import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {SYSTEM_LABEL_FIXTURE_SOURCE_PATHS} from '../scripts/system-label-fixture-contract.mjs';
import {readLabelsContinuityArtifacts} from '../scripts/system-label-source-continuity.mjs';
import {LABELS_V1_RECEIPT,LABELS_READABILITY_PATCH,validateLabelsReadabilityEvidence,labelsReadabilityReceipt} from '../scripts/system-label-readability-continuity.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const git=(args:string[])=>execFileSync('git',['-C',root,...args],{maxBuffer:16000000});
// The first commit on main whose fingerprinted files are byte-identical to 3419fa0b2, which exists only
// on the unmerged codex/board18-label-readability branch. A pin must be reachable from main, or a fresh clone cannot run it.
const corrected='b2b482edfd1a5e8a22eace1132de35581602690a';
// Exact reviewed metadata-only v1 receipt: source/manifest/artifact hashes, no credentials or business rows.
const v1Bytes=readFileSync(new URL('./fixtures/system-label-continuity-v1.json',import.meta.url));
const v1=JSON.parse(v1Bytes.toString());
const proof=(paths:{path:string;sha256:string}[])=>({format:1,paths,sha256:hash(JSON.stringify(paths))});
const gitProof=(candidate:string)=>proof(SYSTEM_LABEL_FIXTURE_SOURCE_PATHS.map(relative=>({path:relative,sha256:hash(git(['show',candidate+':'+relative]))})));
function evidence(){
 const relative=LABELS_READABILITY_PATCH.path,old=git(['show',v1.candidate+':'+relative]),current=git(['show',corrected+':'+relative]);
 const patch=git(['diff','--no-ext-diff','--no-textconv','--binary','--full-index',v1.candidate,corrected,'--',relative]).toString();
 return {v1Bytes,originalGitProof:gitProof(v1.preparationCandidate),previousGitProof:gitProof(v1.candidate),currentProof:gitProof(corrected),currentGitProof:gitProof(corrected),manifests:structuredClone(v1.manifests),artifacts:structuredClone(v1.artifacts),change:{path:relative,oldBlob:git(['rev-parse',v1.candidate+':'+relative]).toString().trim(),newBlob:git(['rev-parse',corrected+':'+relative]).toString().trim(),oldSha256:hash(old),newSha256:hash(current),patchSha256:hash(patch),patch}};
}
function receipt(){
 const value={candidate:corrected,...validateLabelsReadabilityEvidence(evidence()),applicationAcceptance:'UNVERIFIED'};
 const resumeRecords={v1:{candidate:v1.candidate,labelsSourceContinuity:{fileName:LABELS_V1_RECEIPT.fileName,sha256:LABELS_V1_RECEIPT.sha256}}};
 const priorProofs={v1:value.previousProof};
 return {value,resumeRecords,priorProofs};
}
describe('closed Labels readability source transition',()=>{
 it('binds exact immutable v1 bytes and real original/v1/v2 Git proofs to the single reviewed patch',()=>{
  expect(v1Bytes.length).toBe(LABELS_V1_RECEIPT.bytes);expect(hash(v1Bytes)).toBe(LABELS_V1_RECEIPT.sha256);
  const input=evidence();expect(input.change).toMatchObject(LABELS_READABILITY_PATCH);
  expect(validateLabelsReadabilityEvidence(input)).toMatchObject({currentProof:input.currentProof,previousContinuity:LABELS_V1_RECEIPT});
 });
 it('refuses any changed v1 receipt, original manifest, artifact inventory or prior Git proof',()=>{
  for(const mode of ['v1 bytes','manifest','artifact','original Git','v1 Git']){
   const input=evidence();
   if(mode==='v1 bytes')input.v1Bytes=Buffer.from(v1Bytes.toString()+' ');
   if(mode==='manifest')input.manifests[0].sha256='f'.repeat(64);
   if(mode==='artifact')input.artifacts[0].sha256='f'.repeat(64);
   if(mode==='original Git')input.originalGitProof=input.currentProof;
   if(mode==='v1 Git')input.previousGitProof=input.currentProof;
   expect(()=>validateLabelsReadabilityEvidence(input),mode).toThrow();
  }
 });
 it('refuses arbitrary third-path changes, allowed-path changes, current/Git drift and downgrades',()=>{
  for(const mode of ['third path','grid bytes','Git drift','v1 downgrade','original downgrade']){
   const input=evidence();
   if(mode==='third path')input.currentProof.paths.find(row=>row.path==='core/system-labels.ts')!.sha256='f'.repeat(64);
   if(mode==='grid bytes')input.currentProof.paths.find(row=>row.path===LABELS_READABILITY_PATCH.path)!.sha256='f'.repeat(64);
   if(mode==='v1 downgrade')input.currentProof=input.previousGitProof;
   if(mode==='original downgrade')input.currentProof=input.originalGitProof;
   input.currentProof=proof(input.currentProof.paths);
   input.currentGitProof=mode==='Git drift'?input.previousGitProof:structuredClone(input.currentProof);
   expect(()=>validateLabelsReadabilityEvidence(input),mode).toThrow();
  }
 });
 it('refuses altered patch bytes or blob identities',()=>{
  for(const mode of ['patch','blob']){
   const input=evidence();if(mode==='patch')input.change.patch+='\n';else input.change.newBlob='f'.repeat(40);
   expect(()=>validateLabelsReadabilityEvidence(input)).toThrow();
  }
 });
 it('creates v2 without rewriting v1 and reuses its exact bytes on unchanged corrected resumes',()=>{
  const input=receipt(),first=labelsReadabilityReceipt({...input,previous:undefined});
  expect(first.create).toBe(true);expect(first.reference.fileName).not.toBe(LABELS_V1_RECEIPT.fileName);
  const previous=Buffer.from(JSON.stringify(input.value,null,2)+'\n');
  const resumeRecords={...input.resumeRecords,v2:{candidate:corrected,labelsSourceContinuity:first.reference,priorStoppedReceipt:{resumeReceipt:'v1'}}};
  const priorProofs={...input.priorProofs,v2:input.value.currentProof};
  expect(labelsReadabilityReceipt({...input,previous,resumeRecords,priorProofs})).toMatchObject({create:false,reference:first.reference});
  expect(()=>labelsReadabilityReceipt({...input,previous:undefined,resumeRecords,priorProofs})).toThrow();
  expect(()=>labelsReadabilityReceipt({...input,previous:Buffer.from(previous.toString()+' '),resumeRecords,priorProofs})).toThrow();
  expect(()=>labelsReadabilityReceipt({...input,previous,resumeRecords:{...resumeRecords,v2:{...resumeRecords.v2,labelsSourceContinuity:input.resumeRecords.v1.labelsSourceContinuity}},priorProofs})).toThrow();
  expect(()=>labelsReadabilityReceipt({...input,previous,resumeRecords:{...resumeRecords,v1:{...resumeRecords.v1,priorStoppedReceipt:{resumeReceipt:'v2'}}},priorProofs})).toThrow();
  expect(()=>labelsReadabilityReceipt({...input,previous,resumeRecords:{},priorProofs:{}})).toThrow();
 });
 it('detects actual same-length artifact edits without changing the original inventory or files',async()=>{
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),'labels-v2-artifacts-')));
  try{
   const files=Array.from({length:13},(_,index)=>({fileName:`control-${index}.xlsx`,bytes:4,sha256:hash('safe')}));
   for(const file of files)await writeFile(path.join(directory,file.fileName),'safe',{mode:0o600});
   expect(await readLabelsContinuityArtifacts(directory,files)).toEqual(files);
   await writeFile(path.join(directory,files[0].fileName),'edit');await expect(readLabelsContinuityArtifacts(directory,files)).rejects.toThrow();
  }finally{await rm(directory,{recursive:true,force:true});}
 });
});
