'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, listEligibleLeaveTypesFor } from '@/core/read';
import {
  addLeaveAttachment,
  requestLeave,
  validateLeaveDocument,
  isEmergencyReasonCategory,
  todayInKualaLumpur,
  LeaveBackdatingNotAllowedError,
  LeaveDocumentRequiredError,
  LeaveRemarkRequiredError,
  LeaveDocumentTypeError,
  LeaveDocumentSizeError,
  UnpaidConsentRequiredError,
  HourlyLeaveTimeRangeError,
  LeaveNoDaysInRangeError,
  MissingRejectReasonError,
  LeaveCancellationNotAllowedError,
  LeaveCancellationTooLateError,
  LeaveCancellationDateInvalidError,
  LeaveCancellationPeriodClosedError,
  type LeaveDurationType,
} from '@/core/leave';
import {
  checkIn,
  checkOut,
  requestAttendanceCorrection,
  GeolocationRequiredError,
  OutsideGeofenceError,
} from '@/core/attendance';
import { requestProfileChange, updateOwnContact, type ProfileChangeProposed } from '@/core/profile';
import { saveTp1Draft, submitTp1 } from '@/core/tax-relief';
import { submitResignation, withdrawResignation } from '@/core/offboarding';
import {
  createGoal,
  declinePeerFeedback,
  submitPeerFeedback,
  updateGoal,
  updateGoalProgress,
  type GoalStatus,
} from '@/core/performance';

/** Resolve the caller's own employment from the session — never from a form field. */
async function resolveMe() {
  const s = await getSession();
  const me = await myEmployment(s);
  if (!me) throw new Error('This account is not linked to an employee profile.');
  return { s, employmentId: me.employmentId };
}

function nowParts() {
  const d = new Date();
  return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 5) };
}

export async function myRequestLeave(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const leaveTypeId = String(formData.get('leaveTypeId'));
  const startDate = String(formData.get('startDate'));
  const endDate = String(formData.get('endDate'));
  const durationType = String(formData.get('durationType') || 'full_day') as LeaveDurationType;
  // Hourly-leave time window (0129): the form posts a From/To window for hourly leave; the service derives
  // hours from the span. Empty ⇒ undefined ⇒ the service throws HourlyLeaveTimeRangeError (mandatory gate).
  const fromTime = String(formData.get('fromTime') ?? '').trim();
  const toTime = String(formData.get('toTime') ?? '').trim();
  const employeeRemark = String(formData.get('employeeRemark') ?? '').trim() || undefined;
  const file = formData.get('document');
  const hasFile = file instanceof File && file.size > 0;
  // Emergency Leave (Phase-B #12): reason category routes the cascade (illness → paid SICK first), and the
  // unpaid-consent checkbox gates an UNPAID child. Both are inert for non-EL types (the service ignores them).
  const reasonCategoryRaw = String(formData.get('reasonCategory') ?? '').trim();
  const reasonCategory = isEmergencyReasonCategory(reasonCategoryRaw) ? reasonCategoryRaw : undefined;
  const unpaidConsent = String(formData.get('unpaidConsent') ?? '') === 'on';

  const locale = await getLocale();
  // Supporting-document config: resolve the selected type once — supplies the localized name for error
  // messages AND the mime/size rule for the pre-check. listEligibleLeaveTypesFor is the same source the
  // /me dropdown renders from, so the type is always present here.
  const types = await listEligibleLeaveTypesFor(s, employmentId, locale);
  const selected = types.find((t) => t.id === leaveTypeId);

  try {
    // Orphan-prevention (the headline fix): validate the file BEFORE requestLeave commits the row + event.
    // A disallowed/oversized file is rejected here, so no committed pending request is left behind.
    if (hasFile && selected) {
      validateLeaveDocument(
        { allowedMimeTypes: selected.allowedMimeTypes, maxDocBytes: selected.maxDocBytes },
        { mimeType: file.type || 'application/octet-stream', sizeBytes: file.size },
      );
    }
    const { leaveRequestId } = await requestLeave(s, {
      employmentId,
      leaveTypeId,
      startDate,
      endDate,
      hasDocument: hasFile,
      employeeRemark,
      durationType,
      fromTime: durationType === 'hourly' && fromTime !== '' ? fromTime : undefined,
      toTime: durationType === 'hourly' && toTime !== '' ? toTime : undefined,
      reasonCategory,
      unpaidConsent,
      // Configurable backdated-leave restriction (0133): pass the tenant-local (MYT) "today" so the boundary
      // is judged in Malaysian time, not server/UTC.
      today: todayInKualaLumpur(),
    });
    if (hasFile) {
      await addLeaveAttachment(s, {
        leaveRequestId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent(await localizeLeaveError(e, selected?.name))}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Leave+requested');
}

/** Supporting-document config: re-localize the structured service/validation errors into the viewer's
 *  language (they reach ms/ta/th/vi/zh via ?error=). Unknown errors fall back to their English message.
 *  Exported so the Leave-Tab action (app/leave/actions.ts) reuses the same localizer rather than copying
 *  it — both forms now share the document/remark error wording. */
export async function localizeLeaveError(e: unknown, typeName?: string): Promise<string> {
  const t = await getTranslations('leave.errors');
  const name = typeName ?? '';
  if (e instanceof LeaveDocumentRequiredError) {
    return e.afterDays != null
      ? t('documentRequiredAfter', { typeName: name, days: e.afterDays })
      : t('documentRequired', { typeName: name });
  }
  if (e instanceof LeaveRemarkRequiredError) return t('employeeRemarkRequired', { typeName: name });
  if (e instanceof LeaveBackdatingNotAllowedError)
    return t('backdatingNotAllowed', { typeName: name, days: e.limitDays });
  if (e instanceof LeaveDocumentTypeError) {
    const labels: Record<string, string> = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG' };
    return t('fileTypeNotAllowed', { allowed: e.allowed.map((m) => labels[m] ?? m).join(', ') });
  }
  if (e instanceof LeaveDocumentSizeError) return t('fileTooLarge', { mb: e.maxMb });
  if (e instanceof UnpaidConsentRequiredError) return t('unpaidConsentRequired', { days: e.unpaidDays ?? 0 });
  // Partial Leave Approval (0131): a manager rejected a leave date without a reason. Localized so the
  // approvals inbox shows the translated mandatory-reason message, not the raw English Error string.
  if (e instanceof MissingRejectReasonError) return t('rejectReasonRequired');
  // Hourly-leave time window (0129): a missing window or to <= from. Localized so admins (via leave/actions)
  // and employees (via /me) both see a translated message, not the raw English Error string.
  if (e instanceof HourlyLeaveTimeRangeError) return t('hourlyTimeRange');
  // R5 Build #3 (backdating diagnose-first): the request resolves to zero leave days — the range is empty or
  // every day is a weekend/holiday for a working_days type. A common outcome of a BACKDATED single-day leave
  // that lands on a non-working day (fires for HR admins on the on-behalf path too). Localized so the reason
  // reads clearly instead of raw English via the fallback below.
  if (e instanceof LeaveNoDaysInRangeError) return t('noLeaveDaysInRange');
  // Partial Leave Cancellation (ADR-0065): localize the cancellation gate errors.
  if (e instanceof LeaveCancellationTooLateError) return t('cancellationTooLate', { date: e.date ?? '' });
  if (e instanceof LeaveCancellationDateInvalidError) return t('cancelDateInvalid', { date: e.date ?? '' });
  if (e instanceof LeaveCancellationPeriodClosedError) return t('cancellationPeriodClosed', { date: e.date ?? '' });
  if (e instanceof LeaveCancellationNotAllowedError) return t('cancellationNotAllowed');
  return (e as Error).message;
}

export async function myRequestCorrection(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const date = String(formData.get('date'));
  const checkInTime = String(formData.get('checkIn'));
  const checkOutTime = String(formData.get('checkOut') || '');
  const reason = String(formData.get('reason') || '').trim();
  try {
    await requestAttendanceCorrection(s, {
      employmentId,
      date,
      checkIn: checkInTime,
      checkOut: checkOutTime || null,
      reason: reason || undefined,
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Correction+requested');
}

export async function myUpdateContact(formData: FormData) {
  const { s } = await resolveMe();
  try {
    await updateOwnContact(s, {
      phone: String(formData.get('phone') ?? ''),
      address: String(formData.get('address') ?? ''),
      emergencyContactName: String(formData.get('emergencyContactName') ?? ''),
      emergencyContactPhone: String(formData.get('emergencyContactPhone') ?? ''),
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Profile+updated');
}

export async function myRequestProfileChange(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  // Only carry the fields the employee actually filled — the rest are left unchanged.
  const proposed: ProfileChangeProposed = {};
  const bankName = String(formData.get('bankName') ?? '').trim();
  const bankAccountNo = String(formData.get('bankAccountNo') ?? '').trim();
  const taxCategory = String(formData.get('taxCategory') ?? '').trim();
  const numChildren = String(formData.get('numChildren') ?? '').trim();
  if (bankName) proposed.bankName = bankName;
  if (bankAccountNo) proposed.bankAccountNo = bankAccountNo;
  if (taxCategory) proposed.taxCategory = Number(taxCategory);
  if (numChildren) proposed.numChildren = Number(numChildren);
  // #24: compliance-sensitive identity fields are requested here (approval-gated), not self-applied.
  const dateOfBirth = String(formData.get('dateOfBirth') ?? '').trim();
  const gender = String(formData.get('gender') ?? '').trim();
  const maritalStatus = String(formData.get('maritalStatus') ?? '').trim();
  if (dateOfBirth) proposed.dateOfBirth = dateOfBirth;
  if (gender) proposed.gender = gender;
  if (maritalStatus) proposed.maritalStatus = maritalStatus;
  try {
    await requestProfileChange(s, { employmentId, proposed });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Change+requested+for+approval');
}

// ── Self Personal Tax Relief (ADR-0050, #1.1.3) — yearly TP1 self-service ──

export async function mySaveTp1Draft(formData: FormData) {
  const { s } = await resolveMe();
  const assessmentYear = Number(formData.get('assessmentYear'));
  const tp1Amount = Number(formData.get('tp1Amount'));
  try {
    await saveTp1Draft(s, { assessmentYear, tp1Amount });
  } catch (e) {
    redirect(`/me/tax-relief?year=${assessmentYear}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me/tax-relief');
  redirect(`/me/tax-relief?year=${assessmentYear}&toast=Draft+saved`);
}

export async function mySubmitTp1(formData: FormData) {
  const { s } = await resolveMe();
  const assessmentYear = Number(formData.get('assessmentYear'));
  const tp1Amount = Number(formData.get('tp1Amount'));
  try {
    await submitTp1(s, { assessmentYear, tp1Amount });
  } catch (e) {
    redirect(`/me/tax-relief?year=${assessmentYear}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me/tax-relief');
  redirect(`/me/tax-relief?year=${assessmentYear}&toast=TP1+submitted`);
}

// ── Resignation (ADR-0042, #29) — employee-initiated, HR-approved offboarding ──

export async function mySubmitResignation(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const lastWorkingDay = String(formData.get('lastWorkingDay') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  try {
    await submitResignation(s, { employmentId, lastWorkingDay, reason: reason || null });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Resignation+submitted');
}

export async function myWithdrawResignation(formData: FormData) {
  const { s } = await resolveMe();
  const requestId = String(formData.get('requestId'));
  try {
    await withdrawResignation(s, { requestId });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Resignation+withdrawn');
}

/** ADR-0069: parse the optional hidden lat/lng fields the client-side geolocation capture writes.
 *  Missing/blank/non-finite ⇒ undefined — the server decides whether that's fatal (geofencing ON) or
 *  harmless (geofencing OFF), never the client. */
function parseGeo(formData: FormData): { lat: number; lng: number } | undefined {
  const latRaw = formData.get('lat');
  const lngRaw = formData.get('lng');
  if (latRaw == null || lngRaw == null || latRaw === '' || lngRaw === '') return undefined;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

/** ADR-0069: localize the two geofencing errors into the viewer's own language; everything else falls
 *  back to its raw message (mirrors localizeLeaveError's shape). */
async function localizeClockError(e: unknown): Promise<string> {
  const t = await getTranslations('me');
  if (e instanceof OutsideGeofenceError) return t('outsideGeofence');
  if (e instanceof GeolocationRequiredError) return t('locationRequired');
  return (e as Error).message;
}

export async function myCheckIn(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const { date, time } = nowParts();
  try {
    await checkIn(s, { employmentId, date, time, geo: parseGeo(formData) });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent(await localizeClockError(e))}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Checked+in');
}

export async function myCheckOut(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const { date, time } = nowParts();
  try {
    await checkOut(s, { employmentId, date, time, geo: parseGeo(formData) });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent(await localizeClockError(e))}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Checked+out');
}

// ── Goals (ADR-0022) — the employee's own continuous goals ──

const strOrUndef = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s === '' ? undefined : s;
};

export async function myCreateGoal(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const title = String(formData.get('title') ?? '').trim();
  const weightRaw = strOrUndef(formData.get('weight'));
  try {
    await createGoal(s, {
      employmentId,
      title,
      description: strOrUndef(formData.get('description')),
      metric: strOrUndef(formData.get('metric')),
      target: strOrUndef(formData.get('target')),
      dueOn: strOrUndef(formData.get('dueOn')) ?? null,
      weight: weightRaw != null ? Number(weightRaw) : null,
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Goal+added');
}

export async function myUpdateGoalProgress(formData: FormData) {
  const s = await getSession();
  const goalId = String(formData.get('goalId'));
  try {
    await updateGoalProgress(s, {
      goalId,
      progress: Number(formData.get('progress')) || 0,
      status: String(formData.get('status')) as GoalStatus,
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Goal+updated');
}

export async function mySubmitPeerFeedback(formData: FormData) {
  const s = await getSession();
  try {
    await submitPeerFeedback(s, {
      requestId: String(formData.get('requestId')),
      strengths: strOrUndef(formData.get('strengths')),
      improvements: strOrUndef(formData.get('improvements')),
      named: formData.get('named') === 'on',
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Feedback+submitted');
}

export async function myDeclinePeerFeedback(formData: FormData) {
  const s = await getSession();
  try {
    await declinePeerFeedback(s, { requestId: String(formData.get('requestId')) });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Declined');
}

export async function myEditGoal(formData: FormData) {
  const s = await getSession();
  const goalId = String(formData.get('goalId'));
  try {
    await updateGoal(s, {
      goalId,
      title: strOrUndef(formData.get('title')),
      description: strOrUndef(formData.get('description')) ?? '',
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Goal+updated');
}
