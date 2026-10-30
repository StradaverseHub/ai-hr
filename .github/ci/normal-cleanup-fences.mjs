/** Complete metadata fences: canonical source filter, compiled tree except sole runtime cache. */
import assert from 'node:assert/strict';
import {lstatSync,readdirSync,readlinkSync,readFileSync} from 'node:fs';
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

/** Production assembly with bounded external read ports; fixtures exercise the same filesystem path. */
export async function captureNormalCleanupFences({source,p,activated,exclude,recordNames,ports,now=()=>Date.now()}){
 const started=now();await ports.authority();await ports.lease();await ports.runtime();
 const identity=path=>{const s=lstatSync(path);assert(s.isDirectory()&&!s.isSymbolicLink(),'Real cleanup directory required');return {device:s.dev,inode:s.ino};};
 const records=recordNames.map(name=>{const path=join(p.directory,name),s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&s.size>0&&s.size<=16*1024**2,'Bounded original audit record required');return [name,installHash(readFileSync(path)),metadata(path)];});
 const service=await ports.service(),ledger={...await ports.ledger()};delete ledger.verifiedAt;
 const result={source:p.grant.source,installId:p.grant.installId,authorizationSha256:p.authorizationSha256,lease:await ports.leaseIdentity(),...service,boot:await ports.boot(),environment:await ports.environment(),
  active:identity(join(source,'.next')),retained:identity(p.next),packet:identity(p.packet),directory:identity(p.directory),
  sourceMetadata:cleanupTreeFence(source,exclude),compiledMetadata:cleanupTreeFence(join(source,'.next'),relative=>relative==='cache'),records,ledger};
 assert(service.active===true&&/^[1-9][0-9]*$/.test(service.pid)&&JSON.stringify(result.active)===JSON.stringify(activated.activation.activeDirectory)&&JSON.stringify(result.retained)===JSON.stringify(activated.activation.retainedDirectory),'Cleanup runtime/inodes changed');
 assert(await ports.health()===200&&(await ports.service()).pid===service.pid,'Cleanup health/PID changed');
 assert(now()-started<=30000,'Fast cleanup fence exceeded deadline');return result;
}
