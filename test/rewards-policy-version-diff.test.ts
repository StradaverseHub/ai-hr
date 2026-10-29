import {describe,expect,it} from 'vitest';
import {defaultPolicy} from '../packs/rewards/model';
import type {RewardPolicyGroupVersion} from '../packs/rewards/policy-group-model';
import {diffRewardPolicyVersions} from '../packs/rewards/policy-version-diff';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const before:RewardPolicyGroupVersion={groupId:id(1),versionId:id(2),revision:1,name:'Fictional policy',policy:defaultPolicy(2026),targets:[{companyId:id(3),businessUnitId:id(4)}]};
describe('shared reward version comparison',()=>{
 it('ignores JSON object key order and version metadata',()=>{
  const after={...before,versionId:id(7),revision:2,policy:{...before.policy,meritMatrix:Object.fromEntries(Object.entries(before.policy.meritMatrix).reverse()) as typeof before.policy.meritMatrix}};
  expect(diffRewardPolicyVersions(before,after)).toEqual({settings:[],added:[],removed:[]});
 });
 it('compares settings and exact coverage pairs independently, including global units',()=>{
  const after={...before,policy:{...before.policy,standardPools:[600,100,100] as [number,number,number]},targets:[{companyId:id(5),businessUnitId:id(4)}]};
  const diff=diffRewardPolicyVersions(before,after);
  expect(diff.settings).toEqual(['standardPools']);expect(diff.added).toEqual(after.targets);expect(diff.removed).toEqual(before.targets);
  expect(before.policy.standardPools).not.toEqual(after.policy.standardPools);
 });
});
