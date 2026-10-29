/** Operator-only authenticated issuer. Emits a cleanup capability; never connects to staging or deletes. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateInstallGrant,installHash,installJson} from '../../.github/ci/ci-install-grant.mjs';
import {validateRecoveryAuthorization,publishRecoveryRecord,readPrivateRecoveryRecord} from './staging-cleanup-recovery.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:16*1024**2}).trim();
export async function issueRecoveryCapability({grant,helperSource,helperBytes,original,helper,now=()=>Date.now()}){
 // verifier functions are actual existing complete inventory/API/archive verifiers in the CLI.
 validateInstallGrant(grant,{now:now(),allowExpired:true});
 const one=await original.verify(),two=await helper.verify();
 for(const e of [one,two])assert(e.result==='PASS'&&e.tier==='ci'&&e.build.canonicalCandidateInputsVerified===true,'Complete independently reconstructed CI witness required');
 assert(one.sha===grant.source&&one.controller===grant.controller&&one.runId===grant.runId&&one.fingerprint===grant.witnessFingerprint,'Original gate identity changed');
 assert(two.sha===helperSource,'Helper gate does not cover executing source');
 // Finish expensive full reconstruction before refreshing both API witnesses in parallel.
 const checked=await Promise.all([[original,one],[helper,two]].map(async([verifier,evidence])=>{await verifier.revalidate(evidence);return new Date(now()).toISOString();}));
 const issued=now();
 const summarize=(e,createdAt,revalidatedAt)=>({result:e.result,tier:e.tier,source:e.sha,controller:e.controller,runId:e.runId,fingerprint:e.fingerprint,createdAt,revalidatedAt});
 const originalRun=original.run(one),helperRun=helper.run(two);
 const a={format:1,kind:'OWNER_AUTHORIZED_COMPLETED_INSTALL_CLEANUP_RECOVERY',policy:'aihr-owned-cleanup-recovery/v1',scope:'original-next-and-packet-only',source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,grantSha256:installHash(installJson(grant)+'\n'),helperSource,helperSha256:installHash(helperBytes),originalCi:summarize(one,originalRun.created_at,checked[0]),helperCi:summarize(two,helperRun.created_at,checked[1]),issuedAt:new Date(issued).toISOString(),expiresAt:new Date(Math.min(issued+1800000,Date.parse(originalRun.created_at)+86400000,Date.parse(helperRun.created_at)+86400000)).toISOString()};
 validateRecoveryAuthorization(a,grant,{now:issued,initial:true});
 return {authorization:a,originalEvidenceDirectory:one.evidenceDirectory,helperEvidenceDirectory:two.evidenceDirectory,releaseAuthorized:false};
}
async function cli(input){
 assert(Object.keys(input).sort().join(',')==='applicationPath,grantPath,helperControllerPath,helperPath,helperRunId,originalControllerPath,outputPath','Exact issuer input required');
 const g=JSON.parse(readPrivateRecoveryRecord(resolve(input.grantPath),32*1024));
 const helperPath=realpathSync(input.helperPath),source=git(helperPath,'rev-parse','HEAD');
 assert(git(helperPath,'status','--porcelain')==='','Frozen clean helper source required');
 const file='scripts/improve/staging-cleanup-recovery.mjs';
 const bytes=readFileSync(join(helperPath,file));
 assert(bytes.equals(execFileSync('git',['show',source+':'+file],{cwd:helperPath,maxBuffer:1024**2})),'Helper blob differs from gated commit');
 assert(git(input.applicationPath,'rev-parse','HEAD')===g.source,'Original application source moved');
 const load=async(path,candidatePath,runId,baseline,expectedController)=>{
  path=realpathSync(path);assert(git(path,'rev-parse','HEAD')===expectedController&&git(path,'status','--porcelain')==='','Expected clean verifier controller required');
  // Verifier and all its dependency bytes must come from the pinned unchanged controller.
  const module=await import(pathToFileURL(join(path,'.github/ci/release-ci.mjs')).href);
  return {verify:()=>module.verifyCi({candidatePath,runId,baseline}),revalidate:e=>module.revalidateCi(e),run:e=>JSON.parse(readFileSync(join(e.evidenceDirectory,'run.json')))};
 };
 const actualMain=git(helperPath,'rev-parse','refs/remotes/origin/main');
 assert(actualMain===g.source&&git(helperPath,'rev-parse','refs/remotes/origin/alpha')===g.source,'Application baseline refs changed');
 const original=await load(input.originalControllerPath,input.applicationPath,g.runId,g.baseline,g.controller);
 const helper=await load(input.helperControllerPath,helperPath,Number(input.helperRunId),g.source,g.source);
 // Dependencies bundled alongside the helper must be unchanged trusted application controller bytes.
 assert(git(helperPath,'diff','--name-only',g.source,'--','.github/ci')==='','Recovery cannot silently modify trusted controller policy');
 const result=await issueRecoveryCapability({grant:g,helperSource:source,helperBytes:bytes,original,helper});
 assert(git(helperPath,'rev-parse','HEAD')===source&&git(helperPath,'status','--porcelain')==='','Helper source changed while authenticating');
 publishRecoveryRecord(resolve(input.outputPath),result);
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 (async()=>{assert(process.argv.length===3,'Usage: issue-cleanup-recovery.mjs PRIVATE_INPUT_JSON');return cli(JSON.parse(readPrivateRecoveryRecord(resolve(process.argv[2]),32*1024)));})().then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;});
}
