/** Actual compiler-only process and source checkout; no application test coverage is inferred. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {installHash} from './ci-install-grant.mjs';
import {fetchGitHubRunSnapshot,githubSnapshotIdentity} from './retained-units.mjs';
import {isDeepStrictEqual} from 'node:util';
const SHA='d52563c666d39074217ed42191866add4a2793a0',CTRL='dc74b804fcecb4bab3207e82c9b9f099b9bf13be';
export function bonusCompilerCheckoutPins(log){
 assert(typeof log==='string'&&Buffer.byteLength(log)<=16*1024**2,'Bounded actual compiler log required');
 const rows=log.split('\n'),pins=[];
 for(let i=0;i<rows.length-1;i++){
  const columns=rows[i].split('\t');
  if(columns.length!==3||columns[0]!=='typecheck'||columns[1]!=='Run actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'
   ||!columns[2].endsWith('[command]/usr/bin/git log -1 --format=%H'))continue;
  const next=rows[i+1].split('\t');assert(next.length===3&&next[0]===columns[0]&&next[1]===columns[1],'Actual checkout step continuity required');
  const match=/^\d{4}-\d\d-\d\dT\S+Z ([a-f0-9]{40})$/.exec(next[2]);assert(match,'Exact Git checkout commit line required');pins.push(match[1]);
 }
 assert(isDeepStrictEqual(pins,[CTRL,SHA]),'Controller/source checkout identities differ');return pins;
}
export function inspectBonusCompiler(snapshot,now=Date.now()){
 const {run,jobs}=snapshot;
 assert(run?.id===40507897305&&run.repository?.id===1333414856&&run.repository.full_name==='StradaverseHub/ai-hr'&&run.head_repository?.id===1333414856
  &&run.workflow_id===395862645&&run.path==='.github/workflows/alpha-focused-checks.yml'&&run.head_sha===CTRL&&run.head_branch==='alpha'
  &&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Exact successful compiler-only run required');
 assert(Date.parse(run.created_at)<=Date.parse(run.updated_at)&&Date.parse(run.updated_at)<=now+60000&&now-Date.parse(run.created_at)<=86400000,'Compiler evidence expired');
 assert(jobs.length===4&&new Set(jobs.map(j=>j.name)).size===4&&new Set(jobs.map(j=>j.id)).size===4,'Exact compiler-only job inventory required');
 for(const j of jobs)assert(j.run_id===run.id&&j.head_sha===CTRL&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed'
  &&(['resolve','typecheck','selected-tests'].includes(j.name)?j.conclusion==='success':j.name==='linux-build'&&j.conclusion==='skipped'),'Unexpected compiler-only job execution');
 for(const [name,step] of [['typecheck','Run pnpm exec next typegen'],['typecheck','Run bash ../automation/.github/ci/typecheck.sh']]){
  const job=jobs.find(j=>j.name===name),steps=job.steps.filter(s=>s.name===step);assert(steps.length===1&&steps[0].status==='completed'&&steps[0].conclusion==='success','Canonical compiler step did not execute successfully');}
 return jobs.find(j=>j.name==='typecheck');
}
export function authenticateBonusCompiler({repository}){
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',maxBuffer:128*1024});
 const trusted='9bf924ff3389fd5f5a41c03d062a40c429216585',path='.github/workflows/alpha-focused-checks.yml';
 assert(git('diff','--name-only',trusted,CTRL,'--',path).trim()==='','Actual alpha compiler workflow differs from reviewed staging controller');
 const after=git('show',CTRL+':'+path),job=s=>{const a=s.indexOf('\n  typecheck:\n'),b=s.indexOf('\n  linux-build:\n',a);assert(a>=0&&b>a);return s.slice(a,b);};
 const first=fetchGitHubRunSnapshot(40507897305),producer=inspectBonusCompiler(first);
 const log=execFileSync('gh',['run','view','40507897305','--repo','StradaverseHub/ai-hr','--job',String(producer.id),'--log'],{encoding:'utf8',maxBuffer:16*1024**2,timeout:30000});
 bonusCompilerCheckoutPins(log);assert(log.includes('/node/22.23.3/'),'Actual compiler setup runtime must be22.23.3');const second=fetchGitHubRunSnapshot(40507897305);inspectBonusCompiler(second);
 assert(isDeepStrictEqual(githubSnapshotIdentity(first),githubSnapshotIdentity(second))&&isDeepStrictEqual(first.jobs,second.jobs),'Compiler origin changed during authentication');
 return {kind:'AUTHENTICATED_WHOLE_COMPILER_ONLY_NOT_TEST_COVERAGE',candidate:SHA,controller:CTRL,runId:first.run.id,jobId:producer.id,
  checkoutPins:[CTRL,SHA],runtime:{node:'22.23.3',platform:'linux',arch:'x64'},canonicalJobSha256:installHash(job(after)),logSha256:installHash(log),conclusion:'success',snapshot:second,releaseAuthorized:false};
}
