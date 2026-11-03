/** Today (AI v2 Phase 1, W3): "Coming up" for a person, from two existing owners.
 *
 * Who manages the person comes from the reporting line (core/read.ts reportingLinesFor). Who is away comes
 * from the Home team calendar (core/employee-home-sharing.ts readHomeTeamCalendar), which already applies the
 * company's sharing policy and never carries a leave type or reason. A manager is shown away only on the days
 * that calendar lists them, under the name that calendar shows, so Today reveals nothing the person's own
 * Home calendar would not. Pure. */
export type CalendarDay=Readonly<{date:string;available:boolean;items:readonly Readonly<{employmentId:string;name:string}>[]}>;
export type AwayRange=Readonly<{employmentId:string;name:string;from:string;to:string}>;

const next=(iso:string)=>new Date(Date.parse(`${iso}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);

/** Each manager's absences as runs of consecutive calendar days, in date order. */
export function managerAbsences(managerEmploymentIds:readonly string[],days:readonly CalendarDay[]):AwayRange[]{
 const wanted=new Set(managerEmploymentIds);
 const out:AwayRange[]=[];
 const open=new Map<string,{employmentId:string;name:string;from:string;to:string}>();
 for(const day of [...days].sort((a,b)=>a.date.localeCompare(b.date))){
  const here=new Set<string>();
  if(day.available)for(const item of day.items){
   if(!wanted.has(item.employmentId))continue;
   here.add(item.employmentId);
   const run=open.get(item.employmentId);
   if(run&&next(run.to)===day.date)run.to=day.date;
   else{if(run)out.push(Object.freeze({...run}));open.set(item.employmentId,{employmentId:item.employmentId,name:item.name,from:day.date,to:day.date});}
  }
  for(const [id,run] of open)if(!here.has(id)){out.push(Object.freeze({...run}));open.delete(id);}
 }
 for(const run of open.values())out.push(Object.freeze({...run}));
 return out.sort((a,b)=>a.from.localeCompare(b.from)||a.name.localeCompare(b.name));
}
