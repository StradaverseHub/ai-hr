import {describe,expect,it} from 'vitest';
import {defaultPolicy} from '../packs/rewards/model';
import {normalizedRewardTargets,removeRewardTargetCompany,rewardPolicyGroupEditSchema,rewardPolicyTargetsSchema} from '../packs/rewards/policy-group-model';
import {todayInKualaLumpur} from '../lib/hr-date';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
describe('explicit shared reward targets and isolated future policy',()=>{
 it('retains exactly selected pairs and deselects only the requested company',()=>{
  const a={companyId:id(1),businessUnitId:id(3)},b={companyId:id(2),businessUnitId:id(4)};
  expect(normalizedRewardTargets([b,a])).toEqual([a,b]);
  expect(removeRewardTargetCompany([a,b],id(1))).toEqual([b]);
  expect(rewardPolicyTargetsSchema.safeParse([a,{...a}]).success).toBe(false);
  expect(rewardPolicyTargetsSchema.parse([])).toEqual([]);
 });
 it('does not share unit-specific lump funding or restore the legacy senior-grade rule',()=>{
  const policy=defaultPolicy(Number(todayInKualaLumpur().slice(0,4))),base={groupId:null,expectedRevision:0,name:'Fictional shared policy',policy,targets:[{companyId:id(1),businessUnitId:id(2)}]};
  expect(rewardPolicyGroupEditSchema.parse(base).policy).toEqual(policy);
  expect(rewardPolicyGroupEditSchema.safeParse({...base,targets:[]}).success).toBe(false);
  expect(rewardPolicyGroupEditSchema.safeParse({...base,groupId:id(9),expectedRevision:1,targets:[]}).success).toBe(true);
  expect(rewardPolicyGroupEditSchema.safeParse({...base,policy:{...policy,lumpUnitCents:10000}}).success).toBe(false);
  expect(rewardPolicyGroupEditSchema.safeParse({...base,policy:{...policy,seniorMembershipMode:'legacy-grades',seniorGrades:['20']}}).success).toBe(false);
  expect(rewardPolicyGroupEditSchema.safeParse({...base,groupId:id(9)}).success).toBe(false);
 });
});
