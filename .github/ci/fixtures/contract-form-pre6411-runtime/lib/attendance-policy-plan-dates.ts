/** Date scope for Payroll protection only. Minute coordinates describe approved-plan
 * quantities, never physical work, captures, payable authority or a money calculation. */
import {overtimeDate} from './overtime-pattern-schema';
export function attendancePolicyPlanDates(sourceDate:string,windows:readonly {from:number;to:number}[]):string[]{
 overtimeDate(sourceDate,'sourceDate');
 if(windows.length>501)throw Error('The planned date scope exceeds its bounded request set.');
 const offsets=new Set<number>([0]);
 for(const span of windows){
  if(!Number.isSafeInteger(span.from)||!Number.isSafeInteger(span.to)||span.from<0||span.from>=1440
   ||span.to<=span.from||span.to>2880)throw Error('The planned date scope is unavailable.');
  for(let day=Math.floor(span.from/1440);day<=Math.floor((span.to-1)/1440);day++)offsets.add(day);
 }
 const base=Date.parse(sourceDate+'T00:00:00Z');
 return [...offsets].sort((a,b)=>a-b).map(day=>new Date(base+day*86400000).toISOString().slice(0,10));
}
