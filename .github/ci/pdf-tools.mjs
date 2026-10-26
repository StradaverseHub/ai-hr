/** Validate every required tool in the dedicated source-audited PDF suite. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,appendFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlan} from './plan.mjs';
import {PDF_TOOL_CONSUMERS} from './pdf-tool-scope.mjs';
const tools=['pdfinfo','pdftotext','pdftoppm'];
const nativeProbe='import fitz,json,importlib.metadata as m; d=fitz.open(); p=d.new_page(width=144,height=72); p.insert_text((10,20),"AIHR"); b=d.tobytes(); r=fitz.open(stream=b,filetype="pdf"); assert "AIHR" in r[0].get_text(); assert r[0].get_pixmap().width==144; print(json.dumps({"distribution":"PyMuPDF","version":m.version("PyMuPDF"),"nativePdfRoundTrip":True}))';
const execute=(file,args,timeout)=>{
 const began=Date.now(),r=spawnSync(file,args,{encoding:'utf8',timeout,maxBuffer:2*1024**2});
 return {status:r.status,errorCode:r.error?.code??null,signal:r.signal??null,stdout:r.stdout??'',stderr:r.stderr??'',elapsedMs:Date.now()-began};
};
/** Injected transport is for private command-boundary fixtures, never environment-based bypasses. */
export function preparePdfTools({venvPath,run=execute,onStep=()=>{}}){
 assert(typeof venvPath==='string'&&venvPath.startsWith('/')&&!venvPath.includes('\0'),'Private absolute venv path required');
 const began=Date.now(),steps=[];
 const command=(label,file,args,timeout=180000)=>{
  const r=run(file,args,timeout);assert(r&&(Number.isInteger(r.status)||r.status===null),'Invalid command outcome');
  const row={label,file,args,status:r.status,errorCode:r.errorCode??null,signal:r.signal??null,elapsedMs:r.elapsedMs??0,stdout:r.stdout??'',stderr:r.stderr??''};steps.push(row);onStep(row);return row;
 };
 const ok=r=>r.status===0&&!r.errorCode&&!r.signal;
 const requireOk=(r,message)=>assert(ok(r),message);
 const probeTools=label=>tools.map(tool=>command(label+' '+tool,tool,['-v'],10000));
 try{
  const before=probeTools('initial');
  for(const r of before)assert(!r.signal&&(!r.errorCode||r.errorCode==='ENOENT'),'PDF tool probe failed unexpectedly');
  const python=command('initial python venv capability','python3',['-c','import venv, ensurepip'],10000);
  assert(!python.errorCode&&!python.signal,'Python capability probe failed unexpectedly');
  const packages=[];if(before.some(r=>!ok(r)))packages.push('poppler-utils');if(!ok(python)){
   assert(/ModuleNotFoundError: No module named '(?:venv|ensurepip)'/.test(python.stderr),'Unexpected Python capability failure');packages.push('python3-venv');
  }
  let indexesRefreshed=false;
  if(packages.length){
   const args=['-n','env','DEBIAN_FRONTEND=noninteractive','apt-get','install','-y','-qq',...packages];
   // The real pilot proved runner indexes stale. Refresh only this required tool suite, once.
   requireOk(command('refresh indexes for required missing PDF packages','sudo',['-n','env','DEBIAN_FRONTEND=noninteractive','apt-get','update','-qq']),'Package index refresh failed');indexesRefreshed=true;
   requireOk(command('install required missing PDF packages','sudo',args),'Required PDF packages could not be installed');
  }
  const ready=probeTools('ready');for(const r of ready)requireOk(r,'Required Poppler tool is unavailable');
  requireOk(command('ready python venv capability','python3',['-c','import venv, ensurepip'],10000),'Python venv is unavailable');
  requireOk(command('create private PDF venv','python3',['-m','venv',venvPath]),'Private PDF venv creation failed');
  requireOk(command('install required PyMuPDF',join(venvPath,'bin/pip'),['install','--quiet','pymupdf']),'PyMuPDF installation failed');
  const native=command('native PDF roundtrip',join(venvPath,'bin/python'),['-c',nativeProbe],15000);requireOk(native,'Native PDF roundtrip failed');
  const pymupdf=JSON.parse(native.stdout);assert(pymupdf.distribution==='PyMuPDF'&&typeof pymupdf.version==='string'&&pymupdf.version&&pymupdf.nativePdfRoundTrip===true,'Incomplete actual native PDF proof');
  return {kind:'DISPOSABLE_VALIDATED_PDF_TOOLS_NOT_TEST_OR_RELEASE_PASS',elapsedMs:Date.now()-began,indexesRefreshed,installedPackages:packages,tools:ready.map(r=>({name:r.file,versionOutput:(r.stdout+r.stderr).trim()})),pymupdf,steps,releaseAuthorized:false};
 }catch(error){error.pdfToolSteps=steps;throw error;}
}
export function pdfSetupUnit(plan,id){
 const unit=plan.units.find(u=>u.id===id);assert(unit&&['db','nodb'].includes(unit.kind)&&typeof unit.pdfTools==='boolean','Exact non-browser unit PDF scope required');
 assert(unit.pdfTools===unit.files.some(f=>PDF_TOOL_CONSUMERS.includes(f)),'Unit PDF dependency scope differs');return unit;
}
export function validatePdfSetupProof(plan,unit,proof){
 assert(pdfSetupUnit(plan,unit.id)===unit,'Exact locally reconstructed PDF unit required');
 assert(proof&&proof.unit===unit.id&&proof.candidate===plan.sha&&proof.controller===plan.controller&&proof.fingerprint===plan.fingerprint&&proof.pdfToolsRequired===unit.pdfTools&&proof.releaseAuthorized===false,'Missing/foreign PDF setup proof');
 if(unit.pdfTools){assert(proof.kind==='DISPOSABLE_VALIDATED_PDF_TOOLS_NOT_TEST_OR_RELEASE_PASS'&&proof.pymupdf?.nativePdfRoundTrip===true&&JSON.stringify(proof.tools?.map(t=>t.name).sort())===JSON.stringify([...tools].sort()),'Complete actual PDF toolchain/native proof required');}
 else assert(proof.kind==='NO_EXTERNAL_PDF_TOOLS_REQUIRED_FOR_COMPLETE_UNIT'&&Array.isArray(proof.steps)&&proof.steps.length===0,'No-dependency unit proof differs');
 return true;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.GITHUB_REPOSITORY_ID==='1333414856','Only the disposable GitHub Linux runner may install PDF tools');
 const temp=process.env.RUNNER_TEMP;assert(temp?.startsWith('/')&&process.env.GITHUB_PATH,'Runner paths required');
 const args=process.argv.slice(2),diagnostic=args.length===0;
 assert(diagnostic?process.env.GITHUB_WORKFLOW==='alpha-staging-diagnostics':args.length===2&&args[0]==='--unit','Exact normal unit or explicit diagnostic required');
 const plan=diagnostic?null:createPlan(),unit=diagnostic?null:pdfSetupUnit(plan,args[1]);
 const binding={candidate:plan?.sha??process.env.AIHR_CI_HEAD??process.env.GITHUB_SHA,controller:process.env.AIHR_CI_CONTROL_HEAD,...(unit?{unit:unit.id,fingerprint:plan.fingerprint,pdfToolsRequired:unit.pdfTools}:{diagnostic:true,pdfToolsRequired:true})};
 const report=join(temp,'pdf-tools-setup.json');
 if(unit&&!unit.pdfTools){
  const proof={kind:'NO_EXTERNAL_PDF_TOOLS_REQUIRED_FOR_COMPLETE_UNIT',...binding,steps:[],releaseAuthorized:false};validatePdfSetupProof(plan,unit,proof);
  writeFileSync(report,JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(proof));
 }else{
  const parent=mkdtempSync(join(temp,'aihr-pdf-tools-')),venvPath=join(parent,'venv');
  try{
   const result=preparePdfTools({venvPath,onStep:r=>console.log(JSON.stringify({pdfToolStep:r.label,status:r.status,errorCode:r.errorCode,elapsedMs:r.elapsedMs}))});
   const proof={...result,...binding,venvPath};if(unit)validatePdfSetupProof(plan,unit,proof);
   writeFileSync(report,JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
   appendFileSync(process.env.GITHUB_PATH,join(venvPath,'bin')+'\n');console.log(JSON.stringify({pdfToolsReady:true,elapsedMs:result.elapsedMs,indexesRefreshed:result.indexesRefreshed,pymupdf:result.pymupdf}));
  }catch(error){writeFileSync(report,JSON.stringify({kind:'FAILED_DISPOSABLE_PDF_SETUP_NOT_TEST_PASS',...binding,error:String(error),steps:error.pdfToolSteps??[],releaseAuthorized:false},null,2)+'\n',{flag:'wx',mode:0o600});throw error;}
 }
}
