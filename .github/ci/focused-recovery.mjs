/** Authenticated focused-recovery operator adapter. Original failed evidence remains immutable. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,controllerRoot,sourceBoundBuild} from './release-ci.mjs';
import {REPOSITORY,verifyArtifactBytes} from './release-policy.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {validateFocusedMetadata,verifyFocusedRecovery,validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
function pages(path,key){const rows=[];for(let page=1;page<=10;page++){const data=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);assert(Array.isArray(data[key]),'Missing API inventory');rows.push(...data[key]);if(data[key].length<100)return rows;}throw Error('Recovery API inventory exceeds bound');}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2}).trim();
const save=(dir,name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
async function collect(runId,dir,{reuse=false,prefetchDirectory,includeRaw=false,repairPackets=false}={}){
 const run=api(`actions/runs/${runId}`),jobs=pages(`actions/runs/${runId}/jobs?filter=all`,'jobs'),artifacts=pages(`actions/runs/${runId}/artifacts`,'artifacts');
 assert(run.id===runId&&run.status==='completed'&&run.run_attempt===1&&['success','failure'].includes(run.conclusion),'Incomplete/foreign/rerun recovery input');
 if(!reuse){mkdirSync(dir,{recursive:true,mode:0o700});save(dir,'run.json',run);save(dir,'jobs.json',jobs);save(dir,'artifacts.json',artifacts);save(dir,'archive-downloads.json',await downloadCiArchives(artifacts,dir,{prefetchDirectory}));}
 const archives=new Map(),parsed=new Map(),rawParsed=new Map(),temporary=reuse?mkdtempSync(join(tmpdir(),'aihr-recovery-read-')):null;
 try{for(const a of artifacts){
  const path=join(dir,a.name+'.zip'),bytes=readCiArchive(a,path);verifyArtifactBytes(a,bytes);archives.set(a.name,bytes);
  const binary=a.name===BUILD_ARTIFACT,destination=join(temporary??dir,a.name);
  const extractor=binary?'./build-transport-extract.py':a.name==='focused-development-evidence'?(repairPackets?'./repair-recovery-extract.py':'./focused-recovery-extract.py'):'./extract-artifact.py';
  if(!reuse||!binary)execFileSync('python3',[fileURLToPath(new URL(extractor,import.meta.url)),path,destination,...(binary?[a.digest.slice(7)]:[])],{timeout:60000,stdio:'pipe'});
  if(!binary){const raw=new Map(readdirSync(destination).map(name=>[name,readFileSync(join(destination,name))]));parsed.set(a.name,new Map([...raw].map(([name,bytes])=>[name,JSON.parse(bytes)])));if(includeRaw)rawParsed.set(a.name,raw);}
 }}finally{if(temporary)rmSync(temporary,{recursive:true,force:true});}
 return {run,jobs,artifacts,archives,parsed,...(includeRaw?{rawParsed}: {})};
}
// Reuse the bounded byte transport, not v1 admission semantics, for separately versioned recovery.
export {collect as collectRecoveryEvidence};
export async function verifyRecoveredCi({candidatePath,runId,baseline,focusedRunIds,evidenceDirectory,reuse=false}){
 candidatePath=resolve(candidatePath);runId=Number(runId);
 assert(Number.isSafeInteger(runId)&&runId>0&&/^[a-f0-9]{40}$/.test(baseline??''),'Exact recovery source required');
 assert(Array.isArray(focusedRunIds)&&focusedRunIds.length>0&&focusedRunIds.length<=64&&focusedRunIds.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(focusedRunIds).size===focusedRunIds.length&&!focusedRunIds.includes(runId),'Distinct bounded focused run inventory required');
 const candidate=cleanHead(candidatePath),verificationController=cleanHead(controllerRoot);
 const diagnosticId=Number(process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID);assert(Number.isSafeInteger(diagnosticId)&&diagnosticId>0,'AIHR_RECOVERY_CONTROLLER_RUN_ID must identify the frozen verifier controller-only validation');
 assert(readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8').includes(' .github/ci/focused-recovery.test.mjs'),'Controller integrity suite must include focused recovery refusal tests');
 const verificationDiagnostic=validateRecoveryControllerDiagnostic({run:api(`actions/runs/${diagnosticId}`),jobs:pages(`actions/runs/${diagnosticId}/jobs?filter=all`,'jobs'),controller:verificationController});
 assert(git(candidatePath,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Unexpected repository');
 execFileSync('git',['merge-base','--is-ancestor',baseline,candidate],{cwd:candidatePath,stdio:'ignore'});
 // Exact-source v1: the build/test controller remains the original canonical candidate. The separately
 // frozen operator verification controller is recorded honestly, never relabelled as that producer.
 const controller=candidate,p={candidate,controller,baseline,runId};
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`validated-recovery-${runId}-${randomUUID()}`);
 const source=await collect(runId,dir,{reuse,prefetchDirectory:process.env.AIHR_CI_PREFETCH_DIR||undefined});
 const plan=source.parsed.get('gate-plan')?.get('ci-plan.json'),local=createPlan(candidatePath);assert(plan,'Missing original archived plan');
 const {fingerprint:unused,...body}={...local,controller,migrationBase:baseline,runtime:plan.runtime};
 const expectedPlan={...body,fingerprint:hash(body)};
 const assessment=assessResumeSource({...source,expectedPlan,expected:p});
 const workflow=api('actions/workflows/alpha-focused-checks.yml');
 assert(workflow.path==='.github/workflows/alpha-focused-checks.yml'&&workflow.state==='active','Focused workflow registry differs');
 const focused=[];
 for(const id of focusedRunIds.slice().sort((a,b)=>a-b)){
  const sub=join(dir,`focused-${id}`),prefetch=process.env.AIHR_CI_PREFETCH_DIR?join(process.env.AIHR_CI_PREFETCH_DIR,`focused-${id}`):null;
  const f=await collect(id,sub,{reuse,prefetchDirectory:prefetch&&existsSync(prefetch)?prefetch:undefined});
  const producer=validateFocusedMetadata({...f,expected:{runId:id,controller,workflowId:workflow.id,after:source.run.updated_at}});
  const artifact=f.artifacts[0],packet=f.parsed.get(artifact.name);
  assert(isDeepStrictEqual([...packet.keys()].sort(),['focused.json','nodb.vitest.json']),'Exact focused no-DB packet members required');
  focused.push({...f,producer,artifact,report:packet.get('focused.json'),result:packet.get('nodb.vitest.json')});
 }
 const reports=plan.units.map(u=>source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`));
 const recovery=verifyFocusedRecovery({plan:expectedPlan,assessment,run:source.run,jobs:source.jobs,reports,focused,classifierHash:hash(readFileSync(join(candidatePath,'scripts/gate-db-classify.ts'),'utf8')),verificationController});
 recovery.verificationDiagnostic=verificationDiagnostic;
 const build=await sourceBoundBuild({candidatePath,dir,p:{...p,controllerBranch:source.run.head_branch},jobs:source.jobs});
 assert(cleanHead(candidatePath)===candidate&&cleanHead(controllerRoot)===verificationController,'Recovery source/controller changed');
 const alpha=api('git/ref/heads/alpha');assert([baseline,candidate].includes(alpha.object?.sha),'Canonical alpha moved away from recovery source');
 const result={...recovery,tier:'ci',result:'PASS',recovery,fingerprint:hash(recovery),build,candidatePath,controllerBranch:source.run.head_branch,focusedRunIds:focusedRunIds.slice().sort((a,b)=>a-b),verifiedAt:new Date().toISOString(),url:source.run.html_url,evidenceDirectory:dir,artifacts:source.artifacts.map(a=>({id:a.id,name:a.name,digest:a.digest}))};
 save(dir,reuse?`revalidation-${randomUUID()}.json`:'verification.json',result);
 return result;
}
export async function revalidateRecoveredCi(evidence){
 assert(evidence.verificationController===cleanHead(controllerRoot),'Recovery verification controller changed');
 const current=await verifyRecoveredCi({candidatePath:evidence.candidatePath,runId:evidence.runId,baseline:evidence.baseline,focusedRunIds:evidence.focusedRunIds,evidenceDirectory:evidence.evidenceDirectory,reuse:true});
 assert(isDeepStrictEqual(current.recovery,evidence.recovery)&&isDeepStrictEqual(current.build,evidence.build)&&isDeepStrictEqual(current.artifacts,evidence.artifacts),'Recovered evidence changed before installation');
 return true;
}
