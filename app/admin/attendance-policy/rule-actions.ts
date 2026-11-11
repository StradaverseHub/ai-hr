'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  copyAttendanceRule,
  createAttendanceRule,
  deleteAttendanceRule,
  setAttendanceRuleStatus,
  setRuleShifts,
  updateAttendanceRule,
  updateAttendanceRuleSection,
  type AttendanceRuleInput,
} from '@/core/attendance-rule';
import { getTranslations } from 'next-intl/server';
import { SCHEDULE, scheduleGroupEditPath, scheduleGroupNewPath } from './schedule-panel';
import { failScheduleGroup, okScheduleGroup } from '../_redirects';
import { withTenant } from '@/db/client';
import { lockAccessConfigurationWriteTx } from '@/core/access-configuration-lock';
import { sql } from 'drizzle-orm';
import { getScheduleRotation, lockAttendanceClockPolicyConfigurationTx, saveScheduleGroupClockPolicy, saveScheduleRotation } from '@/packs/attendance/service';
import { readScheduleClockPolicyFields } from '../attendance/schedule/clock-policy-fields';
import { parseOtRows } from '../attendance/schedule/overtime-fields';
import type { RotationCycle } from '@/core/week-pattern';

/**
 * 88e94371 · Server actions for the "Lateness, Early Out & Overtime Settings" rule library. Writes are
 * admin-gated at the DB layer (attendance_rule RLS WITH CHECK app.is_admin() since 6da67ab7 / migration
 * 0319 made the library tenant-wide); the pages are gated by requireAdmin(). The OT rows post as one JSON
 * array (the client island's hidden field), mirroring the shift-form break-periods pattern.
 *
 * 6d091cc0 (r301) — EVERY RETURN ADDRESS MOVED, AND NOTHING ELSE DID. The Schedule Group list and its editor
 * were on Attendance › Schedule › General: the list a card, the editor a panel opened by `?editGroup=`.
 *
 * ══ 665de026 (r331) — THEY MOVED AGAIN, AND NOTHING ELSE DID AGAIN ═════════════════════════════════════════
 * The reporter contested r301's shape (one page carrying every Schedule Group's settings at once), so
 * Schedule is list + detail now and this file's return addresses follow the card, exactly as they did in r301:
 *
 *   · A SAVE STAYS ON THE RECORD. `updateAttendanceRuleAction` used to end `redirect(LIST)` — the operator
 *     who corrected one grace period was thrown back to the list and had to find the group again. It now
 *     returns to that group's Edit page, on the General section, with a confirmation (`okScheduleGroup`,
 *     app/admin/_redirects.ts — okCompany's contract from r329, which exists so this URL is built in ONE
 *     place: `fail()`/`ok()` concatenate `?error=` onto whatever they are handed, and a path that already
 *     carried a query key produced `…?tab=general?toast=Saved` twice in this repo, r287 and r301).
 *   · A REFUSAL LANDS ON THE FORM THAT RAISED IT, never on the list: `fail(LIST, e)` would have shown
 *     "A rule named “X” already exists." on a screen with no name field on it, with the typing gone.
 *   · CREATE LANDS ON THE GROUP IT JUST CREATED (its Edit page), not on the list. Add Schedule can only
 *     carry the group's identity — the working week, the grace periods and the rounding belong to a row
 *     that does not exist yet — so the operator's next step is that page, every time.
 *   · DUPLICATE still lands on the COPY — the same "land on the copy" choice ad52212d made, at its third
 *     address. ACTIVATE / DEACTIVATE and DELETE still land on the LIST, because they are row actions ON the
 *     list and a delete has no record page left to return to.
 *
 * The field parsing, the `bool` / marker contracts and the service calls below are untouched.
 * /admin/attendance-policy and its rules/new + rules/[ruleId] pages are redirects to the new addresses
 * (bookmarks keep working).
 */
const LIST = SCHEDULE;
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


function ruleFields(fd: FormData): AttendanceRuleInput {
  return {
    name: String(fd.get('name') ?? '').trim(),
    label:String(fd.get('label')??'').trim()||null,
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

/**
 * 870b79e2 — the "Shifts allowed" selection, or `null` when this submission did not carry the editor.
 *
 * ⚠️ THE DISTINCTION IS THE WHOLE POINT, AND IT CANNOT BE READ FROM THE CHECKBOXES. A browser omits an
 * unchecked checkbox entirely, so "the administrator cleared every shift" and "this form never had the
 * editor on it" both arrive as an empty `getAll('allowedShiftIds')`. Reading the boxes alone would make
 * removing the last shift from a group silently do nothing — the exact shape of defect CLAUDE.md §8 names
 * ("a form field that is always submitted cannot be read by presence"), inverted.
 *
 * The marker is therefore a hidden field read as a VALUE ('1'), never by presence — the same correction
 * 7c834696 had to make to `bool` above, for the same reason. A caller that does not send it (a script, a
 * future partial form) leaves the group's shifts untouched instead of wiping them.
 */
function allowedShiftIds(fd: FormData): string[] | null {
  if (fd.get('allowedShiftsEditor') !== '1') return null;
  return fd.getAll('allowedShiftIds').map((v) => String(v)).filter(Boolean);
}

export async function createAttendanceRuleAction(fd: FormData) {
  const s = await getSession();
  let created: { id: string };
  let section: 'general' | 'attendance' = 'general';
  try {
    section='attendance';
    const clock = readScheduleClockPolicyFields(fd);
    const shiftIds = allowedShiftIds(fd);
    const weekdays = Array.from({length:7}, (_,index)=>String(fd.get(`createDayKind_${index+1}`)??''));
    if (weekdays.some(kind=>!['','full','half','off','rest'].includes(kind))) throw new Error('Choose a valid schedule for each day.');
    const week=weekdays.some(Boolean)?{
      weeklyPattern: weekdays.flatMap((kind,index)=>kind==='full'?[index+1]:[]),
      halfPattern: weekdays.flatMap((kind,index)=>kind==='half'?[index+1]:[]),
      offPattern: weekdays.flatMap((kind,index)=>kind==='off'?[index+1]:[]),
    }:null;
    section='general';
    created = await withTenant(s, async tx => {
      await lockAccessConfigurationWriteTx(tx,s.tenantId);
      if (clock) await lockAttendanceClockPolicyConfigurationTx(tx, s);
      if(week){
        const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.principal_snapshot_current() and app.is_group_admin() as allowed`);
        if(!authority?.allowed)throw new Error('A group-wide HR administrator is required to set a shared working week.');
      }
      const result = await createAttendanceRule(s, {...ruleFields(fd),...week}, tx);
      if (shiftIds?.length) await setRuleShifts(s, {ruleId: result.id, shiftIds, expectedShiftIds:[]}, tx);
      if (fd.get('createRotation')==='1') {
        // c03670cc — the Duty Roster lives in General, directly under Shift Allowed.
        section='general';
        const raw=String(fd.get('cycle')??'');
        if(raw.length>100_000)throw new Error('The rotation is too large.');
        const cycle=JSON.parse(raw) as RotationCycle;
        const postedUnit=fd.get('rotationUnitDraft'), postedLength=fd.get('rotationLengthDraft');
        if((postedUnit!=null&&postedUnit!==cycle.unit)||(postedLength!=null&&Number(postedLength)!==cycle.length)){
          throw new Error('Generate the rotation again before saving the changed unit or length.');
        }
        const {revision}=await getScheduleRotation(s,result.id,tx);
        await saveScheduleRotation(s,{ruleId:result.id,expectedRevision:revision,allowedShiftIds:shiftIds??[],cycle},tx);
      }
      if (clock) {
        section = 'attendance';
        const reason = (await getTranslations('scheduleGroupEditor'))('systemReason');
        await saveScheduleGroupClockPolicy(s, {ruleId: result.id, scope: clock.scope, policy: clock.policy,
          expected: clock.expected, reason}, tx);
      }
      return result;
    });
  } catch (e) {
    const query = new URLSearchParams({error: publicErrorMessage(e)});
    if(section!=='general')query.set('section',section);
    redirect(`${scheduleGroupNewPath()}?${query}${section!=='general'?`#section-${section}`:''}`);
  }
  revalidatePath(LIST);
  const t = await getTranslations('admin.scheduleConfig');
  okScheduleGroup(created.id, t('createdToast'), 'general');
}

/** General on the sectioned Schedule Group page owns identity/ladder only. Wage Deductions is written by
 * the Attendance section (c03670cc), so this action no longer reads `applyDeductions`.
 * Full legacy RuleForm actions above/below keep their existing complete-form semantics. */
export async function saveScheduleGroupGeneralAction(fd: FormData) {
  const s = await getSession();
  const ruleId = String(fd.get('ruleId') ?? '');
  try {
    await updateAttendanceRuleSection(s, {ruleId,section:'general',
      name:String(fd.get('name')??'').trim(),label:String(fd.get('label')??'').trim()||null,description:String(fd.get('description')??'').trim()||null,
      status:fd.get('status')==='inactive'?'inactive':'active',
      ...(fd.has('otRows') ? {otRows: parseOtRows(String(fd.get('otRows')))} : {}),
    });
  } catch(e) {failScheduleGroup(e,ruleId,'general');}
  const t=await getTranslations('admin.scheduleConfig');
  okScheduleGroup(ruleId,t('savedToast'),'general',String(fd.get('__attendanceSaveNonce')??''));
}

export async function updateAttendanceRuleAction(fd: FormData) {
  const s = await getSession();
  const ruleId = String(fd.get('ruleId') ?? '');
  try {
    await updateAttendanceRule(s, { ruleId, ...ruleFields(fd) });
    // 870b79e2 — and the Shifts allowed list, which writes shift.rule_id for the ticked shifts and clears
    // it for the ones that were unticked. Null ⇒ this submission did not carry the editor; leave it alone.
    const shiftIds = allowedShiftIds(fd);
    if (shiftIds) await setRuleShifts(s, { ruleId, shiftIds });
  } catch (e) {
    failScheduleGroup(e, ruleId, 'general');
  }
  revalidatePath(LIST);
  const t = await getTranslations('admin.scheduleConfig');
  okScheduleGroup(ruleId, t('savedToast'), 'general', String(fd.get('__attendanceSaveNonce') ?? ''));
}

/**
 * ad52212d round 2 — DUPLICATE. Lands the operator on the copy's own Edit Schedule page (665de026; r301: the
 * copy's editor panel on the Schedule General tab), not back on the list: the reason to duplicate a pattern is
 * to change the two or three bands that differ, and dropping them on the list would make them hunt for the row
 * they just created. Same choice, and the same reasoning, as copyShiftAction next door.
 *
 * ⚠️ `copyAttendanceRule` copies the source's WORKING WEEK too (core/attendance-rule.ts:860-862, 07ebd04d), so
 * the copy is a faithful duplicate and not a group that silently schedules nothing.
 */
export async function copyAttendanceRuleAction(fd: FormData) {
  const s = await getSession();
  let copied: { id: string };
  try {
    copied = await copyAttendanceRule(s, { ruleId: String(fd.get('ruleId') ?? '') });
  } catch (e) {
    redirect(`${LIST}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(LIST);
  const t = await getTranslations('admin.scheduleConfig');
  okScheduleGroup(copied.id, t('duplicatedToast'), 'general');
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
    redirect(`${LIST}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(LIST);
  redirect(LIST);
}

export async function deleteAttendanceRuleAction(fd: FormData) {
  const s = await getSession();
  try {
    await deleteAttendanceRule(s, { ruleId: String(fd.get('ruleId') ?? '') });
  } catch (e) {
    redirect(`${LIST}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(LIST);
  redirect(LIST);
}
