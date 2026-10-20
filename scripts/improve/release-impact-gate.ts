/** Recompute impact at release time. Receipt evidence never substitutes for an actual dependency plan. */
import type { GateReceipt } from './release-gate';
import { impactFor,environmentHash,git,isAncestor } from '../gate-impact-git';
import {gateHistory,releaseHistory,fullRegressionDue,type GateObservation} from '../gate-learning';
import type { ImpactPlan } from '../gate-impact';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverageBody,unitsFor,verifyReceiptCheckpoints,type ReceiptCheckpoints } from '../gate-checkpoint';
export type ImpactReceipt=GateReceipt&{base?:string;deployedBase?:string;environmentHash?:string;policyVersion?:number;plan?:ImpactPlan;run?:string[];counts?:{files?:number;browserFiles?:number};baselineFull?:GateObservation|null;checkpoints?:ReceiptCheckpoints;resumed?:boolean};
export function validateImpactReceipt(receipt:ImpactReceipt,p:{head:string;deployedRef:string;worktree:string}):{ok:true;lines:string[]}|{ok:false;lines:string[]}{
 const refuse=(why:string)=>({ok:false as const,lines:['✗ REFUSED: impact verification '+why,'  Re-run bash scripts/gate.sh against the current deployed version.']});
 if(receipt.sha!==p.head||receipt.result!=='PASS'||receipt.tier!=='impact')return refuse('does not cover this exact successful candidate');
 if(git(['status','--porcelain'],p.worktree))return refuse('requires a clean candidate');
 if(receipt.environmentHash!==environmentHash(p.worktree))return refuse('environment changed after the gate');
 if(!receipt.base||!isAncestor(receipt.base,p.head,p.worktree))return refuse('baseline is not an ancestor');
 if(receipt.deployedBase!==p.deployedRef)return refuse('production moved after the gate');
 if(receipt.base!==p.deployedRef){
  const baseline=receipt.baselineFull,r=baseline?.fullReceipt;
  if(!baseline||baseline.sha!==receipt.base||baseline.environmentHash!==receipt.environmentHash||baseline.result!=='PASS'||baseline.tier!=='full'
    ||r?.sha!==baseline.sha||r?.result!=='PASS'||r?.tier!=='full'||typeof r.files!=='number'||r.files<1||r.files!==r.suiteFiles
    ||!isAncestor(p.deployedRef,baseline.sha,p.worktree))return refuse('has no complete full-suite witness for the undeployed baseline');
 }
 try{
  const due=fullRegressionDue(gateHistory(),releaseHistory(),receipt.environmentHash!);
  if(due)return refuse('needs periodic full regression: '+due);
  const current=impactFor(receipt.base,p.head,p.worktree);
  if(current.tier!=='impact')return refuse('now needs FULL: '+current.reasons.join('; '));
  if(receipt.policyVersion!==current.policyVersion||receipt.plan?.fingerprint!==current.fingerprint)return refuse('plan or policy changed after the gate');
  if(!Array.isArray(receipt.run)||new Set(receipt.run).size!==receipt.run.length||receipt.counts?.files!==receipt.run.length
    ||current.run.length!==receipt.run.length||current.run.some((file,i)=>receipt.run![i]!==file))return refuse('has incomplete or altered test coverage');
  if(current.browser&&(!Number.isInteger(receipt.counts?.browserFiles)||receipt.counts!.browserFiles!<1))return refuse('has no counted browser verification');
  // ADR-0133: every unit of the release-time partition must have a verified green checkpoint on this exact commit.
  const browserFiles=git(['ls-files','test'],p.worktree).split('\n').filter(f=>f.endsWith('.browser.test.tsx'));
  const body=coverageBody({sha:p.head,base:receipt.base,deployed:p.deployedRef,environmentHash:receipt.environmentHash!,policyVersion:current.policyVersion,tier:current.tier,run:current.run,browser:current.browser,
   units:unitsFor(current,f=>{try{return readFileSync(join(p.worktree,f),'utf8');}catch{return null;}},browserFiles)});
  const unproven=verifyReceiptCheckpoints(receipt.checkpoints,body);
  if(unproven)return refuse('checkpoint evidence '+unproven);
  if(current.browser&&receipt.counts?.browserFiles!==body.units.find(u=>u.kind==='browser')?.files.length)return refuse('browser count does not match its checkpoint');
  const attempts=new Set(receipt.checkpoints!.units.map(r=>r.id.slice(r.id.indexOf('.')+1))).size;
  return {ok:true,lines:[`→ final gate: tier=impact risk=${current.risk}; ${current.run.length} counted files; exact plan revalidated from ${receipt.base.slice(0,12)}`,
   `  ${body.units.length} unit checkpoint(s) verified${receipt.checkpoints!.assembled?` — assembled from ${attempts} attempt(s) of the same coverage`:''}`]};
 }catch(e){return refuse('could not be revalidated: '+String(e));}
}
