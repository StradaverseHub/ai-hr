/** Compose immutable managed coverage with independently authenticated global candidate lineage. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {hash} from './manifest.mjs';
import {cleanHead,controllerRoot} from './release-ci.mjs';
import {verifyCompleteCandidateHistory,FROZEN_PROOF_CONTROLLER,FINITE_SOURCE} from './finite-candidate-history.mjs';
export function pinAssessmentController(path=controllerRoot){
 const controller=cleanHead(path);return {controller,verify(){assert(cleanHead(path)===controller,'Wrapper controller changed during assessment');return controller;}};
}
export async function assessFiniteStaging({proofControllerPath,candidatePath,originalPath,runs,evidenceDirectory}){
 const wrapper=pinAssessmentController();
 proofControllerPath=resolve(proofControllerPath);candidatePath=resolve(candidatePath);originalPath=resolve(originalPath);evidenceDirectory=resolve(evidenceDirectory);
 assert(cleanHead(proofControllerPath)===FROZEN_PROOF_CONTROLLER&&cleanHead(candidatePath)===FINITE_SOURCE,'Exact unchanged proof controller and application required');
 const origin=path=>execFileSync('git',['remote','get-url','origin'],{cwd:path,encoding:'utf8'}).trim().toLowerCase();for(const path of [proofControllerPath,candidatePath,originalPath])assert(origin(path)==='https://github.com/stradaversehub/ai-hr.git','Unexpected source repository');
 assert(Object.keys(runs).sort().join(',')===['focusedRunIds','buildRunId','browserRunId','compilerRunId','pdfRunId','diagnosticId'].sort().join(','),'Exact concrete evidence run options required');
 mkdirSync(evidenceDirectory,{recursive:true,mode:0o700});
 const frozen=await import(pathToFileURL(join(proofControllerPath,'.github/ci/fixture-browser-recovery.mjs')).href);
 const previous=process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID;process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID=String(runs.diagnosticId);
 let managed;
 try{managed=await frozen.verifyFixtureBrowserCi({candidatePath,originalPath,runId:41028659062,baseline:'d6cb83d620d8d4380c981a72fc41628780840b4e',...runs,candidateBranch:'codex/mobile-bank-feedback-staging-prep-20261030',evidenceDirectory:join(evidenceDirectory,'managed')});}
 finally{if(previous===undefined)delete process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID;else process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID=previous;}
 assert(managed.result==='DIAGNOSTIC_NONINSTALLABLE'&&managed.installationEligible===false&&managed.recovery.pendingReview===true,'Managed coverage proof must retain original noninstallable semantics');
 const lineage=await verifyCompleteCandidateHistory({proof:managed,directory:join(evidenceDirectory,'lineage')});
 assert(cleanHead(proofControllerPath)===FROZEN_PROOF_CONTROLLER&&cleanHead(candidatePath)===FINITE_SOURCE,'Frozen proof or application changed during composition');
 wrapper.verify();
 const body={kind:'FINITE_STAGING_READINESS_ASSESSMENT',source:FINITE_SOURCE,verificationController:wrapper.controller,proofController:FROZEN_PROOF_CONTROLLER,managedProofHash:hash(managed.recovery),managedProofScope:'MANAGED_EXECUTION_NAMESPACE_ONLY',lineage,managed,installationEligible:false,releaseAuthorized:false,requiresSeparateReviewedStagingAdmission:true};
 const result={...body,fingerprint:hash(body)};writeFileSync(join(evidenceDirectory,'readiness-assessment.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [optionsPath]=process.argv.slice(2);assert(optionsPath,'Saved JSON options required');assessFiniteStaging(JSON.parse(readFileSync(optionsPath,'utf8'))).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
