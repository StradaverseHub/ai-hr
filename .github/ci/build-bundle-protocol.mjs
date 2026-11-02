/** Closed compiled-byte protocol. Only immutable trusted controller Git objects authorize helpers. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

export const BUILD_BUNDLE_FORMAT=3;
export const BUILD_BUNDLE_KIND='next-map-byte-bundle';
export const BUILD_BUNDLE_HELPER_PATHS=Object.freeze({
 regular:'.github/ci/build-bundle.py',maps:'.github/ci/build-map-bundle.py',
 installer:'.github/ci/staging-build-install.mjs',grant:'.github/ci/ci-install-grant.mjs',
 artifact:'.github/ci/build-artifact.mjs',policy:'.github/ci/policy-version.mjs',
 protocol:'.github/ci/build-bundle-protocol.mjs',
});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX_HELPER=1024**2;
const git=(root,args)=>execFileSync('git',args,{cwd:root,maxBuffer:MAX_HELPER+1024,timeout:10000});
function commit(root,ref){
 assert(ref==='HEAD'||typeof ref==='string'&&/^[a-f0-9]{40}$/.test(ref),'Exact controller/source commit required');
 const value=git(root,['rev-parse','--verify',ref+'^{commit}']).toString('utf8').trim();
 assert(/^[a-f0-9]{40}$/.test(value),'Invalid controller/source commit');
 return value;
}
export function validateBundleHelpers(value){
 assert(value&&typeof value==='object'&&!Array.isArray(value)
  &&isDeepStrictEqual(Object.keys(value).sort(),Object.keys(BUILD_BUNDLE_HELPER_PATHS).sort())
  &&Object.values(value).every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)),
 'Exact closed bundle helper hashes required');
 return value;
}
export function trustedBundleHelpers(root,ref='HEAD'){
 const revision=commit(root,ref),result={};
 for(const [key,path]of Object.entries(BUILD_BUNDLE_HELPER_PATHS)){
  const metadata=git(root,['ls-tree',revision,'--',path]).toString('utf8');
  assert(/^100(?:644|755) blob [a-f0-9]{40}\t/.test(metadata)&&metadata.trimEnd().endsWith('\t'+path),
   'Trusted bundle helper must be a regular Git blob: '+key);
  const bytes=git(root,['show',revision+':'+path]);
  assert(bytes.length>0&&bytes.length<=MAX_HELPER,'Bundle helper byte bound: '+key);
  result[key]=hash(bytes);
 }
 return validateBundleHelpers(result);
}
function rawHelper(root,path){
 const file=join(root,path);
 assert(realpathSync(file)===file,'Canonical source helper required');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd);
  assert(before.isFile()&&before.nlink===1&&before.uid===process.getuid()&&(before.mode&0o022)===0&&before.size>0&&before.size<=MAX_HELPER,'Bounded regular source helper required');
  const digest=createHash('sha256'),chunk=Buffer.allocUnsafe(64*1024);let total=0,count;
  while((count=readSync(fd,chunk,0,Math.min(chunk.length,MAX_HELPER+1-total),null))>0){
   total+=count;assert(total<=MAX_HELPER,'Source helper grew');digest.update(chunk.subarray(0,count));
  }
  const after=fstatSync(fd),current=lstatSync(file);
  assert(!current.isSymbolicLink()&&current.isFile()&&current.nlink===1&&total===before.size,'Source helper changed');
  for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert(before[key]===after[key]&&before[key]===current[key],'Source helper identity changed');
  return digest.digest('hex');
 }finally{closeSync(fd);}
}
export function verifyBundleHelperFiles(source,expectedHelpers){
 validateBundleHelpers(expectedHelpers);source=resolve(source);
 assert(realpathSync(source)===source,'Canonical source checkout required');
 for(const [key,path]of Object.entries(BUILD_BUNDLE_HELPER_PATHS))
  assert(rawHelper(source,path)===expectedHelpers[key],'Current source helper differs from trusted controller: '+key);
 return true;
}
export function assertSourceBundleCapability(source,expectedHelpers,sourceRef='HEAD'){
 validateBundleHelpers(expectedHelpers);
 assert(isDeepStrictEqual(trustedBundleHelpers(source,sourceRef),expectedHelpers),'Source Git bundle capability differs from trusted controller');
 return verifyBundleHelperFiles(source,expectedHelpers);
}
