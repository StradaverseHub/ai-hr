'use server';
import {revalidatePath} from 'next/cache';
import {scopedSession} from '@/lib/scope';
import {hasTeamAccess} from '@/lib/authz';
import {readMyTeam,markMyTeamPunchReviewed} from '@/core/my-team';
import {decideLeave,decideLeaveDates} from '@/packs/leave/service';
import {parseMyTeamQuery,type MyTeamActionResult} from '@/lib/my-team-query';
import {myTeamError} from './server';
function paramsOf(form:FormData):URLSearchParams {const params=new URLSearchParams();for(const [key,value] of form.entries())if(typeof value==='string')params.append(key,value);return params;}
function refresh(){revalidatePath('/manage/my-team');revalidatePath('/leave');revalidatePath('/approvals');revalidatePath('/', 'layout');}
export async function approveMyTeamLeaveAction(form:FormData):Promise<MyTeamActionResult> {
 const {s,scopeIds}=await scopedSession();if(!hasTeamAccess(s))return {ok:false,error:'not_authorized'};
 try{
  const query=parseMyTeamQuery(paramsOf(form));const requested=query.companyIds??scopeIds;
  const snapshot=await readMyTeam(s,{...query,companyIds:requested.filter(id=>scopeIds.includes(id))});
  const requestId=String(form.get('requestId')??''),decision=String(form.get('decision')??'');
  if(decision!=='approved'&&decision!=='rejected')return {ok:false,error:'invalid_query'};
  const approval=snapshot.actionableApprovals.find(item=>item.requestId===requestId);
  if(!approval)return {ok:false,error:'request_changed'};
  const rejectReason=String(form.get('rejectReason')??'').trim()||undefined;
  if(decision==='rejected'&&!rejectReason)return {ok:false,error:'invalid_query'};
  const dates=form.getAll('dateIds').map(value=>String(value));
  if(approval.dateDecisionRequired){
   const allowed=new Set(approval.dates.filter(item=>item.status==='pending').map(item=>item.date));
   if(!dates.length||new Set(dates).size!==dates.length||dates.some(date=>!allowed.has(date)))return {ok:false,error:'request_changed'};
   await decideLeaveDates(s,{leaveRequestId:requestId,decisions:dates.map(leaveDate=>({leaveDate,decision,rejectReason}))});
  }else{
   if(dates.length)return {ok:false,error:'invalid_query'};
   await decideLeave(s,{leaveRequestId:requestId,decision,rejectReason});
  }
  refresh();return {ok:true};
 }catch(error){return {ok:false,error:myTeamError(error).error};}
}
export async function reviewMyTeamPunchAction(form:FormData):Promise<MyTeamActionResult> {
 const {s,scopeIds}=await scopedSession();if(!hasTeamAccess(s))return {ok:false,error:'not_authorized'};
 try{
  const query=parseMyTeamQuery(paramsOf(form));const requested=query.companyIds??scopeIds;
  const snapshot=await readMyTeam(s,{...query,companyIds:requested.filter(id=>scopeIds.includes(id))});
  const attendanceId=String(form.get('attendanceId')??''),fingerprint=String(form.get('fingerprint')??'');
  const current=snapshot.attention.find(item=>item.kind==='missing_punch'&&item.attendanceId===attendanceId);
  if(!current||current.kind!=='missing_punch'||current.fingerprint!==fingerprint)return {ok:false,error:'review_changed'};
  await markMyTeamPunchReviewed(s,{attendanceId,fingerprint});revalidatePath('/manage/my-team');return {ok:true};
 }catch(error){return {ok:false,error:myTeamError(error).error};}
}
