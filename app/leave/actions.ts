'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { decideLeave, requestLeave, isEmergencyReasonCategory, type LeaveDurationType } from '@/core/leave';

export async function requestLeaveAction(formData: FormData) {
  const session = await getSession();
  const durationType = (String(formData.get('durationType') || 'full_day') as LeaveDurationType);
  const hoursRaw = String(formData.get('hours') ?? '').trim();
  // Emergency Leave (Phase-B #12): category routes the cascade (illness → paid SICK first); the consent
  // checkbox gates an UNPAID child. Both are inert for non-EL types.
  const reasonCategoryRaw = String(formData.get('reasonCategory') ?? '').trim();
  const reasonCategory = isEmergencyReasonCategory(reasonCategoryRaw) ? reasonCategoryRaw : undefined;
  const unpaidConsent = String(formData.get('unpaidConsent') ?? '') === 'on';
  // Phase-B #13 (ADR-0062): maternity-only s.37 paid-allowance facts. Inert for non-maternity types (the
  // service only reads them for a MATERNITY request). Empty inputs ⇒ undefined ⇒ conservative paid default.
  const survivingChildrenRaw = String(formData.get('survivingChildren') ?? '').trim();
  const confinementDateRaw = String(formData.get('confinementDate') ?? '').trim();
  // Phase-B #15: a non-blocking holiday-completeness warning is surfaced via ?warn= when the request's
  // (state, year) has fewer than the s.60D minimum of 11 gazetted holidays loaded.
  let warnQuery = '';
  try {
    const res = await requestLeave(session, {
      employmentId: String(formData.get('employmentId')),
      leaveTypeId: String(formData.get('leaveTypeId')),
      startDate: String(formData.get('startDate')),
      endDate: String(formData.get('endDate')),
      reason: (formData.get('reason') as string) || undefined,
      durationType,
      hours: durationType === 'hourly' && hoursRaw !== '' ? Number(hoursRaw) : undefined,
      reasonCategory,
      unpaidConsent,
      survivingChildren: survivingChildrenRaw !== '' ? Number(survivingChildrenRaw) : undefined,
      confinementDate: confinementDateRaw !== '' ? confinementDateRaw : undefined,
    });
    const w = res.holidayWarnings?.[0];
    if (w) {
      warnQuery = `?warnHoliday=1&loaded=${w.loaded}&state=${encodeURIComponent(w.state ?? '')}&year=${w.year}`;
    }
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent((e as Error).message)}`);
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
