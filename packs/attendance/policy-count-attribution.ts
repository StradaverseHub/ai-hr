/** Count ownership after the canonical group duration finalizer. This never recalculates a
 * threshold, maximum or rounding rule, and never supplies physical work or approval authority. */
import {isDeepStrictEqual} from 'node:util';
import {subtractAttendancePolicyIntervals,unionAttendancePolicyIntervals} from '../../lib/attendance-policy-intervals';
import type {PolicyDurationProposal,PolicyRoundingCountAttribution} from './policy-duration';
export type PolicyCountAttribution=
 |{state:'unavailable';reason:'countPartitionUnavailable'}
 |{state:'known';physicalMinutes:number;roundedMinutes:number;minutes:number;
   parts:{sequence:number;calendarDate:string;dayClass:Extract<PolicyDurationProposal,{status:'calculated'}>['parts'][number]['dayClass'];
    physicalMinutes:number;roundedMinutes:number;minutes:number;roundingCountAttributions:PolicyRoundingCountAttribution[]}[]};
/** Only a freshly rederived duration proposal may establish this count contract. A rounded
 * remainder follows the SAME immutable formula allocation order as its physical counts. The
 * existing selected interval is an identity/rate/date anchor, never an extra worked interval. */
export function attendancePolicyCountAttribution(duration:PolicyDurationProposal):PolicyCountAttribution{
 const unavailable:PolicyCountAttribution={state:'unavailable',reason:'countPartitionUnavailable'};
 const integer=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=4320;
 try{
  if(duration.status!=='calculated'||duration.parts.length>3||duration.classes.length>5||!integer(duration.payableMinutes))return unavailable;
  const parts:Extract<PolicyCountAttribution,{state:'known'}>['parts']=duration.parts.map((part,sequence)=>{
   const physical=part.allocations.reduce((n,row)=>n+row.to-row.from,0);
   if(!integer(part.allocatedPayableMinutes)||physical!==part.allocatedPayableMinutes||physical>part.minutes
    ||subtractAttendancePolicyIntervals(part.allocations,part.intervals,4320).length)throw Error('Physical count mismatch');
   return {sequence,calendarDate:part.date,dayClass:part.dayClass,physicalMinutes:physical,roundedMinutes:0,
    minutes:physical,roundingCountAttributions:[]};
  });
  const intervals=duration.parts.flatMap(part=>part.allocations),physical=parts.reduce((n,part)=>n+part.physicalMinutes,0);
  if(unionAttendancePolicyIntervals(intervals,4320).reduce((n,row)=>n+row.to-row.from,0)!==physical)return unavailable;
  const seen=new Set<string>();let rounded=0,minutes=0;
  for(const row of duration.classes){
   if(seen.has(row.dayClass)||!integer(row.eligibleMinutes)||!integer(row.payableMinutes)||!integer(row.unplacedPayableMinutes))return unavailable;
   seen.add(row.dayClass);
   const indexes=parts.filter(part=>part.dayClass===row.dayClass),placed=indexes.reduce((n,part)=>n+part.physicalMinutes,0);
   if(!indexes.length||indexes.reduce((n,part)=>n+duration.parts[part.sequence].minutes,0)!==row.eligibleMinutes
    ||placed+row.unplacedPayableMinutes!==row.payableMinutes)return unavailable;
   const attribution=row.roundingCountAttribution;
   if(row.unplacedPayableMinutes===0){if(attribution!==undefined)return unavailable;}
   else{
    if(!attribution||attribution.kind!=='roundingCount'||attribution.minutes!==row.unplacedPayableMinutes
     ||!['earliest','latest'].includes(attribution.direction)||!row.steps.some(step=>step.kind==='rounding'&&step.after>step.before))return unavailable;
    const slots=indexes.flatMap(part=>duration.parts[part.sequence].allocations.map(interval=>({part,interval})))
     .sort((a,b)=>a.interval.from-b.interval.from||a.interval.to-b.interval.to);
    if(attribution.direction==='latest')slots.reverse();
    const anchor=slots[0];
    if(!anchor||attribution.partSequence!==anchor.part.sequence||attribution.calendarDate!==anchor.part.calendarDate
     ||attribution.dayClass!==row.dayClass||!isDeepStrictEqual(attribution.anchor,anchor.interval))return unavailable;
    anchor.part.roundedMinutes+=attribution.minutes;anchor.part.minutes+=attribution.minutes;
    anchor.part.roundingCountAttributions.push({...attribution,anchor:{...attribution.anchor}});rounded+=attribution.minutes;
   }
   minutes+=row.payableMinutes;
  }
  if(parts.some(part=>!seen.has(part.dayClass))||minutes!==duration.payableMinutes||physical+rounded!==minutes)return unavailable;
  return {state:'known',physicalMinutes:physical,roundedMinutes:rounded,minutes,parts};
 }catch{return unavailable;}
}

/** Read a count only AFTER the complete immutable part has matched canonical replay. This
 * structural adapter does not prove current source, approval, formula or financial authority. */
export function attendancePolicyStoredPartCount(part:{sequence:number;calendarDate:string;dayClass:string;
 allocatedPayableMinutes?:number|null;durationEvidence:unknown}):number|null{
 try{
  const physical=part.allocatedPayableMinutes;
  if(typeof physical!=='number'||!Number.isSafeInteger(physical)||physical<0||physical>4320)return null;
  const value=part.durationEvidence;
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const evidence=value as Record<string,unknown>;
  if(!Object.hasOwn(evidence,'roundingCountAttributions'))return Object.hasOwn(evidence,'attributedPayableMinutes')?null:physical;
  const rows=evidence.roundingCountAttributions;
  if(!Array.isArray(rows)||rows.length!==1||!Array.isArray(evidence.allocatedIntervals))return null;
  const row=rows[0] as PolicyRoundingCountAttribution;
  if(!row||row.kind!=='roundingCount'||!Number.isSafeInteger(row.minutes)||row.minutes<=0||row.minutes>4320
   ||row.partSequence!==part.sequence||row.calendarDate!==part.calendarDate||row.dayClass!==part.dayClass
   ||!['earliest','latest'].includes(row.direction)||!evidence.allocatedIntervals.some(interval=>isDeepStrictEqual(interval,row.anchor)))return null;
  const total=physical+row.minutes;
  return total<=4320&&evidence.attributedPayableMinutes===total?total:null;
 }catch{return null;}
}
