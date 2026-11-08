/** Pure forwarding for module-initialization captures. No native/app imports,
 * schema construction, getter mutation, argument/result copy or authority. */
import type {rewardsPolicyDiagnostics,RewardPolicyCallbackPhase} from './rewards-audit-policy-diagnostic';
type Current=()=>ReturnType<typeof rewardsPolicyDiagnostics>|undefined;
export function rewardPolicyObservedCallback<T>(current:Current,phase:RewardPolicyCallbackPhase,work:()=>Promise<T>):Promise<T>{
 const owner=current();return owner?owner.callback(phase,work):work();
}
export function rewardPolicyObservedParse<T extends object>(actual:T,current:Current,phase:RewardPolicyCallbackPhase):T{
 return new Proxy(actual,{get(target,key){
  const member=Reflect.get(target,key,target);if(key!=='parse'||typeof member!=='function')return member;
  return(...args:unknown[])=>{const owner=current(),work=()=>Reflect.apply(member,target,args);return owner?owner.sync(phase,work):work();};
 }});
}
