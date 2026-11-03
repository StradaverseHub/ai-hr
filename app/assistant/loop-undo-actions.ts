'use server';

import { revalidatePath } from 'next/cache';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import { undoLoopAction, type LoopUndoResult } from '@/core/loops/undo';

/** AI v2 Phase 2 P2-1 — Undo on Today's "clock-out set for you" card. The session comes from the person's own cookie
 * login (the browser-session authenticator the chat cards use), never from the post. The post carries only the action
 * id; the service reads it again as the person and undoes only their own action, within its window, through the
 * attendance owner (core/loops/undo.ts). Nothing is undone unless `confirm` is exactly true. */
export async function undoOwnLoopAction(input: { actionId: unknown; confirm: unknown }): Promise<LoopUndoResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const result = await undoLoopAction(session.ctx, { actionId: input?.actionId, confirm: input?.confirm });
  if (result.kind === 'undone') {
    revalidatePath('/'); revalidatePath('/attendance/my-records'); revalidatePath('/attendance/request-status');
  }
  return result;
}
