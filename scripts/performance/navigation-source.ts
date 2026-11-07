/** Read immutable Git source bytes; JSON self-declared hashes are never authority. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {NAVIGATION_HARNESS_ROOTS,NAVIGATION_SCENARIO_FILE,validateNavigationScenarioPlan} from './navigation-protocol';
const git=(root:string,...args:string[])=>execFileSync('git',args,{cwd:root,maxBuffer:32*1024*1024});
export const navigationSha256=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function navigationCleanHead(root:string):string{
 const sha=git(root,'rev-parse','HEAD').toString().trim();
 if(!/^[a-f0-9]{40}$/.test(sha)||git(root,'status','--porcelain').toString().trim())throw Error('Navigation evidence needs an exact clean source tree');
 if(git(root,'remote','get-url','origin').toString().trim().toLowerCase()!=='https://github.com/stradaversehub/ai-hr.git')throw Error('Navigation source repository differs');
 return sha;
}
export function navigationSourceIdentity(root:string,sha:string){
 if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid navigation source revision');
 const records=git(root,'ls-tree','-r','-z','--full-tree',sha,'--',...NAVIGATION_HARNESS_ROOTS).toString().split('\0').filter(Boolean);
 if(!records.length||records.length>2048)throw Error('Navigation harness inventory exceeds bounds');
 let total=0;
 const files=records.map(record=>{
  const match=record.match(/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/);
  if(!match)throw Error('Navigation harness must contain regular source files');
  const path=match[3],bytes=git(root,'show',sha+':'+path);total+=bytes.length;
  if(bytes.length>2*1024*1024||total>32*1024*1024)throw Error('Navigation harness source exceeds bounds');
  return {path,mode:match[1],sha256:navigationSha256(bytes)};
 }).sort((a,b)=>a.path.localeCompare(b.path,'en'));
 if(!files.some(file=>file.path===NAVIGATION_SCENARIO_FILE)||!files.some(file=>file.path==='scripts/performance/navigation-browser-capture.ts'))throw Error('Trusted navigation capture harness is incomplete');
 const scenarioBytes=git(root,'show',sha+':'+NAVIGATION_SCENARIO_FILE);
 return {harnessSha256:navigationSha256(JSON.stringify(files)),scenarioSha256:navigationSha256(scenarioBytes),files,
  plan:validateNavigationScenarioPlan(JSON.parse(scenarioBytes.toString()))};
}
