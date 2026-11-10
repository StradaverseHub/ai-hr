/** Files and private IPC for the fixed hosted comparison only. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
 closeSync,constants,fstatSync,lstatSync,mkdirSync,opendirSync,openSync,readSync,realpathSync,rmdirSync,unlinkSync,writeFileSync,
} from 'node:fs';
import {Socket} from 'node:net';
import {join} from 'node:path';

const directoryFlags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY;
const fileFlags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
const named=(fd,name)=>`/proc/self/fd/${fd}/${name}`;
const stat=path=>lstatSync(path,{bigint:true});
const held=fd=>fstatSync(fd,{bigint:true});
const same=(left,right)=>left.dev===right.dev&&left.ino===right.ino;
const digest=raw=>createHash('sha256').update(raw).digest('hex');
export const WORKER_COMPARISON_CELLS_DIRECTORY='aihr-worker-comparison-cells';
export const comparisonClock=()=>Number(process.hrtime.bigint()/1_000_000n);

function absent(path){
 try{stat(path);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}
}

function openDirectory(path){
 const fd=openSync(path,directoryFlags);
 try{
  const row=held(fd);
  assert(row.isDirectory()&&row.uid===BigInt(process.getuid())&&(row.mode&0o7022n)===0n
   &&same(row,stat(path)),'Worker comparison directory identity refused');
  return fd;
 }catch(error){closeSync(fd);throw error;}
}

export function readComparisonJson(path,maximum,expectedDigest){
 const fd=openSync(path,fileFlags);
 try{
  const row=held(fd);
  const equal=other=>same(row,other)&&['mode','uid','size','nlink','mtimeNs','ctimeNs'].every(key=>row[key]===other[key]);
  assert(row.isFile()&&row.uid===BigInt(process.getuid())&&row.nlink===1n&&row.size>0n
   &&row.size<=BigInt(maximum)&&(row.mode&0o7022n)===0n&&equal(stat(path))&&(expectedDigest===undefined||(row.mode&0o7777n)===0o600n),
  'Worker comparison private evidence file refused');
  const raw=Buffer.alloc(Number(row.size)+1);
  let read=0;
  while(read<raw.length){
   const count=readSync(fd,raw,read,raw.length-read,null);
   if(!count)break;
   read+=count;
  }
  assert(BigInt(read)===row.size&&equal(held(fd))&&equal(stat(path)),'Worker comparison private evidence changed');
  const bytes=raw.subarray(0,read);
  assert(expectedDigest===undefined||digest(bytes)===expectedDigest,'Worker comparison admission seal refused');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{closeSync(fd);}
}

function removeKnown(parent,name,fd,deadline){
 const root=held(fd),owner=BigInt(process.getuid());
 let visits=0;
 const check=()=>assert(comparisonClock()<deadline,'Worker comparison filesystem deadline elapsed');
 function retire(ancestor,member,owned,depth){
  check();
  assert(depth<=48&&same(held(owned),stat(named(ancestor,member))),'Worker comparison retiring directory name changed');
  const directory=opendirSync(`/proc/self/fd/${owned}`);
  try{
   for(let row;(row=directory.readSync())!==null;){
    check();
    const path=named(owned,row.name),before=stat(path);
    assert(++visits<=250000&&before.uid===owner&&before.dev===root.dev,'Worker comparison owned tree bounds refused');
    if(before.isDirectory()){
     const child=openDirectory(path);
     try{
      assert(same(before,held(child)),'Worker comparison child directory changed');
      retire(owned,row.name,child,depth+1);
     }finally{closeSync(child);}
    }else{
     // Unlink an owned symlink itself. Never traverse it or accept linked regular files.
     assert((before.isSymbolicLink()||before.isFile()&&before.nlink===1n)&&same(before,stat(path)),
      'Worker comparison private tree member refused');
     unlinkSync(path);
    }
   }
  }finally{directory.closeSync();}
  check();
  assert(same(held(owned),stat(named(ancestor,member))),'Worker comparison final directory name changed');
  rmdirSync(named(ancestor,member));
  assert(absent(named(ancestor,member)),'Worker comparison retired name is occupied');
 }
 retire(parent,name,fd,0);
 check();
}

export function holdWorkerComparisonFiles(env){
 const sourcePath=env.GITHUB_WORKSPACE+'/source',tempPath=env.RUNNER_TEMP;
 const descriptors=new Set();
 const open=path=>{
  const fd=openDirectory(path);
  descriptors.add(fd);
  return fd;
 };
 function close(fd){
  closeSync(fd);
  descriptors.delete(fd);
 }
 function closeAll(){for(const fd of descriptors)close(fd);}
 try{
  assert(sourcePath===process.cwd()&&realpathSync(sourcePath)===sourcePath&&realpathSync(tempPath)===tempPath,
   'Worker comparison source or temporary root refused');
  const source=open(sourcePath),temp=open(tempPath);
  assert(held(source).dev===held(temp).dev,'Worker comparison source and temporary roots differ');
  function roots(){
   assert(same(held(source),stat(sourcePath))&&same(held(temp),stat(tempPath))
    &&realpathSync(sourcePath)===sourcePath&&realpathSync(tempPath)===tempPath,'Worker comparison root changed');
  }
  function fresh(parent,name){
   const path=named(parent,name);
   mkdirSync(path,{mode:0o700});
   const fd=open(path);
   assert(held(fd).dev===held(parent).dev&&(held(fd).mode&0o7777n)===0o700n,'Worker comparison reservation refused');
   return fd;
  }
  const workName=WORKER_COMPARISON_CELLS_DIRECTORY,outName='system-worker-comparison-evidence';
  const work=fresh(temp,workName),out=fresh(temp,outName);
  const buildName='.next',seedName='aihr-worker-comparison-next';
  let seed=null;
  let current=null;
  let opened=0;
  function retire(parent,name,fd,deadline){
   roots();
   removeKnown(parent,name,fd,deadline);
   close(fd);
  }
  function currentCell(ordinal){
   assert(current?.ordinal===ordinal,'Worker comparison cell ownership refused');
   return current;
  }
  return Object.freeze({
   holdSeed(){
    roots();
    assert(seed===null,'Worker comparison seed already held');
    seed=open(named(temp,seedName));
   },
   openCell(cell){
    roots();
    assert(current===null&&cell.ordinal===opened+1&&opened<3&&absent(named(source,buildName)),
     'Worker comparison prior cell has not settled');
    const directory=fresh(work,cell.name);
    const focused=fresh(temp,'aihr-focused');
    const evidence=fresh(directory,'evidence');
    const base=join(tempPath,workName,cell.name);
    current={ordinal:++opened,name:cell.name,directory,focused,evidence,build:null};
    return {privateDir:base,out:join(base,'evidence'),focusedEvidence:join(tempPath,'aihr-focused')};
   },
   holdBuild(ordinal,view){
    const cell=currentCell(ordinal);
    roots();
    assert(cell.build===null,'Worker comparison runtime build already held');
    const fd=open(named(source,buildName)),row=held(fd);
    assert(String(row.dev)===view.directory.device&&String(row.ino)===view.directory.inode,
     'Worker comparison runtime build birth changed');
    cell.build=fd;
   },
   retireCell(ordinal,deadline){
    const cell=currentCell(ordinal);
    roots();
    if(cell.build===null)assert(absent(named(source,buildName)),'Worker comparison cannot retire an unknown runtime build');
    else{
     roots();
     // The name and tree are gone before reuse. Keep the unlinked inode pinned
     // until the owner closes so the filesystem cannot give it to the next cell.
     removeKnown(source,buildName,cell.build,deadline);
    }
    retire(temp,'aihr-focused',cell.focused,deadline);
    close(cell.evidence);
    retire(work,cell.name,cell.directory,deadline);
    current=null;
   },
   retireSeed(deadline){
    roots();
    assert(current===null&&seed!==null&&absent(named(source,buildName))&&absent(named(temp,'aihr-focused')),
     'Worker comparison previous runtime is still held');
    retire(temp,seedName,seed,deadline);
    seed=null;
    retire(temp,workName,work,deadline);
   },
   publish(value,deadline){
    roots();
    assert(same(held(out),stat(named(temp,outName)))&&comparisonClock()<deadline,'Worker comparison publication refused');
    const raw=JSON.stringify(value,null,2)+'\n';
    assert(Buffer.byteLength(raw)<=124*1024,'Worker comparison public summary exceeds bounds');
    writeFileSync(named(out,'pending.json'),raw,{flag:'wx',mode:0o600});
    assert(same(held(out),stat(named(temp,outName)))&&comparisonClock()<deadline,'Worker comparison publication overran');
   },
   close:closeAll,
  });
 }catch(error){closeAll();throw error;}
}

export function openWorkerComparisonFamily(env){
 assert(/^[1-9][0-9]{0,3}$/.test(env.AIHR_WORKER_COMPARISON_FAMILY_FD??''),
  'Worker comparison private family channel missing');
 const fd=Number(env.AIHR_WORKER_COMPARISON_FAMILY_FD);
 assert(Number.isSafeInteger(fd)&&fd>=3&&fd<=1024,'Worker comparison private family channel refused');
 const socket=new Socket({fd,readable:true,writable:true});
 let pending=null,failed=false,ordinal=0;
 function refuse(){
  failed=true;
  pending?.finish(false);
 }
 socket.on('data',chunk=>{
  if(!pending||failed)return refuse();
  pending.bytes=Buffer.concat([pending.bytes,chunk]);
  if(!pending.expected.subarray(0,pending.bytes.length).equals(pending.bytes))return refuse();
  if(pending.bytes.length===pending.expected.length)pending.finish(true);
 });
 socket.on('error',refuse);
 socket.on('close',refuse);
 return Object.freeze({
  async acknowledge(next,deadline){
   assert(!failed&&!pending&&next===ordinal&&next<=3&&comparisonClock()<deadline,'Worker comparison family barrier refused');
   const accepted=await new Promise(resolve=>{
    const timer=setTimeout(()=>pending?.finish(false),Math.min(5000,deadline-comparisonClock()));
    const finish=passed=>{
     clearTimeout(timer);
     pending=null;
     resolve(passed);
    };
    pending={bytes:Buffer.alloc(0),expected:Buffer.from(`A${next}\n`),finish};
    socket.write(next===0?'H\n':`B${next}\n`);
   });
   assert(accepted&&!failed&&comparisonClock()<deadline,'Worker comparison family settlement unobserved');
   ordinal++;
  },
  close(){socket.destroy();},
 });
}
