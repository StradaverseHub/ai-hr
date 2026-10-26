import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePdfTools,pdfSetupUnit,validatePdfSetupProof} from './pdf-tools.mjs';
const success=(stdout='',stderr='')=>({status:0,stdout,stderr,errorCode:null,signal:null,elapsedMs:1});
function fixture({present=false,pythonMissing=false,updateFailure=false,installFailure=false,neverReady=false,pipFailure=false,nativeFailure=false,venvFailure=false,pythonUnexpected=false}={}){
 let installed=present,aptAttempts=0;const calls=[];
 const run=(file,args,timeout)=>{
  calls.push({file,args,timeout});
  if(['pdfinfo','pdftotext','pdftoppm'].includes(file))return installed&&!neverReady?success('',file+' version fixture'):({status:null,errorCode:'ENOENT'});
  if(file==='sudo'){
   if(args.includes('update'))return updateFailure?{status:100}:success();
   aptAttempts++;if(installFailure)return {status:100,stderr:'retained genuine package miss'};installed=true;return success();
  }
  if(file==='python3'&&args[0]==='-c')return pythonUnexpected?{status:1,stderr:'unrelated real failure'}:pythonMissing&&!aptAttempts?{status:1,stderr:"ModuleNotFoundError: No module named 'ensurepip'"}:success();
  if(file==='python3')return venvFailure?{status:1}:success();
  if(file.endsWith('/pip'))return pipFailure?{status:1}:success();
  if(file.endsWith('/python'))return nativeFailure?{status:1}:success(JSON.stringify({distribution:'PyMuPDF',version:'fixture',nativePdfRoundTrip:true}));
  throw Error('Unexpected command '+file);
 };
 return {calls,run,execute:()=>preparePdfTools({venvPath:'/private/fixture/venv',run})};
}
test('required missing tools refresh once, retain every tool and verify actual native output',()=>{
 const f=fixture(),r=f.execute();assert.equal(r.indexesRefreshed,true);assert.deepEqual(r.installedPackages,['poppler-utils']);assert.equal(f.calls.filter(c=>c.file==='sudo').length,2);assert.equal(f.calls.filter(c=>c.args.includes('update')).length,1);assert.equal(r.tools.length,3);assert(r.pymupdf.nativePdfRoundTrip);assert(f.calls.some(c=>c.args.join(' ')==='install --quiet pymupdf'));assert.equal(r.releaseAuthorized,false);
});
test('working installed Poppler binaries avoid apt but still create venv and run required native PDF proof',()=>{
 const f=fixture({present:true}),r=f.execute();assert.deepEqual(r.installedPackages,[]);assert(!f.calls.some(c=>c.file==='sudo'));assert(f.calls.some(c=>c.args.includes('venv')));assert(f.calls.some(c=>c.file.endsWith('/python')));
});
test('missing Python capability installs the complete required package set after the refresh',()=>{
 const f=fixture({pythonMissing:true}),r=f.execute();assert(r.indexesRefreshed);assert.deepEqual(r.installedPackages,['poppler-utils','python3-venv']);assert.equal(f.calls.filter(c=>c.file==='sudo'&&c.args.includes('install')).length,1);assert.equal(f.calls.filter(c=>c.args.includes('update')).length,1);assert(f.calls.findIndex(c=>c.args.includes('update'))<f.calls.findIndex(c=>c.args.includes('install')));
});
test('failed refresh or install refuses without native proof or accepted setup',()=>{
 for(const input of [{updateFailure:true},{installFailure:true}]){const f=fixture(input);assert.throws(f.execute);assert(!f.calls.some(c=>c.file.endsWith('/python')));}
});
test('missing final tool, venv, pip, native PDF or unexpected Python errors never become setup success',()=>{
 for(const input of [{neverReady:true},{venvFailure:true},{pipFailure:true},{nativeFailure:true},{pythonUnexpected:true}])assert.throws(fixture(input).execute);
});
test('all command probes and installs retain finite time and output boundary contracts',()=>{
 const f=fixture();f.execute();assert(f.calls.every(c=>c.timeout>0&&c.timeout<=180000));assert(f.calls.filter(c=>c.file==='sudo').every(c=>c.args[0]==='-n'&&c.args.includes('DEBIAN_FRONTEND=noninteractive')));
});

function proofFixture(required){const unit={id:'nodb-fixture',kind:'nodb',files:[required?'test/r379-pcb2ii-pdf.test.ts':'test/plain.test.ts'],pdfTools:required};const plan={sha:'a'.repeat(40),controller:'c'.repeat(40),fingerprint:'source-bound-plan',units:[unit]};const binding={unit:unit.id,candidate:plan.sha,controller:plan.controller,fingerprint:plan.fingerprint,pdfToolsRequired:required,releaseAuthorized:false};return {plan,unit,binding};}
test('units without external PDF dependencies retain exact source-bound setup proof and no commands',()=>{
 const {plan,unit,binding}=proofFixture(false),proof={...binding,kind:'NO_EXTERNAL_PDF_TOOLS_REQUIRED_FOR_COMPLETE_UNIT',steps:[]};assert.equal(pdfSetupUnit(plan,unit.id),unit);assert(validatePdfSetupProof(plan,unit,proof));
 for(const patch of [{unit:'foreign'},{candidate:'b'.repeat(40)},{controller:'d'.repeat(40)},{fingerprint:'other'},{pdfToolsRequired:true},{releaseAuthorized:true},{steps:[{}]},{kind:'DISPOSABLE_VALIDATED_PDF_TOOLS_NOT_TEST_OR_RELEASE_PASS'}])assert.throws(()=>validatePdfSetupProof(plan,unit,{...proof,...patch}));
 assert.throws(()=>pdfSetupUnit(plan,'unknown'));assert.throws(()=>pdfSetupUnit({...plan,units:[{...unit,files:['test/r379-pcb2ii-pdf.test.ts']}]},unit.id));
});
test('required PDF suite cannot replace actual three-tool/native proof with a no-dependency or partial proof',()=>{
 const {plan,unit,binding}=proofFixture(true),proof={...fixture().execute(),...binding};assert(validatePdfSetupProof(plan,unit,proof));
 for(const patch of [{tools:[]},{tools:proof.tools.slice(1)},{pymupdf:{nativePdfRoundTrip:false}},{kind:'NO_EXTERNAL_PDF_TOOLS_REQUIRED_FOR_COMPLETE_UNIT'},{pdfToolsRequired:false}])assert.throws(()=>validatePdfSetupProof(plan,unit,{...proof,...patch}));
});
