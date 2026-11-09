/** Pure/source/filesystem controls; no compiler, Next or native server invocation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,chmodSync,symlinkSync,linkSync,unlinkSync,rmSync,lstatSync,mkdirSync,truncateSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retainTraceDiagnostics,validateWorkflowRef,LIMITS,validatePairData,validateTraceInputs,stageBudget,stockCommand,compilerOutcome,
 readHeld,sameStat,validateExportEntries,copyHeld,traceState,validateAnchorData,validateProducerFragment,
 validateTypegenSuccess,verifyFileManifest,cleanupReceiptRequired,validateCurrentTraceData,validateCurrentTraceInputs,
 summarizeStockTrace,phaseSummary} from './compiler-full-trace.mjs';
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


/** Real fixed retention operation only; these fixtures do not authenticate a hosted producer. */
function retentionFixture(){
 const base=fixture(),root=join(base,'diagnostic-compiler-full-trace'),pending=join(base,'compiler-full-trace-export-pending');
 mkdirSync(root,{mode:0o700});mkdirSync(pending,{mode:0o700});mkdirSync(join(root,'trace'),{mode:0o700});
 const report=Buffer.from('{"nativePhase":"fixed fixture only","complete":false}\n'),log=Buffer.from('FATAL ERROR: fixture heap allocation failed\n');
 writeFileSync(join(root,'report.json'),report,{mode:0o600});writeFileSync(join(root,'compiler.log'),log,{mode:0o600});
 writeFileSync(join(root,'resources.json'),'{}\n',{mode:0o600});
 return {base,root,pending,report,log,cleanup:()=>rmSync(base,{recursive:true,force:true})};
}
const nineMembers=['report.json','inputs.json','resources.json','compiler.log','monitor.jsonl','typegen.json',
 'swap-cleanup.json','trace/trace.json','trace/types.json'];
function assertSafeRefusal(f,result,firstFailure){
 assert.equal(result.status,1);assert.equal(result.refused,true);assert.equal(result.complete,false);assert.equal(result.rawCaptureComplete,false);
 assert.equal(result.firstFailure,firstFailure);assert.equal(result.safeMetadataRetained,true);
 assert.deepEqual(readFileSync(join(result.retentionRoot,'report.json')),f.report);
 assert.deepEqual(readFileSync(join(result.retentionRoot,'compiler.log')),f.log);
 assert(!readdirSync(result.retentionRoot).includes('trace'));assert(!exists(join(result.retentionRoot,'whole-project.tsbuildinfo')));
 assert.deepEqual(result.inventory.map(row=>row.path),nineMembers);
 assert.deepEqual([...result.files.map(row=>row.path),...result.omitted.map(row=>row.path)].sort(),nineMembers.slice().sort());
 assert(result.omitted.every(row=>nineMembers.includes(row.path)&&typeof row.reason==='string'));
}
const exists=path=>{try{lstatSync(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
test('actual fixed retention omits unsafe raw member while preserving exact safe report/log and complete known-member facts',()=>{
 const f=retentionFixture();
 try{
  const secret=join(f.base,'foreign');writeFileSync(secret,'foreign bytes',{mode:0o600});
  symlinkSync(secret,join(f.root,'trace/types.json'));writeFileSync(join(f.root,'trace/trace.json'),'[incomplete',{mode:0o600});
  const result=retainTraceDiagnostics(f.root,f.pending);assertSafeRefusal(f,result,'MEMBER_UNSAFE');
  assert.deepEqual(result.omitted.find(row=>row.path==='trace/types.json'),{path:'trace/types.json',bytes:lstatSync(join(f.root,'trace/types.json')).size,kind:'SYMLINK',reason:'UNSAFE_CUSTODY'});
  assert.equal(result.omitted.find(row=>row.path==='trace/trace.json').reason,'RAW_CAPTURE_REFUSED');
  assert(!result.files.some(row=>row.path.startsWith('trace/')));assert.equal(readFileSync(secret,'utf8'),'foreign bytes');
 }finally{f.cleanup();}
});
test('actual sparse over-cap raw member is refused before payload copy and other safe bytes survive',()=>{
 const f=retentionFixture();
 try{
  const huge=join(f.root,'trace/types.json');writeFileSync(huge,'',{mode:0o600});truncateSync(huge,LIMITS.fileBytes+1);
  const result=retainTraceDiagnostics(f.root,f.pending);assertSafeRefusal(f,result,'MEMBER_OVERSIZE');
  assert.equal(result.omitted.find(row=>row.path==='trace/types.json').bytes,LIMITS.fileBytes+1);
  assert.equal(result.omitted.find(row=>row.path==='trace/types.json').reason,'OVERSIZE');
 }finally{f.cleanup();}
});
test('actual two sparse512MiB raw files refuse aggregate budget including manifest while safe metadata survives',()=>{
 const f=retentionFixture();
 try{
  for(const name of ['trace.json','types.json']){const path=join(f.root,'trace',name);writeFileSync(path,'',{mode:0o600});truncateSync(path,LIMITS.fileBytes);}
  const result=retainTraceDiagnostics(f.root,f.pending);assertSafeRefusal(f,result,'AGGREGATE_LIMIT');
  for(const name of ['trace/trace.json','trace/types.json'])assert.deepEqual(result.omitted.find(row=>row.path===name),
   {path:name,bytes:LIMITS.fileBytes,kind:'REGULAR',reason:'RAW_CAPTURE_REFUSED'});
  assert.equal(readdirSync(join(f.pending,'raw')).length,0);
 }finally{f.cleanup();}
});
test('actual fallback omits an unsafe safe member independently while other safe metadata remains exact',()=>{
 const f=retentionFixture();
 try{
  const foreign=join(f.base,'foreign-log');writeFileSync(foreign,'must not copy',{mode:0o600});
  unlinkSync(join(f.root,'compiler.log'));symlinkSync(foreign,join(f.root,'compiler.log'));
  const result=retainTraceDiagnostics(f.root,f.pending);assert.equal(result.status,1);assert.equal(result.firstFailure,'MEMBER_UNSAFE');
  assert.equal(result.complete,false);assert.deepEqual(readFileSync(join(result.retentionRoot,'report.json')),f.report);
  assert.equal(readFileSync(join(result.retentionRoot,'resources.json'),'utf8'),'{}\n');assert(!exists(join(result.retentionRoot,'compiler.log')));
  assert.equal(result.omitted.find(row=>row.path==='compiler.log').reason,'UNSAFE_CUSTODY');
  assert.deepEqual([...result.files.map(row=>row.path),...result.omitted.map(row=>row.path)].sort(),nineMembers.slice().sort());
 }finally{f.cleanup();}
});
test('actual cleanup-refusal path keeps its first failure/nonzero status and never publishes raw trace or buildinfo',()=>{
 const f=retentionFixture();
 try{
  for(const name of ['trace.json','types.json'])writeFileSync(join(f.root,'trace',name),'[]\n',{mode:0o600});
  writeFileSync(join(f.root,'whole-project.tsbuildinfo'),'private compiler state',{mode:0o600});
  const cleanup=Buffer.from('{"cleanupExit":1,"swapAbsent":false}\n');writeFileSync(join(f.root,'swap-cleanup.json'),cleanup,{mode:0o600});
  const result=retainTraceDiagnostics(f.root,f.pending,'SWAP_CLEANUP_REFUSED');assertSafeRefusal(f,result,'SWAP_CLEANUP_REFUSED');
  assert.deepEqual(readFileSync(join(result.retentionRoot,'swap-cleanup.json')),cleanup);
  assert.equal(result.compilerCompletion,'NOT_ADJUDICATED_BY_FILE_RETENTION');
  assert.throws(()=>retainTraceDiagnostics(f.root,f.pending,'arbitrary reason'));
 }finally{f.cleanup();}
});
test('actual unknown raw-name refusal preserves all fixed omission facts without reflecting or copying the unknown path',()=>{
 const f=retentionFixture();
 try{
  const name='foreign-private-filename';writeFileSync(join(f.root,name),'foreign',{mode:0o600});
  const result=retainTraceDiagnostics(f.root,f.pending);assertSafeRefusal(f,result,'UNKNOWN_RAW_MEMBER');
  assert(!JSON.stringify(result).includes(name));assert(!exists(join(result.retentionRoot,name)));
 }finally{f.cleanup();}
});
test('actual fixed file operation copies both raw files exactly and distinguishes missing native output from completeness',()=>{
 for(const missing of [false,true]){
  const f=retentionFixture();
  try{
   for(const name of ['inputs.json','monitor.jsonl','typegen.json','swap-cleanup.json'])writeFileSync(join(f.root,name),'{}\n',{mode:0o600});
   const trace=Buffer.from('[{"name":"fixture"}'),types=Buffer.from('[]\n');writeFileSync(join(f.root,'trace/trace.json'),trace,{mode:0o600});
   if(!missing)writeFileSync(join(f.root,'trace/types.json'),types,{mode:0o600});
   const result=retainTraceDiagnostics(f.root,f.pending);assert.equal(result.refused,false);
   assert.deepEqual(readFileSync(join(result.retentionRoot,'trace/trace.json')),trace);
   assert.equal(result.complete,!missing);assert.equal(result.rawCaptureComplete,!missing);assert.equal(result.status,missing?1:0);assert.equal(result.files.length,missing?8:9);
   assert.equal(result.trace.jsonArrayValidity,'UNKNOWN_NOT_PARSED');assert.equal(result.trace.endsWithClosingBracket,false);
   for(const row of result.files)assert.equal(row.sha256,digest(readFileSync(join(result.retentionRoot,row.path))));
   if(missing)assert.equal(result.firstFailure,'RAW_CAPTURE_INCOMPLETE');
  }finally{f.cleanup();}
 }
});
test('actual workflow-ref adjudicator admits only main and one literal commissioning branch as data, never hosted authority',()=>{
 const prefix='StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/heads/',commission='codex/compiler-full-stock-trace-mode-20261109';
 for(const value of [prefix+'main',prefix+commission])assert.equal(validateWorkflowRef(value),value);
 for(const value of [undefined,null,'',prefix+'alpha',prefix+'codex/compiler-full-stock-trace-recovery-20261109',prefix+commission+'-extra',
  prefix+commission+'\n',prefix+commission+'/',prefix+'main/extra',prefix.replace('StradaverseHub','foreign')+'main',
  prefix.replace('alpha-focused-checks.yml','other.yml')+'main',prefix.replace('refs/heads','refs/tags')+commission,
  'foreign/'+prefix+'main'])assert.throws(()=>validateWorkflowRef(value));
});

test('actual unreadable safe member causes raw copy refusal and isolated fallback retains other complete safe bytes',()=>{
 assert.notEqual(process.getuid(),0,'Real private-file refusal requires the standard unprivileged runner');
 const f=retentionFixture();
 try{
  chmodSync(join(f.root,'resources.json'),0o200);
  const result=retainTraceDiagnostics(f.root,f.pending);assertSafeRefusal(f,result,'RAW_COPY_REFUSED');
  assert.deepEqual(result.rawFailureFact,{point:'COPY',path:'resources.json',reason:'RAW_COPY_REFUSED'});
  assert.equal(result.omitted.find(row=>row.path==='resources.json').reason,'SAFE_COPY_REFUSED');
  assert(!exists(join(result.retentionRoot,'resources.json')));
  assert.deepEqual(readFileSync(join(f.pending,'raw/report.json')),f.report);
  assert.notEqual(result.retentionRoot,join(f.pending,'raw'));
 }finally{chmodSync(join(f.root,'resources.json'),0o600);f.cleanup();}
});

test('new cohort requires one exact frozen manifest successor and rejects historical or mixed requests',()=>{
 const current=JSON.parse(readFileSync(new URL('./compiler-full-trace-current.json',import.meta.url),'utf8'));
 assert.equal(validateCurrentTraceData(current).base,'db88dffc4de594329a95002c34999a18ba3dcde0');
 assert.equal(validateCurrentTraceInputs(selection(current),current),current);
 for(const value of [selection(original.control),selection(original.candidate),{...selection(current),selected_tests:'["foreign"]'},
  {...selection(current),run_build:true},{...selection(current),extra:'private'},{...selection(current),model_eval:'private'}]){
  assert.throws(()=>validateCurrentTraceInputs(value,current));
 }
 for(const mutate of [row=>row.tree='unknown',row=>row.cohort='FOREIGN',row=>row.common.pop(),row=>row.manifestOutputs.reverse(),
  row=>row.trackedInputCount++,row=>row.branch='codex/foreign']){
  const row=structuredClone(current);mutate(row);assert.throws(()=>validateCurrentTraceData(row));
 }
});

test('owned stock prefix yields only numeric aggregates and tracked-owner hashes after truncation',()=>{
 const base=fixture(),path=join(base,'trace.json'),source=join(base,'source'),owned='test/fixed.ts';
 const event=(cat,name,ph,ts,args)=>({cat,name,ph,ts,pid:1,tid:1,args});
 try{
  const rows=[event('parse','createSourceFile','B',1,{path:'private absolute path'}),
   event('check','checkSourceFile','B',10,{path:source+'/'+owned}),
   event('checkTypes','structuredTypeRelatedTo','X',15,{sourceId:58919,targetId:59419,display:'private compiler text'}),
   event('check','checkSourceFile','E',30,{path:source+'/'+owned}),
   event('check','checkSourceFile','B',40,{path:'private foreign absolute path'})];
  writeFileSync(path,'[\n'+rows.map(row=>JSON.stringify(row)+',\n').join('')+'{"truncatedPrivate":"unfinished',{mode:0o600});
  const summary=summarizeStockTrace(path,source,new Set([owned]),process.hrtime.bigint()+5000000000n);
  assert.equal(summary.events,5);assert.equal(summary.stop,'INCOMPLETE_FINAL_LINE');assert.equal(summary.openCheckIntervals,1);
  assert.deepEqual(summary.groups.test,{intervals:1,durationUs:20});assert.equal(summary.counts.relations,1);
  assert.deepEqual(summary.top,[{ownerSha256:digest(owned),durationUs:20}]);
  const raw=JSON.stringify(summary);
  for(const privateText of ['private','58919','59419','fixed.ts','truncatedPrivate'])assert(!raw.includes(privateText));
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('redacted trace observes real array closure but refuses unsafe custody, malformed prefixes and expired projection',()=>{
 const base=fixture(),path=join(base,'trace.json'),link=join(base,'link.json'),source=join(base,'source');
 const deadline=()=>process.hrtime.bigint()+5000000000n;
 try{
  writeFileSync(path,'[\n{"cat":"test","name":"metadata","ph":"I"}\n]\n',{mode:0o600});
  assert.equal(summarizeStockTrace(path,source,new Set(),deadline()).stop,'CLOSING_LINE_OBSERVED');
  assert.equal(summarizeStockTrace(path,source,new Set(),1n).stop,'TIME_BOUND');
  symlinkSync(path,link);assert.throws(()=>summarizeStockTrace(link,source,new Set(),deadline()));
  writeFileSync(path,'[\nnot-json\n]\n');
  assert.equal(summarizeStockTrace(path,source,new Set(),deadline()).stop,'INVALID_PREFIX');
  writeFileSync(path,'[\n'+'x'.repeat(16385)+'\n');
  assert.equal(summarizeStockTrace(path,source,new Set(),deadline()).stop,'LINE_BOUND');
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('phase projection retains actual bounded OOM and resource facts without raw diagnostics or argv',()=>{
 const raw=Buffer.from('Command terminated by signal 6\n\tMaximum resident set size (kbytes): 12836532\nprivate diagnostic text\n');
 const phase={name:'check',logStartByte:0,logEndByte:raw.length,closed:true,code:134,signal:null,elapsedMs:480000,
  v8HeapFailure:true,diagnosticsObserved:0,compilerCompleted:false,error:'private raw error',args:['private args']};
 assert.deepEqual(phaseSummary(phase,raw),{stage:'check',closed:true,exit:134,wrapperSignal:null,termination:null,
  timeObservedSignal:6,elapsedMs:480000,maxRssKiB:12836532,v8HeapFailure:true,diagnostics:0,compilerCompleted:false});
 const unavailable=phaseSummary({...phase,closed:false,logEndByte:raw.length+1},raw);
 assert.equal(unavailable.maxRssKiB,null);assert.equal(unavailable.timeObservedSignal,null);
 assert.equal(unavailable.compilerCompleted,false);
 assert.equal(phaseSummary({...phase,code:0,compilerCompleted:true},raw).compilerCompleted,false);
});

test('new trace collector receives only the four actual typed step-outcome channels',()=>{
 const text=readFileSync(new URL('../../workflows/alpha-focused-checks.yml',import.meta.url),'utf8');
 for(const step of ['source','setup','typegen','check']){
  assert.equal(text.split('id: trace-'+step).length,2);
  const outcome='AIHR_TRACE_'+step.toUpperCase()+'_OUTCOME: '+String.fromCharCode(36)+'{{ steps.trace-'+step+'.outcome }}';
  assert(text.includes(outcome));
 }
 const branch='refs/heads/codex/compiler-full-stock-trace-db88-20261109';
 const oldUpload=text.slice(text.indexOf('      - name: Retain private compiler diagnostic bytes'),text.indexOf('      - name: Retain only the closed current compiler summary'));
 const currentUpload=text.slice(text.indexOf('      - name: Retain only the closed current compiler summary'),text.indexOf('  linux-build:\n'));
 assert(oldUpload.includes("github.ref != '"+branch+"'"));
 assert(currentUpload.includes("github.ref == '"+branch+"'"));
 assert.deepEqual(currentUpload.match(/^          path:.*$/gm),['          path: '+String.fromCharCode(36)+'{{ runner.temp }}/compiler-full-trace-export/summary.json']);
});
