/** ADR-0170 §3.10 example work job — "every Monday, summarise who on my team is away this week".
 *
 * Reads only through the native owners, under the grantor's CURRENT authority as resolved by ./run.ts and
 * narrowed by the mandate: My Team membership (core/my-team-scope.ts, direct reports only) and the leave
 * owner's team projection (approved leave in the week). Nothing is written: the summary is returned for the
 * grantor and the outcome record keeps only references, counts and the leave policy versions used.
 * The wording is deterministic; no model is involved. */
import {withTenant,type SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {weekRangeOf} from '../../lib/roster-month';
import {resolveMyTeamScope} from '../my-team-scope';
import {leavePolicyVersionTx} from '../outcome-record/rule-versions';
import type {OutcomeCheck,OutcomeRead} from '../outcome-record/types';
import {myTeamLeaveProjection} from '../../packs/leave/service';
import type {MandateLimits,MandateScope} from './job-types';

export type TeamAbsenceLine=Readonly<{employmentId:string;name:string;leaveType:string;dates:readonly string[]}>;
export type TeamAbsenceSummary=Readonly<{from:string;to:string;people:number;absent:readonly TeamAbsenceLine[];text:string}>;
/** What a work job returns to the run: its prepared result for the grantor, and what the record keeps. */
export type WorkJobResult<S=TeamAbsenceSummary>=Readonly<{summary:S;reads:readonly OutcomeRead[];checks:readonly OutcomeCheck[];
 outcome:Readonly<Record<string,string|number|boolean|null|readonly string[]>>}>;

export async function teamAbsenceWeeklySummary(grantor:SessionContext,mandate:Readonly<{scope:MandateScope;limits:MandateLimits}>,now:Date):Promise<WorkJobResult>{
 const today=todayInKualaLumpur(now),{from,to}=weekRangeOf(today);
 // The job type admits only the direct team (job-types.ts); any other scope is refused, never widened.
 if(mandate.scope.team!=='direct')throw Error('The team summary covers the direct team only.');
 const team=await resolveMyTeamScope(grantor,{view:'week',scope:mandate.scope.team,anchorDate:today});
 // The mandate's people limit narrows the team; it never widens it.
 const members=[...team.employees].sort((a,b)=>a.name.localeCompare(b.name)||a.employmentId.localeCompare(b.employmentId)).slice(0,mandate.limits.maxPeople);
 const rows=members.length?await myTeamLeaveProjection(grantor,{employmentIds:members.map(member=>member.employmentId),from,to,today}):[];
 const absent:TeamAbsenceLine[]=[],requestIds:string[]=[],leaveTypeIds=new Set<string>();
 for(const member of members){
  for(const row of rows.filter(item=>item.employmentId===member.employmentId)){
   const dates=row.dates.filter(date=>date.status==='approved'&&date.date>=from&&date.date<=to).map(date=>date.date).sort();
   if(!dates.length)continue;
   absent.push(Object.freeze({employmentId:member.employmentId,name:member.name,leaveType:row.name,dates:Object.freeze(dates)}));
   requestIds.push(row.requestId);leaveTypeIds.add(row.leaveTypeId);
  }
 }
 const versions=await withTenant(grantor,async tx=>{const out:string[]=[];for(const id of [...leaveTypeIds].sort())out.push(await leavePolicyVersionTx(tx,id));return out;});
 const text=absent.length?[`Away on your team, ${from} to ${to}:`,...absent.map(line=>`- ${line.name}: ${line.leaveType}, ${line.dates.join(', ')}`)].join('\n')
  :`Nobody on your team has approved leave from ${from} to ${to}.`;
 return Object.freeze({
  summary:Object.freeze({from,to,people:members.length,absent:Object.freeze(absent),text}),
  reads:Object.freeze([
   {tool:'core/my-team-scope.ts#resolveMyTeamScope',status:'ok',refs:members.map(member=>member.employmentId)},
   {tool:'core/leave.ts#myTeamLeaveProjection',status:'ok',refs:[...new Set(requestIds)]},
  ]),
  checks:Object.freeze(versions.map(ruleVersion=>({check:'leave_policy',owner:'core/leave.ts#myTeamLeaveProjection',ruleVersion,result:'pass' as const}))),
  outcome:Object.freeze({from,to,people:members.length,absentPeople:new Set(absent.map(line=>line.employmentId)).size,requests:new Set(requestIds).size,truncated:team.employees.length>members.length}),
 });
}
