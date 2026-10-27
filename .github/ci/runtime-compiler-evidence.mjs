/** Actual compiler-only process and source checkout; no application test coverage is inferred. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {installHash} from './ci-install-grant.mjs';
import {fetchGitHubRunSnapshot,githubSnapshotIdentity} from './retained-units.mjs';
import {isDeepStrictEqual} from 'node:util';
const SHA='e07a86340d1ced979868bf4359d73597301d0f15',CTRL='f050b1e4e881535f203839d5a34aed0a2a9f24ce';
export function compilerCheckoutPins(log){
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
export function inspectRuntimeCompiler(snapshot,now=Date.now()){
 const {run,jobs}=snapshot;
 assert(run?.id===40475176478&&run.repository?.id===1333414856&&run.repository.full_name==='StradaverseHub/ai-hr'&&run.head_repository?.id===1333414856
  &&run.workflow_id===395862645&&run.path==='.github/workflows/alpha-focused-checks.yml'&&run.head_sha===CTRL&&run.head_branch==='codex/letters-repair-compiler-only-20261027'
  &&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Exact successful compiler-only run required');
 assert(Date.parse(run.created_at)<=Date.parse(run.updated_at)&&Date.parse(run.updated_at)<=now+60000&&now-Date.parse(run.created_at)<=86400000,'Compiler evidence expired');
 assert(jobs.length===4&&new Set(jobs.map(j=>j.name)).size===4&&new Set(jobs.map(j=>j.id)).size===4,'Exact compiler-only job inventory required');
 for(const j of jobs)assert(j.run_id===run.id&&j.head_sha===CTRL&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed'
  &&(['resolve','typecheck'].includes(j.name)?j.conclusion==='success':['selected-tests','linux-build'].includes(j.name)&&j.conclusion==='skipped'),'Unexpected compiler-only job execution');
 for(const [name,step] of [['resolve','Refuse an invalid compiler-only request'],['typecheck','Run pnpm exec next typegen'],['typecheck','Run bash ../automation/.github/ci/typecheck.sh']]){
  const job=jobs.find(j=>j.name===name),steps=job.steps.filter(s=>s.name===step);assert(steps.length===1&&steps[0].status==='completed'&&steps[0].conclusion==='success','Canonical compiler step did not execute successfully');}
 return jobs.find(j=>j.name==='typecheck');
}
export function authenticateRuntimeCompiler({repository}){
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',maxBuffer:128*1024});
 assert(git('rev-parse',CTRL+'^').trim()==='abd8d5b462e984f80cb5bdf8ef471d048fe7437b','Compiler controller parent differs');
 assert(git('diff','--name-only',CTRL+'^',CTRL).trim()==='.github/workflows/alpha-focused-checks.yml','Compiler controller altered other inputs');
 const file=ref=>git('show',ref+':.github/workflows/alpha-focused-checks.yml');
 const before=file(CTRL+'^'),after=file(CTRL),job=s=>{const a=s.indexOf('\n  typecheck:\n'),b=s.indexOf('\n  linux-build:\n',a);assert(a>=0&&b>a,'Canonical compiler job boundaries required');return s.slice(a,b);};
 assert(job(before)===job(after),'Canonical compiler/setup job changed');
 const first=fetchGitHubRunSnapshot(40475176478),producer=inspectRuntimeCompiler(first);
 const log=execFileSync('gh',['run','view','40475176478','--repo','StradaverseHub/ai-hr','--job',String(producer.id),'--log'],{encoding:'utf8',maxBuffer:16*1024**2,timeout:30000});
 compilerCheckoutPins(log);const second=fetchGitHubRunSnapshot(40475176478);inspectRuntimeCompiler(second);
 assert(isDeepStrictEqual(githubSnapshotIdentity(first),githubSnapshotIdentity(second))&&isDeepStrictEqual(first.jobs,second.jobs),'Compiler origin changed during authentication');
 return {kind:'AUTHENTICATED_WHOLE_COMPILER_ONLY_NOT_TEST_COVERAGE',candidate:SHA,controller:CTRL,runId:first.run.id,jobId:producer.id,
  checkoutPins:[CTRL,SHA],canonicalJobSha256:installHash(job(after)),logSha256:installHash(log),conclusion:'success',snapshot:second,releaseAuthorized:false};
}
