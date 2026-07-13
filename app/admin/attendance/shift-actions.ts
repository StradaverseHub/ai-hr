'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { archiveShift, createShift, deleteShift, updateShift } from '@/core/roster';

/**
 * Shift-schedule server actions for the Shift Settings page (/admin/attendance). R33 f21d6eee — the page is
 * now a single SHARED shift library: templates are tenant-global (company_id NULL), so these actions carry
 * no company anchor and redirect straight back to the flat list. Shift writes are admin-gated at the DB
 * layer (migration 0197: shift RLS WITH CHECK app.is_admin()); the page itself is gated by requireAdmin().
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
  const weeklyPattern = formData
    .getAll('weeklyPattern')
    .map((v) => Number(v))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  // f3321963 — shift template type (Normal / Semi-Flexi / Full-Flexi). Blank ⇒ null ⇒ the service defaults to
  // 'normal' (legacy). The service validates the value against the three-value enum + forces the Semi-Flexi
  // break flags.
  const typeRaw = String(formData.get('shiftTemplateType') ?? '').trim();
  return {
    name: String(formData.get('name') ?? '').trim(),
    code: String(formData.get('code') ?? '').trim(),
    type: (typeRaw === '' ? null : typeRaw) as 'normal' | 'semi_flexi' | 'full_flexi' | null,
    startTime: norm(String(formData.get('startTime') ?? '')),
    endTime: norm(String(formData.get('endTime') ?? '')),
    breakMinutes: Number(formData.get('breakMinutes') ?? 0),
    breakPeriods: parseBreakPeriods(String(formData.get('breakPeriods') ?? '')),
    normalMinutesOverride: overrideRaw === '' ? null : Number(overrideRaw),
    // R17 3e8350db — optional per-shift grace windows (blank ⇒ null ⇒ inherit company-policy behaviour).
    lateGraceMinutes: lateGraceRaw === '' ? null : Number(lateGraceRaw),
    earlyLeaveGraceMinutes: earlyLeaveGraceRaw === '' ? null : Number(earlyLeaveGraceRaw),
    // 88e94371 — OT shaping moved to the attendance-rule library; the shift picks a rule via this dropdown.
    // Blank ⇒ null (fall back to the company Standard rule). otRule is intentionally NOT posted here, so the
    // service preserves any pre-existing per-shift OT-shape override untouched.
    ruleId: String(formData.get('attendanceRuleId') ?? '').trim() || null,
    weeklyPattern: weeklyPattern.length > 0 ? weeklyPattern : null,
    differential,
  };
}

// R33 f21d6eee — Shared shift library: no company anchor anymore. Redirect straight back to the flat list.
const errTarget = (e: unknown) => `${BASE}?error=${encodeURIComponent((e as Error).message)}`;

export async function createShiftAction(formData: FormData) {
  const s = await getSession();
  // Tenant-global template (company_id NULL) — a single shared library, assignable to any employee.
  try {
    await createShift(s, shiftFields(formData));
  } catch (e) {
    redirect(errTarget(e));
  }
  revalidatePath(BASE);
  redirect(BASE);
}

export async function updateShiftAction(formData: FormData) {
  const s = await getSession();
  try {
    await updateShift(s, { shiftId: String(formData.get('shiftId') ?? ''), ...shiftFields(formData) });
  } catch (e) {
    redirect(errTarget(e));
  }
  revalidatePath(BASE);
  redirect(BASE);
}

export async function archiveShiftAction(formData: FormData) {
  const s = await getSession();
  try {
    await archiveShift(s, { shiftId: String(formData.get('shiftId') ?? '') });
  } catch (e) {
    redirect(errTarget(e));
  }
  revalidatePath(BASE);
  redirect(BASE);
}

/** R17 3e8350db — hard-delete a shift template (distinct from Archive). The service refuses if the shift is
 *  still referenced (roster rows or an employee default) with a ShiftInUseError, surfaced on the page. */
export async function deleteShiftAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteShift(s, { shiftId: String(formData.get('shiftId') ?? '') });
  } catch (e) {
    redirect(errTarget(e));
  }
  revalidatePath(BASE);
  redirect(BASE);
}
