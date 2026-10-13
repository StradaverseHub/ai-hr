'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationDetail, decideAttendanceCorrection, cancelAttendanceApplication } from '@/packs/attendance/service';
import { publicErrorMessage } from '@/lib/public-error';
export async function attendanceHistoryAction(form: FormData) {
    const { s, scopeIds } = await scopedAdmin(), id = String(form.get('id') ?? ''), action = String(form.get('action') ?? ''), reason = String(form.get('reason') ?? '').trim();
    const detail = await attendanceApplicationDetail(s, scopeIds, id);
    if (!detail)
        throw new Error('Attendance application not found or not visible.');
    let error: string | null = null;
    try {
        if (action === 'approved' || action === 'rejected') {
            if (!detail.canDecide)
                throw new Error('This application is not waiting for your decision.');
            await decideAttendanceCorrection(s, { correctionId: id, decision: action, rejectReason: reason, remarks: reason, expectedStageIndex: form.get('workflowStage') ? Number(form.get('workflowStage')) : undefined });
        }
        else if (action === 'cancelled' || action === 'withdrawn') {
            if (!detail.canCancel)
                throw new Error('This application cannot be cancelled.');
            await cancelAttendanceApplication(s, { correctionId: id, kind: action, reason });
        }
        else
            throw new Error('Invalid attendance action.');
    }
    catch (e) {
        error = publicErrorMessage(e);
    }
    for (const path of ['/attendance/application-history', '/attendance/request-status', '/attendance/plan-ot', '/approvals', '/attendance'])
        revalidatePath(path);
    revalidatePath(`/attendance/application-history/${id}`);
    redirect(`/attendance/application-history/${id}${error ? '?error=' + encodeURIComponent(error) : ''}`);
}
