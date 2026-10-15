import { pmBands,potentialBands,potentialReferenceCurve,referenceCurve,type PMBand,type Policy,type PotentialBand } from './model';
import { curveGaps,curveTolerance } from './journey-model';
import { sourceRound } from './source-numeric';
export type CalibrationCurvePolicy=Pick<Policy,'curveToleranceMode'|'curveTolerancePeople'|'curveTolerancePct'>;
export type ProfitAchievement={companyId:string;achievementPct:number|null;revision:number};
/** A unit's own figure takes precedence over its BG's consolidated figure. Absence means normal, not zero. */
export function profitCurveFor(companyId:string,businessGroupId:string|null,figures:ProfitAchievement[]){
 const own=figures.find(f=>f.companyId===companyId&&f.achievementPct!=null),group=businessGroupId?figures.find(f=>f.companyId===businessGroupId&&f.achievementPct!=null):undefined;
 const figure=own??group,pct=figure?.achievementPct??null;
 return {key:pct!=null&&pct<70?'negative' as const:pct!=null&&pct>130?'positive' as const:'normal' as const,reference:referenceCurve(pct??100),achievementPct:pct,entered:!!figure,source:own?'company' as const:group?'bg' as const:null,companyId:figure?.companyId??null,revision:figure?.revision??null};
}
/** Active source curve pop-outs use five PM bands / three potential bands, including provisional box placements. */
export function calibrationDistribution(rows:{performance:PMBand|null;potential:PotentialBand|null}[],axis:'performance'|'potential',policy:CalibrationCurvePolicy,performanceReference:Record<PMBand,number>|null){
 const order:readonly string[]=axis==='performance'?pmBands:potentialBands,target:Record<string,number>|null=axis==='performance'?performanceReference:potentialReferenceCurve;
 const counts=Object.fromEntries(order.map(band=>[band,rows.filter(row=>row[axis]===band).length])),total=Object.values(counts).reduce((sum,count)=>sum+count,0),tolerance=curveTolerance(policy,total);
 const gaps=target?curveGaps(order,counts,target):null;
 return {total,tolerance,rows:order.map(band=>({band,count:counts[band],actualPct:total?Math.round(counts[band]/total*100):0,targetPct:target?.[band]??null,targetCount:target?sourceRound(target[band]/100*total):null,gap:gaps?.[band]??null,breach:gaps?Math.abs(gaps[band])>tolerance:false}))};
}
/** Source _pat_text / tbPat rounding is for display only; curve selection always uses the original figure. */
export function profitAchievementText(pct:number|null):string{
 if(pct==null)return '';
 const rounded=Math.abs(pct)>=10||Number.isInteger(pct)?Math.floor(pct+.5):Math.floor(pct*10+.5)/10;
 return `${Object.is(rounded,-0)?0:rounded}%`;
}
