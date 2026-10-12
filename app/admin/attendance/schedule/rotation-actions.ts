'use server';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import { saveScheduleRotation } from '@/packs/attendance/service';
import type { RotationCycle } from '@/core/week-pattern';
export type RotationActionState = { error?: string; saved?: boolean };
export async function saveRotationAction(_previous: RotationActionState, fd: FormData): Promise<RotationActionState> {
  try {
    const s = await getSession();
    const raw = String(fd.get('cycle') ?? '');
    if (raw.length > 100_000) throw new Error('The rotation is too large.');
    const cycle = JSON.parse(raw) as RotationCycle;
    const ruleId = String(fd.get('ruleId') ?? '');
    await saveScheduleRotation(s, { ruleId, expectedRevision: String(fd.get('revision') ?? ''),
      allowedShiftIds: fd.getAll('allowedShiftIds').map(String), cycle });
    revalidatePath(`/admin/attendance/schedule/${ruleId}`);
    revalidatePath(`/admin/attendance/schedule/${ruleId}/edit`);
    revalidatePath('/roster'); revalidatePath('/attendance');
    return { saved: true };
  } catch (e) { return { error: publicErrorMessage(e) }; }
}
