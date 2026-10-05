'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { getTranslations } from 'next-intl/server';
import { myEmployment } from '@/core/read';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  cancelOwnReplacementLeaveRequest,
  extendedHoursDayForEmployment,
  isLeaveCreditDayType,
  ReplacementRequestNotPendingError,
  submitLeaveCreditRequest,
  type LeaveCreditRowInput,
} from '@/packs/leave/service';

/**
 * r389 (ba039150) — WHERE A SUBMISSION LANDS. It used to be `/leave/credit` on success AND on error, because
 * that page held a second copy of the form and the list of what had been submitted. The form copy is gone
 * (the dialog on My Leave is the only place to ask) and the page is Leave Credit History now, so a
 * submission returns to My Leave — where the dialog was opened — with the confirmation, exactly as Request
 * Leave does (app/leave/actions.ts `requestLeaveAction`). An error returns there too, rather than to a page
 * with no form on it to correct.
 */
const SUBMIT_LANDING = '/leave';
/** The history page, which a submission and a cancellation both change. */
const HISTORY = '/leave/credit';

/**
 * r343 cbfa8b0b · One date's read-only facts for the single table: what the ROSTER holds for it, the
 * scheduled shift, the clock-in and clock-out on record, and any approved overtime for the date.
 *
 * The roster kind is what the adjudication compares the employee's chosen Day Type against, so this action
 * answers for EVERY row — not only the Ordinary Day ones, which is all r336's equivalent was asked for.
 * Read-only and RLS-scoped (an employee may resolve their own schedule and their own attendance).
 */
export async function leaveCreditDayFactsAction(workedDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workedDate)) return null;
  const session = await getSession();
  const me = await myEmployment(session);
  if (!me) return null;
  const day = await extendedHoursDayForEmployment(session, me.employmentId, workedDate);
  // r365 cbfa8b0b — the shift START, the clock-IN and the approved overtime joined the row's facts, for
  // the Attendance panel behind the row's View button. Listed one by one rather than spread, deliberately:
  // this is the server→client boundary and every field crossing it has to be a value somebody chose to
  // send (test/server-client-boundary.test.ts). None of the three is read by any arithmetic.
  return {
    kind: day.kind,
    scheduleName: day.scheduleName,
    shiftCode: day.shiftCode,
    shiftName: day.shiftName,
    attendanceRecordPresent: day.attendanceRecordPresent,
    shiftStart: day.shiftStart,
    shiftEnd: day.shiftEnd,
    actualClockIn: day.actualClockIn,
    actualClockOut: day.actualClockOut,
    measuredExtendedMinutes: day.measuredExtendedMinutes,
    approvedOtPlan: day.approvedOtPlan,
  };
}

/**
 * Submit the single-table Leave Credit request.
 *
 * ── THE FIVE FIELD LISTS ARE THE SAME LENGTH BY CONSTRUCTION, AND THAT IS THE CONTRACT ──────────────────
 * The form posts `workedDate`, `dayType`, `days`, `claimStart` and `claimEnd` once per row, from hidden
 * inputs that are present whatever the row's day type — because a browser does not submit a DISABLED input
 * at all, and r336's header records what a short list does to a by-index zip: every row after the gap
 * shifts. So this zips by index without checking lengths first, and the values are read BY VALUE — an empty
 * string where a cell means nothing, never an absent entry (CLAUDE.md §8).
 *
 * A row with no date at all is dropped, which is how the last blank row of a part-filled table is ignored.
 * The day type is NARROWED (`isLeaveCreditDayType`) rather than cast: a tampered or stale field is refused
 * by the service with the "choose a day type" message, not passed through as a fifth kind.
 */
export async function submitLeaveCreditRequestAction(formData: FormData) {
  const session = await getSession();
  const dates = formData.getAll('workedDate').map(String);
  const dayTypes = formData.getAll('dayType').map(String);
  const starts = formData.getAll('claimStart').map(String);
  const ends = formData.getAll('claimEnd').map(String);

  const rows: LeaveCreditRowInput[] = dates
    .map((workedDate, i) => {
      const raw = (dayTypes[i] ?? '').trim();
      return {
        workedDate: workedDate.trim(),
        // Narrowed here; an unrecognised value reaches the service as a non-day-type and is refused there.
        dayType: (isLeaveCreditDayType(raw) ? raw : '') as LeaveCreditRowInput['dayType'],
        // r360 — `days` WAS READ AND ASSIGNED HERE AND HAD BEEN DEAD SINCE r358, which removed the field
        // from the form and from `LeaveCreditRowInput`. It survived `tsc` because an object literal
        // inside `.map()` is not "fresh" at the point the result is assigned to a typed array, so excess
        // property checking never fires — the same blind spot that silently dropped a `workedDayKind` I
        // added during r358 itself. `getAll('days')` returned [] against a form that emits no such input,
        // so every row carried `days: undefined` and nothing read it. Inert, but it read as live code.
        claimStart: (starts[i] ?? '').trim() || undefined,
        claimEnd: (ends[i] ?? '').trim() || undefined,
      };
    })
    .filter((r) => r.workedDate !== '');

  try {
    if (!String(formData.get('reason') ?? '').trim()) throw new Error((await getTranslations('replacementRequest'))('table.reasonRequired'));
    const employmentId = (await myEmployment(session))?.employmentId;
    if (!employmentId) throw new Error('No employment on record for this account.');
    await submitLeaveCreditRequest(session, {
      employmentId,
      leaveTypeId: String(formData.get('leaveTypeId') ?? '') || null,
      rows,
      reason: String(formData.get('reason') ?? '').trim() || undefined,
      firstScheduleConsent: formData.get('firstScheduleConsent') === 'on',
      today: todayInKualaLumpur(),
    });
  } catch (e) {
    redirect(`${SUBMIT_LANDING}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  // Both pages read what was just written: My Leave's card shows the pending figure, and Leave Credit
  // History lists the new request.
  revalidatePath(SUBMIT_LANDING);
  revalidatePath(HISTORY);
  // The ALREADY-LOCALISED sentence, which the global ToastFromQuery (app/layout.tsx) renders as is — the
  // house convention requestLeaveAction follows (never an i18n key in the address).
  const t = await getTranslations('replacementRequest');
  redirect(`${SUBMIT_LANDING}?toast=${encodeURIComponent(t('submittedToast'))}`);
}

/**
 * r389 (bc3e203d) — Cancel on a PENDING row of Leave Credit History.
 *
 * The request id is the only thing read off the form; WHOSE it is and WHETHER it is still pending are decided
 * by `cancelOwnReplacementLeaveRequest` against the session (see its header for why RLS cannot decide
 * either). The redirect keeps the page's filters, tab and paging (`back`, narrowed to a query string on this
 * page), so the row the employee was looking at stays in view with its new status.
 *
 * A refusal because the request is no longer pending gets its own translated sentence; anything else goes
 * through publicErrorMessage (r388), never `e.message` of a driver error.
 */
export async function cancelLeaveCreditRequestAction(formData: FormData) {
  const session = await getSession();
  const requestId = String(formData.get('requestId') ?? '');
  const backRaw = String(formData.get('back') ?? '');
  // Only a query string for THIS page — never a path, so the field cannot become an open redirect.
  const back = /^[A-Za-z0-9_=&.%-]*$/.test(backRaw) ? backRaw : '';
  const there = (key: 'toast' | 'error', message: string) => {
    const q = new URLSearchParams(back);
    q.delete('toast');
    q.delete('error');
    q.set(key, message);
    return `${HISTORY}?${q.toString()}`;
  };
  const t = await getTranslations('leaveCreditHistory');
  try {
    await cancelOwnReplacementLeaveRequest(session, { requestId });
  } catch (e) {
    redirect(there('error', e instanceof ReplacementRequestNotPendingError ? t('cancelNotPending') : publicErrorMessage(e)));
  }
  // The approver's list and its badge, My Leave's pending figure, and this page.
  revalidatePath(HISTORY);
  revalidatePath(SUBMIT_LANDING);
  revalidatePath('/approvals');
  redirect(there('toast', t('cancelledToast')));
}
