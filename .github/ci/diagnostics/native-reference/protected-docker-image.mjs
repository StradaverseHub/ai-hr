/** A deterministic, package-free Docker archive. Its layer only holds empty mountpoints. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const protectedOwnerLabel='io.aihr.compiler-protected-canary';
export const protectedRuntimeEnv=Object.freeze({PATH:'/runtime',LANG:'C',LC_ALL:'C',TZ:'UTC',HOME:'/work/home',
 TMPDIR:'/work/tmp',XDG_CACHE_HOME:'/work/cache',HOSTNAME:'aihr-protected-canary'});
export const protectedLimits=Object.freeze({memory:256*1024**2,pids:64,cpuNano:1000000000});
export const protectedHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const protectedDigest=/^sha256:[a-f0-9]{64}$/;
const json=object=>Buffer.from(JSON.stringify(object));
const directories=['dependency/','dev/','etc/','input/','lib/','lib/x86_64-linux-gnu/','lib64/','probe/','proc/','runtime/','sys/','work/'];
const placeholders=['etc/hostname','etc/hosts','etc/resolv.conf','lib64/ld-linux-x86-64.so.2','probe/entry.mjs','probe/plan.json','runtime/node'];

function tar(entries){
 const chunks=[];
 for(const [name,body]of entries){
  const dir=name.endsWith('/');
  assert(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name)&&!name.split('/').includes('..'));
  assert(Buffer.isBuffer(body)&&body.length<=65536&&(!dir||body.length===0));
  const header=Buffer.alloc(512);
  const field=(value,start,length)=>assert.equal(header.write(value,start,length,'ascii'),value.length);
  const octal=(value,start,length)=>field(value.toString(8).padStart(length-1,'0')+'\0',start,length);
  field(name,0,100);octal(dir?0o755:0o644,100,8);octal(0,108,8);octal(0,116,8);
  octal(body.length,124,12);octal(0,136,12);header.fill(32,148,156);
  field(dir?'5':'0',156,1);field('ustar\0',257,6);field('00',263,2);
  const checksum=header.reduce((sum,value)=>sum+value,0).toString(8).padStart(6,'0');
  field(checksum+'\0 ',148,8);
  chunks.push(header,body,Buffer.alloc((512-body.length%512)%512));
 }
 return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}
export function sealedScratchImage(owner){
 assert(/^[a-f0-9]{64}$/.test(owner));
 const layer=tar([...directories,...placeholders].map(path=>[path,Buffer.alloc(0)]));
 const diffId='sha256:'+protectedHash(layer),created='1970-01-01T00:00:00Z';
 const config=json({created,architecture:'amd64',os:'linux',config:{Labels:{[protectedOwnerLabel]:owner}},
  rootfs:{type:'layers',diff_ids:[diffId]},history:[{created,created_by:'AIHR fixed synthetic mountpoints'}]});
 const id='sha256:'+protectedHash(config),configName=id.slice(7)+'.json';
 const archive=tar([['manifest.json',json([{Config:configName,RepoTags:[],Layers:['layer.tar']}])],[configName,config],['layer.tar',layer]]);
 assert(archive.length<32768);
 return {id,diffId,sha256:protectedHash(archive),archive};
}
