import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePdfTools} from './pdf-tools.mjs';
const success=(stdout='',stderr='')=>({status:0,stdout,stderr,errorCode:null,signal:null,elapsedMs:1});
function fixture({present=false,pythonMissing=false,cachedFailure=false,updateFailure=false,installFailure=false,neverReady=false,pipFailure=false,nativeFailure=false,venvFailure=false,pythonUnexpected=false}={}){
 let installed=present,aptAttempts=0;const calls=[];
 const run=(file,args,timeout)=>{
  calls.push({file,args,timeout});
  if(['pdfinfo','pdftotext','pdftoppm'].includes(file))return installed&&!neverReady?success('',file+' version fixture'):({status:null,errorCode:'ENOENT'});
  if(file==='sudo'){
   if(args.includes('update'))return updateFailure?{status:100}:success();
   aptAttempts++;if(installFailure||cachedFailure&&aptAttempts===1)return {status:100,stderr:'retained genuine package miss'};installed=true;return success();
  }
  if(file==='python3'&&args[0]==='-c')return pythonUnexpected?{status:1,stderr:'unrelated real failure'}:pythonMissing&&!aptAttempts?{status:1,stderr:"ModuleNotFoundError: No module named 'ensurepip'"}:success();
  if(file==='python3')return venvFailure?{status:1}:success();
  if(file.endsWith('/pip'))return pipFailure?{status:1}:success();
  if(file.endsWith('/python'))return nativeFailure?{status:1}:success(JSON.stringify({distribution:'PyMuPDF',version:'fixture',nativePdfRoundTrip:true}));
  throw Error('Unexpected command '+file);
 };
 return {calls,run,execute:()=>preparePdfTools({venvPath:'/private/fixture/venv',run})};
}
test('missing tools use current runner indexes first, retain every tool and verify actual native output',()=>{
 const f=fixture(),r=f.execute();assert.equal(r.indexesRefreshed,false);assert.deepEqual(r.installedPackages,['poppler-utils']);assert.equal(f.calls.filter(c=>c.file==='sudo').length,1);assert(!f.calls.some(c=>c.args.includes('update')));assert.equal(r.tools.length,3);assert(r.pymupdf.nativePdfRoundTrip);assert(f.calls.some(c=>c.args.join(' ')==='install --quiet pymupdf'));assert.equal(r.releaseAuthorized,false);
});
test('working installed Poppler binaries avoid apt but still create venv and run required native PDF proof',()=>{
 const f=fixture({present:true}),r=f.execute();assert.deepEqual(r.installedPackages,[]);assert(!f.calls.some(c=>c.file==='sudo'));assert(f.calls.some(c=>c.args.includes('venv')));assert(f.calls.some(c=>c.file.endsWith('/python')));
});
test('a genuine stale-index package failure is retained and triggers exactly one update and retry',()=>{
 const f=fixture({cachedFailure:true,pythonMissing:true}),r=f.execute();assert(r.indexesRefreshed);assert.deepEqual(r.installedPackages,['poppler-utils','python3-venv']);assert.equal(f.calls.filter(c=>c.file==='sudo'&&c.args.includes('install')).length,2);assert.equal(f.calls.filter(c=>c.args.includes('update')).length,1);assert(r.steps.some(s=>s.status===100));
});
test('failed refresh or retry refuses without native proof or accepted setup',()=>{
 for(const input of [{cachedFailure:true,updateFailure:true},{installFailure:true}]){const f=fixture(input);assert.throws(f.execute);assert(!f.calls.some(c=>c.file.endsWith('/python')));}
});
test('missing final tool, venv, pip, native PDF or unexpected Python errors never become setup success',()=>{
 for(const input of [{neverReady:true},{venvFailure:true},{pipFailure:true},{nativeFailure:true},{pythonUnexpected:true}])assert.throws(fixture(input).execute);
});
test('all command probes and installs retain finite time and output boundary contracts',()=>{
 const f=fixture({cachedFailure:true});f.execute();assert(f.calls.every(c=>c.timeout>0&&c.timeout<=180000));assert(f.calls.filter(c=>c.file==='sudo').every(c=>c.args[0]==='-n'&&c.args.includes('DEBIAN_FRONTEND=noninteractive')));
});
