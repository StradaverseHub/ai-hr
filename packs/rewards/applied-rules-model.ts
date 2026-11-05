import type {RewardPolicy,RewardFlag} from './model';
export type RuleControl='hard'|'soft'|'notification'|'rule';
export type AppliedRewardRule={ref:string;category:'pools'|'individual'|'bonus'|'eligibility'|'access';control:RuleControl;values:Record<string,string|number>};
/** Constants are explanations of the deterministic engine controls, never editable free text. */
export const rewardLimitRules={promotionBp:1000,maxPromotionGrades:3,maxGrade:23,catchUpCrBp:9000,nonPromotionWarningBp:1000,promotionWarningBp:3000,minimumUtilizationBp:8000,bonusCeilingMonthsBp:90000} as const;
export function appliedRewardRules(p:RewardPolicy,uploaded=false):AppliedRewardRule[]{
 const make=(ref:string,category:AppliedRewardRule['category'],control:RuleControl,values:AppliedRewardRule['values']={}):AppliedRewardRule=>({ref,category,control,values});
 if(uploaded)return[
  make('UPL-01','individual','hard'),make('UPL-02','eligibility','soft',{cutoff:p.joinedBefore,from:p.blockedFrom,to:p.blockedTo}),make('SAL-02','individual','soft',{limit:10}),make('SAL-03','individual','soft',{limit:30}),make('BUD-03','bonus','soft',{months:9}),make('ACC-02','access','rule'),make('ACC-01','access','rule'),make('ACC-05','access','hard'),
 ];
 return[
 make('POOL-01','pools','hard',{percent:p.standardPools[0]/100}),make('PRO-01','pools','hard',{percent:rewardLimitRules.promotionBp/100,grades:rewardLimitRules.maxPromotionGrades,maximum:rewardLimitRules.maxGrade,pool:p.standardPools[1]/100}),make('PRO-02','pools','soft'),
 make('POOL-04','pools','hard',{percent:p.standardPools[2]/100,cr:rewardLimitRules.catchUpCrBp/10000}),make('POOL-03','pools','hard'),make('POOL-10','pools','hard',{merit:p.hPools[0]/100,promotion:p.hPools[1]/100,special:p.hPools[2]/100}),make('POOL-09','pools','rule'),make('SNR-01','pools','rule'),
 make('SAL-02','individual','soft',{limit:rewardLimitRules.nonPromotionWarningBp/100}),make('SAL-03','individual','soft',{limit:rewardLimitRules.promotionWarningBp/100}),make('SAL-01','individual','hard'),make('SAL-04','individual','notification'),
 make('BUD-01','bonus','hard',{minimum:rewardLimitRules.minimumUtilizationBp/100,targetMonths:p.targetMonthsBp/10000}),make('BUD-02','bonus','soft'),make('BUD-03','bonus','soft',{months:rewardLimitRules.bonusCeilingMonthsBp/10000}),make('BUD-05','bonus','soft',{share:p.lumpShareBp/100,step:p.lumpStepCents/100,cap:p.lumpCapCents===null?'—':p.lumpCapCents/100}),make('MTX-04','bonus','rule',{type:p.bonusStructure}),
 make('ELIG-03','eligibility','rule',{joinedBefore:p.joinedBefore,confirmedBy:p.confirmedBy,activeAsOf:p.activeAsOf??p.confirmedBy}),make('ELIG-04','eligibility','rule',{from:p.blockedFrom,to:p.blockedTo}),make('ELIG-05','eligibility','rule',{rating:p.minimumBonusRating??'BE',excludeNotice:p.excludeNotice!==false?'yes':'no',excludeEr:p.excludeErCase!==false?'yes':'no'}),make('ELIG-02','eligibility','hard'),
 make('ACC-02','access','rule'),make('ACC-01','access','rule'),make('ACC-03','access','rule'),make('ACC-05','access','hard'),make('OC-01','access','hard',{from:p.blockedFrom,to:p.blockedTo}),
 ];
}
/** Native legacy flags link to their exact explanatory row without changing persisted audit codes. */
export function rewardRuleReference(flag:Pick<RewardFlag,'code'|'message'>):string{
 const aliases:Record<string,string>={'INC-01':'SAL-02','RANGE-01':'SAL-04','POOL-05':'POOL-01','DATA-03':'POOL-04','DATA-04':'MTX-04','PPCH-01':'MTX-04','BUD-07':'BUD-01','PAT-01':'BUD-01','PAT-STALE':'BUD-01','ACCESS-01':'ACC-01','PRO-03':'PRO-01'};
 if(flag.code==='CFG-01')return /bonus/i.test(flag.message)?'BUD-01':'POOL-03';return aliases[flag.code]??flag.code;
}
/** Only public policy facts leave this projection; salary ranges and raw PAT never appear. */
export function publicAppliedRules(p:RewardPolicy,uploaded=false){return{year:p.year,rules:appliedRewardRules(p,uploaded),meritMatrix:structuredClone(p.meritMatrix),bonusMatrix:structuredClone(p.bonusMatrix),bonusStructure:p.bonusStructure,branchFactors:p.bonusStructure==='branch'?structuredClone(p.branchFactors):{},uploaded};}
