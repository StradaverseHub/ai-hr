/** Stock TypeScript inventory and result decoder for an isolated measurement. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,readdirSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const cacheRelative='.next/cache/compiler-transport/whole-project.tsbuildinfo';
const generatedTypes=['cache-life.d.ts','root-params.d.ts','routes.d.ts','validator.ts'];
const generatedPaths=['next-env.d.ts',...generatedTypes.map(name=>'.next/types/'+name)];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const encoded=value=>sha(JSON.stringify(value));
const stamp=info=>[info.dev,info.ino,info.size,info.mode,info.uid,info.nlink,info.mtimeNs,info.ctimeNs];

function stableFile(path,maximum,{privateOutput=false,singleLink=false}={}){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd,{bigint:true});
  assert(before.isFile()&&before.size>0n&&before.size<=BigInt(maximum),'Bounded regular compiler member required');
  if(privateOutput||singleLink)assert.equal(before.nlink,1n,'Unexpected compiler member link count');
  if(privateOutput)assert(before.uid===BigInt(process.getuid())&&(before.mode&0o777n)===0o600n,'Private compiler state required');
  const bytes=Buffer.alloc(Number(before.size));
  let offset=0;
  while(offset<bytes.length){
   const count=readSync(fd,bytes,offset,bytes.length-offset,null);
   assert(count>0,'Compiler member truncated');
   offset+=count;
  }
  assert.equal(readSync(fd,Buffer.alloc(1),0,1,null),0,'Compiler member grew while reading');
  assert.deepEqual(stamp(fstatSync(fd,{bigint:true})),stamp(before),'Compiler member changed while reading');
  assert.deepEqual(stamp(lstatSync(path,{bigint:true})),stamp(before),'Compiler member path changed');
  return bytes;
 }finally{closeSync(fd);}
}

function sourcePath(source,path){
 const name=relative(source,path);
 assert(name&&!isAbsolute(name)&&!name.startsWith('../'),'Compiler root outside exact source');
 return name;
}

function generatedSeal(source){
 const types=join(source,'.next/types');
 assert(realpathSync(types)===types&&lstatSync(types).isDirectory(),'Canonical generated types required');
 assert.deepEqual(readdirSync(types).sort(),generatedTypes,'Generated type inventory differs');
 assert(!lstatSync(join(source,'.next/dev'),{throwIfNoEntry:false}),'Development generated types not permitted');
 return generatedPaths.map(name=>{
  const path=join(source,name);
  assert.equal(realpathSync(path),path,'Generated type is not canonical');
  const bytes=stableFile(path,4*1024**2,{singleLink:true});
  return [name,bytes.length,sha(bytes)];
 });
}

function configuredRoots(source,ts){
 const config=join(source,'tsconfig.json');
 const parsed=ts.getParsedCommandLineOfConfigFile(config,{},{
  ...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>assert.fail('Native tsconfig resolution refused'),
 });
 assert(parsed&&parsed.errors.length===0&&!parsed.projectReferences,'Whole native tsconfig required');
 assert(parsed.options.strict===true&&parsed.options.noEmit===true&&parsed.options.incremental===true,'Strict cold build settings differ');
 const roots=parsed.fileNames.map(path=>sourcePath(source,path));
 assert(roots.length>0&&roots.length<=100000&&new Set(roots).size===roots.length,'Bounded unique compiler roots required');
 for(const path of generatedPaths)assert(roots.includes(path),'Generated validator or companion root missing');
 return roots;
}

export function inventory(source,ts,toolSeal){
 const roots=configuredRoots(source,ts),generated=generatedSeal(source);
 return {roots,public:{configuredRoots:roots.length,orderedRootSha256:encoded(roots),
  rootSetSha256:encoded([...roots].sort()),generatedCount:generated.length,generatedSha256:encoded(generated),toolSha256:toolSeal}};
}

export function decodeManagedResult(source,ts,roots){
 const path=join(source,cacheRelative);
 assert.equal(realpathSync(path),path,'Managed build-info path changed');
 const bytes=stableFile(path,64*1024**2,{privateOutput:true}),info=ts.getBuildInfo(path,bytes.toString('utf8'));
 assert(info&&info.version===ts.version&&ts.isIncrementalBuildInfo(info),'Managed incremental build-info version differs');
 assert(info.options?.strict===true&&info.errors===undefined&&info.checkPending===undefined,'Managed build-info has pending checks or errors');
 assert(Array.isArray(info.fileNames)&&Array.isArray(info.fileInfos)&&Array.isArray(info.root)
  &&info.fileInfos.length>0&&info.fileInfos.length<=info.fileNames.length&&info.fileNames.length<=100000,'Bounded native build-info graph required');
 const semantic=info.semanticDiagnosticsPerFile,emit=info.emitDiagnosticsPerFile;
 assert((semantic===undefined||(Array.isArray(semantic)&&semantic.every(id=>Number.isSafeInteger(id)&&id>0&&id<=info.fileInfos.length)))
  &&(emit===undefined||(Array.isArray(emit)&&emit.length===0)),'Managed build-info has pending checks or errors');
 const decoded=ts.getBuildInfoFileVersionMap(info,path,{
  getCurrentDirectory:()=>source,useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,
 });
 assert.equal(decoded.fileInfos.size,info.fileInfos.length,'Duplicate native file graph members');
 const resultRoots=[...decoded.roots.keys()].map(path=>sourcePath(source,path)).sort();
 assert.deepEqual(resultRoots,[...roots].sort(),'Managed build-info roots differ');
 return {buildInfoBytes:bytes.length,buildInfoSha256:sha(bytes),nativeFiles:decoded.fileInfos.size,
  nativeRoots:resultRoots.length,nativeRootSetSha256:encoded(resultRoots)};
}

async function main(){
 const [mode,source,...extra]=process.argv.slice(2);
 assert((mode==='pre'||mode==='post')&&!extra.length&&isAbsolute(source)&&realpathSync(source)===source,'Canonical managed inventory input required');
 const dependencies=join(source,'node_modules');
 assert.equal(realpathSync(dependencies),dependencies,'Canonical dependency tree required');
 const typeScriptRoot=realpathSync(join(dependencies,'typescript')),nextRoot=realpathSync(join(dependencies,'next'));
 for(const root of [typeScriptRoot,nextRoot])sourcePath(dependencies,root);
 const toolRows=(root,names)=>names.map(name=>{
  const path=join(root,name);
  assert.equal(realpathSync(path),path,'Compiler tool member is not canonical');
  const bytes=stableFile(path,32*1024**2);
  return [name,bytes.length,sha(bytes)];
 });
 const tsSeal=toolRows(typeScriptRoot,['package.json','lib/tsc.js','lib/_tsc.js','lib/typescript.js']);
 const nextSeal=toolRows(nextRoot,['package.json','dist/bin/next','dist/cli/next-typegen.js']);
 const {default:ts}=await import(pathToFileURL(join(typeScriptRoot,'lib/typescript.js')));
 assert.equal(ts.version,'5.9.3');
 const next=JSON.parse(stableFile(join(nextRoot,'package.json'),256*1024).toString('utf8'));
 assert.equal(next.version,'16.4.1');
 const current=inventory(source,ts,encoded([ts.version,next.version,tsSeal,nextSeal]));
 const output=mode==='pre'?current.public:{...current.public,...decodeManagedResult(source,ts,current.roots)};
 process.stdout.write(JSON.stringify(output)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(()=>{process.stderr.write('Managed inventory refused\n');process.exitCode=2;});
}
