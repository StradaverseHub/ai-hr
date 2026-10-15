/** Deterministic allocation from original holidays and the raw dated schedule. No effective-holiday recursion. */
export type ReplacementDayKind='full'|'half'|'off'|'rest'|'unknown';
export type ReplacementPolicy={id:string;effectiveFrom:string;regime:'MY_EA_60D'|'MY_SABAH_103'|'company_confirmed';confirmed:boolean;restMode:'scheduled_rest'|'last_weekly_rest';halfEligible:boolean;searchDays:number};
export type OriginalHoliday={id:string;date:string;name:string;holidayType:string;tentative:boolean;active:boolean};
export type ReplacementDecision={source:OriginalHoliday;policyId:string|null;status:'allocated'|'review'|'not_required';date:string|null;reason:string};
export const addHolidayDays=(date:string,n:number)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function policyOn(policies:readonly ReplacementPolicy[],date:string){return policies.filter(p=>p.effectiveFrom<=date).reduce<ReplacementPolicy|null>((a,b)=>!a||b.effectiveFrom>a.effectiveFrom?b:a,null);}
export function replacementPolicyMatches(regime:ReplacementPolicy['regime'],country:string,state:string|null,knownState=false):boolean {
 if(regime==='company_confirmed')return true;
 if(country!=='MY'||!state||!knownState)return false;
 const value=state.trim().toUpperCase();
 const sabah=['SABAH','SBH','MY-12','12'].includes(value),sarawak=['SARAWAK','SWK','MY-13','13'].includes(value);
 return regime==='MY_SABAH_103'?sabah:!sabah&&!sarawak;
}
export function allocateReplacementHolidays(p:{sources:readonly OriginalHoliday[];policies:readonly ReplacementPolicy[];days:ReadonlyMap<string,ReplacementDayKind>;reserved:ReadonlySet<string>;existingDates?:ReadonlyMap<string,string>;retained?:ReadonlyMap<string,string>;companyCountry:string;state:string|null;knownState:boolean;employmentFrom:string;employmentTo:string|null}):ReplacementDecision[]{
 const originals=new Set(p.sources.map(h=>h.date)),occupied=new Set(p.reserved),out:ReplacementDecision[]=[];
 for(const source of [...p.sources].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id))){
  if(source.holidayType!=='public'||source.date<p.employmentFrom||p.employmentTo&&source.date>p.employmentTo)continue;
  const policy=policyOn(p.policies,source.date),kind=p.days.get(source.date)??'unknown';
  const emit=(status:ReplacementDecision['status'],date:string|null,reason:string)=>out.push({source,policyId:policy?.id??null,status,date,reason});
  const retained=p.retained?.get(source.id);if(retained){occupied.add(retained);emit('allocated',retained,'manual_retained');continue;}
  if(kind==='full'||kind==='half'){emit('not_required',null,'original_working_day');continue;}
  if(kind==='off'){emit('not_required',null,'original_off_day');continue;}
  if(kind==='unknown'){emit('review',null,'unknown_schedule');continue;}
  if(!policy||!policy.confirmed){emit('review',null,'policy_unconfirmed');continue;}
  if(!replacementPolicyMatches(policy.regime,p.companyCountry,p.state,p.knownState)){emit('review',null,'jurisdiction_unclear');continue;}
  if(!source.active||source.tentative){emit('review',null,'source_unconfirmed');continue;}
  if(policy.restMode==='last_weekly_rest'){
   const dow=new Date(source.date+'T00:00:00Z').getUTCDay()||7;
   let laterRest=false,unknown=false;
   for(let n=1;n<=7-dow;n++){const next=p.days.get(addHolidayDays(source.date,n));if(next==='rest')laterRest=true;if(!next||next==='unknown')unknown=true;}
   if(unknown){emit('review',null,'unknown_weekly_rest');continue;}
   if(laterRest){emit('not_required',null,'not_designated_weekly_rest');continue;}
  }
  let chosen:string|null=null,unknown=false;
  for(let n=1;n<=policy.searchDays;n++){
   const date=addHolidayDays(source.date,n);
   if(p.employmentTo&&date>p.employmentTo)break;
   const candidate=p.days.get(date)??'unknown';
   if(candidate==='unknown'){unknown=true;break;}
   if(originals.has(date)||occupied.has(date)&&p.existingDates?.get(source.id)!==date)continue;
   if(candidate==='full'||candidate==='half'&&policy.halfEligible){chosen=date;break;}
  }
  if(chosen){occupied.add(chosen);emit('allocated',chosen,'public_holiday_on_rest');}
  else emit('review',null,unknown?'unknown_schedule':'search_exhausted');
 }
 return out;
}
