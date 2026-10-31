import {describe,expect,it} from 'vitest';
import {defaultPolicy,talents,type RewardPolicy} from '../packs/rewards/model';
import {rewardPolicyFromForm,RewardPolicyInputError} from '../app/(app)/rewards/policy-input';
import {REWARD_POLICY_GRADES} from '../packs/rewards/policy-grid-validation';
import {todayInKualaLumpur} from '../lib/hr-date';
function matrixLines(matrix:Record<string,readonly number[]>,scale:number){
 return Object.entries(matrix).map(([name,values])=>[name,...values.map(value=>value/scale)].join(', ')).join('\n');
}
function completePolicy(year:number){return {...defaultPolicy(year),ranges:Object.fromEntries(REWARD_POLICY_GRADES.filter(g=>g!=='23').map(g=>[g,[10000,20000,30000] as [number,number,number]])),bonusMatrix:Object.fromEntries(REWARD_POLICY_GRADES.map(g=>[g,[0,10000,20000,30000,40000] as [number,number,number,number,number]]))};}
function fields(p:RewardPolicy){
 const f=new FormData();
 for(const key of ['effectiveFrom','joinedBefore','confirmedBy','blockedFrom','blockedTo','bonusStructure','exemptReason'] as const)f.set(key,p[key]);
 for(const [key,value,scale] of [['patActual',p.patActual,100],['patTarget',p.patTarget,100],['targetMonths',p.targetMonthsBp,10000],['multiplier',p.multiplierBp,10000],['lumpStep',p.lumpStepCents,100],['lumpShare',p.lumpShareBp,100],['lumpCap',p.lumpCapCents,100]] as const)f.set(key,value===null?'':String(value/scale));
 for(const [key,values] of [['standard',p.standardPools],['h',p.hPools]] as const)values.forEach((v,i)=>f.set(`${key}.${i}`,String(v/100)));
 for(const talent of talents)p.meritMatrix[talent].forEach((v,i)=>f.set(`merit.${talent}.${i}`,String(v/100)));
 for(const [key,matrix,scale] of [['ranges',p.ranges,100],['bonusMatrix',p.bonusMatrix,10000],['branchFactors',p.branchFactors,10000]] as const)f.set(key,matrixLines(matrix,scale));
 f.set('branchRatings',Object.entries(p.branchRatings).map(pair=>pair.join(', ')).join('\n'));return f;
}
describe('review and shared configuration form contract',()=>{
 it('roundtrips the existing policy units and retains server-owned year, membership and unit funding',()=>{
  const p={...completePolicy(Number(todayInKualaLumpur().slice(0,4))),lumpUnitCents:12345};
  const form=fields(p);form.set('year','2001');form.set('seniorMembershipMode','legacy-grades');form.set('lumpUnitCents','999999');
  expect(rewardPolicyFromForm(form,p)).toEqual(p);
 });
 it('reports malformed or duplicate matrix input as a finite input refusal',()=>{
  const p=completePolicy(Number(todayInKualaLumpur().slice(0,4))),form=fields(p);
  form.set('ranges','20, 100');expect(()=>rewardPolicyFromForm(form,p)).toThrow(RewardPolicyInputError);
  form.set('ranges','20, 100, 200, 300\n20, 400, 500, 600');expect(()=>rewardPolicyFromForm(form,p)).toThrow(RewardPolicyInputError);
  form.set('ranges','20, 100, nope, 300');expect(()=>rewardPolicyFromForm(form,p)).toThrow(RewardPolicyInputError);
 });
 it('enforces grid precision and full coverage on the server without trusting an optional marker',()=>{
  const p=completePolicy(2026),f=fields(p);f.delete('policyGridVersion');
  f.set('bonusMatrix',String(f.get('bonusMatrix')).replace('H, 0, 1, 2, 3, 4','H, 0, 1.001, 2, 3, 4'));
  expect(()=>rewardPolicyFromForm(f,p)).toThrow(RewardPolicyInputError);
  f.set('bonusMatrix',matrixLines(p.bonusMatrix,10000));f.set('ranges','H, 100, 200, 300');
  expect(()=>rewardPolicyFromForm(f,p)).toThrow(RewardPolicyInputError);
 });

 it('roundtrips legitimate branch segment commas and newlines through structured grid data',()=>{
  const p=completePolicy(2026),f=fields(p),segment='Retail, West\nRegional';
  f.set('bonusStructure','branch');f.set('policyGridData.branchFactors',JSON.stringify([[segment,'0','1','1.5','2','2.5']]));
  expect(rewardPolicyFromForm(f,p).branchFactors).toEqual({[segment]:[0,10000,15000,20000,25000]});
 });

});
