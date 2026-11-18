import { completeScoring,draftScoringSchema,type Scoring } from './model';
import type { KpiLibraryTemplate } from './import-model';
import { sourceFigure } from './source-numeric';
export type NumberSource='history'|'spread'|'library'|'manual'|'ai';
export function spreadScoring(scoring:Scoring,spread:KpiLibraryTemplate['spread']|undefined,base:number):Scoring{
 const target=sourceFigure(base,2);
 if(scoring.mechanism==='A')return draftScoringSchema.parse({...scoring,target,...(spread?.rate?{rates:spread.rate.map(pct=>sourceFigure(base*pct/100,2))}:{})});
 const shaped=spread&&(spread.threshold!=null||spread.excellence!=null);
 return draftScoringSchema.parse({...scoring,target,...(shaped?{threshold:spread.threshold!=null?sourceFigure(base*spread.threshold/100,2):null,...(scoring.variant==='excellence'?{excellence:spread.excellence!=null?sourceFigure(base*spread.excellence/100,2):null}:{})}:{})});
}
/** Source pm_default_numbers: prior TARGET numbers, then administrator spread, then absolute library values. */
export function defaultLibraryScoring(template:KpiLibraryTemplate,previous?:Scoring):{scoring:Scoring;numberSource:NumberSource}{
 const current=template.scoring;
 if(previous){
  const scoring=current.mechanism==='A'?{...current,target:previous.target??null,rates:previous.mechanism==='A'?previous.rates:[null,null,null,null,null]}:{...current,threshold:previous.mechanism==='B'?previous.threshold:null,target:previous.target??null,multiple:previous.mechanism==='B'?previous.multiple:null,excellence:previous.mechanism==='B'?previous.excellence:null};
  return {scoring:draftScoringSchema.parse(scoring),numberSource:'history'};
 }
 const spread=template.spread,base=current.target??(current.mechanism==='A'?current.rates[2]:null);
 if(base!=null&&spread&&(current.mechanism==='A'?!!spread.rate:spread.threshold!=null||current.variant==='excellence'&&spread.excellence!=null))return {scoring:spreadScoring(current,spread,base),numberSource:'spread'};
 return {scoring:draftScoringSchema.parse({...current,...(current.mechanism==='A'?{target:current.target??null}:{})}),numberSource:'library'};
}
export type KpiLibraryChoice=KpiLibraryTemplate&{id:string;revision:number;defaultScoring?:Scoring;numberSource?:NumberSource};

export function settingNumbersComplete(scoring:Scoring){try{completeScoring(scoring);return true;}catch{return false;}}

export function settingNumberSource(scoring:Scoring,choice:KpiLibraryChoice|undefined,previous?:{scoring:Scoring;numberSource?:NumberSource}):NumberSource{
 const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 if(previous&&same(previous.scoring,scoring))return previous.numberSource??'manual';
 if(choice&&same(choice.defaultScoring,scoring))return choice.numberSource??'library';
 const spread=choice?.spread,shaped=spread&&(scoring.mechanism==='A'?spread.rate:spread.threshold!=null||spread.excellence!=null);
 if(choice&&shaped&&scoring.target!=null&&scoring.target>0)try{if(same(spreadScoring(choice.scoring,spread,scoring.target),scoring))return 'spread';}catch{}
 return 'manual';
}
