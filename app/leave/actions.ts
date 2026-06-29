'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { listLeaveTypes } from '@/core/read';
import {
  addLeaveAttachment,
  decideLeave,
  requestLeave,
  validateLeaveDocument,
  isEmergencyReasonCategory,
  type LeaveDurationType,
} from '@/core/leave';
import { localizeLeaveError } from '@/app/me/actions';

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

export async function decideLeaveAction(formData: FormData) {
  const session = await getSession();
  try {
    await decideLeave(session, {
      leaveRequestId: String(formData.get('leaveRequestId')),
      decision: String(formData.get('decision')) as 'approved' | 'rejected',
    });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/leave');
  redirect('/leave');
}
