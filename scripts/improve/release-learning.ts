/** Every successful official build saves evidence locally and mirrors it outside the rsynced app. */
import { gateHistory,saveGate,saveRelease,queueReleaseMirror,pendingReleaseMirrors,acknowledgeReleaseMirror,type ReleaseObservation } from '../gate-learning';
import { environmentHash,impactFor,git } from '../gate-impact-git';
import type { GateReceipt } from './release-gate';
import type { ImpactReceipt } from './release-impact-gate';
export function recordReleaseLearning(p:{worktree:string;sha:string;buildId:string;previousRef?:string;receipt:GateReceipt;status:Record<string,string>;mirror:(record:ReleaseObservation)=>void}):ReleaseObservation{
 if(p.status.state!=='ok'||p.status.built_ref!==p.sha||p.status.stale_build!=='0')throw Error('Cannot learn from an unverified built source');
 const env=environmentHash(p.worktree),receipt=p.receipt as ImpactReceipt&{files?:number;suiteFiles?:number;wallSeconds?:number};
 let gate=gateHistory().reverse().find(g=>g.sha===p.sha&&g.result==='PASS'&&g.environmentHash===env)??null;
 if(!gate&&receipt.result==='PASS'&&receipt.tier==='full'&&typeof receipt.files==='number'&&receipt.files>0&&receipt.files===receipt.suiteFiles){
  const base=p.previousRef??git(['merge-base','HEAD','main'],p.worktree),plan=impactFor(base,'HEAD',p.worktree);
  gate=saveGate({sha:p.sha,base,environmentHash:env,result:'PASS',tier:'full',plan,failed:[],wallSeconds:receipt.wallSeconds??0,fullReceipt:{...receipt}});
 }
 const record=saveRelease({sha:p.sha,buildId:p.buildId,gate,classifications:gate?.plan.classifications??receipt.plan?.classifications??[]});
 // The local immutable record is the durable retry source if SSH drops after the successful build.
 queueReleaseMirror(record);
 for(const pending of pendingReleaseMirrors()){p.mirror(pending);acknowledgeReleaseMirror(pending);}
 return record;
}
