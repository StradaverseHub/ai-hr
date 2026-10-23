'use server';
import { attendanceHistoryReturn } from '@/lib/attendance-history-filter';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { decideAttendanceHistorySelection, type AttendanceHistorySelection, attendanceApplicationDetail, decideAttendanceCorrection, cancelAttendanceApplication, reassignAttendanceWorkflowStageToHr } from '@/packs/attendance/service';
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
            await decideAttendanceCorrection(s, { correctionId: id, decision: action, rejectReason: reason, remarks: reason, expectedStageIndex: form.get('workflowStage') ? Number(form.get('workflowStage')) : undefined, expectedParticipantSlot: String(form.get('workflowParticipant') ?? '') || undefined });
        }
        else if (action === 'reassign_hr') {
            const stage = String(form.get('workflowStage') ?? '');
            if (!detail.canReassign || (detail.workflow?.routingVersion !== 2 && (detail.workflow?.routingVersion !== 3 && detail.workflow?.routingVersion !== 4)) || !/^\d+$/.test(stage)) throw new Error('This application has no pending level to reassign.');
            await reassignAttendanceWorkflowStageToHr(s, { correctionId: id, expectedStageIndex: Number(stage), expectedParticipantSlot: String(form.get('workflowParticipant') ?? '') || undefined, reason });
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
    const q=new URLSearchParams({returnTo:attendanceHistoryReturn(String(form.get('returnTo')??''))});if(error)q.set('error',error);
    redirect(`/attendance/application-history/${id}?${q}`);
}

export async function attendanceHistoryBulkAction(p:{items:AttendanceHistorySelection[];decision:'approved'|'rejected';reason:string}){
  const {s,scopeIds}=await scopedAdmin();
  const results=await decideAttendanceHistorySelection(s,scopeIds,p);
  for(const path of ['/attendance/application-history','/attendance/request-status','/attendance/requests','/attendance/plan-ot','/approvals','/attendance','/attendance/individual','/attendance/daily','/attendance/my-records'])revalidatePath(path);
  revalidatePath('/attendance/application-history/[id]','page');revalidatePath('/attendance/individual/[date]','page');
  return results;
}
