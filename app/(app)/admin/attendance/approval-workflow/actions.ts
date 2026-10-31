'use server';
import type {AnyAttendanceWorkflowInput} from '@/lib/attendance-workflow-config';
import { getTranslations } from 'next-intl/server';
import {AttendanceCcError} from '@/lib/attendance-workflow-v4';
import { AttendanceLevelError, attendanceLevelProblemMessageKey } from '@/lib/attendance-workflow-v3';
import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { saveAttendanceWorkflow, retireAttendanceWorkflow, restoreAttendanceWorkflow, getAttendanceWorkflow, setAttendanceWorkflowEnabled, previewAttendanceWorkflow, AttendanceWorkflowError, type AttendanceWorkflowInput, type AttendanceApplicationType } from '@/packs/attendance/service';
const LIST = '/admin/attendance/approval-workflow';
async function publicError(e: unknown) { if(e instanceof AttendanceCcError)return(await getTranslations('attendanceWorkflow.v4'))(e.code);if(e instanceof AttendanceWorkflowError&&e.code==='inUse')return(await getTranslations('attendanceWorkflow.v4'))('deletePending');if(e instanceof AttendanceWorkflowError&&e.code==='stale')return(await getTranslations('attendanceWorkflow.v4'))('deleteChanged'); if (e instanceof AttendanceLevelError) return (await getTranslations('attendanceWorkflow.v3'))(attendanceLevelProblemMessageKey(e.problem)); return e instanceof AttendanceWorkflowError ? e.message : 'The workflow could not be saved. Check the configuration and try again.'; }
export async function saveAttendanceWorkflowAction(lineageId: string | null, input: AnyAttendanceWorkflowInput) {
    const { s, scopeIds } = await scopedAdmin();
    if (!scopeIds.includes(input.companyId))
        return { ok: false as const, error: 'Select a company in your active access scope.' };
    try {
        const row = await saveAttendanceWorkflow(s, input, lineageId ?? undefined);
        revalidatePath(LIST);
        revalidatePath(`${LIST}/${row.lineageId}`);
        revalidatePath(`${LIST}/${row.lineageId}/edit`);
        return { ok: true as const, lineageId: row.lineageId };
    }
    catch (e) {
        return { ok: false as const, error: await publicError(e), levelProblem: e instanceof AttendanceLevelError ? e.problem : null };
    }
}
export async function previewAttendanceWorkflowAction(lineageId: string | null, input: AnyAttendanceWorkflowInput) {
    const { s, scopeIds } = await scopedAdmin();
    if (!scopeIds.includes(input.companyId))
        return { ok: false as const, error: 'Select a company in your active access scope.' };
    try {
        return { ok: true as const, preview: await previewAttendanceWorkflow(s, input, lineageId ?? undefined) };
    }
    catch (e) {
        return { ok: false as const, error: await publicError(e), levelProblem: e instanceof AttendanceLevelError ? e.problem : null };
    }
}
export async function setAttendanceWorkflowEnabledAction(companyId: string, type: AttendanceApplicationType, enabled: boolean) {
    const { s, scopeIds } = await scopedAdmin();
    if (!scopeIds.includes(companyId))
        return { ok: false as const, error: 'Select a company in your active access scope.' };
    try {
        await setAttendanceWorkflowEnabled(s, companyId, type, enabled);
        revalidatePath(LIST);
        return { ok: true as const };
    }
    catch (e) {
        return { ok: false as const, error: await publicError(e), levelProblem: e instanceof AttendanceLevelError ? e.problem : null };
    }
}

export async function retireAttendanceWorkflowAction(lineageId:string,version:number) {
 const {s,scopeIds}=await scopedAdmin();
 try{const current=await getAttendanceWorkflow(s,lineageId,scopeIds);if(!current)throw new AttendanceWorkflowError('stale','The workflow changed. Reload.');await retireAttendanceWorkflow(s,lineageId,version);revalidatePath(LIST);revalidatePath(`${LIST}/${lineageId}`);return{ok:true as const,companyId:current.companyId,applicationType:current.applicationType};}
 catch(error){return{ok:false as const,error:await publicError(error)};}
}
export async function restoreAttendanceWorkflowAction(lineageId:string,version:number) {
 const {s,scopeIds}=await scopedAdmin();
 try{const row=await restoreAttendanceWorkflow(s,lineageId,version,scopeIds);revalidatePath(LIST);revalidatePath(`${LIST}/${lineageId}`);return{ok:true as const,lineageId:row.lineageId};}
 catch(error){return{ok:false as const,error:await publicError(error)};}
}
