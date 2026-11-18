/** c03670cc — client-safe contract for the Schedule Group clock settings scope.
 *
 * A clock revision applies either to ALL companies (company_id NULL, group administrators only, and it
 * also covers companies created later) or to one company. On a date, a company's own revision wins;
 * otherwise the group-wide one applies; otherwise legacy clock behaviour. This module decides what the
 * Attendance tab shows on reopen and what a submitted form means. It never writes or dates anything:
 * core/attendance-clock-policy.ts owns storage, ordinals and effective dates. */
import {ATTENDANCE_CLOCK_DAY_TYPES,validateAttendanceClockPolicy,type AttendanceClockPolicy} from './attendance-clock-policy';

export type ClockHistoryRow = {ordinal:number;effectiveFrom:string;policy:AttendanceClockPolicy};
export type ClockScopeCompany = {id:string;name:string;history:ClockHistoryRow[]};
export type ClockScope = {kind:'all'}|{kind:'companies';companyIds:string[]};
/** The token key for the group-wide chain. Company chains use the company id. */
export const GROUP_CLOCK_SCOPE_KEY = 'group';

/** What an untouched form shows when nothing was ever saved: today's legacy defaults. */
export const DEFAULT_ATTENDANCE_CLOCK_POLICY: AttendanceClockPolicy = {
  pairing:{normal:'auto',rest:'auto',off:'auto',publicHoliday:'auto'},minimumIntervalMinutes:0,
};

export function sameClockPolicy(a:AttendanceClockPolicy,b:AttendanceClockPolicy):boolean {
  return a.minimumIntervalMinutes===b.minimumIntervalMinutes
    && ATTENDANCE_CLOCK_DAY_TYPES.every(day=>a.pairing[day]===b.pairing[day]);
}

export function sameClockScope(a:ClockScope,b:ClockScope):boolean {
  if(a.kind!==b.kind)return false;
  if(a.kind==='all')return true;
  const left=[...a.companyIds].sort(),right=[...(b as {companyIds:string[]}).companyIds].sort();
  return left.length===right.length&&left.every((id,index)=>id===right[index]);
}

export type ClockScopeDisplay = {
  scope:ClockScope;
  policy:AttendanceClockPolicy;
  /** Companies that keep their own, different saved settings and are not part of this selection. */
  differing:{id:string;name:string}[];
  /** Expected latest ordinal per chain (group + each company), for optimistic concurrency on save. */
  token:Record<string,number>;
};

/**
 * What the Attendance tab shows on reopen.
 *
 * Group administrator: All Companies when the latest save was group-wide (or nothing was saved);
 * otherwise the companies sharing the most recent company save. Company administrator: always specific
 * companies — those whose settings currently equal the shown values (a company following the
 * group-wide setting counts as sharing it). Either way, companies with their own different settings are
 * listed so the reader knows they are not covered by what is shown.
 */
export function scheduleClockDisplay(p:{group:readonly ClockHistoryRow[];companies:readonly ClockScopeCompany[];canUseAll:boolean}):ClockScopeDisplay {
  const group=p.group.at(-1)??null;
  const own=p.companies.map(company=>({company,latest:company.history.at(-1)??null}));
  const newestCompany=own.filter(row=>row.latest).reduce<typeof own[number]|null>(
    (best,row)=>!best||row.latest!.effectiveFrom>best.latest!.effectiveFrom?row:best,null);
  const companyIsNewer=!!newestCompany&&(!group||newestCompany.latest!.effectiveFrom>group.effectiveFrom);
  const policy=companyIsNewer?newestCompany!.latest!.policy:group?.policy??DEFAULT_ATTENDANCE_CLOCK_POLICY;
  const token:Record<string,number>={[GROUP_CLOCK_SCOPE_KEY]:group?.ordinal??0};
  for(const row of own)token[row.company.id]=row.latest?.ordinal??0;
  const differs=(row:typeof own[number])=>!!row.latest&&!sameClockPolicy(row.latest.policy,policy);
  if(p.canUseAll&&!companyIsNewer) {
    return {scope:{kind:'all'},policy,token,differing:own.filter(differs).map(row=>({id:row.company.id,name:row.company.name}))};
  }
  const shares=(row:typeof own[number])=>row.latest
    ? sameClockPolicy(row.latest.policy,policy)
    : !companyIsNewer||(!!group&&sameClockPolicy(group.policy,policy));
  const selected=own.filter(shares);
  return {
    scope:{kind:'companies',companyIds:selected.map(row=>row.company.id)},
    policy,token,
    differing:own.filter(row=>!selected.includes(row)&&differs(row)).map(row=>({id:row.company.id,name:row.company.name})),
  };
}

/** The scope a form posted. Companies are deduplicated; "All" is only ever an explicit choice. */
export function readClockScope(kind:unknown,companyIds:readonly unknown[]):ClockScope {
  if(kind==='all')return {kind:'all'};
  if(kind!=='companies')throw new Error('Choose All Companies or at least one company for the clock settings.');
  const ids=[...new Set(companyIds.map(String).map(id=>id.trim().toLowerCase()).filter(Boolean))];
  if(!ids.length)throw new Error('Choose All Companies or at least one company for the clock settings.');
  return {kind:'companies',companyIds:ids};
}

/** The form's baseline (what it showed). An untouched form writes nothing. */
export function readClockBaseline(raw:unknown):{scope:ClockScope;policy:AttendanceClockPolicy}|null {
  if(typeof raw!=='string'||!raw||raw.length>20_000)return null;
  try {
    const value=JSON.parse(raw) as {scope?:{kind?:unknown;companyIds?:unknown};policy?:unknown};
    const scope=value.scope;
    const ids:unknown[]=scope&&Array.isArray(scope.companyIds)?scope.companyIds:[];
    return {scope:readClockScope(scope?.kind,ids),policy:validateAttendanceClockPolicy(value.policy)};
  } catch { return null; }
}

/** Expected latest ordinals, keyed by GROUP_CLOCK_SCOPE_KEY or company id. */
export function readClockToken(raw:unknown):Record<string,number> {
  const fail=()=>{throw new Error('Clock settings changed. Reload this Schedule Group before saving.');};
  if(typeof raw!=='string'||raw.length>20_000)fail();
  let value:unknown;
  try{value=JSON.parse(raw as string);}catch{fail();}
  if(!value||typeof value!=='object'||Array.isArray(value))fail();
  const out:Record<string,number>={};
  for(const [key,ordinal] of Object.entries(value as Record<string,unknown>)){
    if(!Number.isSafeInteger(ordinal)||(ordinal as number)<0||(ordinal as number)>=2147483647)fail();
    out[key.toLowerCase()]=ordinal as number;
  }
  return out;
}

/** ISO date + one calendar day, by date arithmetic only (no time zone). */
export function nextIsoDate(date:string):string {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid date.');
  return new Date(Date.parse(date+'T00:00:00Z')+86_400_000).toISOString().slice(0,10);
}
