/** Board fc804e8c: Limit Controls are one typed source for every Rewards limit and threshold. The baseline is exactly
 * the engine before Limit Controls (same amounts and checks), a version changes values and behaviour, fixed financial
 * invariants cannot be configured, and end users see plain-language checks and rules without limit values. */
import {describe,expect,it} from 'vitest';
import {calculateRewards} from '../packs/rewards/engine';
import {defaultPolicy,emptyFacts,emptyRecommendation,type RewardEntry} from '../packs/rewards/model';
import {
 baselineRewardLimitValues,baselineRewardLimits,limitFlagText,rewardConfigurableLimitKeys,rewardLimitAccessForRole,rewardLimitDefinitions,rewardLimitKeys,
 rewardLimitSummaryRecord,rewardLimitValuesSchema,versionRewardLimits,type RewardLimitValues,
} from '../packs/rewards/limit-controls-model';
import {publicAppliedRules,rewardLimitRules} from '../packs/rewards/applied-rules-model';
import {buildRewardAdvisorCandidates} from '../packs/rewards/advisor-model';

const policy=()=>({...defaultPolicy(2026),patActual:100,patTarget:100,ranges:{'12':[300000,500000,700000] as [number,number,number],'13':[300000,600000,900000] as [number,number,number],H:[100000,200000,300000] as [number,number,number]}});
const entry=(id='a'):RewardEntry=>({id,source:{employmentId:id,personId:`person-${id}`,compensationId:`comp-${id}`,gradeId:null,employeeCode:id,name:id,grade:'12',basicCents:500000,currency:'MYR',payMode:'monthly',hiredOn:'2020-01-01',confirmedOn:'2020-04-01',notice:false,lastPayChange:null,confirmationPayChange:false,performanceReviewId:null,performanceRating:null},facts:{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'},recommendation:emptyRecommendation()});
const stored=(values:RewardLimitValues)=>Object.fromEntries(rewardConfigurableLimitKeys.map(key=>[key,values[key]]));
const version=(change:(v:RewardLimitValues)=>void,revision=1)=>{const values=baselineRewardLimitValues();change(values);return versionRewardLimits({id:'00000000-0000-4000-8000-0000000000aa',revision,year:2026,values:stored(values)});};
/** A fictional review with a promotion, a large increase, an individual multiplier and an over-budget bonus. */
function fixture(){
 const nominee=entry('nominee');nominee.recommendation.promotionGrade='13';nominee.recommendation.reason='Fictional business case for a sustained increase in role scope.';
 const star=entry('star');star.source.basicCents=400000;star.facts.talent='STAR';
 const big=entry('big');big.recommendation.meritBp=1200;
 const multiplied=entry('multiplied');multiplied.recommendation.multiplierBp=20000;
 return [nominee,star,big,multiplied];
}

describe('the limit inventory and its baseline',()=>{
 it('holds every requested limit once, with the baseline values the engine used before Limit Controls',()=>{
  expect(new Set(rewardLimitKeys).size).toBe(rewardLimitKeys.length);
  const v=baselineRewardLimitValues();
  expect([v['pool.standard.merit'].value,v['pool.standard.promotion'].value,v['pool.standard.special'].value]).toEqual(defaultPolicy(2026).standardPools);
  expect([v['pool.h.merit'].value,v['pool.h.promotion'].value,v['pool.h.special'].value]).toEqual(defaultPolicy(2026).hPools);
  expect({promotionBp:v['promotion.increment'].value,maxPromotionGrades:v['promotion.maxGrades'].value,maxGrade:v['promotion.maxGrade'].value,catchUpCrBp:v['catchUp.crFloor'].value,
   nonPromotionWarningBp:v['increase.withoutPromotion'].value,promotionWarningBp:v['increase.withPromotion'].value,minimumUtilizationBp:v['bonus.underUse'].value,bonusCeilingMonthsBp:v['bonus.individualCeiling'].value}).toEqual(rewardLimitRules);
  expect([v['lump.share'].value,v['lump.step'].value,v['lump.cap'].value]).toEqual([10000,5000,null]);
  expect([v['advisor.override'].value,v['advisor.longWithoutIncrease'].value,v['advisor.peerGap'].value]).toEqual([200,3,1500]);
  expect(v['bonus.poolCap']).toEqual({value:10000,type:'block'});expect(v['increase.withoutPromotion'].type).toBe('warning');expect(v['promotion.increment'].type).toBe('exception');
 });
 it('keeps salary reduction, separate pools, round-down payout and budget-cap-only exemptions fixed',()=>{
  const fixed=rewardLimitDefinitions.filter(row=>'fixed' in row&&row.fixed).map(row=>row.key).sort();
  expect(fixed).toEqual(['bonus.rounding','exemption.budgetCapsOnly','pool.separate','salary.noReduction']);
  expect(baselineRewardLimitValues()['salary.noReduction'].type).toBe('block');
  for(const key of fixed)expect(rewardConfigurableLimitKeys).not.toContain(key);
 });
 it('takes a baseline review\'s pools and lump-sum settings from its own policy',()=>{
  const p={...policy(),standardPools:[600,200,150] as [number,number,number],lumpStepCents:10000};
  const limits=baselineRewardLimits(p);
  expect(limits.source).toBe('baseline');expect(limits.values['pool.standard.merit'].value).toBe(600);expect(limits.values['lump.step'].value).toBe(10000);
 });
});

describe('a stored version',()=>{
 it('accepts exactly the configurable keys and refuses fixed invariants, locked types, missing keys and out-of-range values',()=>{
  const ok=stored(baselineRewardLimitValues());
  expect(rewardLimitValuesSchema.safeParse(ok).success).toBe(true);
  expect(rewardLimitValuesSchema.safeParse({...ok,'salary.noReduction':{value:null,type:'warning'}}).success).toBe(false);
  expect(rewardLimitValuesSchema.safeParse({...ok,'catchUp.crFloor':{value:9000,type:'block'}}).success).toBe(false);
  const {['bonus.poolCap']:_drop,...missing}=ok;expect(rewardLimitValuesSchema.safeParse(missing).success).toBe(false);
  expect(rewardLimitValuesSchema.safeParse({...ok,'promotion.maxGrade':{value:30,type:'block'}}).success).toBe(false);
  expect(rewardLimitValuesSchema.safeParse({...ok,'lump.step':{value:5050,type:'note'}}).success).toBe(false);
  expect(rewardLimitValuesSchema.safeParse({...ok,'bonus.individualMultiplier':{value:5,type:'exception'}}).success).toBe(false);
  expect(rewardLimitValuesSchema.safeParse({...ok,'lump.cap':{value:null,type:'note'}}).success).toBe(true);
 });
 it('never lets a version change a fixed invariant, even with forged stored values',()=>{
  const forged={...stored(baselineRewardLimitValues())};
  const limits=versionRewardLimits({id:'x',revision:1,year:2026,values:forged});
  expect(limits.values['salary.noReduction']).toEqual({value:null,type:'block'});
  expect(()=>versionRewardLimits({id:'x',revision:1,year:2026,values:{...forged,'salary.noReduction':{value:null,type:'note'}}})).toThrow();
 });
 it('summarises value and type changes as display text',()=>{
  const after=baselineRewardLimitValues();after['increase.withoutPromotion']={value:1200,type:'exception'};
  const before=rewardLimitSummaryRecord(baselineRewardLimitValues())!,next=rewardLimitSummaryRecord(after)!;
  expect([before['increase.withoutPromotion:value'],next['increase.withoutPromotion:value'],before['increase.withoutPromotion:type'],next['increase.withoutPromotion:type']]).toEqual(['10%','12%','Warning','Exception']);
  expect(next['lump.cap:value']).toBe('None');expect(next['bonus.rounding:value']).toBeUndefined();
 });
});

describe('the engine reads the confirmed limits',()=>{
 it('keeps baseline amounts and checks byte for byte when no version exists or a version repeats the baseline',()=>{
  const p=policy(),rows=fixture();
  const legacy=calculateRewards(rows,p),explicit=calculateRewards(rows,p,{limits:baselineRewardLimits(p)}),same=calculateRewards(rows,p,{limits:version(()=>{})});
  expect(explicit).toEqual(legacy);
  expect(same.rows.map(r=>[r.meritCents,r.promotionCents,r.specialCents,r.newBasicCents,r.bonusCents,r.lumpCents])).toEqual(legacy.rows.map(r=>[r.meritCents,r.promotionCents,r.specialCents,r.newBasicCents,r.bonusCents,r.lumpCents]));
  expect(same.budgets).toEqual(legacy.budgets);
  expect(same.flags.map(f=>[f.severity,f.code,f.entryId])).toEqual(legacy.flags.map(f=>[f.severity,f.code,f.entryId]));
  expect(legacy.flags.some(f=>f.code==='INC-01'&&f.entryId==='big'&&f.severity==='warning')).toBe(true);
 });
 it('applies a changed threshold, type, promotion increment and pool from the version',()=>{
  const p=policy(),rows=fixture();
  const relaxed=calculateRewards(rows,p,{limits:version(v=>{v['increase.withoutPromotion']={value:1500,type:'warning'};})});
  expect(relaxed.flags.some(f=>f.code==='INC-01'&&f.entryId==='big')).toBe(false);
  const blocking=calculateRewards(rows,p,{limits:version(v=>{v['increase.withoutPromotion']={value:1000,type:'block'};})});
  expect(blocking.flags.find(f=>f.code==='INC-01'&&f.entryId==='big')).toEqual({severity:'block',code:'INC-01',message:'This increase is above the individual review threshold – reduce the increase to submit.',entryId:'big'});
  const promotion=calculateRewards(rows,p,{limits:version(v=>{v['promotion.increment']={value:1500,type:'exception'};})});
  expect(promotion.rows.find(r=>r.id==='nominee')!.promotionCents).toBe(75000);
  const pools=calculateRewards(rows,p,{limits:version(v=>{v['pool.standard.merit']={value:200,type:'warning'};})});
  expect(pools.budgets.standard.pools[0]).toBe(Math.floor(pools.budgets.standard.payrollCents*200/10000));
  expect(pools.flags).toContainEqual(expect.objectContaining({code:'POOL-03',severity:'warning'}));
  expect(calculateRewards(rows,p).flags.some(f=>f.code==='POOL-03'&&f.severity==='warning')).toBe(false);
  const multiplier=calculateRewards(rows,p,{limits:version(v=>{v['bonus.individualMultiplier']={value:null,type:'note'};})});
  expect(multiplier.flags.find(f=>f.code==='BUD-02')?.severity).toBe('review');
 });
 it('caps bonus at the configured pool cap and keeps an exemption to budget caps only',()=>{
  const p={...policy(),multiplierBp:14000},rows=[entry()];
  const base=calculateRewards(rows,p);
  expect(base.flags).toContainEqual(expect.objectContaining({code:'BUD-01',severity:'block'}));
  const used=base.budgets.standard.bonusUsedCents*10000/base.budgets.standard.bonusPoolCents;
  const loose=calculateRewards(rows,p,{limits:version(v=>{v['bonus.poolCap']={value:Math.ceil(used),type:'block'};})});
  expect(loose.flags.some(f=>f.code==='BUD-01')).toBe(false);
  const exempt=calculateRewards(rows,{...p,exemptReason:'Fictional acquisition integration'},{limits:version(v=>{v['bonus.poolCap']={value:10000,type:'block'};})});
  expect(exempt.flags).toContainEqual(expect.objectContaining({code:'CFG-01',severity:'review'}));
  // A Final pool still blocks, whatever the configured type.
  const final=calculateRewards(rows,p,{poolStatus:'final',limits:version(v=>{v['bonus.poolCap']={value:10000,type:'warning'};})});
  expect(final.flags).toContainEqual(expect.objectContaining({code:'BUD-01',severity:'block'}));
 });
 it('adds the highest-grade and individual bonus ceiling checks only for a Limit Controls version',()=>{
  // 1.5 matrix months × 7.0 = 10.5 months, above the 9.00-month ceiling.
  const p={...policy(),multiplierBp:70000},rows=[entry()];
  expect(calculateRewards(rows,p).flags.some(f=>f.code==='BUD-03')).toBe(false);
  expect(calculateRewards(rows,p,{limits:version(()=>{})}).flags).toContainEqual(expect.objectContaining({code:'BUD-03',severity:'exception',entryId:'a'}));
  const promoted=entry('p');promoted.source.grade='22';promoted.recommendation.promotionGrade='23';promoted.recommendation.reason='Fictional business case for a sustained increase in role scope.';
  const pp={...policy(),ranges:{...policy().ranges,'22':[1,2,3] as [number,number,number],'23':[1,2,3] as [number,number,number]}};
  expect(calculateRewards([promoted],pp,{limits:version(v=>{v['promotion.maxGrade']={value:22,type:'block'};})}).flags).toContainEqual(expect.objectContaining({code:'PRO-01',severity:'block'}));
  expect(calculateRewards([promoted],pp).flags.some(f=>f.code==='PRO-01')).toBe(false);
 });
 it('never states a limit value in a flag and always blocks a salary reduction',()=>{
  const p={...policy(),multiplierBp:30000},rows=fixture();
  const flags=calculateRewards(rows,p,{limits:version(v=>{v['promotion.increment']={value:1500,type:'exception'};})}).flags;
  const limited=flags.filter(f=>['INC-01','POOL-05','POOL-03','BUD-01','BUD-07','BUD-02','BUD-03','BUD-05','PRO-01'].includes(f.code));
  expect(limited.length).toBeGreaterThan(3);
  for(const flag of limited)expect(flag.message,flag.code).not.toMatch(/\d|%/);
  expect(limitFlagText('Bonus pool is over budget','block','reduce amounts')).toBe('Bonus pool is over budget – reduce amounts to submit.');
  expect(limitFlagText('Increase needs review','exception','x')).toBe('Increase needs review – give a reason before you submit.');
 });
 it('feeds the AI advisor the confirmed promotion increment',()=>{
  const nominee=fixture()[0];
  const base=buildRewardAdvisorCandidates([nominee],policy()),versioned=buildRewardAdvisorCandidates([nominee],policy(),{limits:version(v=>{v['promotion.increment']={value:1500,type:'exception'};})});
  expect(base.candidates[0].recommendation?.promotionBp??1000).toBe(1000);
  expect(versioned.candidates[0].newBasicCents-base.candidates[0].newBasicCents).toBe(25000);
 });
});

describe('who sees limit settings',()=>{
 it('lets Group Rewards edit, CTRO and EC view, and nobody else',()=>{
  expect(['gr','ctro','ec','bu','bg','proxy_bg','pbp','payroll','hr_admin'].map(rewardLimitAccessForRole)).toEqual(['edit','view','view',null,null,null,null,null,null]);
 });
 it('shows end users what each rule does without values, controls or references, and keeps eligibility facts',()=>{
  const p=policy(),limits=version(v=>{v['increase.withoutPromotion']={value:1200,type:'warning'};});
  const full=publicAppliedRules(p,false,{limits,showLimits:true}),plain=publicAppliedRules(p,false,{limits,showLimits:false});
  expect(full.rules.find(r=>r.ref==='SAL-02')).toMatchObject({control:'soft',values:{limit:12},plain:false});
  expect(full.rules.find(r=>r.ref==='BUD-01')?.values).toMatchObject({cap:100,minimum:80});
  expect(plain.showLimits).toBe(false);
  for(const ref of ['POOL-01','PRO-01','SAL-02','SAL-03','BUD-01','BUD-03','BUD-05'])expect(plain.rules.find(r=>r.ref===ref)).toEqual(expect.objectContaining({values:{},control:null,plain:true}));
  expect(plain.rules.find(r=>r.ref==='ELIG-04')).toMatchObject({values:{from:p.blockedFrom,to:p.blockedTo},control:null,plain:false});
  expect(JSON.stringify(plain.rules)).not.toMatch(/"limit"|"percent"|"cap"|"hard"|"soft"/);
 });
});
