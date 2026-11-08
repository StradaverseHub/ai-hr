/** Ordinary source/filesystem controls only; never compiler or CI admission proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,linkSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {stableNativeInput,observeLoadedNativeInput,installedPackageContext,candidatePackageContext,withinInputRoot,inputSha} from './application-inputs.mjs';
import {parseNativeExplanation,reconcileNativeMembership,compareAvailableContext,assertFixedInventoryConfig} from './application-protocol.mjs';
import {admitCompilerApplicationInventory,publishCompilerApplicationInventoryClock,readCompilerApplicationInventoryClock} from './admission.mjs';
const scratch=work=>{const root=mkdtempSync(join(tmpdir(),'native-application-control-'));try{return work(root);}finally{rmSync(root,{recursive:true,force:true});}};
test('canonical path containment rejects root, sibling-prefix and traversal ownership',()=>{
 for(const path of ['/owned','/owned-other/a','/a','/owned/../a'])assert(!withinInputRoot('/owned',resolve(path)));assert(withinInputRoot('/owned','/owned/a'));
});
test('empty and UTF16 raw inputs keep distinct exact byte seals',()=>scratch(root=>{
 for(const[name,bytes]of [['empty',Buffer.alloc(0)],['utf16',Buffer.from([255,254,65,0])]]){const path=join(root,name);writeFileSync(path,bytes);const observed=stableNativeInput(path,{root});assert.deepEqual(observed.bytes,bytes);assert.equal(observed.record.sha256,inputSha(bytes));assert.equal(observed.record.bytes,bytes.length);}
}));
test('read-only package hardlinks grant no owned-input custody',()=>scratch(root=>{
 const path=join(root,'source'),alias=join(root,'alias');writeFileSync(path,'fixed');linkSync(path,alias);assert.throws(()=>stableNativeInput(path,{root}));const observed=stableNativeInput(path,{root,readOnlyDependency:true});assert.equal(observed.record.identity.nlink,'2');assert.equal(observed.record.readOnlyDependency,true);assert.equal(readFileSync(alias,'utf8'),'fixed');
}));
test('foreign links, directories, oversized reads and a closed frontier refuse before bytes are accepted',()=>scratch(root=>{
 const path=join(root,'source'),link=join(root,'link');writeFileSync(path,'fixed');symlinkSync(path,link);for(const value of [link,root])assert.throws(()=>stableNativeInput(value,{root}));assert.throws(()=>stableNativeInput(path,{root,maximum:4}));const stopped=Error('frontier closed');assert.throws(()=>stableNativeInput(path,{root,check(){throw stopped;}}),error=>error===stopped);assert.equal(readFileSync(path,'utf8'),'fixed');
}));
test('decoded SourceFile custody model does not confuse BOM bytes with interpreted native text',()=>scratch(root=>{
 // PUBLIC decoder/program stubs test the byte/text distinction, not TypeScript.
 const path=join(root,'source.ts');writeFileSync(path,Buffer.from([255,254,65,0]));const ts={sys:{readFile:()=> 'A'}},program={isSourceFileFromExternalLibrary:()=>false,isSourceFileDefaultLibrary:()=>false},file={fileName:path,text:'A',isDeclarationFile:false,languageVariant:0,languageVersion:4};
 const value=observeLoadedNativeInput(ts,program,file,{source:root,dependencyRoot:join(root,'node_modules'),configured:new Set([path]),check(){}});assert.equal(value.bytes,4);assert.equal(value.loadedTextCodeUnits,1);assert.notEqual(value.sha256,value.loadedTextSha256);assert(value.nativeDecodeMatches);assert.throws(()=>observeLoadedNativeInput(ts,program,{...file,text:'changed'},{source:root,dependencyRoot:join(root,'node_modules'),configured:new Set([path]),check(){}}));
}));
test('available package context retains physical manifests and logical pnpm aliases without following them twice',()=>scratch(root=>{
 const store=join(root,'.pnpm');mkdirSync(store);const physical=join(store,'pkg');mkdirSync(physical);writeFileSync(join(physical,'package.json'),'{"name":"pkg","version":"1"}');writeFileSync(join(physical,'index.js'),'fixed');symlinkSync(physical,join(root,'pkg'));
 const first=installedPackageContext(root);assert.equal(first.packages.length,1);assert.equal(first.aliases.length,1);assert.equal(first.aliases[0].path,'pkg');assert.equal(first.aliases[0].target,'.pnpm/pkg');assert(compareAvailableContext(first,installedPackageContext(root)));writeFileSync(join(physical,'package.json'),'{"name":"pkg","version":"2"}');assert.throws(()=>compareAvailableContext(first,installedPackageContext(root)));
}));
test('candidate context covers mobile vendor aliases and excludes only Git metadata and separately sealed Next generation',()=>scratch(root=>{
 const mobile=join(root,'mobile'),vendor=join(mobile,'vendor'),dependencies=join(mobile,'node_modules');mkdirSync(mobile);mkdirSync(vendor);mkdirSync(dependencies);writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(vendor,'package.json'),'{"name":"vendor"}');symlinkSync(vendor,join(dependencies,'vendor'));const first=candidatePackageContext(root);assert.equal(first.packages.length,2);assert.equal(first.aliases.length,1);mkdirSync(join(root,'.next'));writeFileSync(join(root,'.next','package.json'),'generated separately');mkdirSync(join(root,'.git'));writeFileSync(join(root,'.git','package.json'),'not source lookup context');assert(compareAvailableContext(first,candidatePackageContext(root)));
}));
test('outside and dangling dependency links refuse rather than reading foreign package contents',()=>scratch(root=>{
 const packages=join(root,'node_modules'),foreign=join(root,'foreign');mkdirSync(packages);mkdirSync(foreign);writeFileSync(join(foreign,'package.json'),'foreign');symlinkSync(foreign,join(packages,'pkg'));assert.throws(()=>installedPackageContext(packages));assert.equal(readFileSync(join(foreign,'package.json'),'utf8'),'foreign');rmSync(join(packages,'pkg'));symlinkSync(join(root,'absent'),join(packages,'pkg'));assert.throws(()=>installedPackageContext(packages));
}));
test('native CLI explanation framing retains ALL ordered raw reasons, including unknown future context',()=>{
 const files=parseNativeExplanation('a.ts\n  Matched by include pattern x\n  Unrecognised native fact\nb.ts\n  Imported via "a" from file a.ts\n','/owned');assert.deepEqual(files.map(row=>row.logicalPath),['/owned/a.ts','/owned/b.ts']);assert.deepEqual(files[0].reasons,['Matched by include pattern x','Unrecognised native fact']);
 for(const raw of ['', '  orphan\n','a.ts\n','a.ts\n  root\na.ts\n  root\n','\tinvalid\n'])assert.throws(()=>parseNativeExplanation(raw,'/owned'));
});
const inventory=()=>({roots:['/owned/a.ts'],files:[{logicalPath:'/owned/a.ts',path:'/owned/a.ts',declaration:false,external:false,defaultLibrary:false},{logicalPath:'/owned/b.ts',path:'/owned/b.ts',declaration:false,external:false,defaultLibrary:false}],observations:[{from:'/owned/a.ts',target:{logicalPath:'/owned/b.ts'}},{from:'/owned/b.ts',target:{logicalPath:'/owned/a.ts'}}],gaps:[{kind:'ambient-provider-open'}]});
const explanation=()=>parseNativeExplanation('a.ts\n  Matched by include pattern x\nb.ts\n  Imported via "./b" from file a.ts\n  Unknown fact\n','/owned');
test('ordered membership disagreement and an absent original root refuse completion',()=>{
 assert.throws(()=>reconcileNativeMembership([...explanation()].reverse(),inventory()));const changed=inventory();changed.roots.push('/owned/missing.ts');assert.throws(()=>reconcileNativeMembership(explanation(),changed));
});
test('complete membership never launders unresolved context or direct SCC observations into graph/plan qualification',()=>{
 const value=reconcileNativeMembership(explanation(),inventory());assert.equal(value.orderedInventoryComplete,true);for(const key of ['graphComplete','planFeasible','compilerQualified'])assert.equal(value[key],false);assert(value.gaps.some(row=>row.kind==='ambient-provider-open'));assert(value.gaps.some(row=>row.kind==='unknown-native-explanation-form'));assert(value.gaps.some(row=>row.kind==='native-reason-edge-reconciliation-open'));assert.deepEqual(value.observedImplementationComponents,[['/owned/a.ts','/owned/b.ts']]);
});
test('physical aliases and changed available package/link context remain explicit gaps or refusals',()=>{
 const api=inventory();api.files[1].path=api.files[0].path;assert(reconcileNativeMembership(explanation(),api).gaps.some(row=>row.kind==='multiple-native-logical-aliases'));const before={kind:'STABLE_AVAILABLE_PACKAGE_CONTEXT_NOT_NATIVE_READ_TRACE',packages:[],aliases:[]};assert.throws(()=>compareAvailableContext(before,{...before,aliases:[{path:'changed'}]}));assert.throws(()=>compareAvailableContext(before,{...before,kind:'NATIVE_READ_TRACE'}));
});
test('actual API entry admits only two original config paths, never caller-supplied reference configs',()=>{
 for(const path of ['/owned/tsconfig.json','/owned/tsconfig.build.json'])assertFixedInventoryConfig('/owned',path);for(const path of ['/foreign/tsconfig.json','/owned/generated.json','/owned/.next/tsconfig.json'])assert.throws(()=>assertFixedInventoryConfig('/owned',path));
});
test('ordinary processes and fabricated proof objects cannot publish or read the application native clock',()=>scratch(root=>{
 assert.throws(()=>admitCompilerApplicationInventory());for(const role of ['foreign','inventory-worker'])assert.throws(()=>admitCompilerApplicationInventory(role));const proof={destination:root};assert.throws(()=>publishCompilerApplicationInventoryClock(proof,undefined,process.hrtime.bigint()));assert.throws(()=>readCompilerApplicationInventoryClock(proof));
}));
test('complete inverse restores every changed existing owner and the qualified kernel remains exact',()=>{
 const inverse=JSON.parse(readFileSync(new URL('./application-owner-inverse.json',import.meta.url)));assert.equal(inverse.base,'1ffaffae266870a0b298ec8094433eeeb0dcb57e');assert(inverse.files.length>=4);
 for(const row of inverse.files){const current=readFileSync(new URL('../../../../'+row.path,import.meta.url));assert.equal(createHash('sha256').update(current).digest('hex'),row.currentSha256);const original=Buffer.from(row.originalBase64,'base64');assert.equal(createHash('sha256').update(original).digest('hex'),row.originalSha256);assert(original.length>0);}
 const kernel=readFileSync(new URL('../../owned-process.py',import.meta.url));assert.equal(createHash('sha256').update(kernel).digest('hex'),'9d48394fdc1897c53b5fcd5a581fc53b016c111fcc9aa69679daeb732faf2129');
});
