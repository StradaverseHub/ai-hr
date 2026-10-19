'use server';
import { getTranslations } from 'next-intl/server';
import { AttendanceLevelError, attendanceLevelProblemMessageKey, type AnyAttendanceWorkflowInput } from '@/lib/attendance-workflow-v3';
import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled, previewAttendanceWorkflow, AttendanceWorkflowError, type AttendanceWorkflowInput, type AttendanceApplicationType } from '@/packs/attendance/service';
const LIST = '/admin/attendance/approval-workflow';
async function publicError(e: unknown) { if (e instanceof AttendanceLevelError) return (await getTranslations('attendanceWorkflow.v3'))(attendanceLevelProblemMessageKey(e.problem)); return e instanceof AttendanceWorkflowError ? e.message : 'The workflow could not be saved. Check the configuration and try again.'; }
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
