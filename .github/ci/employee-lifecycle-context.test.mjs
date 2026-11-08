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
 const kernel=readFileSync(new URL('./owned-process.py',import.meta.url));assert.equal(employeeLifecycleHash(kernel),'cb1a2cc2879267f8834dc11ea0e1c52f8326b0bd4e45dcd94ccf2ac43463f28c');
});
test('stop precedes EVERY terminal collection/publication and failure produces an incomplete bounded proof',()=>{
 const source=readFileSync(new URL('./employee-lifecycle.mjs',import.meta.url),'utf8'),tail=source.slice(source.indexOf('export function closeEmployeeLifecycle'));
 assert(tail.indexOf("runEmployeeLifecycleStage(owner,'stop')")<tail.indexOf("attempt('anchor'"));assert(tail.indexOf("runEmployeeLifecycleStage(owner,'stop')")<tail.indexOf("attempt('terminal-publication'"));assert.match(tail,/actualStageOutcomes:state.reports/);assert.match(tail,/new AggregateError\(errors/);assert.match(tail,/preStopResource!==null/);
});
test('ordinary workflow, singleton policy and resource ownership remain ROOT integration gates',()=>{
 const source=readFileSync(new URL('./employee-lifecycle.mjs',import.meta.url),'utf8');assert.match(source,/actualSingletonHost\(plan,unit,directory\)/);assert.match(source,/validateSingletonBinding\(binding,state.plan,state.unit/);assert.match(source,/state.frontier.authorize\(\)/);assert.match(source,/assert.equal\(unit.singleton\?\.profile,'controlled-database-v1'\)/);assert.match(source,/assert.deepEqual\(unit.files,\[file\]\)/);assert.match(source,/state.frontier.record\(stage,false\)/);
});
