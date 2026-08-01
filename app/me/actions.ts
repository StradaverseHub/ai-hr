'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, listEligibleLeaveTypesFor } from '@/core/read';
import {
  addLeaveAttachment,
  requestLeave,
  editLeaveRequest,
  cancelOwnLeave,
  requestLeaveCancellation,
  previewLeaveDeduction,
  validateLeaveDocument,
  isEmergencyReasonCategory,
  todayInKualaLumpur,
  LeaveEditNotAllowedError,
  LeaveBackdatingNotAllowedError,
  LeaveAdvanceNoticeRequiredError,
  LeaveYearNotOpenError,
  LeaveDocumentRequiredError,
  LeaveRemarkRequiredError,
  LeaveDocumentTypeError,
  LeaveDocumentSizeError,
  UnpaidConsentRequiredError,
  HourlyLeaveTimeRangeError,
  LeaveNoDaysInRangeError,
  DuplicateLeaveApplicationError,
  InsufficientLeaveBalanceOnSubmitError,
  CombinedLeaveLimitExceededError,
  CombinedLeaveApplicationTooLongError,
  LeaveTypeApplicationTooLongError,
  LeaveYearApplicationLimitExceededError,
  LeaveApplyNotAllowedError,
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
  DeviceNotRegisteredError,
} from '@/packs/attendance/service';
import { requestTravel } from '@/core/travel-request';
import { requestProfileChange, updateOwnContact, type ProfileChangeProposed } from '@/core/profile';
import { saveTp1Draft, submitTp1 } from '@/core/tax-relief';
import { addResignationAttachment, submitResignation, withdrawResignation } from '@/core/offboarding';
import { LeaveBalanceFrozenError } from '@/core/leave-encashment';
import {
  createGoal,
  declinePeerFeedback,
  submitPeerFeedback,
  updateGoal,
  updateGoalProgress,
  type GoalStatus,
} from '@/packs/performance/service';

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

/** Feedback 31474452 (Step 5): read-only pre-submission preview for the /me leave form — "this will deduct X
 *  day(s)" + balance before/after — called from the client via useTransition (see
 *  components/leave-duration-fields.tsx). Always resolves the CALLER'S OWN employment (never a form field —
 *  `employmentId` on `p` is accepted only so this matches the shared preview `action` prop shape with the
 *  /leave form and is IGNORED here), same trust boundary as myRequestLeave. Day-based durations only. */
export async function myPreviewLeaveDeduction(p: {
  employmentId?: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  durationType: LeaveDurationType;
}) {
  const { s, employmentId } = await resolveMe();
  if (!p.leaveTypeId || !p.startDate || !p.endDate) return null;
  try {
    return await previewLeaveDeduction(s, {
      employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      endDate: p.endDate,
      durationType: p.durationType,
    });
  } catch {
    return null; // preview is best-effort — the submit action remains the authoritative gate
  }
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

// ── Edit / cancel own leave by status (item c9a19e34) ──
// Status-gated ESS self-service on the caller's OWN leave: a PENDING request can be edited (stays pending) or
// withdrawn immediately; an APPROVED request is routed to the manager-approved give-back flow (Option A /
// ADR-0065); a REJECTED request has no action. Every action resolves the caller's own employment server-side
// (never a form field) — the same trust boundary as myRequestLeave — and the core service re-asserts
// subject-only + status authoritatively, so a stale form can't act on someone else's or a non-pending row.
// a7cbd895: the Leave tab moved from /me to /leave ("My Absence"), so these actions now land back on
// /leave — the services they call are unchanged. (The old /me leave-tab address also redirects there.)

/** Edit a PENDING own leave in place (stays pending). Mirrors myRequestLeave's field parsing; the service
 *  re-runs every validation gate against the new details. */
export async function myEditLeave(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  const leaveTypeId = String(formData.get('leaveTypeId'));
  const startDate = String(formData.get('startDate'));
  const endDate = String(formData.get('endDate'));
  const durationType = String(formData.get('durationType') || 'full_day') as LeaveDurationType;
  const fromTime = String(formData.get('fromTime') ?? '').trim();
  const toTime = String(formData.get('toTime') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  const employeeRemark = String(formData.get('employeeRemark') ?? '').trim() || undefined;
  // Resolve the selected type's localized name for any validation error message (mirrors myRequestLeave).
  const locale = await getLocale();
  const types = await listEligibleLeaveTypesFor(s, employmentId, locale);
  const selected = types.find((t) => t.id === leaveTypeId);
  try {
    await editLeaveRequest(s, {
      leaveRequestId,
      leaveTypeId,
      startDate,
      endDate,
      reason,
      employeeRemark,
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

/** Withdraw a PENDING own leave immediately (→ cancelled). */
export async function myCancelLeave(formData: FormData) {
  const { s } = await resolveMe();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  try {
    await cancelOwnLeave(s, { leaveRequestId });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  redirect('/leave?toast=leaveCancelled');
}

/** Request cancellation (give-back) of an APPROVED own leave — the manager-approved flow (Option A / ADR-0065).
 *  The dialog posts one `cancelDate` per whole-span working date; the service re-runs every give-back gate. */
export async function myRequestLeaveCancellation(formData: FormData) {
  const { s } = await resolveMe();
  const leaveRequestId = String(formData.get('leaveRequestId'));
  const cancelDates = formData.getAll('cancelDate').map((d) => String(d)).filter(Boolean);
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  try {
    await requestLeaveCancellation(s, { leaveRequestId, cancelDates, reason, today: todayInKualaLumpur() });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  revalidatePath('/approvals');
  redirect('/leave?toast=cancellationRequested');
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
  // Edit/cancel-by-status (item c9a19e34): the leave is not in an editable state (only PENDING plain rows
  // are editable) or the row is grouped/per-date. Localized so all 6 locales see a clear message.
  if (e instanceof LeaveEditNotAllowedError) return t('editNotAllowed');
  // Custom validation messages (custom-messages migration): when HR configured an override message for the
  // backdating rule, the service passes it through the typed error verbatim — render it as-is (do NOT
  // re-localize or interpolate an admin-authored free-text string). Absent ⇒ the built-in localized default.
  if (e instanceof LeaveBackdatingNotAllowedError)
    return e.customMessage ?? t('backdatingNotAllowed', { typeName: name, days: e.limitDays });
  // Minimum advance-notice rule (0159): same custom-message-verbatim-else-localized-default contract as the
  // backdating branch above.
  if (e instanceof LeaveAdvanceNoticeRequiredError)
    return e.customMessage ?? t('advanceNoticeRequired', { typeName: name, days: e.minDays });
  // Leave Year Configuration (9aa894a4): the employee applied for a future leave year that HR has not opened
  // for applications yet. Localized so all 6 locales see a clear "{year} isn't open yet" message.
  if (e instanceof LeaveYearNotOpenError) return t('leaveYearNotOpen', { year: e.year });
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
  // Duplicate Leave Application Restriction (d5e51c34): the leave type's duplicate_application_policy blocked
  // this same-date double-booking. Localized so all 6 locales see the reporter's requested message.
  if (e instanceof DuplicateLeaveApplicationError) return t('duplicateApplication');
  // Configurable Negative Leave Balance Validation (0ef0defd): the leave type's allow_negative_balance=false
  // blocked a submit/edit whose days exceed the available balance. Localized so all 6 locales see the
  // reporter's requested message ("Insufficient leave balance. Your available leave balance is lower…").
  if (e instanceof InsufficientLeaveBalanceOnSubmitError) return t('insufficientBalance');
  // Combined Leave Type Limit (R44 4c48fd1f, Stage 2): the shared scheme pool cap would be breached across
  // its member leave types. Localized so all 6 locales show which pool + total was exceeded.
  if (e instanceof CombinedLeaveLimitExceededError)
    return t('combinedLimitExceeded', { poolName: e.poolName, days: e.totalLimitDays });
  // Shared Leave Group per-application cap (r82a 1ef1cf95): a DIFFERENT refusal from the one above — the
  // year's shared pool may be untouched; this single application is simply longer than the group allows.
  // Localized separately so the employee is told to shorten the application, not that their days are spent.
  if (e instanceof CombinedLeaveApplicationTooLongError)
    return t('combinedApplicationTooLong', {
      poolName: e.poolName,
      maxDays: e.maxDaysPerApplication,
      days: e.requestedSpanDays,
    });
  // Maximum Consecutive Leave (c6ffa725 rev 2): a FOURTH refusal, and specifically NOT the one above. That
  // one names a shared leave GROUP and is fixed on the group; this names the leave TYPE and is fixed on the
  // type. Both can be configured at once — core/leave.ts composes them and only the binding one is thrown —
  // so handing an employee the wrong one would send them to change a rule that was not refusing them. The
  // UNIT is passed through because the number alone is ambiguous: "at most 3 days, this one covers 4" reads
  // as a mistake to somebody who counted 2 working days.
  if (e instanceof LeaveTypeApplicationTooLongError)
    return t('leaveTypeApplicationTooLong', {
      typeName: e.leaveTypeName,
      maxDays: e.maxConsecutiveDays,
      unit: t(e.unit === 'working_days' ? 'consecutiveUnitWorking' : 'consecutiveUnitCalendar'),
      days: e.requestedSpanDays,
    });
  // Application Limits (c6ffa725): a THIRD, distinct refusal — this leave TYPE's own annual application
  // ceiling, which applies whether or not the type has any entitlement balance. Named separately from the
  // two shared-pool refusals above because the configuration to change is a different one: the leave type,
  // not a benefit scheme's shared group.
  if (e instanceof LeaveYearApplicationLimitExceededError)
    return t('leaveYearApplicationLimit', {
      typeName: e.leaveTypeName,
      maxDays: e.maxDaysPerLeaveYear,
      usedDays: e.usedDays,
      yearStart: e.yearStart,
      yearEnd: e.yearEnd,
      days: e.requestedDays,
    });
  // Leave Type Employee Visibility (7b11f1c1): HR has closed this leave type to employee applications
  // (employee_can_apply=false). Localized so the /me apply form shows a clear "contact HR" message.
  if (e instanceof LeaveApplyNotAllowedError) return t('applyNotAllowed', { typeName: name });
  // Partial Leave Cancellation (ADR-0065): localize the cancellation gate errors.
  if (e instanceof LeaveCancellationTooLateError) return t('cancellationTooLate', { date: e.date ?? '' });
  if (e instanceof LeaveCancellationDateInvalidError) return t('cancelDateInvalid', { date: e.date ?? '' });
  if (e instanceof LeaveCancellationPeriodClosedError) return t('cancellationPeriodClosed', { date: e.date ?? '' });
  if (e instanceof LeaveCancellationNotAllowedError) return t('cancellationNotAllowed');
  // ADR-0069: the requestLeave pre-check throws this when the balance is frozen for encashment (resignation
  // approved). The DB trigger's own message stays English (defense-in-depth, documented in ADR-0069) — only
  // this friendly UX pre-check is translated.
  if (e instanceof LeaveBalanceFrozenError) return t('balanceFrozenForEncashment');
  return (e as Error).message;
}

// R45 3707cba9 — "Attendance Request": a PURE clock-in/out correction (date + optional check-in/out +
// mandatory reason). Overtime moved to its own myRequestOvertime request; the OT field is gone from here.
export async function myRequestCorrection(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const date = String(formData.get('date'));
  const checkInTime = String(formData.get('checkIn') || '');
  const checkOutTime = String(formData.get('checkOut') || '');
  const reason = String(formData.get('reason') || '').trim();
  try {
    await requestAttendanceCorrection(s, {
      employmentId,
      date,
      checkIn: checkInTime || null,
      checkOut: checkOutTime || null,
      reason: reason || undefined,
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Attendance+request+submitted');
}

// R45 3707cba9 — "Overtime Request": OT-only, reusing the proven correction engine (requestedOtMinutes set,
// no punch edits — no new schema). Date + overtime hours + mandatory reason. Planned (before the shift) or
// actual (after) is up to the employee; the approver compares Actual (system) vs Approved on their screen.
export async function myRequestOvertime(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const date = String(formData.get('date'));
  const reason = String(formData.get('reason') || '').trim();
  const otHoursRaw = String(formData.get('otHours') || '').trim();
  let requestedOtMinutes: number | null = null;
  if (otHoursRaw.length > 0) {
    const hrs = Number(otHoursRaw);
    if (!Number.isFinite(hrs) || hrs < 0) {
      redirect(`/me?error=${encodeURIComponent('Overtime hours must be a non-negative number.')}`);
    }
    requestedOtMinutes = Math.round(hrs * 60);
  }
  try {
    await requestAttendanceCorrection(s, {
      employmentId,
      date,
      requestedOtMinutes,
      reason: reason || undefined,
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Overtime+request+submitted');
}

/** ADR-0069: submit a Travel Request (off-site work window). Same approvals inbox, same decide flow. */
export async function myRequestTravel(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const travelFrom = String(formData.get('travelFrom') || '');
  const travelTo = String(formData.get('travelTo') || '');
  const remarks = String(formData.get('remarks') || '').trim();
  try {
    await requestTravel(s, { employmentId, travelFrom, travelTo, remarks: remarks || undefined });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Travel+requested');
}

export async function myUpdateContact(formData: FormData) {
  const { s } = await resolveMe();
  try {
    await updateOwnContact(s, {
      phone: String(formData.get('phone') ?? ''),
      // b4682879 — structured home address (legacy single-line `address` retired from the UI).
      personalEmail: String(formData.get('personalEmail') ?? ''),
      addressLine1: String(formData.get('addressLine1') ?? ''),
      addressLine2: String(formData.get('addressLine2') ?? ''),
      addressLine3: String(formData.get('addressLine3') ?? ''),
      postcode: String(formData.get('postcode') ?? ''),
      city: String(formData.get('city') ?? ''),
      state: String(formData.get('state') ?? ''),
      country: String(formData.get('country') ?? ''),
      emergencyContactName: String(formData.get('emergencyContactName') ?? ''),
      emergencyContactRelationship: String(formData.get('emergencyContactRelationship') ?? ''),
      emergencyContactPhone: String(formData.get('emergencyContactPhone') ?? ''),
      emergencyContactPhone2: String(formData.get('emergencyContactPhone2') ?? ''),
      emergencyContactAddress: String(formData.get('emergencyContactAddress') ?? ''),
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

// ── Self Personal Tax Relief (ADR-0050, #1.1.3; per-category breakdown a2f1fa24) — yearly TP1 ──

// Read the structured per-category breakdown from the form. The category inputs are named `cat_<key>`
// (one number per LHDN TP1 section) plus a `remarks` textarea. The server recomputes the total — the
// client's total is never trusted. Falls back to a bare `tp1Amount` when no category field is present
// (backward compatibility for any legacy scalar form).
function readTp1Input(formData: FormData): { assessmentYear: number; categories?: Record<string, unknown>; tp1Amount?: number } {
  const assessmentYear = Number(formData.get('assessmentYear'));
  const keys = ['individual', 'spouse', 'children', 'parent', 'medicalInsurance', 'lifestyle', 'education', 'other'] as const;
  const hasCategories = keys.some((k) => formData.get(`cat_${k}`) != null);
  if (hasCategories) {
    const categories: Record<string, unknown> = {};
    for (const k of keys) categories[k] = Number(formData.get(`cat_${k}`) ?? 0);
    const remarks = formData.get('remarks');
    if (remarks != null) categories.remarks = String(remarks);
    return { assessmentYear, categories };
  }
  return { assessmentYear, tp1Amount: Number(formData.get('tp1Amount')) };
}

export async function mySaveTp1Draft(formData: FormData) {
  const { s } = await resolveMe();
  const input = readTp1Input(formData);
  try {
    await saveTp1Draft(s, input);
  } catch (e) {
    redirect(`/me/tax-relief?year=${input.assessmentYear}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me/tax-relief');
  redirect(`/me/tax-relief?year=${input.assessmentYear}&toast=Draft+saved`);
}

export async function mySubmitTp1(formData: FormData) {
  const { s } = await resolveMe();
  const input = readTp1Input(formData);
  try {
    await submitTp1(s, input);
  } catch (e) {
    redirect(`/me/tax-relief?year=${input.assessmentYear}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me/tax-relief');
  redirect(`/me/tax-relief?year=${input.assessmentYear}&toast=TP1+submitted`);
}

// ── Resignation (ADR-0042, #29) — employee-initiated, HR-approved offboarding ──

// #42cff598: the PDF/JPG/PNG + 10 MB gate reused for resignation attachments (same set the ticket asks
// for). Mirrors the fixed list in core/offboarding.ts so the pre-commit check and the service check agree.
const RESIGNATION_DOC_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const RESIGNATION_DOC_MAX_BYTES = 10 * 1024 * 1024;

export async function mySubmitResignation(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const lastWorkingDay = String(formData.get('lastWorkingDay') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  // #42cff598: supporting documents (e.g. a signed resignation letter). Multiple files supported.
  const files = formData.getAll('document').filter((f): f is File => f instanceof File && f.size > 0);
  try {
    // Orphan-prevention: validate every file BEFORE submitResignation commits the row + event, so a
    // disallowed/oversized file never leaves a committed pending resignation behind (same placement as leave).
    for (const file of files) {
      validateLeaveDocument(
        { allowedMimeTypes: RESIGNATION_DOC_MIME_TYPES, maxDocBytes: RESIGNATION_DOC_MAX_BYTES },
        { mimeType: file.type || 'application/octet-stream', sizeBytes: file.size },
      );
    }
    const { requestId } = await submitResignation(s, { employmentId, lastWorkingDay, reason: reason || null });
    for (const file of files) {
      await addResignationAttachment(s, {
        resignationRequestId: requestId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
  } catch (e) {
    // Reuse localizeLeaveError: the two file-validation errors thrown above are LeaveDocumentTypeError /
    // LeaveDocumentSizeError, so the PDF/JPG/PNG and size messages appear already translated in all 6
    // locales. Non-file errors (e.g. ResignationError) fall through to their own message.
    redirect(`/me?error=${encodeURIComponent(await localizeLeaveError(e))}`);
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

/** ADR-0070: parse the optional hidden lat/lng fields the client-side geolocation capture writes.
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

/** Feedback 5249d43f: the registered-device token this browser stored at registration (hidden field
 *  filled client-side from localStorage). Blank ⇒ undefined — the SERVER decides whether that blocks
 *  the punch (only when the company policy requires a registered device). */
function parseDeviceToken(formData: FormData): string | undefined {
  const v = String(formData.get('deviceToken') ?? '').trim();
  return v || undefined;
}

/** ADR-0070: localize the geofencing + registered-device errors into the viewer's own language;
 *  everything else falls back to its raw message (mirrors localizeLeaveError's shape). */
async function localizeClockError(e: unknown): Promise<string> {
  const t = await getTranslations('me');
  if (e instanceof OutsideGeofenceError) return t('outsideGeofence');
  if (e instanceof GeolocationRequiredError) return t('locationRequired');
  // 5249d43f — points the employee at the Clock in/out page, where device registration lives.
  if (e instanceof DeviceNotRegisteredError) return t('deviceNotRegistered');
  return (e as Error).message;
}

export async function myCheckIn(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const { date, time } = nowParts();
  try {
    await checkIn(s, { employmentId, date, time, geo: parseGeo(formData), deviceToken: parseDeviceToken(formData) });
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
    await checkOut(s, { employmentId, date, time, geo: parseGeo(formData), deviceToken: parseDeviceToken(formData) });
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
