/** Complete metadata fences: canonical source filter, compiled tree except sole runtime cache. */
import assert from 'node:assert/strict';
import {lstatSync,readdirSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {installHash,installJson} from './ci-install-grant.mjs';
const metadata=path=>{const s=lstatSync(path,{bigint:true});return [s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).concat(s.isSymbolicLink()?readlinkSync(path):'');};
export function cleanupTreeFence(root,excluded){
 const rows=[];function walk(path,relative=''){
  assert(rows.length<200000,'Cleanup tree fence exceeds bound');rows.push([relative,metadata(path)]);const s=lstatSync(path);
  if(s.isDirectory())for(const name of readdirSync(path).sort()){const child=relative?relative+'/'+name:name;if(!excluded(child))walk(join(path,name),child);}
 }walk(root);return installHash(installJson(rows));
}
export function canonicalSourceExclusions(args){
 const filters=args.flatMap((v,i)=>v==='--exclude'?[args[i+1]]:[]);assert(filters.length>0&&filters.includes('.next')&&filters.includes('node_modules'),'Actual canonical source exclusions required');
 const patterns=filters.map(raw=>{const anchored=raw.startsWith('/'),pattern=raw.replace(/^\//,'').replace(/\/$/,'');assert(!pattern.includes('**')&&!pattern.includes('?')&&!pattern.includes('['),'Unsupported canonical exclusion pattern');return {anchored,re:new RegExp('^'+pattern.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')+'$')};});
 return relative=>patterns.some(({anchored,re})=>re.test(anchored?relative:relative.split('/').at(-1)));
}
