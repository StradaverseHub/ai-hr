'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { plannedOvertimeMinutes } from '@/lib/overtime-duration';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, listEligibleLeaveTypesFor, pickName } from '@/core/read';
import {
  addLeaveAttachment,
  requestLeave,
  editLeaveRequest,
  cancelOwnLeave,
  requestLeaveCancellation,
  previewLeaveDeduction,
  validateLeaveDocument,
  isEmergencyReasonCategory,
  LeaveEditNotAllowedError,
  LeaveBackdatingNotAllowedError,
  LeaveAdvanceNoticeRequiredError,
  LeaveYearNotOpenError,
  LeaveDocumentRequiredError,
  LeaveRemarkRequiredError,
  LeaveDocumentTypeError,
  LeaveDocumentSizeError,
  UnpaidConsentRequiredError,
  LeaveOverrideConsentRequiredError,
  LeaveOverrideTargetMissingError,
  HourlyLeaveTimeRangeError,
  LeaveNoDaysInRangeError,
  DuplicateLeaveApplicationError,
  MarriageLeaveAlreadyPendingError,
  InsufficientLeaveBalanceOnSubmitError,
  CombinedLeaveLimitExceededError,
  CombinedLeaveApplicationTooLongError,
  LeaveTypeApplicationTooLongError,
  LeaveYearApplicationLimitExceededError,
  LeaveApplyNotAllowedError,
  MissingRejectReasonError,
  LeaveCancellationNotAllowedError,
  ReplacementCreditCancellationBlockedError,
  LeaveCancellationTooLateError,
  LeaveCancellationTooCloseError,
  LeaveCancellationDateInvalidError,
  LeaveCancellationPeriodClosedError,
  type LeaveDurationType,
} from '@/core/leave';
import {
  addAttendanceCorrectionAttachment,
  cancelOwnAttendanceCorrection,
  cancelPlannedOvertime,
  checkIn,
  checkOut,
  requestAttendanceCorrection,
  ATTENDANCE_ATTACHMENT_MAX_BYTES,
  ATTENDANCE_ATTACHMENT_MIME_TYPES,
  GeolocationRequiredError,
  OutsideGeofenceError,
  DeviceNotRegisteredError,
  OvertimePlanWithdrawNotAllowedError,
  // ec30b2e9 (r364) — the two refusals of a second overtime request for one date. Typed so this file can
  // print them in the employee's own language; see localizeOvertimeRequestError below.
  OvertimePlanAlreadyApprovedError,
  OvertimeAlreadyCountedError,
} from '@/packs/attendance/service';
import {
  ATTENDANCE_REQUEST_KINDS,
  OT_REASON_CATEGORIES,
  type AttendanceRequestKind,
  type OtReasonCategory,
} from '@/db/schema';
import { requestProfileChange, updateOwnContact, type ProfileChangeProposed } from '@/core/profile';
// 9583deac stage two — the ONE declaration of which fields an employee may ask to change. This action
// reads it instead of naming seven fields by hand; see that file's header.
import { PROFILE_REQUESTABLE_FIELDS } from '@/lib/profile-requestable-fields';
import { saveTp1Draft, submitTp1 } from '@/core/tax-relief';
import { readTp1FormInput } from '@/lib/tp1-form-input';
import type { Tp1FormState } from '@/lib/tp1-form-state';
import { tp1RefusalMessage } from '@/lib/tp1-refusal';
import { addResignationAttachment, submitResignation, withdrawResignation } from '@/core/offboarding';
import { LeaveBalanceFrozenError } from '@/core/leave-encashment';
// 6aee1d91 — the read AFTER an insufficient-balance refusal, through the pack facade (ADR-0080 D9).
import { entitlementCoverageFor } from '@/packs/leave/service';
import type { SessionContext } from '@/db/client';
import { timeInKualaLumpur, todayInKualaLumpur } from '@/lib/hr-date';
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

/** SERVER clock, both halves read in MYT — see the same helper in app/attendance/clock/actions.ts.
 *  The date used to be toISOString() (UTC), so a punch between midnight and 08:00 MYT was stamped
 *  with YESTERDAY's date beside today's time. */
function nowParts() {
  const d = new Date();
  return { date: todayInKualaLumpur(d), time: timeInKualaLumpur(d) };
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
      // Override Leave Application (56910869): the same tenant-local "today" myRequestLeave passes below, so
      // the pop-out and the submission judge the notice period against one date.
      today: todayInKualaLumpur(),
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
  // Override Leave Application (56910869): the employee's confirmation of each rule that will CHANGE this
  // application (`trigger:action` tokens). getAll because two rules can fire on one application. The SERVICE
  // is the gate — this only forwards what the form collected.
  const overrideConsent = formData.getAll('overrideConsent').map(String).filter((v) => v !== '');

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
      overrideConsent,
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
    redirect(
      `/me?error=${encodeURIComponent(
        await localizeLeaveError(e, selected?.name, { ctx: s, employmentId, leaveTypeId, subject: 'self' }),
      )}`,
    );
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
    redirect(
      `/leave?error=${encodeURIComponent(
        await localizeLeaveError(e, selected?.name, { ctx: s, employmentId, leaveTypeId, subject: 'self' }),
      )}`,
    );
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
  let result: Awaited<ReturnType<typeof requestLeaveCancellation>> | undefined;
  try {
    result = await requestLeaveCancellation(s, { leaveRequestId, cancelDates, reason, today: todayInKualaLumpur() });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent(await localizeLeaveError(e))}`);
  }
  revalidatePath('/leave');
  revalidatePath('/approvals');
  // r301 (83511d3b) — a leave type set to approve cancellations automatically has ALREADY cancelled the days;
  // "waiting for approval" would be untrue, so it gets its own toast.
  if (result?.status === 'approved') redirect('/leave?toast=cancellationApproved');
  redirect('/leave?toast=cancellationRequested');
}

/** Supporting-document config: re-localize the structured service/validation errors into the viewer's
 *  language (they reach ms/ta/th/vi/zh via ?error=). Unknown errors fall back to their English message.
 *  Exported so the Leave-Tab action (app/leave/actions.ts) reuses the same localizer rather than copying
 *  it — both forms now share the document/remark error wording. */
export async function localizeLeaveError(
  e: unknown,
  typeName?: string,
  /**
   * 6aee1d91 — WHO WAS REFUSED, so a zero balance can be explained rather than merely reported. Only the
   * insufficient-balance branch reads it. `subject` says whose refusal this is: the caller's own ("you")
   * or, on the HR on-behalf path, another employee's. Absent ⇒ the plain message, exactly as before.
   */
  coverage?: { ctx: SessionContext; employmentId: string; leaveTypeId: string; subject: 'self' | 'other' },
): Promise<string> {
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
  //
  // Advance Notice — calendar days or working days (7daac043): the DEFAULT wording says which kind of day
  // was counted, because "at least 7 day(s)" in front of an employee who counted five working days and a
  // weekend explains nothing. THE CUSTOM-MESSAGE SHORT-CIRCUIT STAYS FIRST AND UNCHANGED — an admin-authored
  // string is rendered verbatim for both units, never re-worded and never suffixed.
  if (e instanceof LeaveAdvanceNoticeRequiredError)
    return (
      e.customMessage ??
      (e.dayType === 'working_days'
        ? t('advanceNoticeRequiredWorking', { typeName: name, days: e.minDays })
        : t('advanceNoticeRequired', { typeName: name, days: e.minDays }))
    );
  // Leave Year Configuration (9aa894a4): the employee applied for a future leave year that HR has not opened
  // for applications yet. Localized so all 6 locales see a clear "{year} isn't open yet" message.
  if (e instanceof LeaveYearNotOpenError) return t('leaveYearNotOpen', { year: e.year });
  if (e instanceof LeaveDocumentTypeError) {
    const labels: Record<string, string> = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG' };
    return t('fileTypeNotAllowed', { allowed: e.allowed.map((m) => labels[m] ?? m).join(', ') });
  }
  if (e instanceof LeaveDocumentSizeError) return t('fileTooLarge', { mb: e.maxMb });
  if (e instanceof UnpaidConsentRequiredError) return t('unpaidConsentRequired', { days: e.unpaidDays ?? 0 });
  // Override Leave Application (56910869): the SERVICE refused to apply a rule that would CHANGE this
  // application because the employee never confirmed it. Reaching this message means the client skipped the
  // pop-out (a stale form, or a direct post) — the ordinary flow answers Yes/No before submitting and never
  // sees it. Localized per action so each rule explains itself in the viewer's language.
  if (e instanceof LeaveOverrideConsentRequiredError) {
    return e.action === 'convert_to_emergency'
      ? t('overrideConsentRequiredConvert', { typeName: e.toTypeName ?? '', fromTypeName: e.fromTypeName ?? name ?? '' })
      : t('overrideConsentRequiredSplit', { paid: e.paidDays ?? 0, unpaid: e.unpaidDays ?? 0 });
  }
  // A conversion rule is enabled but there is no Emergency Leave type to convert TO. Refused loudly rather
  // than quietly falling back to the ordinary refusal, so HR is not left looking at a rule that is on and
  // doing nothing.
  if (e instanceof LeaveOverrideTargetMissingError) return t('overrideTargetMissing');
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
  // Marriage Leave (72fca31d rule 2): one pending Marriage Leave application at a time. A DIFFERENT
  // refusal from `duplicateApplication` above and named separately because the fix is different — that
  // one says the DATES clash and the employee should pick others; this one says a request for this very
  // type is already with an approver and there is nothing to do but wait. Scoped to the marriage role, so
  // no other leave type can ever produce it.
  if (e instanceof MarriageLeaveAlreadyPendingError) return t('marriageLeaveAlreadyPending', { typeName: name || e.typeName || '' });
  // Configurable Negative Leave Balance Validation (0ef0defd): the leave type's allow_negative_balance=false
  // blocked a submit/edit whose days exceed the available balance. Localized so all 6 locales see the
  // reporter's requested message ("Insufficient leave balance. Your available leave balance is lower…").
  if (e instanceof InsufficientLeaveBalanceOnSubmitError) {
    // 6aee1d91 — THE SAME REFUSAL, THREE REASONS. The service has already said no; this only asks WHY the
    // balance was zero, through the engine's own resolver (core/leave.ts entitlementCoverageFor), so an
    // employee nobody's benefit scheme covers is told that instead of being sent to count their days. A
    // failed read falls back to the plain message: the refusal must never turn into a raw server error.
    if (coverage) {
      const reason = await entitlementCoverageFor(coverage.ctx, {
        employmentId: coverage.employmentId,
        leaveTypeId: coverage.leaveTypeId,
        asOf: todayInKualaLumpur(),
      }).catch(() => 'covered' as const);
      const other = coverage.subject === 'other';
      if (reason === 'no_scheme')
        return t(other ? 'insufficientBalanceNoSchemeOther' : 'insufficientBalanceNoScheme', { typeName: name });
      if (reason === 'no_table')
        return t(other ? 'insufficientBalanceNoTableOther' : 'insufficientBalanceNoTable', { typeName: name });
    }
    return t('insufficientBalance');
  }
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
  // r301 (83511d3b) — the leave type's notice period, counted per leave date. The type is named in the
  // reader's language when HR gave it one (the same pickName every other leave surface resolves through).
  if (e instanceof LeaveCancellationTooCloseError)
    return t('cancellationTooClose', {
      date: e.date,
      days: e.noticeDays,
      typeName: pickName(e.leaveTypeName, e.leaveTypeI18n, await getLocale()),
    });
  if (e instanceof LeaveCancellationDateInvalidError) return t('cancelDateInvalid', { date: e.date ?? '' });
  if (e instanceof LeaveCancellationPeriodClosedError) return t('cancellationPeriodClosed', { date: e.date ?? '' });
  // 3fb1a611 (r299) — a Replacement Leave whose credit has expired (or been paid out, or reversed) since the
  // leave used it. Checked BEFORE the generic refusal it extends: the plan promises the screen SAYS the credit
  // has expired, naming it, rather than the bare "can't be cancelled".
  if (e instanceof ReplacementCreditCancellationBlockedError) {
    const parts = e.credits.map((c) =>
      c.state === 'expired'
        ? t('cancellationCreditExpired', { workedDate: c.workedDate ?? '', expiresOn: c.expiresOn ?? '' })
        : c.state === 'paid_out'
          ? t('cancellationCreditPaidOut', { workedDate: c.workedDate ?? '', expiresOn: c.expiresOn ?? '' })
          : c.state === 'reversed'
            ? t('cancellationCreditReversed', { workedDate: c.workedDate ?? '' })
            : t('cancellationCreditUnreadable'),
    );
    return t('cancellationCreditBlocked', { credits: [...new Set(parts)].join('; ') });
  }
  // r301 (83511d3b) — EACH refusal says why. This used to be one sentence for every case ("This leave date
  // can't be cancelled."), which the reporter could not act on. Spelled out as literal keys (not a computed
  // `cancellationRefused.${code}`) so the i18n coverage guard can see every one of them.
  if (e instanceof LeaveCancellationNotAllowedError) {
    const typeName = e.leaveTypeName ? pickName(e.leaveTypeName, e.leaveTypeI18n ?? null, await getLocale()) : name;
    switch (e.refusal) {
      case 'type_off':
        return t('cancellationTypeOff', { typeName });
      case 'not_yours':
        return t('cancellationNotYours');
      case 'not_approved':
        return t('cancellationNotApproved');
      case 'not_full_day':
        return t('cancellationNotFullDay');
      case 'grouped':
        return t('cancellationGrouped');
      case 'unpaid_days':
        return t('cancellationUnpaidDays');
      case 'already_pending':
        return t('cancellationAlreadyPending');
      case 'no_longer_cancellable':
        return t('cancellationNoLongerCancellable');
      case 'admin_only':
        return t('cancellationAdminOnly');
      case 'admin_own_leave':
        return t('cancellationAdminOwnLeave');
      case 'already_final':
        return t('cancellationAlreadyFinal');
      case 'already_approved':
        return t('cancellationAlreadyApproved');
      default:
        return t('cancellationNotAllowed');
    }
  }
  // ADR-0069: the requestLeave pre-check throws this when the balance is frozen for encashment (resignation
  // approved). The DB trigger's own message stays English (defense-in-depth, documented in ADR-0069) — only
  // this friendly UX pre-check is translated.
  if (e instanceof LeaveBalanceFrozenError) return t('balanceFrozenForEncashment');
  return publicErrorMessage(e);
}

/**
 * 0bb0e303 rev2 — the three self-service request forms moved off /me onto their own My Attendance page,
 * so these three actions land the employee back where they posted from. The ACTIONS did not move or fork
 * (one implementation, one approval route); only the screen they answer to did. They stay in this file
 * because they are ESS actions sharing resolveMe() with the rest of /me's self-service writes.
 */
const REQUESTS_PAGE = '/attendance/requests';
/**
 * c6bb5f5a split that one screen into four, so two of these actions answer to a DIFFERENT page than they
 * did — and "land the employee back on the page they posted from" is the rule, not the address.
 *
 * • The correction form is still on /attendance/requests (the Attendance Irregularity screen), inline for a
 *   flagged day and in a pop-up for any other day, so myRequestCorrection is unchanged.
 * • The request LIST — and the Cancel control on it — moved to /attendance/request-status. A cancel that
 *   still redirected to REQUESTS_PAGE would bounce the employee off the list they were reading, onto a
 *   screen that no longer shows the row they just cancelled.
 * • Travel USED TO BE the third case here — myRequestTravel, answering to /attendance/travel. b833a077
 *   (r362) removed My Travel completely: the row, the screen, the form and the approvals section are
 *   gone, so there is no travel action and no travel page to land on. The travel_request rows are kept
 *   for audit and no new one can be created. /attendance/travel is now a redirect to /attendance/clock.
 */
const REQUEST_STATUS_PAGE = '/attendance/request-status';

// R45 3707cba9 — "Attendance Request": a PURE clock-in/out correction (date + optional check-in/out +
// mandatory reason). Overtime moved to its own myRequestOvertime request; the OT field is gone from here.
//
// 2166ef79 WIDENED IT, it did not fork it — the same action, the same core service, the same approval route.
// What is new is what My Attendance's "Fix this" panel collects on top: an optional remark, one optional
// supporting file, and WHICH of the four sections the employee filed from (stored, because the moment a
// missing clock-out is approved the day stops being an Incomplete Entry and a re-derived label would
// relabel its own history). Every one of them is optional at every layer, so the plain form is unchanged.
export async function myRequestCorrection(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const date = String(formData.get('date'));
  const checkInTime = String(formData.get('checkIn') || '');
  const checkOutTime = String(formData.get('checkOut') || '');
  const reason = String(formData.get('reason') || '').trim();
  const remark = String(formData.get('remark') || '').trim();
  // Never trust the posted kind: an unknown value would meet the DB CHECK with a constraint name in the
  // message. Anything outside the vocabulary is simply dropped — the request itself is unaffected.
  const kindRaw = String(formData.get('requestKind') || '').trim();
  const requestKind = (ATTENDANCE_REQUEST_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as AttendanceRequestKind)
    : null;
  // Land back on the SECTION the employee was working through, so a fix does not bounce them to a
  // different tab from the one they came from. Spelt out against REQUESTS_PAGE at each redirect rather
  // than hidden behind a local: test/me-tabs.test.ts reads these lines to prove an action still answers
  // to the page it is posted from, and a guard that can only see a variable name proves nothing.
  const section = encodeURIComponent(sectionParam(formData));
  const file = formData.get('attachment');
  const hasFile = file instanceof File && file.size > 0;
  try {
    // Orphan-prevention, the leave path's lesson (myRequestLeave above): a bad file is refused BEFORE the
    // request row and its event commit, so a rejected upload never leaves a pending request behind.
    if (hasFile) {
      assertAttendanceAttachmentAcceptable(file);
    }
    const { correctionId } = await requestAttendanceCorrection(s, {
      employmentId,
      date,
      checkIn: checkInTime || null,
      checkOut: checkOutTime || null,
      reason: reason || undefined,
      remark: remark || null,
      requestKind,
    });
    if (hasFile) {
      await addAttendanceCorrectionAttachment(s, {
        correctionId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
  } catch (e) {
    redirect(`${REQUESTS_PAGE}?section=${section}&error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(REQUESTS_PAGE);
  redirect(`${REQUESTS_PAGE}?section=${section}&toast=Attendance+request+submitted`);
}

/** 2166ef79 — the employee WITHDRAWS their own pending clock-time request. Overtime is withdrawn from the
 *  Self Overtime list instead (myWithdrawOvertimePlan): approving a plan does not touch a day, approving a
 *  correction rewrites one, so the two states are not the same and the service refuses the cross-over.
 *
 *  r363 — THE TOAST SAYS "withdrawn" NOW, and it is a HARDCODED ENGLISH STRING, not a message key: it is
 *  handed to the screen through the URL and rendered as-is, so a Tamil or Thai employee reads English here
 *  whichever word it carries. That gap is PRE-EXISTING and is deliberately not fixed in this wording round
 *  — every `?toast=` in this file has it. Reported rather than patched, so the fix is a decision somebody
 *  takes for all of them at once rather than one string quietly becoming the odd one out.
 *  The function's NAME does not move: the stored status is still `cancelled` and renaming the action, the
 *  service and the control is a separate decision (test/attendance-screens-layout.test.ts case D). */
export async function myCancelAttendanceRequest(formData: FormData) {
  const { s } = await resolveMe();
  try {
    await cancelOwnAttendanceCorrection(s, { correctionId: String(formData.get('correctionId')) });
  } catch (e) {
    redirect(`${REQUEST_STATUS_PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(REQUEST_STATUS_PAGE);
  redirect(`${REQUEST_STATUS_PAGE}?toast=Attendance+request+withdrawn`);
}

/** The section the form was posted from, shape-checked. Anything unrecognised falls back to the section a
 *  fix most often comes from, so a tampered field can never build a redirect out of posted text. */
function sectionParam(formData: FormData): string {
  const raw = String(formData.get('section') || '');
  return (['overtime', 'short', 'incomplete', 'absent', 'other'] as const).includes(raw as never)
    ? raw
    : 'incomplete';
}

/** The fixed stage-one attachment rule, checked before anything is written. Deliberately restated in the
 *  action as well as in the service: the service is the authority (any other caller meets it there), this
 *  one exists so the employee is told before a request row is created. */
function assertAttendanceAttachmentAcceptable(file: File) {
  if (file.size > ATTENDANCE_ATTACHMENT_MAX_BYTES) throw new Error('That file is larger than 5 MB.');
  if (!(ATTENDANCE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
    throw new Error('That file type is not accepted — attach a photo or a PDF.');
  }
}

// 1e9145d4 — Plan OT is now the ONE home for overtime, planned or claimed after the fact, so these two
// actions answer to it rather than to the Attendance Request screen the Overtime card moved off.
const PLAN_OT_PAGE = '/attendance/plan-ot';

/**
 * ec30b2e9 (r364) · THE TWO "one overtime figure per date" REFUSALS, IN THE EMPLOYEE'S OWN LANGUAGE.
 *
 * This whole file hands `Error.message` to `?error=` and ErrorBanner prints it verbatim, so every refusal
 * the service raises reaches a Tamil, Thai, Malay, Vietnamese or Chinese employee in English. That gap is
 * pre-existing and wide, and it is NOT fixed wholesale here (the same note sits on `?toast=`). What is
 * fixed is the two refusals this round is about — one of them brand new — because shipping a NEW English
 * throw on a screen that has six catalogues is how the gap gets wider.
 *
 * `me.otAlreadyApprovedForDate` is the key that used to be intended for this and is RETIRED rather than
 * deleted: it named no date, and app/attendance/plan-ot/apply/page.tsx is guarded against ever rendering
 * it again (it once told brand-new employees they had a plan to withdraw). The two keys used here carry
 * `{date}`, which is the whole point of showing the sentence at all.
 *
 * Anything else falls through to its raw message, exactly as before — the shape localizeClockError and
 * localizeLeaveError already use in this file.
 */
async function localizeOvertimeRequestError(e: unknown): Promise<string> {
  if (e instanceof OvertimePlanAlreadyApprovedError || e instanceof OvertimeAlreadyCountedError) {
    const t = await getTranslations('me');
    return e instanceof OvertimeAlreadyCountedError
      ? t('otAlreadyCountedForDate', { date: e.date })
      : t('otPlanApprovedNotCounted', { date: e.date });
  }
  return publicErrorMessage(e);
}

// R45 3707cba9 — "Overtime Request": OT-only, reusing the proven correction engine (requestedOtMinutes set,
// no punch edits — no new schema). Date + overtime hours + mandatory reason. Planned (before the shift) or
// actual (after) is up to the employee; the approver compares Actual (system) vs Approved on their screen.
//
// 1e9145d4 WIDENED IT, it did not fork it: the same action, the same core service, the same approval route.
// What is new is the planned window (start + end, from which the form shows the hours as you type) and the
// reason category. Both optional at every layer, so an hours-only submission — the shape that has always
// worked — is byte-identical. `otHours` is still accepted and still authoritative; when the window is
// supplied the form posts the derived figure in it, so there is exactly ONE number the engine reads.
export async function myRequestOvertime(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const date = String(formData.get('date'));
  const reason = String(formData.get('reason') || '').trim();
  const otHoursRaw = String(formData.get('otHours') || '').trim();
  const plannedStart = String(formData.get('plannedStart') || '').trim();
  const plannedEnd = String(formData.get('plannedEnd') || '').trim();
  // ce5ded11 — the optional note and the optional supporting file. Both are EXISTING capability that the
  // overtime form simply never offered: `attendance_correction.remark` is a column
  // requestAttendanceCorrection already accepts, and the attachment is the same table, the same 5 MB /
  // jpeg-png-webp-heic-pdf guard and the same download route myRequestCorrection above uses.
  const remark = String(formData.get('remark') || '').trim();
  const file = formData.get('attachment');
  const hasFile = file instanceof File && file.size > 0;
  const postedMinutes = String(formData.get('otMinutes') ?? '').trim();
  const derivedMinutes = plannedStart || plannedEnd ? plannedOvertimeMinutes(plannedStart, plannedEnd) : null;
  let requestedOtMinutes: number | null = null;
  try {
    if (plannedStart || plannedEnd) {
      if (derivedMinutes == null) throw new Error('Enter different valid start and end times.');
      requestedOtMinutes = derivedMinutes;
    }
    if (postedMinutes) {
      const value = Number(postedMinutes);
      if (!Number.isSafeInteger(value) || value < 0 || derivedMinutes != null && value !== derivedMinutes) {
        throw new Error('Overtime minutes must agree with the planned times.');
      }
      requestedOtMinutes = value;
    } else if (derivedMinutes == null && otHoursRaw) {
      // Bounded compatibility for callers that supply only the original hours field.
      const hours = Number(otHoursRaw);
      if (!Number.isFinite(hours) || hours < 0 || hours > 24) throw new Error('Overtime hours must be a non-negative number.');
      requestedOtMinutes = Math.round(hours * 60);
    }

    // Orphan-prevention, the leave path's lesson (myRequestCorrection above): a bad file is refused
    // BEFORE the request row and its event commit, so a rejected upload never leaves a pending request
    // behind that the employee then has to withdraw.
    if (hasFile) {
      assertAttendanceAttachmentAcceptable(file);
    }
    const { correctionId } = await requestAttendanceCorrection(s, {
      employmentId,
      date,
      requestedOtMinutes,
      reason: reason || undefined,
      remark: remark || null,
      plannedStartTime: plannedStart || null,
      plannedEndTime: plannedEnd || null,
    });
    if (hasFile) {
      await addAttendanceCorrectionAttachment(s, {
        correctionId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
  } catch (e) {
    // Back to the FORM, not the list: a refusal (a duplicate approved plan for the date, a bad time window)
    // is something the employee has to fix in the fields they just filled in.
    //
    // r364 — STILL EXACTLY ONE REFUSAL REDIRECT HERE. The localizer runs BEFORE it rather than beside it,
    // deliberately: test/plan-ot-calendar-screen.test.ts counts the redirects out of this action (three:
    // bad figure, refusal, success) and asserts every one of them carries the date. A second refusal
    // redirect for the localized case would have been the easy shape and would have broken that guard —
    // and the guard is right, because a refusal that loses the date resets the form to tomorrow.
    const msg = await localizeOvertimeRequestError(e);
    redirect(`${PLAN_OT_PAGE}/apply?date=${encodeURIComponent(date)}&error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(PLAN_OT_PAGE);
  revalidatePath(`${PLAN_OT_PAGE}/apply`);
  // ce5ded11 — STAY ON THE CALENDAR. The rule this file states everywhere else is "land the employee back
  // on the page they posted from", and they posted from the calendar, not the list. Coming back to it with
  // the same date still selected means the dot they just created is visible on the grid and the next day
  // is one click away; being thrown to the table meant navigating back in to plan a second day. The date
  // rides along so the month, the summary and the day card are the ones they were looking at.
  redirect(`${PLAN_OT_PAGE}/apply?date=${encodeURIComponent(date)}&toast=Overtime+plan+submitted`);
}

/** 1e9145d4 — withdraw an overtime plan. The service enforces subject-only and the allowed states (pending,
 *  or approved-but-not-yet-counted and not past its date); this just reports the refusal on the page. */
export async function myWithdrawOvertimePlan(formData: FormData) {
  const { s } = await resolveMe();
  try {
    await cancelPlannedOvertime(s, { correctionId: String(formData.get('correctionId')) });
  } catch (e) {
    const msg =
      e instanceof OvertimePlanWithdrawNotAllowedError ? e.message : 'This plan could not be withdrawn.';
    redirect(`${PLAN_OT_PAGE}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(PLAN_OT_PAGE);
  redirect(`${PLAN_OT_PAGE}?toast=Overtime+plan+withdrawn`);
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
    redirect(`/me?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Profile+updated');
}

/**
 * Ask for a change to any field `lib/profile-requestable-fields.ts` declares (9583deac stage two).
 *
 * ── ONE LOOP, NOT A LIST OF NAMES ───────────────────────────────────────────────────────────────────
 * This used to read seven `formData.get('…')` calls by hand, which is exactly why the request form, the
 * sanitiser and the applier could each know a different set of fields. It now walks the declaration, so
 * "which fields may be asked about" is answered in ONE place and this action cannot fall behind the form
 * that posts to it.
 *
 * BLANK MEANS "LEAVE IT ALONE" — unchanged semantics, and the reason the form is not pre-filled. A key
 * only enters the proposal when the employee actually typed or picked something; `core/profile.ts`
 * `sanitizeProposed` then validates the value and drops anything it does not recognise.
 *
 * THE EMPLOYMENT IS THE SESSION'S — `resolveMe()` resolves it from `ctx.personId`, never from the form.
 * A hidden employment id in this form would be the whole scope of My Profile undone by one input.
 */
export async function myRequestProfileChange(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const proposed: ProfileChangeProposed = {};
  for (const field of PROFILE_REQUESTABLE_FIELDS) {
    const raw = String(formData.get(field.key) ?? '').trim();
    if (!raw) continue;
    (proposed as Record<string, string | number>)[field.key] =
      field.input === 'number' || field.key === 'taxCategory' ? Number(raw) : raw;
  }
  try {
    await requestProfileChange(s, { employmentId, proposed });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Change+requested+for+approval');
}

// ── Self Personal Tax Relief (ADR-0050, #1.1.3; per-category breakdown a2f1fa24) — yearly TP1 ──

// The form reader moved to lib/tp1-form-input.ts (7ad37961) so that this action and the HR
// admin-on-behalf action (app/payroll/transactions/deductions-actions.ts) read the SAME field names —
// the TP1 (1/2026) catalogue boxes, the legacy `cat_<key>` boxes, and the scalar fallback, in that
// order. Two hand-maintained copies of seventeen items' field names is how a figure silently drops on
// one surface and not the other. See that file's header, including the RULE 17 note on the tick.

/**
 * ══ THE EMPLOYEE'S OWN TP1 FORM, ONE ACTION (r352, item 0df7dd44) ═══════════════════════════════════
 *
 * ⚠️ THE ITEM WAS RAISED ABOUT THE HR SCREEN, AND IT LANDS HERE TOO — because both screens render the
 * SAME component (`components/tp1-declaration-form.tsx`) through the same reader
 * (`lib/tp1-form-input.ts`). `mySaveTp1Draft` / `mySubmitTp1` had the identical defect in a milder form:
 * a refusal `redirect`ed to /me/tax-relief, which at least IS the right screen, but the navigation still
 * discarded every amount box the employee had keyed, because the form was uncontrolled.
 *
 * So this is `useActionState`-shaped like the HR one: a refusal RETURNS a message, nothing navigates,
 * and the figures stay. Success redirects with a toast, exactly as before. The refusal is translated by
 * the shared `tp1RefusalMessage` (lib/tp1-refusal.ts), so the two surfaces cannot word one differently.
 *
 * SUBMIT-AND-APPROVE IS NOT AN INTENT HERE, and that is the point of Section F: an employee may not
 * approve their own claim. Only `draft` and `submit` are reachable, and the services refuse the rest
 * anyway (`requireAdminTarget`, `refuseSelfApproval`, and the tp1_relief RLS beneath both).
 */
export async function myTp1FormAction(_prev: Tp1FormState, formData: FormData): Promise<Tp1FormState> {
  const { s } = await resolveMe();
  const input = readTp1FormInput(formData);
  const draft = String(formData.get('intent') ?? 'submit') === 'draft';
  try {
    if (draft) await saveTp1Draft(s, input);
    else await submitTp1(s, input);
  } catch (e) {
    return { error: await tp1RefusalMessage(e) };
  }
  revalidatePath('/me/tax-relief');
  redirect(
    `/me/tax-relief?year=${input.assessmentYear}&toast=${draft ? 'Draft+saved' : 'TP1+submitted'}`,
  );
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
    redirect(`/me?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
  return publicErrorMessage(e);
}

export async function myCheckIn(_formData: FormData) {
  await getSession();
  redirect('/attendance/clock');
}

export async function myCheckOut(_formData: FormData) {
  await getSession();
  redirect('/attendance/clock');
}

// ── Goals (ADR-0022) — the employee's own continuous goals ──
//
// r259 — THE PAGE THESE POST FROM MOVED, so their redirects moved with it. Goals, 360 feedback and 1:1
// check-ins left /me when My Profile was rebuilt in the shape of the Personnel record (six tabs, none of
// them Performance) and now live on /me/performance. The rule is the one 1e9145d4 and c6bb5f5a already
// wrote down for the attendance forms: an action must return the employee to the screen they posted from.
// Left unchanged, every one of these would have bounced the employee off the page they were reading, and
// an error banner would have rendered on a screen with no form on it. Pinned by test/me-tabs.test.ts.
const PERFORMANCE_PAGE = '/me/performance';

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
    redirect(`${PERFORMANCE_PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PERFORMANCE_PAGE);
  redirect(`${PERFORMANCE_PAGE}?toast=Goal+added`);
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
    redirect(`${PERFORMANCE_PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PERFORMANCE_PAGE);
  redirect(`${PERFORMANCE_PAGE}?toast=Goal+updated`);
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
    redirect(`${PERFORMANCE_PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PERFORMANCE_PAGE);
  redirect(`${PERFORMANCE_PAGE}?toast=Feedback+submitted`);
}

export async function myDeclinePeerFeedback(formData: FormData) {
  const s = await getSession();
  try {
    await declinePeerFeedback(s, { requestId: String(formData.get('requestId')) });
  } catch (e) {
    redirect(`${PERFORMANCE_PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PERFORMANCE_PAGE);
  redirect(`${PERFORMANCE_PAGE}?toast=Declined`);
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
    redirect(`${PERFORMANCE_PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PERFORMANCE_PAGE);
  redirect(`${PERFORMANCE_PAGE}?toast=Goal+updated`);
}
