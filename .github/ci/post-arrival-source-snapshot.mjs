/** Public tracked source bytes only. Never writes staging, the original checkout or private target inputs. */
import assert from 'node:assert/strict';
import {lstatSync,readFileSync,readlinkSync,readdirSync,mkdirSync,copyFileSync,symlinkSync,chmodSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {digest} from './post-arrival-cleanup-policy.mjs';
function rowsValid(rows){
 assert(Array.isArray(rows)&&rows.length>0&&rows.length<=20000&&new Set(rows.map(r=>r.path)).size===rows.length,'Unique bounded source pins required');
 for(const row of rows)assert(typeof row.path==='string'&&!row.path.startsWith('/')&&!/[\n\r\0]/.test(row.path)&&!row.path.split('/').some(s=>!s||s==='.'||s==='..')&&['file','link'].includes(row.kind)&&[0o644,0o755,0o777].includes(row.mode)&&/^[a-f0-9]{64}$/.test(row.sha256),'Unsafe source pin');
}
export function verifySnapshot(root,rows,{complete=true}={}){
 rowsValid(rows);assert(realpathSync(root)===resolve(root)&&!lstatSync(root).isSymbolicLink(),'Canonical snapshot directory required');
 const expected=new Set(rows.map(r=>r.path)),directories=new Set(),seen=new Set();
 for(const row of rows){let parent=dirname(row.path);while(parent!=='.'){directories.add(parent);parent=dirname(parent);}}
 for(const row of rows){
  const path=join(root,row.path);assert(realpathSync(dirname(path))===resolve(dirname(path)),'Source parents may not follow links');
  const st=lstatSync(path);assert((row.kind==='link'?st.isSymbolicLink():st.isFile()&&!st.isSymbolicLink())&&(st.mode&0o777)===row.mode&&st.size<=64*1024**2,'Source type/mode differs');
  assert(digest(row.kind==='link'?readlinkSync(path):readFileSync(path))===row.sha256,'Source differs from immutable Git bytes');
 }
 if(complete){
  function walk(directory,prefix=''){
   for(const name of readdirSync(directory)){
    const path=join(directory,name),relative=prefix?prefix+'/'+name:name;
    if(lstatSync(path).isDirectory()){assert(directories.has(relative),'Unknown snapshot directory');walk(path,relative);}else{assert(expected.has(relative),'Unknown snapshot member');seen.add(relative);}
   }
  }walk(root);assert(seen.size===expected.size,'Snapshot member inventory differs');
 }
 return {kind:'FROZEN_CANONICAL_SOURCE_BYTES_VERIFIED_NOT_RELEASE',files:rows.length,releaseAuthorized:false};
}
export function createSourceSnapshot(candidate,destination,rows){
 verifySnapshot(candidate,rows,{complete:false});mkdirSync(destination,{mode:lstatSync(candidate).mode&0o777});
 for(const row of rows){
  const from=join(candidate,row.path),to=join(destination,row.path);mkdirSync(dirname(to),{recursive:true,mode:0o755});
  assert(realpathSync(dirname(to))===resolve(dirname(to)),'Snapshot parent link refused');
  if(row.kind==='link')symlinkSync(readlinkSync(from),to);else{copyFileSync(from,to);chmodSync(to,row.mode);}
 }
 return verifySnapshot(destination,rows);
}
