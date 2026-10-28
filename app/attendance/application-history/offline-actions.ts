'use server';
import {revalidatePath} from 'next/cache';
import {scopedAdmin} from '@/lib/scope';
import {resolveOfflineClaim,type OfflineClaimResolutionStatus} from '@/packs/attendance/mobile-offline-claim-review';
import {offlineResolveError,type OfflineResolveError} from './offline-errors';

export type OfflineResolveResult={ok:true;claimId:string;status:OfflineClaimResolutionStatus}|{ok:false;error:OfflineResolveError}|null;

/** Reject, or accept as an HR punch correction at the chosen instant, one held offline punch. The screen's guard is the
 * Application History page's (scopedAdmin); the service checks attendance-correction authority, self-resolution, the
 * photo rule for a group admin and the interval, and the correction owner its payroll and workflow rules. */
export async function resolveOfflineClaimAction(_previous:OfflineResolveResult,fd:FormData):Promise<OfflineResolveResult>{
 const {s}=await scopedAdmin();
 const claimId=String(fd.get('claimId')??''),decision=String(fd.get('decision')??''),reason=String(fd.get('reason')??'').trim();
 if(!reason)return {ok:false,error:'reasonRequired'};
 if(decision!=='accepted'&&decision!=='rejected')return {ok:false,error:'failed'};
 const rawAt=String(fd.get('effectiveAt')??''),effectiveAt=Number(rawAt);
 if(decision==='accepted'&&(rawAt===''||!Number.isSafeInteger(effectiveAt)))return {ok:false,error:'timeRequired'};
 try{
  const resolved=await resolveOfflineClaim(s,decision==='accepted'?{claimId,decision,effectiveAt,reason}:{claimId,decision,reason});
  for(const path of ['/attendance/application-history','/attendance','/attendance/individual','/attendance/daily','/attendance/request-status','/approvals'])revalidatePath(path);
  return {ok:true,claimId:resolved.claimId,status:resolved.status};
 }catch(error){
  return {ok:false,error:offlineResolveError(error)};
 }
}
