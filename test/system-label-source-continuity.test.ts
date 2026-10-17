import {mkdtemp,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {SYSTEM_LABEL_FIXTURE_SOURCE_PATHS} from '../scripts/system-label-fixture-contract.mjs';
import {LABELS_REVIEWED_PREPARATION,validateLabelsTransitionEvidence,labelsContinuityReceipt,readLabelsContinuityArtifacts} from '../scripts/system-label-source-continuity.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const git=(args:string[])=>execFileSync('git',['-C',root,...args]);
const old=LABELS_REVIEWED_PREPARATION.candidate;
const corrected='4ab1f0c1175992a0c4725cd1165f774dc7938238';
const proof=(paths:{path:string;sha256:string}[])=>({format:1,paths,sha256:hash(JSON.stringify(paths))});
const gitProof=(candidate:string)=>proof(SYSTEM_LABEL_FIXTURE_SOURCE_PATHS.map(relative=>({path:relative,sha256:hash(git(['show',candidate+':'+relative]))})));
const artifacts=[
 ['blank-current-template.xlsx',111984,'224006d4185a9ddcdee9c7c68a28b68e748b166f3adad9a77676bb212f3905ab'],
 ['valid-main-new.xlsx',19902,'4dbf2e1061395506005d4ea52b992fa14eb5c61d9107dbbdde26d0fd3d99e6a7'],
 ['valid-multi-new.xlsx',18892,'92885892bb62cff34aec75dc26702ef616047f8f09b496aa15dd685b036ba0f4'],
 ['global-group-only.xlsx',19904,'51ea1a9fcdc11b59ecf7dfc257d29c12de6eb289f36ea87a5632af5c18fe2e5f'],
 ['empty-company-criteria.xlsx',19901,'523fc41b31c3d94276be8c47634fee679aa7d885a56959dce908901db5862569'],
 ['unauthorized-hidden-company.xlsx',19946,'6cec69e727436f1f71cca55057fd8e9a0603268e2642fa3216defa8200a0f354'],
 ['foreign-company.xlsx',19908,'38e86a6053297deb26d29d779d8686df6a82e4b95dcf18ec252fb21fb436ba59'],
 ['existing-code-global-collision.xlsx',19903,'d5502c4a46e30ed4adb7a7fcd290adb5ed190ac62e56641e63eedc9420d8e5e0'],
 ['conflicting-duplicate-rows.xlsx',19947,'b6e2c4ba94e7249536826bec4c104559dd828bd5a01fd296bc4dad508dba9f29'],
 ['optional-clear-update.xlsx',19871,'fc7d0154bd1348cf1977c96ffc6203950277ed8716be0e031086574cf4232232'],
 ['group-current-before-ui.xlsx',52573,'40a0138f61b66c11a9a9343080f16cd88628ecaf8e07bf5e7ebf4f1dd2606911'],
 ['scoped-current-before-ui.xlsx',52352,'77aa5a6c6946d5fe4ca472599f0a61472ebc52ccfdfefe3abb1ad4b197dc55fe'],
 ['unsupported-label-upload.csv',259,'b5098274789f8766e716abf0d2e5aa718a6e1c94d99f04db7c8b5be9bb86953d'],
].map(([fileName,bytes,sha256])=>({fileName,bytes,sha256}));
function evidence(){
 const preparationProof=gitProof(old),currentProof=gitProof(corrected);
 const changes:{path:string;oldBlob:string;newBlob:string;oldSha256:string;newSha256:string;patchSha256:string;patch:string}[]=LABELS_REVIEWED_PREPARATION.changes.map(change=>({...change,patch:git(['diff','--no-ext-diff','--no-textconv','--binary','--full-index',old,corrected,'--',change.path]).toString()}));
 const manifests=LABELS_REVIEWED_PREPARATION.manifests.map(row=>({fileName:String(row.fileName),bytes:Number(row.bytes),sha256:String(row.sha256)}));
 return {preparationProof,currentProof,oldGitProof:structuredClone(preparationProof),currentGitProof:structuredClone(currentProof),manifests,artifacts:structuredClone(artifacts),changes};
}
describe('reviewed Labels source continuity',()=>{
 it('accepts only the two actual reviewed Git patches without pinning a future candidate SHA',()=>{
  const input=evidence();expect(validateLabelsTransitionEvidence(input)).toMatchObject({currentProof:input.currentProof,changes:input.changes});
 });
 it('refuses an arbitrary third fingerprinted path even with a recomputed honest digest',()=>{
  const input=evidence();input.currentProof.paths.find(row=>row.path==='core/system-labels.ts')!.sha256='f'.repeat(64);
  input.currentProof=proof(input.currentProof.paths);input.currentGitProof=structuredClone(input.currentProof);
  expect(()=>validateLabelsTransitionEvidence(input)).toThrow(/continuity/);
 });
 it('refuses arbitrary new bytes on an allowed path, partial fixes, reordered paths and source/Git drift',()=>{
  for(const mode of ['new bytes','partial','reorder','git']){
   const input=evidence();
   if(mode==='new bytes')input.currentProof.paths.find(row=>row.path===input.changes[0].path)!.sha256='f'.repeat(64);
   if(mode==='partial')input.currentProof.paths.find(row=>row.path===input.changes[0].path)!.sha256=input.changes[0].oldSha256;
   if(mode==='reorder')input.currentProof.paths.reverse();
   if(mode==='git')input.currentGitProof=structuredClone(input.preparationProof);
   else{input.currentProof=proof(input.currentProof.paths);input.currentGitProof=structuredClone(input.currentProof);}
   expect(()=>validateLabelsTransitionEvidence(input),mode).toThrow(/continuity/);
  }
 });
 it('refuses changed manifests, original artifact inventories, blob identities and exact patch bytes',()=>{
  for(const mode of ['manifest','artifact','blob','patch']){
   const input=evidence();
   if(mode==='manifest')input.manifests[0].sha256='f'.repeat(64);
   if(mode==='artifact')input.artifacts[0].sha256='f'.repeat(64);
   if(mode==='blob')input.changes[0].newBlob='f'.repeat(40);
   if(mode==='patch')input.changes[0].patch+='\n';
   expect(()=>validateLabelsTransitionEvidence(input),mode).toThrow(/continuity/);
  }
 });
 it('reuses one byte-exact receipt for subsequent unchanged corrected resumes and rejects receipt drift/orphans',()=>{
  const value={candidate:corrected,...validateLabelsTransitionEvidence(evidence()),applicationAcceptance:'UNVERIFIED'};
  const first=labelsContinuityReceipt({value,previous:undefined,resumeRecords:{},priorProofs:{}});
  expect(first.create).toBe(true);
  const previous=Buffer.from(JSON.stringify(value,null,2)+'\n');
  const resumes={first:{candidate:corrected,labelsSourceContinuity:first.reference}},proofs={first:value.currentProof};
  expect(labelsContinuityReceipt({value,previous,resumeRecords:resumes,priorProofs:proofs})).toMatchObject({create:false,reference:first.reference});
  for(const previousBytes of [Buffer.from(previous.toString().replace('UNVERIFIED','PASS')),Buffer.from(previous.toString()+' ')])expect(()=>labelsContinuityReceipt({value,previous:previousBytes,resumeRecords:resumes,priorProofs:proofs})).toThrow();
  expect(()=>labelsContinuityReceipt({value,previous:undefined,resumeRecords:resumes,priorProofs:proofs})).toThrow();
  expect(()=>labelsContinuityReceipt({value,previous,resumeRecords:{first:{...resumes.first,labelsSourceContinuity:{...first.reference,sha256:'f'.repeat(64)}}},priorProofs:proofs})).toThrow();
  expect(()=>labelsContinuityReceipt({value,previous,resumeRecords:resumes,priorProofs:{first:value.preparationProof}})).toThrow();
 });
 it('reads actual artifact bytes and refuses same-sized edits, path traversal and symlinks',async()=>{
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),'labels-continuity-')));
  try{
   const files=Array.from({length:13},(_,index)=>({fileName:`control-${index}.xlsx`,bytes:4,sha256:hash('safe')}));
   for(const file of files)await writeFile(path.join(directory,file.fileName),'safe',{mode:0o600});
   expect(await readLabelsContinuityArtifacts(directory,files)).toEqual(files);
   await writeFile(path.join(directory,files[0].fileName),'edit');await expect(readLabelsContinuityArtifacts(directory,files)).rejects.toThrow();
   await writeFile(path.join(directory,files[0].fileName),'safe');
   await expect(readLabelsContinuityArtifacts(directory,[{...files[0],fileName:'../control.xlsx'},...files.slice(1)])).rejects.toThrow();
   await rm(path.join(directory,files[0].fileName));await symlink(path.join(directory,files[1].fileName),path.join(directory,files[0].fileName));
   await expect(readLabelsContinuityArtifacts(directory,files)).rejects.toThrow();
  }finally{await rm(directory,{recursive:true,force:true});}
 });
});
