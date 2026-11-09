'use server';

import { scopedAdmin } from '@/lib/scope';
import { publicErrorMessage } from '@/lib/public-error';
import { readAttendanceFormulaResult } from '@/packs/attendance/service';

export async function readAttendancePayItemAction(id: string) {
  try {
    const { s, scopeIds } = await scopedAdmin();
    const result = await readAttendanceFormulaResult(s, id);
    if (!scopeIds.includes(result.companyId)) throw Error('Choose the result company in your selected scope.');
    return { ok: true as const, value: result };
  } catch (error) {
    return { ok: false as const, error: publicErrorMessage(error) };
  }
}
