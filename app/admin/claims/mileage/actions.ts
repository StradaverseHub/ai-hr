'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { setMileageRateTable, type MileageBand } from '@/core/claims';

const BASE = '/admin/claims/mileage';

/** Round-trip the screen's selection so an error or a save never bounces the admin to a different grade or
 *  claim type than the one they were editing — the same reason the limits action carries ?gradeId=. */
const backTo = (claimTypeId: string, gradeId: string | null, vehicleClass: string, extra: string): string => {
  const q = new URLSearchParams({ claimTypeId, vehicleClass });
  if (gradeId) q.set('gradeId', gradeId);
  return `${BASE}?${q.toString()}&${extra}`;
};

/**
 * Save ONE mileage rate table (claim type × grade × vehicle class), effective-dated.
 *
 * The bands arrive as three parallel arrays from repeated inputs named fromKm/toKm/ratePerKm — a plain GET/POST
 * form, no client state. A row whose rate is blank is DROPPED rather than treated as zero: an empty trailing
 * row is what a "add another band" UI leaves behind, and pricing a distance at RM 0.00 because of it is the
 * silent-underpayment failure assertValidMileageBands exists to prevent.
 */
export async function setMileageRateTableAction(formData: FormData) {
  const s = await getSession();
  const claimTypeId = String(formData.get('claimTypeId') ?? '');
  const gradeId = String(formData.get('gradeId') ?? '').trim() || null;
  const vehicleClass = String(formData.get('vehicleClass') ?? 'any');
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');

  const fromKm = formData.getAll('fromKm').map((v) => String(v).trim());
  const toKm = formData.getAll('toKm').map((v) => String(v).trim());
  const rate = formData.getAll('ratePerKm').map((v) => String(v).trim());

  const bands: MileageBand[] = [];
  for (let i = 0; i < rate.length; i++) {
    if (rate[i] === '') continue;
    bands.push({
      fromKm: fromKm[i] === '' || fromKm[i] == null ? 0 : Number(fromKm[i]),
      toKm: toKm[i] === '' || toKm[i] == null ? null : Number(toKm[i]),
      ratePerKm: Number(rate[i]),
    });
  }

  try {
    await setMileageRateTable(s, { claimTypeId, gradeId, vehicleClass, effectiveFrom, bands });
  } catch (e) {
    redirect(backTo(claimTypeId, gradeId, vehicleClass, `error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(BASE);
  redirect(backTo(claimTypeId, gradeId, vehicleClass, `toast=${encodeURIComponent('Mileage rates saved')}`));
}
