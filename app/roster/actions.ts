'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  assertRosterDatesWritable,
  assignRosterRow,
  assignShift,
  assignShiftBulk,
  clearRoster,
  copyRoster,
  generateRosterFromTemplate,
  setRestDay,
} from '@/core/roster';
import { accrueToil, ToilFirstScheduleConsentRequiredError } from '@/core/toil';

export type CellResult = { ok: true } | { ok: false; error: string };

export type AccrueToilResult =
  | { ok: true; daysCredited: number; warning?: string; premiumEquivalentWarning?: string }
  // Phase-B #14: a First-Schedule election refused for want of per-election consent — the UI prompts for the
  // employee's agreement and retries with firstScheduleConsent:true.
  | { ok: false; needsConsent: true }
  | { ok: false; error: string };

/** ADR-0033 — bank a worked rest day as time in lieu from the roster variance card. Phase-B #14: a
 *  First-Schedule (≤ RM4,000) election requires explicit per-election consent (`firstScheduleConsent`); the
 *  service refuses without it so the UI can prompt for the employee's agreement before retrying. */
export async function accrueToilAction(input: {
  employmentId: string;
  workedDate: string;
  firstScheduleConsent?: boolean;
}): Promise<AccrueToilResult> {
  const s = await getSession();
  try {
    const r = await accrueToil(s, input);
    revalidatePath('/roster');
    return {
      ok: true,
      daysCredited: r.daysCredited,
      warning: r.complianceWarning,
      premiumEquivalentWarning: r.premiumEquivalentWarning,
    };
  } catch (e) {
    if (e instanceof ToilFirstScheduleConsentRequiredError) return { ok: false, needsConsent: true };
    return { ok: false, error: (e as Error).message };
  }
}

/** Apply a "brush" to one (employee, date) cell of the roster grid: a shift id, 'rest', or 'clear'.
 *  Returns the outcome to the client island (no navigation).
 *
 *  23390097 — the past-date right is RE-CHECKED here. The grid disables those cells for a non-admin, but
 *  a disabled button is an affordance, not a guard: the action is reachable directly. */
export async function assignCellAction(input: { employmentId: string; shiftDate: string; brush: string }): Promise<CellResult> {
  const s = await getSession();
  const { employmentId, shiftDate, brush } = input;
  try {
    assertRosterDatesWritable(s, [shiftDate]);
    if (brush === 'rest') await setRestDay(s, { employmentId, shiftDate });
    else if (brush === 'clear') await clearRoster(s, { employmentId, shiftDate });
    else await assignShift(s, { employmentId, shiftDate, shiftId: brush });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Bulk-apply a brush to many employees across a date range (the roster-grid bulk bar). */
export async function bulkAssignAction(input: {
  employmentIds: string[];
  shiftDates: string[];
  brush: string;
}): Promise<CellResult> {
  const s = await getSession();
  try {
    assertRosterDatesWritable(s, input.shiftDates);
    if (input.brush === 'clear') {
      for (const employmentId of input.employmentIds) {
        for (const shiftDate of input.shiftDates) await clearRoster(s, { employmentId, shiftDate });
      }
    } else if (input.brush === 'rest') {
      for (const employmentId of input.employmentIds) {
        for (const shiftDate of input.shiftDates) await setRestDay(s, { employmentId, shiftDate });
      }
    } else {
      await assignShiftBulk(s, { employmentIds: input.employmentIds, shiftDates: input.shiftDates, shiftId: input.brush });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 23390097 — the row Edit panel: ONE employee, several ticked dates, one shift.
 *
 * It routes through assignRosterRow, NOT bulkAssignAction. The bulk primitives write a single summary
 * event with a shift id and counts — no per-date row and no previous shift — and requirement 10 asks the
 * Audit Trail for exactly those. One employee × at most 31 dates is bounded, so the per-date events the
 * bulk path exists to avoid are affordable here. assignRosterRow re-checks the past-date right too.
 */
export async function rowAssignAction(input: {
  employmentId: string;
  shiftDates: string[];
  brush: string;
}): Promise<CellResult> {
  const s = await getSession();
  try {
    await assignRosterRow(s, input);
    revalidatePath('/roster');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** R7 Phase 2 — generate a roster window from a shift's weekly pattern: shift + scope (explicit employees
 *  or a whole department; department wins when both are posted) + date range → the thin generator over the
 *  existing bulk primitives. Success redirects to the window's first week with a summary banner. */
export async function generateRosterAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const from = String(formData.get('from') ?? '');
  const departmentId = String(formData.get('departmentId') ?? '').trim();
  const employmentIds = formData.getAll('employmentIds').map(String).filter(Boolean);
  let summary: { employments: number; workingRows: number; restRows: number };
  try {
    summary = await generateRosterFromTemplate(s, {
      shiftId: String(formData.get('shiftId') ?? ''),
      ...(departmentId ? { departmentId } : { employmentIds }),
      from,
      to: String(formData.get('to') ?? ''),
    });
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/roster');
  redirect(
    `/roster?companyId=${companyId}&month=${from.slice(0, 7)}&generated=${summary.employments}.${summary.workingRows}.${summary.restRows}`,
  );
}

/** R17 3e8350db — "Copy roster schedules from previous weeks or months". Copies every roster row from a
 *  source window forward onto a target window that starts at `targetFrom`, preserving each row's day-offset.
 *  Scope is the whole company's active employees (posted as employmentIds) so a manager copies exactly the
 *  team they see on the grid; RLS still gates each write. Success lands on the target week with a banner. */
export async function copyRosterAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const targetFrom = String(formData.get('targetFrom') ?? '');
  const employmentIds = formData.getAll('employmentIds').map(String).filter(Boolean);
  let summary: { copied: number; sourceRows: number };
  try {
    summary = await copyRoster(s, {
      sourceFrom: String(formData.get('sourceFrom') ?? ''),
      sourceTo: String(formData.get('sourceTo') ?? ''),
      targetFrom,
      ...(employmentIds.length > 0 ? { employmentIds } : {}),
    });
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/roster');
  redirect(`/roster?companyId=${companyId}&month=${targetFrom.slice(0, 7)}&copied=${summary.copied}`);
}
