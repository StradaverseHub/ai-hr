'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveShift,
  copyShift,
  createShift,
  deleteShift,
  replaceShiftOtWindows,
  unarchiveShift,
  updateShift,
  type ShiftOtWindowInput,
} from '@/core/roster';

/**
 * Shift-schedule server actions for the Shift Settings page (/admin/attendance). R33 f21d6eee — the page is
 * now a single SHARED shift library: templates are tenant-global (company_id NULL), so these actions carry
 * no company anchor and redirect straight back to the flat list. Shift writes are admin-gated at the DB
 * layer (migration 0197: shift RLS WITH CHECK app.is_admin()); the page itself is gated by requireAdmin().
 *
 * r429 (f6819e19) — THE SHIFT PAGE NO LONGER POSTS A WEEK OR A SCHEDULE GROUP. D1/D2 of the approved plan
 * retire the Mon–Sun row and the group picker from this form: which days are worked is now set on the
 * Schedule Group's own page (app/admin/attendance/schedule/group-sections.tsx), and which group a shift
 * belongs to is changed there too (its "Shifts allowed" editor). So `weekToWrite` / `postedWeek` / the
 * `dayKind_<n>` decode / the legacy `weeklyPattern` checkbox fallback / `postedRuleId` are ALL GONE — there
 * is nothing left to decide. `createShift` / `updateShift` simply never receive `weeklyPattern` /
 * `halfPattern` / `offPattern` / `ruleId` keys from this action any more, which is UNDEFINED under the
 * contract those four fields already use for otRule (core/roster.ts): a key a save does not send is a key
 * the stored value survives, and a brand-new shift stores NO week of its own (createShift's own `?? null`).
 */

const BASE = '/admin/attendance';
const norm = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t);

const DIFF_KINDS = ['percent', 'flat_hourly', 'flat_per_shift'] as const;

/** An optional text box: blank ⇒ null so the column says "not configured" rather than storing "". */
const optStr = (formData: FormData, key: string): string | null => {
  const v = String(formData.get(key) ?? '').trim();
  return v === '' ? null : v;
};
/** An optional time box: blank ⇒ null, otherwise normalised to HH:MM:SS. */
const optTime = (formData: FormData, key: string): string | null => {
  const v = String(formData.get(key) ?? '').trim();
  return v === '' ? null : norm(v);
};
/** An optional whole-number box: blank ⇒ null (the service validates the range). */
const optNum = (formData: FormData, key: string): number | null => {
  const v = String(formData.get(key) ?? '').trim();
  return v === '' ? null : Number(v);
};

/**
 * The break-period rows post as one JSON array of 'HH:MM' pairs (the client island's hidden field) — EVERY
 * row the table shows, in order, INCLUDING a half-filled or otherwise invalid one. r429 (f6819e19) · D6 —
 * a half-filled row must be REFUSED by the service, not silently dropped here the way an earlier version of
 * this screen dropped it; the index each row arrives at is what lets core/roster.ts name "Break 2" in a
 * refusal, so nothing here may reorder or skip entries before the service sees them. A row with NEITHER
 * time (the blank row a new shift opens with) is dropped — it saves nothing, by design — and an empty
 * result (or no field at all) ⇒ null ⇒ the legacy single breakMinutes scalar is the fallback. `paid` /
 * `flexible` are carried through ONLY when true, so an unpaid, fixed row is the byte-identical { start,
 * end } it has always been.
 */
type PostedBreak = { start: string; end: string; paid?: boolean; flexible?: boolean; flexibleMinutes?: number };
const parseBreakPeriods = (raw: string): PostedBreak[] | null => {
  if (!raw) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const out = arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && 'start' in x && 'end' in x)
      .map((x) => {
        const row: PostedBreak = { start: norm(String(x.start ?? '').trim()), end: norm(String(x.end ?? '').trim()) };
        if (x.paid === true) row.paid = true;
        // The "Flexible" tick (D4 — one way to set a break, per row). Carried through ONLY when true, so a
        // window saved before this release round-trips as the byte-identical { start, end } it always was.
        // Semi-Flexi still forces flexible on every break inside core/roster.ts; this only carries what the
        // operator actually chose.
        if (x.flexible === true) row.flexible = true;
        // r277 (439565ff) — this row's own allowance. ABSENT stays absent (the break is deducted exactly as
        // it is today); a value present is passed through UNCHECKED so core/roster.ts is the one place that
        // decides whether it is storable — a figure quietly dropped here would deduct the whole window
        // instead, which is more minutes off a payslip than the operator typed.
        if (x.flexibleMinutes != null && String(x.flexibleMinutes).trim() !== '') row.flexibleMinutes = Number(x.flexibleMinutes);
        return row;
      })
      // A row with NEITHER time saves nothing — dropped here (not by the service) so its index never
      // reaches a refusal message; every OTHER row — including a half-filled one — is kept and refused by
      // core/roster.ts if it is not fixable.
      .filter((row) => !(row.start === '' && row.end === ''));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

/**
 * cf21e554 stage 2 — the Overtime Schedule grid posts as one JSON array. An ABSENT field and an EMPTY array
 * are deliberately different: absent means "this form did not carry the tab, leave the windows alone", an
 * empty array means "the operator deleted the last row". Returning null vs [] is what keeps those apart.
 */
const parseOtWindows = (raw: string): ShiftOtWindowInput[] | null => {
  if (!raw) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const num = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
    return arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && 'startTime' in x && 'endTime' in x)
      .map((x) => ({
        label: x.label == null ? null : String(x.label),
        startTime: norm(String(x.startTime)),
        endTime: norm(String(x.endTime)),
        endNextDay: x.endNextDay === true,
        minMinutes: num(x.minMinutes),
        maxMinutes: num(x.maxMinutes),
        adjustAfterMinutes: num(x.adjustAfterMinutes),
        adjustDeltaMinutes: num(x.adjustDeltaMinutes),
      }));
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
    // 7c834696 rev 2 point 4 — lateGraceMinutes / earlyLeaveGraceMinutes are deliberately NOT listed here.
    // The form dropped both inputs (grace belongs to the rule now), and this is a full-row overwrite path:
    // posting a blank would write null and silently clear any stored per-shift override on every save.
    // Omitting the keys leaves them undefined, which normalizeShiftInput/updateShift preserve — the same
    // pattern otRule already uses for exactly this reason (88e94371).
    // r429 (f6819e19) · D2 — ruleId / weeklyPattern / halfPattern / offPattern join that list: the group
    // picker and the day row both left this form, so none of the four is posted at all any more. UNDEFINED
    // ⇒ preserve (core/roster.ts), which is what keeps the two live shifts running on their own fallback
    // week and keeps every shift's group from being silently cleared to Standard on its next save.
    //
    // 88e94371 — OT shaping moved to the attendance-rule library; otRule is intentionally NOT posted here
    // either, so the service preserves any pre-existing per-shift OT-shape override untouched.
    //
    // b8aa3466 — the daily cut-off pair. An unchecked box posts nothing ⇒ off, which is byte-identical to
    // every shift today; the service refuses enabled-with-no-time rather than storing a state its reader
    // could not honour.
    dailyCutoffEnabled: formData.get('dailyCutoffEnabled') != null,
    dailyCutoffTime: optTime(formData, 'dailyCutoffTime'),
    differential,
    // cf21e554 stage 1 — Description and Category stay on the form (Shift Information); a blank box
    // genuinely means "cleared", so posting null is correct for these two.
    description: optStr(formData, 'description'),
    category: optStr(formData, 'category'),
    // r429 (f6819e19) · D3 — day_type / full_day_leave_minutes / full_day_ot_minutes are RECORDED ONLY and
    // no longer rendered. NOT posted here ⇒ undefined ⇒ preserve (core/roster.ts), the same reasoning as
    // the week and the group above: a box that stopped rendering must not be able to clear a stored value.
    //
    // 6340aecb point 8 — relabelled "Earliest clock-in" / "Latest clock-out", still on the form (marked
    // recorded-only), so these three stay a plain post-or-clear.
    earlyIn: optTime(formData, 'earlyIn'),
    lateOut: optTime(formData, 'lateOut'),
    lateOutNextDay: formData.get('lateOutNextDay') != null,
    // cf21e554 — rounding moved to Working Time, beside Full Day Working Hours; still on the form.
    normalHoursRoundingMinutes: optNum(formData, 'normalHoursRoundingMinutes'),
    halfDayFirstOut: optTime(formData, 'halfDayFirstOut'),
    halfDaySecondIn: optTime(formData, 'halfDaySecondIn'),
    // 6340aecb — the colour is a RADIO GROUP whose "No colour" option posts an empty string, so blank ⇒
    // null ⇒ the roster keeps its automatic palette for this shift. The service validates the token
    // against the closed palette; anything else is refused rather than stored.
    color: optStr(formData, 'color'),
    // r429 (f6819e19) · D4 — THE WHOLE-SHIFT SWITCH IS RETIRED FROM THE FORM. It is posted ONLY as an
    // explicit "Stop using it" tick (`stopFlexibleBreak`), which can only ever turn it OFF — the form never
    // offers a way to turn it on. Not ticked (every shift, and every save of a shift that was never in that
    // state) ⇒ neither key is set here ⇒ undefined ⇒ preserve. flexibleBreakMinutes is never posted by this
    // tick (clearing it is what "off" means — core/roster.ts sets it to null whenever the switch goes off).
    ...(formData.get('stopFlexibleBreak') != null ? { flexibleBreakEnabled: false as const } : {}),
  };
}

// R33 f21d6eee — Shared shift library: no company anchor anymore. Redirect straight back to the flat list.
// af7a8eb4 — `at` is the screen the operator was ON when the write failed. The list actions (archive,
// unarchive, copy, delete) are fired from the list, so they keep BASE; create and update are fired from
// their own page now, so a validation error has to land back on the form the operator filled in rather
// than on a list that has forgotten every box they typed. Same idiom as rule-actions.ts.
const errTarget = (e: unknown, at: string = BASE) => `${at}?error=${encodeURIComponent(publicErrorMessage(e))}`;

export async function createShiftAction(formData: FormData) {
  const s = await getSession();
  // Tenant-global template (company_id NULL) — a single shared library, assignable to any employee.
  let created: { id: string };
  try {
    created = await createShift(s, shiftFields(formData));
    const windows = parseOtWindows(String(formData.get('otWindows') ?? ''));
    if (windows) await replaceShiftOtWindows(s, { shiftId: created.id, windows });
  } catch (e) {
    redirect(errTarget(e, `${BASE}/new`));
  }
  revalidatePath(BASE);
  redirect(BASE);
}

export async function updateShiftAction(formData: FormData) {
  const s = await getSession();
  const shiftId = String(formData.get('shiftId') ?? '');
  try {
    await updateShift(s, { shiftId, ...shiftFields(formData) });
    const windows = parseOtWindows(String(formData.get('otWindows') ?? ''));
    if (windows) await replaceShiftOtWindows(s, { shiftId, windows });
  } catch (e) {
    redirect(errTarget(e, `${BASE}/${shiftId}`));
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

/**
 * cf21e554 stage 1 — REACTIVATE a deactivated shift. The service re-checks name and code first: the
 * partial unique indexes skip archived rows, so the name may well have been taken while the shift was off.
 */
export async function unarchiveShiftAction(formData: FormData) {
  const s = await getSession();
  try {
    await unarchiveShift(s, { shiftId: String(formData.get('shiftId') ?? '') });
  } catch (e) {
    redirect(errTarget(e));
  }
  revalidatePath(BASE);
  redirect(BASE);
}

/**
 * cf21e554 stage 1 — COPY a shift. Lands the operator straight on the NEW shift's edit form, because the
 * point of copying is to change the two or three boxes that differ; dropping them back on the list would
 * make them hunt for the row they just created.
 */
export async function copyShiftAction(formData: FormData) {
  const s = await getSession();
  let copied: { id: string };
  try {
    copied = await copyShift(s, { shiftId: String(formData.get('shiftId') ?? '') });
  } catch (e) {
    redirect(errTarget(e));
  }
  revalidatePath(BASE);
  // af7a8eb4 — the copy's own edit PAGE, not the old in-list anchor.
  redirect(`${BASE}/${copied.id}`);
}

/** R17 3e8350db — hard-delete a shift template (distinct from Archive). The service refuses if the shift is
 *  still referenced — roster rows, an employee default, or any dated shift-arrangement period (18504ca6,
 *  live or superseded) — with a ShiftInUseError, whose message is what errTarget puts on the page. */
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
