/** AI v2 Phase 2, P2-4 — how a company's baseline minutes per item are resolved from what the event log measured and what
 * the administrator entered. Pure: no database, no clock.
 *
 * MEASURED FIRST. For an item the event log can measure (types.ts MEASURED_BY), when the baseline period holds at least
 * `minCompleted` completed cases and the administrator gave their minutes per staff action:
 *   minutes per item = staff actions in the period / cases started in the period x minutes per staff action.
 * Otherwise the administrator's own minutes for the item, if they gave any. An item with neither is left out of the
 * baseline, and the ledger counts its work as done without freeing any time. Never an industry average. */
import {CAPACITY_ITEMS,MEASURED_BY,type CapacityBaselineItem,type CapacityBaselineItems,type CapacityItem,type MeasuredProcess} from './types';

export type ProcessEvidence=Readonly<{cases:number;completed:number;staffActions:number}>;
export const MAX_ITEM_MINUTES=1440;
export const MAX_MINUTES_PER_STAFF_ACTION=240;

/** A whole or one-decimal number of minutes in [0,max], or null for blank or invalid input (never a default figure). */
export function parseMinutes(value:unknown,max:number):number|null{
 const text=typeof value==='string'?value.trim():'';
 if(!/^\d{1,4}(?:\.\d)?$/.test(text))return null;
 const n=Number(text);
 return n>=0&&n<=max?n:null;
}

const round1=(n:number)=>Math.round(n*10)/10;

export function resolveBaselineItems(input:Readonly<{
 entered:Readonly<Partial<Record<CapacityItem,number|null>>>;minutesPerStaffAction:number|null;
 evidence:Readonly<Partial<Record<MeasuredProcess,ProcessEvidence|null>>>;minCompleted:number;
}>):CapacityBaselineItems{
 const out:Partial<Record<CapacityItem,CapacityBaselineItem>>={};
 for(const item of CAPACITY_ITEMS){
  const process=MEASURED_BY[item];
  const measured=process?input.evidence[process]??null:null;
  if(process&&measured&&measured.completed>=input.minCompleted&&measured.cases>0&&input.minutesPerStaffAction!=null){
   const value:CapacityBaselineItem={minutes:round1(measured.staffActions/measured.cases*input.minutesPerStaffAction),basis:'event_log',process,
    cases:measured.cases,completed:measured.completed,staffActions:measured.staffActions};
   out[item]=Object.freeze(value);
   continue;
  }
  const entered=input.entered[item];
  if(entered!=null&&Number.isFinite(entered)&&entered>=0&&entered<=MAX_ITEM_MINUTES){const value:CapacityBaselineItem={minutes:entered,basis:'entered'};out[item]=Object.freeze(value);}
 }
 return Object.freeze(out);
}

/** Whether the event log can measure an item for this baseline period (enough completed cases). */
export const measurable=(evidence:ProcessEvidence|null|undefined,minCompleted:number)=>!!evidence&&evidence.completed>=minCompleted&&evidence.cases>0;
