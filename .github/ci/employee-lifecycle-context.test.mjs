import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,linkSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {employeeLifecycleRead,employeeLifecycleProcess,assertEmployeeLifecycleParent,assertEmployeeLifecycleAnchor,employeeLifecycleHash} from './employee-lifecycle-context.mjs';
import {prepareEmployeeLifecycle,authorizeEmployeeLifecycleTest,runEmployeeLifecycleStage,closeEmployeeLifecycle} from './employee-lifecycle.mjs';
const identity={run:'123',attempt:'1',unit:'db-0123456789abcdef',source:'a'.repeat(40),controller:'b'.repeat(40)},anchor={version:1,...identity,job:'test',bootId:'fixed',startNs:'1000000000',wallTimeNs:'2000000000'};
test('actual anchor retains the1770s post-first-step window and every source/unit/run/boot binding',()=>{
 assert.equal(assertEmployeeLifecycleAnchor(anchor,identity,2000000000n,'fixed'),1);
 for(const change of [{run:'124'},{unit:'db-fedcba9876543210'},{source:'c'.repeat(40)},{controller:'d'.repeat(40)},{job:'selected-tests'},{bootId:'foreign'},{startNs:'1000000000\n'},{wallTimeNs:'2000000000\n'},{private:'unknown'}])assert.throws(()=>assertEmployeeLifecycleAnchor({...anchor,...change},identity,2000000000n,'fixed'));
 assert.throws(()=>assertEmployeeLifecycleAnchor(anchor,identity,1771000000000n,'fixed'));assert.throws(()=>assertEmployeeLifecycleAnchor(anchor,identity,999999999n,'fixed'));
});
test('private descriptor reads retain ALL actual bytes and reject wrong ownership bounds/modes/link types',()=>{
 const directory=mkdtempSync(join(tmpdir(),'lifecycle-read-'));try{const file=join(directory,'member'),bytes=Buffer.from('complete\0UTF8☃');writeFileSync(file,bytes,{mode:0o600});assert(employeeLifecycleRead(file,bytes.length).equals(bytes));assert.throws(()=>employeeLifecycleRead(file,bytes.length-1));assert.equal(employeeLifecycleHash(employeeLifecycleRead(file,bytes.length)),employeeLifecycleHash(bytes));
  symlinkSync(file,join(directory,'symlink'));assert.throws(()=>employeeLifecycleRead(join(directory,'symlink'),1024));linkSync(file,join(directory,'hardlink'));assert.throws(()=>employeeLifecycleRead(file,1024));
  writeFileSync(join(directory,'public'),'not private',{mode:0o644});assert.throws(()=>employeeLifecycleRead(join(directory,'public'),1024));assert.throws(()=>employeeLifecycleRead(directory,1024));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('native PID/full-start/executable/argv identity is checked rather than a JSON parent claim',()=>{
 const actual=employeeLifecycleProcess(process.pid);assert.equal(actual.pid,process.pid);assert.equal(actual.parent,process.ppid);assert(actual.start.length>0);assert(actual.argv.includes('--test')||actual.argv.some(value=>value.endsWith('employee-lifecycle-context.test.mjs')));
 // The pure full identity checker also demands the fixed four-argument launcher.
 const four={...actual,argv:['/node','/automation/.github/ci/run-unit.mjs','db-0123456789abcdef','/temp/aihr-ci']};assertEmployeeLifecycleParent(four,four);for(const change of [{start:four.start+'0'},{parent:four.parent+1},{exe:'/foreign'},{argv:[...four.argv,'foreign']}])assert.throws(()=>assertEmployeeLifecycleParent({...four,...change},four));
});
test('no caller object/JSON can create or operate a live normal owner',()=>{
 const forged=Object.freeze({mode:'full-ci-singleton'});assert.throws(()=>authorizeEmployeeLifecycleTest(forged,'/tmp/forged'));assert.throws(()=>runEmployeeLifecycleStage(forged,'reset'));assert.throws(()=>closeEmployeeLifecycle(forged));assert.throws(()=>prepareEmployeeLifecycle('test/foreign.test.ts'));
 // This test subprocess has no actual run-unit native argv/first-step context;
 // even genuine runner flags cannot turn it into preparation authority.
 assert.throws(()=>prepareEmployeeLifecycle('test/employee-choice-native-purpose-plan.test.ts'));
});
test('actual admission excludes caller mode/boolean/factory override and hashes before native context use',()=>{
 const source=readFileSync(new URL('../../test/performance/employee-choice-lifecycle-admission.ts',import.meta.url),'utf8');assert.match(source,/export function admitEmployeeChoiceLifecycle\(file:string\)/);assert.match(source,/const admission=admitSingletonTest\(file\)/);assert.match(source,/assert.deepEqual\(employeeLifecycleProcess\(context.parent.pid\),context.parent\)/);assert.match(source,/singletonSha256/);assert.match(source,/EMPLOYEE_LIFECYCLE_CONTROLLER_SOURCES/);assert.doesNotMatch(source,/AIHR_CI_UNIT\?\?|process.env\[[^\]]+\]\s*=/);
});
test('normal fixed commands never accept caller argv or source callbacks and use the qualified kernel',()=>{
 const source=readFileSync(new URL('./employee-lifecycle-supervisor.py',import.meta.url),'utf8');assert.match(source,/'testContext', 'sequence'/);assert.match(source,/native_parent\(parent\)/);assert.match(source,/commands\[stage\]/);assert.doesNotMatch(source,/request\['argv'\]|shell=True|eval\(|exec_module/);
 // Actual17 native controls42451455766 (afdf/ZIP833caa9e...ab0d6), plus
 // actual2f720 clock and2aa UID paths qualify the unchanged9d primitive only.
 // This source gate does not qualify normal-five/SixOp/API/compiler/release.
 const kernel=readFileSync(new URL('./owned-process.py',import.meta.url));
 const inverse=readFileSync(new URL('./compiler-file-window-inverse.json',import.meta.url));
 const registry=readFileSync(new URL('./employee-lifecycle-profile.json',import.meta.url));
 const prior='cb1a2cc2879267f8834dc11ea0e1c52f8326b0bd4e45dcd94ccf2ac43463f28c';
 const current='9d48394fdc1897c53b5fcd5a581fc53b016c111fcc9aa69679daeb732faf2129';
 const changes=[
  {before:'file_clock=None, mandatory=False):',after:'file_clock=None, file_seconds=900, mandatory=False):'},
  {before:'    require(type(seconds) in (int, float) and 0 < seconds <= 960)\n',after:'    require(type(seconds) in (int, float) and 0 < seconds <= 960)\n    require(type(file_seconds) in (int, float) and 0 < file_seconds <= 960)\n'},
  {before:'benchmark_start + 900',after:'benchmark_start + file_seconds'},
 ];
 const call="result = _kernel.supervise(argv, seconds, event, clock=clock, file_clock=file_clock if test and profile['clockDirectory'] is not None else None, mandatory=stage == 'stop')";
 function verifyPurpose(actual,mapBytes,normal,profileBytes){
  assert(Buffer.isBuffer(actual)&&Buffer.isBuffer(mapBytes)&&Buffer.isBuffer(profileBytes));
  assert.equal(employeeLifecycleHash(actual),current,'Exact later-natively-tested kernel required');
  assert.equal(employeeLifecycleHash(mapBytes),'6dc7a68c49921b085b9292972fa92e3b413fc01dbb21510578431712172d97ea');
  const map=JSON.parse(mapBytes.toString('utf8'));
  assert.deepEqual(Object.keys(map).sort(),['kind','base','qualifiedKernelSha256','currentKernelSha256','defaultFileSeconds','compilerFileSeconds','changes'].sort());
  assert.equal(map.kind,'CLOSED_PURPOSE_FILE_WINDOW_EXTENSION_NOT_PROCESS_OWNERSHIP_REPLACEMENT');assert.equal(map.base,'756e834dc0db88b5131547bc6d5108284201ab48');
  assert.equal(map.currentKernelSha256,current);assert.equal(map.qualifiedKernelSha256,prior);assert.equal(map.defaultFileSeconds,900);assert.equal(map.compilerFileSeconds,720);assert.deepEqual(map.changes,changes);
  let complete=actual.toString('utf8');for(const change of [...map.changes].reverse()){assert.equal(complete.split(change.after).length,2);complete=complete.replace(change.after,change.before);}
  assert.equal(employeeLifecycleHash(complete),prior,'ENTIRE qualified predecessor must reconstruct');
  assert.equal(employeeLifecycleHash(normal),'7f4c2d78cb4baff9f150b45e85c0b834b1fb998f5353916ff2cdd71dfa7a3bc8');
  assert.deepEqual(normal.split('\n').map(line=>line.trim()).filter(line=>line.includes('_kernel.supervise(')),[call]);
  assert(!normal.includes('file_seconds')&&!call.includes('**'));
  assert(normal.includes('require(started <= observed <= now and observed + 900 <= started + seconds)'));
  assert.equal(employeeLifecycleHash(profileBytes),'90972f3b57d62a473dafa3a48b671137234cf43de33c964b0eea00f0af05979e');const profile=JSON.parse(profileBytes.toString('utf8'));
  assert.equal(profile.normalJobSeconds,1800);assert.equal(profile.focusedJobSeconds,1170);assert.equal(profile.settlementSeconds,6);
  assert.deepEqual(profile.files.filter(row=>row.clockDirectory!==null).map(row=>[row.fileSeconds,row.stageSeconds,row.workSeconds,row.cleanupSeconds]),[[900,960,840,60],[900,960,840,60],[900,960,840,60]]);
 }
 verifyPurpose(kernel,inverse,source,registry);
 for(const changed of [kernel.subarray(1),Buffer.concat([kernel,Buffer.from('\n')]),Buffer.from(kernel.toString().replace('benchmark_start + file_seconds','benchmark_start + 960'))])assert.throws(()=>verifyPurpose(changed,inverse,source,registry));
 for(const edit of [value=>value.qualifiedKernelSha256=current,value=>value.base='0'.repeat(40),value=>value.defaultFileSeconds=720,value=>value.compilerFileSeconds=900,value=>value.changes.pop(),value=>value.changes.push({...value.changes[0]}),value=>value.changes[0].after+='changed',value=>value.unknown=true]){const value=JSON.parse(inverse.toString());edit(value);assert.throws(()=>verifyPurpose(kernel,Buffer.from(JSON.stringify(value)),source,registry));}
 for(const changed of [source.replace(call,call.replace(', mandatory=',', file_seconds=720, mandatory=')),source.replace(call,call.replace(', mandatory=',', **caller, mandatory=')),source.replace(call,call.replace(', mandatory=',', file_seconds=window(), mandatory=')),source.replace('observed + 900','observed + 720'),source+'\n'])assert.throws(()=>verifyPurpose(kernel,inverse,changed,registry));
 for(const edit of [value=>value.files[0].fileSeconds=720,value=>value.files[0].stageSeconds=961,value=>value.files[0].workSeconds=841,value=>value.settlementSeconds=7]){const value=JSON.parse(registry.toString());edit(value);assert.throws(()=>verifyPurpose(kernel,inverse,source,Buffer.from(JSON.stringify(value))));}
});
test('stop precedes EVERY terminal collection/publication and failure produces an incomplete bounded proof',()=>{
 const source=readFileSync(new URL('./employee-lifecycle.mjs',import.meta.url),'utf8'),tail=source.slice(source.indexOf('export function closeEmployeeLifecycle'));
 assert(tail.indexOf("runEmployeeLifecycleStage(owner,'stop')")<tail.indexOf("attempt('anchor'"));assert(tail.indexOf("runEmployeeLifecycleStage(owner,'stop')")<tail.indexOf("attempt('terminal-publication'"));assert.match(tail,/actualStageOutcomes:state.reports/);assert.match(tail,/new AggregateError\(errors/);assert.match(tail,/preStopResource!==null/);
});
test('ordinary workflow, singleton policy and resource ownership remain ROOT integration gates',()=>{
 const source=readFileSync(new URL('./employee-lifecycle.mjs',import.meta.url),'utf8');assert.match(source,/actualSingletonHost\(plan,unit,directory\)/);assert.match(source,/validateSingletonBinding\(binding,state.plan,state.unit/);assert.match(source,/state.frontier.authorize\(\)/);assert.match(source,/assert.equal\(unit.singleton\?\.profile,'controlled-database-v1'\)/);assert.match(source,/assert.deepEqual\(unit.files,\[file\]\)/);assert.match(source,/state.frontier.record\(stage,false\)/);
});
