import type {ProbationPersonnel,ProbationSettings} from '../core/probation';
/** Specific scopes win; later rules break an equal-specificity tie deterministically in the pinned version. */
export function effectiveProbationSettings(settings:ProbationSettings,facts:Pick<ProbationPersonnel,'businessGroupId'|'businessUnitId'|'grade'>,months:number|null):ProbationSettings{
 const result=structuredClone(settings);
 const matches=(settings.overrides??[]).map((rule,index)=>({rule,index,specificity:[rule.businessGroupId,rule.businessUnitId,rule.grade,rule.months].filter(Boolean).length})).filter(({rule})=>(!rule.businessGroupId||rule.businessGroupId===facts.businessGroupId)&&(!rule.businessUnitId||rule.businessUnitId===facts.businessUnitId)&&(!rule.grade||rule.grade===facts.grade)&&(rule.months===undefined||rule.months===months)).sort((a,b)=>b.specificity-a.specificity||b.index-a.index);
 if(matches[0])result.kpiGate=matches[0].rule.kpiGate;
 return result;
}
