import type {RewardPolicyGroupVersion} from './policy-group-model';
import {rewardTargetKey} from './policy-group-model';
function ordered(value:unknown):unknown{
 if(Array.isArray(value))return value.map(ordered);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)]));
 return value;
}
/** Object storage order is irrelevant; explicit company/unit pairs never become a Cartesian product. */
export function diffRewardPolicyVersions(before:RewardPolicyGroupVersion,after:RewardPolicyGroupVersion){
 const keys=[...new Set([...Object.keys(before.policy),...Object.keys(after.policy)])] as (keyof typeof before.policy)[];
 const oldTargets=new Set(before.targets.map(rewardTargetKey)),newTargets=new Set(after.targets.map(rewardTargetKey));
 return {settings:keys.filter(key=>JSON.stringify(ordered(before.policy[key]))!==JSON.stringify(ordered(after.policy[key]))),
  added:after.targets.filter(pair=>!oldTargets.has(rewardTargetKey(pair))),removed:before.targets.filter(pair=>!newTargets.has(rewardTargetKey(pair)))};
}
