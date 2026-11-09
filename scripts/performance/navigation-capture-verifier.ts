/** Live GitHub provenance + immutable reviewed source + actual browser capture.
 * This capability is DEVELOPMENT ONLY and cannot issue a release/installation grant. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {downloadCiArchives,readCiArchive} from '../../.github/ci/archive-downloads.mjs';
import {NAVIGATION_CAPTURE_ARTIFACT,NAVIGATION_CAPTURE_MEMBER,NAVIGATION_CAPTURE_VERSION,validateNavigationCapture,
 type NavigationCaptureBundle,type NavigationScenarioPlan} from './navigation-protocol';
import {navigationCleanHead,navigationSourceIdentity} from './navigation-source';
const REPOSITORY='StradaverseHub/ai-hr',REPOSITORY_ID=1333414856,WORKFLOW_ID=395862645,WORKFLOW_PATH='.github/workflows/alpha-focused-checks.yml';
const controllerRoot=fileURLToPath(new URL('../../',import.meta.url));
export type VerifiedNavigationDevelopmentData={scope:'authenticated-development-runtime';releaseAuthorized:false;candidateSha:string;controllerSha:string;
 runId:number;runAttempt:1;runUrl:string;artifactId:number;artifactDigest:string;harnessSha256:string;scenarioSha256:string;plan:NavigationScenarioPlan;
 captures:NavigationCaptureBundle;evidenceDirectory:string;verifiedAt:string;expiresAt:string};
const authenticated=new WeakMap<object,Readonly<VerifiedNavigationDevelopmentData>>();
function deepFreeze<T>(value:T):Readonly<T>{
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}
 return value as Readonly<T>;
}
/** A JSON object, copied token, flag or callback cannot confer this private brand. */
export function readVerifiedNavigationDevelopmentEvidence(token:unknown):Readonly<VerifiedNavigationDevelopmentData>|undefined{
 const data=token!==null&&typeof token==='object'?authenticated.get(token):undefined;
 return data&&Date.now()<=Date.parse(data.expiresAt)?data:undefined;
}
function api(path:string):any{
 return JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{maxBuffer:8*1024*1024,timeout:30000}).toString());
}
function inventory(path:string,key:'jobs'|'artifacts'){
 const rows:any[]=[];let expected:number|undefined;
 for(let page=1;page<=10;page++){
  const response=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
  const count:unknown=response.total_count;
  assert(typeof count==='number'&&Number.isSafeInteger(count)&&count>=0&&count<=1000&&Array.isArray(response[key]),'Unbounded GitHub navigation inventory');
  expected??=count;assert(count===expected,'GitHub navigation inventory changed');
  rows.push(...response[key]);assert(rows.length<=expected,'Duplicate or inconsistent GitHub navigation inventory');
  if(response[key].length<100||rows.length===expected){assert(rows.length===expected,'Incomplete GitHub navigation inventory');return rows;}
 }
 throw Error('GitHub navigation inventory exceeds pagination bound');
}
function freshTimestamp(value:unknown,now:number){
 const time=typeof value==='string'?Date.parse(value):NaN;
 assert(Number.isFinite(time)&&time<=now+60000&&now-time<=24*60*60*1000,'Navigation run is stale or future dated');return time;
}
/** Only this function can mint the opaque capability, after live API and byte verification.
 * No injectable transport/factory is part of the production interface. */
export async function verifyNavigationDevelopmentRun({runId,candidateRoot}:{runId:number;candidateRoot:string}):Promise<object>{
 assert(Number.isSafeInteger(runId)&&runId>0,'Exact navigation run ID required');
 const candidate=resolve(candidateRoot),candidateSha=navigationCleanHead(candidate),controllerSha=navigationCleanHead(controllerRoot);
 const source=navigationSourceIdentity(candidate,candidateSha),controller=navigationSourceIdentity(controllerRoot,controllerSha);
 assert(source.harnessSha256===controller.harnessSha256&&source.scenarioSha256===controller.scenarioSha256,'Candidate navigation harness differs from trusted executing controller');
 const now=Date.now(),run=api(`actions/runs/${runId}`),workflow=api(`actions/workflows/${WORKFLOW_ID}`);
 assert(workflow.id===WORKFLOW_ID&&workflow.path===WORKFLOW_PATH&&workflow.state==='active','Unexpected navigation workflow');
 assert(run.id===runId&&run.repository?.id===REPOSITORY_ID&&run.repository?.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign navigation run/repository');
 assert(run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.event==='workflow_dispatch'&&['main','alpha'].includes(run.head_branch)&&run.head_sha===controllerSha,'Untrusted navigation workflow/controller');
 assert(run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===1,'Navigation run is incomplete, unsuccessful or rerun');
 const began=freshTimestamp(run.run_started_at,now),updated=freshTimestamp(run.updated_at,now);assert(updated>=began,'Navigation run time order differs');
 const jobs=inventory(`actions/runs/${runId}/jobs?filter=all`,'jobs');
 assert(new Set(jobs.map(job=>job.id)).size===jobs.length,'Duplicate navigation jobs');
 for(const name of ['resolve','system-http-browser-load']){
  const matches=jobs.filter(job=>job.name===name);assert(matches.length===1,'Missing or ambiguous navigation producer job');
  const job=matches[0];assert(job.run_id===runId&&job.head_sha===controllerSha&&job.run_attempt===1&&job.status==='completed'&&job.conclusion==='success','Navigation producer did not succeed on exact controller');
  assert(freshTimestamp(job.started_at,now)>=began&&freshTimestamp(job.completed_at,now)>=Date.parse(job.started_at),'Navigation job time order differs');
 }
 const artifacts=inventory(`actions/runs/${runId}/artifacts`,'artifacts'),matches=artifacts.filter(row=>row.name===NAVIGATION_CAPTURE_ARTIFACT);
 assert(matches.length===1&&new Set(artifacts.map(row=>row.id)).size===artifacts.length,'Missing or ambiguous navigation artifact');
 const artifact=matches[0],provenance=artifact.workflow_run;
 assert(provenance?.id===runId&&provenance.repository_id===REPOSITORY_ID&&provenance.head_repository_id===REPOSITORY_ID&&provenance.head_sha===controllerSha&&provenance.head_branch===run.head_branch,'Navigation artifact provenance differs');
 assert(artifact.expired===false&&Number.isSafeInteger(artifact.id)&&artifact.id>0&&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=64*1024*1024&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest??''),'Invalid navigation artifact boundary');
 assert(freshTimestamp(artifact.created_at,now)>=began&&freshTimestamp(artifact.updated_at,now)>=Date.parse(artifact.created_at),'Navigation artifact freshness differs');
 const evidenceDirectory=mkdtempSync(join(tmpdir(),'aihr-navigation-development-'));
 const download=await downloadCiArchives([artifact],evidenceDirectory,{concurrency:1});
 const zip=join(evidenceDirectory,NAVIGATION_CAPTURE_ARTIFACT+'.zip');readCiArchive(artifact,zip);
 const extracted=join(evidenceDirectory,'capture');
 execFileSync('python3',[join(controllerRoot,'scripts/performance/navigation-capture-extract.py'),zip,extracted],{timeout:30000,maxBuffer:1024*1024});
 // Recheck authenticated bytes after extraction; extracted content is never executed.
 readCiArchive(artifact,zip);
 const json=(name:string)=>JSON.parse(readFileSync(join(extracted,name),'utf8'));
 const runner=json('runner.json'),http=json('http-browser.json'),captures=json(NAVIGATION_CAPTURE_MEMBER) as NavigationCaptureBundle;
 assert(runner.kind==='ISOLATED_HTTP_BROWSER_DEVELOPMENT_ONLY'&&runner.releaseEligible===false&&runner.sha===candidateSha&&runner.controller===controllerSha&&runner.run===String(runId)&&runner.exitCode===0,'Navigation runner source/outcome differs');
 assert(runner.runtimeAcceptance?.pass===true&&Array.isArray(runner.runtimeAcceptance.failures)&&runner.runtimeAcceptance.failures.length===0,'Native runtime acceptance did not pass');
 assert(['HTTP_WORKFLOW_PREFLIGHT_ONLY','HTTP_AND_CHROMIUM_DEVELOPMENT_ONLY'].includes(http.kind)&&http.releaseEligible===false&&['whole-system','workflow-preflight'].includes(http.suite),'Unexpected navigation HTTP/browser suite');
 for(const key of ['functionalErrors','browserErrors','homeCardFailures'])assert(Array.isArray(http[key])&&http[key].length===0,'HTTP/browser runtime failures remain');
 assert(captures&&Object.keys(captures).every(key=>['schemaVersion','protocol','releaseAuthorized','baseline','loaded'].includes(key))&&captures.schemaVersion===1&&captures.protocol===NAVIGATION_CAPTURE_VERSION&&captures.releaseAuthorized===false,'Invalid development navigation capture bundle');
 const expected={candidateSha,controllerSha,runId,harnessSha256:source.harnessSha256,scenarioSha256:source.scenarioSha256};
 validateNavigationCapture(captures.baseline,source.plan,{...expected,phase:'baseline'});
 if(captures.loaded){
  assert(http.kind==='HTTP_AND_CHROMIUM_DEVELOPMENT_ONLY'&&http.suite==='whole-system'&&http.users===500&&http.latencyTargetMet===true,'Loaded navigation lacks successful 500-user HTTP/browser load');
  assert(Array.isArray(http.browserLoad?.errors)&&http.browserLoad.errors.length===0,'Loaded browser journeys failed');
  validateNavigationCapture(captures.loaded,source.plan,{...expected,phase:'loaded'});
 }else assert(http.kind==='HTTP_WORKFLOW_PREFLIGHT_ONLY'&&http.suite==='workflow-preflight'&&http.users===0,'Loaded workflow did not include loaded navigation capture');
 assert(navigationCleanHead(candidate)===candidateSha&&navigationCleanHead(controllerRoot)===controllerSha,'Navigation source changed during verification');
 const data=deepFreeze({scope:'authenticated-development-runtime' as const,releaseAuthorized:false as const,candidateSha,controllerSha,runId,runAttempt:1 as const,
  runUrl:`https://github.com/${REPOSITORY}/actions/runs/${runId}`,artifactId:artifact.id,artifactDigest:artifact.digest,harnessSha256:source.harnessSha256,
  scenarioSha256:source.scenarioSha256,plan:source.plan,captures,evidenceDirectory,verifiedAt:new Date().toISOString(),expiresAt:new Date(began+24*60*60*1000).toISOString()});
 writeFileSync(join(evidenceDirectory,'authenticated-metadata.json'),JSON.stringify({run,workflow,jobs,artifact,download,scope:data.scope,releaseAuthorized:false},null,2)+'\n',{mode:0o600,flag:'wx'});
 const token=Object.freeze({scope:data.scope,releaseAuthorized:false});authenticated.set(token,data);return token;
}
