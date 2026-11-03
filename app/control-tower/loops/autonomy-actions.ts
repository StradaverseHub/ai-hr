'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { isAdmin, isGroupAdmin } from '@/lib/authz-model';
import { LoopLevelRefused, setLoopLevel } from '@/core/loops/levels';
import { undoLoopAction } from '@/core/loops/undo';
import { isLoopId } from '@/core/loops/types';

/** AI v2 Phase 2 P2-1 — a loop's level and its automatic actions, from AI Centre › Operations › Loops. Each command is
 * checked again by its service and by the database (migration 0963):
 *  - a group administrator promotes a loop one level for one company, with its limits, or moves it down (setLoopLevel:
 *    the cap, the certificate and the one-level step are all checked there, in the same transaction);
 *  - an administrator of the employment undoes an automatic action within its window (undoLoopAction).
 * Each returns to the page it was posted from with a closed result code the page translates; no other text crosses. */
const PAGE = '/control-tower/loops';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVEL_ERRORS = ['invalid', 'refused', 'capped', 'no_actor', 'not_next_level', 'certificate', 'changed', 'unchanged', 'not_found', 'failed'] as const;
type LevelActionError = (typeof LEVEL_ERRORS)[number];

const int = (value: FormDataEntryValue | null) => (typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : NaN);

export async function setLoopLevelAction(formData: FormData) {
  const loop = formData.get('loop'), company = formData.get('company');
  const back = isLoopId(loop) && typeof company === 'string' && UUID.test(company)
    ? `${PAGE}/${loop}/promote?${new URLSearchParams({ company })}` : PAGE;
  let error: LevelActionError | null = null, saved: 'promoted' | 'moved_down' = 'promoted';
  try {
    if (!isLoopId(loop) || typeof company !== 'string' || !UUID.test(company)) throw new LoopLevelRefused('invalid');
    const toLevel = int(formData.get('toLevel')), expectedLevel = int(formData.get('expectedLevel'));
    const s = await getBrowserCommandSession();
    if (!s.userId || s.agent || !isGroupAdmin(s)) throw new LoopLevelRefused('not_group_administrator');
    const limits = formData.has('maxActionsPerNight')
      ? { maxActionsPerNight: int(formData.get('maxActionsPerNight')), undoDays: int(formData.get('undoDays')), condition: formData.get('condition') } : undefined;
    await setLoopLevel(s, { workerId: loop, companyId: company, toLevel, expectedLevel, limits });
    saved = toLevel > expectedLevel ? 'promoted' : 'moved_down';
  } catch (e) {
    error = e instanceof LoopLevelRefused ? (e.reason === 'not_group_administrator' ? 'refused' : e.reason) : 'failed';
  }
  revalidatePath(PAGE, 'layout');
  redirect(`${back}${back.includes('?') ? '&' : '?'}${new URLSearchParams(error ? { error } : { saved })}`);
}

export async function undoLoopActionFromDetailAction(formData: FormData) {
  const loop = formData.get('loop'), action = formData.get('action');
  const back = isLoopId(loop) ? `${PAGE}/${loop}` : PAGE;
  let notice: string = 'unavailable';
  try {
    if (!isLoopId(loop) || typeof action !== 'string' || !UUID.test(action)) notice = 'invalid';
    else {
      const s = await getBrowserCommandSession();
      if (!s.userId || s.agent || !isAdmin(s)) notice = 'access';
      else {
        const result = await undoLoopAction(s, { actionId: action, confirm: true });
        notice = result.kind === 'undone' ? 'undone' : result.reason;
      }
    }
  } catch { notice = 'unavailable'; }
  if (notice === 'undone') { revalidatePath('/attendance'); revalidatePath('/'); }
  revalidatePath(PAGE, 'layout');
  redirect(`${back}?${new URLSearchParams({ autonomy: notice })}`);
}
