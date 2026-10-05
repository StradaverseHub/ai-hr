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
import { grantLeaveCredit, previewLeaveCredit, reverseLeaveCredit, type LeaveCreditPreview } from '@/packs/leave/service';
import { todayInKualaLumpur } from '@/lib/hr-date';

const PAGE = '/admin/leave-config/leave-credit';
const str = (v: FormDataEntryValue | null) => String(v ?? '').trim();

/**
 * What the Add form shows before save for the employee and date typed: the kind of day, recorded overtime,
 * the default expiry, and whether the statutory floor applies. Best-effort — a failure renders nothing and
 * the save is still refused by the service if it should be.
 */
export async function previewLeaveCreditAction(p: {
  employmentId: string;
  workedDate: string;
}): Promise<LeaveCreditPreview | null> {
  const s = await requireAdmin();
  if (!p.employmentId || !/^\d{4}-\d{2}-\d{2}$/.test(p.workedDate)) return null;
  try {
    return await previewLeaveCredit(s, { employmentId: p.employmentId, workedDate: p.workedDate });
  } catch {
    return null;
  }
}

/** + Add Leave Credit. */
export async function grantLeaveCreditAction(formData: FormData) {
  const s = await requireAdmin();
  let granted: Awaited<ReturnType<typeof grantLeaveCredit>>;
  const workedDate = str(formData.get('workedDate'));
  try {
    granted = await grantLeaveCredit(s, {
      employmentId: str(formData.get('employmentId')),
      workedDate,
      days: Number(str(formData.get('days'))),
      reason: str(formData.get('reason')),
      remarks: str(formData.get('remarks')) || undefined,
      expiresOn: str(formData.get('expiresOn')) || undefined,
      // The employee's recorded agreement to take time instead of statutory overtime cash. Read by presence
      // of the exact value the checkbox posts; the service refuses without it for a First-Schedule employee
      // and ignores it for everyone else.
      firstScheduleConsent: str(formData.get('firstScheduleConsent')) === '1',
      today: todayInKualaLumpur(),
    });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PAGE);
  const q = new URLSearchParams({ granted: String(granted.daysCredited) });
  if (granted.overtimeSuppressedMinutes > 0) {
    q.set('otDate', workedDate);
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
