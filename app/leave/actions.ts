'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { listLeaveTypes, myEmployment } from '@/core/read';
import {
  addLeaveAttachment,
  adminCancelLeave,
  cancelOwnLeave,
  decideLeave,
  editLeaveRequest,
  requestLeave,
  requestLeaveCancellation,
  previewLeaveDeduction,
  validateLeaveDocument,
  isEmergencyReasonCategory,
  todayInKualaLumpur,
  type LeaveDurationType,
} from '@/core/leave';
import { localizeLeaveError } from '@/app/me/actions';

/** Feedback 31474452 (Step 5): read-only pre-submission preview for the Leave-tab form (which can apply
 *  on-behalf-of any employment the caller can see, via the Field label={t('fieldEmployee')} select). Runs
 *  under the caller's own session — RLS on leave_ledger/leave_type gates disclosure exactly as requestLeave
 *  does; an out-of-scope employmentId simply yields an RLS-empty balance rather than a throw. */
export async function previewLeaveDeductionAction(p: {
  employmentId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  durationType: LeaveDurationType;
}) {
  const session = await getSession();
  if (!p.employmentId || !p.leaveTypeId || !p.startDate || !p.endDate) return null;
  try {
    return await previewLeaveDeduction(session, p);
  } catch {
    return null; // preview is best-effort — the submit action remains the authoritative gate
  }
}

export async function requestLeaveAction(formData: FormData) {
  const session = await getSession();
  const leaveTypeId = String(formData.get('leaveTypeId'));
  const durationType = (String(formData.get('durationType') || 'full_day') as LeaveDurationType);
  // Hourly-leave time window (0129): the form now posts a From/To window (not a raw hours number) for hourly
  // leave; the service derives hours from the span. Empty ⇒ undefined ⇒ the service throws its mandatory gate.
  const fromTime = String(formData.get('fromTime') ?? '').trim();
  const toTime = String(formData.get('toTime') ?? '').trim();
  // Emergency Leave (Phase-B #12): category routes the cascade (illness → paid SICK first); the consent
  // checkbox gates an UNPAID child. Both are inert for non-EL types.
  const reasonCategoryRaw = String(formData.get('reasonCategory') ?? '').trim();
  const reasonCategory = isEmergencyReasonCategory(reasonCategoryRaw) ? reasonCategoryRaw : undefined;
  const unpaidConsent = String(formData.get('unpaidConsent') ?? '') === 'on';
  // Phase-B #13 (ADR-0062): maternity-only s.37 paid-allowance facts. Inert for non-maternity types (the
  // service only reads them for a MATERNITY request). Empty inputs ⇒ undefined ⇒ conservative paid default.
  const survivingChildrenRaw = String(formData.get('survivingChildren') ?? '').trim();
  const confinementDateRaw = String(formData.get('confinementDate') ?? '').trim();
  // Supporting-document config: read the optional file + remark (mirrors /me's myRequestLeave). The remark
  // is required server-side only when the selected type sets employeeRemarkRequired; an empty box → undefined.
  const file = formData.get('document');
  const hasFile = file instanceof File && file.size > 0;
  const employeeRemark = String(formData.get('employeeRemark') ?? '').trim() || undefined;
  // Resolve the selected type once. This is NOT mirroring /me's listEligibleLeaveTypesFor eligibility filter:
  // the Leave-Tab dropdown renders the unfiltered listLeaveTypes (it can apply on behalf of an employee who
  // may be ineligible), and requestLeave re-runs assertEligible server-side. We only need the localized name
  // (for errors) and the mime/size config (for the orphan-prevention pre-check) here.
  const locale = await getLocale();
  const types = await listLeaveTypes(session, { locale });
  const selected = types.find((t) => t.id === leaveTypeId);
  // Emergency Leave (0106) edge: EL short-circuits to requestEmergencyLeave, which decomposes into
  // ANNUAL+UNPAID child rows that hard-code employeeRemark:null and never carry a document. Attaching here
  // would dangle a file on a hidden child. So for EL we hide the fields (LeaveDurationFields) AND ignore any
  // posted file/remark here as a server-side backstop against a stale form.
  const isEL = selected?.code === 'EMERGENCY';
  const attach = hasFile && !isEL;
  // Phase-B #15: a non-blocking holiday-completeness warning is surfaced via ?warn= when the request's
  // (state, year) has fewer than the s.60D minimum of 11 gazetted holidays loaded.
  let warnQuery = '';
  try {
    // Orphan-prevention: validate the file BEFORE requestLeave commits the row + event, so a
    // disallowed/oversized file is rejected with no committed pending request left behind.
    if (attach) {
      if (!selected) {
        // The posted type isn't in the projection — we can't resolve its mime/size rule. Let requestLeave
        // reject the unknown type (it will) and never call addLeaveAttachment for an unresolved type.
        throw new Error('Leave type not found.');
      }
      validateLeaveDocument(
        { allowedMimeTypes: selected.allowedMimeTypes, maxDocBytes: selected.maxDocBytes },
        { mimeType: file.type || 'application/octet-stream', sizeBytes: file.size },
      );
    }
    const res = await requestLeave(session, {
      employmentId: String(formData.get('employmentId')),
      leaveTypeId,
      startDate: String(formData.get('startDate')),
      endDate: String(formData.get('endDate')),
      reason: (formData.get('reason') as string) || undefined,
      hasDocument: attach,
      employeeRemark: isEL ? undefined : employeeRemark,
      durationType,
      fromTime: durationType === 'hourly' && fromTime !== '' ? fromTime : undefined,
      toTime: durationType === 'hourly' && toTime !== '' ? toTime : undefined,
      reasonCategory,
      unpaidConsent,
      survivingChildren: survivingChildrenRaw !== '' ? Number(survivingChildrenRaw) : undefined,
      confinementDate: confinementDateRaw !== '' ? confinementDateRaw : undefined,
      // Configurable backdated-leave restriction (0133): tenant-local (MYT) "today" for the boundary. The
      // on-behalf admin path bypasses the limit anyway (isAdmin override), but pass it for correctness/parity.
      today: todayInKualaLumpur(),
    });
    if (attach && file instanceof File) {
      // Same server-action session that just created the row, so the new pending request is visible to this
      // RLS session (transitively, also for the on-behalf-of admin). Order matters: addLeaveAttachment
      // requires status==='pending', which is exactly the state requestLeave leaves it in.
      await addLeaveAttachment(session, {
        leaveRequestId: res.leaveRequestId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
    const w = res.holidayWarnings?.[0];
    if (w) {
      warnQuery = `?warnHoliday=1&loaded=${w.loaded}&state=${encodeURIComponent(w.state ?? '')}&year=${w.year}`;
    }
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e, selected?.name))}`);
  }
  revalidatePath('/leave');
  redirect(`/leave${warnQuery}`);
}

// Partial Leave Cancellation (ADR-0065): an employee gives back a SUBSET of an approved leave's dates. The
// checkboxes post one `cancelDate` value per ticked future working day. requestLeaveCancellation re-runs every
// gate server-side (subject-only, approved+full_day+non-EL+non-REPLACEMENT, per-date future, closed-period,
// pending-overlap) so a stale form can't slip a bad date through. Revalidate /leave, /approvals, and / so the
// manager's inbox and the dashboard Planned Absences both pick up the new pending request.
export async function requestLeaveCancellationAction(formData: FormData) {
  const session = await getSession();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  const cancelDates = formData.getAll('cancelDate').map((d) => String(d)).filter(Boolean);
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  try {
    // R5 Build #2 (Fix B): pass MYT "today" so the per-date "hasn't started yet" gate uses Malaysia time
    // (mirrors requestLeaveAction). Import already present at the top of this file.
    await requestLeaveCancellation(session, { leaveRequestId, cancelDates, reason, today: todayInKualaLumpur() });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  revalidatePath('/approvals');
  revalidatePath('/');
  redirect('/leave?toast=cancellationRequested');
}

// HR Admin Leave Cancellation on behalf of an employee (feedback 22e68ff0). Immediate, no approval workflow:
// adminCancelLeave re-runs every gate server-side (HR-only, self-ban, pending|approved status, approved-
// REPLACEMENT block, closed-payroll block) so a stale form can't slip through. The `back` field lands the
// caller back where they started — '/' from the dashboard calendar, '/leave' from Leave Management — with the
// record list refreshed. We pass the real HR actor via cancelledByEmploymentId (deciderEmploymentId pattern).
export async function adminCancelLeaveAction(formData: FormData) {
  const session = await getSession();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  // Whitelist the return surface so a crafted form can't redirect off-app.
  const back = String(formData.get('back') ?? '') === '/' ? '/' : '/leave';
  try {
    const me = await myEmployment(session);
    await adminCancelLeave(session, { leaveRequestId, reason, cancelledByEmploymentId: me?.employmentId });
  } catch (e) {
    redirect(`${back}?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  revalidatePath('/approvals');
  revalidatePath('/');
  redirect(`${back}?toast=adminCancelled`);
}

// Edit / cancel own leave by status (item c9a19e34): an employee edits or withdraws their OWN PENDING leave
// from the /leave history table. Both re-run every gate server-side (subject-only + status='pending'). The
// listLeaveTypes lookup supplies the localized type name for any validation error message.
export async function editLeaveAction(formData: FormData) {
  const session = await getSession();
  const leaveTypeId = String(formData.get('leaveTypeId'));
  const durationType = String(formData.get('durationType') || 'full_day') as LeaveDurationType;
  const fromTime = String(formData.get('fromTime') ?? '').trim();
  const toTime = String(formData.get('toTime') ?? '').trim();
  const locale = await getLocale();
  const types = await listLeaveTypes(session, { locale });
  const selected = types.find((t) => t.id === leaveTypeId);
  try {
    await editLeaveRequest(session, {
      leaveRequestId: String(formData.get('leaveRequestId')),
      leaveTypeId,
      startDate: String(formData.get('startDate')),
      endDate: String(formData.get('endDate')),
      reason: (formData.get('reason') as string) || undefined,
      employeeRemark: (formData.get('employeeRemark') as string) || undefined,
      durationType,
      fromTime: durationType === 'hourly' && fromTime !== '' ? fromTime : undefined,
      toTime: durationType === 'hourly' && toTime !== '' ? toTime : undefined,
      today: todayInKualaLumpur(),
    });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e, selected?.name))}`);
  }
  revalidatePath('/leave');
  redirect('/leave?toast=leaveUpdated');
}

export async function cancelOwnLeaveAction(formData: FormData) {
  const session = await getSession();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  try {
    await cancelOwnLeave(session, { leaveRequestId });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  revalidatePath('/approvals');
  redirect('/leave?toast=leaveCancelled');
}

export async function decideLeaveAction(formData: FormData) {
  const session = await getSession();
  // Partial Leave Approval (0131): thread the reject-reason (required on rejection) through the Leave-tab
  // decide path too, so decideLeave enforces it uniformly and stamps it onto the rejected event.
  const rejectReason = String(formData.get('rejectReason') || '') || undefined;
  try {
    await decideLeave(session, {
      leaveRequestId: String(formData.get('leaveRequestId')),
      decision: String(formData.get('decision')) as 'approved' | 'rejected',
      rejectReason,
    });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  redirect('/leave');
}
