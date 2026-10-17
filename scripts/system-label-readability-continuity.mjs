/** Closed second Labels acceptance transition; v1 receipt and original artifacts remain immutable. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {SYSTEM_LABEL_FIXTURE_SOURCE_PATHS} from './system-label-fixture-contract.mjs';
import {LABELS_CONTINUITY_NAME,LABELS_REVIEWED_PREPARATION,validateLabelsTransitionEvidence,readLabelsContinuityFile,readLabelsContinuityArtifacts} from './system-label-source-continuity.mjs';

export const LABELS_READABILITY_CONTINUITY_NAME='labels-source-continuity-readable-grid-v2.json';
export const LABELS_READABILITY_SOURCE_SHA256='e7a5b0240b3b598ec7e8cf3c4bb028bcb2e50f8abafc3ef00a4a590c84090ebb';
export const LABELS_V1_RECEIPT=Object.freeze({fileName:LABELS_CONTINUITY_NAME,bytes:12284,sha256:'5aa9ecb6b57e0e92efa835f30371faac1b83effe4eaec49d20b57b4e6d2fde18'});
export const LABELS_READABILITY_PATCH=Object.freeze({path:'components/system-labels-grid.tsx',oldBlob:'79c8ead19a2dc5b6716a0f377495bae2f898be55',newBlob:'bbdc6e85ddf2e93a1144d42351ffaf4b188ce698',oldSha256:'f51956f50828967ac9a0a0728c851eb01be75489a64987b7328345914c100832',newSha256:'3805797aed463f323436063ea1326b52f3be7c5a6ab3f0dc1f5ae85db5edf917',patchSha256:'7c21da92e43f837a44f110755113fc4517281a4a8464bb8fa7cf816fa64f6872'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw new Error('Unproven reviewed Labels readability continuity; preserve both prior receipts.');};
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
const proof=paths=>({format:1,paths,sha256:hash(JSON.stringify(paths))});
const validProof=value=>value?.format===1&&same(value.paths?.map(row=>row.path),SYSTEM_LABEL_FIXTURE_SOURCE_PATHS)&&same(value,proof(value.paths));
const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const v1Reference={fileName:LABELS_V1_RECEIPT.fileName,sha256:LABELS_V1_RECEIPT.sha256};

/** Pure policy: previous receipt bytes, manifests/artifacts and both Git proofs are acquired separately. */
export function validateLabelsReadabilityEvidence({v1Bytes,originalGitProof,previousGitProof,currentProof,currentGitProof,manifests,artifacts,change}){
 if(v1Bytes.length!==LABELS_V1_RECEIPT.bytes||hash(v1Bytes)!==LABELS_V1_RECEIPT.sha256)fail();
 const v1=JSON.parse(v1Bytes.toString());
 validateLabelsTransitionEvidence({...v1,oldGitProof:originalGitProof,currentGitProof:previousGitProof});
 if(!same(manifests,v1.manifests)||!same(artifacts,v1.artifacts)||!validProof(currentProof)||!same(currentProof,currentGitProof)||currentProof.sha256!==LABELS_READABILITY_SOURCE_SHA256)fail();
 const changed=v1.currentProof.paths.filter((row,index)=>row.sha256!==currentProof.paths[index].sha256).map(row=>row.path);
 if(!same(changed,[LABELS_READABILITY_PATCH.path])||!same(Object.keys(change),['path','oldBlob','newBlob','oldSha256','newSha256','patchSha256','patch'])||!same({...change,patch:undefined},{...LABELS_READABILITY_PATCH,patch:undefined})||typeof change.patch!=='string'||hash(change.patch)!==LABELS_READABILITY_PATCH.patchSha256||currentProof.paths.find(row=>row.path===change.path)?.sha256!==change.newSha256)fail();
 return {preparationProof:v1.preparationProof,previousProof:v1.currentProof,currentProof,previousContinuity:LABELS_V1_RECEIPT,manifests,artifacts,change};
}

/** A corrected resume cannot lose/change its receipt reference or move backwards through source states. */
export function labelsReadabilityReceipt({value,previous,resumeRecords,priorProofs}){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),reference={fileName:LABELS_READABILITY_CONTINUITY_NAME,sha256:hash(bytes)};
 if(previous&&!previous.equals(bytes))fail();
 const ranks={};let foundV1=false;
 for(const [name,record]of Object.entries(resumeRecords)){
  const prior=priorProofs[name];
  if(same(prior,value.currentProof)){if(!previous||!same(record.labelsSourceContinuity,reference))fail();ranks[name]=2;}
  else if(same(prior,value.previousProof)){if(!same(record.labelsSourceContinuity,v1Reference))fail();ranks[name]=1;foundV1=true;}
  else if(same(prior,value.preparationProof)){if(record.labelsSourceContinuity!==undefined)fail();ranks[name]=0;}
  else fail();
 }
 if(!foundV1)fail();
 for(const [name,record]of Object.entries(resumeRecords)){
  const previousName=record.priorStoppedReceipt?.resumeReceipt;
  if(previousName!==undefined&&(ranks[previousName]===undefined||ranks[previousName]>ranks[name]))fail();
 }
 return {name:LABELS_READABILITY_CONTINUITY_NAME,value,reference,create:!previous};
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
function gitChange(root,previousCandidate,candidate){
 const relative=LABELS_READABILITY_PATCH.path,old=git(root,['show',previousCandidate+':'+relative]),current=git(root,['show',candidate+':'+relative]);
 const patch=git(root,['diff','--no-ext-diff','--no-textconv','--binary','--full-index',previousCandidate,candidate,'--',relative]).toString();
 return {path:relative,oldBlob:blob(old),newBlob:blob(current),oldSha256:hash(old),newSha256:hash(current),patchSha256:hash(patch),patch};
}
/** Runner owns stopped/PID/port/role/identity guards and writes a new receipt only after those pass. */
export async function prepareLabelsReadabilityContinuity({root,candidate,fixture,browser,currentProof,resumeRecords={}}){
 const exactRoot=path.resolve(root),out=path.join(exactRoot,'scratchpad/board18-labels');
 if(!sha(candidate)||fixture.candidate!==LABELS_REVIEWED_PREPARATION.candidate||browser.candidate!==fixture.candidate||fixture.root!==root||browser.root!==root||await fs.realpath(exactRoot)!==exactRoot||git(exactRoot,['status','--porcelain']).length||git(exactRoot,['rev-parse','HEAD']).toString().trim()!==candidate)fail();
 const v1Bytes=await readLabelsContinuityFile(path.join(out,LABELS_CONTINUITY_NAME));
 if(v1Bytes.length!==LABELS_V1_RECEIPT.bytes||hash(v1Bytes)!==LABELS_V1_RECEIPT.sha256)fail();
 const v1=JSON.parse(v1Bytes.toString());
 if(v1.root!==root||!same(v1.preparationProof,fixture.sourceProof))fail();
 const manifests=[];
 for(const expected of LABELS_REVIEWED_PREPARATION.manifests){
  const bytes=await readLabelsContinuityFile(path.join(out,expected.fileName));
  manifests.push({fileName:expected.fileName,bytes:bytes.length,sha256:hash(bytes)});
  if(!same(JSON.parse(bytes.toString()),expected.fileName==='fixture-manifest.json'?fixture:browser))fail();
 }
 const artifacts=await readLabelsContinuityArtifacts(path.join(out,'files'),fixture.files);
 const evidence=validateLabelsReadabilityEvidence({v1Bytes,originalGitProof:gitProof(exactRoot,LABELS_REVIEWED_PREPARATION.candidate),previousGitProof:gitProof(exactRoot,v1.candidate),currentProof,currentGitProof:gitProof(exactRoot,candidate),manifests,artifacts,change:gitChange(exactRoot,v1.candidate,candidate)});
 let previous;try{previous=await readLabelsContinuityFile(path.join(out,LABELS_READABILITY_CONTINUITY_NAME));}catch(error){if(error.code!=='ENOENT')throw error;}
 let recordedCandidate=candidate;
 if(previous){recordedCandidate=JSON.parse(previous.toString()).candidate;if(!same(gitProof(exactRoot,recordedCandidate),currentProof)||!same(gitChange(exactRoot,v1.candidate,recordedCandidate),evidence.change))fail();}
 const value={format:2,kind:'reviewed-labels-readability-continuity',root,scenario:'labels',database:'ai_hr_board18_labels_browser',namespace:'board18labels',port:3198,preparationCandidate:fixture.candidate,candidate:recordedCandidate,...evidence,fixtureRunsThisTransition:0,migrationRunsThisTransition:0,seedRunsThisTransition:0,applicationAcceptance:'UNVERIFIED'};
 const priorProofs=Object.fromEntries(Object.entries(resumeRecords).map(([name,record])=>[name,gitProof(exactRoot,record.candidate)]));
 return labelsReadabilityReceipt({value,previous,resumeRecords,priorProofs});
}
