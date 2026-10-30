/** Hosted immutable-source scheduling projection; never supplies passing test evidence. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createPlan,hash} from './plan.mjs';
import {reconstructRepairImpact} from './repair-impact.mjs';
import {reconstructFixtureRepairImpact} from './fixture-repair-impact.mjs';
import {repairDisposition} from './fixture-browser-recovery-policy.mjs';
import {validateFixtureRepairDelta} from './fixture-browser-recovery.mjs';
const [originalPath,candidatePath,output]=process.argv.slice(2),original='a16f0beb40e2d331273ac2aaf40c7eb8effb280b',candidate='6bdddf4f84b3ecb693d8fbf29409373e49c73ac9',controller='d6cb83d620d8d4380c981a72fc41628780840b4e',runId=41028659062;
const git=(path,...args)=>execFileSync('git',args,{cwd:path,encoding:'utf8'}).trim();
assert(git(originalPath,'rev-parse','HEAD')===original&&git(candidatePath,'rev-parse','HEAD')===candidate,'Exact frozen source checkouts required');
const verificationController=git(process.cwd(),'rev-parse','HEAD');validateFixtureRepairDelta({cwd:candidatePath,original,candidate});
const api=path=>JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/'+path],{encoding:'utf8',maxBuffer:32*1024**2}));
const run=api('actions/runs/'+runId);assert(run.id===runId&&run.repository.id===1333414856&&run.workflow_id===395777276&&run.head_sha===controller&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='failure','Complete authenticated original failure required');
const jobs=[];for(let page=1;page<=10;page++){const data=api(`actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`);jobs.push(...data.jobs);if(data.jobs.length<100)break;if(page===10)throw Error('Job inventory exceeds bound');}
assert(jobs.every(j=>j.status==='completed'),'Original planned jobs must finish');
process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';
const boundPlan=path=>{const local=createPlan(path),{fingerprint,...body}={...local,controller,migrationBase:controller};return {...body,fingerprint:hash(body)};};
const sourcePlan=boundPlan(originalPath),plan=boundPlan(candidatePath);
const assessment={reusable:sourcePlan.units.filter(u=>jobs.some(j=>j.name===(u.kind==='browser'?`browser (${u.engine})`:`test (${u.id})`)&&j.conclusion==='success')).map(u=>({id:u.id}))};
const impactContext=reconstructFixtureRepairImpact({cwd:candidatePath,base:original,head:candidate,controller:verificationController});
const disposition=repairDisposition({sourcePlan,plan,assessment,impactContext,verificationController});
const rawImpactContext=reconstructRepairImpact({cwd:candidatePath,base:original,head:candidate,controller:verificationController});
const result={rawImpactContext,kind:'IMMUTABLE_REPAIR_SCHEDULING_PROJECTION_NOT_PASS',releaseAuthorized:false,runId:process.env.GITHUB_RUN_ID,verificationController,originalRunId:runId,original,candidate,controller,impactContext,disposition,required:plan.units.filter(u=>disposition.fresh.includes(u.id)),retained:plan.units.filter(u=>disposition.retained.includes(u.id)),warning:'API status supplies scheduling only. Final proof must authenticate every original/replacement artifact, assertion and runtime.'};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({tier:impactContext.plan.tier,reasons:impactContext.plan.reasons,selectedTests:impactContext.plan.run.length,fresh:result.required.map(u=>({id:u.id,kind:u.kind,files:u.files.length})),retained:result.retained.length}));
