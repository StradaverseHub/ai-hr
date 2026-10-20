/** Deterministic allocation from original holidays and the raw dated schedule. No effective-holiday recursion. */
export type ReplacementDayKind='full'|'half'|'off'|'rest'|'unknown';
export type ReplacementPolicy={id:string;companyId?:string;effectiveFrom:string;regime:'MY_EA_60D'|'MY_SABAH_103'|'company_confirmed';confirmed:boolean;restMode:'scheduled_rest'|'last_weekly_rest';halfEligible:boolean;searchDays:number};
export type OriginalHoliday={id:string;companyId?:string;date:string;name:string;holidayType:string;tentative:boolean;active:boolean};
export type ReplacementDecision={source:OriginalHoliday;policyId:string|null;status:'allocated'|'review'|'not_required';date:string|null;reason:string};
export const addHolidayDays=(date:string,n:number)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function policyOn(policies:readonly ReplacementPolicy[],date:string,companyId?:string){return policies.filter(p=>p.effectiveFrom<=date&&(!companyId||p.companyId===companyId)).reduce<ReplacementPolicy|null>((a,b)=>!a||b.effectiveFrom>a.effectiveFrom?b:a,null);}
export function replacementPolicyMatches(regime:ReplacementPolicy['regime'],country:string,state:string|null,knownState=false):boolean {
 if(regime==='company_confirmed')return true;
 if(country!=='MY'||!state||!knownState)return false;
 const value=state.trim().toUpperCase();
 const sabah=['SABAH','SBH','MY-12','12'].includes(value),sarawak=['SARAWAK','SWK','MY-13','13'].includes(value);
 return regime==='MY_SABAH_103'?sabah:!sabah&&!sarawak;
}
export function allocateReplacementHolidays(p:{sources:readonly OriginalHoliday[];policies:readonly ReplacementPolicy[];days:ReadonlyMap<string,ReplacementDayKind>;reserved:ReadonlySet<string>;existingDates?:ReadonlyMap<string,string>;retained?:ReadonlyMap<string,string|null>;companyCountry:string;state:string|null;knownState:boolean;companyContexts?:ReadonlyMap<string,{country:string;state:string|null;knownState:boolean}>;sourceContexts?:ReadonlyMap<string,{country:string;state:string|null;knownState:boolean}>;companyCoverage?:ReadonlyMap<string,{companyId:string|null;reason:string|null}>;scheduleUnknownReasons?:ReadonlyMap<string,string>;employmentFrom:string;employmentTo:string|null}):ReplacementDecision[]{
 const originals=new Set(p.sources.map(h=>h.date)),occupied=new Set(p.reserved),assigned=new Set<string>(),out:ReplacementDecision[]=[];
 const publicSourcesByDate=new Map<string,Set<string>>();
 for(const source of p.sources)if(source.holidayType==='public'){const ids=publicSourcesByDate.get(source.date)??new Set<string>();ids.add(source.id);publicSourcesByDate.set(source.date,ids);}
 for(const source of [...p.sources].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id))){
  if(source.holidayType!=='public'||source.date<p.employmentFrom||p.employmentTo&&source.date>p.employmentTo)continue;
  const policy=policyOn(p.policies,source.date,source.companyId),kind=p.days.get(source.date)??'unknown';
  const context=p.sourceContexts?.get(source.id)??(source.companyId?p.companyContexts?.get(source.companyId):null);
  const emit=(status:ReplacementDecision['status'],date:string|null,reason:string)=>out.push({source,policyId:policy?.id??null,status,date,reason});
  if(p.retained?.has(source.id)){const retained=p.retained.get(source.id)??null;if(retained){occupied.add(retained);assigned.add(retained);}emit(retained?'allocated':'not_required',retained,retained?'manual_retained':'manual_waived');continue;}
  if(kind==='full'||kind==='half'){emit('not_required',null,'original_working_day');continue;}
  if(kind==='off'){emit('not_required',null,'original_off_day');continue;}
  if(kind==='unknown'){emit('review',null,p.scheduleUnknownReasons?.get(source.date)??'unknown_schedule');continue;}
  if(p.companyCoverage){const coverage=p.companyCoverage.get(source.date);if(!coverage||coverage.reason||coverage.companyId!==source.companyId){emit('review',null,'company_coverage_unknown');continue;}}
  if(!policy||!policy.confirmed){emit('review',null,'policy_unconfirmed');continue;}
  if(!replacementPolicyMatches(policy.regime,context?.country??p.companyCountry,context?.state??p.state,context?.knownState??p.knownState)){emit('review',null,'jurisdiction_unclear');continue;}
  if(!source.active||source.tentative){emit('review',null,'source_unconfirmed');continue;}
  // Distinct gazette rows on one date can describe one occasion or several entitlements. The policy
  // does not settle that identity, so do not silently issue two replacement days or collapse originals.
  if((publicSourcesByDate.get(source.date)?.size??0)>1){emit('review',null,'source_collision_unclear');continue;}
  if(policy.restMode==='last_weekly_rest'){
   const dow=new Date(source.date+'T00:00:00Z').getUTCDay()||7;
   let laterRest=false,unknown=false;
   for(let n=1;n<=7-dow;n++){const next=p.days.get(addHolidayDays(source.date,n));if(next==='rest')laterRest=true;if(!next||next==='unknown')unknown=true;}
   if(unknown){emit('review',null,'unknown_weekly_rest');continue;}
   if(laterRest){emit('not_required',null,'not_designated_weekly_rest');continue;}
  }
  let chosen:string|null=null,unknown=false,coverageUnknown=false,unknownReason='unknown_schedule';
  for(let n=1;n<=policy.searchDays;n++){
   const date=addHolidayDays(source.date,n);
   if(p.employmentTo&&date>p.employmentTo)break;
   if(p.companyCoverage){const coverage=p.companyCoverage.get(date);if(!coverage||coverage.reason||coverage.companyId!==source.companyId){unknown=true;coverageUnknown=true;break;}}
   const candidate=p.days.get(date)??'unknown';
   if(candidate==='unknown'){unknown=true;unknownReason=p.scheduleUnknownReasons?.get(date)??'unknown_schedule';break;}
   // An owner can retain its protected old date, but cannot reclaim that date after an earlier
   // source has selected it in this pass. Old projections may move together after a schedule change.
   if(originals.has(date)||assigned.has(date)||occupied.has(date)&&p.existingDates?.get(source.id)!==date)continue;
   if(candidate==='full'||candidate==='half'&&policy.halfEligible){chosen=date;break;}
  }
  if(chosen){occupied.add(chosen);assigned.add(chosen);emit('allocated',chosen,'public_holiday_on_rest');}
  else emit('review',null,coverageUnknown?'company_coverage_unknown':unknown?unknownReason:'search_exhausted');
 }
 return out;
}
