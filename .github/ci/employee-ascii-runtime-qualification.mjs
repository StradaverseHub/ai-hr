/** Closed development semantic cells. Metadata/receipts are never API or release authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {EMPLOYEE_LIFECYCLE_SOURCES} from './employee-lifecycle-sources.mjs';
import {singletonSourceMaximum} from './singleton-protocol.mjs';
export const EMPLOYEE_ASCII_CELL_NODES=Object.freeze({node22:'22.23.3',node24:'24.22.1'});
export const EMPLOYEE_ASCII_CASES=Object.freeze(Object.fromEntries(Object.entries({
 "test/employee-choice-exact-ascii-proof.test.ts": [
  "compares every valid scalar native record with pinned tables and the actual bound Node binary",
  "retains all context barriers with actual Final Sigma whole-string and deliberately defective native controls",
  "matches literal ASCII query semantics and refuses unsupported modes before forbidden query parameters"
 ],
 "test/employee-choice-inline-ascii-native.test.ts": [
  "uses the actual inline product predicate with exact Node Unicode/literal matches and native duplicate-name UUID order",
  "preserves both native page branches, independent selection/facets, organisation labels and out-of-range exact totals",
  "bounds the shared server page at2000 while retaining all matching IDs and exact server populations and effect dates",
  "keeps the original JS fallback for non-ASCII, NUL, lone-surrogate and unqualified external ICU configuration",
  "retains native RLS behind a held Access writer and fresh role revocation before search SQL"
 ]
}).map(([file,names])=>[file,Object.freeze(names)])));
export const EMPLOYEE_ASCII_SELECTORS=Object.freeze(Object.keys(EMPLOYEE_ASCII_CASES).sort());
const blocked=['qualify_restricted_port_prerequisites','profile_database','duration_order','run_typecheck','run_native_typecheck','run_native_swift_models','run_native_bundle','run_build','run_native_uid_isolation_fixture'];
const known=new Set(['candidate_ref','expected_sha','selected_tests','employee_ascii_qualification','model_eval','eval_budget_usd','eval_allowed_providers',...blocked]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function employeeAsciiChoice(mode,files,inputs={}){
 assert(mode===undefined||typeof mode==='string'&&['off','node22','node24'].includes(mode),'Unknown closed employee ASCII purpose');
 if(mode===undefined||mode==='off')return null;
 assert.deepEqual(files,EMPLOYEE_ASCII_SELECTORS,'Exact two employee ASCII files required');assert(inputs&&typeof inputs==='object'&&!Array.isArray(inputs),'Closed qualification input object required');
 assert(Object.keys(inputs).every(key=>known.has(key)),'Unexpected coincident qualification intent');
 if(inputs.employee_ascii_qualification!==undefined)assert.equal(inputs.employee_ascii_qualification,mode,'Closed purpose intent differs');
 if(inputs.selected_tests!==undefined){assert.equal(typeof inputs.selected_tests,'string');assert.deepEqual(JSON.parse(inputs.selected_tests).sort(),files,'Declared source selection differs');}
 for(const key of blocked)assert([undefined,false,'false',''].includes(inputs[key]),'Other qualification work forbidden');
 for(const key of ['model_eval','eval_allowed_providers'])assert(inputs[key]===undefined||inputs[key]==='','Provider/model intent forbidden');
 assert(inputs.eval_budget_usd===undefined||String(inputs.eval_budget_usd)==='20','Unused model budget must retain its default');
 return Object.freeze({version:1,kind:'EMPLOYEE_ASCII_SEMANTIC_CELL_NOT_RELEASE',cell:mode,node:EMPLOYEE_ASCII_CELL_NODES[mode]});
}
function bounded(file,maximum){
 assert.equal(realpathSync(file),resolve(file),'Canonical fixed source/evidence path required');const before=lstatSync(file);
 assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=maximum,'Bounded regular qualification bytes required');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const bytes=Buffer.alloc(before.size+1);let count=0;while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}
  assert.equal(count,before.size);const after=fstatSync(fd),path=lstatSync(file);for(const key of ['dev','ino','size','mtimeMs','ctimeMs']){assert.equal(after[key],before[key]);assert.equal(path[key],before[key]);}return bytes.subarray(0,count);
 }finally{closeSync(fd);}
}
/** Selection metadata only; actual GitHub API provenance remains independently required. */
export function employeeAsciiSelection(files){
 const mode=process.env.AIHR_EMPLOYEE_ASCII_QUALIFICATION??'off';const choice=employeeAsciiChoice(mode,files);if(!choice)return null;
 const env=process.env;assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.CI,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(env.GITHUB_REPOSITORY_ID,'1333414856');assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(env.GITHUB_RUN_ATTEMPT,'1');
 assert(env.GITHUB_WORKFLOW_REF?.startsWith('StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/heads/'));
 const event=JSON.parse(bounded(env.GITHUB_EVENT_PATH,1048576));assert.equal(event.repository?.id,1333414856);assert.equal(event.inputs?.employee_ascii_qualification,mode);assert.equal(typeof event.inputs?.selected_tests,'string');
 return employeeAsciiChoice(mode,files,event.inputs);
}
const proofFiles=Object.freeze(['test/fixtures/employee-choice-ascii-observation.ts','test/fixtures/employee-choice-ascii-proof-native.ts','test/fixtures/employee-choice-ascii-scalar-corpus.sql','test/fixtures/employee-choice-ascii-proof-lifetime.ts','test/fixtures/employee-choice-ascii-vectors.sql','test/employee-choice-ascii-observation.test.ts','test/employee-choice-exact-ascii-proof.test.ts','core/employee-choice-ascii.ts','package.json','pnpm-lock.yaml','test/fixtures/unicode-17.0.0/LICENSE.txt','test/fixtures/unicode-17.0.0/UnicodeData.txt','test/fixtures/unicode-17.0.0/SpecialCasing.txt']);
/** Reuse the existing complete source owner; never duplicate a repository inventory. */
function sourceSnapshot(){
 const files=[...new Set([...EMPLOYEE_LIFECYCLE_SOURCES,...proofFiles,...EMPLOYEE_ASCII_SELECTORS])].sort();assert(files.length<=4000);let bytes=0;
 return Object.fromEntries(files.map(file=>{assert(!file.startsWith('/')&&file.split('/').every(part=>part&&part!=='.'&&part!=='..'));const raw=bounded(join(process.cwd(),file),singletonSourceMaximum(file));bytes+=raw.length;assert(bytes<=256*1024*1024,'Qualification source input bound');return[file,hash(raw)];}));
}
function executable(){
 const fd=openSync('/proc/self/exe',constants.O_RDONLY|constants.O_NONBLOCK);
 try{const before=fstatSync(fd,{bigint:true}),path=statSync(process.execPath,{bigint:true});assert(before.isFile()&&before.size>0n&&before.size<=268435456n);assert.equal(path.ino,before.ino);assert.equal(path.dev,before.dev);
  const h=createHash('sha256'),block=Buffer.alloc(65536);let count=0;while(count<Number(before.size)){const n=readSync(fd,block,0,Math.min(block.length,Number(before.size)-count),count);assert(n>0);count+=n;h.update(block.subarray(0,n));}assert.equal(readSync(fd,block,0,1,count),0);
  const after=fstatSync(fd,{bigint:true}),current=statSync(process.execPath,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs']){assert.equal(after[key],before[key]);assert.equal(current[key],before[key]);}return{bytes:count,sha256:h.digest('hex')};
 }finally{closeSync(fd);}
}
export function captureEmployeeAsciiCell(files){
 const cell=employeeAsciiSelection(files);if(!cell)return null;
 assert.equal(process.env.GITHUB_JOB,'selected-tests');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.versions.node,cell.node);assert.equal(process.versions.icu,'78.3');assert.equal(process.versions.unicode,'17.0');
 for(const key of ['NODE_ICU_DATA','ICU_DATA'])assert.equal(process.env[key],undefined,'External ICU configuration unqualified');assert(!process.execArgv.some(value=>value.includes('--icu-data-dir'))&&!(process.env.NODE_OPTIONS??'').includes('--icu-data-dir'));
 return{cell,versions:{...process.versions},executable:executable(),sourceFiles:sourceSnapshot()};
}
/** Pure census guard, not an execution or capability factory. */
export function employeeAsciiResultCases(result,cwd){
 assert(result?.success===true&&result.numTotalTests===8&&result.numPassedTests===8&&result.numFailedTests===0&&result.numPendingTests===0&&result.numTodoTests===0&&result.numFailedTestSuites===0&&result.numPendingTestSuites===0&&Number.isSafeInteger(result.numTotalTestSuites)&&result.numTotalTestSuites>0&&result.numPassedTestSuites===result.numTotalTestSuites);
 assert(typeof cwd==='string'&&cwd===resolve(cwd),'Actual canonical source directory required');
 const seen=new Set(),cases=[];for(const suite of result.testResults??[]){assert(typeof suite.name==='string');const absolute=suite.name.startsWith('/'),file=absolute?relative(cwd,suite.name):suite.name;if(absolute)assert.equal(suite.name,join(cwd,file),'Canonical suite filename required');assert(EMPLOYEE_ASCII_CASES[file]&&!seen.has(file));seen.add(file);assert.equal(suite.status,'passed');assert.deepEqual(suite.assertionResults.map(row=>row.fullName),EMPLOYEE_ASCII_CASES[file]);for(const row of suite.assertionResults){assert.equal(row.status,'passed');cases.push({file,name:row.fullName,status:'passed'});}}
 assert.equal(seen.size,2);return cases;
}
export function finishEmployeeAsciiCell(snapshot,report,directory){
 assert.equal(resolve(directory),join(realpathSync(process.env.RUNNER_TEMP),'aihr-focused'));assert.equal(report.exitCode,0);assert.equal(report.qualificationDatabaseStopped,true);assert.equal(report.releaseEligible,false);
 assert.equal(report.healthBefore?.ok,true);assert.equal(report.healthAfter?.ok,true);assert.deepEqual(report.groups,{NODB:[],DB:EMPLOYEE_ASCII_SELECTORS});assert.deepEqual({...process.versions},snapshot.versions);assert.deepEqual(executable(),snapshot.executable);assert.deepEqual(sourceSnapshot(),snapshot.sourceFiles);
 const cases=employeeAsciiResultCases(JSON.parse(bounded(join(directory,'db.vitest.json'),1048576)),process.cwd());
 const proofDirectory=join(directory,'employee-choice-exact-ascii-proof');assert.deepEqual(readdirSync(proofDirectory).sort(),['contexts.json','native-scalars.bin','node-scalars.bin','queries.json','scalars.json']);
 const members=[],proofs={};for(const name of ['scalars','contexts','queries']){const raw=bounded(join(proofDirectory,name+'.json'),1048576),value=JSON.parse(raw);
  assert.equal(value.kind,'DEVELOPMENT_ASCII_OBSERVATION_NOT_RELEASE');assert.equal(value.name,name);assert.equal(value.source,report.sha);assert.equal(value.controller,report.controller);assert.equal(value.run,report.runId);assert.equal(value.attempt,report.attempt);assert.equal(value.success,true);assert.equal(value.ownedClientClosed,true);assert.equal(value.releaseAuthorized,false);assert.deepEqual(value.versions,snapshot.versions);assert.equal(value.executable.bytes,snapshot.executable.bytes);assert.equal(value.executable.sha256,snapshot.executable.sha256);
  assert.deepEqual(Object.keys(value.sourceFiles).sort(),[...proofFiles].sort());for(const [file,sha]of Object.entries(value.sourceFiles))assert.equal(sha,snapshot.sourceFiles[file]);
  assert.equal(value.native.session,'ai_hr_app');assert.equal(value.native.current,'ai_hr_app');assert.equal(value.native.encoding,'UTF8');assert.equal(value.native.isolation,'repeatable read');assert.equal(value.native.readonly,'on');assert.equal(value.native.statement,'20s');assert.equal(value.native.lock,'300ms');assert.equal(value.native.loopback,true);assert(value.native.version>=160000&&value.native.version<170000);proofs[name]=value;members.push({file:name+'.json',bytes:raw.length,sha256:hash(raw)});
 }
 const native=bounded(join(proofDirectory,'native-scalars.bin'),16*1024*1024),node=bounded(join(proofDirectory,'node-scalars.bin'),16*1024*1024);assert(native.equals(node));assert.equal(proofs.scalars.completeComparison.count,1112063);assert.equal(proofs.scalars.completeComparison.sha256,hash(native));assert.equal(proofs.scalars.completeComparison.byteLength,native.length);assert.equal(proofs.contexts.contexts.allVectors,85);assert.equal(proofs.queries.queries.literalVectors,130);
 for(const [name,raw]of [['native-scalars.bin',native],['node-scalars.bin',node]])members.push({file:name,bytes:raw.length,sha256:hash(raw)});
 return{kind:'ACTUAL_EMPLOYEE_ASCII_SEMANTIC_CELL_ONLY',complete:true,cell:snapshot.cell,source:report.sha,controller:report.controller,run:report.runId,attempt:report.attempt,versions:snapshot.versions,executable:snapshot.executable,sourceFiles:snapshot.sourceFiles,cases,members,scalarRecords:1112063,contextVectors:85,literalVectors:130,ownedProofClientsClosed:true,databaseStopped:true,normalNoDbVerified:false,ordinaryCompilerQualified:false,releaseAuthorized:false,packageAcceptance:false};
}
