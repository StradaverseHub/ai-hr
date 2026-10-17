/** One reviewed projection correction; no fixture writer, metadata override or setup repair. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {REPORT_FIXTURE_METADATA_FILES,reportFixtureDigest} from './employee-master-fixture-proof.mts';
export const REPORTS_PROJECTION_CONTINUITY_NAME='reports-source-continuity-terminated-scope-v1.json';
export const REPORTS_PROJECTION_PREPARATION='0eb9f05b913ffcd0cd2c49ac667dde9939f1cd3a';
export const REPORTS_PROJECTION_PATCH=Object.freeze({path:'core/employee-master-projection.ts',oldBlob:'331a904296d49640ae8604c1f56719cf9a178c86',newBlob:'931fc14cb063cafa0f5f086da3e34b8f6d601c96',oldSha256:'4142b2f3e5bfbcdaec4a82b12804c9cddeb325b6ce5e000f3c8f516125b31c35',newSha256:'8e8bea800dabc2ed4d7ae1ec84dbfdb36e80c78aa0203344e89d93c8908b6630',patchSha256:'4fc12394f591117e2102867b96cbcfde64b127d834f8953cd3f54fdd83fa9cf3'});
export const REPORTS_PROJECTION_ARTIFACTS=Object.freeze([
 {fileName:'fixture-manifest.json',bytes:30498,sha256:'59d9020d733882c72f30b859d38adcdd759b59920edcab4b550dcf00eb977fd2'},
 {fileName:'browser-manifest.json',bytes:32950,sha256:'49146d472f1dbd0e6cd72d0420efb47d820be52e207de5d364c52dd266e86076'},
 ...['first','second'].map(which=>({fileName:REPORTS_PROJECTION_PREPARATION+'-1792238945098-browser-fixture-'+which+'.log',bytes:30516,sha256:'2ce70c597260912bcd7aa27cf3c9ccd03c4dd2eaf47f63edbaedf299c90c81ee'})),
 {fileName:'reports-prefix-continuation-c260-v1.json',bytes:170691,sha256:'4f86e2a683a3f2e9c4c83a9d6ff154c90822b7650d0d4232e377b6393f44f410'},
]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw new Error('Unproven Reports terminated-scope source continuity; preserve setup and saved reports.');};
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
function git(root,args){return execFileSync('git',['-C',root,...args],{cwd:root,maxBuffer:16000000});}
function metadata(root,candidate){
 if(!sha(candidate)||git(root,['rev-parse',candidate+'^{commit}']).toString().trim()!==candidate)fail();
 return REPORT_FIXTURE_METADATA_FILES.map(relative=>{if(!git(root,['ls-tree',candidate,'--',relative]).toString().startsWith('100644 blob '))fail();const bytes=git(root,['show',candidate+':'+relative]);if(!bytes.length||bytes.length>4000000)fail();return {path:relative,sha256:hash(bytes)};});
}
export function readReportsProjectionGitEvidence(root,candidate){
 const preparedMetadata=metadata(root,REPORTS_PROJECTION_PREPARATION),currentMetadata=metadata(root,candidate),relative=REPORTS_PROJECTION_PATCH.path;
 const old=git(root,['show',REPORTS_PROJECTION_PREPARATION+':'+relative]),current=git(root,['show',candidate+':'+relative]);
 const patch=git(root,['diff','--no-ext-diff','--no-textconv','--binary','--full-index',REPORTS_PROJECTION_PREPARATION,candidate,'--',relative]).toString();
 return {preparedMetadata,currentMetadata,change:{path:relative,oldBlob:blob(old),newBlob:blob(current),oldSha256:hash(old),newSha256:hash(current),patchSha256:hash(patch),patch}};
}
/** Source reconstruction and SELECT-only state proof are acquired independently by the caller. */
export function validateReportsProjectionEvidence({fixtureProof,currentProof,preparedMetadata,currentMetadata,change,artifacts}){
 if(fixtureProof?.version!==1||fixtureProof.metadataDigest!=='487510deae033356f85671fc76766894eddc3b2281a7a2158d84165bbb9aa278'||fixtureProof.stateDigest!=='418b286d40cd3d99c548e3adcb24bfc4ee5cf21c49243f2a11dd9e458b4cef79'||reportFixtureDigest(fixtureProof.tables)!==fixtureProof.stateDigest||!same(fixtureProof,{...currentProof,metadataDigest:fixtureProof.metadataDigest})||!same(artifacts,REPORTS_PROJECTION_ARTIFACTS))fail();
 if(!same(preparedMetadata.map(row=>row.path),REPORT_FIXTURE_METADATA_FILES)||!same(currentMetadata.map(row=>row.path),REPORT_FIXTURE_METADATA_FILES)||reportFixtureDigest(preparedMetadata)!==fixtureProof.metadataDigest||reportFixtureDigest(currentMetadata)!==currentProof.metadataDigest)fail();
 const changed=preparedMetadata.filter((row,i)=>row.sha256!==currentMetadata[i].sha256).map(row=>row.path);
 if(!same(changed,[REPORTS_PROJECTION_PATCH.path])||!same({...change,patch:undefined},{...REPORTS_PROJECTION_PATCH,patch:undefined})||typeof change.patch!=='string'||hash(change.patch)!==REPORTS_PROJECTION_PATCH.patchSha256||preparedMetadata.find(row=>row.path===change.path)?.sha256!==change.oldSha256||currentMetadata.find(row=>row.path===change.path)?.sha256!==change.newSha256)fail();
 return {preparedMetadata,currentMetadata,preparationProof:fixtureProof,currentProof,artifacts,change};
}
/** Existing corrected history can never shed the immutable reference or revert to old source. */
export function reportsProjectionReceipt({value,previous,resumeRecords,priorMetadataDigests}){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),reference={fileName:REPORTS_PROJECTION_CONTINUITY_NAME,sha256:hash(bytes)};
 if(previous&&!previous.equals(bytes))fail();
 const ranks={};
 for(const [name,record]of Object.entries(resumeRecords)){
  const digest=priorMetadataDigests[name];
  if(digest===value.currentProof.metadataDigest){if(!previous||!same(record.reportsSourceContinuity,reference))fail();ranks[name]=1;}
  else if(digest===value.preparationProof.metadataDigest){if(record.reportsSourceContinuity!==undefined)fail();ranks[name]=0;}
  else fail();
 }
 for(const [name,record]of Object.entries(resumeRecords)){const prior=record.priorStoppedReceipt?.resumeReceipt;if(prior!==undefined&&(ranks[prior]===undefined||ranks[prior]>ranks[name]))fail();}
 return {name:REPORTS_PROJECTION_CONTINUITY_NAME,value,reference,create:!previous};
}
async function ownedBytes(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size<1||stat.size>1000000||await fs.realpath(file)!==file)fail();const bytes=await fs.readFile(file);if(stat.size!==bytes.length)fail();return bytes;}
/** Caller retains closed-port/PID/role/tenant/principal guards and writes wx after all pass. */
export async function prepareReportsProjectionContinuity({root,candidate,fixture,browser,currentProof,resumeRecords={}}){
 const out=path.join(root,'scratchpad/board18-reports');
 if(path.resolve(root)!==root||await fs.realpath(root)!==root||!sha(candidate)||fixture.root!==root||browser.root!==root||fixture.candidate!==REPORTS_PROJECTION_PREPARATION||browser.candidate!==fixture.candidate||fixture.database!=='ai_hr_board18_reports_browser'||browser.database!==fixture.database||fixture.namespace!=='board18reports'||browser.namespace!==fixture.namespace||fixture.port!==3197||browser.port!==fixture.port||git(root,['status','--porcelain']).length||git(root,['rev-parse','HEAD']).toString().trim()!==candidate)fail();
 const artifacts=[];
 for(const expected of REPORTS_PROJECTION_ARTIFACTS){const bytes=await ownedBytes(path.join(out,expected.fileName));artifacts.push({fileName:expected.fileName,bytes:bytes.length,sha256:hash(bytes)});if(expected.fileName==='fixture-manifest.json'&&!same(JSON.parse(bytes.toString()),fixture)||expected.fileName==='browser-manifest.json'&&!same(JSON.parse(bytes.toString()),browser))fail();}
 const evidence=validateReportsProjectionEvidence({fixtureProof:fixture.proof,currentProof,...readReportsProjectionGitEvidence(root,candidate),artifacts});
 let previous;try{previous=await ownedBytes(path.join(out,REPORTS_PROJECTION_CONTINUITY_NAME));}catch(error){if(error.code!=='ENOENT')throw error;}
 let recordedCandidate=candidate;
 if(previous){recordedCandidate=JSON.parse(previous.toString()).candidate;if(!same(readReportsProjectionGitEvidence(root,recordedCandidate),{preparedMetadata:evidence.preparedMetadata,currentMetadata:evidence.currentMetadata,change:evidence.change}))fail();}
 const value={format:1,kind:'reviewed-reports-terminated-scope-continuity',root,scenario:'reports',database:fixture.database,namespace:fixture.namespace,port:fixture.port,preparationCandidate:fixture.candidate,candidate:recordedCandidate,...evidence,fixtureRunsThisTransition:0,migrationRunsThisTransition:0,seedRunsThisTransition:0,applicationAcceptance:'UNVERIFIED'};
 const priorMetadataDigests=Object.fromEntries(Object.entries(resumeRecords).map(([name,record])=>[name,reportFixtureDigest(metadata(root,record.candidate))]));
 return reportsProjectionReceipt({value,previous,resumeRecords,priorMetadataDigests});
}
