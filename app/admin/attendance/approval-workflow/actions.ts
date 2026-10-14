'use server';
import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled, previewAttendanceWorkflow, AttendanceWorkflowError, type AttendanceWorkflowInput, type AttendanceApplicationType } from '@/packs/attendance/service';
const LIST = '/admin/attendance/approval-workflow';
function publicError(e: unknown) { return e instanceof AttendanceWorkflowError ? e.message : 'The workflow could not be saved. Check the configuration and try again.'; }
export async function saveAttendanceWorkflowAction(lineageId: string | null, input: AttendanceWorkflowInput) {
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
        return { ok: false as const, error: publicError(e) };
    }
}
export async function previewAttendanceWorkflowAction(lineageId: string | null, input: AttendanceWorkflowInput) {
    const { s, scopeIds } = await scopedAdmin();
    if (!scopeIds.includes(input.companyId))
        return { ok: false as const, error: 'Select a company in your active access scope.' };
    try {
        return { ok: true as const, preview: await previewAttendanceWorkflow(s, input, lineageId ?? undefined) };
    }
    catch (e) {
        return { ok: false as const, error: publicError(e) };
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
        return { ok: false as const, error: publicError(e) };
    }
}
