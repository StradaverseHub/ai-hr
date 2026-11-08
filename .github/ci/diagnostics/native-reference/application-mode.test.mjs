/** Ordinary guard models only; fabricated nodes are NOT native context proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {observeNativeUsageResolution} from './application-mode.mjs';
test('missing actual parent retains unavailable context without calling mode or resolver or editing the literal',()=>{
 const literal=Object.freeze({text:'./retained',pos:10,end:22,kind:11}),file=Object.freeze({fileName:'/owned/source.ts'}),options=Object.freeze({}),before=Object.getOwnPropertyDescriptors(literal);let calls=0;
 const refused=()=>{calls++;throw Error('Unavailable native mode cannot be guessed');};
 const value=observeNativeUsageResolution({resolveModuleName:refused,sys:Object.freeze({})},{getModeForUsageLocation:refused},file,literal,options);
 assert.deepEqual(value,{mode:null,modeObserved:false,resolutionAttempted:false,nativeParentKind:null,resolvedModule:null});assert.equal(calls,0);assert.deepEqual(Object.getOwnPropertyDescriptors(literal),before);
});
test('a genuine API undefined mode remains observed and reaches unchanged public resolution as undefined',()=>{
 const parent=Object.freeze({kind:273}),literal=Object.freeze({text:'./native',parent}),file=Object.freeze({fileName:'/owned/source.ts'}),options=Object.freeze({}),sys=Object.freeze({}),resolved=Object.freeze({resolvedFileName:'/owned/native.ts'}),calls=[];
 const program={getModeForUsageLocation(actualFile,actualLiteral){assert.equal(actualFile,file);assert.equal(actualLiteral,literal);calls.push('mode');return undefined;}};
 const ts={sys,resolveModuleName(...args){calls.push('resolution');assert.deepEqual(args,['./native','/owned/source.ts',options,sys,undefined,undefined,undefined]);assert.equal(args[2],options);assert.equal(args[3],sys);return{resolvedModule:resolved};}};
 assert.deepEqual(observeNativeUsageResolution(ts,program,file,literal,options),{mode:null,modeObserved:true,resolutionAttempted:true,nativeParentKind:273,resolvedModule:resolved});assert.deepEqual(calls,['mode','resolution']);assert.equal(literal.parent,parent);
});
test('native API errors and explicit modes retain identity instead of being swallowed as missing context',()=>{
 const literal=Object.freeze({text:'./native',parent:Object.freeze({kind:273})}),file={fileName:'/owned/source.ts'},options={},sys={},failure=Error('actual native failure');let resolved=0;
 assert.throws(()=>observeNativeUsageResolution({sys,resolveModuleName(){resolved++;}},{getModeForUsageLocation(){throw failure;}},file,literal,options),error=>error===failure);assert.equal(resolved,0);
 const resolverFailure=Error('actual resolver failure');assert.throws(()=>observeNativeUsageResolution({sys,resolveModuleName(){throw resolverFailure;}},{getModeForUsageLocation(){return 99;}},file,literal,options),error=>error===resolverFailure);
 for(const mode of [1,99]){const result=observeNativeUsageResolution({sys,resolveModuleName(...args){assert.equal(args[6],mode);return{};}},{getModeForUsageLocation(){return mode;}},file,literal,options);assert.equal(result.mode,mode);assert.equal(result.modeObserved,true);assert.equal(result.resolutionAttempted,true);assert.equal(result.resolvedModule,null);}
});

test('whole parent-context inverse retains all three original bodies and current executable source bindings',()=>{
 const inverse=JSON.parse(readFileSync(new URL('./application-parent-context-inverse.json',import.meta.url))),hash=bytes=>createHash('sha256').update(bytes).digest('hex');assert.equal(inverse.base,'267dcb7b8bf8866268734944aa8af2adaa2d6696');
 assert.deepEqual(inverse.files.map(row=>row.path).sort(),['.github/ci/diagnostics/native-reference/application-worker.mjs','docs/qualification/compiler-native-application-inventory-source-20261108.json','test/compiler-native-application-controls.test.ts'].sort());
 // Restore complete current→ACA→a1 bodies before the immutable e54 layer.
 // The current manifest is the only deliberate self-hash exclusion; its full
 // parent preimages and every current component pin are still checked.
 const manifest='docs/qualification/compiler-native-application-inventory-source-20261108.json',restored=new Map();
 for(const[file,base,paths]of [
  ['application-jsdoc-binding-inverse.json','aca13b6136a58e14e2f7445be98483364e81434d',['.github/ci/diagnostics/native-reference/application-mode.test.mjs','.github/ci/diagnostics/native-reference/application-mode-native.test.mjs',manifest]],
  ['application-jsdoc-inverse.json','a1b866f070e2098682813d3fb6c6e60b17fcd9c8',['.github/ci/diagnostics/native-reference/application-worker.mjs','.github/ci/diagnostics/native-reference/application-mode-native.test.mjs','test/compiler-native-usage-mode.test.ts',manifest]],
 ]){
  const layer=JSON.parse(readFileSync(new URL('./'+file,import.meta.url)));assert.equal(layer.base,base);assert.deepEqual(Object.keys(layer.files).sort(),paths.sort());
  for(const[path,row]of Object.entries(layer.files)){const current=restored.has(path)?restored.get(path):readFileSync(new URL('../../../../'+path,import.meta.url));if(row.currentSha256)assert.equal(hash(current),row.currentSha256,path);else assert.equal(path,manifest);const original=Buffer.from(row.originalBase64,'base64');assert.equal(hash(original),row.originalSha256,path);restored.set(path,original);}
 }
 for(const row of inverse.files){assert.equal(hash(Buffer.from(row.originalBase64,'base64')),row.originalSha256);if(row.currentSha256)assert.equal(hash(restored.has(row.path)?restored.get(row.path):readFileSync(new URL('../../../../'+row.path,import.meta.url))),row.currentSha256);else assert.equal(row.path,'docs/qualification/compiler-native-application-inventory-source-20261108.json');}
 const current=JSON.parse(readFileSync(new URL('../../../../docs/qualification/compiler-native-application-inventory-source-20261108.json',import.meta.url)));for(const[path,wanted]of Object.entries(current.componentSources))assert.equal(hash(readFileSync(new URL('../../../../'+path,import.meta.url))),wanted,path);
});
