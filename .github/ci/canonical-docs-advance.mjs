/** One explicitly pinned documentation-only canonical advance; never changes the built source. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {hash} from './manifest.mjs';
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const CANONICAL_DOC_PATHS=['docs/adr/0024-multi-cycle-payroll.md','docs/architecture/STATUTORY-SOURCES.md'];
const seal=body=>({...body,fingerprint:hash(body)});
const bytesHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function exactCanonicalRefs({originalController,baseline,candidate,head=baseline}){
 assert([originalController,baseline,candidate,head].every(sha)&&[baseline,candidate].includes(head),'Exact canonical baseline/source required');
 return seal({kind:'EXACT_CANONICAL_REFS',originalController,baseline,candidate,head,focusedController:originalController});
}
export function validateCanonicalContext(context,{originalController,baseline,candidate}){
 assert(context&&[originalController,baseline,candidate].every(sha),'Canonical source identities required');
 const {fingerprint,...body}=context;assert(fingerprint===hash(body),'Canonical context changed');
 for(const key of ['originalController','baseline','candidate'])assert(context[key]===({originalController,baseline,candidate})[key],'Canonical identity differs: '+key);
 if(context.kind==='EXACT_CANONICAL_REFS'){
  assert(isDeepStrictEqual(Object.keys(body).sort(),['kind','originalController','baseline','candidate','head','focusedController'].sort())
   &&[baseline,candidate].includes(context.head)&&context.focusedController===originalController,'Canonical exact-ref proof differs');
 }else{
  assert(isDeepStrictEqual(Object.keys(body).sort(),['kind','originalController','baseline','candidate','head','approvedDocsHead','focusedController','commits','baseTree','headTree','diffSha256','paths'].sort()),'Exact documentation proof shape required');
  assert(context.kind==='IMMUTABLE_CANONICAL_DOCS_ADVANCE'&&sha(context.head)&&context.head!==originalController
   &&context.approvedDocsHead===context.head&&context.focusedController===context.head
   &&sha(context.baseTree)&&sha(context.headTree)&&digest(context.diffSha256)&&context.commits===1,'Pinned one-commit documentation proof required');
  assert(Array.isArray(context.paths)&&isDeepStrictEqual(context.paths.map(r=>r.path),CANONICAL_DOC_PATHS),'Only the reviewed two documentation paths may advance');
  for(const row of context.paths)assert(isDeepStrictEqual(Object.keys(row).sort(),['path','mode','baseBlob','headBlob','baseSha256','headSha256'].sort())&&row.mode==='100644'&&sha(row.baseBlob)&&sha(row.headBlob)
   &&digest(row.baseSha256)&&digest(row.headSha256),'Regular committed documentation bytes required');
 }
 return context;
}
export function proveCanonicalRefs({cwd,originalController,baseline,candidate,main,alpha,approvedDocsHead}){
 assert(main===alpha&&sha(main),'Published main/alpha must identify the same exact commit');
 if([baseline,candidate].includes(main))return exactCanonicalRefs({originalController,baseline,candidate,head:main});
 assert(sha(approvedDocsHead)&&approvedDocsHead===main,'Explicit exact documentation-advance pin required');
 const git=(...args)=>execFileSync('git',args,{cwd,maxBuffer:4*1024**2,timeout:10000});
 const text=(...args)=>git(...args).toString('utf8').trim();
 for(const ref of [originalController,main])assert(text('rev-parse','--verify',ref+'^{commit}')===ref,'Exact committed canonical source required');
 execFileSync('git',['merge-base','--is-ancestor',originalController,main],{cwd,stdio:'ignore',timeout:10000});
 assert(text('rev-list','--count',originalController+'..'+main)==='1','Only one explicitly reviewed documentation commit is admitted');
 const records=git('diff','--name-status','--no-renames','-z',originalController,main).toString('utf8').split('\0');assert(records.pop()==='');
 assert(records.length===4,'Canonical advance must change exactly two existing documentation files');
 const names=[];for(let i=0;i<records.length;i+=2){assert(records[i]==='M','Only existing documentation edits admitted');names.push(records[i+1]);}
 names.sort();assert(isDeepStrictEqual(names,CANONICAL_DOC_PATHS),'Canonical advance changed executable, migration, controller or other input');
 const blob=(ref,path)=>{
  const row=text('ls-tree',ref,'--',path),match=/^100644 blob ([a-f0-9]{40})\t/.exec(row);assert(match,'Documentation must remain a regular non-executable Git blob');
  return {id:match[1],bytes:git('cat-file','blob',match[1])};
 };
 const paths=names.map(path=>{const before=blob(originalController,path),after=blob(main,path);return {path,mode:'100644',baseBlob:before.id,headBlob:after.id,baseSha256:bytesHash(before.bytes),headSha256:bytesHash(after.bytes)};});
 const context=seal({kind:'IMMUTABLE_CANONICAL_DOCS_ADVANCE',originalController,baseline,candidate,head:main,approvedDocsHead,
  focusedController:main,commits:1,baseTree:text('rev-parse',originalController+'^{tree}'),headTree:text('rev-parse',main+'^{tree}'),
  diffSha256:bytesHash(git('diff','--binary','--no-ext-diff',originalController,main)),paths});
 return validateCanonicalContext(context,{originalController,baseline,candidate});
}
