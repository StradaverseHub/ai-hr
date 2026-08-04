'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  createAttendanceRule,
  deleteAttendanceRule,
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
const bool = (fd: FormData, key: string): boolean => fd.get(key) != null;

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
        rate: Number(x.rate ?? 0) || 0,
        phRate: x.phRate == null || x.phRate === '' ? null : Number(x.phRate) || 0,
        rounding: x.rounding === true || x.rounding === 'true' || x.rounding === 'on',
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
