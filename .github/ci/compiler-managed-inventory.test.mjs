/** Small native proof of root decoding, without running the application compiler. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,linkSync,mkdirSync,readdirSync,readFileSync,realpathSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cacheRelative,decodeManagedResult,inventory} from './compiler-managed-inventory.mjs';
import {nativeListedFiles} from './compiler-bounded-input-fingerprint.mjs';

const tool=realpathSync(resolve(process.argv[2]));
const {default:ts}=await import(pathToFileURL(tool));
assert.equal(ts.version,'5.9.3');
process.umask(0o077);
const source=join(realpathSync('/tmp'),'managed-compiler-model-'+randomBytes(12).toString('hex'));
mkdirSync(source,{mode:0o700});
const cache=join(source,cacheRelative);
const cfg={compilerOptions:{strict:true,noEmit:true,incremental:true},include:['next-env.d.ts','fixture.ts','.next/types/*.ts']};
const write=(file,text)=>writeFileSync(join(source,file),text);
try{
 mkdirSync(join(source,'.next/types'),{recursive:true});
 mkdirSync(dirname(cache),{recursive:true});
 write('tsconfig.json',JSON.stringify(cfg));
 write('next-env.d.ts','export {};\n');
 for(const name of ['cache-life.d.ts','root-params.d.ts','routes.d.ts','validator.ts'])write('.next/types/'+name,'export {};\n');
 write('fixture.ts','export const value: string = "valid";\n');
 const run=()=>spawnSync(process.execPath,[join(dirname(tool),'tsc.js'),'--noEmit','--pretty','false',
  '--extendedDiagnostics','--tsBuildInfoFile',cache],{cwd:source,encoding:'utf8',timeout:15000,maxBuffer:128*1024});
 const initial=inventory(source,ts,'a'.repeat(64));
 const localTool=join(source,'node_modules/typescript/lib');
 mkdirSync(localTool,{recursive:true});
 for(const name of readdirSync(dirname(tool))){
  if(/^(?:_?tsc\.js|lib(?:\..+)?\.d\.ts)$/.test(name))copyFileSync(join(dirname(tool),name),join(localTool,basename(name)));
 }
 const listed=spawnSync(process.execPath,[join(localTool,'tsc.js'),'--noEmit','--pretty','false',
  '--tsBuildInfoFile',cache,'--listFilesOnly'],{cwd:source,timeout:15_000,maxBuffer:128*1024});
 assert.equal(listed.status,0);assert.equal(listed.signal,null);assert.equal(listed.stderr.length,0);
 const native=nativeListedFiles(source,listed.stdout);
 assert(initial.roots.every(name=>native.includes(name)));
 assert(!existsSync(cache),'Native list-only operation must leave the strict compiler cold');
 const positive=run();
 assert.equal(positive.status,0);
 assert.equal(positive.signal,null);
 const state=decodeManagedResult(source,ts,initial.roots);
 assert.equal(state.nativeFiles,Number(positive.stdout.match(/^Files:\s+([0-9]+)$/m)?.[1]));
 assert.equal(state.nativeRootSetSha256,initial.public.rootSetSha256);
 assert.equal(state.nativeRoots,6);
 assert.throws(()=>decodeManagedResult(source,ts,initial.roots.map(name=>name==='fixture.ts'?'different.ts':name)),/roots differ/);

 write('.next/types/validator.ts','export const replacement = true;\n');
 assert.notEqual(inventory(source,ts,'a'.repeat(64)).public.generatedSha256,initial.public.generatedSha256);
 write('tsconfig.json',JSON.stringify({...cfg,exclude:['.next/types/validator.ts']}));
 assert.throws(()=>inventory(source,ts,'a'.repeat(64)),/Generated validator/);
 write('tsconfig.json',JSON.stringify(cfg));

 const genuine=readFileSync(cache);
 unlinkSync(cache);
 write('foreign.tsbuildinfo',genuine);
 symlinkSync(join(source,'foreign.tsbuildinfo'),cache);
 assert.throws(()=>decodeManagedResult(source,ts,initial.roots),/path changed/);
 unlinkSync(cache);
 linkSync(join(source,'foreign.tsbuildinfo'),cache);
 assert.throws(()=>decodeManagedResult(source,ts,initial.roots),/link count/);
 unlinkSync(cache);
 for(const modified of [{version:'0.0.0'},{errors:true},{checkPending:true}]){
  write(cacheRelative,JSON.stringify({...JSON.parse(genuine.toString('utf8')),...modified}));
  assert.throws(()=>decodeManagedResult(source,ts,initial.roots),/version differs|pending checks or errors/);
 }
 unlinkSync(cache);
 write('fixture.ts','export const value: string = 1;\n');
 const negative=run();
 assert.equal(negative.signal,null);
 assert(negative.status!==0&&/error TS2322:/.test(negative.stdout));
 assert.throws(()=>decodeManagedResult(source,ts,initial.roots),/pending checks or errors/);
 console.log('Native managed output, complete roots, generated validator and failure controls passed');
}finally{rmSync(source,{recursive:true,force:true});}
