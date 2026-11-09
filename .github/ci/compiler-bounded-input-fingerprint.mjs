/** Native compiler input identity. Actual candidate/controller commits remain separate receipt fields. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readManagedInventory} from './compiler-managed-inventory.mjs';

// Only reviewed controller additions and the normal workflow wiring may differ at alignment.
// Each is independently checked against both the native configured and loaded file paths.
export const controllerOnlyMembers=Object.freeze([
 '.github/ci/compiler-bounded-input-fingerprint.mjs',
 '.github/ci/compiler-bounded-input-fingerprint.test.mjs',
 '.github/ci/compiler-managed-inventory.mjs',
 '.github/ci/compiler-managed-inventory.test.mjs',
 '.github/ci/compiler-memory-feasibility.py',
 '.github/ci/compiler-platform-swap.test.py',
 '.github/workflows/alpha-staging.yml',
]);
const excluded=new Set(controllerOnlyMembers);
const sha256=value=>createHash('sha256').update(value).digest('hex');
const encoded=value=>sha256(JSON.stringify(value));
const gitSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const utf8=new TextDecoder('utf-8',{fatal:true});
const ordered=(a,b)=>a<b?-1:a>b?1:0;

function sourcePath(path){
 assert(typeof path==='string'&&path.length>0&&path.length<=2048&&!/[\\\u0000-\u001f\u007f]/.test(path));
 assert(path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&part!=='.git'));
 return path;
}
function exactMembers(records){
 const text=utf8.decode(records);
 assert(text.endsWith('\0')&&text.length<=16*1024**2);
 const parsed=text.slice(0,-1).split('\0').map(record=>{
  const match=/^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(record);
  assert(match,'Complete tracked source entry required');
  const [,mode,kind,id,name]=match;
  assert((mode==='160000')===(kind==='commit'));
  return [sourcePath(name),mode,kind,id];
 });
 assert(parsed.length>=1&&parsed.length<=50_000&&new Set(parsed.map(row=>row[0])).size===parsed.length);
 return parsed.sort((a,b)=>ordered(a[0],b[0]));
}

/** The caller supplies actual native paths from the same held, clean stock compiler workspace. */
export function compilerInputFingerprint({tracked,configured,loaded,generatedSha256,toolSha256,nodeSha256,argvSha256}){
 const tree=exactMembers(tracked);
 for(const hash of [generatedSha256,toolSha256,nodeSha256,argvSha256])assert(digest(hash));
 for(const members of [configured,loaded]){
  assert(Array.isArray(members)&&members.length>0&&members.length<=50_000);
  assert(new Set(members).size===members.length);
  for(const member of members)assert(!excluded.has(sourcePath(member)),'Excluded controller member belongs to the native compiler');
 }
 const native=new Set(loaded);
 assert(configured.every(member=>native.has(member)),'Native file list omitted a configured root');
 const trackedMembers=tree.filter(([path])=>!excluded.has(path));
 const excludedMembers=tree.filter(([path])=>excluded.has(path));
 assert(excludedMembers.every(([,mode,kind])=>mode==='100644'&&kind==='blob'),'Controller member must be a regular tracked blob');
 const scoped={trackedMembers:trackedMembers.length,trackedSha256:encoded(trackedMembers),
  configuredRoots:configured.length,configuredSha256:encoded(configured),loadedFiles:loaded.length,
  loadedSha256:encoded(loaded),generatedSha256,toolSha256,nodeSha256,argvSha256};
 return {...scoped,inputFingerprintSha256:encoded(scoped)};
}

export function checkoutCompilerTree(source,expectedSha,expectedTree){
 assert(isAbsolute(source)&&resolve(source)===source&&realpathSync(source)===source&&lstatSync(source).isDirectory());
 assert(gitSha(expectedSha)&&gitSha(expectedTree));
 const git=(...args)=>execFileSync('/usr/bin/git',['--no-replace-objects','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{
  cwd:source,timeout:10_000,maxBuffer:16*1024**2,
  env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',
   GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0'},
 });
 assert.equal(git('rev-parse','--show-toplevel').toString().trim(),source);
 assert.deepEqual(git('rev-parse','HEAD','HEAD^{tree}','--show-object-format').toString().trim().split('\n'),[expectedSha,expectedTree,'sha1']);
 assert.equal(git('status','--porcelain=v1','-z','--untracked-files=all').length,0);
 return git('ls-tree','-r','-z','--full-tree','HEAD');
}

export function nativeListedFiles(source,raw){
 assert(isAbsolute(source)&&resolve(source)===source&&sep==='/');
 const text=utf8.decode(raw);
 assert(text.endsWith('\n')&&text.length<=16*1024**2);
 return text.replace(/\r?\n$/, '').split(/\r?\n/).map(line=>{
  assert(isAbsolute(line)&&resolve(line)===line&&line.startsWith(source+'/'),'Native compiler loaded outside the exact source checkout');
  return sourcePath(relative(source,line));
 });
}

function ownedList(path){
 assert(isAbsolute(path)&&resolve(path)===path&&realpathSync(path)===path);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd,{bigint:true});
  assert(before.isFile()&&before.nlink===1n&&before.uid===BigInt(process.getuid())&&(before.mode&0o777n)===0o600n
   &&before.size>0n&&before.size<=16n*1024n*1024n);
  const bytes=readFileSync(fd),after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
  assert.equal(BigInt(bytes.length),before.size);
  for(const name of ['dev','ino','size','mtimeNs','ctimeNs'])assert(before[name]===after[name]&&after[name]===named[name]);
  return bytes;
 }finally{closeSync(fd);}
}

async function main(){
 const [source,actualSha,actualTree,listPath,nodeSha256,argvSha256,...extra]=process.argv.slice(2);
 assert(extra.length===0);
 const tracked=checkoutCompilerTree(source,actualSha,actualTree),raw=ownedList(listPath);
 const current=await readManagedInventory(source);
 const fingerprint=compilerInputFingerprint({tracked,configured:current.roots,loaded:nativeListedFiles(source,raw),
  generatedSha256:current.public.generatedSha256,toolSha256:current.public.toolSha256,nodeSha256,argvSha256});
 process.stdout.write(JSON.stringify({...fingerprint,stockListSha256:sha256(raw)})+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(()=>{process.stderr.write('Compiler input fingerprint refused\n');process.exitCode=2;});
}
