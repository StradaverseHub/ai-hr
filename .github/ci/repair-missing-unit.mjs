/** Authenticated missing-unit scheduling/collection. No gate PASS and no old report synthesis. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync,writeFileSync,readdirSync,mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH,verifyArtifactBytes} from './release-policy.mjs';
import {validateMissingUnitRequest,validateMissingOriginalUnit,validateMissingUnitProducer,verifyMissingUnitEvidence,missingUnit,MISSING_UNIT_FILE} from './repair-missing-unit-policy.mjs';
export {validateMissingUnitProducer,verifyMissingUnitEvidence} from './repair-missing-unit-policy.mjs';
const api=p=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${p}`],{encoding:'utf8',timeout:60000,maxBuffer:64*1024**2}));
function pages(path,key){const rows=[];for(let page=1;page<=10;page++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);assert(Array.isArray(r[key]));rows.push(...r[key]);if(r[key].length<100)return rows;}throw Error('Missing-unit API inventory exceeds bound');}
const metadata=runId=>({run:api(`actions/runs/${runId}`),jobs:pages(`actions/runs/${runId}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${runId}/artifacts`,'artifacts')});
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:60000,maxBuffer:64*1024**2}).trim();
function artifactOwner(m,name,producerName){
 assert(m.artifacts.filter(a=>a.name===name).length===1,'Unique selected artifact required');
 const a=m.artifacts.find(a=>a.name===name),j=m.jobs.find(j=>j.name===producerName),w=a?.workflow_run;
 assert(a&&!a.expired&&a.size_in_bytes>0&&a.size_in_bytes<=64*1024**2&&w?.id===m.run.id&&w.head_sha===m.run.head_sha&&w.head_branch===m.run.head_branch&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&j?.conclusion==='success'&&Date.parse(a.created_at)>=Date.parse(j.started_at)&&Date.parse(a.created_at)<=Date.parse(j.completed_at)&&Date.parse(a.expires_at)>Date.now(),'Authenticated source-bound successful artifact producer required');return a;
}
function packet(m,name,producer,directory,reuse=false){
 const a=artifactOwner(m,name,producer),path=join(directory,`${a.id}.zip`);mkdirSync(directory,{recursive:true,mode:0o700});
 if(!reuse){const raw=execFileSync('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${a.id}/zip`],{timeout:60000,maxBuffer:64*1024**2});verifyArtifactBytes(a,raw);assert(raw.length===a.size_in_bytes);writeFileSync(path,raw,{flag:'wx',mode:0o600});}
 const bytes=readFileSync(path);verifyArtifactBytes(a,bytes);assert(bytes.length===a.size_in_bytes);
 const temp=mkdtempSync(join(tmpdir(),'aihr-missing-unit-'));try{execFileSync('python3',[fileURLToPath(new URL('./extract-artifact.py',import.meta.url)),path,join(temp,'packet')],{timeout:60000});return {artifact:a,files:new Map(readdirSync(join(temp,'packet')).map(n=>[n,JSON.parse(readFileSync(join(temp,'packet',n),'utf8'))]))};}finally{rmSync(temp,{recursive:true,force:true});}
}
function boundRun(m,{runId,controller,branch}){
 assert(Number.isSafeInteger(runId)&&runId>0&&/^[a-f0-9]{40}$/.test(controller??'')&&typeof branch==='string');
 const r=m.run;assert(r.id===runId&&r.head_sha===controller&&r.head_branch===branch&&r.repository?.id===REPOSITORY_ID&&r.repository.full_name===REPOSITORY&&r.head_repository?.id===REPOSITORY_ID&&r.workflow_id===WORKFLOW_ID&&r.path===WORKFLOW_PATH&&r.event==='workflow_dispatch'&&r.status==='completed'&&r.run_attempt===1,'Expected independent run metadata differs');
 assert(new Set(m.jobs.map(j=>j.id)).size===m.jobs.length&&new Set(m.jobs.map(j=>j.name)).size===m.jobs.length,'Duplicate producer jobs');
 for(const j of m.jobs)assert(j.run_id===runId&&j.head_sha===controller&&j.head_branch===branch&&j.run_attempt===1&&j.status==='completed','Independent producer job identity differs');
}
function sameBlob(cwd,source,other){const original=git(cwd,'rev-parse',`${source}:${MISSING_UNIT_FILE}`),candidate=git(cwd,'rev-parse',`${other}:${MISSING_UNIT_FILE}`);assert(original===candidate,'Missing unit source blob changed');return original;}
export async function collectMissingUnitRecovery({candidatePath,originalPath,sourcePlan,plan,source,options,directory,reuse=false,after}){
 assert(options&&Object.keys(options).every(k=>['runId','controller','branch','candidateBranch','unitId','expectation','controllerDiagnosticRunId'].includes(k)),'Closed missing-unit producer options required');
 const {runId,controller,branch,candidateBranch,unitId,expectation}=options;assert(expectation&&Object.keys(expectation).sort().join(',')==='branch,controller,runId,source','Closed independent expectation selection required');
 assert(git(candidatePath,'rev-parse','HEAD')===plan.sha&&git(originalPath,'rev-parse','HEAD')===sourcePlan.sha&&!git(candidatePath,'status','--porcelain')&&!git(originalPath,'status','--porcelain'),'Source checkout changed');
 validateMissingOriginalUnit({...source,plan:sourcePlan,unitId});missingUnit(plan,unitId);
 assert(Number.isSafeInteger(options.controllerDiagnosticRunId)&&options.controllerDiagnosticRunId>0,'Qualified producer controller diagnostic required');
 const diagnosticMetadata=metadata(options.controllerDiagnosticRunId),producerDiagnostic=validateRecoveryControllerDiagnostic({...diagnosticMetadata,controller});
 const m=metadata(runId),producer=validateMissingUnitProducer({...m,expected:{runId,controller,branch,candidateBranch,unitId,after}});
 const dir=join(directory,'missing-whole-unit');mkdirSync(dir,{recursive:true,mode:0o700});
 const fp=packet(m,'gate-plan','plan',dir,reuse),up=packet(m,'unit-'+unitId,producer.name,dir,reuse);assert(fp.files.size===1&&fp.files.has('ci-plan.json'),'Exact complete producer plan packet required');
 const freshPlan=fp.files.get('ci-plan.json'),report=up.files.get(`unit-${unitId}.json`),font=up.files.get('noto-font-setup.json');assert(report&&font,'Fresh whole-unit report and actual font proof required');
 assert(![...up.files.keys()].some(n=>n==='ci-receipt.json'||n.startsWith('unit-')&&n!==`unit-${unitId}.json`),'Foreign unit or synthetic gate receipt');
 const em=metadata(expectation.runId);boundRun(em,expectation);assert(Date.parse(em.run.updated_at)<Date.parse(source.run.created_at),'Independent expectation must precede original execution');
 const ep=packet(em,'gate-plan','plan',dir,reuse),eu=packet(em,'unit-'+unitId,`test (${unitId})`,dir,reuse);assert(ep.files.size===1&&ep.files.has('ci-plan.json'),'Independent whole plan required');
 const priorPlan=ep.files.get('ci-plan.json');assert(priorPlan.sha===expectation.source&&priorPlan.controller===expectation.controller,'Independent expectation plan identity differs');
 const fileBlob={original:sameBlob(candidatePath,sourcePlan.sha,plan.sha),candidate:git(candidatePath,'rev-parse',`${plan.sha}:${MISSING_UNIT_FILE}`),expectation:sameBlob(candidatePath,sourcePlan.sha,expectation.source)};
 const provenance=(mm,a,j)=>({runId:mm.run.id,controller:mm.run.head_sha,branch:mm.run.head_branch,jobId:j.id,artifactId:a.id,digest:a.digest});
 const proof={freshPlan,run:m.run,workflowId:m.run.workflow_id,branch,candidateBranch,metadata:m,expected:{runId,controller,branch,candidateBranch,unitId,after},producer,report,font,nativePrepull:up.files.get('native-postgres-prepull.json'),fileBlob,source:provenance(m,up.artifact,producer),expectation:{metadata:em,selection:expectation,plan:priorPlan,report:eu.files.get(`unit-${unitId}.json`),source:provenance(em,eu.artifact,em.jobs.find(j=>j.name===`test (${unitId})`))}};
 const verified=verifyMissingUnitEvidence({sourcePlan,plan,missing:unitId,proof});
 assert(isDeepStrictEqual(metadata(runId),m)&&isDeepStrictEqual(metadata(expectation.runId),em),'Missing/expectation API inventory changed');
 const audit={fresh:m,expectation:em,fileBlob,unitId};const auditPath=join(dir,'metadata.json');if(reuse)assert(isDeepStrictEqual(JSON.parse(readFileSync(auditPath,'utf8')),audit));else writeFileSync(auditPath,JSON.stringify(audit,null,2)+'\n',{flag:'wx',mode:0o600});
 assert(isDeepStrictEqual(metadata(options.controllerDiagnosticRunId),diagnosticMetadata),'Producer diagnostic changed');
 return {...verified,proof,producerDiagnostic,run:m.run,workflowId:m.run.workflow_id,branch,candidateBranch};
}
export function selectMissingUnitMatrix({plan,originalPlan,run,jobs,artifacts,inputs,event}){
 validateMissingUnitRequest(inputs,event);assert(String(run.id)===inputs.missing_original_run&&plan.sha===inputs.expected_sha,'Requested source/original execution differs');const unit=validateMissingOriginalUnit({run,jobs,artifacts,plan:originalPlan,unitId:inputs.missing_unit});sameTopology(plan,originalPlan);missingUnit(plan,unit.id);return {unit:[unit.id]};
}
function sameTopology(current,original){for(const k of ['schemaVersion','policyVersion','migrationBase','runtime','execution','pdfTooling','suite','units'])assert(isDeepStrictEqual(current[k],original[k]),'Original full plan topology/runtime changed: '+k);}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));validateMissingUnitRequest(event.inputs??{},process.env.GITHUB_EVENT_NAME);
 if(process.argv[2]!=='--request'){
  assert(process.argv.length===3);const inputs=event.inputs,m=metadata(Number(inputs.missing_original_run)),dir=mkdtempSync(join(tmpdir(),'aihr-missing-source-'));
  try{const originalPlan=packet(m,'gate-plan','plan',dir).files.get('ci-plan.json'),plan=JSON.parse(readFileSync(process.argv[2],'utf8'));const matrix=selectMissingUnitMatrix({...m,plan,originalPlan,inputs,event:process.env.GITHUB_EVENT_NAME});execFileSync('git',['merge-base','--is-ancestor',originalPlan.sha,plan.sha],{stdio:'ignore'});sameBlob(process.cwd(),originalPlan.sha,plan.sha);assert(git(process.cwd(),'rev-parse','HEAD')===plan.sha&&!git(process.cwd(),'status','--porcelain'),'Actual candidate differs');appendFileSync(process.env.GITHUB_OUTPUT,'test_matrix='+JSON.stringify(matrix)+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
 }
}
