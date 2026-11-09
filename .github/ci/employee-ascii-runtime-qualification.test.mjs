/** Pure dispatch/result controls. These cases never collect or manufacture native evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {employeeAsciiChoice,employeeAsciiResultCases,EMPLOYEE_ASCII_CASES,EMPLOYEE_ASCII_SELECTORS} from './employee-ascii-runtime-qualification.mjs';

// Independent literal expectations: changing a product case or its source must renew this contract.
const expectedCases=Object.freeze({
 'test/employee-choice-exact-ascii-proof.test.ts':[
  'compares every valid scalar native record with pinned tables and the actual bound Node binary',
  'retains all context barriers with actual Final Sigma whole-string and deliberately defective native controls',
  'matches literal ASCII query semantics and refuses unsupported modes before forbidden query parameters',
 ],
 'test/employee-choice-inline-ascii-native.test.ts':[
  'uses the actual inline product predicate with exact Node Unicode/literal matches and native duplicate-name UUID order',
  'preserves both native page branches, independent selection/facets, organisation labels and out-of-range exact totals',
  'bounds the shared server page at2000 while retaining all matching IDs and exact server populations and effect dates',
  'keeps the original JS fallback for non-ASCII, NUL, lone-surrogate and unqualified external ICU configuration',
  'retains native RLS behind a held Access writer and fresh role revocation before search SQL',
 ],
});
const files=Object.keys(expectedCases).sort(),cwd=process.cwd();
function result(){return {
 success:true,numTotalTests:8,numPassedTests:8,numFailedTests:0,numPendingTests:0,numTodoTests:0,
 numTotalTestSuites:4,numPassedTestSuites:4,numFailedTestSuites:0,numPendingTestSuites:0,
 testResults:files.map(file=>({name:file,status:'passed',assertionResults:expectedCases[file].map(fullName=>({fullName,status:'passed'}))})),
};}
const expectedRows=order=>order.flatMap(file=>expectedCases[file].map(name=>({file,name,status:'passed'})));

test('off preserves ordinary focused metadata without creating a runtime cell',()=>{
 const ordinaryFiles=['test/ordinary.test.ts'],inputs={run_build:true,unrelated:'ordinary metadata'};
 assert.equal(employeeAsciiChoice(undefined,ordinaryFiles,inputs),null);
 assert.equal(employeeAsciiChoice('off',ordinaryFiles,inputs),null);
 assert.deepEqual(ordinaryFiles,['test/ordinary.test.ts']);assert.deepEqual(inputs,{run_build:true,unrelated:'ordinary metadata'});
});

test('binds only two named runtime cells to exact release literals and one complete selector pair',()=>{
 assert.deepEqual(EMPLOYEE_ASCII_SELECTORS,files);assert.deepEqual(EMPLOYEE_ASCII_CASES,expectedCases);
 for(const [cell,node]of [['node22','22.23.3'],['node24','24.22.1']]){
  const selected=employeeAsciiChoice(cell,files,{employee_ascii_qualification:cell,eval_budget_usd:'20'});
  assert.deepEqual(selected,{version:1,kind:'EMPLOYEE_ASCII_SEMANTIC_CELL_NOT_RELEASE',cell,node});assert(Object.isFrozen(selected));
  assert.equal(selected.releaseAuthorized,undefined);assert.equal(selected.normalNoDbVerified,undefined);
  assert.equal(employeeAsciiChoice(cell,files,{employee_ascii_qualification:cell,selected_tests:JSON.stringify([...files].reverse())}).cell,cell);
 }
 assert.deepEqual(files,Object.keys(expectedCases).sort());
});

test('refuses unknown purposes and missing duplicated foreign or expanded selectors',()=>{
 for(const mode of [null,false,true,0,'','node20','node24.22.1','NODE22',{},[]])assert.throws(()=>employeeAsciiChoice(mode,files));
 for(const selected of [[],[files[0]],[files[1]],[files[0],files[0]],[...files,'test/ordinary.test.ts'],[files[1],files[0]],files.map(file=>'./'+file),null]){
  for(const cell of ['node22','node24'])assert.throws(()=>employeeAsciiChoice(cell,selected));
 }
 for(const cell of ['node22','node24']){
  assert.throws(()=>employeeAsciiChoice(cell,files,{employee_ascii_qualification:cell==='node22'?'node24':'node22'}));
  for(const selected_tests of [files,'not-json',JSON.stringify([files[0]]),JSON.stringify([files[0],files[0]]),JSON.stringify([...files,'test/foreign.test.ts'])])assert.throws(()=>employeeAsciiChoice(cell,files,{selected_tests}));
 }
});

test('refuses coincident compiler build native provider profiling and restricted-port intent',()=>{
 const blocked=['qualify_restricted_port_prerequisites','profile_database','duration_order','run_typecheck','run_native_typecheck','run_native_swift_models','run_native_bundle','run_build','run_native_uid_isolation_fixture'];
 for(const cell of ['node22','node24']){
  for(const inputs of [null,[],false,20])assert.throws(()=>employeeAsciiChoice(cell,files,inputs));
  for(const key of blocked){
   for(const value of [true,'true',1,'1',{},[]])assert.throws(()=>employeeAsciiChoice(cell,files,{[key]:value}),key);
   for(const value of [undefined,false,'false',''])assert.equal(employeeAsciiChoice(cell,files,{[key]:value}).cell,cell);
  }
  for(const intent of [{model_eval:'anything'},{eval_allowed_providers:'openai'},{eval_budget_usd:'0'},{eval_budget_usd:21},{unknown:'true'}])assert.throws(()=>employeeAsciiChoice(cell,files,intent));
 }
});

test('accepts only all eight exact source cases from two complete result files',()=>{
 const input=result(),before=structuredClone(input),rows=employeeAsciiResultCases(input,cwd);
 assert.deepEqual(rows,expectedRows(files));assert.deepEqual(input,before);
 rows[0].name='changed output';assert.equal(input.testResults[0].assertionResults[0].fullName,expectedCases[files[0]][0]);
 const reversed=result();reversed.testResults.reverse();
 assert.deepEqual(employeeAsciiResultCases(reversed,cwd),expectedRows([...files].reverse()));
 const absolute=result();absolute.testResults.forEach(suite=>{suite.name=join(cwd,suite.name);});
 assert.deepEqual(employeeAsciiResultCases(absolute,cwd),expectedRows(files));
});

test('refuses failed skipped missing renamed duplicated or foreign cases and suites',()=>{
 const mutate=[
  value=>{value.success=false;},
  ...['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests','numTotalTestSuites','numPassedTestSuites','numFailedTestSuites','numPendingTestSuites'].map(key=>value=>{value[key]++;}),
  value=>{value.testResults=[];},value=>{value.testResults.pop();},value=>{value.testResults.push(structuredClone(value.testResults[0]));},
  value=>{value.testResults[1].name=files[0];},value=>{value.testResults[0].name='test/foreign.test.ts';},
  value=>{value.testResults[0].status='failed';},value=>{value.testResults[0].status='pending';},
  value=>{value.testResults[0].assertionResults.pop();},
  value=>{value.testResults[0].assertionResults.push(structuredClone(value.testResults[0].assertionResults[0]));},
  value=>{value.testResults[0].assertionResults[1].fullName=value.testResults[0].assertionResults[0].fullName;},
  value=>{value.testResults[0].assertionResults[0].fullName+=' renamed';},
  value=>{value.testResults[0].assertionResults.reverse();},
  ...['failed','pending','skipped','todo','disabled'].map(status=>value=>{value.testResults[0].assertionResults[0].status=status;}),
 ];
 for(const change of mutate){const input=result();change(input);assert.throws(()=>employeeAsciiResultCases(input,cwd));}
 assert.throws(()=>employeeAsciiResultCases(null,cwd));
});

test('binds absolute result filenames to the actual source directory and refuses foreign path interpretations',()=>{
 for(const path of [join(cwd,'foreign',files[0]),join(cwd,'..','foreign',files[0]),'../'+files[0],'./'+files[0],files[0].replaceAll('/','\\'),cwd+'/foreign/../'+files[0],cwd+'//'+files[0]]){
  const input=result();input.testResults[0].name=path;assert.throws(()=>employeeAsciiResultCases(input,cwd),path);
 }
 const absolute=result();absolute.testResults.forEach(suite=>{suite.name=join(cwd,suite.name);});
 assert.throws(()=>employeeAsciiResultCases(absolute,join(cwd,'foreign')));
 assert.deepEqual(employeeAsciiResultCases(absolute,cwd),expectedRows(files));
});
