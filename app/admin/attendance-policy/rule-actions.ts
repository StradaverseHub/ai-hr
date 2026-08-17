'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  copyAttendanceRule,
  createAttendanceRule,
  deleteAttendanceRule,
  setAttendanceRuleStatus,
  updateAttendanceRule,
  type AttendanceRuleInput,
  type OtRowInput,
} from '@/core/attendance-rule';

/**
 * 88e94371 · Server actions for the "Lateness, Early Out & Overtime Settings" rule library. Writes are
 * admin-gated at the DB layer (attendance_rule RLS WITH CHECK app.is_admin() since 6da67ab7 / migration
 * 0319 made the library tenant-wide); the pages are gated by requireAdmin(). The OT rows post as one JSON
 * array (the client island's hidden field), mirroring the shift-form break-periods pattern.
 */
const LIST = '/admin/attendance-policy';
const num = (fd: FormData, key: string): number => Math.trunc(Number(fd.get(key) ?? 0)) || 0;
/** True only when the field is present AND carries a value.
 *
 *  7c834696 contested: this used to be `fd.get(key) != null`, which is correct for a real checkbox — the
 *  browser omits an unchecked one entirely — but WRONG for a hidden input, which is always submitted. The
 *  OT editor's "Apply to Early Overtime" is a controlled React checkbox with no `name`, so its value rides
 *  a hidden field; unticked, that field arrived as an empty string, `'' != null` was true, and the flag
 *  saved as ON every time. It could not be turned off at all, on a setting that folds pre-shift minutes
 *  into paid overtime.
 *
 *  Safe for every caller: a checked checkbox with no explicit `value` submits the string 'on', and none of
 *  the checkboxes on this form carries an explicit value — verified, not assumed. The editor now also omits
 *  the hidden field when off, so the two halves of the fix are independent. */
const bool = (fd: FormData, key: string): boolean => {
  const v = fd.get(key);
  return v != null && v !== '';
};

/** Parse the OT-rows hidden JSON field into typed rows. Invalid / empty ⇒ []. */
function parseOtRows(raw: string): OtRowInput[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        fromMinutes: Math.trunc(Number(x.fromMinutes ?? 0)) || 0,
        toMinutes: Math.trunc(Number(x.toMinutes ?? 0)) || 0,
        ratePattern: x.ratePattern === 'variable' ? 'variable' : 'flat',
        // 7c834696 contested — an ABSENT rate stays absent. `Number(x.rate ?? 0) || 0` used to turn "the
        // admin has not typed a rate" into a stored 0.00, which is a real and different setting ("record
        // the hours, pay nothing"). Now the band that was never filled in is refused on save with a message
        // naming the row, instead of being paid at a number nobody chose.
        rate: x.rate == null || x.rate === '' ? null : Number(x.rate) || 0,
        phRate: x.phRate == null || x.phRate === '' ? null : Number(x.phRate) || 0,
        // 0439 — three modes. Anything else (including the pre-0439 booleans, if a stale tab posts one)
        // normalises to 'none' in core/attendance-rule.ts, which cannot change what a band pays.
        roundingMode: x.roundingMode === 'down' || x.roundingMode === 'up' ? x.roundingMode : 'none',
        roundToMinutes: x.roundToMinutes == null || x.roundToMinutes === '' ? null : Math.trunc(Number(x.roundToMinutes)) || null,
      }));
  } catch {
    return [];
  }
}

function ruleFields(fd: FormData): AttendanceRuleInput {
  return {
    name: String(fd.get('name') ?? '').trim(),
    description: String(fd.get('description') ?? '').trim() || null,
    status: fd.get('status') === 'inactive' ? 'inactive' : 'active',
    lateGracePeriodMinutes: num(fd, 'lateGracePeriodMinutes'),
    lateAfterMinutes: num(fd, 'lateAfterMinutes'),
    lateDeductMinutes: num(fd, 'lateDeductMinutes'),
    includeGraceInLateness: bool(fd, 'includeGraceInLateness'),
    earlyGracePeriodMinutes: num(fd, 'earlyGracePeriodMinutes'),
    earlyAfterMinutes: num(fd, 'earlyAfterMinutes'),
    earlyDeductMinutes: num(fd, 'earlyDeductMinutes'),
    includeGraceInEarlyOut: bool(fd, 'includeGraceInEarlyOut'),
    applyToEarlyOt: bool(fd, 'applyToEarlyOt'),
    // 7c834696 — the deduction switch. The effective-FROM date is deliberately not a form field: the
    // service stamps it, so no request body can back-date a deduction into a closed payroll period.
    applyDeductions: bool(fd, 'applyDeductions'),
    otRows: parseOtRows(String(fd.get('otRows') ?? '')),
  };
}

export async function createAttendanceRuleAction(fd: FormData) {
  const s = await getSession();
  try {
    await createAttendanceRule(s, ruleFields(fd));
  } catch (e) {
    redirect(`${LIST}/rules/new?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(LIST);
  redirect(LIST);
}

export async function updateAttendanceRuleAction(fd: FormData) {
  const s = await getSession();
  const ruleId = String(fd.get('ruleId') ?? '');
  try {
    await updateAttendanceRule(s, { ruleId, ...ruleFields(fd) });
  } catch (e) {
    redirect(`${LIST}/rules/${ruleId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(LIST);
  redirect(LIST);
}

/**
 * ad52212d round 2 — DUPLICATE. Lands the operator on the copy's own edit form, not back on the list: the
 * reason to duplicate a pattern is to change the two or three bands that differ, and dropping them on the
 * list would make them hunt for the row they just created. Same choice, and the same reasoning, as
 * copyShiftAction next door.
 */
export async function copyAttendanceRuleAction(fd: FormData) {
  const s = await getSession();
  let copied: { id: string };
  try {
    copied = await copyAttendanceRule(s, { ruleId: String(fd.get('ruleId') ?? '') });
  } catch (e) {
    redirect(`${LIST}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(LIST);
  redirect(`${LIST}/rules/${copied.id}`);
}

/**
 * ad52212d round 2 — ACTIVATE / DEACTIVATE from the list.
 *
 * The target status rides a hidden field because the two buttons are the same control in two states, and a
 * hidden input is ALWAYS submitted. That is exactly the trap 7c834696 hit on this form (see `bool` above),
 * so the field is read as a VALUE — 'inactive', or anything else meaning 'active'. A presence test would
 * be true on every submission and would turn every one of these buttons into a deactivate button.
 */
export async function setAttendanceRuleStatusAction(fd: FormData) {
  const s = await getSession();
  try {
    await setAttendanceRuleStatus(s, {
      ruleId: String(fd.get('ruleId') ?? ''),
      status: fd.get('status') === 'inactive' ? 'inactive' : 'active',
    });
  } catch (e) {
    redirect(`${LIST}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(LIST);
  redirect(LIST);
}

export async function deleteAttendanceRuleAction(fd: FormData) {
  const s = await getSession();
  try {
    await deleteAttendanceRule(s, { ruleId: String(fd.get('ruleId') ?? '') });
  } catch (e) {
    redirect(`${LIST}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(LIST);
  redirect(LIST);
}
