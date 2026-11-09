/** Fixed installed dependency witnesses, shared by the host and both read-only container views. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,isAbsolute,join,relative} from 'node:path';

const MiB=1024**2;
const directoryFields=['dev','ino','uid','gid','mode','mtimeNs','ctimeNs'];
const fileFields=[...directoryFields,'nlink','size'];
const packages=[
 ['next','16.4.1','dist/bin/next','dist/build/swc/index.js'],
 ['typescript','5.9.3','lib/_tsc.js','lib/typescript.js','lib/typescript.d.ts'],
 ['@types/node','20.19.41','index.d.ts','async_hooks.d.ts'],
 ['@types/react','19.2.16','index.d.ts','jsx-runtime.d.ts'],
 ['@types/react-dom','19.2.3','index.d.ts'],
 ['drizzle-orm','0.45.2','index.d.ts','postgres-js/index.d.ts','pg-core/index.d.ts'],
 ['postgres','3.4.9','types/index.d.ts'],
];
const swcName='@next/swc-linux-x64-gnu';
export const protectedDependencyFileCount=packages.reduce((sum,[,,...files])=>sum+1+files.length,2);
const identity=(stat,fields)=>Object.fromEntries(fields.map(key=>[key,String(stat[key])]));
const hash=raw=>createHash('sha256').update(raw).digest('hex');

export function snapshotProtectedDependencies(root){
 assert(isAbsolute(root)&&realpathSync(root)===root);
 const initial=lstatSync(root,{bigint:true});
 assert(initial.isDirectory()&&(initial.mode&0o022n)===0n&&initial.uid===BigInt(process.getuid()));
 const rootBirth=identity(initial,directoryFields);
 const rows=[];
 const buffer=Buffer.allocUnsafe(MiB);
 let selectedBytes=0;
 function packageRoot(path){
  const resolved=realpathSync(path);
  assert(resolved.startsWith(join(root,'.pnpm')+'/')&&lstatSync(resolved).isDirectory());
  return resolved;
 }
 function file(directory,member,maximum,manifest){
  const path=join(directory,member);
  assert.equal(realpathSync(path),path);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=fstatSync(fd,{bigint:true});
   assert(before.isFile()&&before.nlink>0n&&before.size>0n&&before.size<=BigInt(maximum)&&(before.mode&0o022n)===0n);
   const birth=identity(before,fileFields), digest=createHash('sha256');
   const chunks=[];
   let bytes=0;
   for(let count;(count=readSync(fd,buffer,0,buffer.length,null))!==0;){
    bytes+=count;assert(bytes<=Number(before.size));digest.update(buffer.subarray(0,count));
    if(manifest)chunks.push(Buffer.from(buffer.subarray(0,count)));
   }
   assert.equal(bytes,Number(before.size));
   assert.deepEqual(identity(fstatSync(fd,{bigint:true}),fileFields),birth);
   assert.deepEqual(identity(lstatSync(path,{bigint:true}),fileFields),birth);
   if(manifest){
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.deepEqual([value.name,value.version],manifest);
   }
   selectedBytes+=bytes;
   assert(selectedBytes<=512*MiB);
   rows.push({path:relative(root,path),birth,bytes,sha256:digest.digest('hex')});
  }finally{closeSync(fd);}
 }
 let next;
 for(const [name,version,...members] of packages){
  const directory=packageRoot(join(root,name));
  if(name==='next')next=directory;
  file(directory,'package.json',MiB,[name,version]);
  for(const member of members)file(directory,member,16*MiB);
 }
 const swcRequire=createRequire(join(next,'dist/build/swc/index.js'));
 const swc=packageRoot(dirname(swcRequire.resolve(swcName+'/package.json')));
 assert.equal(realpathSync(swcRequire.resolve(swcName)),join(swc,'next-swc.linux-x64-gnu.node'));
 file(swc,'package.json',MiB,[swcName,'16.4.1']);
 file(swc,'next-swc.linux-x64-gnu.node',256*MiB);
 assert(rows.length===protectedDependencyFileCount&&new Set(rows.map(row=>row.path)).size===rows.length);
 assert.deepEqual(identity(lstatSync(root,{bigint:true}),directoryFields),rootBirth);
 return {selectedFileCount:rows.length,selectedBytes,selectedSealSha256:hash(JSON.stringify(rows)),rootBirth};
}

export function publicProtectedDependencySelection(snapshot){
 const {selectedFileCount,selectedBytes,selectedSealSha256,rootBirth}=snapshot;
 assert.equal(selectedFileCount,protectedDependencyFileCount);
 assert(Number.isSafeInteger(selectedBytes)&&selectedBytes>0&&selectedBytes<=512*MiB);
 assert.match(selectedSealSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(Object.keys(rootBirth),directoryFields);
 assert(Object.values(rootBirth).every(value=>typeof value==='string'&&/^[0-9]{1,30}$/.test(value)));
 return {selectedFileCount,selectedBytes,selectedSealSha256,rootBirthSha256:hash(JSON.stringify(rootBirth)),
  selectedFilesOnly:true,physicalReadOnly:true};
}
