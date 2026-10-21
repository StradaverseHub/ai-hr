import {describe,expect,it} from 'vitest';
import {defaultPolicy,talents,type RewardPolicy} from '../packs/rewards/model';
import {rewardPolicyFromForm,RewardPolicyInputError} from '../app/rewards/policy-input';
import {todayInKualaLumpur} from '../lib/hr-date';
function fields(p:RewardPolicy){
 const f=new FormData();
 for(const key of ['effectiveFrom','joinedBefore','confirmedBy','blockedFrom','blockedTo','bonusStructure','exemptReason'] as const)f.set(key,p[key]);
 for(const [key,value,scale] of [['patActual',p.patActual,100],['patTarget',p.patTarget,100],['targetMonths',p.targetMonthsBp,10000],['multiplier',p.multiplierBp,10000],['lumpStep',p.lumpStepCents,100],['lumpShare',p.lumpShareBp,100],['lumpCap',p.lumpCapCents,100]] as const)f.set(key,value===null?'':String(value/scale));
 for(const [key,values] of [['standard',p.standardPools],['h',p.hPools]] as const)values.forEach((v,i)=>f.set(`${key}.${i}`,String(v/100)));
 for(const talent of talents)p.meritMatrix[talent].forEach((v,i)=>f.set(`merit.${talent}.${i}`,String(v/100)));
 for(const [key,matrix,scale] of [['ranges',p.ranges,100],['bonusMatrix',p.bonusMatrix,10000],['branchFactors',p.branchFactors,10000]] as const)f.set(key,Object.entries(matrix).map(([name,values])=>[name,...values.map(v=>v/scale)].join(', ')).join('\n'));
 f.set('branchRatings',Object.entries(p.branchRatings).map(pair=>pair.join(', ')).join('\n'));return f;
}
describe('review and shared configuration form contract',()=>{
 it('roundtrips the existing policy units and retains server-owned year, membership and unit funding',()=>{
  const p={...defaultPolicy(Number(todayInKualaLumpur().slice(0,4))),lumpUnitCents:12345};
  const form=fields(p);form.set('year','2001');form.set('seniorMembershipMode','legacy-grades');form.set('lumpUnitCents','999999');
  expect(rewardPolicyFromForm(form,p)).toEqual(p);
 });
 it('reports malformed or duplicate matrix input as a finite input refusal',()=>{
  const p=defaultPolicy(Number(todayInKualaLumpur().slice(0,4))),form=fields(p);
  form.set('ranges','20, 100');expect(()=>rewardPolicyFromForm(form,p)).toThrow(RewardPolicyInputError);
  form.set('ranges','20, 100, 200, 300\n20, 400, 500, 600');expect(()=>rewardPolicyFromForm(form,p)).toThrow(RewardPolicyInputError);
  form.set('ranges','20, 100, nope, 300');expect(()=>rewardPolicyFromForm(form,p)).toThrow(RewardPolicyInputError);
 });
});
