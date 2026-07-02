'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { archiveShift, assignShift, assignShiftBulk, clearRoster, createShift, duplicateShift, setRestDay, updateShift } from '@/core/roster';
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

const normTime = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t);

/** Apply a "brush" to one (employee, date) cell of the roster grid: a shift id, 'rest', or 'clear'.
 *  Returns the outcome to the client island (no navigation). */
export async function assignCellAction(input: { employmentId: string; shiftDate: string; brush: string }): Promise<CellResult> {
  const s = await getSession();
  const { employmentId, shiftDate, brush } = input;
  try {
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
      .map((x) => ({ start: normTime(String(x.start)), end: normTime(String(x.end)) }));
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
  return {
    name: String(formData.get('name') ?? '').trim(),
    code: String(formData.get('code') ?? '').trim(),
    startTime: normTime(String(formData.get('startTime') ?? '')),
    endTime: normTime(String(formData.get('endTime') ?? '')),
    breakMinutes: Number(formData.get('breakMinutes') ?? 0),
    breakPeriods: parseBreakPeriods(String(formData.get('breakPeriods') ?? '')),
    normalMinutesOverride: overrideRaw === '' ? null : Number(overrideRaw),
    differential,
  };
}

export async function createShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await createShift(s, { companyId, ...shiftFields(formData) });
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/roster');
  redirect(`/roster?companyId=${companyId}`);
}

export async function updateShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await updateShift(s, { shiftId: String(formData.get('shiftId') ?? ''), ...shiftFields(formData) });
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/roster');
  redirect(`/roster?companyId=${companyId}`);
}

export async function duplicateShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await duplicateShift(s, { shiftId: String(formData.get('shiftId') ?? '') });
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/roster');
  redirect(`/roster?companyId=${companyId}`);
}

export async function archiveShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await archiveShift(s, { shiftId: String(formData.get('shiftId') ?? '') });
  } catch (e) {
    redirect(`/roster?companyId=${companyId}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/roster');
  redirect(`/roster?companyId=${companyId}`);
}
