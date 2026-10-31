'use server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {OfflineClockingSettingsError,setOfflineClockingPolicy} from '@/packs/attendance/service';
import {SCHEDULE} from './schedule-panel';

/** A value result, so a refused save keeps the card's typing (useActionState; see app/(app)/admin/holidays/holiday-dialog). */
export type OfflineClockingSaveResult={ok:true;savedAt:number;savedReceipt:string|null}|{ok:false;error:'minutesRange'|'forbidden'|'unavailable'|'failed'}|null;

/** Saves one company's offline clocking switch and review threshold. Guard: requireAdmin here, and the attendance
 * policy's own can_admin_payroll_for(company) in setOfflineClockingPolicy (as RLS requires for setAttendancePolicy).
 * The threshold is posted in minutes and stored in seconds; 60 to 86400 seconds, the column's CHECK, is checked here
 * for the plain message and again by the service. */
export async function saveOfflineClockingAction(_previous:OfflineClockingSaveResult,fd:FormData):Promise<OfflineClockingSaveResult>{
 const s=await requireAdmin();
 const raw=String(fd.get('maxProvenWindowMinutes')??'').trim(),minutes=Number(raw),seconds=Math.round(minutes*60);
 if(raw===''||!Number.isFinite(minutes)||seconds<60||seconds>86400)return {ok:false,error:'minutesRange'};
 try{
  await setOfflineClockingPolicy(s,{companyId:String(fd.get('companyId')??''),enabled:fd.get('enabled')!=null,maxProvenWindowSeconds:seconds});
 }catch(error){
  if(error instanceof OfflineClockingSettingsError)return {ok:false,error:error.reason==='invalid_input'?'failed':error.reason};
  throw error;
 }
 revalidatePath(SCHEDULE);
 // The unsaved-changes guard's receipt (components/attendance-settings-navigation): echoed only after the write.
 const nonce=String(fd.get('__attendanceSaveNonce')??'');
 return {ok:true,savedAt:Date.now(),savedReceipt:/^[a-f0-9]{32}$/.test(nonce)?nonce:null};
}
