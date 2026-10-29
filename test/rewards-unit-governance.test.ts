import {describe,it,expect} from 'vitest';
import {calculateRewards} from '../packs/rewards/engine';
import {defaultPolicy,emptyFacts,emptyRecommendation,type RewardEntry} from '../packs/rewards/model';
import {emptyGovernance,poolStatus,effectiveRewardPolicy,confirmedSeniorAwards,seniorGrade,governanceBasis,seniorSourceFingerprint,redactPatPolicy} from '../packs/rewards/governance-model';
const entry=(id='a'):RewardEntry=>({id,source:{employmentId:id,personId:'person-'+id,compensationId:'comp-'+id,gradeId:null,employeeCode:id,name:id,grade:'21',basicCents:500000,currency:'MYR',payMode:'monthly',hiredOn:'2020-01-01',confirmedOn:'2020-04-01',notice:false,lastPayChange:null,confirmationPayChange:false,performanceReviewId:null,performanceRating:null},facts:{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'},recommendation:emptyRecommendation()});
const policy=()=>({...defaultPolicy(2026),patActual:100000,patTarget:100000,multiplierBp:10000,ranges:{'21':[300000,500000,700000] as [number,number,number]}});
const state=()=>({...emptyGovernance(),inputs:{forecastCents:900000,actualCents:null,targetCents:1000000,targetMonthsBp:20000,multiplierBp:10000,branchRatings:{}}});
describe('unit-owned PAT and independently checked Senior plan',()=>{
 it('distinguishes missing actual from entered zero without using forecast as a fallback',()=>{
  const s=state();expect(poolStatus(s)).toBe('provisional');s.inputs.actualCents=0 as never;
  expect(poolStatus(s)).toBe('not-set');expect(effectiveRewardPolicy(policy(),s).patActual).toBe(0);
 });
 it('uses forecast then actual, and permits a genuine positive RM1 target',()=>{
  const s=state();expect(effectiveRewardPolicy(policy(),s)).toMatchObject({patActual:900000,patTarget:1000000});
  s.inputs.actualCents=800000 as never;expect(poolStatus(s)).toBe('final');expect(effectiveRewardPolicy(policy(),s).patActual).toBe(800000);
  s.inputs.targetCents=100;expect(poolStatus(s)).toBe('final');
 });
 it('preserves the saved legacy basis until explicit adoption',()=>{
  const p=policy();expect(effectiveRewardPolicy(p,null)).toBe(p);expect(poolStatus(emptyGovernance())).toBe('legacy');
 });
 it('keeps exact public pool cents equal to the private calculation, never reconstructing from a rounded percentage',()=>{
  const s=state(),p=effectiveRewardPolicy(policy(),s),privateResult=calculateRewards([entry()],p,{poolStatus:'provisional'});
  // 500000 x 900000 / 1000000 x 2 = 900000 cents, independently expected.
  expect(privateResult.budgets.standard.bonusPoolCents).toBe(900000);
  const redacted=redactPatPolicy(p,['bu']);expect(redacted.patActual).toBe(0);
  const publicResult=calculateRewards([entry()],redacted,{poolStatus:'provisional',bonusPools:{standard:900000,h:0}});
  expect(publicResult.budgets.standard).toEqual(privateResult.budgets.standard);expect(publicResult.rows).toEqual(privateResult.rows);
 });
 it('excludes selected Senior salary and awards from every pool while leaving ordinary JG21 in the standard plan',()=>{
  const a=entry('senior'),b=entry('ordinary');a.facts.seniorPlan=true;
  const result=calculateRewards([a,b],policy(),{seniorAwards:{senior:{newBasicCents:550000,bonusCents:2000000}}});
  expect(result.budgets.standard.payrollCents).toBe(500000);expect(result.budgets.standard.bonusPayrollCents).toBe(500000);
  expect(result.budgets.standard.pools).toEqual([25000,5000,5000]);expect(result.budgets.standard.used).toEqual([22500,0,0]);
  expect(result.rows[0]).toMatchObject({incrementEligible:false,bonusEligible:false,lumpEligible:false,meritCents:0,promotionCents:0,specialCents:0,lumpCents:0,newBasicCents:550000,bonusCents:2000000});
  expect(result.budgets.standard.bonusUsedCents).toBe(result.rows[1].bonusCents+result.rows[1].lumpCents);
 });
 it('rejects below-grade selection and discards a confirmed award after its salary snapshot changes',()=>{
  expect(seniorGrade('20')).toBe(false);expect(seniorGrade('21')).toBe(true);expect(seniorGrade('JG 23')).toBe(true);
  const e=entry(),s=state();s.awards[e.id]={newBasicCents:600000,bonusCents:100000,approvalReference:'APP-1',approvalDate:'2026-10-29',reason:'Checked approved evidence',sourceFingerprint:seniorSourceFingerprint(e),evidence:[],proposedBy:'a',confirmedBy:'b',confirmedAt:'2026-10-29T00:00:00Z'};
  expect(confirmedSeniorAwards(s,[e])[e.id]).toEqual({newBasicCents:600000,bonusCents:100000});e.source.compensationId='changed';expect(confirmedSeniorAwards(s,[e])).toEqual({});
 });
 it('binds the public projection to a hash rather than exposing roster salaries or PAT',()=>{
  const s=state(),p=effectiveRewardPolicy(policy(),s),e=entry();const basis=governanceBasis(p,[e]);expect(basis).toMatch(/^[a-f0-9]{64}$/);expect(basis).not.toContain('500000');
  const edited={...e,facts:{...e.facts,performance:'OU' as const}};expect(governanceBasis(p,[edited])).not.toBe(basis);
 });
 it('keeps final-pool overspend blocked even after an exemption is independently approved',()=>{
  const result=calculateRewards([entry()],{...policy(),exemptReason:'Approved special exemption'},{poolStatus:'final',bonusPools:{standard:1,h:0}});
  expect(result.flags).toContainEqual(expect.objectContaining({severity:'block',code:'CFG-01'}));
 });
 it('makes PPCH branch UA nil even when an individual override attempts to supply a multiplier',()=>{
  const e=entry();e.facts.branch='A';e.facts.segment='S';e.recommendation.multiplierBp=20000;
  const result=calculateRewards([e],{...policy(),bonusStructure:'branch',branchRatings:{A:'UA'},branchFactors:{S:[10000,10000,10000,10000,10000]}});
  expect(result.rows[0].bonusCents).toBe(0);expect(result.rows[0].bonusMultiplierBp).toBe(0);
 });
});
