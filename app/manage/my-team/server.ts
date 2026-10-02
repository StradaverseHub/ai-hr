/** Server-owned links and finite error translation; caller URLs never confer scope. */
import {ModuleNotEnabledError} from '@/core/entitlements';
import type {MyTeamNavigation,MyTeamSnapshot} from '@/lib/my-team-types';
import {serializeMyTeamQuery,MyTeamQueryError,type MyTeamActionError} from '@/lib/my-team-query';
export function myTeamNavigation(snapshot:MyTeamSnapshot):MyTeamNavigation {
 const query=snapshot.query;
 const rosterHref=(week?:{from:string;to:string},employmentId?:string)=>{
  const q={...query,...(week?{view:'week' as const,anchorDate:week.from}:{}),...(employmentId?{employmentId}:{})};
  return '/roster?'+new URLSearchParams({myTeam:serializeMyTeamQuery(q).toString()});
 };
 const employees:MyTeamNavigation['employees']={};
 for(const employee of snapshot.employees){const weeks:MyTeamNavigation['employees'][string]['weeks']={};
  for(const week of snapshot.period.coveringWeeks){
   weeks[week.from]={
    attendanceHref:snapshot.availability.attendance==='available'?'/attendance/individual?'+new URLSearchParams({emp:employee.employmentId,from:week.from,to:week.to}):null,
    rosterHref:snapshot.availability.roster!=='available'?null:snapshot.scope.canEditRoster?`/roster/edit/${employee.employmentId}?`+new URLSearchParams({view:'week',from:week.from,to:week.to}):rosterHref(week,employee.employmentId),
   };
  }employees[employee.employmentId]={weeks};
 }
 return {roster:{href:snapshot.availability.roster==='available'?rosterHref():null,label:snapshot.scope.canEditRoster?'edit':'view'},employees};
}
export function myTeamError(error:unknown):{error:MyTeamActionError;status:number} {
 if(error instanceof ModuleNotEnabledError)return {error:'not_authorized',status:403};
 if(error instanceof MyTeamQueryError)return {error:'invalid_query',status:400};
 const code=error instanceof Error?(error as Error&{code?:string}).code??error.message:'';
 if(code==='MY_TEAM_QUERY_INVALID')return {error:'invalid_query',status:400};
 if(['MY_TEAM_FORBIDDEN','Forbidden','MODULE_DISABLED','MY_TEAM_NOT_AUTHORIZED','not_authorized'].includes(code))return {error:'not_authorized',status:403};
 if(['MY_TEAM_REVIEW_CHANGED','review_changed'].includes(code))return {error:'review_changed',status:409};
 if(['MY_TEAM_REQUEST_CHANGED','request_changed'].includes(code))return {error:'request_changed',status:409};
 if(['MY_TEAM_STALE_CONTEXT','stale_context'].includes(code))return {error:'stale_context',status:409};
 return {error:'failed',status:500};
}
export function myTeamErrorResponse(error:unknown):Response {const result=myTeamError(error);return Response.json({error:result.error},{status:result.status,headers:{'Cache-Control':'no-store'}});}
