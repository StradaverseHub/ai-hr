'use server';

/**
 * 3fb1a611 (r279) · the two HR-minted credit actions, on their own route rather than in
 * `app/admin/actions.ts`.
 *
 * Kept local because both of them MOVE MONEY and the reasoning for that belongs next to them: a granted
 * credit takes that worked day out of the overtime prefill (`EXCLUDE_TOIL_BANKED_DAYS`, core/payroll.ts,
 * applied unconditionally in both reads of `attendance.ot_minutes`), and a reversal puts it back. The
 * services enforce the whole rule set — admin-only, the `toil` entitlement, the company policy, the
 * double-bank guard and the First-Schedule floor — so nothing here re-implements a check; `requireAdmin`
 * is the surface's own guard, not the authoritative one, exactly as `app/admin/actions.ts` treats the two
 * sweeps on this page.
 */

import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { grantToilCreditManually, reverseToilCredit } from '@/core/toil';

const PAGE = '/admin/toil';

const str = (v: FormDataEntryValue | null) => String(v ?? '').trim();

/** Grant one replacement-leave credit by hand. Both rows, through `bankToilCreditTx`. */
export async function grantToilCreditAction(formData: FormData) {
  const s = await requireAdmin();
  let granted: Awaited<ReturnType<typeof grantToilCreditManually>>;
  try {
    granted = await grantToilCreditManually(s, {
      employmentId: str(formData.get('employmentId')),
      workedDate: str(formData.get('workedDate')),
      days: Number(str(formData.get('days'))),
      reason: str(formData.get('reason')),
      // The employee's own agreement to take time instead of the statutory overtime cash. Only meaningful
      // for a First-Schedule-eligible employee; the service ignores it for everyone else and REFUSES
      // without it for them, so the checkbox is the record of consent rather than a formality.
      firstScheduleConsent: str(formData.get('firstScheduleConsent')) === '1',
    });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  // ⚠️ The OT figure the grant just suppressed is carried back to the page so the banner SAYS it. A
  // screen that banks a worked day without mentioning that the day stopped being payable is the half of
  // this feature most likely to surprise an administrator at month end.
  const q = new URLSearchParams({ granted: String(granted.daysCredited) });
  if (granted.overtimeSuppressedForDate) {
    q.set('otDate', granted.overtimeSuppressedForDate);
    q.set('otMinutes', String(granted.overtimeSuppressedMinutes));
  }
  redirect(`${PAGE}?${q.toString()}`);
}

/** Undo a hand-minted credit that has not been touched. Removes the register row; the audit survives. */
export async function reverseToilCreditAction(formData: FormData) {
  const s = await requireAdmin();
  let out: Awaited<ReturnType<typeof reverseToilCredit>>;
  try {
    out = await reverseToilCredit(s, {
      accrualId: str(formData.get('accrualId')),
      reason: str(formData.get('reason')) || 'Reversed by an administrator',
    });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  const q = new URLSearchParams({ reversed: String(out.daysReversed) });
  if (out.overtimeRestoredForDate) q.set('otBackDate', out.overtimeRestoredForDate);
  redirect(`${PAGE}?${q.toString()}`);
}
