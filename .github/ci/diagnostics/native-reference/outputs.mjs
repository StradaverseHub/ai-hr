/** Precomputed native output ownership, never a compiler writer/copy hook. */
import assert from 'node:assert/strict';
import {join,relative,isAbsolute} from 'node:path';
import {readFileSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {REFERENCE_LIMITS} from './graph.mjs';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function nativeOutputNames(id){
 if(id.endsWith('.json'))return[id];
 if(/\.d\.[cm]?ts$/.test(id))return[];
 const match=/\.(tsx?|jsx?|[cm][tj]s)$/.exec(id);assert(match,'Unknown owned implementation extension');const stem=id.slice(0,-match[0].length);
 return[stem+(match[0]==='.mts'||match[0]==='.mjs'?'.mjs':match[0]==='.cts'||match[0]==='.cjs'?'.cjs':'.js'),stem+(match[0]==='.mts'||match[0]==='.mjs'?'.d.mts':match[0]==='.cts'||match[0]==='.cjs'?'.d.cts':'.d.ts')];
}
export function outputOwnership(plan,files){
 const byId=new Map(files.map(f=>[f.id,f])),outputs=new Map();assert.equal(byId.size,files.length,'Duplicate native source identity');
 for(const project of plan.projects)for(const source of [...project.owned,...project.context.filter(id=>byId.get(id)?.kind==='json')]){
  const file=byId.get(source);assert(file&&/^[a-f0-9]{64}$/.test(file.sha256));
  for(const path of nativeOutputNames(source)){
   assert(!isAbsolute(path)&&!path.split('/').includes('..'));const prior=outputs.get(path);
   if(prior){assert(file.kind==='json'&&prior.kind==='json'&&prior.source===source&&prior.sourceSha256===file.sha256,'Conflicting or duplicate native implementation output');prior.projects.push(project.index);}
   else outputs.set(path,{path,source,sourceSha256:file.sha256,kind:file.kind,projects:[project.index]});
  }
 }
 return[...outputs.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
export function regularHash(path,maximum=512*1024**2){const before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=maximum);assert.equal(realpathSync(path),path);const bytes=readFileSync(path);const after=lstatSync(path);assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);assert.equal(after.size,before.size);return{path,sha256:digest(bytes),bytes:bytes.length};}
export function assertOutputSeal(rows){assert(rows.length>0&&new Set(rows.map(r=>r.path)).size===rows.length);for(const row of rows)assert.deepEqual(regularHash(row.path),row,'Stale/foreign native output');}
export function emittedTree(root){const result=[];function visit(dir){for(const name of readdirSync(dir)){const path=join(dir,name),info=lstatSync(path);assert(!info.isSymbolicLink());if(info.isDirectory())visit(path);else{const row=regularHash(path);assert(!relative(root,path).startsWith('../'));result.push(row);}}}visit(root);return result.sort((a,b)=>a.path.localeCompare(b.path));}

export function assertArtifactBudget(root){let bytes=0,files=0;const visit=dir=>{for(const name of readdirSync(dir)){const path=join(dir,name),info=lstatSync(path);assert(!info.isSymbolicLink(),'Foreign artifact link');if(info.isDirectory())visit(path);else{assert(info.isFile()&&info.nlink===1&&info.size<=REFERENCE_LIMITS.fileBytes,'Individual native artifact budget');bytes+=info.size;assert(++files<=50000&&bytes<=REFERENCE_LIMITS.totalBytes,'Aggregate native artifact budget');}}};visit(root);return{bytes,files};}
