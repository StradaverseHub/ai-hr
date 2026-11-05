import {z} from 'zod';
import {calculateRewards,ratio,type CalculatedEntry} from './engine';
import {emptyRecommendation,isSeniorPlanMember,recommendationSchema,type RewardEntry,type RewardPolicy,type Recommendation} from './model';
export const advisorSettingsSchema=z.object({enabled:z.boolean(),overrideThresholdBp:z.number().int().min(0).max(10000),longWithoutIncreaseYears:z.number().int().min(1).max(20),equityGapBp:z.number().int().min(0).max(10000),fairnessGapBp:z.number().int().min(0).max(10000)}).strict();
export type AdvisorSettings=z.infer<typeof advisorSettingsSchema>;
export const defaultAdvisorSettings:AdvisorSettings={enabled:false,overrideThresholdBp:200,longWithoutIncreaseYears:3,equityGapBp:1500,fairnessGapBp:1000};
export const advisorReasonRefs=['matrix','below_midpoint','above_range','promotion_nomination','separate_pools','bonus_matrix','long_without_increase'] as const;
export type AdvisorReasonRef=typeof advisorReasonRefs[number];
export type AdvisorCandidate={entryId:string;recommendation:Recommendation|null;confidence:'high'|'medium'|'low';reasons:AdvisorReasonRef[];missing:string[];newBasicCents:number;bonusCents:number;plan:'standard'|'h'|'ec'};
type Controls=Parameters<typeof calculateRewards>[2];
/** Native deterministic candidates. A provider can order explanation refs, never supply an amount. */
export function buildRewardAdvisorCandidates(entries:readonly RewardEntry[],policy:RewardPolicy,controls:Controls={}):{candidates:AdvisorCandidate[];poolUse:{standard:{salaryBp:number|null;bonusBp:number|null};h:{salaryBp:number|null;bonusBp:number|null}}}{
 const personCount=new Map<string,number>();for(const e of entries)personCount.set(e.source.personId,(personCount.get(e.source.personId)??0)+1);
 const suggestions=entries.map(e=>({...e,recommendation:{...emptyRecommendation(),promotionGrade:e.recommendation.promotionGrade,promotionBp:e.recommendation.promotionGrade?1000:null,reason:e.recommendation.promotionGrade?e.recommendation.reason:''}}));
 const calculation=calculateRewards(suggestions,policy,controls);
 const over=Object.values(calculation.budgets).some((b,i)=>i<2&&(b.used.some((used,n)=>used>b.pools[n])||b.bonusUsedCents>b.bonusPoolCents));
 const candidates=calculation.rows.map(e=>{
  const missing:string[]=[];
  if(!e.facts.talent)missing.push('talent');if(!e.facts.performance)missing.push('performance');if(!/^(H|1[2-9]|2[0-3])$/.test(e.source.grade))missing.push('grade');
  if(!policy.ranges[e.source.grade])missing.push('salary_range');if(!e.source.compensationId||e.source.basicCents<=0||e.source.currency!=='MYR')missing.push('salary');
  if((personCount.get(e.source.personId)??0)>1)missing.push('duplicate');if(!e.facts.reviewed)missing.push('unverified');
  if(isSeniorPlanMember(policy,e.facts,e.source.grade)||e.plan==='ec')missing.push('separate_plan');if(!e.incrementEligible&&!e.bonusEligible)missing.push('ineligible');
  if(calculation.flags.some(f=>f.entryId===e.id&&f.severity==='block'))missing.push('rules');if(over)missing.push('budget');
  if(controls.poolStatus==='not-set'||controls.poolStatus==='provisional')missing.push('final_pool');
  const range=policy.ranges[e.source.grade],reasons:AdvisorReasonRef[]=['matrix','separate_pools'];
  if(range&&e.source.basicCents*10000<range[1]*9000)reasons.unshift('below_midpoint');else if(range&&e.source.basicCents>range[2])reasons.unshift('above_range');
  if(e.recommendation.promotionGrade)reasons.unshift('promotion_nomination');if(e.bonusEligible)reasons.push('bonus_matrix');
  const recommendation:Recommendation|null=missing.length?null:{...e.recommendation,meritBp:e.meritBp,promotionBp:e.recommendation.promotionGrade?e.promotionBp:null,specialBp:e.specialBp,multiplierBp:e.bonusMultiplierBp,bonusCents:null,lumpCents:e.lumpCents,reason:''};
  return{entryId:e.id,recommendation,confidence:e.source.onehr?'high' as const:'medium' as const,reasons:reasons.slice(0,3),missing:[...new Set(missing)],newBasicCents:e.newBasicCents,bonusCents:e.bonusCents,plan:e.plan};
 });
 const use=(plan:'standard'|'h')=>{const b=calculation.budgets[plan],salaryPool=b.pools.reduce((n,v)=>n+v,0),salaryUsed=calculation.rows.filter(r=>r.plan===plan&&candidates.find(c=>c.entryId===r.id)?.recommendation).reduce((n,r)=>n+r.meritCents+r.promotionCents+r.specialCents,0);return{salaryBp:salaryPool?ratio(salaryUsed,10000,salaryPool):null,bonusBp:b.bonusPoolCents?ratio(calculation.rows.filter(r=>r.plan===plan&&candidates.find(c=>c.entryId===r.id)?.recommendation).reduce((n,r)=>n+r.bonusCents,0),10000,b.bonusPoolCents):null};};
 return{candidates,poolUse:{standard:use('standard'),h:use('h')}};
}
export function advisorNeedsOverrideReason(proposed:Recommendation,suggested:Recommendation,thresholdBp:number){
 return(['meritBp','promotionBp','specialBp'] as const).some(key=>Math.abs((proposed[key]??0)-(suggested[key]??0))>thresholdBp)||Math.abs((proposed.multiplierBp??0)-(suggested.multiplierBp??0))>thresholdBp||proposed.promotionGrade!==suggested.promotionGrade;
}
export function validateAdvisorDecision(raw:unknown,candidate:AdvisorCandidate,settings:AdvisorSettings){const p=z.object({action:z.enum(['accept','adjust','ignore']),recommendation:recommendationSchema.optional(),reason:z.string().trim().max(4000)}).strict().parse(raw);if(p.action==='ignore')return p;if(!candidate.recommendation)throw new Error('There is no validated suggestion for this employee.');const recommendation=p.action==='accept'?candidate.recommendation:p.recommendation;if(!recommendation)throw new Error('Enter the adjusted recommendation.');if(p.action==='adjust'&&advisorNeedsOverrideReason(recommendation,candidate.recommendation,settings.overrideThresholdBp)&&p.reason.length<10)throw new Error('Explain the difference from the suggestion in at least 10 characters.');return{...p,recommendation:{...recommendation,reason:p.reason||recommendation.reason}};}
export function validatedAdvisorReasonOrder(raw:string,refs:readonly AdvisorReasonRef[]):AdvisorReasonRef[]{
 const p=z.object({items:z.array(z.number().int().min(0).max(refs.length-1)).min(Math.min(2,refs.length)).max(3)}).strict().parse(JSON.parse(raw));if(new Set(p.items).size!==p.items.length)throw new Error('Explanation references must be distinct.');return p.items.map(i=>refs[i]);
}
export type RewardAdvisorInsights={belowTarget:number;longWithoutIncrease:number;rangeBefore:{below:number;within:number;above:number};rangeAfter:{below:number;within:number;above:number}};
export function rewardAdvisorInsights(rows:readonly CalculatedEntry[],policy:RewardPolicy,settings:AdvisorSettings):RewardAdvisorInsights{
 const pos=(cents:number,grade:string)=>{const r=policy.ranges[grade];return !r?null:cents<r[0]?'below' as const:cents>r[2]?'above' as const:'within' as const;},count={below:0,within:0,above:0},after={...count};
 for(const row of rows){const before=pos(row.source.basicCents,row.source.grade),next=pos(row.newBasicCents,row.recommendation.promotionGrade??row.source.grade);if(before)count[before]++;if(next)after[next]++;}
 return{belowTarget:rows.filter(r=>['STAR','SSTAR'].includes(r.facts.talent??'')&&policy.ranges[r.source.grade]&&r.newBasicCents*10000<policy.ranges[r.source.grade][1]*9000).length,longWithoutIncrease:rows.filter(r=>{const last=r.source.lastPayChange??r.source.hiredOn;return Number(last.slice(0,4))+settings.longWithoutIncreaseYears<=policy.year;}).length,rangeBefore:count,rangeAfter:after};
}
