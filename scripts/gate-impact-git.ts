import { execFileSync } from 'node:child_process';
import { readFileSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { arch,platform } from 'node:os';
import { collectChanges } from './gate-tier-git';
import { planImpact,type ImpactPlan } from './gate-impact';
import { failureHistory,gateHistory,type GateObservation } from './gate-learning';
export function git(args:string[],cwd=process.cwd()){return execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:128*1024*1024}).trim();}
export function isAncestor(base:string,head:string,cwd=process.cwd()){try{execFileSync('git',['merge-base','--is-ancestor',base,head],{cwd,stdio:'ignore'});return true;}catch{return false;}}
export function readyProductionBaseline(status:Record<string,string>):string{
 if(status.state!=='ok'||status.stale_build!=='0'||status.ref!==status.built_ref||!status.built_ref||!/^[0-9a-f]{40}$/.test(status.built_ref))throw Error('Production has no complete, stable deployed baseline');
 return status.built_ref;
}
export function sourceFiles(cwd=process.cwd()):Map<string,string>{
 const files=git(['ls-files','-z'],cwd).split('\0').filter(Boolean),map=new Map<string,string>();
 for(const p of files){if(!/\.(?:[cm]?[jt]sx?|json|css|md)$/.test(p))continue;try{const text=readFileSync(join(cwd,p),'utf8');map.set(p,text);}catch{/* deletion is supplied by collectChanges */}}
 return map;
}
export function environmentHash(cwd=process.cwd()):string{
 const h=createHash('sha256').update(JSON.stringify([process.versions.node,platform(),arch()]));
 for(const p of ['.env.local','pnpm-lock.yaml','tsconfig.json','tsconfig.build.json','next.config.ts','vitest.config.ts','vitest.nodb.config.ts','vitest.browser.config.ts','test/env.ts','test/global-setup.ts','test/dom-setup.ts','test/db-names.ts']){
  h.update(p);if(existsSync(join(cwd,p)))h.update(readFileSync(join(cwd,p)));else h.update('<absent>');
 }
 return h.digest('hex');
}
export function impactFor(base:string,head='HEAD',cwd=process.cwd(),directory?:string):ImpactPlan{
 if(!isAncestor(base,head,cwd))throw Error('Impact baseline must be an ancestor; a merge-base diff does not describe production replacement');
 return planImpact(collectChanges(base,head,cwd),sourceFiles(cwd),failureHistory(directory));
}
/** A verified full candidate can remain the baseline after a small repair, even before it is deployed. */
export function reusableFullBaseline(deployed:string,head:string,cwd=process.cwd(),directory?:string):GateObservation|null{
 const env=environmentHash(cwd);
 return gateHistory(directory).reverse().find(r=>r.result==='PASS'&&r.tier==='full'&&r.environmentHash===env
  &&r.fullReceipt?.sha===r.sha&&r.fullReceipt?.result==='PASS'&&r.fullReceipt?.tier==='full'
  &&typeof r.fullReceipt?.files==='number'&&r.fullReceipt.files>0&&r.fullReceipt.files===r.fullReceipt.suiteFiles
  &&isAncestor(deployed,r.sha,cwd)&&isAncestor(r.sha,head,cwd))??null;
}
