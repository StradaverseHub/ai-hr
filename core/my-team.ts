/** One authorized period projection supplies My Team tiles, grid, attention and detail. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {attendance,attendanceAttentionReview,shift} from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import {todayInKualaLumpur} from '../lib/hr-date';
import {datesBetween,monthRange,weekRangeOf,addDaysIso,resolveRosterCell} from '../lib/roster-month';
import type {MyTeamQuery,MyTeamSnapshot,MyTeamEmployee,MyTeamDay,MyTeamRosterDay,MyTeamPunchReviewResult,MyTeamRosterScope,MyTeamApproval} from '../lib/my-team-types';
import {attendanceForEmploymentsRange,statusOf,flagOf} from '../packs/attendance/service';
import {actionableLeaveRequests,myTeamLeaveProjection,decideLeave,decideLeaveDates,leaveTypeIs} from '../packs/leave/service';
import {leaveBalances} from './read';
import {rosterWindowView,type RosterMonthView} from './roster';
import {isModuleEnabled} from './entitlements';
import {resolveMyTeamScope,assertMyTeamAccess,assertMyTeamSubjectTx,MyTeamAuthorizationError} from './my-team-scope';
export type * from '../lib/my-team-types';
export {MyTeamAuthorizationError} from './my-team-scope';

export class MyTeamReviewChangedError extends Error {constructor(){super('MY_TEAM_REVIEW_CHANGED');this.name='MyTeamReviewChangedError';}}
const validDate=(d:string)=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeQuery(query:MyTeamQuery,today:string){
 const anchorDate=query.anchorDate??today;
 if(!validDate(anchorDate)||!['week','month'].includes(query.view)||!['direct','all','department'].includes(query.scope)
   ||query.companyIds?.some(id=>!uuid.test(id))||query.departmentId&&!uuid.test(query.departmentId)
   ||query.employmentId&&!uuid.test(query.employmentId)||(query.search?.length??0)>100
   ||query.tile&&!['members','checked_in','late','absent','on_leave','pending_approvals'].includes(query.tile))throw new Error('MY_TEAM_QUERY_INVALID');
 return {...query,anchorDate,companyIds:query.companyIds??[],search:query.search?.trim()??'',layers:query.layers??{roster:true,attendance:true,leave:true}};
}
function periodOf(query:ReturnType<typeof normalizeQuery>){
 const period=query.view==='month'?monthRange(query.anchorDate.slice(0,7)):weekRangeOf(query.anchorDate);
 const start=weekRangeOf(period.from).from,end=weekRangeOf(period.to).to;
 const coveringWeeks=[];
 for(let from=start;from<=end;from=addDaysIso(from,7))coveringWeeks.push({from,to:addDaysIso(from,6)});
 return {...period,gridDates:datesBetween(start,end),coveringWeeks};
}
function rosterDay(view:RosterMonthView,id:string,date:string):MyTeamRosterDay {
 const assigned=view.cells[`${id}|${date}`]??null,resolved=resolveRosterCell(date,assigned,view.usual[id]);
 const shiftId=resolved.kind==='shift'||resolved.kind==='usual'?resolved.shiftId:null;
 const sh=view.shifts.find(s=>s.id===shiftId);
 return {kind:resolved.kind==='rest'?'rest':resolved.kind==='off'?'off':resolved.kind==='none'?'unassigned':'shift',
   shiftId,code:sh?.code??null,name:sh?.name??null,color:sh?.color??null,start:sh?.startTime??null,end:sh?.endTime??null,
   scheduledMinutes:null,isRestDay:resolved.kind==='rest',isOverride:assigned!==null};
}
/** Bounded concurrency for canonical employee balance reads, never a call per cell. */
async function mapBounded<T,R>(items:T[],fn:(item:T)=>Promise<R>):Promise<R[]>{
 const result=new Array<R>(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{for(;;){const index=next++;if(index>=items.length)return;result[index]=await fn(items[index]);}}));return result;
}
export async function readMyTeam(ctx:SessionContext,input:MyTeamQuery):Promise<MyTeamSnapshot>{
 assertMyTeamAccess(ctx);
 const today=todayInKualaLumpur(),query=normalizeQuery(input,today),period=periodOf(query);
 const scope=await resolveMyTeamScope(ctx,input);
 const employeeIds=scope.employees.map(e=>e.employmentId),companyIds=scope.companies.map(c=>c.id);
 query.companyIds=companyIds;
 const attendanceAvailable=isModuleEnabled(ctx,'attendance'),leaveAvailable=isModuleEnabled(ctx,'leave');
 const inGrid=period.gridDates.includes(today),from=period.gridDates[0],to=period.gridDates.at(-1)!;
 const realCtx={...ctx,personId:scope.principal.personId};
 const [roster,todayRoster,attendanceRows,todayAttendanceRows,leaves,decisions,balanceRows,observations]=await Promise.all([
   employeeIds.length ? rosterWindowView(realCtx,{companyIds,employmentIds:employeeIds,from,to}) : null,
   employeeIds.length&&!inGrid ? rosterWindowView(realCtx,{companyIds,employmentIds:employeeIds,from:today,to:today}) : null,
   attendanceAvailable&&employeeIds.length ? attendanceForEmploymentsRange(realCtx,employeeIds,from,to) : new Map(),
   attendanceAvailable&&employeeIds.length&&!inGrid ? attendanceForEmploymentsRange(realCtx,employeeIds,today,today) : new Map(),
   leaveAvailable ? myTeamLeaveProjection(realCtx,{employmentIds:employeeIds,from,to,today}) : [],
   leaveAvailable ? actionableLeaveRequests(realCtx,{employmentIds:employeeIds}) : [],
   leaveAvailable ? mapBounded(scope.employees,e=>leaveBalances(realCtx,e.employmentId,input.locale)) : [],
   attendanceAvailable&&employeeIds.length ? withTenant(realCtx,async tx=>{
     const rows=await tx.select({attendanceId:attendance.id,employmentId:attendance.employmentId,date:attendance.attendanceDate,
       fingerprint:sql<string>`app.attendance_attention_fingerprint(${attendance})`,
       reviewed:sql<boolean>`EXISTS(SELECT 1 FROM attendance_attention_review r WHERE r.attendance_id=${attendance.id}
        AND r.reviewer_user_id=app.current_user_id() AND r.fingerprint=app.attendance_attention_fingerprint(${attendance}))`})
       .from(attendance).where(and(inArray(attendance.employmentId,employeeIds),
         sql`(${attendance.attendanceDate} BETWEEN ${from}::date AND ${to}::date OR ${attendance.attendanceDate}=${today}::date)`));return rows;
   }) : [],
 ]);
 const usualIds=[...new Set([...Object.values(roster?.usual??{}),...Object.values(todayRoster?.usual??{})].map(u=>u.shiftId))];
 const defaults=usualIds.length ? await withTenant(realCtx,tx=>tx.select({id:shift.id,code:shift.code,start:shift.startTime,end:shift.endTime})
   .from(shift).where(inArray(shift.id,usualIds))) : [];
 const approvals:MyTeamApproval[]=decisions.map(d=>{
   const employee=scope.employees.find(e=>e.employmentId===d.employmentId)!;
   const effectiveDates=leaves.find(l=>l.requestId===d.requestId)?.dates.filter(date=>date.status==='pending').map(date=>({date:date.date,days:date.days}))??[];
   return {...d,effectiveDates,employeeName:employee.name,appliedAt:d.appliedAt.toISOString(),annualAvailable:null};
 });
 const allDates=inGrid?period.gridDates:[...period.gridDates,today];
 const employees:MyTeamEmployee[]=scope.employees.map((employee,index)=>{
   const balances=(balanceRows[index]??[]).map(b=>({leaveTypeId:b.leaveTypeId,code:b.code,name:b.leaveType,role:b.role,
     accrued:b.essView.ytdEntitled?b.accrued:null,taken:b.essView.taken?b.taken:null,
     pending:b.essView.pendingApproval?b.pending:null,available:b.essView.available?b.available:null}));
   const annualRows=balances.filter(b=>leaveTypeIs(b,'annual'));
   const annual=annualRows.length===1 ? annualRows[0] : undefined;
   const defaultShift=defaults.find(s=>s.id===(todayRoster??roster)?.usual[employee.employmentId]?.shiftId);
   const days:MyTeamDay[]=allDates.map(date=>{
     const ownRoster=date===today&&!inGrid?todayRoster:roster;
     const row=(date===today&&!inGrid?todayAttendanceRows:attendanceRows).get(employee.employmentId)?.find((r: {date:string})=>r.date===date);
     const observation=observations.find(o=>o.employmentId===employee.employmentId&&o.date===date);
     const dayRoster=ownRoster?rosterDay(ownRoster,employee.employmentId,date):null;
     if(dayRoster&&row)dayRoster.scheduledMinutes=row.scheduledMinutes;
     return {date,roster:dayRoster,attendance:row?{attendanceId:row.attendanceId,status:statusOf(row),flag:flagOf(row),
       checkInAt:row.checkInAt,checkOutAt:row.checkOutAt,workedMinutes:row.workedMinutes,lateMinutes:row.lateMinutes,
       scheduledMinutes:row.scheduledMinutes,fingerprint:observation?.fingerprint??null,reviewed:observation?.reviewed??false}:null,
       leave:leaves.filter(l=>l.employmentId===employee.employmentId).flatMap(l=>l.dates.filter(d=>d.date===date).map(d=>({
         requestId:l.requestId,leaveTypeId:l.leaveTypeId,code:l.code??'',name:l.name,color:l.color,status:d.status,
         session:l.session,days:d.days,fromTime:l.fromTime,toTime:l.toTime})))};
   });
   const todayDay=days.find(d=>d.date===today)!;
   const flags={checkedIn:!!todayDay.attendance?.checkInAt,late:todayDay.attendance?.flag==='late',
     absent:todayDay.attendance?.status==='absent',onLeave:todayDay.leave.some(l=>l.status==='approved'&&l.session==='full_day'),
     halfDayLeave:todayDay.leave.some(l=>l.status==='approved'&&(l.session==='AM'||l.session==='PM')),
     pendingApprovals:approvals.some(a=>a.employmentId===employee.employmentId)};
   const upcomingLeave=leaves.filter(l=>l.employmentId===employee.employmentId).flatMap(l=>{
     const groups:MyTeamEmployee['upcomingLeave']=[];
     for(const d of l.dates.filter(d=>d.date>=today).sort((a,b)=>a.date.localeCompare(b.date))){
       const last=groups.at(-1);
       if(last&&last.status===d.status&&addDaysIso(last.to,1)===d.date){last.to=d.date;last.days+=d.days;}
       else groups.push({requestId:l.requestId,leaveTypeId:l.leaveTypeId,code:l.code??'',name:l.name,from:d.date,to:d.date,
         days:d.days,status:d.status,session:l.session});
     }return groups;
   });
   return {employmentId:employee.employmentId,employeeCode:employee.employeeCode,name:employee.name,
     occupation:employee.occupation,companyId:employee.companyId,departmentId:employee.departmentId,defaultShift:defaultShift?{code:defaultShift.code??'',start:defaultShift.start,end:defaultShift.end}:null,
     balances,annualAvailable:annual?.available??null,days,upcomingLeave,today:flags,
     weeks:period.coveringWeeks.map(week=>{
       const own=days.filter(d=>d.date>=week.from&&d.date<=week.to);
       const observed=own.filter(d=>d.date<=today);
       return {...week,rosteredDays:own.filter(d=>d.roster?.kind==='shift').length,
         checkedInDays:observed.filter(d=>d.attendance?.checkInAt).length,absentDays:observed.filter(d=>d.attendance?.status==='absent').length,
         lateOrMissingDays:observed.filter(d=>d.attendance?.flag==='late'||d.attendance?.flag==='odd').length,
         approvedLeaveDays:leaveAvailable?own.reduce((sum,d)=>sum+d.leave.filter(l=>l.status==='approved').reduce((s,l)=>s+l.days,0),0):null,
         workedMinutes:attendanceAvailable&&observed.every(d=>!d.attendance?.attendanceId||d.attendance.workedMinutes!==null)
           ? observed.reduce((sum,d)=>sum+(d.attendance?.workedMinutes??0),0):null,
         lateMinutes:attendanceAvailable&&observed.every(d=>!d.attendance?.attendanceId||d.attendance.lateMinutes!==null)
           ? observed.reduce((sum,d)=>sum+(d.attendance?.lateMinutes??0),0):null};
     })};
 });
 for(const approval of approvals)approval.annualAvailable=employees.find(e=>e.employmentId===approval.employmentId)?.annualAvailable??null;
 const attention:MyTeamSnapshot['attention']=approvals.map(a=>({kind:'pending_leave',id:a.requestId,employmentId:a.employmentId,approval:a}));
 for(const employee of employees){const day=employee.days.find(d=>d.date===today)!;
   if(day.attendance?.status==='absent')attention.push({kind:'absent',id:`absent:${employee.employmentId}:${today}`,employmentId:employee.employmentId,date:today,lateMinutes:null,pendingLeave:day.leave.some(l=>l.status==='pending'),roster:day.roster});
   if(day.attendance?.flag==='late')attention.push({kind:'late',id:`late:${employee.employmentId}:${today}`,employmentId:employee.employmentId,date:today,lateMinutes:day.attendance.lateMinutes,pendingLeave:day.leave.some(l=>l.status==='pending'),roster:day.roster});
   for(const observed of employee.days.filter(d=>d.date<=today&&d.attendance?.flag==='odd'&&!d.attendance.reviewed)){
     const a=observed.attendance!;
     if(a.attendanceId&&a.fingerprint)attention.push({kind:'missing_punch',id:a.attendanceId,employmentId:employee.employmentId,date:observed.date,attendanceId:a.attendanceId,fingerprint:a.fingerprint});
   }
 }
 const tile=input.tile??'members',flag={checked_in:'checkedIn',late:'late',absent:'absent',on_leave:'onLeave',pending_approvals:'pendingApprovals'} as const;
 const gridEmploymentIds=employees.filter(e=>(!query.search||`${e.name} ${e.employeeCode??''}`.toLowerCase().includes(query.search.toLowerCase()))
   &&(tile==='members'||e.today[flag[tile]])).map(e=>e.employmentId);
 // Source owners retain their normal transactions; refuse a membership change rather than return old IDs.
 const finalScope=await resolveMyTeamScope(ctx,input);
 const scopeSignature=(value:typeof scope)=>JSON.stringify({
   employees:value.employees.slice().sort((a,b)=>a.employmentId.localeCompare(b.employmentId)),
   companies:value.companies.slice().sort((a,b)=>a.id.localeCompare(b.id)),
   departments:value.departments.slice().sort((a,b)=>a.id.localeCompare(b.id)),
   principal:value.principal,canEditRoster:value.canEditRoster,canChooseDepartment:value.canChooseDepartment});
 if(scopeSignature(scope)!==scopeSignature(finalScope))throw new MyTeamAuthorizationError();
 const count=(key:keyof MyTeamEmployee['today'])=>employees.filter(e=>e.today[key]).length;
 return {query,today,period,scope:{employmentIds:employeeIds,companies:scope.companies,departments:scope.departments,
   canEditRoster:scope.canEditRoster,canChooseDepartment:scope.canChooseDepartment},availability:{attendance:attendanceAvailable?'available':'unavailable',leave:leaveAvailable?'available':'unavailable',roster:'available'},
   employees,gridEmploymentIds,actionableApprovals:approvals,attention,todaySummary:{members:employees.length,
     checkedIn:attendanceAvailable?count('checkedIn'):null,late:attendanceAvailable?count('late'):null,absent:attendanceAvailable?count('absent'):null,
     onLeave:leaveAvailable?count('onLeave'):null,halfDayLeave:leaveAvailable?count('halfDayLeave'):null,pendingApprovals:leaveAvailable?approvals.length:null}};
}
export async function resolveMyTeamRosterScope(ctx:SessionContext,query:MyTeamQuery):Promise<MyTeamRosterScope>{
 const snapshot=await readMyTeam(ctx,query);return {companyIds:snapshot.query.companyIds,employmentIds:snapshot.gridEmploymentIds,
   from:snapshot.period.gridDates[0],to:snapshot.period.gridDates.at(-1)!,canEditRoster:snapshot.scope.canEditRoster};
}
export function markMyTeamPunchReviewed(ctx:SessionContext,p:{attendanceId:string;fingerprint:string}):Promise<MyTeamPunchReviewResult>{
 assertMyTeamAccess(ctx);if(!isModuleEnabled(ctx,'attendance'))throw new MyTeamAuthorizationError();
 if(!uuid.test(p.attendanceId)||!/^[0-9a-f]{32}$/.test(p.fingerprint))throw new MyTeamReviewChangedError();
 return withTenant(ctx,async tx=>{
   const [row]=await tx.select().from(attendance).where(eq(attendance.id,p.attendanceId)).limit(1).for('update');
   if(!row)throw new MyTeamAuthorizationError();
   await assertMyTeamSubjectTx(tx,ctx,undefined,row.employmentId);
   const [observed]=await tx.execute(sql`SELECT app.attendance_attention_fingerprint(a) AS fingerprint FROM attendance a WHERE a.id=${row.id}::uuid`) as unknown as {fingerprint:string}[];
   if(observed?.fingerprint!==p.fingerprint||row.attendanceDate>todayInKualaLumpur()||!!row.checkInAt===!!row.checkOutAt)throw new MyTeamReviewChangedError();
   const [inserted]=await tx.insert(attendanceAttentionReview).values({tenantId:ctx.tenantId,attendanceId:row.id,
     reviewerUserId:ctx.userId!,fingerprint:p.fingerprint}).onConflictDoNothing().returning({id:attendanceAttentionReview.id});
   if(inserted){await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-attention-review',aggregateId:inserted.id,
     eventType:'attendance-attention.reviewed',actor:actorOf(ctx),subjectEmploymentId:row.employmentId,
     payload:{attendanceId:row.id,fingerprint:p.fingerprint}});return {reviewed:true,reviewId:inserted.id};}
   const [existing]=await tx.select({id:attendanceAttentionReview.id}).from(attendanceAttentionReview).where(and(
     eq(attendanceAttentionReview.attendanceId,row.id),eq(attendanceAttentionReview.reviewerUserId,ctx.userId!),eq(attendanceAttentionReview.fingerprint,p.fingerprint)));
   if(!existing)throw new MyTeamReviewChangedError();return {reviewed:true,reviewId:existing.id};
 });
}
export function decideMyTeamLeave(ctx:SessionContext,query:MyTeamQuery,p:Parameters<typeof decideLeave>[1]){
 assertMyTeamAccess(ctx);return decideLeave(ctx,{...p,teamScope:query});
}
export function decideMyTeamLeaveDates(ctx:SessionContext,query:MyTeamQuery,p:Parameters<typeof decideLeaveDates>[1]){
 assertMyTeamAccess(ctx);return decideLeaveDates(ctx,{...p,teamScope:query});
}
