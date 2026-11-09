/** Read-only native input custody. No compiler host, resolver or cleanup API. */
import assert from 'node:assert/strict';
import {constants,lstatSync,fstatSync,openSync,closeSync,readSync,realpathSync,opendirSync,readlinkSync} from 'node:fs';
import {isAbsolute,relative,resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {REFERENCE_LIMITS} from './graph.mjs';
const fields=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
const same=(a,b)=>fields.every(key=>a[key]===b[key]);
export const inputSha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const withinInputRoot=(root,path)=>{const value=relative(root,path);return value!==''&&value!=='..'&&!value.startsWith('../')&&!isAbsolute(value);};
const identity=stat=>Object.fromEntries(fields.map(key=>[key,String(stat[key])]));
export const APPLICATION_INPUT_LIMITS=Object.freeze({files:50000,packageJson:50000,metadataEntries:1000000,phaseMs:120000});

/** All actual bytes are bounded descriptor reads. The exception is input-only:
 * package-manager hardlinks never acquire owned output/config/disposal rights. */
export function stableNativeInput(path,{root,readOnlyDependency=false,maximum=REFERENCE_LIMITS.fileBytes,check=()=>{}}){
 check();assert(isAbsolute(root)&&realpathSync(root)===root);const rootStat=lstatSync(root,{bigint:true});assert(rootStat.isDirectory()&&!rootStat.isSymbolicLink());
 assert(isAbsolute(path)&&resolve(path)===path&&withinInputRoot(root,path)&&realpathSync(path)===path,'Native input outside its canonical source root');
 assert(Number.isSafeInteger(maximum)&&maximum>=0&&maximum<=REFERENCE_LIMITS.fileBytes);
 const before=lstatSync(path,{bigint:true});assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink>0n&&before.size>=0n&&before.size<=BigInt(maximum));
 assert(readOnlyDependency===true||before.nlink===1n,'Owned input hardlink refused');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),chunks=[];let total=0;
 try{
  assert(same(before,fstatSync(fd,{bigint:true})));const block=Buffer.alloc(65536);
  while(total<Number(before.size)){check();const size=readSync(fd,block,0,Math.min(block.length,Number(before.size)-total),null);assert(size>0,'Native input truncated');chunks.push(Buffer.from(block.subarray(0,size)));total+=size;}
  assert.equal(readSync(fd,block,0,1,null),0,'Native input grew');assert(same(before,fstatSync(fd,{bigint:true}))&&same(before,lstatSync(path,{bigint:true})));
  assert.equal(realpathSync(path),path);const current=lstatSync(root,{bigint:true});for(const key of ['dev','ino','mode','uid','gid'])assert.equal(current[key],rootStat[key]);
  const bytes=Buffer.concat(chunks);assert.equal(bytes.length,Number(before.size));check();return{bytes,record:{path,sha256:inputSha(bytes),bytes:bytes.length,identity:identity(before),readOnlyDependency}};
 }finally{closeSync(fd);}
}

/** SourceFile.text can be decoded BOM/UTF16 text; raw bytes and interpreted text
 * retain distinct seals. The PUBLIC pinned decoder is observed, never replaced. */
export function observeLoadedNativeInput(ts,program,file,{source,dependencyRoot,configured,check}){
 const logical=resolve(file.fileName),path=realpathSync(logical);assert(withinInputRoot(source,path),'Unexpected native source outside candidate');
 const external=program.isSourceFileFromExternalLibrary(file),defaultLibrary=program.isSourceFileDefaultLibrary(file);
 const readOnlyDependency=(external||defaultLibrary)&&withinInputRoot(dependencyRoot,path)&&!configured.has(path);
 const observed=stableNativeInput(path,{root:source,readOnlyDependency,check});
 const decoded=ts.sys.readFile(logical);assert.equal(typeof decoded,'string');assert.equal(decoded,file.text,'Actual native loaded text differs from stable input');
 const after=stableNativeInput(path,{root:source,readOnlyDependency,check});assert.deepEqual(after.record,observed.record);
 return{...observed.record,logicalPath:logical,loadedTextSha256:inputSha(Buffer.from(file.text)),loadedTextCodeUnits:file.text.length,
  nativeDecodeMatches:true,inputKind:file.isDeclarationFile?'declaration':logical.endsWith('.json')?'json':'implementation',extension:logical.match(/\.[^.\/]+$/)?.[0]??null,declaration:file.isDeclarationFile,external,defaultLibrary,languageVariant:file.languageVariant,languageVersion:file.languageVersion,impliedNodeFormat:file.impliedNodeFormat??null};
}

/** Complete stable AVAILABLE package context, not a claim about native reads.
 * Physical traversal never follows a link; logical aliases are separately bound.
 * Artifact/source-file bounds stay unchanged; metadata iteration has its own
 * fixed finite entry refusal and the same outer native clock. */
export function installedPackageContext(root,{check=()=>{}}={}){return availablePackageContext(root,{check,candidate:false});}
export function candidatePackageContext(root,{check=()=>{}}={}){return availablePackageContext(root,{check,candidate:true});}
function availablePackageContext(root,{check,candidate}){
 assert(isAbsolute(root)&&resolve(root)===root&&realpathSync(root)===root);const original=lstatSync(root,{bigint:true});assert(original.isDirectory()&&!original.isSymbolicLink());
 const packages=[],aliases=[];let entries=0,total=0;
 function visit(directory){
  check();const before=lstatSync(directory,{bigint:true});assert(before.isDirectory()&&!before.isSymbolicLink());
  const fd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   assert(same(before,fstatSync(fd,{bigint:true})));const handle=opendirSync(directory,{bufferSize:1});
   try{for(;;){check();const entry=handle.readSync();if(entry===null)break;assert(++entries<=APPLICATION_INPUT_LIMITS.metadataEntries,'Installed package metadata entry bound');
    if(candidate&&directory===root&&['.git','.next'].includes(entry.name))continue;
    const path=join(directory,entry.name),stat=lstatSync(path,{bigint:true});
    if(stat.isSymbolicLink()){
     const target=realpathSync(path);assert(withinInputRoot(root,target),'External installed dependency link refused');
     aliases.push({path:relative(root,path),target:relative(root,target),literal:readlinkSync(path),identity:identity(stat)});assert(same(stat,lstatSync(path,{bigint:true})));continue;
    }
    if(stat.isDirectory())visit(path);
    else if(stat.isFile()&&entry.name==='package.json'){
     assert(packages.length<APPLICATION_INPUT_LIMITS.packageJson);const readOnlyDependency=!candidate||relative(root,path).split('/').includes('node_modules');const value=stableNativeInput(path,{root,readOnlyDependency,check});total+=value.record.bytes;assert(total<=REFERENCE_LIMITS.totalBytes,'Available package metadata byte bound');packages.push(value.record);
    }else assert(stat.isFile(),'Unexpected installed dependency entry kind');
   }}finally{handle.closeSync();}
   assert(same(before,fstatSync(fd,{bigint:true}))&&same(before,lstatSync(directory,{bigint:true})));
  }finally{closeSync(fd);}
 }
 visit(root);for(const key of ['dev','ino','mode','uid','gid'])assert.equal(lstatSync(root,{bigint:true})[key],original[key]);
 packages.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);aliases.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return{kind:'STABLE_AVAILABLE_PACKAGE_CONTEXT_NOT_NATIVE_READ_TRACE',root,packages,aliases,entries,bytes:total};
}
