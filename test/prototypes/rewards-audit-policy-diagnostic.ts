/** Test-only observations. No messages, SQL, parameters, stack or authority output. */
const phases=['tenant-callback','agent-guard','bank-actor','bank-interval','bank-source','bank-metadata-parse','bank-stored-parse','catalogue-lock','catalogue-source','catalogue-metadata-parse','catalogue-stored-parse']as const;
export type RewardPolicyCallbackPhase=typeof phases[number];
type Phase=RewardPolicyCallbackPhase;
type CallbackObservation=Readonly<{kind:'callback-refused';phase:Phase;sqlstate:string|null}>;
const steps=['writer-entered','writer-stamped','writer-insert-submitted','receipt-finalize-submitted']as const;
export type RewardPolicySourceStep=typeof steps[number];
export type RewardPolicyWaitObservation=Readonly<{kind:'wait-unavailable';waitingPresent:boolean;holderPresent:boolean;waitingActive:boolean;waitingOnLock:boolean;ownedBlocking:boolean;waitingFloorWrite:boolean;waitingHistoryLock:boolean;waitingStatementOlderThanWindow:boolean}>;
type Observation=CallbackObservation|RewardPolicyWaitObservation|Readonly<{kind:'callback-returned';phase:Phase}>|Readonly<{kind:'source-callback-step';phase:RewardPolicySourceStep}>;
function sqlstate(error:unknown):string|null{
 const seen=new Set<unknown>();let current=error;
 for(let depth=0;depth<4&&current!==null&&typeof current==='object'&&!seen.has(current);depth++){
  seen.add(current);
  // Do not invoke arbitrary getters, toString(), stack access or foreign codecs.
  const code=Object.getOwnPropertyDescriptor(current,'code');
  if(code&&'value'in code&&typeof code.value==='string'&&code.value.length===5&&/^[0-9A-Z]{5}$/.test(code.value))return code.value;
  const cause=Object.getOwnPropertyDescriptor(current,'cause');current=cause&&'value'in cause?cause.value:undefined;
 }
 return null;
}
export function rewardsPolicyDiagnostics(){
 const rows:Observation[]=[],pending=new Set<Promise<void>>();let overflow=false;
 function add(row:Observation){if(rows.length===64){overflow=true;return;}rows.push(Object.freeze(row));}
 function refused(phase:Phase,error:unknown){let state:string|null=null;try{state=sqlstate(error);}catch{overflow=true;}add({kind:'callback-refused',phase,sqlstate:state});}
 function returned(phase:Phase){if(phase!=='tenant-callback')add({kind:'callback-returned',phase});}
 return Object.freeze({
  async callback<T>(phase:Phase,work:()=>PromiseLike<T>):Promise<T>{
   if(!phases.includes(phase))throw Error('Unknown owned Rewards diagnostic phase');
   let finished!:()=>void;const marker=new Promise<void>(resolve=>{finished=resolve;});pending.add(marker);
   try{const value=await work();returned(phase);return value;}catch(error){
    // Reflective classification can itself be hostile; never replace the real
    // callback error or let diagnostic failure authorize continued native work.
    refused(phase,error);throw error;
   }finally{pending.delete(marker);finished();}
  },
  sync<T>(phase:Phase,work:()=>T):T{
   if(!phases.includes(phase))throw Error('Unknown owned Rewards diagnostic phase');
   try{const value=work();returned(phase);return value;}catch(error){refused(phase,error);throw error;}
  },
  async drain(){while(pending.size)await Promise.all([...pending]);},
  step(phase:RewardPolicySourceStep){
   if(!steps.includes(phase))throw Error('Closed source observation step required');add({kind:'source-callback-step',phase});
  },
  wait(row:RewardPolicyWaitObservation){
   const keys=['kind','waitingPresent','holderPresent','waitingActive','waitingOnLock','ownedBlocking','waitingFloorWrite','waitingHistoryLock','waitingStatementOlderThanWindow'];
   if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.kind!=='wait-unavailable'||keys.slice(1).some(key=>typeof Reflect.get(row,key)!=='boolean'))throw Error('Closed owned wait observation required');
   add({kind:'wait-unavailable',waitingPresent:row.waitingPresent,holderPresent:row.holderPresent,waitingActive:row.waitingActive,waitingOnLock:row.waitingOnLock,ownedBlocking:row.ownedBlocking,waitingFloorWrite:row.waitingFloorWrite,waitingHistoryLock:row.waitingHistoryLock,waitingStatementOlderThanWindow:row.waitingStatementOlderThanWindow});
  },
  snapshot(){return Object.freeze({kind:'UNINSTALLED_REWARDS_POLICY_FAILURE_DIAGNOSTIC' as const,releaseAuthorized:false as const,complete:!overflow,observations:Object.freeze([...rows])});},
 });
}
