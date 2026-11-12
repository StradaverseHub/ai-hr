import type {RewardPolicy,RewardFlag} from './model';
import {baselineRewardLimits,rewardLimitRuleRefs,type RewardLimitKey,type RewardLimitType,type RewardLimits} from './limit-controls-model';
export type RuleControl='hard'|'soft'|'notification'|'rule';
export type AppliedRewardRule={ref:string;category:'pools'|'individual'|'bonus'|'eligibility'|'access';control:RuleControl;values:Record<string,string|number>};
/** The baseline engine controls (board fc804e8c moved them to Limit Controls; these are the baseline values). */
export const rewardLimitRules={promotionBp:1000,maxPromotionGrades:3,maxGrade:23,catchUpCrBp:9000,nonPromotionWarningBp:1000,promotionWarningBp:3000,minimumUtilizationBp:8000,bonusCeilingMonthsBp:90000} as const;
const controlFor=(type:RewardLimitType):RuleControl=>type==='block'?'hard':type==='note'?'notification':'soft';
/** Constants are explanations of the deterministic engine controls, never editable free text. Values and controls
 * come from the review's confirmed Limit Controls (the baseline when the year has none). */
export function appliedRewardRules(p:RewardPolicy,uploaded=false,limits:RewardLimits=baselineRewardLimits(p)):AppliedRewardRule[]{
 const make=(ref:string,category:AppliedRewardRule['category'],control:RuleControl,values:AppliedRewardRule['values']={}):AppliedRewardRule=>({ref,category,control,values});
 const v=(key:RewardLimitKey)=>limits.values[key].value,c=(key:RewardLimitKey)=>controlFor(limits.values[key].type);
 const pct=(key:RewardLimitKey)=>(v(key)??0)/100;
 if(uploaded)return[
  make('ARCH-01','individual','notification'),make('UPL-01','individual','hard'),make('UPL-02','eligibility','soft',{cutoff:p.joinedBefore,from:p.blockedFrom,to:p.blockedTo}),make('SAL-02','individual',c('increase.withoutPromotion'),{limit:pct('increase.withoutPromotion')}),make('SAL-03','individual',c('increase.withPromotion'),{limit:pct('increase.withPromotion')}),make('BUD-03','bonus',c('bonus.individualCeiling'),{months:(v('bonus.individualCeiling')??0)/10000}),make('ACC-02','access','rule'),make('ACC-01','access','rule'),make('ACC-05','access','hard'),
 ];
 const cap=v('lump.cap');
 return[
 make('POOL-01','pools',c('pool.standard.merit'),{percent:pct('pool.standard.merit')}),make('PRO-01','pools',c('promotion.maxGrades'),{percent:pct('promotion.increment'),grades:v('promotion.maxGrades')??0,maximum:v('promotion.maxGrade')??0,pool:pct('pool.standard.promotion')}),make('PRO-02','pools','soft'),
 make('POOL-04','pools',c('pool.standard.special'),{percent:pct('pool.standard.special'),cr:(v('catchUp.crFloor')??0)/10000}),make('POOL-03','pools','hard'),make('POOL-10','pools',c('pool.h.merit'),{merit:pct('pool.h.merit'),promotion:pct('pool.h.promotion'),special:pct('pool.h.special')}),make('POOL-09','pools','rule'),make('SNR-01','pools','rule'),
 make('ARCH-01','individual','notification'),make('SAL-02','individual',c('increase.withoutPromotion'),{limit:pct('increase.withoutPromotion')}),make('SAL-03','individual',c('increase.withPromotion'),{limit:pct('increase.withPromotion')}),make('SAL-01','individual','hard'),make('SAL-04','individual','notification'),
 make('BUD-01','bonus',c('bonus.poolCap'),{cap:pct('bonus.poolCap'),minimum:pct('bonus.underUse'),targetMonths:p.targetMonthsBp/10000}),make('BUD-02','bonus',c('bonus.individualMultiplier')),make('BUD-03','bonus',c('bonus.individualCeiling'),{months:(v('bonus.individualCeiling')??0)/10000}),make('BUD-05','bonus',c('lump.individualAmendment'),{share:pct('lump.share'),step:(v('lump.step')??0)/100,cap:cap===null?'—':cap/100}),make('MTX-04','bonus','rule',{type:p.bonusStructure}),
 make('ELIG-03','eligibility','rule',{joinedBefore:p.joinedBefore,confirmedBy:p.confirmedBy,activeAsOf:p.activeAsOf??p.confirmedBy}),make('ELIG-04','eligibility','rule',{from:p.blockedFrom,to:p.blockedTo}),make('ELIG-05','eligibility','rule',{rating:p.minimumBonusRating??'BE',excludeNotice:p.excludeNotice!==false?'yes':'no',excludeEr:p.excludeErCase!==false?'yes':'no'}),make('ELIG-02','eligibility','hard'),
 make('ACC-02','access','rule'),make('ACC-01','access','rule'),make('ACC-03','access','rule'),make('ACC-05','access','hard'),make('OC-01','access','hard',{from:p.blockedFrom,to:p.blockedTo}),
 ];
}
/** Native legacy flags link to their exact explanatory row without changing persisted audit codes. */
export function rewardRuleReference(flag:Pick<RewardFlag,'code'|'message'>,promotion=false):string{
 const aliases:Record<string,string>={'INC-01':'SAL-02','RANGE-01':'SAL-04','POOL-05':'POOL-01','DATA-03':'POOL-04','DATA-04':'MTX-04','PPCH-01':'MTX-04','BUD-07':'BUD-01','PAT-01':'BUD-01','PAT-STALE':'BUD-01','ACCESS-01':'ACC-01','PRO-03':'PRO-01'};
 if(flag.code==='INC-01')return promotion?'SAL-03':'SAL-02';
 if(flag.code==='CFG-01')return /bonus/i.test(flag.message)?'BUD-01':'POOL-03';return aliases[flag.code]??flag.code;
}
/** A rule as an end user sees it: what it does in plain language, without limit values, controls or references. */
export type ProjectedRewardRule={ref:string;category:AppliedRewardRule['category'];control:RuleControl|null;values:AppliedRewardRule['values'];plain:boolean};
/** Only public policy facts leave this projection; salary ranges and raw PAT never appear. Limit settings (values,
 * Block/Exception/Warning/Note controls and references) appear only for Limit Controls readers (`showLimits`). */
export function publicAppliedRules(p:RewardPolicy,uploaded=false,options:{limits?:RewardLimits;showLimits?:boolean}={}){
 const rules=appliedRewardRules(p,uploaded,options.limits??baselineRewardLimits(p));
 const hidden=options.showLimits===false;
 const shown:ProjectedRewardRule[]=rules.map(rule=>hidden?(rewardLimitRuleRefs as readonly string[]).includes(rule.ref)?{ref:rule.ref,category:rule.category,control:null,values:{},plain:true}:{ref:rule.ref,category:rule.category,control:null,values:rule.values,plain:false}:{...rule,plain:false});
 return{year:p.year,rules:shown,showLimits:!hidden,meritMatrix:structuredClone(p.meritMatrix),bonusMatrix:structuredClone(p.bonusMatrix),bonusStructure:p.bonusStructure,branchFactors:p.bonusStructure==='branch'?structuredClone(p.branchFactors):{},uploaded};
}
