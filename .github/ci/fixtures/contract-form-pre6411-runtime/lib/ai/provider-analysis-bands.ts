/** One deterministic owner for analysis change bands. Boundaries are disjoint; no LLM calculation.
 * Native owners supply already-calculated percentages or exact difference/baseline ratios. This
 * classifier never adds, subtracts or calculates pay. Ratios and counts stay private; only bands leave. */
import {AiGatewayError} from './types';
export const PROVIDER_ANALYSIS_CHANGE_BANDS=Object.freeze(['decrease_over_25_percent','decrease_10_to_25_percent','decrease_5_to_10_percent','decrease_up_to_5_percent','unchanged','increase_up_to_5_percent','increase_5_to_10_percent','increase_10_to_25_percent','increase_over_25_percent'] as const);
export type AnalysisChangeBand=typeof PROVIDER_ANALYSIS_CHANGE_BANDS[number];
export const ANALYSIS_CHANGE_INTERVALS=Object.freeze([
 {band:'decrease_over_25_percent',lower:null,upper:-25,lowerInclusive:false,upperInclusive:false},
 {band:'decrease_10_to_25_percent',lower:-25,upper:-10,lowerInclusive:true,upperInclusive:false},
 {band:'decrease_5_to_10_percent',lower:-10,upper:-5,lowerInclusive:true,upperInclusive:false},
 {band:'decrease_up_to_5_percent',lower:-5,upper:0,lowerInclusive:true,upperInclusive:false},
 {band:'unchanged',lower:0,upper:0,lowerInclusive:true,upperInclusive:true},
 {band:'increase_up_to_5_percent',lower:0,upper:5,lowerInclusive:false,upperInclusive:true},
 {band:'increase_5_to_10_percent',lower:5,upper:10,lowerInclusive:false,upperInclusive:true},
 {band:'increase_10_to_25_percent',lower:10,upper:25,lowerInclusive:false,upperInclusive:true},
 {band:'increase_over_25_percent',lower:25,upper:null,lowerInclusive:false,upperInclusive:false},
].map(row=>Object.freeze(row)));
function ratioBand(numerator:bigint,denominator:bigint):AnalysisChangeBand{
 if(denominator<=BigInt('0'))throw new AiGatewayError('The analysis change could not be confirmed.');
 if(numerator===BigInt('0'))return 'unchanged';const magnitude=numerator<BigInt('0')?-numerator:numerator;
 const step=magnitude<=BigInt('5')*denominator?0:magnitude<=BigInt('10')*denominator?1:magnitude<=BigInt('25')*denominator?2:3;
 return numerator<BigInt('0')?(['decrease_up_to_5_percent','decrease_5_to_10_percent','decrease_10_to_25_percent','decrease_over_25_percent'] as const)[step]:(['increase_up_to_5_percent','increase_5_to_10_percent','increase_10_to_25_percent','increase_over_25_percent'] as const)[step];
}
export function analysisPercentageBand(value:string):AnalysisChangeBand{
 if(typeof value!=='string'||!/^[-]?\d{1,24}(?:\.\d{1,6})?$/.test(value))throw new AiGatewayError('The native analysis percentage could not be confirmed.');
 const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.'),scale=BigInt('10')**BigInt(fraction.length);
 const numerator=BigInt(whole)*scale+BigInt(fraction||'0');return ratioBand(negative?-numerator:numerator,scale);
}
export function analysisCountChangeBand(previous:number,current:number):AnalysisChangeBand{
 if(!Number.isSafeInteger(previous)||previous<=0||!Number.isSafeInteger(current)||current<0)throw new AiGatewayError('The native analysis counts could not be confirmed.');
 return ratioBand((BigInt(current)-BigInt(previous))*BigInt('100'),BigInt(previous));
}

/** The numerator is an ALREADY computed native difference, denominator its native positive baseline.
 * Dimensionless ratio classification only: no amount arithmetic or payroll recomputation. */
export function analysisNativeRatioBand(numerator:bigint,denominator:bigint):AnalysisChangeBand{
 if(typeof numerator!=='bigint'||typeof denominator!=='bigint')throw new AiGatewayError('The native analysis ratio could not be confirmed.');
 return ratioBand(numerator*BigInt('100'),denominator);
}
