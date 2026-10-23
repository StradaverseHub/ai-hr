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
