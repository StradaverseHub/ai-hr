/** Scheduling only: full source plan retained, exactly one authenticated interrupted unit selected. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync,readdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {hash} from './manifest.mjs';
import {REPOSITORY,verifyArtifactBytes} from './release-policy.mjs';
import {UNIT_RECOVERY,FAILED_FONT_SETUP,validateFailedFontSetup,validateUnitRecoveryRequest,validateInterruptedSource} from './unit-recovery-policy.mjs';
const api=p=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${p}`],{encoding:'utf8',timeout:60000,maxBuffer:64*1024**2}));
function pages(path,key){const rows=[];for(let p=1;p<=10;p++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${p}`);rows.push(...r[key]);if(r[key].length<100)return rows;}throw Error('Original inventory exceeds bound');}
export function selectRecoveryMatrix({plan,originalPlan,run,jobs,artifacts,failedSetup,inputs,event}){
 validateUnitRecoveryRequest(inputs,event);const {fingerprint,...body}=plan;
 assert(fingerprint===hash(body),'Fresh plan fingerprint altered');
 const oldBody={...body,controller:UNIT_RECOVERY.controller},expected={...oldBody,fingerprint:hash(oldBody)};
 assert(isDeepStrictEqual(originalPlan,expected),'Complete original plan/source/runtime/coverage differs');
 const unit=validateInterruptedSource({run,jobs,artifacts,plan:originalPlan});validateFailedFontSetup({...failedSetup,originalPlan,candidateBranch:inputs.candidate_ref,after:run.updated_at});return {unit:[unit.id]};
}
function packet(artifact,runId,controller){
 const a=artifact;assert(a&&!a.expired&&a.size_in_bytes>0&&a.size_in_bytes<=16*1024**2&&a.workflow_run?.id===runId&&a.workflow_run.head_sha===controller&&a.workflow_run.repository_id===1333414856&&a.workflow_run.head_repository_id===1333414856,'Source-bound artifact missing/foreign');
 const bytes=execFileSync('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${a.id}/zip`],{timeout:60000,maxBuffer:16*1024**2});assert(bytes.length===a.size_in_bytes);verifyArtifactBytes(a,bytes);
 const temp=mkdtempSync(join(tmpdir(),'aihr-unit-source-'));try{const zip=join(temp,'source.zip'),dir=join(temp,'packet');writeFileSync(zip,bytes,{mode:0o600});execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),zip,dir],{timeout:10000});return new Map(readdirSync(dir).map(name=>[name,JSON.parse(readFileSync(join(dir,name),'utf8'))]));}finally{rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const e=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));validateUnitRecoveryRequest(e.inputs??{},process.env.GITHUB_EVENT_NAME);
 if(process.argv[2]!=='--request'){
  assert(process.argv.length===3);const c=UNIT_RECOVERY,f=FAILED_FONT_SETUP,run=api(`actions/runs/${c.runId}`),jobs=pages(`actions/runs/${c.runId}/jobs?filter=all`,'jobs'),artifacts=pages(`actions/runs/${c.runId}/artifacts`,'artifacts');
  const originalPlan=packet(artifacts.find(a=>a.name==='gate-plan'),c.runId,c.controller).get('ci-plan.json');
  const failedRun=api(`actions/runs/${f.runId}`),failedJobs=pages(`actions/runs/${f.runId}/jobs?filter=all`,'jobs'),failedArtifacts=pages(`actions/runs/${f.runId}/artifacts`,'artifacts');
  const failedPlan=packet(failedArtifacts.find(a=>a.id===f.planArtifactId),f.runId,f.controller).get('ci-plan.json'),failedPacket=packet(failedArtifacts.find(a=>a.id===f.artifactId),f.runId,f.controller);
  const failedSetup={run:failedRun,jobs:failedJobs,artifacts:failedArtifacts,plan:failedPlan,packet:failedPacket},plan=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const matrix=selectRecoveryMatrix({plan,originalPlan,run,jobs,artifacts,failedSetup,inputs:e.inputs,event:process.env.GITHUB_EVENT_NAME});appendFileSync(process.env.GITHUB_OUTPUT,'test_matrix='+JSON.stringify(matrix)+'\n');
 }
}
