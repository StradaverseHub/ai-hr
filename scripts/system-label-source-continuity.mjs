/** One reviewed acceptance-only transition. Never changes preparation, artifacts or business rows. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {SYSTEM_LABEL_FIXTURE_SOURCE_PATHS} from './system-label-fixture-contract.mjs';

export const LABELS_CONTINUITY_NAME='labels-source-continuity-886-grid-workbook-v1.json';
export const LABELS_REVIEWED_PREPARATION=Object.freeze({
 candidate:'886aca23054f02e4ed2d7a3b3b1bbfc1b1d0b444',
 sourceSha256:'9cb9857c1bd8840435fc8bcdf2e5301918ce2498987b924621b29dd1f46795be',
 manifests:Object.freeze([
  Object.freeze({fileName:'fixture-manifest.json',bytes:15521,sha256:'438c40f044ead1337d6f8ca8270b4951277c0113893948f9fd1b5ccae5358d96'}),
  Object.freeze({fileName:'browser-manifest.json',bytes:16766,sha256:'fd46e4ac664165268d90a3b923ee6ea7bbd4144e760bec8d3853da068e55c38f'}),
 ]),
 artifactsSha256:'723f92678104a6ec98bc5a335d06be4e4b3e661ff20b44f32e2f5fc319ecb07e',
 changes:Object.freeze([
  Object.freeze({path:'components/system-labels-grid.tsx',oldBlob:'d1a3d9c851f6579c45f7849548f0107c38f87852',newBlob:'79c8ead19a2dc5b6716a0f377495bae2f898be55',oldSha256:'f75d84a567676551ce66eb7196a6454caaa9d78b120fc4b6b2815df05b536129',newSha256:'f51956f50828967ac9a0a0728c851eb01be75489a64987b7328345914c100832',patchSha256:'5084cbeaf632019d93d1213d8952b6f9fd7e61d582e1aef341625b663f50657f'}),
  Object.freeze({path:'lib/system-label-workbook.ts',oldBlob:'eadd9958f2d2a176e2320641b93c261c7d637e6f',newBlob:'db9453889558ba724329e3499409c58505774ee6',oldSha256:'fc3b207dd502c7a197798175c27198d02257c283cb103cfbfab3389423f5b256',newSha256:'e25226b4da3bb26298c8e6c951edc09c6027bba30071f52f1b86ed379a9115b5',patchSha256:'c50a2d69238d752c5686d136d10132862bfaba35738507d2fb97f0a3fb12534c'}),
 ]),
});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
const fail=()=>{throw new Error('Unproven reviewed Labels source continuity; preserve original journey.');};
const proof=paths=>({format:1,paths,sha256:hash(JSON.stringify(paths))});
const validProof=value=>value?.format===1&&same(value.paths?.map(row=>row.path),SYSTEM_LABEL_FIXTURE_SOURCE_PATHS)&&value.paths.every(row=>same(Object.keys(row),['path','sha256'])&&/^[0-9a-f]{64}$/.test(row.sha256))&&same(value,proof(value.paths));
const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');

/** Pure fail-closed policy over independently acquired bytes/Git evidence; no caller-supplied policy. */
export function validateLabelsTransitionEvidence(evidence){
 const {preparationProof,currentProof,oldGitProof,currentGitProof,manifests,artifacts,changes}=evidence;
 if(!validProof(preparationProof)||!validProof(currentProof)||!same(preparationProof,oldGitProof)||!same(currentProof,currentGitProof)||preparationProof.sha256!==LABELS_REVIEWED_PREPARATION.sourceSha256||!same(manifests,LABELS_REVIEWED_PREPARATION.manifests)||!Array.isArray(artifacts)||artifacts.length!==13||hash(JSON.stringify(artifacts))!==LABELS_REVIEWED_PREPARATION.artifactsSha256||!Array.isArray(changes)||changes.length!==2)fail();
 const changed=preparationProof.paths.filter((row,index)=>row.sha256!==currentProof.paths[index].sha256).map(row=>row.path);
 if(!same([...changed].sort(),LABELS_REVIEWED_PREPARATION.changes.map(row=>row.path).sort()))fail();
 for(let index=0;index<changes.length;index++){
  const actual=changes[index],expected=LABELS_REVIEWED_PREPARATION.changes[index];
  if(!same(Object.keys(actual),['path','oldBlob','newBlob','oldSha256','newSha256','patchSha256','patch'])||!same({...actual,patch:undefined},{...expected,patch:undefined})||typeof actual.patch!=='string'||hash(actual.patch)!==expected.patchSha256||preparationProof.paths.find(row=>row.path===expected.path)?.sha256!==expected.oldSha256||currentProof.paths.find(row=>row.path===expected.path)?.sha256!==expected.newSha256)fail();
 }
 return {preparationProof,currentProof,manifests,artifacts,changes};
}

/** Owned ordinary files only, including every ancestor; never follows an artifact/receipt symlink. */
export async function readLabelsContinuityFile(file,limit=1000000){
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size<1||stat.size>limit||await fs.realpath(file)!==file)fail();
 const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail();return bytes;
}
/** Exact declared artifact bytes, deliberately excluding mutable labels or later UI downloads. */
export async function readLabelsContinuityArtifacts(directory,files){
 if(!Array.isArray(files)||files.length!==13)fail();
 const result=[];
 for(const file of files){
  if(!/^[a-z0-9-]+\.(xlsx|csv)$/.test(file.fileName))fail();
  const bytes=await readLabelsContinuityFile(path.join(directory,file.fileName),750000);
  const actual={fileName:file.fileName,bytes:bytes.length,sha256:hash(bytes)};
  if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)fail();result.push(actual);
 }
 return result;
}
function git(root,args){return execFileSync('git',['-C',root,...args],{cwd:root,maxBuffer:16000000});}
function gitProof(root,candidate){
 if(!sha(candidate)||git(root,['rev-parse',candidate+'^{commit}']).toString().trim()!==candidate)fail();
 return proof(SYSTEM_LABEL_FIXTURE_SOURCE_PATHS.map(relative=>{
  if(!git(root,['ls-tree',candidate,'--',relative]).toString().startsWith('100644 blob '))fail();
  const bytes=git(root,['show',candidate+':'+relative]);if(!bytes.length||bytes.length>4000000)fail();
  return {path:relative,sha256:hash(bytes)};
 }));
}
function gitChanges(root,candidate){
 return LABELS_REVIEWED_PREPARATION.changes.map(expected=>{
  const old=git(root,['show',LABELS_REVIEWED_PREPARATION.candidate+':'+expected.path]);
  const current=git(root,['show',candidate+':'+expected.path]);
  const patch=git(root,['diff','--no-ext-diff','--no-textconv','--binary','--full-index',LABELS_REVIEWED_PREPARATION.candidate,candidate,'--',expected.path]).toString();
  return {path:expected.path,oldBlob:blob(old),newBlob:blob(current),oldSha256:hash(old),newSha256:hash(current),patchSha256:hash(patch),patch};
 });
}
/** Reuse is byte-exact and every prior corrected resume must reference this same immutable receipt. */
export function labelsContinuityReceipt({value,previous,resumeRecords,priorProofs}){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),reference={fileName:LABELS_CONTINUITY_NAME,sha256:hash(bytes)};
 if(previous&&!previous.equals(bytes))fail();
 for(const [name,record] of Object.entries(resumeRecords)){
  const priorProof=priorProofs[name];
  if(same(priorProof,value.currentProof)){if(!previous||!same(record.labelsSourceContinuity,reference))fail();}
  else if(!same(priorProof,value.preparationProof)||record.labelsSourceContinuity!==undefined)fail();
 }
 return {name:LABELS_CONTINUITY_NAME,value,reference,create:!previous};
}
/** Prepares but does not write a receipt. Runner persists it only after its unchanged identity checks.
 * Existing stopped/PID/port/role/tenant/resume-chain checks remain the runner's responsibility.
 */
export async function prepareLabelsSourceContinuity({root,candidate,fixture,browser,currentProof,resumeRecords={}}){
 const exactRoot=path.resolve(root),out=path.join(exactRoot,'scratchpad/board18-labels');
 if(!sha(candidate)||fixture.candidate!==LABELS_REVIEWED_PREPARATION.candidate||browser.candidate!==fixture.candidate||fixture.root!==root||browser.root!==root||await fs.realpath(exactRoot)!==exactRoot||git(exactRoot,['status','--porcelain']).length||git(exactRoot,['rev-parse','HEAD']).toString().trim()!==candidate)fail();
 const manifests=[];
 for(const expected of LABELS_REVIEWED_PREPARATION.manifests){
  const bytes=await readLabelsContinuityFile(path.join(out,expected.fileName));
  manifests.push({fileName:expected.fileName,bytes:bytes.length,sha256:hash(bytes)});
  if(!same(JSON.parse(bytes.toString()),expected.fileName==='fixture-manifest.json'?fixture:browser))fail();
 }
 const artifacts=await readLabelsContinuityArtifacts(path.join(out,'files'),fixture.files);
 const evidence=validateLabelsTransitionEvidence({preparationProof:fixture.sourceProof,currentProof,oldGitProof:gitProof(exactRoot,LABELS_REVIEWED_PREPARATION.candidate),currentGitProof:gitProof(exactRoot,candidate),manifests,artifacts,changes:gitChanges(exactRoot,candidate)});
 const receiptPath=path.join(out,LABELS_CONTINUITY_NAME);
 let previous;
 try{previous=await readLabelsContinuityFile(receiptPath);}catch(error){if(error.code!=='ENOENT')throw error;}
 let recordedCandidate=candidate;
 if(previous){
  recordedCandidate=JSON.parse(previous.toString()).candidate;
  if(!same(gitProof(exactRoot,recordedCandidate),currentProof)||!same(gitChanges(exactRoot,recordedCandidate),evidence.changes))fail();
 }
 const value={format:1,kind:'reviewed-labels-source-continuity',root,scenario:'labels',database:'ai_hr_board18_labels_browser',namespace:'board18labels',port:3198,preparationCandidate:LABELS_REVIEWED_PREPARATION.candidate,candidate:recordedCandidate,...evidence,fixtureRunsThisTransition:0,migrationRunsThisTransition:0,seedRunsThisTransition:0,applicationAcceptance:'UNVERIFIED'};
 const priorProofs=Object.fromEntries(Object.entries(resumeRecords).map(([name,record])=>[name,gitProof(exactRoot,record.candidate)]));
 return labelsContinuityReceipt({value,previous,resumeRecords,priorProofs});
}
