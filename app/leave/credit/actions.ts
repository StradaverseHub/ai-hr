'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { getTranslations } from 'next-intl/server';
import { myEmployment } from '@/core/read';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  extendedHoursDayForEmployment,
  isLeaveCreditDayType,
  submitLeaveCreditRequest,
  type LeaveCreditRowInput,
} from '@/packs/leave/service';

const PAGE = '/leave/credit';

/**
 * r343 cbfa8b0b · One date's read-only facts for the single table: what the ROSTER holds for it, the
 * scheduled shift end and the actual clock-out.
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
  return {
    kind: day.kind,
    shiftEnd: day.shiftEnd,
    actualClockOut: day.actualClockOut,
    measuredExtendedMinutes: day.measuredExtendedMinutes,
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
  const days = formData.getAll('days').map(String);
  const starts = formData.getAll('claimStart').map(String);
  const ends = formData.getAll('claimEnd').map(String);

  const rows: LeaveCreditRowInput[] = dates
    .map((workedDate, i) => {
      const raw = (dayTypes[i] ?? '').trim();
      return {
        workedDate: workedDate.trim(),
        // Narrowed here; an unrecognised value reaches the service as a non-day-type and is refused there.
        dayType: (isLeaveCreditDayType(raw) ? raw : '') as LeaveCreditRowInput['dayType'],
        days: (days[i] ?? '').trim() === '' ? undefined : Number(days[i]),
        claimStart: (starts[i] ?? '').trim() || undefined,
        claimEnd: (ends[i] ?? '').trim() || undefined,
      };
    })
    .filter((r) => r.workedDate !== '');

  try {
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
    redirect(`${PAGE}?error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
  revalidatePath(PAGE);
  // The My Absence card shows the pending figure, so it goes stale on every submission too.
  revalidatePath('/leave');
  const t = await getTranslations('replacementRequest');
  redirect(`${PAGE}?toast=${encodeURIComponent(t('submittedToast'))}`);
}
