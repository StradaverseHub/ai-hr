/** Actual GitHub transport/ZIP/extractor/source-assessment pipeline with a local API executable. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture,put,now} from './resume-test-fixtures.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {validateRepairArchiveInventory,assertRepairRevalidation} from './repair-recovery.mjs';
test('real collector authenticates API/ZIP bytes, separates failure diagnostics, and revalidates unchanged original evidence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-repair-adapter-')),bin=join(root,'bin'),responses=join(root,'api'),directory=join(root,'evidence');mkdirSync(bin);mkdirSync(responses);
 const f=fixture(),unit=f.expectedPlan.units.find(u=>u.kind==='nodb'),report=f.reports.find(r=>r.id===unit.id);
 report.exitCode=1;report.batches[0].exitCode=1;report.batches[0].result.success=false;put(f,'unit-'+unit.id,'unit-'+unit.id+'.json',report);
 f.jobs.find(j=>j.name===`test (${unit.id})`).conclusion='failure';f.jobs.find(j=>j.name==='typecheck').conclusion='failure';f.jobs.find(j=>j.name==='build').conclusion='failure';
 put(f,'next-application-build-failure','comparison.json',{kind:'CANONICAL_CI_APPLICATION_COMPILER_STATE_NOT_RELEASE',releaseAuthorized:false,source:f.expected.candidate,controller:f.expected.controller,runId:String(f.run.id),attempt:'1'});
 const stateFile=join(responses,'state.json'),state=()=>writeFileSync(stateFile,JSON.stringify({run:f.run,jobs:f.jobs,artifacts:f.artifacts}));state();
 for(const a of f.artifacts)writeFileSync(join(responses,String(a.id)+'.zip'),f.archives.get(a.name));
 writeFileSync(join(bin,'gh'),'#!'+process.execPath+'\n'+
  'const fs=require("node:fs"),p=process.argv[3].split("?")[0],r=process.env.AIHR_FAKE_REPAIR_API,s=JSON.parse(fs.readFileSync(r+"/state.json"));if(p.endsWith("/artifacts"))process.stdout.write(JSON.stringify({artifacts:s.artifacts}));else if(p.endsWith("/jobs"))process.stdout.write(JSON.stringify({jobs:s.jobs}));else if(/artifacts\\/\\d+\\/zip$/.test(p))process.stdout.write(fs.readFileSync(r+"/"+p.split("/").at(-2)+".zip"));else process.stdout.write(JSON.stringify(s.run));\n',{mode:0o700});
 const previousPath=process.env.PATH,previousApi=process.env.AIHR_FAKE_REPAIR_API;process.env.PATH=bin+':'+previousPath;process.env.AIHR_FAKE_REPAIR_API=responses;
 const assess=source=>assessResumeSource({...source,expectedPlan:f.expectedPlan,expected:f.expected,now});
 const producer=name=>name==='gate-plan'?'plan':name==='next-application-build-failure'?'build':name.startsWith('unit-browser-')?`browser (${name.slice('unit-browser-'.length)})`:`test (${name.slice('unit-'.length)})`;
 try{
  const source=await collectRecoveryEvidence(f.run.id,directory,{includeRaw:true});validateRepairArchiveInventory(source,new Set(f.artifacts.map(a=>a.name)),producer,now);const checked=assess(source);
  assert.equal(checked.reusable.length,4);assert.equal(checked.rerun.length,1);assert.equal(source.run.conclusion,'failure');assert.equal(source.jobs.find(j=>j.name==='typecheck').conclusion,'failure');assert.equal(source.parsed.get('next-application-build-failure').get('comparison.json').releaseAuthorized,false);
  const fresh=await collectRecoveryEvidence(f.run.id,directory,{reuse:true});assert.deepEqual(assess(fresh),checked);
  const path=join(directory,'gate-plan.zip'),original=readFileSync(path);writeFileSync(path,Buffer.alloc(original.length,1));await assert.rejects(collectRecoveryEvidence(f.run.id,directory,{reuse:true}),/digest/);writeFileSync(path,original);
  f.run.run_attempt=2;state();await assert.rejects(collectRecoveryEvidence(f.run.id,directory,{reuse:true}),/rerun/);f.run.run_attempt=1;state();
  const a=f.artifacts[0];a.workflow_run.head_sha='f'.repeat(40);state();const foreign=await collectRecoveryEvidence(f.run.id,directory,{reuse:true});assert.throws(()=>validateRepairArchiveInventory(foreign,new Set(f.artifacts.map(a=>a.name)),producer,now),/foreign/);
 }finally{process.env.PATH=previousPath;if(previousApi===undefined)delete process.env.AIHR_FAKE_REPAIR_API;else process.env.AIHR_FAKE_REPAIR_API=previousApi;rmSync(root,{recursive:true,force:true});}
});
test('prelaunch comparison refuses certificate, canonical bytes or authenticated artifact identity drift',()=>{
 const e={recovery:{originalSha:'original',sha:'repair',originalArtifacts:[{id:1,digest:'original'}]},build:{source:'repair',archiveSha256:'canonical'},artifacts:[{id:2,digest:'replacement'}]};
 assert.equal(assertRepairRevalidation(e,structuredClone(e)),true);
 for(const change of [x=>x.recovery.originalArtifacts[0].digest='changed',x=>x.recovery.sha='foreign',x=>x.build.archiveSha256='foreign',x=>x.artifacts[0].id++]){const c=structuredClone(e);change(c);assert.throws(()=>assertRepairRevalidation(e,c));}
});
