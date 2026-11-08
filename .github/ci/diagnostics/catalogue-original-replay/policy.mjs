/** Metadata validation only. Caller JSON never becomes API authentication. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const CONTRACT=freeze(JSON.parse(readFileSync(new URL('contract.json',import.meta.url),'utf8')));
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fields=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value?.[key]]));
export function validateOriginalMetadata({run,jobs,artifacts,workflow}){
 assert(run&&typeof run==='object'&&!Array.isArray(run),'Original run refused');
 assert.deepEqual(fields(run,Object.keys(CONTRACT.run)),CONTRACT.run,'Original run identity refused');
 for(const key of ['repository','head_repository'])assert.deepEqual(fields(run[key],['id','full_name']),CONTRACT.repository,'Original repository refused');
 assert.equal(run.repository.private,false);assert.deepEqual(fields(workflow,['id','path']),CONTRACT.workflow,'Original workflow refused');assert.equal(workflow.state,'active');
 assert(jobs&&jobs.total_count===14&&Array.isArray(jobs.jobs)&&jobs.jobs.length===14,'Complete original jobs required');
 assert.equal(new Set(jobs.jobs.map(job=>job.id)).size,14);assert.equal(new Set(jobs.jobs.map(job=>job.name)).size,14);
 const actualJobs=jobs.jobs.map(job=>fields(job,Object.keys(CONTRACT.jobs[0]))).sort((a,b)=>a.id-b.id);assert.deepEqual(actualJobs,CONTRACT.jobs,'Original complete job inventory refused');
 assert(artifacts&&artifacts.total_count===4&&Array.isArray(artifacts.artifacts)&&artifacts.artifacts.length===4,'Complete original artifacts required');
 assert.equal(new Set(artifacts.artifacts.map(a=>a.id)).size,4);assert.equal(new Set(artifacts.artifacts.map(a=>a.name)).size,4);
 for(const actual of artifacts.artifacts){const expected=CONTRACT.artifacts.find(row=>row.id===actual.id);assert(expected,'Unknown original artifact');const{members,...metadata}=expected;
  assert.deepEqual({...fields(actual,['id','name','size_in_bytes','digest','expired']),workflow_run:fields(actual.workflow_run,Object.keys(metadata.workflow_run))},metadata,'Original artifact identity refused');
 }
 return{run:CONTRACT.run,jobs:CONTRACT.jobs,artifacts:CONTRACT.artifacts.map(({members,...row})=>row),workflow:CONTRACT.workflow};
}
export function originalReconstructionEnvironment(environment){
 const safe={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',LANG:'C',LC_ALL:'C',TZ:'UTC',NODE_NO_WARNINGS:'1',RUNNER_TEMP:environment.RUNNER_TEMP,
  AIHR_CI_HEAD:CONTRACT.originalCandidate,AIHR_CI_CONTROL_HEAD:CONTRACT.originalController,AIHR_CI_MIGRATION_BASE:CONTRACT.originalMigrationBase,
  AIHR_CI_CLASSIFIER_RUNTIME:'native',AIHR_ORIGINAL_REPLAY_SCOPE:'old-plan-comparison-only'};
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])safe[key]='postgres://nobody:nothing@127.0.0.1:1/no_database';
 return safe;
}
export const FAILURE_PHASES=Object.freeze(['admission','api-before','download','extract','api-after','comparison','api-final','publish']);
export function publicFailure(phase){assert(FAILURE_PHASES.includes(phase));return{kind:'ORIGINAL_CATALOGUE_REPLAY_DIAGNOSTIC',complete:false,phase,expectedProfileAuthorized:false,releaseAuthorized:false};}
/** Output failure must not replace a closed refusal with a raw filesystem error. */
export function publishPublicFailure(phase,publish){
 const bytes=JSON.stringify(publicFailure(phase),null,2)+'\n';
 try{publish(bytes);return true;}catch{return false;}
}
export function validatePublicComparison(value){
 assert(value&&Object.keys(value).sort().join('|')===['kind','originalRun','originalCandidate','originalController','originalPlanFingerprint','originalPlanReconstructed','units','members','comparison','expectedProfileAuthorized','releaseAuthorized','completeSuite'].sort().join('|'),'Closed comparison result required');
 assert.equal(value.kind,'VERIFIED_ORIGINAL_CATALOGUE_PAIR_NOT_PROFILE');assert.equal(value.originalRun,String(CONTRACT.run.id));assert.equal(value.originalCandidate,CONTRACT.originalCandidate);assert.equal(value.originalController,CONTRACT.originalController);assert.equal(value.originalPlanFingerprint,CONTRACT.originalPlanFingerprint);assert.equal(value.originalPlanReconstructed,true);
 assert.equal(value.expectedProfileAuthorized,false);assert.equal(value.releaseAuthorized,false);assert.equal(value.completeSuite,false);
 assert.deepEqual(value.units.map(row=>({id:row.id,tests:row.tests,files:row.files,sourceMembers:row.sourceMembers})),CONTRACT.pairs.map(row=>({id:row.unit,tests:1,files:[row.file],sourceMembers:1738})));
 assert(value.units.every(row=>Object.keys(row).sort().join('|')==='files|id|sourceMembers|tests'));
 assert.equal(value.members.length,10);const names=['notification-canonical-source.json','notification-canonical-raw.json','notification-canonical-normalized.json','notification-canonical-report.json'];
 for(const pair of CONTRACT.pairs){const records=value.members.filter(row=>row.mode===pair.mode);assert.equal(records.length,5);assert.equal(new Set(records.map(row=>row.name)).size,5);assert.deepEqual(records.map(row=>row.name).sort(),[...names,`personnel-dd-full-role-${pair.unit}-offset-0.json`].sort());}
 for(const row of value.members)assert(Object.keys(row).sort().join('|')==='bytes|mode|name|sha256'&&Number.isSafeInteger(row.bytes)&&row.bytes>0&&row.bytes<=(row.name.startsWith('personnel-')?32768:16*1024**2)&&typeof row.sha256==='string'&&row.sha256.length===64&&/^[a-f0-9]+$/.test(row.sha256));
 const c=value.comparison;assert(c&&Object.keys(c).sort().join('|')==='defaultFunctions|exactRawDefaultsEqual|functionCount|shiftedFunctions');assert.equal(c.functionCount,2308);assert.equal(c.exactRawDefaultsEqual,true);assert(Number.isSafeInteger(c.defaultFunctions)&&c.defaultFunctions>=0&&c.defaultFunctions<=2308);assert(Number.isSafeInteger(c.shiftedFunctions)&&c.shiftedFunctions>0&&c.shiftedFunctions<=2308);
 return value;
}
