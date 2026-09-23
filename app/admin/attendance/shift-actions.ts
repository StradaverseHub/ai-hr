'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveShift,
  copyShift,
  createShift,
  deleteShift,
  listShiftsForTenant,
  replaceShiftOtWindows,
  unarchiveShift,
  updateShift,
  type ShiftOtWindowInput,
} from '@/core/roster';
import { listAttendanceRules } from '@/core/attendance-rule';
// aec53564 (r331) — the ONE resolver for "whose working week is this", and the in-memory twin of
// resolveRuleTx's group chain. The FORM greys the day row on this same pair of answers
// (components/shift-time-fields.tsx), which is the point: a greyed control in a browser is not a refusal.
import { weekPatternFor, weekPatternGroupFor } from '@/core/week-pattern';

/**
 * Shift-schedule server actions for the Shift Settings page (/admin/attendance). R33 f21d6eee — the page is
 * now a single SHARED shift library: templates are tenant-global (company_id NULL), so these actions carry
 * no company anchor and redirect straight back to the flat list. Shift writes are admin-gated at the DB
 * layer (migration 0197: shift RLS WITH CHECK app.is_admin()); the page itself is gated by requireAdmin().
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

/** The break-period rows post as one JSON array of { start, end, paid? } 'HH:MM' pairs (the client island's
 *  hidden field). Empty/absent/invalid JSON ⇒ null ⇒ the legacy single breakMinutes scalar is the fallback.
 *  cf21e554 — `paid` is carried through ONLY when true, so an unpaid row is the byte-identical
 *  { start, end } it has always been. */
type PostedBreak = { start: string; end: string; paid?: boolean; flexible?: boolean; flexibleMinutes?: number };
const parseBreakPeriods = (raw: string): PostedBreak[] | null => {
  if (!raw) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const out = arr
      .filter((x): x is PostedBreak => !!x && typeof x === 'object' && 'start' in x && 'end' in x)
      .map((x) => {
        const row: PostedBreak = { start: norm(String(x.start)), end: norm(String(x.end)) };
        if (x.paid === true) row.paid = true;
        // b8aa3466 — the Fixed tick, stored INVERTED as `flexible` and carried through ONLY when true, so a
        // window saved before this release round-trips as the byte-identical { start, end } it always was.
        // Semi-Flexi still forces flexible on every break inside core/roster.ts; this only carries what the
        // operator actually chose on a Normal shift.
        if (x.flexible === true) row.flexible = true;
        // r277 (439565ff) — this row's own allowance. ABSENT stays absent (the break is deducted exactly as
        // it is today); a value present is passed through UNCHECKED so core/roster.ts is the one place that
        // decides whether it is storable — a figure quietly dropped here would deduct the whole window
        // instead, which is more minutes off a payslip than the operator typed.
        if (x.flexibleMinutes != null) row.flexibleMinutes = Number(x.flexibleMinutes);
        return row;
      });
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

/** The three ISO-weekday arrays a shift stores, in the shape core/roster.ts normalizeShiftInput reads. */
type StoredWeek = { weeklyPattern: number[] | null; halfPattern: number[]; offPattern: number[] };

/** A shift that declares no working week of its own. NOT the same as "unchanged": see `weekToWrite`. */
const NO_WEEK: StoredWeek = { weeklyPattern: null, halfPattern: [], offPattern: [] };

/**
 * b8aa3466 — the Mon-Sun row posts one dayKind_<1..7> select ("full" | "half" | "rest" | "off") per ISO
 * weekday instead of a checkbox list. Decode into the three arrays the service expects; REST is the
 * complement and has no array, exactly as "unticked" has none today. An unrecognised value falls to rest,
 * which is what an absent checkbox meant — this is a select, not free text.
 *
 * The legacy `weeklyPattern` checkbox name is still read as a FALLBACK so any caller or test that posts the
 * old shape keeps working unchanged. aec53564 — it is a fallback for the SHAPE of the post, never a way
 * round the rule below: `weekToWrite` discards this whole value when a Schedule Group is deciding, so the
 * old field name reaches the database on exactly the same terms as the new one.
 */
function postedWeek(formData: FormData): StoredWeek {
  const weeklyPattern: number[] = [];
  const halfPattern: number[] = [];
  const offPattern: number[] = [];
  let sawDayKind = false;
  for (let d = 1; d <= 7; d++) {
    const v = formData.get(`dayKind_${d}`);
    if (v == null) continue;
    sawDayKind = true;
    if (v === 'full') weeklyPattern.push(d);
    else if (v === 'half') halfPattern.push(d);
    else if (v === 'off') offPattern.push(d);
  }
  if (!sawDayKind) {
    for (const v of formData.getAll('weeklyPattern')) {
      const d = Number(v);
      if (Number.isInteger(d) && d >= 1 && d <= 7) weeklyPattern.push(d);
    }
  }
  return { weeklyPattern: weeklyPattern.length > 0 ? weeklyPattern : null, halfPattern, offPattern };
}

/** The `rule_id` this save selects — blank ⇒ null ⇒ the tenant's Standard rule (88e94371). */
const postedRuleId = (formData: FormData): string | null =>
  String(formData.get('attendanceRuleId') ?? '').trim() || null;

/**
 * ─── aec53564 (r331) · THE WEEK THIS SAVE IS ALLOWED TO WRITE ────────────────────────────────────────────
 *
 * The Shift form greys its seven day dropdowns when the shift's Schedule Group states a working week, and a
 * disabled <select> submits nothing. THAT IS NOT A REFUSAL. A stale tab opened before the group was given a
 * week, the legacy `weeklyPattern` field name, a copied cURL or a form re-submitted from history all still
 * carry day fields, and before this they were written — to a column nothing reads, because every reader
 * resolves the group first (core/week-pattern.ts `weekPatternFor`). So the write asks the SAME function the
 * screen asked, about the SAME post, and the answer decides whether the posted days count.
 *
 * ⚠️ AND WHEN THEY DO NOT COUNT, THE STORED WEEK IS WRITTEN BACK UNCHANGED — it is not cleared. Two reasons,
 * and both are load-bearing:
 *   · core/roster.ts updateShift is a FULL-ROW OVERWRITE for these three columns (unlike ruleId / otRule,
 *     which are undefined-means-preserve), so "ignore the post" spelled as "pass nothing" would null the
 *     week rather than leave it alone;
 *   · the shift's own week is the FALLBACK. A group whose pattern is emptied later stops winning
 *     immediately, and the shift's row is the only value left to fall back to. Measured on production
 *     2026-09-23: 2 of 8 shifts are living on exactly that fallback today.
 *
 * A NEW shift under a week-setting group stores NO week of its own (`NO_WEEK`), because there is no stored
 * row to preserve and the form could not ask for one — inventing Mon–Fri here would be this action
 * declaring a working week nobody chose. It is the same state a shift saved with all seven days on Rest has
 * always been in, and core/roster.ts refuses to generate a roster from it with a sentence that says so.
 */
async function weekToWrite(
  s: Awaited<ReturnType<typeof getSession>>,
  formData: FormData,
  shiftId: string | null,
): Promise<StoredWeek> {
  const posted = postedWeek(formData);
  // Read by VALUE against the rules that exist for this viewer, exactly as the form's dropdown was built —
  // and WITHOUT a status filter, because resolveRuleTx does not look at `status` either.
  const group = weekPatternGroupFor(await listAttendanceRules(s), postedRuleId(formData));
  // `attendance_rule` spells the full-day list `weekly_pattern`; `WeekPattern` spells it `pattern`, because
  // `shift` does. The same two-line mapping core/attendance.ts toResolved does — not a second opinion about
  // the value, just the column names.
  const groupWeek =
    group == null
      ? null
      : { pattern: group.weeklyPattern, halfPattern: group.halfPattern, offPattern: group.offPattern };
  const postedWeekPattern = {
    pattern: posted.weeklyPattern,
    halfPattern: posted.halfPattern,
    offPattern: posted.offPattern,
  };
  // The SAME call the form makes, about the same two candidates. `source` is what is read here; the form
  // reads the triple as well, to show the week that is actually in force.
  if (weekPatternFor(groupWeek, postedWeekPattern).source !== 'group') return posted;
  if (!shiftId) return NO_WEEK;
  const stored = (await listShiftsForTenant(s, { includeArchived: true })).find((sh) => sh.id === shiftId);
  return stored
    ? { weeklyPattern: stored.weeklyPattern, halfPattern: stored.halfPattern, offPattern: stored.offPattern }
    : NO_WEEK;
}

/** The fields createShift/updateShift share, read off the posted form. `week` is resolved by `weekToWrite`
 *  rather than read here, because deciding it needs a query and this function is pure. */
function shiftFields(formData: FormData, week: StoredWeek) {
  const dk = String(formData.get('differentialKind') ?? '');
  const dv = Number(formData.get('differentialValue') ?? 0);
  const differential =
    DIFF_KINDS.includes(dk as (typeof DIFF_KINDS)[number]) && dv > 0 ? { kind: dk as (typeof DIFF_KINDS)[number], value: dv } : null;
  const overrideRaw = String(formData.get('normalMinutesOverride') ?? '').trim();
  // R17 3e8350db — per-shift "OT Rules". A checkbox posts otEligible='on' when TICKED; an unchecked box
  // posts nothing ⇒ ineligible. Optional min-block / daily-cap minutes. The service collapses a fully-default
  // rule (eligible, no min, no cap) back to null, so a shift that touched none of these stays legacy.
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
    // 7c834696 rev 2 point 4 — lateGraceMinutes / earlyLeaveGraceMinutes are deliberately NOT listed here.
    // The form dropped both inputs (grace belongs to the rule now), and this is a full-row overwrite path:
    // posting a blank would write null and silently clear any stored per-shift override on every save.
    // Omitting the keys leaves them undefined, which normalizeShiftInput/updateShift preserve — the same
    // pattern otRule and ruleId already use for exactly this reason (88e94371).
    // 88e94371 — OT shaping moved to the attendance-rule library; the shift picks a rule via this dropdown.
    // Blank ⇒ null (fall back to the company Standard rule). otRule is intentionally NOT posted here, so the
    // service preserves any pre-existing per-shift OT-shape override untouched.
    ruleId: postedRuleId(formData),
    // aec53564 — NOT the posted day fields: `weekToWrite` above decides whether the post is what is stored.
    weeklyPattern: week.weeklyPattern,
    halfPattern: week.halfPattern,
    offPattern: week.offPattern,
    // b8aa3466 — the daily cut-off pair. An unchecked box posts nothing ⇒ off, which is byte-identical to
    // every shift today; the service refuses enabled-with-no-time rather than storing a state its reader
    // could not honour.
    dailyCutoffEnabled: formData.get('dailyCutoffEnabled') != null,
    dailyCutoffTime: optTime(formData, 'dailyCutoffTime'),
    differential,
    // cf21e554 stage 1 — the General tab. Unlike the two grace fields above these ARE on the form, so a
    // blank box genuinely means "cleared" and posting null is correct.
    description: optStr(formData, 'description'),
    dayType: optStr(formData, 'shiftDayType'),
    category: optStr(formData, 'category'),
    earlyIn: optTime(formData, 'earlyIn'),
    lateOut: optTime(formData, 'lateOut'),
    lateOutNextDay: formData.get('lateOutNextDay') != null,
    fullDayLeaveMinutes: optNum(formData, 'fullDayLeaveMinutes'),
    normalHoursRoundingMinutes: optNum(formData, 'normalHoursRoundingMinutes'),
    fullDayOtMinutes: optNum(formData, 'fullDayOtMinutes'),
    halfDayFirstOut: optTime(formData, 'halfDayFirstOut'),
    halfDaySecondIn: optTime(formData, 'halfDaySecondIn'),
    // 6340aecb — the colour is a RADIO GROUP whose "No colour" option posts an empty string, so blank ⇒
    // null ⇒ the roster keeps its automatic palette for this shift. The service validates the token
    // against the closed palette; anything else is refused rather than stored.
    color: optStr(formData, 'color'),
    // 6340aecb — the FLEXIBLE BREAK. A real checkbox, so an unticked box posts NOTHING and presence is a
    // safe read (unlike a hidden input, which is always submitted — the trap that once shipped a
    // pay-affecting setting nobody could turn off). Off ⇒ the shift computes exactly as it does today.
    flexibleBreakEnabled: formData.get('flexibleBreakEnabled') != null,
    flexibleBreakMinutes: optNum(formData, 'flexibleBreakMinutes'),
  };
}

// R33 f21d6eee — Shared shift library: no company anchor anymore. Redirect straight back to the flat list.
// af7a8eb4 — `at` is the screen the operator was ON when the write failed. The list actions (archive,
// unarchive, copy, delete) are fired from the list, so they keep BASE; create and update are fired from
// their own page now, so a validation error has to land back on the form the operator filled in rather
// than on a list that has forgotten every box they typed. Same idiom as rule-actions.ts.
const errTarget = (e: unknown, at: string = BASE) => `${at}?error=${encodeURIComponent((e as Error).message)}`;

export async function createShiftAction(formData: FormData) {
  const s = await getSession();
  // Tenant-global template (company_id NULL) — a single shared library, assignable to any employee.
  let created: { id: string };
  try {
    created = await createShift(s, shiftFields(formData, await weekToWrite(s, formData, null)));
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
    await updateShift(s, { shiftId, ...shiftFields(formData, await weekToWrite(s, formData, shiftId)) });
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
