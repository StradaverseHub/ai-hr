/** Pure/source/filesystem controls; no compiler, Next or native server invocation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,chmodSync,symlinkSync,linkSync,unlinkSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LIMITS,validatePairData,validateTraceInputs,stageBudget,stockCommand,compilerOutcome,
 readHeld,sameStat,validateExportEntries,copyHeld,traceState,validateAnchorData,validateProducerFragment,
 validateTypegenSuccess,verifyFileManifest,cleanupReceiptRequired} from './compiler-full-trace.mjs';
const original=JSON.parse(readFileSync(new URL('./compiler-full-trace-pair.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(original),digest=b=>createHash('sha256').update(b).digest('hex');
const selection=cell=>({candidate_ref:cell.branch,expected_sha:cell.source,selected_tests:'[]',
 compiler_full_trace:true,run_typecheck:true,qualify_restricted_port_prerequisites:false,profile_database:false,
 duration_order:false,run_native_typecheck:false,run_native_swift_models:false,run_native_bundle:false,
 run_build:false,model_eval:'',eval_budget_usd:'20',eval_allowed_providers:''});
const fixture=()=>realpathSync(mkdtempSync(join(tmpdir(),'stock-trace-model-')));
const entry=(path,bytes=10)=>({path,bytes,sha256:'a'.repeat(64)});
test('pair is the exact corrected CONTROL and direct CANDIDATE, not the unqualified original pair',()=>{
 assert.equal(validatePairData(clone()).guard.sha256,'99a8278db7e0009402b5c9afc5caaf5c429b60eb3e0741d80dbd4ad259427014');
 assert.equal(original.control.source,'0be622808b1b7a07889fdf4ef2f273e43c740c38');
 assert.equal(original.candidate.source,'2202245a62cabcd43ba193150a54dfabb5f71c43');
 assert.equal(original.candidate.parent,original.control.source);assert.equal(original.control.parent,original.base);
 assert.equal(original.guard.bytes,7540);assert.equal(original.trackedInputCount,9069);
});
test('pair schema refuses expanded roles, paths, duplicated source and placeholders',()=>{
 for(const mutate of [p=>p.version=2,p=>p.extra=true,p=>p.control.source='PENDING',
  p=>p.control.parent=p.control.source,p=>p.candidate.parent=p.base,p=>p.candidate.source=p.control.source,
  p=>p.guard.path='foreign.ts',p=>p.control.dbClient.path='db/schema.ts',p=>p.common.pop(),
  p=>p.common.push(p.common[0]),p=>p.common[0].sha256='claimed',p=>p.trackedInputCount=0,
  p=>p.control.branch='codex/../foreign']){
  const p=clone();mutate(p);assert.throws(()=>validatePairData(p));
 }
});
test('both exact fifteen-input selections and omitted optional defaults admit as data only',()=>{
 for(const cell of [original.control,original.candidate]){
  const input=selection(cell);assert.equal(Object.keys(input).length,15);
  assert.equal(validateTraceInputs(input,original).source,cell.source);
  for(const key of ['model_eval','eval_budget_usd','eval_allowed_providers','profile_database']){
   const omitted={...input};delete omitted[key];assert.equal(validateTraceInputs(omitted,original).source,cell.source);
  }
 }
});
test('trace selection refuses mixed operations, missing required fields, nulls and foreign source',()=>{
 const good=selection(original.control);
 for(const key of ['qualify_restricted_port_prerequisites','profile_database','duration_order','run_native_typecheck',
  'run_native_swift_models','run_native_bundle','run_build'])assert.throws(()=>validateTraceInputs({...good,[key]:true},original));
 for(const key of ['candidate_ref','expected_sha','selected_tests','compiler_full_trace','run_typecheck']){
  const p={...good};delete p[key];assert.throws(()=>validateTraceInputs(p,original));
 }
 for(const change of [{selected_tests:'[ ]'},{selected_tests:'["test/ordinary.test.ts"]'},
  {selected_tests:[]},{compiler_full_trace:'true'},{compiler_full_trace:false},{run_typecheck:false},
  {model_eval:'provider/model'},{eval_budget_usd:'50'},{eval_allowed_providers:'provider'},
  {model_eval:null},{extra:false},{expected_sha:original.base},{candidate_ref:'main'}]){
  assert.throws(()=>validateTraceInputs({...good,...change},original));
 }
});
test('same clock parser refuses stale identities, missing native clock, future clock and unknown fields',()=>{
 const identity={source:original.control.source,controller:'a'.repeat(40),runId:'123',attempt:'1',job:'typecheck'};
 const clock={version:1,kind:'NATIVE_FIRST_STEP_CLOCK_NOT_GITHUB_JOB_START',...identity,monotonicNs:'1000'};
 assert.equal(validateAnchorData(clock,identity,2000n),1000n);
 for(const patch of [{source:original.candidate.source},{controller:'b'.repeat(40)},{runId:'456'},{attempt:'2'},
  {job:'selected-tests'},{kind:'server-job-start'},{monotonicNs:'0'},{monotonicNs:'claimed'},{extra:true}]){
  assert.throws(()=>validateAnchorData({...clock,...patch},identity,2000n));
 }
 const missing={...clock};delete missing.monotonicNs;assert.throws(()=>validateAnchorData(missing,identity,2000n));
 assert.throws(()=>validateAnchorData(clock,identity,999n));
});
test('same producer binding and real-typegen success adjudicators refuse relabelled or invented readiness data',()=>{
 const identity={source:original.control.source,controller:'a'.repeat(40),runId:'123',attempt:'1',job:'typecheck'},
  expected={identity,clockSha256:'c'.repeat(64),clock:{monotonicNs:'1000'},cell:'CONTROL',root:{dev:1,ino:2}},
  valid={version:1,kind:'STOCK_FULL_TRACE_DIAGNOSTIC_ONLY',...identity,clockSha256:expected.clockSha256,
   clock:expected.clock,cell:expected.cell,root:{...expected.root}};
 validateProducerFragment(valid,expected);
 for(const patch of [{source:original.candidate.source},{runId:'124'},{cell:'CANDIDATE'},
  {clockSha256:'d'.repeat(64)},{clock:{monotonicNs:'999'}},{root:{dev:1,ino:3}},{kind:'claimed-ready'}]){
  assert.throws(()=>validateProducerFragment({...valid,...patch},expected));
 }
 const success={complete:true,sourceRestored:true,controllerSourceRestored:true,generated:[{path:'.next/types/routes.d.ts'}],
  phases:[{name:'typegen',completed:true,closed:true,code:0,signal:null,stoppedBecause:null}]};
 validateTypegenSuccess(success);
 for(const patch of [{complete:'true'},{complete:false},{sourceRestored:false},{controllerSourceRestored:false},
  {generated:[]},{phases:[]},{phases:[...success.phases,...success.phases]}]){
  assert.throws(()=>validateTypegenSuccess({...success,...patch}));
 }
 for(const patch of [{name:'check'},{closed:false},{code:1},{signal:'SIGTERM'},{stoppedBecause:'timeout'},
  {stoppedBecause:false},{error:'unknown'},{stopError:'unsettled'}]){
  assert.throws(()=>validateTypegenSuccess({...success,phases:[{...success.phases[0],...patch}]}));
 }
});
test('missing swap receipt is failure unless failed typegen left no checking artifacts, with no invented cleanup PASS',()=>{
 const absent={report:false,inputs:false,trace:false,cache:false};
 assert.equal(cleanupReceiptRequired({complete:false},absent),false);
 for(const complete of [true,'false',undefined,null])assert.equal(cleanupReceiptRequired({complete},absent),true);
 for(const key of Object.keys(absent))assert.equal(cleanupReceiptRequired({complete:false},{...absent,[key]:true}),true);
 assert.throws(()=>cleanupReceiptRequired({complete:false},{...absent,extra:false}));
 assert.throws(()=>cleanupReceiptRequired({complete:false},{...absent,report:'false'}));
});
test('stock command is fixed full-config CLI with no arbitrary checker, project or executable input',()=>{
 const source='/fixture/source',out='/fixture/temp/diagnostic-compiler-full-trace',node='/tools/node';
 const prefix=['--verbose','--signal=TERM','--kill-after=10s','720s','/usr/bin/time','-v',
  '/usr/bin/prlimit','--core=0','--fsize=536870912','--',node,source+'/node_modules/typescript/lib/tsc.js'];
 assert.deepEqual(stockCommand('check',source,out,node),{command:'/usr/bin/timeout',args:[...prefix,
  '--noEmit','--pretty','false','--tsBuildInfoFile',out+'/whole-project.tsbuildinfo','--extendedDiagnostics','--generateTrace',out+'/trace']});
 assert.deepEqual(stockCommand('typegen',source,out,node).args.slice(-4),['pnpm','exec','next','typegen']);
 assert(stockCommand('show',source,out,node).args.includes('--showConfig'));
 assert(stockCommand('inventory',source,out,node).args.includes('--listFilesOnly'));
 for(const s of ['check','show','inventory'])assert(!stockCommand(s,source,out,node).args.includes('--project'));
 assert.throws(()=>stockCommand('arbitrary',source,out,node));assert.throws(()=>stockCommand('check','relative',out,node));
});
test('whole native slots fit exact independent boundaries and collector uses the reserved tail',()=>{
 const anchor=1000000000n;
 for(const [work,elapsed]of [[120000,1490000],[30000,1580000],[720000,890000],[20000,1780000]]){
  const at=anchor+BigInt(elapsed)*1000000n;assert.equal(stageBudget(anchor,at,work).elapsedMs,elapsed);
  assert.throws(()=>stageBudget(anchor,at+1000000n,work));
 }
 assert.equal(stageBudget(anchor,anchor,20000).reserveMs,0);
 assert.equal(stageBudget(anchor,anchor,720000).reserveMs,180000);
 assert.throws(()=>stageBudget(0n,anchor,720000));assert.throws(()=>stageBudget(anchor,anchor-1n,720000));
 assert.throws(()=>stageBudget(anchor,anchor,1));assert.throws(()=>stageBudget('claimed',anchor,720000));
});
test('OOM, timeout, missing count, diagnostics and unsettled native close never become completion',()=>{
 const result={closed:true,code:0,signal:null,stoppedBecause:null};
 assert.equal(compilerOutcome(result,'Files: 11\n').compilerCompleted,true);
 for(const [change,text]of [[{code:134},'FATAL ERROR: Allocation failed - heap out of memory'],
  [{code:124},'Files: 11'],[{signal:'SIGABRT'},'Files: 11'],[{closed:false},'Files: 11'],
  [{stoppedBecause:'output-cap'},'Files: 11'],[{error:'spawn failed'},'Files: 11'],
  [{stopError:'unknown'},'Files: 11'],[{},'Files: 11\nx.ts(1,1): error TS2322: wrong'],
  [{},''],[{},'Files: claimed']]){
  assert.equal(compilerOutcome({...result,...change},text).compilerCompleted,false);
 }
 assert.equal(compilerOutcome({...result,code:134},'FATAL ERROR: heap out of memory').v8HeapFailure,true);
 assert.equal(compilerOutcome(result,'Files: 11').wrapperSignalIsNotAssumedNativeCompilerSignal,true);
});
test('held private files use real bytes and refuse public modes, symlinks, hardlinks and oversize',()=>{
 const root=fixture(),file=join(root,'one'),bytes=Buffer.from('private evidence\n');
 try{
  writeFileSync(file,bytes,{flag:'wx',mode:0o600});assert.deepEqual(readHeld(file,100,true).bytes,bytes);
  assert.equal(readHeld(file,100,true).sha256,digest(bytes));assert.throws(()=>readHeld(file,bytes.length-1,true));
  chmodSync(file,0o644);assert.throws(()=>readHeld(file,100,true));chmodSync(file,0o600);
  const linked=join(root,'linked');linkSync(file,linked);assert.throws(()=>readHeld(file,100,true));unlinkSync(linked);
  const symlink=join(root,'symlink');symlinkSync(file,symlink);assert.throws(()=>readHeld(symlink,100,true));
  assert.throws(()=>readHeld(root,100,true));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('same stability adjudicator rejects replaced inode, truncation, growth and timestamp drift as data',()=>{
 const root=fixture(),file=join(root,'held');
 try{
  writeFileSync(file,'held',{mode:0o600});const real=lstatSync(file);assert.equal(sameStat(real,real),true);
  for(const patch of [{dev:real.dev+1},{ino:real.ino+1},{size:0},{size:real.size+1},
   {mtimeMs:real.mtimeMs+1},{ctimeMs:real.ctimeMs+1}])assert.equal(sameStat(real,{...real,...patch}),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('actual copy preserves incomplete stock trace bytes without a synthetic closing bracket',()=>{
 const root=fixture(),input=join(root,'trace.json'),output=join(root,'copied.json'),bytes=Buffer.from('[\n{"name":"checkExpression"}');
 try{
  writeFileSync(input,bytes,{mode:0o600});assert.deepEqual(copyHeld(input,output,bytes.length),{bytes:bytes.length,sha256:digest(bytes)});
  assert.deepEqual(readFileSync(output),bytes);
  assert.deepEqual(traceState(output),{present:true,endsWithClosingBracket:false,jsonArrayValidity:'UNKNOWN_NOT_PARSED'});
  assert.throws(()=>copyHeld(input,output,bytes.length));assert.deepEqual(readFileSync(output),bytes);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('tail observation distinguishes presence from valid JSON or complete type catalogue',()=>{
 const root=fixture(),file=join(root,'trace.json');
 try{
  assert.equal(traceState(file).present,false);writeFileSync(file,'[]\n',{mode:0o600});
  assert.equal(traceState(file).endsWithClosingBracket,true);assert.equal(traceState(file).jsonArrayValidity,'UNKNOWN_NOT_PARSED');
  const link=join(root,'link');symlinkSync(file,link);assert.throws(()=>traceState(link));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('closed export limits include metadata, unique members and the reserved manifest byte bound',()=>{
 const entries=[entry('report.json'),entry('inputs.json'),entry('compiler.log'),entry('typegen.json'),
  entry('trace/trace.json'),entry('swap-cleanup.json')];assert.equal(validateExportEntries(entries),60);
 for(const value of [[...entries,entries[0]],[entry('../secret')],[entry('trace/legend.json')],[entry('whole-project.tsbuildinfo')],
  [entry('compiler.log',LIMITS.logBytes+1)],[entry('report.json',LIMITS.reportBytes+1)],
  [entry('inputs.json',LIMITS.metadataBytes+1)],[entry('trace/trace.json',LIMITS.fileBytes+1)],
  [entry('trace/trace.json',LIMITS.fileBytes),entry('trace/types.json',LIMITS.fileBytes)],
  [{...entry('report.json'),sha256:'unverified'}],[entry('report.json',-1)]]){
  assert.throws(()=>validateExportEntries(value));
 }
});
test('actual copy refuses unsafe raw files and never replaces an existing destination',()=>{
 const root=fixture(),input=join(root,'input'),output=join(root,'output');
 try{
  writeFileSync(input,'source',{mode:0o600});writeFileSync(output,'original',{mode:0o600});
  assert.throws(()=>copyHeld(input,output,100));assert.equal(readFileSync(output,'utf8'),'original');
  chmodSync(input,0o644);assert.throws(()=>copyHeld(input,join(root,'new'),100));chmodSync(input,0o600);
  const link=join(root,'link');symlinkSync(input,link);assert.throws(()=>copyHeld(link,join(root,'new'),100));
  assert.throws(()=>copyHeld(input,join(root,'new'),1));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('same actual input postimage reader rejects changed bytes, missing input, unsafe path and expired frontier',()=>{
 const root=fixture(),file=join(root,'input.ts'),bytes=Buffer.from('export const value=1;\n');
 try{
  writeFileSync(file,bytes,{mode:0o600});const rows=[{path:'input.ts',realPath:'input.ts',bytes:bytes.length,sha256:digest(bytes)}];
  const deadline=()=>process.hrtime.bigint()+1000000000n;
  assert.equal(verifyFileManifest(root,rows,deadline()),1);
  writeFileSync(file,'export const value=2;\n');assert.throws(()=>verifyFileManifest(root,rows,deadline()));
  assert.throws(()=>verifyFileManifest(root,[{...rows[0],path:'../foreign.ts'}],deadline()));
  assert.throws(()=>verifyFileManifest(root,rows,1n));
  unlinkSync(file);assert.throws(()=>verifyFileManifest(root,rows,deadline()));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('workflow trace selection keeps default-off ordinary commands, original job cap and bounded failure collection',()=>{
 const text=readFileSync(new URL('../../workflows/alpha-focused-checks.yml',import.meta.url),'utf8');
 const keys=[...text.split('permissions:')[0].matchAll(/^      ([A-Za-z_]+):$/gm)].map(m=>m[1]);
 assert.equal(keys.length,15);assert.equal(new Set(keys).size,15);assert(keys.includes('compiler_full_trace'));
 const block=text.slice(text.indexOf('  typecheck:\n'),text.indexOf('  linux-build:\n')),open=String.fromCharCode(36)+'{{';
 assert(block.includes('timeout-minutes: 30'));assert(block.includes('--typegen'));assert(block.includes('typecheck.sh --full-trace'));
 assert(block.includes("steps.trace-collect.outputs.export_ready == 'true'"));
 assert(block.includes('if: '+open+' always() && inputs.compiler_full_trace }}'));
 assert(block.includes('      - run: pnpm exec next typegen\n        if: '+open+' !inputs.compiler_full_trace }}'));
 assert(block.includes('      - run: bash ../automation/.github/ci/typecheck.sh\n        if: '+open+' !inputs.compiler_full_trace }}'));
 assert(!block.includes('continue-on-error'));
});
