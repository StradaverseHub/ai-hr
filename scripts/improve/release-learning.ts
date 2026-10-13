/** Every successful official build saves evidence locally and mirrors it outside the rsynced app. */
import { gateHistory,saveGate,saveRelease,queueReleaseMirror,pendingReleaseMirrors,acknowledgeReleaseMirror,type GateObservation,type ReleaseObservation } from '../gate-learning';
import { environmentHash,impactFor,git } from '../gate-impact-git';
import type { GateReceipt } from './release-gate';
import type { ImpactReceipt } from './release-impact-gate';
export function recordReleaseLearning(p:{worktree:string;sha:string;buildId:string;previousRef?:string;receipt:GateReceipt;status:Record<string,string>;mirror:(record:ReleaseObservation)=>void}):ReleaseObservation{
 if(p.status.state!=='ok'||p.status.built_ref!==p.sha||p.status.stale_build!=='0')throw Error('Cannot learn from an unverified built source');
 const env=environmentHash(p.worktree),receipt=p.receipt as ImpactReceipt&{files?:number;suiteFiles?:number;wallSeconds?:number};
 const deployedBase=/^[0-9a-f]{40}$/.test(p.previousRef??'')?p.previousRef:undefined,impactUncertainties:string[]=[];
 let gate:GateObservation|null=null;
 const frozen=()=>{if(git(['rev-parse','HEAD'],p.worktree)!==p.sha||git(['status','--porcelain'],p.worktree))throw Error('Release source no longer matches its verified snapshot');};
 try{gate=gateHistory().reverse().find(g=>g.sha===p.sha&&g.result==='PASS'&&g.environmentHash===env)??null;}
 catch{impactUncertainties.push('Verification history was unavailable; its scope could not be reconstructed.');}
 if(!gate&&receipt.result==='PASS'&&receipt.tier==='full'&&typeof receipt.files==='number'&&receipt.files>0&&receipt.files===receipt.suiteFiles){
  try{
   frozen();const base=deployedBase??git(['merge-base','HEAD','main'],p.worktree),plan=impactFor(base,'HEAD',p.worktree);frozen();
   gate=saveGate({sha:p.sha,base,environmentHash:env,result:'PASS',tier:'full',plan,failed:[],wallSeconds:receipt.wallSeconds??0,fullReceipt:{...receipt}});
  }catch{impactUncertainties.push('The full receipt is retained, but its module scope could not be reconstructed.');}
 }
 let classifications=gate?.plan.classifications??receipt.plan?.classifications??[];
 if(deployedBase){
  if(gate?.base!==deployedBase){
   try{frozen();classifications=impactFor(deployedBase,'HEAD',p.worktree).classifications;frozen();}
   catch{impactUncertainties.push('The production-to-release scope could not be reconstructed; saved classifications may cover only verification changes.');}
  }
 }else impactUncertainties.push('The deployed baseline was unavailable; saved classifications may cover only verification changes.');
 const record=saveRelease({sha:p.sha,buildId:p.buildId,deployedBase,impactUncertainties:[...new Set(impactUncertainties)],gate,classifications});
 if(record.impactUncertainties.length)console.warn('Release-learning impact scope remains unknown; the verified build record is retained.');
 // The local immutable record is the durable retry source if SSH drops after the successful build.
 queueReleaseMirror(record);
 for(const pending of pendingReleaseMirrors()){p.mirror(pending);acknowledgeReleaseMirror(pending);}
 return record;
}
