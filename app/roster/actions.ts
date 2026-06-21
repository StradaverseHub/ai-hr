'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { archiveShift, assignShift, assignShiftBulk, clearRoster, createShift, setRestDay } from '@/core/roster';

export type CellResult = { ok: true } | { ok: false; error: string };

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

export async function createShiftAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await createShift(s, {
      companyId,
      name: String(formData.get('name') ?? '').trim(),
      startTime: normTime(String(formData.get('startTime') ?? '')),
      endTime: normTime(String(formData.get('endTime') ?? '')),
      breakMinutes: Number(formData.get('breakMinutes') ?? 0),
    });
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
