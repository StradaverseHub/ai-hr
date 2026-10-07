'use server';

/**
 * 3fb1a611 (r299) · Leave Config › Leave Credit — the three actions this screen owns.
 *
 * Kept beside the page rather than in app/admin/actions.ts because two of them MOVE MONEY and the reasoning
 * belongs next to them: adding a credit takes that worked day's overtime out of payroll
 * (core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS, both reads, unconditional) and reversing one puts it back. The
 * figure each moved is carried back to the page so the banner SAYS it.
 *
 * NOTHING IS DECIDED HERE. The services enforce the whole rule set — admin-only, the `toil` entitlement (for
 * adding), the rest/off/holiday day gate, the double-credit guard, the First Schedule floor, the expiry rule
 * and the unused/unexpired rule for reversal. `requireAdmin` is this surface's own guard, not the authority:
 * a server action is one POST away from being called directly.
 *
 * The policy form on the Rules tab still posts `setToilPolicyAction` in app/admin/actions.ts, and the two
 * settlement sweeps still post `runToilExpiryAction` / `closeReplacementLeaveYearAction` there; their return
 * addresses were repointed at this page in the same commit.
 */

import { publicErrorMessage } from '@/lib/public-error';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import {
  grantLeaveCreditRows,
  isLeaveCreditDayType,
  leaveCreditGrantContext,
  leaveCreditGrantDayFacts,
  reverseLeaveCredit,
  type LeaveCreditGrantContext,
  type LeaveCreditRowInput,
} from '@/packs/leave/service';
import { todayInKualaLumpur } from '@/lib/hr-date';

const PAGE = '/admin/leave-config/leave-credit';
const str = (v: FormDataEntryValue | null) => String(v ?? '').trim();

/**
 * r406 952129bb — `previewLeaveCreditAction` and `grantLeaveCreditAction` STOOD HERE: the one-date, typed-days
 * Add form (components/leave/leave-credit-add-dialog.tsx, deleted with them). + Add Leave Credit is now the
 * employee's own Leave Credit form plus an Employee picker, and the three actions below feed it. The kernel
 * functions they called (`previewLeaveCredit`, `grantLeaveCredit`) stay: the suite drives them directly.
 */

/** After HR picks the employee: that employee's company tiers, switches and statutory floor. Best-effort. */
export async function leaveCreditGrantContextAction(employmentId: string): Promise<LeaveCreditGrantContext | null> {
  const s = await requireAdmin();
  if (!employmentId) return null;
  try {
    return await leaveCreditGrantContext(s, { employmentId, today: todayInKualaLumpur() });
  } catch {
    return null;
  }
}

/**
 * One date's facts for the PICKED employee — the employee form's own view, plus the overtime already recorded
 * (⚠️ MONEY: a credit stops it being paid) and whether the date already holds a credit. Listed field by field:
 * this is the server→client boundary (test/server-client-boundary.test.ts). Rejects rather than returning
 * null on a server failure, so the table's retry is offered — the employee action's contract.
 */
export async function leaveCreditGrantDayFactsAction(workedDate: string, employmentId?: string) {
  const s = await requireAdmin();
  if (!employmentId || !/^\d{4}-\d{2}-\d{2}$/.test(workedDate)) return null;
  const day = await leaveCreditGrantDayFacts(s, { employmentId, workedDate });
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
    overtimeMinutes: day.overtimeMinutes,
    alreadyCredited: day.alreadyCredited,
  };
}

/**
 * + Add Leave Credit — the rows of the employee's form, granted DIRECTLY (`grantLeaveCreditRows`). The four
 * row lists are zipped BY INDEX, exactly as `submitLeaveCreditRequestAction` does, for that action's reason:
 * the table posts them from hidden inputs present on every row. The consent is read as the checkbox's default
 * value, `'on'` — the employee form's checkbox, now this form's too.
 */
export async function grantLeaveCreditRowsAction(formData: FormData) {
  const s = await requireAdmin();
  const dates = formData.getAll('workedDate').map(String);
  const dayTypes = formData.getAll('dayType').map(String);
  const starts = formData.getAll('claimStart').map(String);
  const ends = formData.getAll('claimEnd').map(String);
  const rows: LeaveCreditRowInput[] = dates
    .map((workedDate, i) => {
      const raw = (dayTypes[i] ?? '').trim();
      return {
        workedDate: workedDate.trim(),
        dayType: (isLeaveCreditDayType(raw) ? raw : '') as LeaveCreditRowInput['dayType'],
        claimStart: (starts[i] ?? '').trim() || undefined,
        claimEnd: (ends[i] ?? '').trim() || undefined,
      };
    })
    .filter((r) => r.workedDate !== '');
  let granted: Awaited<ReturnType<typeof grantLeaveCreditRows>>;
  try {
    granted = await grantLeaveCreditRows(s, {
      employmentId: str(formData.get('employmentId')),
      rows,
      reason: str(formData.get('reason')),
      firstScheduleConsent: str(formData.get('firstScheduleConsent')) === 'on',
      today: todayInKualaLumpur(),
    });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PAGE);
  const q = new URLSearchParams({ granted: String(granted.totalDays) });
  if (granted.overtimeSuppressedMinutes > 0) {
    // ⚠️ MONEY, carried to the banner: every date whose overtime this grant suppressed, and the total.
    q.set('otDate', granted.overtimeDates.join(','));
    q.set('otMinutes', String(granted.overtimeSuppressedMinutes));
  }
  redirect(`${PAGE}?${q.toString()}`);
}

/** Reverse one unused, unexpired credit. Nothing is deleted. */
export async function reverseLeaveCreditAction(formData: FormData) {
  const s = await requireAdmin();
  let out: Awaited<ReturnType<typeof reverseLeaveCredit>>;
  try {
    out = await reverseLeaveCredit(s, {
      accrualId: str(formData.get('accrualId')),
      reason: str(formData.get('reason')),
      today: todayInKualaLumpur(),
    });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PAGE);
  const q = new URLSearchParams({ reversed: String(out.daysReversed) });
  if (out.overtimeRestoredMinutes > 0) {
    q.set('otBackDate', out.workedDate);
    q.set('otBackMinutes', String(out.overtimeRestoredMinutes));
  }
  redirect(`${PAGE}?${q.toString()}`);
}
