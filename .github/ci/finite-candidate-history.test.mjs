import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {completeWorkflowRows,bindExecutionSource,classifyCandidateHistory,FINITE_SOURCE,PUBLISHED_CONTROLLER,knownProofBindings} from './finite-candidate-history.mjs';
import {REPOSITORY,REPOSITORY_ID,digest} from './release-policy.mjs';
const workflows=[395777276,999,395862646],stamp='2026-10-30T03:00:00Z';
const row=(id,workflow_id=999)=>({id,workflow_id,event:'workflow_dispatch',head_branch:'main',head_sha:PUBLISHED_CONTROLLER,status:'completed',conclusion:'failure',run_attempt:1,created_at:'2020-01-01T00:00:00Z',updated_at:stamp});
const original={id:41028659062,updated_at:'2026-10-30T02:00:00Z'};
test('complete unfiltered API history includes old-created newly-failed executions and refuses omissions',()=>{
 const rows=Array.from({length:1237},(_,i)=>row(i+1));const queries=[];
 const api=path=>{queries.push(path);const [,w,p]=path.match(/workflows\/(\d+)\/runs\?per_page=100&page=(\d+)/);return {total_count:Number(w)===999?rows.length:0,workflow_runs:Number(w)===999?rows.slice((p-1)*100,p*100):[]};};
 assert.equal(completeWorkflowRows(workflows,api).length,1237);assert(queries.every(q=>!q.includes('created=')));
 assert.throws(()=>completeWorkflowRows(workflows,p=>({...api(p),total_count:1238})),/omitted/);
 assert.throws(()=>completeWorkflowRows(workflows,p=>{const a=api(p);if(p.endsWith('page=2'))a.total_count++;return a;}),/count changed/);
 assert.throws(()=>completeWorkflowRows(workflows,p=>{const a=api(p);if(p.includes('/999/')&&p.endsWith('page=2'))a.workflow_runs[0]=rows[0];return a;}),/Repeated/);
});
test('unknown arbitrary aliases require source binding regardless title or old creation date',()=>{
 const r={...row(12),display_title:'Focused only · deleted-arbitrary-alias'};
 const input={rows:[r],original,knownBindings:[],workflowIds:workflows,bindings:new Map()};
 assert.throws(()=>classifyCandidateHistory(input),/Unresolved source/);
 const binding={kind:'AUTHENTICATED_ARCHIVE_SOURCE_BINDING',runId:12,source:FINITE_SOURCE,controller:PUBLISHED_CONTROLLER};
 assert.throws(()=>classifyCandidateHistory({...input,bindings:new Map([[12,binding]])}),/Unaccounted same-source/);
 const out=classifyCandidateHistory({...input,bindings:new Map([[12,{...binding,source:'e'.repeat(40)}]])});assert.equal(out.records[0].classification,'AUTHENTICATED_OTHER_SOURCE');assert.equal(out.releaseAuthorized,false);
 assert.throws(()=>classifyCandidateHistory({...input,rows:[{...r,head_sha:'c'.repeat(40)}]}),/changed published/);
 const noncanonical=classifyCandidateHistory({...input,rows:[{...r,head_branch:'codex/independent-controller',head_sha:'c'.repeat(40)}]});assert.equal(noncanonical.records[0].classification,'OUTSIDE_CANONICAL_EXECUTION_CONTRACT');assert.equal(noncanonical.scope.noncanonicalExecutionsAreNotSourceObservations,true);
});
const zip=entries=>execFileSync('python3',['-c','import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,v)) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:JSON.stringify(entries)});
test('real ZIP digest and bounded Python reader bind historical source; missing producers and tampering refuse',()=>{
 const directory=mkdtempSync(join(tmpdir(),'finite-source-'));const r=row(12);
 const packet={kind:'FOCUSED_ONLY',sha:'e'.repeat(40),controller:PUBLISHED_CONTROLLER,runId:'12',attempt:'1'};
 const bytes=zip({'focused.json':JSON.stringify(packet)});
 const artifact={id:71,name:'focused-development-evidence',expired:false,size_in_bytes:bytes.length,digest:digest(bytes),created_at:'2026-10-30T03:01:00Z',expires_at:'2030-01-01T00:00:00Z',workflow_run:{id:12,repository_id:REPOSITORY_ID,head_repository_id:REPOSITORY_ID,head_sha:PUBLISHED_CONTROLLER,head_branch:'main'}};
 const m={run:{...r,repository:{id:REPOSITORY_ID,full_name:REPOSITORY},head_repository:{id:REPOSITORY_ID}},jobs:[{id:13,name:'selected-tests',run_id:12,run_attempt:1,head_sha:PUBLISHED_CONTROLLER,head_branch:'main',status:'completed',started_at:stamp,completed_at:'2026-10-30T03:02:00Z'}],artifacts:[artifact]};
 const run=metadata=>bindExecutionSource({row:r,directory,readMetadata:()=>metadata,download:()=>bytes});
 try{
  assert.equal(run(m).source,packet.sha);
  assert.equal(run({...m,jobs:[]}).kind,'UNRESOLVED');assert.equal(run({...m,artifacts:[]}).kind,'UNRESOLVED');
  for(const mutate of [x=>x.run.repository.id++,x=>x.artifacts[0].workflow_run.head_sha='f'.repeat(40),x=>x.artifacts[0].digest='sha256:'+'0'.repeat(64),x=>x.jobs[0].run_attempt=2,x=>x.artifacts.push(x.artifacts[0])]){const bad=structuredClone(m);mutate(bad);assert.throws(()=>run(bad));}
  const path=join(directory,'source-12-71.zip');writeFileSync(path,Buffer.alloc(bytes.length));assert.throws(()=>run(m),/digest/);
  const script=fileURLToPath(new URL('./finite-history-source-extract.py',import.meta.url));
  for(const entries of [{'focused.json':'{}','../escape':'x'},{'other.json':'{}'}]){writeFileSync(path,zip(entries));assert.throws(()=>execFileSync('python3',[script,path,'focused.json'],{stdio:'pipe'}));}
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('a fabricated installable result cannot enter the immutable diagnostic proof adapter',()=>{
 assert.throws(()=>knownProofBindings({sha:FINITE_SOURCE,result:'PASS',installationEligible:true,recovery:{}},999),/Exact frozen managed proof/);
});
