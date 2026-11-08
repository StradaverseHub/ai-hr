/** Test-only observations. No messages, SQL, parameters, stack or authority output. */
const phases=['tenant-callback','agent-guard','bank-actor','bank-source','catalogue-lock','catalogue-source']as const;
type Phase=typeof phases[number];
type CallbackObservation=Readonly<{kind:'callback-refused';phase:Phase;sqlstate:string|null}>;
export type RewardPolicyWaitObservation=Readonly<{kind:'wait-unavailable';waitingPresent:boolean;holderPresent:boolean;waitingActive:boolean;waitingOnLock:boolean;ownedBlocking:boolean}>;
type Observation=CallbackObservation|RewardPolicyWaitObservation;
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
 const rows:Observation[]=[];let overflow=false;
 function add(row:Observation){if(rows.length===64){overflow=true;return;}rows.push(Object.freeze(row));}
 return Object.freeze({
  async callback<T>(phase:Phase,work:()=>PromiseLike<T>):Promise<T>{
   if(!phases.includes(phase))throw Error('Unknown owned Rewards diagnostic phase');
   try{return await work();}catch(error){
    // Reflective classification can itself be hostile; never replace the real
    // callback error or let diagnostic failure authorize continued native work.
    let state:string|null=null;try{state=sqlstate(error);}catch{overflow=true;}
    add({kind:'callback-refused',phase,sqlstate:state});throw error;
   }
  },
  wait(row:RewardPolicyWaitObservation){
   const keys=['kind','waitingPresent','holderPresent','waitingActive','waitingOnLock','ownedBlocking'];
   if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.kind!=='wait-unavailable'||keys.slice(1).some(key=>typeof Reflect.get(row,key)!=='boolean'))throw Error('Closed owned wait observation required');
   add({kind:'wait-unavailable',waitingPresent:row.waitingPresent,holderPresent:row.holderPresent,waitingActive:row.waitingActive,waitingOnLock:row.waitingOnLock,ownedBlocking:row.ownedBlocking});
  },
  snapshot(){return Object.freeze({kind:'UNINSTALLED_REWARDS_POLICY_FAILURE_DIAGNOSTIC' as const,releaseAuthorized:false as const,complete:!overflow,observations:Object.freeze([...rows])});},
 });
}
