/** Fictional workload dates. The caller supplies today through the native HR date owner. */
import assert from 'node:assert/strict';
export const MAX_IMPORT_LOOKBACK_DAYS=90;
/** @param {string} today */
export function performanceFixtureCalendar(today){
 assert(/^\d{4}-\d{2}-\d{2}$/.test(today));
 const now=new Date(today+'T12:00:00Z');assert(now.toISOString().startsWith(today));
 // The five-minute workload cannot exceed75 iterations: three navigation pauses plus
 // the end-of-iteration pause, each at least1s. Keep every import offset2..90 open.
 const earliest=new Date(now.getTime()-MAX_IMPORT_LOOKBACK_DAYS*86400000);
 const historicalMonth=new Date(Date.UTC(earliest.getUTCFullYear(),earliest.getUTCMonth()-1,1)).toISOString().slice(0,7);
 const publicationMonth=new Date(Date.UTC(earliest.getUTCFullYear(),earliest.getUTCMonth()-2,1)).toISOString().slice(0,7);
 /** @param {number} offset */
 const importDate=offset=>{
  assert(Number.isInteger(offset)&&offset>=1&&offset<=MAX_IMPORT_LOOKBACK_DAYS,'clocking fixture lookback exceeded the planned workload');
  const date=new Date(now.getTime()-offset*86400000).toISOString().slice(0,10);
  assert(date.slice(0,7)>historicalMonth,'clocking fixture overlaps retained closed payroll');return date;
 };
 return {historicalMonth,publicationMonth,importDate};
}
/** @param {Array<{index:number,tenant:number,company:number}>} users @param {number} tenant @param {number} company @param {string} date */
export function clockingFixtureText(users,tenant,company,date){
 const [year,month,day]=date.split('-');
 return users.filter(actor=>actor.tenant===tenant&&actor.company===company).flatMap(actor=>[['08','31','IN'],['16','31','OUT']].map(parts=>['PERF'+String(actor.index).padStart(4,'0'),day,month,year,...parts].join(','))).join('\n');
}
