'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { archiveShift, createShiftMulti, deleteShift, duplicateShift, updateShift } from '@/core/roster';

/**
 * Shift-schedule server actions for the Attendance Policy page (Configurable Multi-Shift Attendance
 * Management). Relocated verbatim from app/roster/actions.ts — same core/roster.ts calls, same
 * error-redirect shape; only the redirect target changed to /admin/attendance. Shift writes stay
 * admin-gated at the DB layer (migration 0075: shift RLS = app.is_admin_for(company_id)); the page itself
 * is gated by requireAdmin(). updateShiftAction is newly wired to a UI here (previously defined but never
 * called from any page).
 *
 * REDIRECT/SCROLL: /admin/attendance renders every visible company as its own Card and does not key state
 * off a companyId URL param, so a plain ?companyId=… is a harmless no-op for the page render. We attach it
 * anyway so a small client island (ScrollToCompany) can read it on mount and scrollIntoView the right
 * company card — Next.js App Router server-action redirect() does NOT reliably preserve a #hash, so we pass
 * the target as a query param and do the scroll client-side.
 */

const BASE = '/admin/attendance';
const norm = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t);

const DIFF_KINDS = ['percent', 'flat_hourly', 'flat_per_shift'] as const;

/** The break-period rows post as one JSON array of { start, end } 'HH:MM' pairs (the client island's hidden
 *  field). Empty/absent/invalid JSON ⇒ null ⇒ the legacy single breakMinutes scalar is the fallback. */
const parseBreakPeriods = (raw: string): { start: string; end: string }[] | null => {
  if (!raw) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const out = arr
      .filter((x): x is { start: string; end: string } => !!x && typeof x === 'object' && 'start' in x && 'end' in x)
      .map((x) => ({ start: norm(String(x.start)), end: norm(String(x.end)) }));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

/** The fields createShift/updateShift share, read off the posted form. */
function shiftFields(formData: FormData) {
  const dk = String(formData.get('differentialKind') ?? '');
  const dv = Number(formData.get('differentialValue') ?? 0);
  const differential =
    DIFF_KINDS.includes(dk as (typeof DIFF_KINDS)[number]) && dv > 0 ? { kind: dk as (typeof DIFF_KINDS)[number], value: dv } : null;
  const overrideRaw = String(formData.get('normalMinutesOverride') ?? '').trim();
  const lateGraceRaw = String(formData.get('lateGraceMinutes') ?? '').trim();
  const earlyLeaveGraceRaw = String(formData.get('earlyLeaveGraceMinutes') ?? '').trim();
  // R17 3e8350db — per-shift "OT Rules". A checkbox posts otEligible='on' when TICKED; an unchecked box
  // posts nothing ⇒ ineligible. Optional min-block / daily-cap minutes. The service collapses a fully-default
  // rule (eligible, no min, no cap) back to null, so a shift that touched none of these stays legacy.
  const otEligible = formData.get('otEligible') != null;
  const otMinRaw = String(formData.get('otMinMinutes') ?? '').trim();
  const otCapRaw = String(formData.get('otDailyCapMinutes') ?? '').trim();
  const otRule = {
    eligible: otEligible,
    ...(otMinRaw === '' ? {} : { minMinutes: Number(otMinRaw) }),
    ...(otCapRaw === '' ? {} : { dailyCapMinutes: Number(otCapRaw) }),
  };
  const weeklyPattern = formData
    .getAll('weeklyPattern')
    .map((v) => Number(v))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return {
    name: String(formData.get('name') ?? '').trim(),
    code: String(formData.get('code') ?? '').trim(),
    startTime: norm(String(formData.get('startTime') ?? '')),
    endTime: norm(String(formData.get('endTime') ?? '')),
    breakMinutes: Number(formData.get('breakMinutes') ?? 0),
    breakPeriods: parseBreakPeriods(String(formData.get('breakPeriods') ?? '')),
    normalMinutesOverride: overrideRaw === '' ? null : Number(overrideRaw),
    // R17 3e8350db — optional per-shift grace windows (blank ⇒ null ⇒ inherit company-policy behaviour).
    lateGraceMinutes: lateGraceRaw === '' ? null : Number(lateGraceRaw),
    earlyLeaveGraceMinutes: earlyLeaveGraceRaw === '' ? null : Number(earlyLeaveGraceRaw),
    otRule,
    weeklyPattern: weeklyPattern.length > 0 ? weeklyPattern : null,
    differential,
  };
}

const okTarget = (companyId: string) => `${BASE}?companyId=${companyId}`;
const errTarget = (companyId: string, e: unknown) =>
  `${BASE}?companyId=${companyId}&error=${encodeURIComponent((e as Error).message)}`;

export async function createShiftAction(formData: FormData) {
  const s = await getSession();
  // R17 3e8350db — centralized authoring: the create form posts one or more companyId checkboxes. Fall
  // back to the single legacy field so a single-company tenant keeps working. The FIRST company is used for
  // the redirect/scroll anchor.
  const companyIds = formData.getAll('companyId').map((v) => String(v)).filter(Boolean);
  const anchor = companyIds[0] ?? '';
  try {
    await createShiftMulti(s, { companyIds, ...shiftFields(formData) });
  } catch (e) {
    redirect(errTarget(anchor, e));
  }
  revalidatePath(BASE);
  redirect(okTarget(anchor));
}

export async function updateShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await updateShift(s, { shiftId: String(formData.get('shiftId') ?? ''), ...shiftFields(formData) });
  } catch (e) {
    redirect(errTarget(companyId, e));
  }
  revalidatePath(BASE);
  redirect(okTarget(companyId));
}

export async function duplicateShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  // R17 3e8350db — optional "copy to…" companies. Empty ⇒ same-company duplicate (legacy). The redirect
  // anchor stays the source company so the shift table scrolls back into view.
  const targetCompanyIds = formData.getAll('targetCompanyId').map((v) => String(v)).filter(Boolean);
  try {
    await duplicateShift(s, {
      shiftId: String(formData.get('shiftId') ?? ''),
      targetCompanyIds: targetCompanyIds.length > 0 ? targetCompanyIds : undefined,
    });
  } catch (e) {
    redirect(errTarget(companyId, e));
  }
  revalidatePath(BASE);
  redirect(okTarget(companyId));
}

export async function archiveShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await archiveShift(s, { shiftId: String(formData.get('shiftId') ?? '') });
  } catch (e) {
    redirect(errTarget(companyId, e));
  }
  revalidatePath(BASE);
  redirect(okTarget(companyId));
}

/** R17 3e8350db — hard-delete a shift template (distinct from Archive). The service refuses if the shift is
 *  still referenced (roster rows or an employee default) with a ShiftInUseError, surfaced on the page. */
export async function deleteShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await deleteShift(s, { shiftId: String(formData.get('shiftId') ?? '') });
  } catch (e) {
    redirect(errTarget(companyId, e));
  }
  revalidatePath(BASE);
  redirect(okTarget(companyId));
}
