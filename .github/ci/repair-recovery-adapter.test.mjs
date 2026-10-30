/** Actual GitHub transport/ZIP/extractor/source-assessment pipeline with a local API executable. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture,put,now} from './resume-test-fixtures.mjs';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
import {assessResumeSource} from './resume-source.mjs';
import {validateRepairArchiveInventory,assertRepairRevalidation,validateLatestRepairHistory} from './repair-recovery.mjs';
import {operatorRelease} from './operator-release.mjs';
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
test('actual deploy-repair boundary refuses pending/mismatched review before candidate access, transport or lease phase',async()=>{
 const previous=process.env.AIHR_REPAIR_REVIEWED_CONTROLLER;
 try{for(const value of [undefined,'f'.repeat(40)]){
  if(value===undefined)delete process.env.AIHR_REPAIR_REVIEWED_CONTROLLER;else process.env.AIHR_REPAIR_REVIEWED_CONTROLLER=value;
  await assert.rejects(operatorRelease({candidatePath:'/nonexistent-candidate-review-probe',execute:true,repair:{}}),/Exact independent verifier review required/);
 }}finally{if(previous===undefined)delete process.env.AIHR_REPAIR_REVIEWED_CONTROLLER;else process.env.AIHR_REPAIR_REVIEWED_CONTROLLER=previous;}
});
test('latest history does not lose overlapping failures, pending runs or executions on the original source branch',()=>{
 const source={run:{id:100,display_title:'Alpha CI · original',created_at:'2026-10-30T01:00:00Z',updated_at:'2026-10-30T02:00:00Z'}};
 const rows=[{id:200,display_title:'Focused only · repair',head_sha:'controller',status:'completed',conclusion:'success',run_attempt:1,created_at:'2026-10-30T02:10:00Z',updated_at:'2026-10-30T03:00:00Z'},{id:300,display_title:'Canonical build only · repair',head_sha:'controller',status:'completed',conclusion:'success',run_attempt:1,created_at:'2026-10-30T02:10:00Z',updated_at:'2026-10-30T03:00:00Z'}];
 const input={source,rows,candidateBranch:'repair',focusedRunIds:[200],buildRunId:300};assert.deepEqual(validateLatestRepairHistory(input).runIds,[200,300]);
 for(const title of ['Alpha CI · original','Alpha CI · repair','Focused only · repair'])for(const status of ['completed','in_progress']){
  const overlapping={id:400,display_title:title,created_at:'2026-10-30T01:30:00Z',updated_at:'2026-10-30T02:30:00Z',status,conclusion:status==='completed'?'failure':null,run_attempt:1};
  assert.throws(()=>validateLatestRepairHistory({...input,rows:[...rows,overlapping]}),/Unaccounted/);
 }
 assert.throws(()=>validateLatestRepairHistory({...input,rows:rows.slice(1)}),/Unaccounted/);
 for(const status of ['queued','in_progress','waiting','requested','pending']){
  const oldPending={id:401,display_title:'Focused only · repair',created_at:'2026-10-29T01:30:00Z',updated_at:'2026-10-29T01:30:00Z',status,conclusion:null,run_attempt:1};
  assert.throws(()=>validateLatestRepairHistory({...input,rows:[...rows,oldPending]}),/Unaccounted/);
 }
 assert.throws(()=>validateLatestRepairHistory({...input,rows:[...rows,{...rows[0],updated_at:'not-a-time'}]}),/Malformed/);
});

import {validateLatestRepairHistory as browserHistory,validateFixtureRepairDelta} from './fixture-browser-recovery.mjs';
test('Browser history refuses unaccounted, pending, overlapping failures and exact-run omission',()=>{
 const source={run:{id:1,display_title:'Alpha CI · repair',updated_at:'2026-10-30T02:00:00Z'}};
 const row=(id,title)=>({id,display_title:title,created_at:'2026-10-30T02:10:00Z',updated_at:'2026-10-30T02:20:00Z',status:'completed',conclusion:'success',run_attempt:1});
 const rows=[row(2,'Focused only · repair'),row(3,'Canonical build only · repair'),row(4,'Tooling transport only · repair')],f={source,rows,candidateBranch:'repair',focusedRunIds:[2],buildRunId:3,browserRunId:4};
 assert.deepEqual(browserHistory(f).runIds,[2,3,4]);
 for(const change of [x=>x.rows.pop(),x=>x.rows[2].conclusion='failure',x=>x.rows[2].status='queued',x=>x.rows.push({...row(5,'Tooling transport only · repair'),created_at:'2026-10-30T01:00:00Z',conclusion:'failure'}),x=>x.rows.push({...row(6,'Tooling transport only · repair'),created_at:'2020-01-01T00:00:00Z',status:'pending'})]){const bad=structuredClone(f);change(bad);assert.throws(()=>browserHistory(bad));}
});
test('Finite fixture route refuses arbitrary commits before touching Git or candidate paths',()=>{
 assert.throws(()=>validateFixtureRepairDelta({cwd:'/no-path',original:'a'.repeat(40),candidate:'b'.repeat(40)}),/independently reviewed exact fixture/);
});

import {execFileSync as browserExec} from 'node:child_process';
import {fileURLToPath as browserFilePath} from 'node:url';
test('Actual bounded browser extractor preserves unit results, binds image text and refuses unknown members',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-browser-extract-')),archive=join(root,'packet.zip'),script=browserFilePath(new URL('./browser-repair-extract.py',import.meta.url));
 const writeZip=entries=>writeFileSync(archive,browserExec('python3',['-c','import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,v)) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:JSON.stringify(entries)}));
 const extract=(entries,mode,label)=>{writeZip(entries);return browserExec('python3',[script,archive,join(root,label),mode,'chromium'],{stdio:'pipe'});};
 const unit={'unit-browser-chromium.json':'{"report":true}','browser-chromium-batch-0.json':'{"result":true}','health-before-browser-chromium.json':'{"health":true}'};
 const identity={'filesystem-capacity.txt':'facts','image-binding.json':'{"binding":true}','installed-packages.tsv':'packages','lockfile-sha256.txt':'lock text\n','source-sha.txt':'source text\n'};
 try{
  extract(unit,'unit','unit');assert.deepEqual(JSON.parse(readFileSync(join(root,'unit/unit-browser-chromium.json'))),{report:true});
  extract(identity,'identity','identity');assert.deepEqual(JSON.parse(readFileSync(join(root,'identity/source-binding.json'))),{sourceText:'source text\n',lockText:'lock text\n'});
  let i=0;for(const entries of [{...unit,'../escape.json':'{}'},{...unit,'unexpected.json':'{}'},{'unit-browser-chromium.json':'{}'},{...identity,'unexpected.txt':'x'},{...identity,'ui-screenshots/extra.png':'x'}])assert.throws(()=>extract(entries,entries['image-binding.json']?'identity':'unit','refuse-'+i++));
 }finally{rmSync(root,{recursive:true,force:true});}
});

import {collectCompleteRepairHistory} from './fixture-browser-recovery.mjs';
test('Real history collector supplies old-created newly-completed failures and refuses incomplete API pagination',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-browser-history-api-')),bin=join(root,'bin');mkdirSync(bin);
 const stamp='2026-10-30T03:00:00Z',row=(id,title)=>({id,display_title:title,head_sha:'controller',created_at:'2026-10-30T02:10:00Z',updated_at:stamp,status:'completed',conclusion:'success',run_attempt:1});
 const state={395777276:[row(3,'Canonical build only · repair')],999:[row(2,'Focused only · repair')],395862646:[row(4,'Tooling transport only · repair')]};
 const statePath=join(root,'state.json'),queries=join(root,'queries.txt'),saveState=()=>writeFileSync(statePath,JSON.stringify(state));saveState();
 writeFileSync(join(bin,'gh'),'#!'+process.execPath+'\n'+
  'const fs=require("node:fs"),p=process.argv[3],root=process.env.AIHR_HISTORY_TEST_ROOT;fs.appendFileSync(root+"/queries.txt",p+"\\n");const id=p.match(/workflows\\/(\\d+)\\//)[1],s=JSON.parse(fs.readFileSync(root+"/state.json"));let rows=s[id];if(p.includes("created="))rows=rows.filter(r=>!r.created_at.startsWith("2020"));process.stdout.write(JSON.stringify({total_count:s.incomplete?rows.length+1:rows.length,workflow_runs:rows}));\n',{mode:0o700});
 const oldPath=process.env.PATH,oldRoot=process.env.AIHR_HISTORY_TEST_ROOT;process.env.PATH=bin+':'+oldPath;process.env.AIHR_HISTORY_TEST_ROOT=root;
 const input={source:{run:{id:1,display_title:'Alpha CI · repair',updated_at:'2026-10-30T02:00:00Z'}},focusedWorkflowId:999,candidateBranch:'repair',focusedRunIds:[2],buildRunId:3,browserRunId:4};
 try{
  assert.deepEqual(collectCompleteRepairHistory(input).runIds,[2,3,4]);
  assert(!readFileSync(queries,'utf8').includes('created='));
  state[395862646].push({...row(5,'Tooling transport only · repair'),created_at:'2020-01-01T00:00:00Z',conclusion:'failure'});saveState();
  assert.throws(()=>collectCompleteRepairHistory(input),/Unaccounted/);
  state[395862646].pop();state.incomplete=true;saveState();assert.throws(()=>collectCompleteRepairHistory(input),/omitted/);
 }finally{process.env.PATH=oldPath;if(oldRoot===undefined)delete process.env.AIHR_HISTORY_TEST_ROOT;else process.env.AIHR_HISTORY_TEST_ROOT=oldRoot;rmSync(root,{recursive:true,force:true});}
});

import {parseFixtureAliases} from './fixture-browser-recovery.mjs';
test('Complete fixed-source alias registry excludes moved, foreign, duplicated and malformed branches',()=>{
 const sha='a'.repeat(40),row=sha+'\trefs/heads/codex/mobile-recovery-6bdd-01';assert.deepEqual(parseFixtureAliases([row],sha),{'codex/mobile-recovery-6bdd-01':sha});
 for(const rows of [[row,row],[row.replace(sha,'b'.repeat(40))],[row.replace('6bdd','other')],[row.replace('-01','-00')],[row+'\textra'],Array(100).fill(row)])assert.throws(()=>parseFixtureAliases(rows,sha));
});
test('All discovered source aliases contribute pending, failed and superseding history to admission',()=>{
 const alias='codex/mobile-recovery-6bdd-01',base={id:2,display_title:'Focused only · '+alias,head_sha:'controller',created_at:'2026-10-30T02:10:00Z',updated_at:'2026-10-30T02:20:00Z',status:'completed',conclusion:'success',run_attempt:1};
 const f={source:{run:{id:1,display_title:'Alpha CI · repair',updated_at:'2026-10-30T02:00:00Z'}},rows:[base,{...base,id:3,display_title:'Canonical build only · repair'},{...base,id:4,display_title:'Tooling transport only · repair'},{...base,id:5,display_title:'Focused only · repair'}],candidateBranch:'repair',candidateRefs:[alias],focusedRunIds:[2],buildRunId:3,browserRunId:4,compilerRunId:5};
 assert.deepEqual(browserHistory(f).runIds,[2,3,4,5]);
 for(const extra of [{...base,id:6,conclusion:'failure'},{...base,id:6,status:'pending',conclusion:null}])assert.throws(()=>browserHistory({...f,rows:[...f.rows,extra]}),/Unaccounted/);
});
test('Actual compiler auxiliary extractor accepts mixed packets as source identity only and rejects unsafe inventory',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-compiler-extract-')),archive=join(root,'packet.zip'),script=browserFilePath(new URL('./compiler-repair-extract.py',import.meta.url));
 const entries={'focused.json':JSON.stringify({groups:{NODB:['a'],DB:['b']}}),'nodb.vitest.json':'{}','db.vitest.json':'{}'};
 const extract=(data,name)=>{writeFileSync(archive,browserExec('python3',['-c','import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,v)) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:JSON.stringify(data)}));return browserExec('python3',[script,archive,join(root,name)],{stdio:'pipe'});};
 try{extract(entries,'valid');assert.deepEqual(JSON.parse(readFileSync(join(root,'valid/focused.json'))).groups,{NODB:['a'],DB:['b']});assert.throws(()=>readFileSync(join(root,'valid/db.vitest.json')));assert.throws(()=>extract({...entries,'../escape.json':'{}'},'bad'));const missing={...entries};delete missing['db.vitest.json'];assert.throws(()=>extract(missing,'missing'));}finally{rmSync(root,{recursive:true,force:true});}
});

test('Actual complete history collector retains deleted-alias failures even with an empty advertised registry',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-deleted-alias-history-')),bin=join(root,'bin');mkdirSync(bin);
 const row={id:2,display_title:'Focused only · codex/mobile-recovery-6bdd-01',head_sha:'controller',created_at:'2020-01-01T00:00:00Z',updated_at:'2026-10-30T02:30:00Z',status:'completed',conclusion:'failure',run_attempt:1};
 writeFileSync(join(root,'row.json'),JSON.stringify(row));
 writeFileSync(join(bin,'gh'),'#!'+process.execPath+'\n'+
  'const fs=require("node:fs"),p=process.argv[3],row=JSON.parse(fs.readFileSync(process.env.AIHR_DELETED_ALIAS_ROOT+"/row.json")),rows=p.includes("workflows/999/")?[row]:[];process.stdout.write(JSON.stringify({total_count:rows.length,workflow_runs:rows}));\n',{mode:0o700});
 const previous=process.env.PATH,old=process.env.AIHR_DELETED_ALIAS_ROOT;process.env.PATH=bin+':'+previous;process.env.AIHR_DELETED_ALIAS_ROOT=root;
 const input={source:{run:{id:1,display_title:'Alpha CI · repair',updated_at:'2026-10-30T02:00:00Z'}},focusedWorkflowId:999,candidateBranch:'repair',candidateRefs:[],focusedRunIds:[],buildRunId:3,browserRunId:4};
 try{
  assert.throws(()=>collectCompleteRepairHistory(input),/Unaccounted/);
  row.display_title='Focused only · codex/mobile-recovery-6bdd-001';writeFileSync(join(root,'row.json'),JSON.stringify(row));assert.throws(()=>collectCompleteRepairHistory(input),/Malformed/);
 }finally{process.env.PATH=previous;if(old===undefined)delete process.env.AIHR_DELETED_ALIAS_ROOT;else process.env.AIHR_DELETED_ALIAS_ROOT=old;rmSync(root,{recursive:true,force:true});}
});

test('Finite fixture reader preserves exact complete inert duration diagnostics without expanding v2 packet admission',()=>{
 const root=mkdtempSync(join(tmpdir(),'fixture-duration-reader-')),path=join(root,'packet.zip');
 const fixed=['baseline.sequence.json','baseline.log','baseline.vitest.json','duration.log','duration.sequence.json','duration.vitest.json','proof.json'];
 const basic={'focused.json':JSON.stringify({groups:{NODB:['test/node.test.ts'],DB:[]}}),'nodb.vitest.json':'{}'},entries={...basic,...Object.fromEntries(fixed.map(n=>['duration-sequence-smoke/'+n,'{}']))};
 const zip=e=>writeFileSync(path,browserExec('python3',['-c','import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,v)) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:JSON.stringify(e)}));
 let index=0;const extract=(e,legacy=false)=>{zip(e);const destination=join(root,'out-'+index++);browserExec('python3',[browserFilePath(new URL(legacy?'./repair-recovery-extract.py':'./fixture-repair-extract.py',import.meta.url)),path,destination],{stdio:'pipe'});return destination;};
 try{
  const directory=extract(entries);assert.deepEqual(readdirSync(directory).sort(),['focused.json','nodb.vitest.json']);assert.throws(()=>extract(entries,true));
  assert.deepEqual(readdirSync(extract(basic)).sort(),['focused.json','nodb.vitest.json']);
  zip(entries);browserExec('python3',['-c','import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],"a");z.writestr("duration-sequence-smoke/proof.json","{}");z.close()',path],{stdio:'pipe'});
  assert.throws(()=>browserExec('python3',[browserFilePath(new URL('./fixture-repair-extract.py',import.meta.url)),path,join(root,'duplicate-refused')],{stdio:'pipe'}));
  const missing={...entries};delete missing['duration-sequence-smoke/proof.json'];
  for(const e of [missing,{...entries,'duration-sequence-smoke/unknown.json':'{}'},{...entries,'duration-sequence-smoke/../evil.json':'{}'},{...entries,'duration-sequence-smoke/proof.json':'x'.repeat(16*1024*1024+1)},{...entries,'focused.json':JSON.stringify({groups:{NODB:[],DB:['test/db.test.ts']}}),'db.vitest.json':'{}'}])assert.throws(()=>extract(e));
 }finally{rmSync(root,{recursive:true,force:true});}
});
