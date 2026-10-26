/** Next application compiler graph only; every admitted run still performs the canonical build. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const NEXT_STATE_NAME='diagnostic-next-app-compiler-state';
export const NEXT_STATE_MEMBERS=['build-log.json','build-provenance.json','envelope.json','producer.json','state.json','successful-build.json','system-testing.json'];
export const NEXT_CACHE_WORKFLOW='.github/workflows/alpha-staging-build-cache-diagnostic.yml';
export const NEXT_CACHE_REF='StradaverseHub/ai-hr/'+NEXT_CACHE_WORKFLOW+'@refs/heads/codex/test-suite-efficiency-review-20261025';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const validSha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
export const validId=v=>/^[1-9][0-9]{0,15}$/.test(String(v))&&Number.isSafeInteger(Number(v));
export function assertNextCacheInvocation(e){
 assert(e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'
  &&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_WORKFLOW_REF===NEXT_CACHE_REF
  &&e.GITHUB_JOB==='next-build-cache'&&e.GITHUB_RUN_ATTEMPT==='1'&&validId(e.GITHUB_RUN_ID)
  &&validSha(e.AIHR_CI_HEAD)&&e.AIHR_CI_HEAD===e.AIHR_CI_CONTROL_HEAD&&e.GITHUB_SHA===e.AIHR_CI_CONTROL_HEAD
  &&['cold','warm'].includes(e.AIHR_NEXT_BUILD_CACHE_MODE)&&e.AIHR_BUILD_DIAGNOSTIC==='transport-producer','Exact first-attempt build-cache diagnostic required');
 for(const k of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])
  assert(e[k]==='postgres://nobody:nothing@127.0.0.1:1/no_database','Build cache diagnostic cannot reach a database');
}
export function parseNextCacheOrigin(text){
 const p=JSON.parse(text);
 assert(isDeepStrictEqual(Object.keys(p).sort(),['artifactId','digest','runId','sha']),'Exact origin selector required');
 assert(validId(p.runId)&&validId(p.artifactId)&&validSha(p.sha)&&/^[a-f0-9]{64}$/.test(p.digest),'Malformed origin selector');
 return p;
}
export function validateNextOrigin(origin,run,jobs,artifact){
 assert(run.id===Number(origin.runId)&&run.run_attempt===1&&run.event==='workflow_dispatch'&&run.head_sha===origin.sha&&run.path===NEXT_CACHE_WORKFLOW
  &&run.head_branch==='codex/test-suite-efficiency-review-20261025'&&run.repository?.full_name==='StradaverseHub/ai-hr'&&run.repository.id===1333414856&&run.head_repository?.id===1333414856,'Authenticated original build run differs');
 assert(jobs.total_count===jobs.jobs.length&&jobs.jobs.length<100,'Complete original job inventory required');
 const matches=jobs.jobs.filter(j=>j.name==='next-build-cache');assert(matches.length===1);
 const j=matches[0];
 assert(j.run_id===run.id&&j.run_attempt===1&&j.head_sha===origin.sha&&j.status==='completed'&&j.conclusion==='success','Successful original canonical build job required');
 assert(artifact.id===Number(origin.artifactId)&&artifact.name===NEXT_STATE_NAME&&!artifact.expired&&artifact.workflow_run?.id===run.id
  &&artifact.workflow_run.head_sha===origin.sha&&artifact.workflow_run.repository_id===1333414856&&artifact.workflow_run.head_repository_id===1333414856
  &&artifact.digest==='sha256:'+origin.digest&&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=64*1024**2,'Authenticated original state artifact differs');
 return j;
}
export function validateNextContext(c){
 assert(c&&isDeepStrictEqual(Object.keys(c).sort(),['compiler','generatedTypes','inputs','nodeOptions','runtime','sourcePath']),'Next compiler context differs');
 assert(isDeepStrictEqual(c.runtime,{node:'20.20.2',abi:'115',platform:'linux',arch:'x64',glibc:'2.39',next:'16.3.8',typescript:'5.9.3'}),'Exact application-build runtime required');
 assert(c.nodeOptions==='--max-old-space-size=6144'&&/^\/home\/runner\/work\/ai-hr\/ai-hr\/source$/.test(c.sourcePath),'Actual application build path/heap required');
 const inputs=['tsconfig.json','tsconfig.build.json','pnpm-lock.yaml','package.json','pnpm-workspace.yaml','next.config.ts','deploy/css-cache-guard.sh','cssInputs'];
 assert(isDeepStrictEqual(Object.keys(c.inputs).sort(),inputs.sort())&&Object.values(c.inputs).every(v=>/^[a-f0-9]{64}$/.test(v)),'All application compiler/config/CSS inputs required');
 const binaries=['typescript/package.json','typescript/lib/tsc.js','typescript/lib/_tsc.js','typescript/lib/typescript.js','next/dist/lib/typescript/runTypeCheckCli.js','next/dist/lib/typescript/runTypeScriptCli.js','next/dist/lib/typescript/runTypeCheck.js','next/dist/build/type-check.js'];
 assert(isDeepStrictEqual(Object.keys(c.compiler).sort(),binaries.sort())&&Object.values(c.compiler).every(v=>/^[a-f0-9]{64}$/.test(v)),'Actual Next/TypeScript implementations required');
 assert(Array.isArray(c.generatedTypes)&&c.generatedTypes.length>0&&c.generatedTypes.length<10000);
 assert(new Set(c.generatedTypes.map(r=>r.path)).size===c.generatedTypes.length,'Duplicate generated type path');
 for(const r of c.generatedTypes)assert(isDeepStrictEqual(Object.keys(r).sort(),['bytes','path','sha256'])&&typeof r.path==='string'&&r.path.length>0&&!r.path.startsWith('/')&&!r.path.split('/').some(p=>p==='.'||p==='..')&&Number.isSafeInteger(r.bytes)&&r.bytes>=0&&/^[a-f0-9]{64}$/.test(r.sha256),'Generated application types differ');
 return c;
}
export function validateNextState(bytes,envelope,expectedSource,context,{now=Date.now()}={}){
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=64*1024**2);
 const data=JSON.parse(bytes);
 assert(data.version==='5.9.3'&&Array.isArray(data.fileNames)&&data.fileNames.length>0&&data.fileNames.length<=100000
  &&new Set(data.fileNames).size===data.fileNames.length&&data.fileNames.every(p=>typeof p==='string'&&p.length>0),'Complete bounded application graph required');
 assert(envelope?.kind==='NEXT_APPLICATION_COMPILER_STATE_BUILD_MUST_RUN'&&envelope.releaseAuthorized===false&&envelope.source===expectedSource
  &&validSha(envelope.controller)&&validId(envelope.runId)&&envelope.attempt==='1'&&envelope.actualCanonicalBuildExit===0
  &&envelope.bytes===bytes.length&&envelope.sha256===hash(bytes)&&envelope.files===data.fileNames.length,'Original graph bytes/build provenance differ');
 assert(isDeepStrictEqual(validateNextContext(envelope.context),validateNextContext(context)),'Application compiler inputs changed');
 const age=now-Date.parse(envelope.completedAt);assert(Number.isFinite(age)&&age>=-60000&&age<=86400000,'Application compiler graph expired');
 return data;
}
export function assertNextAncestry(origin,current,comparison){
 assert(validSha(origin)&&validSha(current));
 if(origin===current){assert(comparison===null);return [];}
 assert(comparison?.status==='ahead'&&comparison.behind_by===0&&comparison.base_commit?.sha===origin&&comparison.merge_base_commit?.sha===origin
  &&Number.isSafeInteger(comparison.ahead_by)&&comparison.ahead_by>0&&comparison.ahead_by<=32&&comparison.total_commits===comparison.ahead_by
  &&comparison.commits.length===comparison.total_commits&&comparison.commits.every(c=>validSha(c.sha))&&new Set(comparison.commits.map(c=>c.sha)).size===comparison.commits.length
  &&comparison.commits.at(-1)?.sha===current&&Array.isArray(comparison.files)&&comparison.files.length>0&&comparison.files.length<300,'Complete bounded ancestor comparison required');
 assert(new Set(comparison.files.map(f=>f.filename)).size===comparison.files.length);
 for(const f of comparison.files)assert(typeof f.filename==='string'&&f.filename.length>0&&!f.filename.includes('\0')&&!f.filename.split('/').some(p=>p==='.'||p==='..')
  &&['modified','added','removed','renamed','copied','changed'].includes(f.status),'Unsafe changed-file inventory');
 return comparison.files.map(f=>f.filename);
}
