import {finishCleanupCli} from './cleanup-only-recovery-policy.mjs';
/** Operator-only authenticated CI refresh and separately issued cleanup-only authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,writeFileSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {SELECTION,ORIGIN,BASELINE,digest,issueCleanupCertificate,validateReauthentication} from './cleanup-only-recovery-policy.mjs';
export const TOOL_FILES=['policy','session','runtime','admission','server','operator'].map(n=>'cleanup-only-recovery-'+n+'.mjs');
export function toolDigest(){return digest(TOOL_FILES.map(name=>[name,digest(readFileSync(new URL(name,import.meta.url)))]));}
export function privateBytes(path,max=16*1024**2){const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size>0&&s.size<=max,'Private bounded operator input required');return readFileSync(path);}
export function savePrivate(path,value){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
export async function reauthenticate(frozen,verificationPath,out,originalControllerRoot){
 frozen=realpathSync(frozen);
 const controllerRoot=realpathSync(originalControllerRoot);
 const imported=await import(pathToFileURL(join(controllerRoot,'.github/ci/release-ci.mjs')).href);
 const {revalidateBrowserRecoveredCi}=await import(pathToFileURL(join(controllerRoot,'.github/ci/browser-recovery.mjs')).href);
 const originalVerifier='f9e36395772eeeeca84d5a6edd90aa5740c77476';
 assert(imported.cleanHead(frozen)===SELECTION.source&&imported.cleanHead(controllerRoot)===originalVerifier,
  'Original source and reviewed incident verifier must remain clean and exact');
 const bytes=privateBytes(verificationPath),evidence=JSON.parse(bytes);
 assert(evidence.sha===SELECTION.source&&evidence.controller===ORIGIN.controller&&Number(evidence.runId)===ORIGIN.runId
  &&evidence.fingerprint===ORIGIN.witnessFingerprint&&evidence.browserRunId===41529495273
  &&evidence.verificationController===originalVerifier&&evidence.candidatePath===frozen,'Exact incident recovery witness required');
 await revalidateBrowserRecoveredCi(evidence);
 const api=route=>JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/'+route],{encoding:'utf8',timeout:60000,maxBuffer:16*1024**2}));
 const run=api('actions/runs/'+ORIGIN.runId),artifact=api('actions/artifacts/'+ORIGIN.artifactId),alpha=api('git/ref/heads/alpha'),main=api('git/ref/heads/main');
 assert(run.status==='completed'&&run.conclusion==='failure'&&run.head_sha===ORIGIN.controller&&run.head_branch==='main'&&run.event==='workflow_dispatch'&&run.run_attempt===1,'Original terminal failed full run must retain its conclusion');
 assert(artifact.id===ORIGIN.artifactId&&artifact.digest===ORIGIN.artifactDigest&&artifact.expired===false&&artifact.workflow_run?.id===ORIGIN.runId&&artifact.workflow_run?.head_sha===ORIGIN.controller,'Original unexpired artifact differs');
 const metadata={run,artifact,alpha,main,originalVerificationSha256:digest(bytes)},value={...ORIGIN,source:SELECTION.source,alpha:alpha.object?.sha,main:main.object?.sha,metadataSha256:digest(metadata),verifiedAt:new Date().toISOString()};validateReauthentication(value,{issuing:true});savePrivate(out,{value,metadata});return value;
}
export function issue({reauthenticationPath,inspectionPath,humanEvidencePath,controller,out}){
 const authenticated=JSON.parse(privateBytes(reauthenticationPath));assert(digest(authenticated.metadata)===authenticated.value.metadataSha256,'Authenticated raw metadata changed');
 const inspection=JSON.parse(privateBytes(inspectionPath));assert(inspection.kind==='CLEANUP_ONLY_READONLY_PREPARATION'&&Date.now()-Date.parse(inspection.verifiedAt)>=0&&Date.now()-Date.parse(inspection.verifiedAt)<=120000,'Fresh independently guarded inspection required');
 assert(inspection.toolSha256===toolDigest()&&inspection.controller===controller,'Reviewed inspection tool/controller differs');
 const cert=issueCleanupCertificate({controller,toolSha256:toolDigest(),humanEvidenceSha256:digest(privateBytes(humanEvidencePath)),reauthentication:authenticated.value,fences:inspection.fences,runtime:inspection.runtime,reconciliationSha256:inspection.reconciliationSha256,certificateId:randomBytes(32).toString('hex')});savePrivate(out,cert);return cert;
}
export {finishCleanupCli as finishCleanupAdmissionCli};
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2);
 await finishCleanupCli(async()=>{if(command==='reauthenticate'){assert(args.length===4);return reauthenticate(...args);}assert(command==='issue'&&args.length===5);return issue({reauthenticationPath:args[0],inspectionPath:args[1],humanEvidencePath:args[2],controller:args[3],out:args[4]});});
}
