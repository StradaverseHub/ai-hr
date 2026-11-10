'use server';
import {validateAnyAttendanceWorkflow, type AnyAttendanceWorkflowInput} from '@/lib/attendance-workflow-config';
import { getTranslations } from 'next-intl/server';
import {AttendanceCcError} from '@/lib/attendance-workflow-v4';
import { AttendanceLevelError, attendanceLevelProblemMessageKey } from '@/lib/attendance-workflow-v3';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { pgSqlState } from '@/lib/db-error';
import { isWorkflowId } from './navigation';
import { scopedAdmin } from '@/lib/scope';
import { saveAttendanceWorkflow, archiveAttendanceWorkflow, attendanceWorkflowWarningPage, retireAttendanceWorkflow, restoreAttendanceWorkflow, getAttendanceWorkflow, previewAttendanceWorkflow, generateAttendanceWorkflowPreview, AttendanceWorkflowError, type AttendanceWorkflowCopySource } from '@/packs/attendance/service';
const LIST = '/admin/attendance/approval-workflow';
async function publicError(e: unknown) { if(e instanceof AttendanceCcError)return(await getTranslations('attendanceWorkflow.v4'))(e.code);if(e instanceof AttendanceWorkflowError&&e.code==='inUse')return(await getTranslations('attendanceWorkflow.v4'))('usedCannotDelete');if(e instanceof AttendanceWorkflowError&&e.code==='stale')return(await getTranslations('attendanceWorkflow.v4'))('deleteChanged'); if (e instanceof AttendanceLevelError) return (await getTranslations('attendanceWorkflow.v3'))(attendanceLevelProblemMessageKey(e.problem)); return e instanceof AttendanceWorkflowError ? e.message : 'The workflow could not be saved. Check the configuration and try again.'; }
export async function saveAttendanceWorkflowAction(lineageId: string | null, input: AnyAttendanceWorkflowInput, autoPriority = false, saveRequestId?:string, copiedFrom?: AttendanceWorkflowCopySource) {
    let row: Awaited<ReturnType<typeof saveAttendanceWorkflow>>;
    try {
        const { s, scopeIds, allowedCompanyIds } = await scopedAdmin();
        if (lineageId!==null&&!isWorkflowId(lineageId)) throw new AttendanceWorkflowError('invalid','Reopen the workflow before saving.');
        if (copiedFrom!==undefined&&(lineageId!==null||!copiedFrom||!isWorkflowId(String(copiedFrom.lineageId)))) throw new AttendanceWorkflowError('invalid','Reopen the copied workflow before saving.');
        const configuration=validateAnyAttendanceWorkflow({...input,active:true});
        const allowed=allowedCompanyIds??scopeIds;
        if ((configuration.companyIds??[configuration.companyId]).some(id=>!allowed.includes(id)))
            throw new AttendanceWorkflowError('scope','Select a company in your active access scope.');
        row = copiedFrom===undefined
            ? await saveAttendanceWorkflow(s, configuration, lineageId ?? undefined, undefined, autoPriority === true, saveRequestId)
            : await saveAttendanceWorkflow(s, configuration, undefined, undefined, autoPriority === true, saveRequestId, {lineageId:copiedFrom.lineageId,version:copiedFrom.version});
    }
    catch (error) {
        unstable_rethrow(error);
        if (!(error instanceof AttendanceWorkflowError || error instanceof AttendanceLevelError || error instanceof AttendanceCcError)) {
            const state = pgSqlState(error);
            console.warn('Attendance workflow save did not complete.', { state });
            if (state === '42501') return { ok: false as const, error: 'Your workflow access changed. Reopen the workflow and check your company access.' };
            if (state === '23505') return { ok: false as const, error: 'The workflow code or version changed during this save. Reopen the workflow before trying again.' };
        }
        const message=error instanceof AttendanceWorkflowError&&error.code==='stale' ? error.message : await publicError(error);
        return { ok: false as const, error: message, levelProblem: error instanceof AttendanceLevelError ? error.problem : null };
    }
    // The definition and receipt have committed. Cache invalidation cannot turn that into a failed save.
    try {
        revalidatePath(LIST);
        revalidatePath(`${LIST}/${row.lineageId}`);
        revalidatePath(`${LIST}/${row.lineageId}/edit`);
    } catch {
        console.warn('Attendance workflow saved, but its pages could not be revalidated.');
    }
    return { ok: true as const, lineageId: row.lineageId };
}
export async function previewAttendanceWorkflowAction(lineageId: string | null, input: AnyAttendanceWorkflowInput) {
    const { s, scopeIds,allowedCompanyIds } = await scopedAdmin();
    if ((input.companyIds??[input.companyId]).some(id=>!(allowedCompanyIds??scopeIds).includes(id)))
        return { ok: false as const, error: 'Select a company in your active access scope.' };
    try {
        return { ok: true as const, preview: await previewAttendanceWorkflow(s, {...input,active:true}, lineageId ?? undefined) };
    }
    catch (e) {
        return { ok: false as const, error: await publicError(e), levelProblem: e instanceof AttendanceLevelError ? e.problem : null };
    }
}
export async function retireAttendanceWorkflowAction(lineageId:string,version:number) {
 const {s,scopeIds,allowedCompanyIds}=await scopedAdmin();
 try{const current=await getAttendanceWorkflow(s,lineageId,allowedCompanyIds??scopeIds);if(!current)throw new AttendanceWorkflowError('stale','The workflow changed. Reload.');await retireAttendanceWorkflow(s,lineageId,version);revalidatePath(LIST);revalidatePath(`${LIST}/${lineageId}`);return{ok:true as const,companyId:current.companyId,applicationType:current.applicationType};}
 catch(error){return{ok:false as const,error:await publicError(error)};}
}
export async function restoreAttendanceWorkflowAction(lineageId:string,version:number) {
 const {s,scopeIds,allowedCompanyIds}=await scopedAdmin();
 try{const row=await restoreAttendanceWorkflow(s,lineageId,version,allowedCompanyIds??scopeIds);revalidatePath(LIST);revalidatePath(`${LIST}/${lineageId}`);return{ok:true as const,lineageId:row.lineageId};}
 catch(error){return{ok:false as const,error:await publicError(error)};}
}

export async function searchAttendanceApproversAction(input:{companyIds:string[];query:string;page:number;selectedIds?:string[]}){
 const {s,scopeIds,allowedCompanyIds}=await scopedAdmin();
 try{
  if(input.companyIds.some(id=>!(allowedCompanyIds??scopeIds).includes(id)))throw new AttendanceWorkflowError('scope','Select companies in your permitted scope.');
  const {searchAttendanceApprovers}=await import('@/packs/attendance/service');
  return {ok:true as const,value:await searchAttendanceApprovers(s,input)};
 }catch(error){return {ok:false as const,error:await publicError(error)};}
}

export async function archiveAttendanceWorkflowAction(lineageId:string,version:number){
 const {s,scopeIds,allowedCompanyIds}=await scopedAdmin();
 try{const current=await getAttendanceWorkflow(s,lineageId,allowedCompanyIds??scopeIds);if(!current)throw new AttendanceWorkflowError('stale','The workflow changed. Reload.');await archiveAttendanceWorkflow(s,lineageId,version);revalidatePath(LIST);revalidatePath(`${LIST}/${lineageId}`);return{ok:true as const,companyId:current.companyId,applicationType:current.applicationType};}
 catch(error){return{ok:false as const,error:await publicError(error)};}
}
export async function attendanceWorkflowWarningPageAction(lineageId:string,offset:number){
 const {s,scopeIds,allowedCompanyIds}=await scopedAdmin();
 try{return{ok:true as const,page:await attendanceWorkflowWarningPage(s,lineageId,allowedCompanyIds??scopeIds,offset)};}catch(error){return{ok:false as const,error:await publicError(error)};}
}

/** Generates and stores a Preview Assignment of the saved version. Administrator of every workflow company only. */
export async function generateAttendanceWorkflowPreviewAction(lineageId:string,version:number){
 const {s,scopeIds,allowedCompanyIds}=await scopedAdmin();
 try{
  if(!isWorkflowId(lineageId))throw new AttendanceWorkflowError('invalid','Reload the workflow before generating a preview.');
  const result=await generateAttendanceWorkflowPreview(s,lineageId,version,allowedCompanyIds??scopeIds);
  try{revalidatePath(`${LIST}/${lineageId}`);revalidatePath(`${LIST}/${lineageId}/previews`);}catch{console.warn('Attendance workflow preview stored, but its pages could not be revalidated.');}
  return{ok:true as const,previewId:result.id};
 }catch(error){unstable_rethrow(error);return{ok:false as const,error:await publicError(error)};}
}
