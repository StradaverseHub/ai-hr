/** aihr-browser-recovery/v3 read-only adapter (ADR-0175 decision 4a). It authenticates the original failed gate,
 * the single fresh engine execution, every other execution of that engine since the original run, the static
 * impact of the candidate and the flaky test register, then returns a certificate or a full refusal list.
 * It never contacts staging, never builds a grant and never authorizes installation (no v3 install route exists).
 *
 *   node --import tsx .github/ci/browser-recovery-v3.mjs diagnose /ABS/CANDIDATE ORIGINAL_RUN '<options JSON>'
 *   options: {"baseline","browserRunId","recoveryRef","controllerBranch","browserProducerController",
 *             "browserProducerBranch","producerDiagnosticRunId"}   (+ AIHR_RECOVERY_CONTROLLER_RUN_ID) */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,relative,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {cleanHead,controllerRoot} from './release-ci.mjs';
import {REPOSITORY,WORKFLOW_ID,verifyArtifactBytes} from './release-policy.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {validateRecoveryControllerDiagnostic} from './focused-recovery-policy.mjs';
import {BROWSER_WORKFLOW_ID} from './browser-recovery-policy.mjs';
import {decodeCommittedBlobs} from './repair-impact.mjs';
import {validateSingleShotMetadata,verifySingleShotRecovery,browserImpact,ownedBranch,originalBrowserFailure,validateSingleShotHistory,registeredFlakes,runChecks,SINGLE_SHOT_POLICY,SINGLE_SHOT_SCOPES} from './browser-recovery-v3-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}));
const bytes=path=>execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{maxBuffer:128*1024**2,timeout:120000});
function pages(path,key){const rows=[];for(let p=1;p<=10;p++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${p}`);assert(Array.isArray(r[key]),'Missing API inventory');rows.push(...r[key]);if(r[key].length<100)return rows;}throw Error('API inventory exceeds bounded recovery');}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:128*1024**2,timeout:60000}).trim();
const metadata=id=>({run:api(`actions/runs/${id}`),jobs:pages(`actions/runs/${id}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${id}/artifacts`,'artifacts')});
const facts=m=>({run:m.run,jobs:m.jobs,artifacts:m.artifacts});
const positiveId=n=>Number.isSafeInteger(n)&&n>0;
const sha256=b=>createHash('sha256').update(b).digest('hex');
const V3_FILES=['.github/ci/browser-recovery-v3.mjs','.github/ci/browser-recovery-v3-policy.mjs','.github/ci/browser-recovery-v3.test.mjs','.github/workflows/alpha-staging.yml','docs/BROWSER-RECOVERY-V3.md','docs/FLAKY-TESTS.md'];
/** The verifier/producer may differ from the original controller only in the v3 recovery files and register. */
export function validateV3ControllerDelta(records){
 assert(records.length>0&&records.every(p=>V3_FILES.includes(p)),'Recovery controller changed application, runtime, unit runner or unrelated controls: '+records.filter(p=>!V3_FILES.includes(p)).slice(0,5).join(', '));
 for(const p of ['.github/ci/browser-recovery-v3.mjs','.github/ci/browser-recovery-v3-policy.mjs','.github/ci/browser-recovery-v3.test.mjs'])assert(records.includes(p),'Incomplete v3 recovery controller');
}
function planAt(candidatePath,controller,baseline){
 const previous=process.env.AIHR_CI_CLASSIFIER_RUNTIME;process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';
 try{const local=createPlan(candidatePath),{fingerprint,...body}={...local,controller,migrationBase:baseline,runtime:{node:'22.23.3',platform:'linux',arch:'x64'}};return {...body,fingerprint:hash(body)};}
 finally{if(previous===undefined)delete process.env.AIHR_CI_CLASSIFIER_RUNTIME;else process.env.AIHR_CI_CLASSIFIER_RUNTIME=previous;}
}
function committedTexts(cwd,ref){
 const entries=git(cwd,'ls-tree','-r','-z',ref).split('\0').filter(Boolean).map(r=>/^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(r)).filter(m=>m&&m[2]==='blob'&&/\.(?:[cm]?[jt]sx?|json|css|md)$/.test(m[4])).map(m=>({path:m[4],id:m[3]}));
 const ids=[...new Set(entries.map(e=>e.id))],blobs=decodeCommittedBlobs(ids,execFileSync('git',['cat-file','--batch'],{cwd,input:ids.join('\n')+'\n',maxBuffer:256*1024**2,timeout:120000}));
 return new Map(entries.map(e=>[e.path,blobs.get(e.id)]));
}
/** Static forward import graph of the candidate from the existing ADR-0114 classifier (immutable Git objects). */
export function candidateImpact({candidatePath,baseline,candidate,failing}){
 const require=createRequire(import.meta.url);
 const {planImpact,IMPACT_POLICY_VERSION}=require(join(controllerRoot,'scripts/gate-impact.ts')),{collectChanges}=require(join(controllerRoot,'scripts/gate-tier-git.ts'));
 assert(IMPACT_POLICY_VERSION===3,'Unexpected impact policy');
 const files=committedTexts(candidatePath,candidate),changes=collectChanges(baseline,candidate,candidatePath);let edges=null;
 planImpact(changes,files,[],graph=>{edges=new Map([...graph].map(([k,v])=>[k,new Set(v)]));});
 const uncertain=new Set([...files].filter(([p,t])=>/\.[cm]?[jt]sx?$/.test(p)&&/\b(?:import|require)\(\s*(?!['"`][^'"`$]*['"`]\s*\))/.test(t)).map(([p])=>p));
 return browserImpact({changed:changes.map(c=>c.path).sort(),edges:edges??new Map(),failing,uncertain});
}
async function readArchiveMember(artifact,member){
 const zip=bytes(`actions/artifacts/${artifact.id}/zip`);verifyArtifactBytes(artifact,zip);
 const out=execFileSync('python3',['-I','-c','import io,sys,zipfile;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));n=sys.argv[1];sys.stdout.write(z.read(n).decode() if n in z.namelist() else "")',member],{input:zip,maxBuffer:64*1024**2,timeout:60000}).toString('utf8');
 return out?JSON.parse(out):null;
}
/** Every complete execution of the engine unit since the original run started, in the gate and the browser
 * workflow, wherever dispatched from; candidate identity comes from each run's own digest-verified artifact. */
async function engineExecutions({engine,since,originalRunId}){
 const runs=[...pages(`actions/workflows/${BROWSER_WORKFLOW_ID}/runs?created=${encodeURIComponent('>='+since)}`,'workflow_runs'),...pages(`actions/workflows/${WORKFLOW_ID}/runs?created=${encodeURIComponent('>='+since)}`,'workflow_runs')].filter(r=>r.id!==originalRunId);
 const out=[];
 for(const r of runs){
  const gate=r.workflow_id===WORKFLOW_ID,jobs=pages(`actions/runs/${r.id}/jobs?filter=all`,'jobs');
  const job=jobs.find(j=>j.name===(gate?`browser (${engine})`:`browser-image (${engine})`));
  if(!job)continue;
  const ran=gate?!['skipped',null].includes(job.conclusion)||job.status!=='completed':job.steps?.some(s=>s.name==='Complete original browser unit in pinned image'&&s.conclusion!=='skipped')||job.status!=='completed';
  if(!ran)continue;
  let candidate=null;
  if(r.status==='completed'){
   const artifacts=pages(`actions/runs/${r.id}/artifacts`,'artifacts').filter(a=>!a.expired);
   const binding=artifacts.find(a=>a.name===`browser-recovery-runtime-${engine}`),unit=artifacts.find(a=>a.name===(gate?`unit-browser-${engine}`:`diagnostic-complete-image-browser-${engine}`));
   try{candidate=binding?(await readArchiveMember(binding,'image-binding.json'))?.candidate??null:unit?(await readArchiveMember(unit,`unit-browser-${engine}.json`))?.sha??null:null;}catch{candidate=null;}
  }
  out.push({id:r.id,workflow:gate?'gate':'browser',engine,status:r.status==='completed'&&job.status==='completed'?'completed':'pending',conclusion:job.conclusion,attempt:r.run_attempt,candidate:typeof candidate==='string'&&/^[a-f0-9]{40}$/.test(candidate)?candidate:null});
 }
 return out.sort((a,b)=>a.id-b.id);
}
export async function diagnoseSingleShot({candidatePath,runId,baseline,browserRunId,recoveryRef,controllerBranch,browserProducerController,browserProducerBranch,producerDiagnosticRunId,evidenceDirectory,collect=true}){
 candidatePath=resolve(candidatePath);runId=Number(runId);browserRunId=Number(browserRunId);
 assert(positiveId(runId)&&positiveId(browserRunId)&&runId!==browserRunId&&/^[a-f0-9]{40}$/.test(baseline??''),'Exact original/browser/baseline required');
 for(const b of [recoveryRef,controllerBranch,browserProducerBranch])assert(ownedBranch(b),'Owned recovery/controller branches required');
 const candidate=cleanHead(candidatePath),verificationController=cleanHead(controllerRoot),reviewedController=process.env.AIHR_BROWSER_REVIEWED_CONTROLLER??null;
 assert(git(candidatePath,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Foreign source origin');
 execFileSync('git',['merge-base','--is-ancestor',baseline,candidate],{cwd:candidatePath,stdio:'ignore'});
 const refAt=b=>api('git/ref/heads/'+b.split('/').map(encodeURIComponent).join('/')).object?.sha;
 const refs=()=>({recoveryRef:refAt(recoveryRef)===candidate,controllerBranch:refAt(controllerBranch)===verificationController,browserProducerBranch:refAt(browserProducerBranch)===browserProducerController,main:[baseline,candidate].includes(refAt('main')),alpha:[baseline,candidate].includes(refAt('alpha'))});
 const originalMetadata=metadata(runId),controller=originalMetadata.run.head_sha;
 assert(originalMetadata.run.status==='completed'&&originalMetadata.run.conclusion==='failure'&&originalMetadata.run.run_attempt===1,'Wait for every original gate chunk to finish');
 const deltas={};
 for(const [name,c]of [['verificationController',verificationController],['browserProducerController',browserProducerController]]){
  try{execFileSync('git',['merge-base','--is-ancestor',controller,c],{cwd:controllerRoot,stdio:'ignore'});validateV3ControllerDelta(git(controllerRoot,'diff','--name-only',controller,c).split('\n').filter(Boolean));deltas[name]='ok';}catch(e){deltas[name]=String(e.message??e);}
 }
 assert(readFileSync(join(controllerRoot,'.github/workflows/alpha-staging.yml'),'utf8').includes(' .github/ci/browser-recovery-v3.test.mjs'),'Hosted integrity must include v3 refusal tests');
 const diagnosticId=Number(process.env.AIHR_RECOVERY_CONTROLLER_RUN_ID);assert(positiveId(diagnosticId),'Frozen verifier controller-only run required');
 const verificationDiagnostic=validateRecoveryControllerDiagnostic({...metadata(diagnosticId),controller:verificationController});
 const producerDiagnostic=validateRecoveryControllerDiagnostic({...metadata(producerDiagnosticRunId),controller:browserProducerController});
 const browserMetadata=metadata(browserRunId),engine=Object.keys(SINGLE_SHOT_SCOPES).find(e=>browserMetadata.jobs.some(j=>j.name===`browser-image (${e})`));
 // A failed or foreign producer is itself a refusal; the remaining checks are still evaluated for the record.
 let producer=null,producerRefusal=null;
 try{producer=validateSingleShotMetadata({...browserMetadata,expected:{runId:browserRunId,controller:browserProducerController,branch:browserProducerBranch,candidateBranch:recoveryRef,engine,after:originalMetadata.run.updated_at}});}catch(e){producerRefusal=String(e?.message??e);}
 const dir=evidenceDirectory??join(controllerRoot,'scratchpad',`browser-single-shot-${runId}-${randomUUID()}`);mkdirSync(dir,{recursive:true,mode:0o700});
 const source=await collectRecoveryEvidence(runId,dir,{prefetchDirectory:process.env.AIHR_CI_PREFETCH_DIR||undefined});
 assert(isDeepStrictEqual(originalMetadata,facts(source)),'Original metadata changed during collection');
 const plan=planAt(candidatePath,controller,baseline),freshPlan=planAt(candidatePath,browserProducerController,baseline);
 const assessment=assessResumeSource({...source,expectedPlan:plan,expected:{candidate,controller,baseline,runId}});
 const reports=plan.units.map(u=>source.parsed.get('unit-'+u.id)?.get(`unit-${u.id}.json`));
 const failedUnit=plan.units.find(u=>u.kind==='browser'&&u.engine===engine),failedReport=reports.find(r=>r?.id===failedUnit?.id);
 const failing=[...new Set((failedReport?.batches??[]).flatMap(b=>b.result?.testResults??[]).filter(f=>f.status!=='passed'||f.assertionResults?.some(a=>a.status!=='passed')).map(f=>relative(failedReport.cwd,f.name).split('\\').join('/')))].sort();
 const impact=candidateImpact({candidatePath,baseline,candidate,failing});
 const executions=await engineExecutions({engine,since:originalMetadata.run.created_at,originalRunId:runId});
 const registerPath=join(controllerRoot,'docs/FLAKY-TESTS.md');let registerText='';try{registerText=readFileSync(registerPath,'utf8');}catch{/* refused by the register check */}
 let certificate;
 if(producer){
  const fresh=await collectRecoveryEvidence(browserRunId,join(dir,'browser-'+browserRunId));assert(isDeepStrictEqual(browserMetadata,facts(fresh)),'Browser metadata changed during collection');
  const packet=fresh.parsed.get(`diagnostic-complete-image-browser-${engine}`),binding=fresh.parsed.get(`browser-recovery-runtime-${engine}`);
  assert(binding?.size===1&&binding.has('image-binding.json')&&packet?.has(`unit-browser-${engine}.json`),'Exact runtime binding and unit packet required');
  certificate=verifySingleShotRecovery({plan,freshPlan,assessment,run:source.run,jobs:source.jobs,reports,fresh:{...fresh,producer,binding:binding.get('image-binding.json'),report:packet.get(`unit-browser-${engine}.json`)},impact,executions,flakeRegister:{path:'docs/FLAKY-TESTS.md',sha256:sha256(registerText),text:registerText},verificationController,verificationDiagnostic,producerDiagnostic,reviewedController,lockSha256:sha256(readFileSync(join(candidatePath,'pnpm-lock.yaml')))},{collect});
 }else{
  const partial=runChecks([
   ['fresh producer',()=>{throw Error(producerRefusal);}],
   ['original failure',()=>originalBrowserFailure({plan,assessment,run:source.run,jobs:source.jobs,reports})],
   ['outside impact set',()=>assert(impact.outside,'Failing browser files are inside the candidate impact set: '+impact.reasons.slice(0,5).join('; '))],
   ['single shot',()=>validateSingleShotHistory({executions,browserRunId,candidate:plan.sha,engine}),['original failure']],
   ['registered flake',v=>registeredFlakes(registerText,v['original failure'].failing),['original failure']],
  ],{collect:true});
  certificate={kind:'BROWSER_SINGLE_SHOT_DIAGNOSTIC',recoveryPolicy:SINGLE_SHOT_POLICY,result:'REFUSED',checks:partial.results,installationEligible:false,releaseAuthorized:false};
 }
 const refState=refs(),extra=[
  ...Object.entries(refState).filter(([,ok])=>!ok).map(([name])=>({name:'frozen ref '+name,ok:false,refusal:`${name} moved away from the frozen candidate/baseline/controller`})),
  ...Object.entries(deltas).filter(([,v])=>v!=='ok').map(([name,v])=>({name:'controller delta '+name,ok:false,refusal:v})),
 ];
 const result={...certificate,checks:[...certificate.checks,...extra],result:extra.length&&certificate.result!=='REFUSED'?'REFUSED':certificate.result,installationEligible:false,releaseAuthorized:false,
  candidate,baseline,runId,browserRunId,engine,failing,impactReasons:impact.reasons.slice(0,50),executions,verifiedAt:new Date().toISOString(),evidenceDirectory:dir};
 writeFileSync(join(dir,'v3-diagnostic.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,candidatePath,runId,options]=process.argv.slice(2);
 if(mode!=='diagnose'||!candidatePath||!/^\d+$/.test(runId??'')||!options)throw Error('Usage: diagnose /ABS/CANDIDATE ORIGINAL_RUN \'<options JSON>\'');
 diagnoseSingleShot({candidatePath,runId,...JSON.parse(options)}).then(r=>{
  console.log(JSON.stringify({kind:r.kind,result:r.result,installationEligible:r.installationEligible,releaseAuthorized:r.releaseAuthorized,engine:r.engine,failing:r.failing,checks:r.checks,impactReasons:r.impactReasons,executions:r.executions,evidenceDirectory:r.evidenceDirectory},null,2));
 }).catch(e=>{console.error(e.message??e);process.exitCode=1;});
}
